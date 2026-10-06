"""Exhaust exact-ISSN Q1/Q2 source queries, with durable per-source cursors."""
import argparse, gzip, html, json, re, sqlite3, time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'
STAGE=DATA/'openalex-refresh/management'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pages',type=int,help='Optional operational page limit; omitted means exhaust the queue')
parser.add_argument('--retry-gaps',action='store_true',help='Retry missing journal endpoints and all conference series through exact ISSN work filters')
args=parser.parse_args()
catalog=json.loads((DATA/'management-journals.json').read_text(encoding='utf-8-sig'))
sources={s['scopusSourceId']:s for s in catalog['sources'] if s['sourceType'] in ['journal','conference-series'] and s.get('quartile') in ['Q1','Q2'] and s.get('issns')}
db=sqlite3.connect(STAGE/'harvest.sqlite')
db.execute('PRAGMA journal_mode=WAL')
db.executescript('''
CREATE TABLE IF NOT EXISTS crossref_streams(source TEXT PRIMARY KEY,issn TEXT,cursor TEXT DEFAULT '*',total INTEGER,received INTEGER DEFAULT 0,pages INTEGER DEFAULT 0,complete INTEGER DEFAULT 0,status TEXT DEFAULT 'pending',error TEXT);
CREATE TABLE IF NOT EXISTS crossref_seen(source TEXT,doi TEXT,PRIMARY KEY(source,doi));
CREATE TABLE IF NOT EXISTS crossref_edges(citing TEXT,cited TEXT,PRIMARY KEY(citing,cited));
CREATE INDEX IF NOT EXISTS crossref_edges_cited ON crossref_edges(cited);
CREATE TABLE IF NOT EXISTS crossref_evidence(doi TEXT PRIMARY KEY,payload TEXT NOT NULL);
''')
if 'endpoint' not in {row[1] for row in db.execute('PRAGMA table_info(crossref_streams)')}:
    db.execute("ALTER TABLE crossref_streams ADD COLUMN endpoint TEXT DEFAULT 'journal'")
for key in sources: db.execute('INSERT OR IGNORE INTO crossref_streams(source) VALUES (?)',(key,))
if args.retry_gaps:
    for key,status in db.execute('SELECT source,status FROM crossref_streams').fetchall():
        if status in ['unavailable','error'] or sources[key]['sourceType']=='conference-series':
            db.execute("UPDATE crossref_streams SET issn=NULL,cursor='*',total=NULL,received=0,pages=0,complete=0,status='pending',error=NULL,endpoint='works' WHERE source=?",(key,))
            db.execute('DELETE FROM crossref_seen WHERE source=?',(key,))
db.commit()
baseline={p['id'].lower() for name in ['papers.index.json','recent.index.json'] for p in json.loads((DATA/name).read_text(encoding='utf-8-sig'))}
known=baseline | {json.loads(row[0])['id'].lower() for row in db.execute('SELECT record FROM works')}
gate=Lock(); last=[0.0]; started=time.monotonic(); pages=added=abstracts=0
fields='DOI,title,author,published,container-title,ISSN,type,abstract,is-referenced-by-count,reference'

