"""Browser regression checks against the real Research Book datasets."""
import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from threading import Thread
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
read = lambda name: json.loads((root / 'data' / name).read_text(encoding='utf-8-sig'))
hand = read('papers.index.json')
recent = read('recent.index.json')
catalog = read('management-journals.json')
hand_ids = {p['id'] for p in hand}
expected = hand + [p for p in recent if p['id'] not in hand_ids]
hand_names = {p.get('journal') for p in hand if p.get('journal')}
imported_only = next(p for p in recent if p.get('journal') and p['journal'] not in hand_names)
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(root)))
Thread(target=server.serve_forever, daemon=True).start()

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    try:
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        # Keep verification deterministic and avoid external API side effects.
        page.route('https://api.openalex.org/**', lambda route: route.fulfill(status=200, json={'results': []}))
        page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
        page.wait_for_function('S.recentLoaded && S.managementCoverage')
        assert page.evaluate('S.papers.length') == len(expected)
        assert page.evaluate('Number(document.querySelector("#ovStats b").textContent.replaceAll(",",""))') == len(expected)
        assert page.evaluate('S.managementJournals.length') == len(catalog['journals'])
        options = page.locator('#fJournal option').evaluate_all('(opts)=>opts.map(o=>o.value)')
        assert imported_only['journal'] in options
        assert all(j['name'] in options for j in catalog['journals'])
        assert len(options) == len(set(options)), 'duplicate journal options'
        page.select_option('#fJournal', imported_only['journal'])
        expected_count = sum(p.get('journal') == imported_only['journal'] for p in expected)
        assert page.evaluate('S.filtered.length') == expected_count
        page.uncheck('#fRecent')
        assert page.evaluate('S.filtered.length') == 0
        assert page.locator('#fJournal').input_value() == imported_only['journal'], 'selection lost on toggle'
        assert page.evaluate('Number(document.querySelector("#ovStats b").textContent.replaceAll(",",""))') == len(hand)
        page.check('#fRecent')
        assert page.evaluate('S.filtered.length') == expected_count
        page.select_option('#fJournal', '')
        page.locator('[data-view="trends"]').click()
        assert 'imported machine tags' in page.locator('#trendModeNote').inner_text()
        assert page.locator('#trendsWrap tbody tr').count() == 40
        page.locator('#trendShare').click()
        assert 'composition' in page.locator('#trendModeNote').inner_text()
        page.locator('[data-view="library"]').click()
        registry_empty = next(j['name'] for j in catalog['journals'] if not any(paper.get('journal') == j['name'] for paper in expected))
        page.select_option('#fJournal', registry_empty)
        assert page.evaluate('S.filtered.length') == 0
        assert 'not imported' in page.locator('#fJournal option:checked').inner_text()
        page.set_viewport_size({'width': 393, 'height': 852})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'mobile overflow'
        page.screenshot(path=str(root / '_smoke_journal_expansion.png'), full_page=True)
        assert not errors, errors
        print(f'PASS: {len(expected):,} real papers, {len(catalog["journals"]):,} registry journals; imported journal selection/counts, toggle preservation, overview totals, trends, zero coverage, mobile layout; no JS errors.')
    finally:
        browser.close()
        server.shutdown()
        server.server_close()
