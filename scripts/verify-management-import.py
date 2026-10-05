"""Check published records against staged API evidence, then exercise the actual UI."""
import argparse
import json
import sqlite3
import subprocess
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url',help='Optional deployed URL; API calls remain blocked for deterministic testing')
args=parser.parse_args()
DATA = ROOT / 'data'
read = lambda p: json.loads(p.read_text(encoding='utf-8-sig'))
manifest = read(DATA / 'management/manifest.json')
baseline = read(DATA / 'papers.index.json') + read(DATA / 'recent.index.json')
have = {p['id'].lower() for p in baseline}
registry = read(DATA / 'management-journals.json')
source_issns = {}
ranked_source_ids = {s['sourceId'] for s in registry['sources'] if s.get('sourceId') and s['sourceType']=='journal' and s.get('quartile') in ['Q1','Q2']}
for source in registry['sources']:
    if source.get('sourceId') and source['sourceType']=='journal':
        source_issns.setdefault(source['sourceId'],set()).update(source['issns'])
added = []
for file in manifest['files']:
    rows = read(DATA / 'management' / file['path'])
    assert len(rows) == file['count'] <= 500
    for paper in rows:
        assert paper['id'].lower() not in have, 'duplicate baseline/import identity'
        have.add(paper['id'].lower())
        assert paper['sourceType'] == file['sourceType']
        assert (paper.get('openalexId') or '').startswith('https://openalex.org/W') or paper.get('metadataSource') == 'crossref'
        assert 'scopusPercentile' not in paper, 'source ranking backfilled onto historical paper'
    added.extend(rows)
assert len(added) == manifest['publishedNewPapers']
database = sqlite3.connect(DATA / 'openalex-refresh/management/harvest.sqlite')
abstract_count = 0
with_references = []
with_abstract = []
shard = lambda key: f'{__import__("functools").reduce(lambda h,c:(h*31+ord(c))&0xffffffff,key,0)%64:02}'
abstracts = {k: v for path in (DATA / 'management/abstracts').glob('*.json') for k, v in read(path).items()}
references = {k: v for path in (DATA / 'management/references').glob('*.json') for k, v in read(path).items()}
for paper in added:
    work_key = paper['openalexId'].split('/')[-1] if paper.get('openalexId') else 'doi:'+paper['doi']
    original, abstract = database.execute('SELECT record,abstract FROM works WHERE id=?', (work_key,)).fetchone()
    if paper.get('metadataSource') == 'crossref':
        evidence = json.loads(database.execute('SELECT payload FROM crossref_evidence WHERE doi=?',(paper['doi'],)).fetchone()[0])
        assert paper['title'] == evidence['title'][0] and paper['doi'] == evidence['DOI'].lower()
        assert evidence['type'] == 'journal-article'
        assert paper['sourceId'] in ranked_source_ids
        assert source_issns[paper['sourceId']].intersection(x.replace('-','') for x in evidence.get('ISSN',[]))
    original = json.loads(original)
    for field in ['title', 'doi', 'authors', 'year', 'journal', 'sourceId', 'sourceType', 'importRole']:
        assert paper[field] == original[field], (field, paper['id'])
    if paper['hasAbstract']:
        assert abstracts[paper['id']] == abstract
        with_abstract.append(paper)
        abstract_count += 1
    if paper['id'] in references:
        assert len(references[paper['id']]) == database.execute('SELECT COUNT(*) FROM edges WHERE citing=?', (paper['openalexId'].split('/')[-1],)).fetchone()[0]
        if references[paper['id']]:
            with_references.append(paper)
assert abstract_count == manifest['papersWithAbstract']
if manifest.get('crossref'):
    assert manifest['crossref']['records'] == sum(p.get('metadataSource')=='crossref' for p in added)
    assert manifest['crossref']['abstracts'] == sum(p.get('metadataSource')=='crossref' and p['hasAbstract'] for p in added)
assert database.execute('SELECT COUNT(*) FROM edges').fetchone()[0] == manifest['referenceEdges']
database.close()
subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', 'data/papers.index.json', 'data/papers.json', 'data/constructs.json', 'data/memberships.json'], cwd=ROOT, check=True)
cooc = read(DATA / 'construct-cooccurrence.json')
memberships = read(DATA / 'construct-memberships.json')
assert memberships['papersScanned'] == len(read(DATA / 'recent.index.json')) + sum(p['sourceType'] == 'journal' for p in added)
assert any(p['id'] in memberships['memberships'] for p in added), 'import not reflected in construct map'
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
        page.wait_for_function('S.managementLoaded', timeout=180000)
        assert page.evaluate('S.managementAdded') == len(added)
        assert page.evaluate('libraryPapers().length') == before + len(added)
        assert page.evaluate('new Set(S.papers.map(p=>p.id.toLowerCase())).size===S.papers.length')
        assert 'partial coverage' in page.locator('#freshNote').inner_text()
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
        assert page.evaluate('S.filtered.every(p=>sourceTypeOf(p.journal)==="conference-series")')
        page.select_option('#fSourceType', 'journal')
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
        print(f'PASS {"LIVE" if args.url else "LOCAL"}: {len(added):,} additional real records; {abstract_count:,} verbatim abstracts; {manifest["referenceEdges"]:,} source reference edges; tier counts/toggles, source isolation, historical abstracts, references, updated trends/map, mobile, and immutable hand-coded corpus.')
    finally:
        browser.close()
        server.shutdown()
        server.server_close()
