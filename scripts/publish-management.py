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
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--gzip', action='store_true', help='Publish compressed evidence and index shards')
parser.add_argument('--output',type=Path,help='Alternative output folder for deterministic comparison')
parser.add_argument('--require-complete-snapshot',action='store_true')
args = parser.parse_args()
OUT=args.output or DATA/'management'
OUT.mkdir(parents=True,exist_ok=True)
chunk_size = 5000 if args.gzip else 500
read = lambda path: json.loads(path.read_text(encoding='utf-8-sig'))
catalog = read(DATA / 'management-journals.json')
checkpoint = read(DATA / 'openalex-refresh/management/checkpoint.json')
snapshot_path=DATA/'openalex-refresh/management/openalex-snapshot-checkpoint.json'
snapshot=read(snapshot_path) if snapshot_path.exists() else None
if args.require_complete_snapshot:
    assert snapshot and snapshot['status']=='complete' and snapshot['filesCompleted']['sources']==snapshot['filesTotal'], 'Full snapshot traversal is not complete'
crossref_path = DATA / 'openalex-refresh/management/crossref-checkpoint.json'
full_crossref_path = DATA / 'openalex-refresh/management/crossref-full-checkpoint.json'
if full_crossref_path.exists(): crossref_path = full_crossref_path
crossref = read(crossref_path) if crossref_path.exists() else None
db = sqlite3.connect(DATA / 'openalex-refresh/management/harvest.sqlite')
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
referenced_ids = {row[0] for row in db.execute('SELECT DISTINCT cited FROM edges')}
short = lambda value: str(value).rsplit('/', 1)[-1]
source_map = {}
for source in catalog['sources']:
    if source['sourceId']:
        source_map.setdefault(short(source['sourceId']), []).append(source)
source_map = {key: rows[0] for key, rows in source_map.items() if len(rows) == 1}
if snapshot and snapshot['status']=='complete':
    # Snapshot records can establish exact ISSN identities that the earlier API
    # source lookup did not resolve. Use their already verified official names,
    # only when a name/type identifies one registry source.
    official_names=defaultdict(list)
    for source in catalog['sources']:
        official_names[(source['name'],source['sourceType'])].append(source)
    for source_id,name,source_type in db.execute("SELECT DISTINCT source_id,json_extract(record,'$.journal'),json_extract(record,'$.sourceType') FROM works WHERE json_extract(record,'$.addedVia')='openalex-snapshot'"):
        matches=official_names[(name,source_type)]
        if source_id and len(matches)==1 and source_id not in source_map:
            source_map[source_id]=matches[0]
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

files=[]
class IndexStream:
    def __init__(self,source_type):self.source_type=source_type;self.buffer=[];self.number=0
    def append(self,record):
        self.buffer.append(record)
        if len(self.buffer)>=chunk_size:self.flush()
    def flush(self):
        if not self.buffer:return
        filename=f'index/{self.source_type}-{self.number:04}.json'
        published_path=write_shard(OUT/filename,self.buffer)
        files.append({'path':published_path.relative_to(OUT).as_posix(),'sourceType':self.source_type,'count':len(self.buffer)})
        self.number+=1;self.buffer=[]
    def close(self):self.flush()
class JsonMapStream:
    def __init__(self,path):
        self.path=path.with_suffix(path.suffix+'.gz') if args.gzip else path
        self.path.parent.mkdir(parents=True,exist_ok=True)
        self.temp=self.path.with_suffix('.tmp');self.raw=self.temp.open('wb')
        self.output=gzip.GzipFile(filename='',mode='wb',fileobj=self.raw,mtime=0) if args.gzip else self.raw
        self.output.write(b'{');self.first=True
    def __setitem__(self,key,value):
        if not self.first:self.output.write(b',')
        self.first=False
        self.output.write((json.dumps(str(key),ensure_ascii=False)+':'+json.dumps(value,ensure_ascii=False,separators=(',',':'))).encode('utf-8'))
    def close(self):
        self.output.write(b'}');self.output.close()
        if not self.raw.closed:self.raw.close()
        self.temp.replace(self.path)