def fetch_page(state):
    key,chosen,cursor,endpoint=state
    source=sources[key]
    kind='journal-article' if source['sourceType']=='journal' else None
    candidates=[chosen] if chosen else [value[:4]+'-'+value[4:] for value in source['issns']]
    empty=None
    for issn in candidates:
        filters=[]
        if endpoint=='works': filters.append('issn:'+issn)
        if kind: filters.append('type:'+kind)
        elif endpoint=='journal': filters.append('type:proceedings-article')
        params={'rows':1000,'cursor':cursor,'filter':','.join(filters),'select':fields,'mailto':'syedfaceprep@gmail.com'}
        base='https://api.crossref.org/works' if endpoint=='works' else 'https://api.crossref.org/journals/'+issn+'/works'
        url=base+'?'+urlencode(params)
        for attempt in range(5):
            try:
                with gate:
                    time.sleep(max(0,.5-(time.monotonic()-last[0])))
                    last[0]=time.monotonic()
                with urlopen(Request(url,headers={'User-Agent':'ResearchBookFullImport/1.0 (mailto:syedfaceprep@gmail.com)','Accept-Encoding':'gzip'}),timeout=90) as response:
                    stream=gzip.GzipFile(fileobj=response) if response.headers.get('Content-Encoding','').lower()=='gzip' else response
                    result=json.load(stream)['message']
                if result['items'] or chosen: return key,issn,result,None
                empty=(key,issn,result,None)
                break
            except HTTPError as error:
                if error.code==404: break
                if error.code==400: return key,issn,None,'HTTP 400; query/cursor requires review'
                time.sleep(min(2**attempt,30))
            except Exception:
                time.sleep(min(2**attempt,30))
        else: return key,issn,None,'Network/API retries exhausted'
    return empty or (key,None,None,'No Crossref journal endpoint for the exact registry ISSNs')

def summary():
    rows=list(db.execute('SELECT source,issn,total,received,pages,complete,status,error,endpoint FROM crossref_streams'))
    counts=Counter(row[6] for row in rows)
    report={'provider':'Crossref','mode':'full-cursor','selection':'All ranked Q1/Q2 registry journals and separately typed conference series; exact ISSNs; full cursor traversal, no arbitrary year or record cap.',
            'generatedAt':datetime.now(timezone.utc).isoformat(),'status':('complete' if all(row[5] for row in rows) else 'finished-with-gaps' if not (counts['pending'] or counts['running']) else 'in-progress'),
            'sourceStatus':dict(counts),'sourceTypes':dict(Counter(sources[row[0]]['sourceType'] for row in rows)),
            'records':db.execute("SELECT COUNT(*) FROM works WHERE id LIKE 'doi:%'").fetchone()[0],
            'abstracts':db.execute("SELECT COUNT(*) FROM works WHERE id LIKE 'doi:%' AND abstract!=''").fetchone()[0],
            'publisherDoiReferenceEdges':db.execute('SELECT COUNT(*) FROM crossref_edges').fetchone()[0],
            'batches':[{'scopusSourceId':row[0],'source':sources[row[0]]['name'],'sourceType':sources[row[0]]['sourceType'],'quartile':sources[row[0]]['quartile'],'issn':row[1],'available':row[2],'received':row[3],'pages':row[4],'complete':bool(row[5]),'status':row[6],'error':row[7],'endpoint':row[8]} for row in rows]}
    path=STAGE/'crossref-full-checkpoint.json';temp=path.with_suffix('.tmp');temp.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(path)
    print(json.dumps({'pagesThisRun':pages,'addedThisRun':added,'abstractsThisRun':abstracts,'sourceStatus':dict(counts),'storedCrossref':report['records'],'minutes':round((time.monotonic()-started)/60,1)}),flush=True)

queue=list(db.execute("SELECT source,issn,cursor,endpoint FROM crossref_streams WHERE complete=0 AND status NOT IN ('unavailable','error') ORDER BY pages DESC"))
pool=ThreadPoolExecutor(max_workers=3);pending={};queued=iter(queue)
def schedule_next():
    try: state=next(queued)
    except StopIteration: return
    pending[pool.submit(fetch_page,state)]=state
