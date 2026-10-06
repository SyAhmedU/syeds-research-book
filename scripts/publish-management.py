"""Publish staged real management records as bounded index/abstract/reference shards."""
import json
import gzip
import argparse
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from literal_match import literal_pattern

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
OUT = DATA / 'management'
OUT.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--gzip', action='store_true', help='Publish compressed evidence and index shards')
args = parser.parse_args()
chunk_size = 5000 if args.gzip else 500
read = lambda path: json.loads(path.read_text(encoding='utf-8-sig'))
catalog = read(DATA / 'management-journals.json')
checkpoint = read(DATA / 'openalex-refresh/management/checkpoint.json')
crossref_path = DATA / 'openalex-refresh/management/crossref-checkpoint.json'
full_crossref_path = DATA / 'openalex-refresh/management/crossref-full-checkpoint.json'
if full_crossref_path.exists(): crossref_path = full_crossref_path
crossref = read(crossref_path) if crossref_path.exists() else None
db = sqlite3.connect(DATA / 'openalex-refresh/management/harvest.sqlite')
db.execute('PRAGMA query_only=ON')
referenced_ids = {row[0] for row in db.execute('SELECT DISTINCT cited FROM edges')}
short = lambda value: str(value).rsplit('/', 1)[-1]
source_map = {}
for source in catalog['sources']:
    if source['sourceId']:
        source_map.setdefault(short(source['sourceId']), []).append(source)
source_map = {key: rows[0] for key, rows in source_map.items() if len(rows) == 1}
known = {p['id'].lower() for name in ['papers.index.json', 'recent.index.json'] for p in read(DATA / name)}
lex = read(DATA / 'construct-lexicon.json')
synonyms = defaultdict(set)
for construct in lex['constructs']:
    for term in construct['synonyms']:
        normalized = term.lower().replace('’', "'").replace('‘', "'").replace('–', '-').replace('—', '-')
        if len(normalized) >= 4:
            synonyms[normalized].update(construct.get('bookCodes', []))
synonyms = {term: codes for term, codes in synonyms.items() if codes}
matcher = re.compile(r'(?<![a-z0-9])(?:' + literal_pattern(synonyms) + r')(?![a-z0-9])')
def codes_for(text):
    normalized = re.sub(r'\s+', ' ', text.lower().replace('’', "'").replace('‘', "'").replace('–', '-').replace('—', '-'))
    return sorted({code for match in matcher.finditer(normalized) for code in synonyms[match.group()]})

def shard_of(value):
    value_hash = 0
    for character in value:
        value_hash = (value_hash * 31 + ord(character)) & 0xffffffff
    return f'{value_hash % 64:02}'

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temporary.replace(path)

