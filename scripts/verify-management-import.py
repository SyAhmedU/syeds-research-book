"""Check published records against staged API evidence, then exercise the actual UI."""
import argparse
import json
import gzip
import sqlite3
import subprocess
import time
import unicodedata
from collections import defaultdict
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright, TimeoutError as BrowserTimeout

ROOT = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url',help='Optional deployed URL; API calls remain blocked for deterministic testing')
parser.add_argument('--ui-only',action='store_true',help='Check deployed UI after the same snapshot passed full local provider verification')
parser.add_argument('--load-timeout',type=int,default=180000,help='Import wait limit in milliseconds; progress is reported every 30 seconds')
args=parser.parse_args()
DATA = ROOT / 'data'
read = lambda p: json.loads(gzip.decompress(p.read_bytes()).decode('utf-8') if p.suffix=='.gz' else p.read_text(encoding='utf-8-sig'))
manifest = read(DATA / 'management/manifest.json')
baseline = read(DATA / 'papers.index.json') + read(DATA / 'recent.index.json')
have = {p['id'].lower() for p in baseline}
registry = read(DATA / 'management-journals.json')
source_aliases = read(DATA / 'management' / manifest['sourceAliases']) if manifest.get('sourceAliases') else {'aliases':[],'conferenceDois':[]}
conference_ids = set(source_aliases['conferenceDois'])
source_issns = {}
ranked_source_ids = {s.get('sourceId') or 'https://www.scopus.com/sourceid/'+s['scopusSourceId'] for s in registry['sources'] if s['sourceType'] in ['journal','conference-series'] and s.get('quartile') in ['Q1','Q2']}
for source in registry['sources']:
    if source['sourceType'] in ['journal','conference-series']:
        source_issns.setdefault(source.get('sourceId') or 'https://www.scopus.com/sourceid/'+source['scopusSourceId'],set()).update(source['issns'])
