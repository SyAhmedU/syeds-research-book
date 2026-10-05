"""Import bounded newest-first publisher metadata from exact registry ISSNs."""
import json, sqlite3, time, urllib.request, urllib.parse, re, html, argparse
from pathlib import Path
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'
db=sqlite3.connect(DATA/'openalex-refresh/management/harvest.sqlite')
db.execute('CREATE TABLE IF NOT EXISTS crossref_evidence (doi TEXT PRIMARY KEY, payload TEXT NOT NULL)')
db.execute('CREATE TABLE IF NOT EXISTS crossref_batches (source TEXT PRIMARY KEY, payload TEXT NOT NULL)')
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sources',type=int,default=40,help='Number of Q1 journal sources, ordered by source-wide OpenAlex worksCount')
args=parser.parse_args()
catalog=json.loads((DATA/'management-journals.json').read_text(encoding='utf-8-sig'))
sources=sorted([s for s in catalog['sources'] if s['sourceType']=='journal' and s.get('quartile')=='Q1' and s.get('sourceId') and s.get('issns')],key=lambda s: -(s.get('worksCount') or 0))[:args.sources]
known={p['id'].lower() for name in ['papers.index.json','recent.index.json'] for p in json.loads((DATA/name).read_text(encoding='utf-8-sig'))}
known.update(json.loads(row[0])['id'].lower() for row in db.execute('SELECT record FROM works'))
added=abstracts=0
for source in sources:
    if db.execute('SELECT 1 FROM crossref_batches WHERE source=?',(source['scopusSourceId'],)).fetchone(): continue
    issn=source['issns'][0]; issn=issn[:4]+'-'+issn[4:]
    query=urllib.parse.urlencode({'rows':1000,'sort':'published','order':'desc','filter':'type:journal-article','mailto':'syedfaceprep@gmail.com'})
    url='https://api.crossref.org/journals/'+issn+'/works?'+query
    response=None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'ResearchBookVerifiedImport/1.0 (mailto:syedfaceprep@gmail.com)'}),timeout=90) as stream: response=json.load(stream)['message']
            break
        except Exception as error:
            print('Retry',issn,str(error),flush=True);time.sleep(min(2**attempt,16))
    if response is None: continue
    matched=0
    for work in response['items']:
        doi=work.get('DOI','').lower().strip(); titles=work.get('title',[])
        if not doi or not titles or not set(x.replace('-','') for x in work.get('ISSN',[])).intersection(source['issns']): continue
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
    evidence={'source':source['name'],'issn':issn,'url':url,'available':response['total-results'],'received':len(response['items']),'added':matched,'retrievedAt':datetime.now(timezone.utc).isoformat(),'complete':response['total-results']<=len(response['items'])}
    db.execute('INSERT INTO crossref_batches VALUES (?,?)',(source['scopusSourceId'],json.dumps(evidence)))
    db.commit();print(json.dumps(evidence),flush=True);time.sleep(.5)
report={'provider':'Crossref','selection':f'{args.sources} Q1 journal sources with highest OpenAlex worksCount; exact registry ISSN; newest 1000 journal-article records per source, DOI deduplicated. Bounded partial import, not full coverage.',
        'batches':[json.loads(row[0]) for row in db.execute('SELECT payload FROM crossref_batches')],
        'records':db.execute("SELECT COUNT(*) FROM works WHERE id LIKE 'doi:%'").fetchone()[0],
        'abstracts':db.execute("SELECT COUNT(*) FROM works WHERE id LIKE 'doi:%' AND abstract!=''").fetchone()[0]}
(DATA/'openalex-refresh/management/crossref-checkpoint.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'added':added,'abstracts':abstracts,'stored':report['records']}))
