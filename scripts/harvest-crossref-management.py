"""Import bounded newest-first publisher metadata from exact registry ISSNs."""
import json, sqlite3, time, urllib.request, urllib.parse, re, html, argparse
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from urllib.error import HTTPError
from collections import Counter
from pathlib import Path
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'
db=sqlite3.connect(DATA/'openalex-refresh/management/harvest.sqlite')
db.execute('CREATE TABLE IF NOT EXISTS crossref_evidence (doi TEXT PRIMARY KEY, payload TEXT NOT NULL)')
db.execute('CREATE TABLE IF NOT EXISTS crossref_batches (source TEXT PRIMARY KEY, payload TEXT NOT NULL)')
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sources',type=int,default=120,help='Number of ranked journal sources, ordered by source-wide OpenAlex worksCount')
parser.add_argument('--quartiles',nargs='+',choices=['Q1','Q2'],default=['Q1','Q2'])
args=parser.parse_args()
if args.sources < 1: parser.error('--sources must be positive')
catalog=json.loads((DATA/'management-journals.json').read_text(encoding='utf-8-sig'))
sources=sorted([s for s in catalog['sources'] if s['sourceType']=='journal' and s.get('quartile') in args.quartiles and s.get('sourceId') and s.get('issns')],key=lambda s: -(s.get('worksCount') or 0))[:args.sources]
known={p['id'].lower() for name in ['papers.index.json','recent.index.json'] for p in json.loads((DATA/name).read_text(encoding='utf-8-sig'))}
known.update(json.loads(row[0])['id'].lower() for row in db.execute('SELECT record FROM works'))
added=abstracts=0
remaining=[source for source in sources if not db.execute('SELECT 1 FROM crossref_batches WHERE source=?',(source['scopusSourceId'],)).fetchone()]
request_lock=Lock()
last_request=[0.0]
def fetch_source(source):
    query=urllib.parse.urlencode({'rows':1000,'sort':'published','order':'desc','filter':'type:journal-article','mailto':'syedfaceprep@gmail.com'})
    response=None
    empty_result=None
    for raw_issn in source['issns']:
        response=None
        issn=raw_issn[:4]+'-'+raw_issn[4:]
        url='https://api.crossref.org/journals/'+issn+'/works?'+query
        for attempt in range(5):
            try:
                with request_lock:
                    time.sleep(max(0, .5-(time.monotonic()-last_request[0])))
                    last_request[0]=time.monotonic()
                with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'ResearchBookVerifiedImport/1.0 (mailto:syedfaceprep@gmail.com)'}),timeout=90) as stream: response=json.load(stream)['message']
                break
            except HTTPError as error:
                if error.code == 404:
                    print('ISSN not registered in Crossref',issn,flush=True)
                    break
                print('Retry',issn,str(error),flush=True);time.sleep(min(2**attempt,16))
            except Exception as error:
                print('Retry',issn,str(error),flush=True);time.sleep(min(2**attempt,16))
        if response and response['items']: break
        if response is not None: empty_result=(issn,url,response)
    if response is None and empty_result is not None:
        issn,url,response=empty_result
    return source,issn,url,response

# Network only in two workers; SQLite writes and DOI precedence remain serial.
pool=ThreadPoolExecutor(max_workers=2)
for source,issn,url,response in pool.map(fetch_source,remaining):
    if response is None: continue
    matched=0
    for work in response['items']:
        doi=work.get('DOI','').lower().strip(); titles=work.get('title',[])
        if not doi or not titles or work.get('type')!='journal-article' or not set(x.replace('-','') for x in work.get('ISSN',[])).intersection(source['issns']): continue
        db.execute('INSERT OR REPLACE INTO crossref_evidence VALUES (?,?)',(doi,json.dumps(work,ensure_ascii=False)))
        if doi in known: continue
        date=(work.get('published') or {}).get('date-parts',[[None]])[0]
        year=date[0] if date else None
        if year and year>datetime.now().year+1: continue
        abstract=html.unescape(re.sub('<[^>]*>',' ',work.get('abstract','')))
        abstract=re.sub(r'\s+',' ',abstract).strip()
        record={'id':doi,'doi':doi,'openalexId':None,'metadataSource':'crossref','metadataUrl':'https://api.crossref.org/works/'+urllib.parse.quote(doi,safe=''),
                'title':titles[0],'authors':[' '.join(filter(None,[a.get('given'),a.get('family')])) or a.get('name','') for a in work.get('author',[])],
                'year':year,'journal':source['name'],'sourceName':(work.get('container-title') or [source['name']])[0],
                'sourceId':source['sourceId'],'sourceType':'journal','citations':None,'crossrefCitations':work.get('is-referenced-by-count'),
                'type':work['type'],'openAccess':None,'oaUrl':None,'constructCodes':[],'hasAbstract':bool(abstract),'absSrc':'crossref' if abstract else 'none',
                'addedVia':'crossref-management','addedAt':datetime.now(timezone.utc).date().isoformat(),'importRole':'q1q2-published','referenceCount':None}
        db.execute('INSERT INTO works VALUES (?,?,?,?,?,?)',('doi:'+doi,doi,source['sourceId'].rsplit('/',1)[-1],'q1q2-published',json.dumps(record,ensure_ascii=False),abstract))
        known.add(doi);added+=1;matched+=1;abstracts+=bool(abstract)
    evidence={'source':source['name'],'quartile':source['quartile'],'issn':issn,'url':url,'available':response['total-results'],'received':len(response['items']),'added':matched,'retrievedAt':datetime.now(timezone.utc).isoformat(),'complete':response['total-results']<=len(response['items'])}
    db.execute('INSERT INTO crossref_batches VALUES (?,?)',(source['scopusSourceId'],json.dumps(evidence)))
    db.commit();print(json.dumps(evidence),flush=True)
pool.shutdown()
registry_by_id={s['scopusSourceId']:s for s in catalog['sources']}
completed_ids={row[0] for row in db.execute('SELECT source FROM crossref_batches')}
report={'provider':'Crossref','selection':f'Accumulated ranked journal batches, including the top {args.sources} {"/".join(args.quartiles)} sources by source-wide OpenAlex worksCount; exact registry ISSN; newest 1000 journal-article records per source, DOI deduplicated. Bounded partial import, not full coverage.',
        'sourceQuartiles':dict(Counter(registry_by_id[key]['quartile'] for key in completed_ids)),
        'unimportedSelectedSources':[{'scopusSourceId':s['scopusSourceId'],'name':s['name'],'issns':s['issns']} for s in sources if s['scopusSourceId'] not in completed_ids],
        'batches':[json.loads(row[0]) for row in db.execute('SELECT payload FROM crossref_batches')],
        'records':db.execute("SELECT COUNT(*) FROM works WHERE id LIKE 'doi:%'").fetchone()[0],
        'abstracts':db.execute("SELECT COUNT(*) FROM works WHERE id LIKE 'doi:%' AND abstract!=''").fetchone()[0]}
(DATA/'openalex-refresh/management/crossref-checkpoint.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'added':added,'abstracts':abstracts,'stored':report['records']}))
