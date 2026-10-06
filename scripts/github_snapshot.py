"""Read runner status or retrieve verified temporary snapshot release assets.

Uses the existing Git credential internally; never prints credentials or signed URLs.
"""
import argparse,gzip,hashlib,json,re,shutil,subprocess,tarfile,time
import concurrent.futures,threading
from pathlib import Path
import requests

REPO='SyAhmedU/syeds-research-book'
API='https://api.github.com/repos/'+REPO
ROOT=Path('E:/ResearchBook/openalex-snapshot')
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('command',choices=['status','download'])
parser.add_argument('--phase',choices=['sources','references'],default='sources')
parser.add_argument('--parts',nargs='+',type=int,choices=range(4),default=[0,1,2,3])
args=parser.parse_args()
credential=subprocess.run(['git','credential','fill'],input='protocol=https\nhost=github.com\n\n',text=True,capture_output=True,check=True)
values=dict(line.split('=',1) for line in credential.stdout.splitlines() if '=' in line)
headers={'Authorization':'Bearer '+values['password'],'Accept':'application/vnd.github+json'}
local=threading.local()
def parallel_asset(url,asset,temporary):
    ledger=temporary.with_suffix('.ranges.json')
    if ledger.exists():
        state=json.loads(ledger.read_text())
        assert state['asset']==asset['id'] and state['size']==asset['size']
    else:
        state={'asset':asset['id'],'size':asset['size'],'prefix':temporary.stat().st_size if temporary.exists() else 0,'done':[]}
        ledger.write_text(json.dumps(state))
    assert 0<=state['prefix']<=asset['size']
    completed=set(state['done'])
    spans=[(start,min(start+1024*1024,asset['size'])-1) for start in range(state['prefix'],asset['size'],1024*1024) if start not in completed]
    def fetch(span):
        start,end=span
        for attempt in range(4):
            try:
                if not hasattr(local,'session'):local.session=requests.Session()
                response=local.session.get(url,headers={'Range':f'bytes={start}-{end}','Accept-Encoding':'identity'},timeout=60)
                assert response.status_code==206 and response.headers.get('Content-Range')==f"bytes {start}-{end}/{asset['size']}"
                data=response.content;response.close();assert len(data)==end-start+1
                return start,data
            except Exception:
                if attempt==3:raise RuntimeError('Asset range download failed') from None
                time.sleep(2**attempt)
    def checkpoint():
        state['done']=sorted(completed);staged=ledger.with_suffix('.tmp');staged.write_text(json.dumps(state));staged.replace(ledger)
    with temporary.open('r+b' if temporary.exists() else 'w+b') as output:
        output.truncate(asset['size'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            active={pool.submit(fetch,span):span for span in spans}
            for future in concurrent.futures.as_completed(active):
                start,data=future.result();active.pop(future)
                output.seek(start);output.write(data);output.flush();completed.add(start);checkpoint()
                if len(completed)%50==0:print(asset['name']+': '+str(round((state['prefix']+sum(min(1024*1024,asset['size']-s) for s in completed))/1024**2))+' MB saved',flush=True)
    assert len(completed)==len(range(state['prefix'],asset['size'],1024*1024))
    ledger.unlink()
def api(path):
    response=requests.get(API+path,headers=headers,timeout=60);response.raise_for_status();return response.json()
def asset(asset,destination):
    destination.parent.mkdir(parents=True,exist_ok=True)
    temporary=destination.with_suffix(destination.suffix+'.tmp')
    for attempt in range(4):
        try:
            offset=temporary.stat().st_size if temporary.exists() else 0
            # Strip the repository credential before following an asset-storage redirect.
            response=requests.get(asset['url'],headers={**headers,'Accept':'application/octet-stream'},allow_redirects=False,stream=True,timeout=60)
            if response.status_code in [301,302,303,307,308]:
                location=response.headers['Location'];response.close()
                if asset['size']>8*1024*1024:
                    parallel_asset(location,asset,temporary);temporary.replace(destination);return
                response=requests.get(location,headers={'Range':f'bytes={offset}-'} if offset else {},stream=True,timeout=60)
            assert response.status_code in [200,206],f'Asset HTTP {response.status_code}'
            append=response.status_code==206 and offset>0
            if append:assert response.headers.get('Content-Range')==f"bytes {offset}-{asset['size']-1}/{asset['size']}"
            with response,temporary.open('ab' if append else 'wb') as output:
                for chunk in response.iter_content(1024*1024):output.write(chunk)
            assert temporary.stat().st_size==asset['size']
            temporary.replace(destination);return
        except Exception:
            if attempt==3:raise RuntimeError('Asset transfer failed for '+asset['name']+'; saved bytes can be resumed') from None
            print('Retrying '+asset['name'],flush=True);time.sleep(2**attempt)
if args.command=='status':
    runs=api('/actions/runs?branch=research%2Fopenalex-snapshot-run&per_page=3')['workflow_runs']
    for run in runs:
        print(json.dumps({k:run[k] for k in ['id','status','conclusion','html_url']}))
        jobs=api('/actions/runs/'+str(run['id'])+'/jobs')['jobs']
        print(json.dumps([{k:j[k] for k in ['id','name','status','conclusion']} for j in jobs]))
        for job in jobs:
            if job['status']!='completed':continue
            response=requests.get(API+'/actions/jobs/'+str(job['id'])+'/logs',headers=headers,allow_redirects=False,timeout=60)
            if response.status_code!=302:continue
            log=requests.get(response.headers['Location'],timeout=60).text
            lines=[line for line in log.splitlines() if '{"part"' in line or '{"finished"' in line or 'Error:' in line or 'Traceback' in line]
            print(json.dumps({'job':job['name'],'progress':lines[-3:]}))
else:
    releases=api('/releases?per_page=100')
    release=next(item for item in releases if item['tag_name']=='openalex-20260923-'+args.phase)
    assert release['draft'],'Only the internal draft evidence release should be used'
    assets={item['name']:item for item in release['assets']}
    download=ROOT/'runner-download'/args.phase;download.mkdir(parents=True,exist_ok=True)
    imports=ROOT/'remote'/args.phase;imports.mkdir(parents=True,exist_ok=True)
    expected={}
    assert len(set(args.parts))==len(args.parts)
    for part in args.parts:
        name=f'{args.phase}-proof-{part}.json';asset(assets[name],download/name)
        proof=json.loads((download/name).read_text(encoding='utf-8'))
        assert not proof['sample'] and proof['phase']==args.phase
        assert proof['manifestSha256']==hashlib.sha256((ROOT/'manifest.json').read_bytes()).hexdigest()
        for item in proof['files']:
            assert item['path'] not in expected;expected[item['path']]=item
        name=f'{args.phase}-bundles-{part}.json';asset(assets[name],download/name)
        bundles=json.loads((download/name).read_text())
        assert bundles['manifestSha256']==proof['manifestSha256']
        for bundle in bundles['bundles']:
            path=download/bundle['name']
            if not path.exists() or path.stat().st_size!=bundle['bytes'] or hashlib.file_digest(path.open('rb'),'sha256').hexdigest()!=bundle['sha256']:
                print('Downloading '+bundle['name'],flush=True);asset(assets[bundle['name']],path)
            with path.open('rb') as file:assert hashlib.file_digest(file,'sha256').hexdigest()==bundle['sha256']
            with tarfile.open(path,'r|') as archive:
                for member in archive:
                    assert member.isfile() and re.fullmatch(r'[0-9a-f]{64}\.json\.gz',member.name) and member.name in expected
                    destination=imports/member.name;temporary=destination.with_suffix('.tmp')
                    if destination.exists():
                        with destination.open('rb') as file:
                            if hashlib.file_digest(file,'sha256').hexdigest()==expected[member.name]['sha256']:continue
                    with archive.extractfile(member) as source,temporary.open('wb') as output:shutil.copyfileobj(source,output)
                    with temporary.open('rb') as file:assert hashlib.file_digest(file,'sha256').hexdigest()==expected[member.name]['sha256']
                    temporary.replace(destination)
            print('Verified '+bundle['name'],flush=True)
    manifest=json.loads((ROOT/'manifest.json').read_text())
    selected=[entry for i,entry in enumerate(manifest['files']) if i%4 in args.parts]
    assert len(expected)==len(selected)
    assert sum(item['scanned'] for item in expected.values())==sum(entry['meta']['record_count'] for entry in selected)
    (imports/'proof.json').write_text(json.dumps({'phase':args.phase,'files':expected}),encoding='utf-8')
    print(json.dumps({'phase':args.phase,'parts':args.parts,'files':len(expected),'scanned':sum(item['scanned'] for item in expected.values()),'status':'verified-download'}))
