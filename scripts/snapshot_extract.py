"""Project official snapshot columns on a free public-repository runner.

Exports raw matched rows plus manifest reconciliation; publication stays local.
"""
import concurrent.futures as futures
import argparse,gzip,hashlib,json,os,tarfile,time
from pathlib import Path
from collections import defaultdict
from urllib.request import urlopen
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import pyarrow.fs as fs
from openalex_snapshot import FIELDS,SCAN
from snapshot_fields import normalize_row

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--verify-file',help='One exact manifest URL for a local reader comparison')
args=parser.parse_args()
EXPORT_ROOT=Path(os.environ.get('SNAPSHOT_OUTPUT_ROOT',ROOT));EXPORT_ROOT.mkdir(parents=True,exist_ok=True)
config=json.loads((ROOT/'snapshot-job.json').read_text())
part=int(os.environ['SNAPSHOT_PART'])
phase=config['phase']
output=EXPORT_ROOT/'snapshot-export';output.mkdir(exist_ok=True)
raw=urlopen('https://openalex.s3.amazonaws.com/data/parquet/works/manifest.json',timeout=60).read()
fingerprint=hashlib.sha256(raw).hexdigest()
assert fingerprint==config['manifestSha256']
manifest=json.loads(raw)
catalog=json.loads((ROOT/'data/management-journals.json').read_text(encoding='utf-8'))
ids=defaultdict(list);issns=defaultdict(list)
for source in catalog['sources']:
    if source['sourceType'] not in ['journal','conference-series']:continue
    if source.get('sourceId'):ids[source['sourceId']].append(source)
    for issn in source['issns']:issns[issn.replace('-','')].append(source)
ids={k:v[0] for k,v in ids.items() if len(v)==1}
issns={k:v[0] for k,v in issns.items() if len(v)==1}
id_values=pa.array(list(ids))
pending=set(json.loads(gzip.decompress((ROOT/'snapshot-targets.json.gz').read_bytes()))) if phase=='references' else None
filesystem=fs.S3FileSystem(anonymous=True,region='us-east-1',request_timeout=120,connect_timeout=30)
def official_for(row):
    source=(row.get('primary_location') or {}).get('source') or {}
    if source.get('id') in ids:return ids[source['id']]
    matches={issns[i.replace('-','')]['scopusSourceId']:issns[i.replace('-','')] for i in source.get('issn') or [] if i.replace('-','') in issns}
    return next(iter(matches.values())) if len(matches)==1 else None
def extract(entry):
    for attempt in range(5):
        try:
            parquet=pq.ParquetFile(entry['url'].removeprefix('s3://'),filesystem=filesystem,page_checksum_verification=True)
            rows=[];scanned=0
            for group in range(parquet.num_row_groups):
                scan=parquet.read_row_group(group,columns=SCAN,use_threads=False);scanned+=scan.num_rows
                if phase=='references':
                    mask=pa.array([identity in pending for identity in scan['id'].to_pylist()])
                    for row in scan.filter(mask).to_pylist():
                        rows.append([row['id'].rsplit('/',1)[-1],((row.get('primary_location') or {}).get('source') or {}).get('id'),bool(row.get('is_xpac'))])
                    continue
                source=pc.struct_field(scan['primary_location'],'source')
                source_ids=pc.struct_field(source,'id')
                issn_mask=pa.array([any(i.replace('-','') in issns for i in (values or [])) for values in pc.struct_field(source,'issn').to_pylist()])
                mask=pc.and_(pc.or_(pc.is_in(source_ids,value_set=id_values),issn_mask),pc.invert(pc.fill_null(scan['is_xpac'],False)))
                if pc.any(mask).as_py():
                    for row in parquet.read_row_group(group,columns=FIELDS,use_threads=False).filter(mask).to_pylist():
                        official=official_for(row)
                        if not official:continue
                        normalize_row(row)
                        rows.append([row,official])
            assert scanned==entry['meta']['record_count']
            key=hashlib.sha256((fingerprint+phase+entry['url']).encode()).hexdigest()
            path=output/(key+'.json.gz')
            path.write_bytes(gzip.compress(json.dumps({'manifestSha256':fingerprint,'phase':phase,'url':entry['url'],'scanned':scanned,'rows':rows},ensure_ascii=False).encode(),mtime=0))
            return {'path':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'scanned':scanned,'matched':len(rows),'url':entry['url']}
        except Exception as error:
            print(json.dumps({'retry':entry['url'],'attempt':attempt+1,'error':repr(error)}),flush=True)
            if attempt==4:raise
            time.sleep(2**attempt)
entries=[e for i,e in enumerate(manifest['files']) if i%config['partitions']==part]
if args.verify_file:
    entries=[e for e in manifest['files'] if e['url']==args.verify_file]
    assert len(entries)==1
proof=[];started=time.monotonic()
with futures.ThreadPoolExecutor(max_workers=4) as pool:
    for future in futures.as_completed([pool.submit(extract,e) for e in entries]):
        proof.append(future.result())
        print(json.dumps({'part':part,'phase':phase,'files':len(proof),'total':len(entries),'scanned':sum(p['scanned'] for p in proof),'elapsed':round(time.monotonic()-started)}),flush=True)
assert sum(p['scanned'] for p in proof)==sum(e['meta']['record_count'] for e in entries)
assert hashlib.sha256(urlopen('https://openalex.s3.amazonaws.com/data/parquet/works/manifest.json',timeout=60).read()).hexdigest()==fingerprint
proof_path=output/f'{phase}-proof-{part}.json';proof_path.write_text(json.dumps({'manifestSha256':fingerprint,'phase':phase,'part':part,'sample':bool(args.verify_file),'files':proof}),encoding='utf-8')
bundles=[];bundle=None;size=0;number=0
for file in sorted(output.glob('*.json.gz')):
    if bundle is None or size+file.stat().st_size>400*1024**2:
        if bundle:bundle.close()
        name=EXPORT_ROOT/f'{phase}-part-{part}-{number:03}.tar';number+=1
        bundle=tarfile.open(name,'w');bundles.append(name);size=0
    bundle.add(file,arcname=file.name);size+=file.stat().st_size
if bundle:bundle.close()
bundle_proof=EXPORT_ROOT/f'{phase}-bundles-{part}.json'
bundle_proof.write_text(json.dumps({'manifestSha256':fingerprint,'bundles':[{'name':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in bundles]}))
print(json.dumps({'finished':part,'phase':phase,'files':len(proof),'scanned':sum(p['scanned'] for p in proof),'matched':sum(p['matched'] for p in proof),'bundles':len(bundles)}),flush=True)