def write_shard(path, value):
    if not args.gzip:
        write(path, value)
        return path
    compressed = path.with_suffix(path.suffix + '.gz')
    compressed.parent.mkdir(parents=True, exist_ok=True)
    temporary = compressed.with_suffix('.tmp')
    with temporary.open('wb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as archive:
            archive.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    temporary.replace(compressed)
    return compressed

indices, abstracts, refs, targets = defaultdict(list), defaultdict(dict), defaultdict(dict), defaultdict(dict)
types, roles, source_counts, by_year = Counter(), Counter(), Counter(), Counter()
provider_counts, provider_abstracts = Counter(), Counter()
stored_records = {}
with_abstract = duplicate = invalid = without_doi = 0
for work_id, text, abstract in db.execute('SELECT id,record,abstract FROM works ORDER BY id'):
    record = json.loads(text)
    if not record['journal'] or (record['year'] is not None and record['year'] > datetime.now().year + 1):
        invalid += 1
        continue
    identity = record['id']
    record['constructCodes'] = codes_for(record['title'] + '. ' + abstract)
    target = {field: record.get(field) for field in ['id', 'doi', 'openalexId', 'title', 'year', 'journal', 'sourceType']}
    if work_id in referenced_ids:
        targets[shard_of(work_id)][work_id] = target
    stored_records[work_id] = record
    if identity.lower() in known:
        duplicate += 1
        continue
    known.add(identity.lower())
    if abstract:
        abstracts[shard_of(identity)][identity] = abstract
    source_type = record['sourceType']
    provider = record.get('metadataSource') or 'openalex'
    provider_counts[provider] += 1
    provider_abstracts[provider] += bool(abstract)
    indices[source_type].append(record)
    types[source_type] += 1
    roles[record['importRole']] += 1
    source_counts[short(record['sourceId'])] += 1
    if record['year'] is not None:
        by_year[record['year']] += 1
    if abstract:
        with_abstract += 1
    if not record['doi']:
        without_doi += 1

current = None
references = []
for citing, cited in db.execute('SELECT citing,cited FROM edges ORDER BY citing,cited'):
    if citing != current:
        if current in stored_records:
            identity = stored_records[current]['id']
            refs[shard_of(identity)][identity] = references
        current, references = citing, []
    references.append(cited)
if current in stored_records:
    identity = stored_records[current]['id']
    refs[shard_of(identity)][identity] = references

files = []
for source_type, records in indices.items():
    for start in range(0, len(records), chunk_size):
        filename = f'index/{source_type}-{start // chunk_size:04}.json'
        published_path = write_shard(OUT / filename, records[start:start + chunk_size])
        files.append({'path': published_path.relative_to(OUT).as_posix(), 'sourceType': source_type, 'count': len(records[start:start + chunk_size])})
for index in range(64):
    shard = f'{index:02}'
    write_shard(OUT / f'abstracts/{shard}.json', abstracts[shard])
    write_shard(OUT / f'references/{shard}.json', refs[shard])
    write_shard(OUT / f'targets/{shard}.json', targets[shard])

cited_journals = Counter()
cited_pairs = Counter()
for citing_source, cited_source, count in db.execute('SELECT works.source_id,targets.source_id,COUNT(*) FROM edges JOIN works ON works.id=edges.citing JOIN targets ON targets.id=edges.cited WHERE targets.source_id IS NOT NULL GROUP BY works.source_id,targets.source_id'):
    cited = source_map.get(cited_source)
    citing = source_map.get(citing_source)
    if cited and cited['sourceType'] == 'journal' and citing and citing['sourceType'] == 'journal':
        cited_journals[cited_source] += count
        cited_pairs[(citing_source, cited_source)] += count
observed = [{'sourceId': 'https://openalex.org/' + source_id, 'name': source_map[source_id]['name'], 'referenceEdges': count,
             'quartile': source_map[source_id]['quartile'], 'quartileScope': source_map[source_id].get('quartileScope'),
             'papersAdded': source_counts[source_id]} for source_id, count in cited_journals.most_common()]
write(OUT / 'cited-journals.json', {'basis': 'Observed OpenAlex referenced_works edges from fetched Q1/Q2 journal works; partially resolved, not whole-corpus totals.', 'journals': observed,
      'pairs': [{'from': a, 'to': b, 'count': count} for (a, b), count in cited_pairs.most_common()]})
published = sum(types.values())
manifest = {'version': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'status': checkpoint['status'],
            'scope': checkpoint['scope'], 'selectionNote': 'Source identities are exact ISSN matches; export rankings attach by unique normalized title, verify. All-years queues are incomplete until each cursor finishes.',
            'seedJournalSources': checkpoint['seedJournalSources'], 'seedConferenceSources': checkpoint['seedConferenceSources'],
            'harvestedWorks': db.execute('SELECT COUNT(*) FROM works').fetchone()[0], 'publishedNewPapers': published, 'baselineDuplicates': duplicate,
            'excludedInvalidRecords': invalid, 'papersWithoutDoi': without_doi, 'papersWithAbstract': with_abstract,
            'sourceTypes': dict(types), 'importRoles': dict(roles), 'byYear': dict(sorted(by_year.items())), 'files': files,
            'abstractShards': 64, 'referenceShards': 64, 'referenceEdges': checkpoint['referenceEdges'],
            'referenceTargets': checkpoint['referenceTargets'], 'citedManagementJournals': len(observed),
            'completedJournalBatches': sum(batch['complete'] for batch in checkpoint['journals']), 'journalBatches': len(checkpoint['journals']),
            'knownAvailableJournalWorks': sum(batch['available'] or 0 for batch in checkpoint['journals']),
            'receivedJournalWorks': sum(batch['received'] for batch in checkpoint['journals']),
            'sourceCounts': dict(source_counts), 'provenance': 'OpenAlex work records and verbatim inverted-index abstracts; no AI; construct tags are word-boundary matches against the existing verified lexicon, machine · verify.'}
write(OUT / 'manifest.json', manifest)
manifest['indexChunkSize'] = chunk_size
if (OUT / 'source-aliases.json').exists(): manifest['sourceAliases'] = 'source-aliases.json'
if args.gzip: manifest['compression'] = 'gzip'
if crossref:
    manifest['crossref'] = {**crossref, 'stagedRecords': crossref['records'], 'stagedAbstracts': crossref['abstracts'],
                           'records': provider_counts['crossref'], 'abstracts': provider_abstracts['crossref']}
    manifest['provenance'] = 'OpenAlex records plus Crossref publisher-deposited records matched by exact registry ISSN; original provider abstracts, no AI. Construct tags are machine word-boundary matches; verify.'
    write(OUT / 'manifest.json', manifest)
write(OUT / 'manifest.json', manifest)
print(json.dumps({key: manifest[key] for key in ['status', 'harvestedWorks', 'publishedNewPapers', 'baselineDuplicates', 'papersWithAbstract', 'sourceTypes', 'importRoles', 'referenceEdges', 'referenceTargets', 'citedManagementJournals']}))
db.close()
