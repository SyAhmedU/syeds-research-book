// _srb_corpus_smoke.mjs — headless browser smoke for the recent-corpus matrix/graph tier.
// Serves the project dir and drives system Chrome via puppeteer-core (_mobile-audit).
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const require = createRequire('C:/Users/Syed Asrar/_mobile-audit/package.json');
const puppeteer = require('puppeteer-core');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});

const results = [];
const ok = (name, cond, extra = '') => { results.push([cond, name + (extra ? ' — ' + extra : '')]); };

await new Promise((r) => server.listen(8099, r));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text()); });
  page.on('requestfailed', (r) => errs.push('reqfail:' + r.url().split('/').pop() + ' ' + (r.failure() || {}).errorText));
  await page.goto('http://localhost:8099/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const r = document.querySelector('#resCount'); return r && /\d/.test(r.textContent); }, { timeout: 15000 });

  // go to Map view (auto-inits corpus tier)
  await page.evaluate(() => { const b = document.querySelector('[data-view="map"]'); if (b) b.click(); else setView('map'); });
  try {
    // graph nodes rendering proves CC loaded + drew
    await page.waitForFunction(() => document.querySelectorAll('#mapSvg .node').length > 5, { timeout: 18000 });
  } catch (e) {
    const diag = await page.evaluate(() => ({ ccN: (typeof CC !== 'undefined' && CC.constructs) ? CC.constructs.length : 'noCC', corpusOn: document.querySelector('#mxTierCorpus') ? document.querySelector('#mxTierCorpus').classList.contains('on') : '?', svg: document.querySelector('#mapSvg') ? document.querySelector('#mapSvg').innerHTML.slice(0, 80) : 'noSvg' }));
    console.log('DIAG ' + JSON.stringify(diag));
    console.log('ERRS:', errs.slice(0, 6).join('\n      '));
    throw e;
  }
  ok('corpus tier button active', await page.evaluate(() => document.querySelector('#mxTierCorpus').classList.contains('on')));
  ok('graph renders nodes', await page.evaluate(() => document.querySelectorAll('#mapSvg .node').length > 5), await page.evaluate(() => document.querySelectorAll('#mapSvg .node').length + ' nodes'));

  // switch to matrix
  await page.click('#mapModeMatrix');
  await page.waitForFunction(() => document.querySelectorAll('#mxGrid .mx-cell').length > 50, { timeout: 8000 });
  const gridText = await page.evaluate(() => document.querySelector('#mxGrid').textContent);
  ok('matrix grid renders', await page.evaluate(() => document.querySelectorAll('#mxGrid .mx-cell').length > 50));
  ok('clean construct labels (not 167-groupings)', /Knowledge Management|Innovation|Work Engagement/.test(gridText));
  ok('leads panel visible', await page.evaluate(() => { const l = document.querySelector('#mxLeads'); return l && !l.hidden && l.querySelectorAll('.mx-lead-row').length > 0; }));
  ok('note says recent corpus', /recent corpus/i.test(await page.evaluate(() => document.querySelector('#mxNote').textContent)));

  // drill-down: click the strongest leads row → Library with papers
  await page.click('#mxLeads .mx-lead-row');
  await page.waitForFunction(() => document.querySelector('#v-library') && !document.querySelector('#v-library').classList.contains('hidden'), { timeout: 8000 });
  await page.waitForFunction(() => +document.querySelector('#resCount').textContent.replace(/,/g, '') > 0, { timeout: 8000 });
  const cnt = await page.evaluate(() => +document.querySelector('#resCount').textContent.replace(/,/g, ''));
  ok('drill-down opens papers', cnt > 0, cnt + ' papers');
  ok('drill-down chip shown', await page.evaluate(() => { const x = document.querySelector('#xfilterNote'); return x && !x.hidden && /recent-corpus papers/.test(x.textContent); }));

  ok('no page JS errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
  ok('smoke ran without exception', false, String(e).slice(0, 160));
} finally {
  await browser.close();
  server.close();
}

let pass = 0;
for (const [c, n] of results) { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (c) pass++; }
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