for _ in range(3): schedule_next()
try:
    while pending:
        done,_=wait(pending,timeout=30,return_when=FIRST_COMPLETED)
        if not done: summary();continue
        for future in done:
            old_state=pending.pop(future);key,issn,result,error=future.result();source=sources[key]
            if error:
                status='unavailable' if error.startswith('No Crossref') else 'error'
                db.execute('UPDATE crossref_streams SET status=?,error=? WHERE source=?',(status,error,key));db.commit();print(json.dumps({'source':source['name'],'status':status,'reason':error}),flush=True);schedule_next();continue
            accepted_types={'journal-article'} if source['sourceType']=='journal' else {'proceedings-article','journal-article','book-chapter'}
            page_added=0
            for work in result['items']:
                doi=work.get('DOI','').lower().strip()
                if not doi: continue
                db.execute('INSERT OR IGNORE INTO crossref_seen VALUES (?,?)',(key,doi))
                titles=work.get('title') or []
                if not titles or work.get('type') not in accepted_types or not set(value.replace('-','') for value in work.get('ISSN',[])).intersection(source['issns']): continue
                # Store provider evidence even for duplicates, never invent missing reference DOIs.
                db.execute('INSERT OR REPLACE INTO crossref_evidence VALUES (?,?)',(doi,json.dumps(work,ensure_ascii=False)))
                for reference in work.get('reference') or []:
                    target=(reference.get('DOI') or '').lower().strip()
                    if re.fullmatch(r'10\.\d{4,9}/\S+',target): db.execute('INSERT OR IGNORE INTO crossref_edges VALUES (?,?)',(doi,target))
                if doi in known: continue
                date=(work.get('published') or {}).get('date-parts',[[None]])[0];year=date[0] if date else None
                if year and year>datetime.now().year+1: continue
                abstract=re.sub(r'\s+',' ',html.unescape(re.sub('<[^>]*>',' ',work.get('abstract') or ''))).strip()
                source_url=source.get('sourceId') or 'https://www.scopus.com/sourceid/'+key
                record={'id':doi,'doi':doi,'openalexId':None,'metadataSource':'crossref','metadataUrl':'https://api.crossref.org/works/'+quote(doi,safe=''),'scopusSourceId':key,
                    'title':titles[0],'authors':[' '.join(filter(None,[author.get('given'),author.get('family')])) or author.get('name','') for author in work.get('author') or []],
                    'year':year,'journal':source['name'],'sourceName':(work.get('container-title') or [source['name']])[0],'sourceId':source_url,'sourceType':source['sourceType'],
                    'citations':None,'crossrefCitations':work.get('is-referenced-by-count'),'type':work['type'],'openAccess':None,'oaUrl':None,'constructCodes':[],
                    'hasAbstract':bool(abstract),'absSrc':'crossref' if abstract else 'none','addedVia':'crossref-management','addedAt':datetime.now(timezone.utc).date().isoformat(),
                    'importRole':'q1q2-published' if source['sourceType']=='journal' else 'conference-published','referenceCount':None}
                db.execute('INSERT INTO works VALUES (?,?,?,?,?,?)',('doi:'+doi,doi,source_url.rsplit('/',1)[-1],record['importRole'],json.dumps(record,ensure_ascii=False),abstract))
                known.add(doi);added+=1;page_added+=1;abstracts+=bool(abstract)
            next_cursor=result.get('next-cursor')
            complete=len(result['items'])<1000 or not next_cursor
            if not complete and next_cursor==old_state[2]:
                db.execute("UPDATE crossref_streams SET status='error',error='Cursor did not advance' WHERE source=?",(key,));db.commit();schedule_next();continue
            db.execute('UPDATE crossref_streams SET issn=?,cursor=?,total=?,received=received+?,pages=pages+1,complete=?,status=?,error=NULL WHERE source=?',
                       (issn,next_cursor or old_state[2],result['total-results'],len(result['items']),int(complete),'complete' if complete else 'running',key))
            db.commit();pages+=1
            if complete:
                print(json.dumps({'source':source['name'],'sourceType':source['sourceType'],'status':'complete','available':result['total-results']}),flush=True);schedule_next()
            elif args.pages is None or pages+len(pending)<args.pages:
                state=(key,issn,next_cursor,old_state[3]);pending[pool.submit(fetch_page,state)]=state
            if pages%20==0: summary()
            if args.pages and pages>=args.pages:
                # Pending requests are processed before stopping; no fetched page is silently lost.
                queued=iter(())
finally:
    pool.shutdown();summary();db.close()
