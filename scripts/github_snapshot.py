"""Read runner status or retrieve verified temporary snapshot release assets.

Uses the existing Git credential internally; never prints credentials or signed URLs.
"""
import argparse,gzip,hashlib,json,re,shutil,subprocess,tarfile,time
from pathlib import Path
import requests

REPO='SyAhmedU/syeds-research-book'
API='https://api.github.com/repos/'+REPO
ROOT=Path('E:/ResearchBook/openalex-snapshot')
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('command',choices=['status','download'])
parser.add_argument('--phase',choices=['sources','references'],default='sources')
args=parser.parse_args()
credential=subprocess.run(['git','credential','fill'],input='protocol=https\nhost=github.com\n\n',text=True,capture_output=True,check=True)
values=dict(line.split('=',1) for line in credential.stdout.splitlines() if '=' in line)
headers={'Authorization':'Bearer '+values['password'],'Accept':'application/vnd.github+json'}
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
    runs=api('/actions/runs?branch=research%2Fopenalex-snapshot-run&per_page=1')['workflow_runs']
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
    release=api('/releases/tags/openalex-20260923-'+args.phase)
    assert release['draft'],'Only the internal draft evidence release should be used'
    assets={item['name']:item for item in release['assets']}
    download=ROOT/'runner-download'/args.phase;download.mkdir(parents=True,exist_ok=True)
    imports=ROOT/'remote'/args.phase;imports.mkdir(parents=True,exist_ok=True)
    expected={}
    for part in range(4):
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
                    with archive.extractfile(member) as source,temporary.open('wb') as output:shutil.copyfileobj(source,output)
                    with temporary.open('rb') as file:assert hashlib.file_digest(file,'sha256').hexdigest()==expected[member.name]['sha256']
                    temporary.replace(destination)
            print('Verified '+bundle['name'],flush=True)
    manifest=json.loads((ROOT/'manifest.json').read_text())
    assert len(expected)==len(manifest['files'])
    assert sum(item['scanned'] for item in expected.values())==manifest['record_count']
    (imports/'proof.json').write_text(json.dumps({'phase':args.phase,'files':expected}),encoding='utf-8')
    print(json.dumps({'phase':args.phase,'files':len(expected),'scanned':manifest['record_count'],'status':'verified-download'}))
