"""Resumable, all-years OpenAlex Q1/Q2 journal harvest and reference resolution.

All API evidence, cursors, and edges are staged in SQLite, never in hand-coded data.
Conferences use a separate queue. Export to the website with publish-management.py.
No paid requests: this script uses the supplied key's available daily budget only.
"""
import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / 'data/openalex-refresh/management'
STAGE.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--journal-pages', type=int, default=650, help='Pages this run; remaining daily requests resolve references')
parser.add_argument('--reference-pages', type=int, default=330)
parser.add_argument('--conference-pages', type=int, default=10)
parser.add_argument('--workers', type=int, default=4)
parser.add_argument('--snapshot', action='store_true', help='Complete a dated free public snapshot using projected Parquet reads')
parser.add_argument('--snapshot-workers', type=int, default=8)
parser.add_argument('--snapshot-sources-only', action='store_true', help='Prepare all source records and reference IDs before remote reference extraction')
args = parser.parse_args()
catalog = json.loads((ROOT / 'data/management-journals.json').read_text(encoding='utf-8'))
short = lambda value: str(value).rsplit('/', 1)[-1]
source_map = {}
for source in catalog['sources']:
    if source['sourceId']:
        source_map.setdefault(short(source['sourceId']), []).append(source)
source_map = {key: rows[0] for key, rows in source_map.items() if len(rows) == 1}
seed_ids = sorted({short(s['sourceId']) for s in catalog['journals'] if s['sourceId'] and s['quartile'] in ['Q1', 'Q2']})
conference_ids = sorted({short(s['sourceId']) for s in catalog['sources'] if s['sourceId'] and s['sourceType'] == 'conference-series' and s['quartile'] in ['Q1', 'Q2']})
now = lambda: datetime.now(timezone.utc).isoformat()
db = sqlite3.connect(STAGE / 'harvest.sqlite', timeout=60)
db.execute('PRAGMA journal_mode=WAL')
db.executescript('''
CREATE TABLE IF NOT EXISTS works(id TEXT PRIMARY KEY, doi TEXT, source_id TEXT, role TEXT, record TEXT, abstract TEXT);
CREATE INDEX IF NOT EXISTS works_doi ON works(doi);
CREATE TABLE IF NOT EXISTS edges(citing TEXT, cited TEXT, PRIMARY KEY(citing,cited));
CREATE INDEX IF NOT EXISTS edges_cited ON edges(cited);
CREATE TABLE IF NOT EXISTS targets(id TEXT PRIMARY KEY, state TEXT DEFAULT 'pending', source_id TEXT);
CREATE TABLE IF NOT EXISTS cursors(queue TEXT, batch INTEGER, ids TEXT, cursor TEXT DEFAULT '*', complete INTEGER DEFAULT 0, total INTEGER, received INTEGER DEFAULT 0, pages INTEGER DEFAULT 0, PRIMARY KEY(queue,batch));
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS missing_title_evidence(id TEXT PRIMARY KEY,source_id TEXT,payload TEXT,recorded_at TEXT);
''')
signature = hashlib.sha256(json.dumps([seed_ids, conference_ids]).encode()).hexdigest()
previous = db.execute("SELECT value FROM metadata WHERE key='seed_signature'").fetchone()
if previous and previous[0] != signature:
    raise SystemExit('Seed set changed: preserve this database and start a new harvest checkpoint.')