from management_evidence import verify_data
counts,published_keys,with_abstract,abstracts,with_references,references=verify_data(ROOT,manifest,registry,source_aliases,args.ui_only)
added_count=counts['papers'];abstract_count=manifest['papersWithAbstract']
subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', 'data/papers.index.json', 'data/papers.json', 'data/constructs.json', 'data/memberships.json'], cwd=ROOT, check=True)
cooc = read(DATA / 'construct-cooccurrence.json')
memberships = read(DATA / 'construct-memberships.json')
source_types=defaultdict(set)
norm=lambda name:' '.join(unicodedata.normalize('NFKC',name or '').split()).lower()
for source in registry['sources']: source_types[norm(source['name'])].add(source['sourceType'])
excluded_names={name for name,types in source_types.items() if len(types)==1 and 'journal' not in types}
excluded_names.update(norm(alias['name']) for alias in source_aliases['aliases'] if alias['sourceType']!='journal')
recent_rows=read(DATA / 'recent.index.json')
excluded_ids={p['id'].lower() for p in recent_rows if p['id'].lower() in conference_ids or norm(p['journal']) in excluded_names}
recent_journals = [p for p in recent_rows if p['id'].lower() not in excluded_ids]
assert memberships['papersScanned'] == len(recent_journals) + counts['journal']
assert (conference_ids|excluded_ids).isdisjoint(memberships['memberships']), 'non-journal records leaked into journal corpus analysis'
assert any(identity in memberships['memberships'] for identity in published_keys), 'import not reflected in construct map'
assert cooc['N'] == memberships['withConstruct']

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as runtime:
    browser = runtime.chromium.launch(channel='chrome', headless=True)
    try:
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('https://api.openalex.org/**', lambda route: route.fulfill(status=200, json={'results': []}))
        page.goto(args.url or f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle',timeout=60000)
        page.wait_for_function('S.recentLoaded && S.managementManifest',timeout=60000)
        before = page.evaluate('libraryPapers().length')
        page.check('#fManagement')
        deadline=time.monotonic()+args.load_timeout/1000
        while not page.evaluate('!!S.managementLoaded'):
            try:
                page.wait_for_function('S.managementLoaded',timeout=min(30000,max(1,int((deadline-time.monotonic())*1000))))
            except BrowserTimeout:
                state=page.evaluate('({label:document.querySelector("#fManagementLbl")?.textContent,error:S.managementImportError,loaded:S.papers.filter(p=>p._management).length})')
                print('Import progress:',state,flush=True)
                assert not state['error'], (state,errors)
                if time.monotonic()>=deadline: raise
        assert page.evaluate('S.managementAdded') == added_count
        print('PASS browser import load and count.',flush=True)
        assert page.evaluate('libraryPapers().length') == before + added_count
        assert page.evaluate('new Set(S.papers.map(p=>p.id.toLowerCase())).size===S.papers.length')
        assert ('complete OpenAlex '+manifest['openalexSnapshot']['release'] if manifest.get('openalexSnapshot') else 'partial coverage') in page.locator('#freshNote').inner_text()
        page.locator('#managementCoverage summary').click()
        assert 'reference links' in page.locator('#managementCoverage').inner_text()
        assert 'Most referenced management journals' in page.locator('#managementCoverage').inner_text()
        example = next(p for p in with_abstract if p['year'] and p['year'] < 1950)
        page.evaluate('(id)=>openDetail(id)', example['id'])
        page.wait_for_function('!document.querySelector("#absBox").textContent.includes("Loading")')
        assert page.locator('#absBox').inner_text() == abstracts[example['id']]
        assert 'All-years import' in page.locator('#mcontent').inner_text()
        page.locator('#mclose').click()
        crossref_example = next((p for p in with_abstract if p.get('metadataSource')=='crossref'),None)
        if crossref_example:
            page.evaluate('(id)=>openDetail(id)',crossref_example['id'])
            page.wait_for_function('!document.querySelector("#absBox").textContent.includes("Loading")')
            assert page.locator('#absBox').inner_text() == abstracts[crossref_example['id']]
            assert 'via Crossref' in page.locator('#mcontent').text_content(), page.locator('#mcontent').text_content()[:1500]
            assert page.get_by_role('link',name='Crossref publisher record ↗').count() == 1
            page.locator('#mclose').click()
        reference_example = max(with_references, key=lambda p: len(references[p['id']]))
        page.evaluate('(id)=>openDetail(id)', reference_example['id'])
        page.wait_for_function('document.querySelector("#managementReferences")?.textContent.includes("indexed reference identities")', timeout=60000)
        assert 'metadata' in page.locator('#managementReferences').inner_text()
        page.locator('#mclose').click()
        page.select_option('#fSourceType', 'conference-series')
        assert page.evaluate('S.filtered.every(p=>paperSourceType(p)==="conference-series")')
        if conference_ids:
            assert page.evaluate('S.filtered.filter(p=>S.managementConferenceDois.has(p.id.toLowerCase())).length') == len(conference_ids)
        page.select_option('#fSourceType', 'journal')
        assert page.evaluate('S.filtered.every(p=>!S.managementConferenceDois?.has(p.id.toLowerCase()))')
        page.locator('[data-view="trends"]').click()
        assert 'imported machine tags' in page.locator('#trendModeNote').inner_text()
        page.locator('[data-view="map"]').click()
        page.wait_for_function('CC.loaded')
        assert page.evaluate('CC.N') == cooc['N']
        # Loading the new tier must never change hand-coded map counts.
        assert page.evaluate('S.papers.filter(p=>!p._recent&&!p._management&&!p._live).length') == 9388
        page.locator('[data-view="library"]').click()
        page.select_option('#fSourceType', '')
        page.uncheck('#fManagement')
        assert page.evaluate('libraryPapers().length') == before
        assert page.evaluate('S.filtered.every(p=>!p._management)')
        page.set_viewport_size({'width': 393, 'height': 852})
        page.check('#fManagement')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        page.screenshot(path=str(ROOT / '_smoke_management_import.png'))
        assert not errors, errors
        print(f'PASS {"LIVE UI (provider evidence verified locally)" if args.ui_only else "LIVE" if args.url else "LOCAL"}: {added_count:,} additional real records; {abstract_count:,} verbatim abstracts; {manifest["referenceEdges"]:,} source reference edges; tier counts/toggles, source isolation, historical abstracts, references, updated trends/map, mobile, and immutable hand-coded corpus.')
    finally:
        browser.close()
        server.shutdown()
        server.server_close()