indices={}
abstracts={f'{i:02}':JsonMapStream(OUT/f'abstracts/{i:02}.json') for i in range(64)}
refs={f'{i:02}':JsonMapStream(OUT/f'references/{i:02}.json') for i in range(64)}
targets={f'{i:02}':JsonMapStream(OUT/f'targets/{i:02}.json') for i in range(64)}
types, roles, source_counts, by_year = Counter(), Counter(), Counter(), Counter()
provider_counts, provider_abstracts = Counter(), Counter()
abstract_problems=Counter()
stored_records = {}
chosen_work = {}
with_abstract = duplicate = invalid = without_doi = 0
for work_id, text, abstract in db.execute('SELECT id,record,abstract FROM works ORDER BY id'):
    record = json.loads(text)
    # The raw-file locator stays in staged evidence; it is not a browser field.
    record.pop('snapshotEvidence',None)
    if not record['journal'] or (record['year'] is not None and record['year'] > datetime.now().year + 1):
        invalid += 1
        continue
    identity = record['id']
    record['constructCodes'] = codes_for(record['title'] + '. ' + abstract)
    target = {field: record.get(field) for field in ['id', 'doi', 'openalexId', 'title', 'year', 'journal', 'sourceType']}
    if work_id in referenced_ids:
        targets[shard_of(work_id)][work_id] = target
    stored_records[work_id] = identity
    chosen_work.setdefault(identity.lower(),work_id)
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
    if record.get('abstractUnavailableReason'):abstract_problems[record['abstractUnavailableReason']]+=1
    if source_type not in indices:indices[source_type]=IndexStream(source_type)
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
        if current in stored_records and chosen_work[stored_records[current].lower()]==current:
            identity = stored_records[current]
            refs[shard_of(identity)][identity] = references
        current, references = citing, []
    references.append(cited)
if current in stored_records and chosen_work[stored_records[current].lower()]==current:
    identity = stored_records[current]
    refs[shard_of(identity)][identity] = references

for stream in indices.values():stream.close()
for maps in [abstracts,refs,targets]:
    for stream in maps.values():stream.close()
files.sort(key=lambda file:(file['sourceType'],file['path']))

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
basis=(f"Observed OpenAlex first-hop referenced_works edges from Q1/Q2 journal works in the complete {snapshot['release']} public release plus retained API evidence; target states reported separately, not an impact metric." if snapshot and snapshot['status']=='complete' else 'Observed OpenAlex referenced_works edges from fetched Q1/Q2 journal works; partially resolved, not whole-corpus totals.')
write(OUT / 'cited-journals.json', {'basis': basis, 'journals': observed,
      'pairs': [{'from': a, 'to': b, 'count': count} for (a, b), count in cited_pairs.most_common()]})
published = sum(types.values())
manifest = {'version': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'status': checkpoint['status'],
            'scope': checkpoint['scope'], 'selectionNote': 'Source identities are exact ISSN matches; export rankings attach by unique normalized title, verify. All-years queues are incomplete until each cursor finishes.',
            'seedJournalSources': checkpoint['seedJournalSources'], 'seedConferenceSources': checkpoint['seedConferenceSources'],
            'harvestedWorks': db.execute('SELECT COUNT(*) FROM works').fetchone()[0], 'publishedNewPapers': published, 'baselineDuplicates': duplicate,
            'excludedInvalidRecords': invalid, 'papersWithoutDoi': without_doi, 'papersWithAbstract': with_abstract,
            'providerAbstractProblems':dict(abstract_problems),
            'sourceTypes': dict(types), 'importRoles': dict(roles), 'byYear': dict(sorted(by_year.items())), 'files': files,
            'abstractShards': 64, 'referenceShards': 64, 'referenceEdges': checkpoint['referenceEdges'],
            'referenceTargets': checkpoint['referenceTargets'], 'citedManagementJournals': len(observed),
            'completedJournalBatches': sum(batch['complete'] for batch in checkpoint['journals']), 'journalBatches': len(checkpoint['journals']),
            'knownAvailableJournalWorks': sum(batch['available'] or 0 for batch in checkpoint['journals']),
            'receivedJournalWorks': sum(batch['received'] for batch in checkpoint['journals']),
            'sourceCounts': dict(source_counts), 'provenance': 'OpenAlex work records and verbatim inverted-index abstracts; no AI; construct tags are word-boundary matches against the existing verified lexicon, machine · verify.'}
if snapshot and snapshot['status']=='complete':
    manifest.update(status='complete',coverageMode='full-public-snapshot',openalexSnapshot=snapshot,
                    scope=f"All matching Q1/Q2 journal and conference records in the official OpenAlex {snapshot['release']} release; additional observed API and Crossref records retained; source types separate",
                    selectionNote='Full dated snapshot traversal; live API cursors are preserved separately and are not claimed complete.',
                    referenceEdges=snapshot['referenceEdges'],referenceTargets=snapshot['referenceTargets'])
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
