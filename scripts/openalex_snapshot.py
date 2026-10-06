"""Quota-independent, resumable extraction of a dated official OpenAlex snapshot.

Remote column projection avoids saving the complete public database. Only real
matched records are retained; a second projected pass classifies reference IDs.
"""
import gzip
import hashlib
import json
import sqlite3
import shutil
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from snapshot_http import RangeFile

MANIFEST='https://openalex.s3.amazonaws.com/data/parquet/works/manifest.json'
FIELDS=['id','doi','display_name','publication_year','publication_date',
        'authorships.list.element.author.id','authorships.list.element.author.display_name',
        'primary_location.source','cited_by_count','type','open_access',
        'abstract_inverted_index','referenced_works','is_xpac']
SCAN=['id','primary_location.source.id','primary_location.source.issn','is_xpac']
short=lambda value:str(value).rsplit('/',1)[-1]

def run_snapshot(db, store_work, catalog, source_map, stage, workers):
    root=Path('E:/ResearchBook/openalex-snapshot')
    root.mkdir(parents=True,exist_ok=True)
    groups=root/'groups';groups.mkdir(exist_ok=True)
    manifest_bytes=urlopen(MANIFEST,timeout=60).read()
    manifest=json.loads(manifest_bytes)
    fingerprint=hashlib.sha256(manifest_bytes).hexdigest()
    evidence=sqlite3.connect(root/'evidence.sqlite',timeout=60)
    evidence.execute('PRAGMA journal_mode=WAL')
    evidence.executescript('''
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS files(phase TEXT,path TEXT,scanned INTEGER,matched INTEGER,PRIMARY KEY(phase,path));
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,payload BLOB,path TEXT,official TEXT);
      CREATE TABLE IF NOT EXISTS outside_evidence(id TEXT PRIMARY KEY,source_id TEXT,path TEXT);
      CREATE TABLE IF NOT EXISTS applied(id TEXT PRIMARY KEY);
    ''')
    old=evidence.execute("SELECT value FROM metadata WHERE key='manifest_sha256'").fetchone()
    if old and old[0]!=fingerprint:
        raise RuntimeError('Snapshot release changed; preserve the checkpoint before starting another release.')
    evidence.execute("INSERT OR REPLACE INTO metadata VALUES('manifest_sha256',?)",(fingerprint,))
    (root/'manifest.json').write_bytes(manifest_bytes)
    by_id={};by_issn=defaultdict(list);id_sources=defaultdict(list)
    official_sources=[s for s in catalog['sources'] if s['sourceType'] in ['journal','conference-series']]
    for s in official_sources:
        if s.get('sourceId'):id_sources[s['sourceId']].append(s)
        for issn in s['issns']:by_issn[issn.replace('-','')].append(s)
    by_id={key:rows[0] for key,rows in id_sources.items() if len(rows)==1}
    exact_issns={k:rows[0] for k,rows in by_issn.items() if len(rows)==1}
    id_values=pa.array(list(by_id))
    started=time.monotonic()
    progress={}
    def official_for(work):
        source=(work.get('primary_location') or {}).get('source') or {}
        if source.get('id') in by_id:return by_id[source['id']]
        matches={exact_issns[i.replace('-','')]['scopusSourceId']:exact_issns[i.replace('-','')] for i in source.get('issn') or [] if i.replace('-','') in exact_issns}
        return next(iter(matches.values())) if len(matches)==1 else None
    def status(phase):
        counts=dict(evidence.execute('SELECT phase,COUNT(*) FROM files GROUP BY phase'))
        payload={'version':1,'mode':'full-public-snapshot','release':manifest['date'],
                 'manifestUrl':MANIFEST,'manifestSha256':fingerprint,'status':phase,
                 'filesTotal':len(manifest['files']),'filesCompleted':counts,
                 'snapshotWorks':manifest['record_count'],
                 'worksScanned':evidence.execute("SELECT COALESCE(SUM(scanned),0) FROM files WHERE phase='sources'").fetchone()[0],
                 'matchedManagementRecords':evidence.execute('SELECT COUNT(*) FROM candidates').fetchone()[0],
                 'referenceEdges':db.execute('SELECT COUNT(*) FROM edges').fetchone()[0],
                 'referenceTargets':dict(db.execute('SELECT state,COUNT(*) FROM targets GROUP BY state')),
                 'selectedSources':sum(s.get('quartile') in ['Q1','Q2'] for s in official_sources),'updatedAt':datetime.now(timezone.utc).isoformat()}
        if phase=='complete':
            seed_counts=dict(evidence.execute("SELECT json_extract(official,'$.sourceType'),COUNT(*) FROM candidates WHERE json_extract(official,'$.quartile') IN ('Q1','Q2') GROUP BY json_extract(official,'$.sourceType')"))
            payload.update(seedJournalRecords=seed_counts.get('journal',0),seedConferenceRecords=seed_counts.get('conference-series',0),
                           appliedSnapshotRecords=evidence.execute('SELECT COUNT(*) FROM applied').fetchone()[0])
        (stage/'openalex-snapshot-checkpoint.json').write_text(json.dumps(payload),encoding='utf-8')
        print(json.dumps(payload),flush=True)
        return payload
    def apply_work(work,official,role,path):
        identity=short(work['id'])
        source_id=((work.get('primary_location') or {}).get('source') or {}).get('id')
        if source_id:source_map[short(source_id)]=official
        existing=db.execute('SELECT record FROM works WHERE id=?',(identity,)).fetchone()
        if not existing:
            store_work(work,role)
            result=db.execute('SELECT record FROM works WHERE id=?',(identity,)).fetchone()
            if result:
                record=json.loads(result[0]);record.update(addedVia='openalex-snapshot',snapshotRelease=manifest['date'],snapshotEvidence=path)
                db.execute('UPDATE works SET record=? WHERE id=?',(json.dumps(record,ensure_ascii=False),identity))
                evidence.execute('INSERT OR IGNORE INTO applied VALUES(?)',(identity,))
            return
        # A dated snapshot must not replace newer API metadata.
        record=json.loads(existing[0])
        if record.get('addedVia')=='openalex-snapshot':
            evidence.execute('INSERT OR IGNORE INTO applied VALUES(?)',(identity,))
        if role=='q1q2-published':
            if record['importRole']=='cited-by-q1q2':
                record['importRole']=role
                db.execute('UPDATE works SET role=?,record=? WHERE id=?',(role,json.dumps(record,ensure_ascii=False),identity))
            refs={short(ref) for ref in work.get('referenced_works') or []}
            db.executemany('INSERT OR IGNORE INTO edges VALUES(?,?)',((identity,ref) for ref in refs))
            db.executemany('INSERT OR IGNORE INTO targets(id) VALUES(?)',((ref,) for ref in refs))
        if role=='cited-by-q1q2':
            state='resolved-management-journal' if official['sourceType']=='journal' else 'outside-management-journals'
            db.execute('UPDATE targets SET state=?,source_id=? WHERE id=?',(state,short(source_id or ''),identity))
    def read_file(entry,phase,pending=None):
        for attempt in range(5):
            try:
                progress[entry['url']]={'attempt':attempt+1,'step':'footer'}
                url='https://openalex.s3.amazonaws.com/'+entry['url'].removeprefix('s3://openalex/')
                reader=RangeFile(url,entry['meta']['content_length'])
                parquet=pq.ParquetFile(reader,page_checksum_verification=True)
                scanned=0;rows=[]
                for group in range(parquet.num_row_groups):
                    cache=groups/(hashlib.sha256((fingerprint+phase+entry['url']+str(group)).encode()).hexdigest()+'.json.gz')
                    if cache.exists():
                        saved=json.loads(gzip.decompress(cache.read_bytes()))
                        assert saved['scanned']==parquet.metadata.row_group(group).num_rows
                        scanned+=saved['scanned'];rows.extend(saved['rows']);continue
                    group_rows=[]
                    progress[entry['url']]={'attempt':attempt+1,'step':f'scan {group+1}/{parquet.num_row_groups}'}
                    scan=parquet.read_row_group(group,columns=SCAN,use_threads=False)
                    scanned+=scan.num_rows
                    src=pc.struct_field(pc.struct_field(scan['primary_location'],'source'),'id')
                    if phase=='references':
                        # Reuse one ID hash set instead of rebuilding a multi-million-ID
                        # Arrow lookup table for every row group in every worker.
                        mask=pa.array([identity in pending for identity in scan['id'].to_pylist()])
                        for row in scan.filter(mask).to_pylist():
                            group_rows.append((short(row['id']),((row.get('primary_location') or {}).get('source') or {}).get('id'),bool(row.get('is_xpac'))))
                        rows.extend(group_rows)
                        temporary=cache.with_suffix('.tmp');temporary.write_bytes(gzip.compress(json.dumps({'scanned':scan.num_rows,'rows':group_rows},ensure_ascii=False).encode(),mtime=0));temporary.replace(cache)
                        continue
                    mask=pc.is_in(src,value_set=id_values)
                    # Exact ISSNs identify registry sources whose OpenAlex ID was unresolved.
                    source_struct=pc.struct_field(scan['primary_location'],'source')
                    issns=pc.struct_field(source_struct,'issn').to_pylist()
                    issn_mask=pa.array([any(i.replace('-','') in exact_issns for i in (values or [])) for values in issns])
                    mask=pc.and_(pc.or_(mask,issn_mask),pc.invert(pc.fill_null(scan['is_xpac'],False)))
                    if pc.any(mask).as_py():
                        progress[entry['url']]={'attempt':attempt+1,'step':f'metadata {group+1}/{parquet.num_row_groups}'}
                        for row in parquet.read_row_group(group,columns=FIELDS,use_threads=False).filter(mask).to_pylist():
                            official=official_for(row)
                            if not official:continue
                            if isinstance(row.get('abstract_inverted_index'),str):row['abstract_inverted_index']=json.loads(row['abstract_inverted_index'])
                            row['publication_date']=str(row['publication_date']) if row.get('publication_date') else None
                            group_rows.append((row,official))
                    rows.extend(group_rows)
                    temporary=cache.with_suffix('.tmp');temporary.write_bytes(gzip.compress(json.dumps({'scanned':scan.num_rows,'rows':group_rows},ensure_ascii=False).encode(),mtime=0));temporary.replace(cache)
                assert scanned==entry['meta']['record_count'],(entry['url'],scanned,entry['meta'])
                return entry,scanned,rows
            except Exception as error:
                print(json.dumps({'retryFile':entry['url'],'attempt':attempt+1,'error':repr(error)},ensure_ascii=True),flush=True)
                if attempt==4:raise
                time.sleep(min(60,2**attempt))
    def parallel(phase,pending=None):
        done={r[0] for r in evidence.execute('SELECT path FROM files WHERE phase=?',(phase,))}
        entries=iter(e for e in manifest['files'] if e['url'] not in done)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            active={}
            for _ in range(workers):
                entry=next(entries,None)
                if entry:active[pool.submit(read_file,entry,phase,pending)]=entry
            while active:
                finished,_=wait(active,timeout=30,return_when=FIRST_COMPLETED)
                if not finished:
                    print(f'[{phase}] {len(done)}/{len(manifest["files"])} files; {len(active)} active; elapsed {int(time.monotonic()-started)}s',flush=True)
                    print(json.dumps({'activeProgress':{entry['url']:progress.get(entry['url']) for entry in active.values()}},ensure_ascii=True),flush=True)
                for future in finished:
                    active.pop(future)
                    entry,scanned,rows=future.result()
                    progress.pop(entry['url'],None)
                    if shutil.disk_usage(root).free<2*1024**3 or shutil.disk_usage(stage).free<5*1024**3:
                        raise RuntimeError('Low disk space; saved snapshot checkpoint can be resumed after freeing space.')
                    if phase=='sources':
                        for work,official in rows:
                            identity=short(work['id']);source_id=((work.get('primary_location') or {}).get('source') or {}).get('id')
                            if source_id:source_map[short(source_id)]=official
                            raw=gzip.compress(json.dumps(work,ensure_ascii=False).encode(),mtime=0)
                            evidence.execute('INSERT OR REPLACE INTO candidates VALUES(?,?,?,?)',(identity,raw,entry['url'],json.dumps(official)))
                            if official.get('quartile') in ['Q1','Q2']:
                                role='q1q2-published' if official['sourceType']=='journal' else 'conference-published'
                                apply_work(work,official,role,entry['url'])
                    else:
                        for identity,source_id,xpac in rows:
                            evidence.execute('INSERT OR REPLACE INTO outside_evidence VALUES(?,?,?)',(identity,source_id,entry['url']))
                            state='excluded-xpac' if xpac else ('outside-management-journals' if source_id else 'no-source-in-snapshot')
                            db.execute("UPDATE targets SET state=?,source_id=? WHERE id=? AND state='pending'",(state,short(source_id or ''),identity))
                    db.commit();evidence.commit()
                    evidence.execute('INSERT INTO files VALUES(?,?,?,?)',(phase,entry['url'],scanned,len(rows)))
                    evidence.commit();done.add(entry['url']);status('harvesting-'+phase)
                    entry=next(entries,None)
                    if entry:active[pool.submit(read_file,entry,phase,pending)]=entry
    try:
        status('harvesting-sources');parallel('sources')
        assert evidence.execute("SELECT SUM(scanned) FROM files WHERE phase='sources'").fetchone()[0]==manifest['record_count']
        db.execute("UPDATE targets SET state='pending' WHERE state IN ('not-returned-by-openalex','missing-title-in-openalex','outside-management-journals','no-source-in-snapshot')")
        db.commit()
        # Resolve management references from the complete filtered source corpus.
        for identity,raw,official_json,path in evidence.execute('SELECT id,payload,official,path FROM candidates'):
            target=db.execute("SELECT state FROM targets WHERE id=? AND state='pending'",(identity,)).fetchone()
            if not target:continue
            work=json.loads(gzip.decompress(raw));official=json.loads(official_json)
            source_id=((work.get('primary_location') or {}).get('source') or {}).get('id')
            if source_id:source_map[short(source_id)]=official
            apply_work(work,official,'cited-by-q1q2',path)
        db.commit();evidence.commit()
        pending={'https://openalex.org/'+r[0] for r in db.execute("SELECT id FROM targets WHERE state='pending'")}
        if len(pending):
            parallel('references',pending)
            assert evidence.execute("SELECT COUNT(*) FROM files WHERE phase='references'").fetchone()[0]==len(manifest['files'])
        db.execute("UPDATE targets SET state='not-in-snapshot' WHERE state='pending'");db.commit()
        assert hashlib.sha256(urlopen(MANIFEST,timeout=60).read()).hexdigest()==fingerprint, 'Snapshot manifest changed during traversal; do not publish a mixed release'
        status('complete')
    finally:evidence.close()