db.execute("INSERT OR REPLACE INTO metadata VALUES('seed_signature',?)", (signature,))
for queue, ids in [('journals', seed_ids), ('conferences', conference_ids)]:
    for index in range(0, len(ids), 50):
        db.execute('INSERT OR IGNORE INTO cursors(queue,batch,ids) VALUES(?,?,?)', (queue, index // 50, json.dumps(ids[index:index + 50])))
db.commit()
FIELDS = 'id,doi,display_name,publication_year,publication_date,authorships,primary_location,cited_by_count,type,open_access,abstract_inverted_index,referenced_works'
key = os.environ.get('OPENALEX_API_KEY')
remaining = None
requests = 0
stopped = None

class DailyLimit(Exception):
    pass

def request(params):
    url = 'https://api.openalex.org/works?' + urlencode({'per_page': 100, 'select': FIELDS, **params})
    headers = {'User-Agent': 'ResearchBook/1.0 (verified-source import)', 'Accept-Encoding': 'gzip'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    for attempt in range(4):
        try:
            with urlopen(Request(url, headers=headers), timeout=45) as response:
                stream = gzip.GzipFile(fileobj=response) if response.headers.get('Content-Encoding', '').lower() == 'gzip' else response
                return json.load(stream), response.headers.get('X-RateLimit-Remaining')
        except HTTPError as error:
            if error.code == 429:
                raise DailyLimit('OpenAlex rate limit reached; resume after reset or with an authorized free API key') from None
            if error.code in (500, 502, 503, 504) and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f'OpenAlex HTTP {error.code}; checkpoint preserved') from None
        except (URLError, TimeoutError) as error:
            if attempt == 3:
                raise RuntimeError('OpenAlex network unavailable; checkpoint preserved') from error
            time.sleep(2 ** attempt)

def abstract_text(index):
    if not index:
        return ''
    words = {position: word for word, positions in index.items() for position in positions}
    return ' '.join(words.get(i, '') for i in range(max(words) + 1)).strip() if words else ''

def store_work(work, role):
    if not work.get('id'):
        raise ValueError('API work without identity')
    identity = short(work['id'])
    primary = (work.get('primary_location') or {}).get('source') or {}
    source_id = short(primary.get('id') or '')
    official = source_map.get(source_id)
    if role == 'cited-by-q1q2' and (not official or official['sourceType'] != 'journal'):
        # Keep the exact edge and resolved source identity; do not import unrelated sources.
        db.execute('UPDATE targets SET state=?,source_id=? WHERE id=?', ('outside-management-journals', source_id, identity))
        return
    if not work.get('display_name'):
        db.execute('INSERT OR REPLACE INTO missing_title_evidence VALUES(?,?,?,?)',
                   (identity, source_id, json.dumps(work, ensure_ascii=False), now()))
        db.execute("UPDATE targets SET state='missing-title-in-openalex',source_id=? WHERE id=?", (source_id, identity))
        return
    doi = (work.get('doi') or '').removeprefix('https://doi.org/').removeprefix('http://doi.org/').lower()
    abstract = abstract_text(work.get('abstract_inverted_index'))
    source_type = official['sourceType'] if official else ('conference-series' if primary.get('type') == 'conference' else primary.get('type') or 'unclassified')
    record = {'id': doi or work['id'], 'doi': doi or None, 'openalexId': work['id'],
              'title': work['display_name'], 'authors': [a['author']['display_name'] for a in work.get('authorships', []) if (a.get('author') or {}).get('display_name')],
              'year': work.get('publication_year'), 'journal': official['name'] if official else primary.get('display_name'),
              'sourceName': primary.get('display_name'), 'sourceId': primary.get('id'), 'sourceType': source_type,
              'citations': work.get('cited_by_count'), 'type': work.get('type'), 'openAccess': bool((work.get('open_access') or {}).get('is_oa')),
              'oaUrl': (work.get('open_access') or {}).get('oa_url'), 'constructCodes': [], 'hasAbstract': bool(abstract),
              'absSrc': 'openalex' if abstract else None, 'addedVia': 'openalex-management', 'addedAt': now()[:10],
              'importRole': role, 'referenceCount': len(work.get('referenced_works') or [])}
    previous_role = db.execute('SELECT role FROM works WHERE id=?', (identity,)).fetchone()
    if previous_role and previous_role[0] != 'cited-by-q1q2':
        record['importRole'] = previous_role[0]
    db.execute('INSERT OR REPLACE INTO works VALUES(?,?,?,?,?,?)', (identity, doi or None, source_id, record['importRole'], json.dumps(record, ensure_ascii=False, separators=(',', ':')), abstract))
    db.execute('UPDATE targets SET state=?,source_id=? WHERE id=?', ('resolved-management-journal', source_id, identity))
    if role == 'q1q2-published':
        references = {short(ref) for ref in work.get('referenced_works') or []}
        db.executemany('INSERT OR IGNORE INTO edges VALUES(?,?)', ((identity, ref) for ref in references))
        db.executemany('INSERT OR IGNORE INTO targets(id) VALUES(?)', ((ref,) for ref in references))

def checkpoint(status):
    rows = db.execute('SELECT queue,batch,total,received,pages,complete FROM cursors ORDER BY queue,batch').fetchall()
    payload = {'version': 1, 'updatedAt': now(), 'status': status,
               'seedJournalSources': len(seed_ids), 'seedConferenceSources': len(conference_ids),
               'requestsThisRun': requests, 'remainingDailyRequests': remaining,
               'scope': 'all available years; Q1/Q2 highest-category CiteScore 2025 journal sources; conferences separate',
               'journals': [{'batch': r[1], 'available': r[2], 'received': r[3], 'pages': r[4], 'complete': bool(r[5])} for r in rows if r[0] == 'journals'],
               'conferences': [{'batch': r[1], 'available': r[2], 'received': r[3], 'pages': r[4], 'complete': bool(r[5])} for r in rows if r[0] == 'conferences'],
               'storedWorks': db.execute('SELECT COUNT(*) FROM works').fetchone()[0],
               'referenceEdges': db.execute('SELECT COUNT(*) FROM edges').fetchone()[0],
               'referenceTargets': dict(db.execute('SELECT state,COUNT(*) FROM targets GROUP BY state').fetchall())}
    path = STAGE / 'checkpoint.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)
    return payload

def harvest(queue, page_limit):
    global remaining, requests, stopped
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        while done < page_limit:
            if remaining is not None and remaining <= args.workers + 2:
                stopped = 'daily-budget-limited'
                break
            jobs = db.execute('SELECT batch,ids,cursor FROM cursors WHERE queue=? AND complete=0 ORDER BY pages,batch LIMIT ?', (queue, min(args.workers, page_limit - done))).fetchall()
            if not jobs:
                break
            futures = {pool.submit(request, {'filter': 'primary_location.source.id:' + '|'.join(json.loads(ids)), 'cursor': cursor, 'sort': 'publication_date:asc'}): batch for batch, ids, cursor in jobs}
            for future in as_completed(futures):
                batch = futures[future]
                try:
                    body, budget = future.result()
                except DailyLimit:
                    stopped = 'daily-budget-limited'
                    continue
                requests += 1
                done += 1
                if budget is not None:
                    remaining = min(remaining, int(budget)) if remaining is not None else int(budget)
                works = body.get('results', [])
                meta = body['meta']
                for work in works:
                    store_work(work, 'q1q2-published' if queue == 'journals' else 'conference-published')
                cursor = meta.get('next_cursor')
                db.execute('UPDATE cursors SET cursor=?,complete=?,total=?,received=received+?,pages=pages+1 WHERE queue=? AND batch=?', (cursor, int(not cursor or not works), meta['count'], len(works), queue, batch))
                db.commit()
            if stopped:
                break
            if done % 20 == 0 or done == page_limit:
                summary = checkpoint('harvesting-' + queue)
                print(f"[{queue}] pages={done} works={summary['storedWorks']:,} edges={summary['referenceEdges']:,} remaining={remaining}", flush=True)

def resolve_references(page_limit):
    global remaining, requests, stopped
    db.execute("UPDATE targets SET state='resolved-management-journal',source_id=(SELECT source_id FROM works WHERE works.id=targets.id) WHERE id IN (SELECT id FROM works)")
    db.commit()
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        while done < page_limit:
            if remaining is not None and remaining <= args.workers + 2:
                stopped = 'daily-budget-limited'
                break
            # Frequent citations first. Frequency is an observed edge count, not a journal metric.
            pending = [r[0] for r in db.execute("SELECT targets.id FROM targets JOIN edges ON edges.cited=targets.id WHERE targets.state='pending' GROUP BY targets.id ORDER BY COUNT(*) DESC,targets.id LIMIT ?", (min(args.workers, page_limit - done) * 100,))]
            if not pending:
                break
            futures = {pool.submit(request, {'filter': 'openalex_id:' + '|'.join(pending[i:i + 100])}): pending[i:i + 100] for i in range(0, len(pending), 100)}
            for future in as_completed(futures):
                requested = futures[future]
                try:
                    body, budget = future.result()
                except DailyLimit:
                    stopped = 'daily-budget-limited'
                    continue
                requests += 1
                done += 1
                if budget is not None:
                    remaining = min(remaining, int(budget)) if remaining is not None else int(budget)
                returned = set()
                for work in body.get('results', []):
                    returned.add(short(work['id']))
                    store_work(work, 'cited-by-q1q2')
                db.executemany("UPDATE targets SET state='not-returned-by-openalex' WHERE id=?", ((value,) for value in requested if value not in returned))
                db.commit()
            if stopped:
                break
            if done % 20 == 0 or done == page_limit:
                summary = checkpoint('resolving-references')
                print(f"[references] batches={done} storedWorks={summary['storedWorks']:,} targets={summary['referenceTargets']} remaining={remaining}", flush=True)

try:
    print(f"Seed sources: {len(seed_ids)} journals; {len(conference_ids)} conferences (separate). All-years cursor paging.", flush=True)
    if args.snapshot:
        from openalex_snapshot import run_snapshot
        run_snapshot(db, store_work, catalog, source_map, STAGE, args.snapshot_workers, sources_only=args.snapshot_sources_only)
        raise SystemExit(0)
    harvest('conferences', args.conference_pages)
    if not stopped:
        harvest('journals', args.journal_pages)
    if not stopped:
        resolve_references(args.reference_pages)
    incomplete = db.execute('SELECT COUNT(*) FROM cursors WHERE complete=0').fetchone()[0]
    pending = db.execute("SELECT COUNT(*) FROM targets WHERE state='pending'").fetchone()[0]
    summary = checkpoint(stopped or ('complete' if not incomplete and not pending else 'partial-checkpoint'))
    print(json.dumps(summary), flush=True)
finally:
    db.close()
