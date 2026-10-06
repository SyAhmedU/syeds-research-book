"""Bounded-memory verification of every published record and evidence shard."""
import gzip
import json
import sqlite3
from collections import Counter,defaultdict
from functools import reduce

def read(path):
    return json.loads(gzip.decompress(path.read_bytes()).decode('utf-8') if path.suffix=='.gz' else path.read_text(encoding='utf-8-sig'))

def shard(key):return f'{reduce(lambda h,c:(h*31+ord(c))&0xffffffff,key,0)%64:02}'

def verify_data(root,manifest,registry,aliases,ui_only=False):
    data=root/'data';folder=data/'management'
    baseline=read(data/'papers.index.json')+read(data/'recent.index.json')
    have={p['id'].lower() for p in baseline};published_keys={}
    database=sqlite3.connect(data/'openalex-refresh/management/harvest.sqlite') if not ui_only else None
    official={s['scopusSourceId']:s for s in registry['sources']}
    source_issns=defaultdict(set)
    ranked_sources=set()
    for source in registry['sources']:
        source_id=source.get('sourceId') or 'https://www.scopus.com/sourceid/'+source['scopusSourceId']
        source_issns[source_id].update(source['issns'])
        if source['sourceType'] in ['journal','conference-series'] and source.get('quartile') in ['Q1','Q2']:ranked_sources.add(source_id)
    snapshot_db=None
    if database and manifest.get('openalexSnapshot'):
        snapshot_db=sqlite3.connect('file:E:/ResearchBook/openalex-snapshot/evidence.sqlite?mode=ro',uri=True)
        assert snapshot_db.execute("SELECT value FROM metadata WHERE key='manifest_sha256'").fetchone()[0]==manifest['openalexSnapshot']['manifestSha256']
    if database:
        for alias in aliases['aliases']:
            source=official[alias['scopusSourceId']]
            raw=json.loads(database.execute('SELECT payload FROM crossref_evidence WHERE doi=?',(alias['evidenceDoi'],)).fetchone()[0])
            assert source['sourceType']==alias['sourceType']=='conference-series'
            assert source['name']==alias['canonicalName'] and alias['name'] in raw['container-title']
            assert set(source['issns']).intersection(i.replace('-','') for i in raw['ISSN'])
    counts=Counter();historical=None;crossref=None;reference_paper=None
    for file in manifest['files']:
        rows=read(folder/file['path'])
        assert len(rows)==file['count']<=manifest.get('indexChunkSize',500)
        for paper in rows:
            identity=paper['id'];lower=identity.lower()
            assert lower not in have,'Duplicate baseline/import identity'
            have.add(lower)
            assert paper['sourceType']==file['sourceType']
            assert 'scopusPercentile' not in paper
            work_key=paper['openalexId'].split('/')[-1] if paper.get('openalexId') else 'doi:'+paper['doi']
            published_keys[identity]=work_key
            counts['papers']+=1;counts[paper['sourceType']]+=1
            provider=paper.get('metadataSource') or 'openalex'
            counts[provider]+=1;counts[provider+'Abstracts']+=bool(paper['hasAbstract'])
            if paper['hasAbstract']:
                if not historical and paper['year'] and paper['year']<1950:historical=paper
                if not crossref and provider=='crossref':crossref=paper
            if paper.get('openalexId') and paper.get('importRole')=='q1q2-published' and paper.get('referenceCount') and (not reference_paper or paper['referenceCount']>reference_paper['referenceCount']):reference_paper=paper
            if not database:continue
            original,abstract=database.execute('SELECT record,abstract FROM works WHERE id=?',(work_key,)).fetchone()
            original=json.loads(original)
            for field in ['title','doi','authors','year','journal','sourceId','sourceType','importRole']:
                assert paper[field]==original[field],(field,identity)
            assert bool(abstract)==paper['hasAbstract']
            if provider=='crossref':
                raw=json.loads(database.execute('SELECT payload FROM crossref_evidence WHERE doi=?',(paper['doi'],)).fetchone()[0])
                assert paper['title']==raw['title'][0] and paper['doi']==raw['DOI'].lower() and paper['type']==raw['type']
                assert raw['type'] in ({'journal-article'} if paper['sourceType']=='journal' else {'proceedings-article','journal-article','book-chapter'})
                assert paper['sourceId'] in ranked_sources
                assert source_issns[paper['sourceId']].intersection(i.replace('-','') for i in raw.get('ISSN',[]))
            elif original.get('addedVia')=='openalex-snapshot':
                assert snapshot_db
                raw,official_json=snapshot_db.execute('SELECT payload,official FROM candidates WHERE id=?',(work_key,)).fetchone()
                raw=json.loads(gzip.decompress(raw));source=json.loads(official_json)
                expected_doi=(raw.get('doi') or '').removeprefix('https://doi.org/').removeprefix('http://doi.org/').lower() or None
                assert paper['openalexId']==raw['id'] and paper['doi']==expected_doi and paper['type']==raw['type'] and not raw.get('is_xpac')
                assert paper['title']==raw['display_name'] and paper['year']==raw['publication_year']
                assert paper['authors']==[a['author']['display_name'] for a in raw['authorships'] if (a.get('author') or {}).get('display_name')]
                assert paper['sourceType']==source['sourceType'] and paper['journal']==source['name']
                primary=(raw.get('primary_location') or {}).get('source') or {}
                assert paper['sourceId']==primary.get('id')
                assert source.get('sourceId')==primary.get('id') or set(source['issns']).intersection(i.replace('-','') for i in primary.get('issn') or [])
                inverted=raw.get('abstract_inverted_index') or {}
                words={position:word for word,positions in inverted.items() for position in positions}
                expected=' '.join(words.get(i,'') for i in range(max(words)+1)).strip() if words else ''
                assert abstract==expected
        print(f'Verified index records: {counts["papers"]:,}',flush=True) if counts['papers']%100000==0 else None
    assert counts['papers']==manifest['publishedNewPapers']
    assert counts['openalexAbstracts']+counts['crossrefAbstracts']==manifest['papersWithAbstract']
    if manifest.get('crossref'):
        assert counts['crossref']==manifest['crossref']['records'] and counts['crossrefAbstracts']==manifest['crossref']['abstracts']
    suffix='.json.gz' if manifest.get('compression')=='gzip' else '.json'
    samples=[p for p in [historical,crossref] if p];sample_abstracts={}
    for paper in samples:sample_abstracts[paper['id']]=read(folder/f'abstracts/{shard(paper["id"])}{suffix}')[paper['id']]
    references={};with_references=[]
    if ui_only:
        assert reference_paper
        rows=read(folder/f'references/{shard(reference_paper["id"])}{suffix}')
        references[reference_paper['id']]=rows[reference_paper['id']]
        with_references=[reference_paper]
    else:
        abstract_entries=0;target_entries=0
        for bucket in range(64):
            code=f'{bucket:02}'
            for identity,text in read(folder/f'abstracts/{code}{suffix}').items():
                assert shard(identity)==code and identity in published_keys
                assert text==database.execute('SELECT abstract FROM works WHERE id=?',(published_keys[identity],)).fetchone()[0]
                abstract_entries+=1
            for key,target in read(folder/f'targets/{code}{suffix}').items():
                assert shard(key)==code
                original=json.loads(database.execute('SELECT record FROM works WHERE id=?',(key,)).fetchone()[0])
                assert target=={field:original.get(field) for field in ['id','doi','openalexId','title','year','journal','sourceType']}
                assert database.execute('SELECT 1 FROM edges WHERE cited=? LIMIT 1',(key,)).fetchone()
                target_entries+=1
            for identity,edges in read(folder/f'references/{code}{suffix}').items():
                assert shard(identity)==code
                work_key=published_keys.get(identity)
                if not work_key:
                    if identity.startswith('https://openalex.org/'):work_key=identity.rsplit('/',1)[-1]
                    else:work_key=database.execute('SELECT id FROM works WHERE doi=? ORDER BY id LIMIT 1',(identity,)).fetchone()[0]
                expected=[row[0] for row in database.execute('SELECT cited FROM edges WHERE citing=? ORDER BY cited',(work_key,))]
                assert edges==expected,(identity,len(edges),len(expected))
                if identity in published_keys and edges and (not with_references or len(edges)>len(references[with_references[0]['id']])):
                    references={identity:edges};with_references=[{'id':identity}]
            print(f'Verified evidence shards: {bucket+1}/64',flush=True)
        assert abstract_entries==manifest['papersWithAbstract']
        assert target_entries==database.execute('SELECT COUNT(*) FROM works JOIN (SELECT DISTINCT cited FROM edges) links ON works.id=links.cited').fetchone()[0]
        assert database.execute('SELECT COUNT(*) FROM edges').fetchone()[0]==manifest['referenceEdges']
        print(f'PASS provider evidence: {counts["papers"]:,} records and all abstract/reference/target shards.',flush=True)
    if database:database.close()
    if snapshot_db:snapshot_db.close()
    return counts,published_keys,samples,sample_abstracts,with_references,references
