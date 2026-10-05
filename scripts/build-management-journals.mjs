// Exact ISSN crosswalk from Elsevier's local March 2026 registry to OpenAlex.
// No title guessing, invented ranks, or inferred citation edges.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'data');
const cacheDir = path.join(data, 'openalex-refresh');
fs.mkdirSync(cacheDir, { recursive: true });
const read = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } };
const normIssn = s => String(s || '').replace(/[^0-9X]/gi, '').toUpperCase();
const registry = read(path.resolve(root, '../journal-timelines/data/journals.json'), []).filter(j => String(j.field).split(';').some(c => /^14\d\d$/.test(c.trim())));
if (!registry.length) throw Error('Management journal registry unavailable');
const cachePath = path.join(cacheDir, 'management.sources.json');
const cache = read(cachePath, { checked: [], sources: {} });
const checked = new Set(cache.checked);
const issns = [...new Set(registry.flatMap(j => [j.issn, j.eissn]).map(normIssn).filter(s => s.length === 8))];
const pending = issns.filter(s => !checked.has(s));
for (let i = 0; i < pending.length; i += 50) {
  const batch = pending.slice(i, i + 50);
  const url = new URL('https://api.openalex.org/sources');
  url.searchParams.set('filter', 'issn:' + batch.map(s => s.slice(0, 4) + '-' + s.slice(4)).join('|'));
  url.searchParams.set('per_page', '100');
  if (process.env.OPENALEX_API_KEY) url.searchParams.set('api_key', process.env.OPENALEX_API_KEY);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error(`OpenAlex HTTP ${response.status}; checkpoint saved, rerun to resume`);
  const body = await response.json();
  // Refuse to silently mark an overflowing batch complete.
  if (body.meta.count > body.results.length) throw Error('Source lookup overflow; reduce batch size');
  for (const source of body.results) cache.sources[source.id] = { id: source.id, name: source.display_name, issns: source.issn || [], type: source.type, worksCount: source.works_count, verifiedAt: new Date().toISOString() };
  batch.forEach(s => checked.add(s));
  cache.checked = [...checked];
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`ISSNs checked ${checked.size}/${issns.length}; sources ${Object.keys(cache.sources).length}`);
  await new Promise(r => setTimeout(r, 200));
}
const byIssn = new Map();
for (const source of Object.values(cache.sources)) for (const issn of source.issns) {
  const key = normIssn(issn);
  if (!byIssn.has(key)) byIssn.set(key, []);
  byIssn.get(key).push(source);
}
const journals = registry.map(j => {
  const candidates = [...new Map([j.issn, j.eissn].flatMap(s => byIssn.get(normIssn(s)) || []).filter(s => s.type === 'journal').map(s => [s.id, s])).values()];
  const source = candidates.length === 1 ? candidates[0] : null;
  return { name: j.journal, publisher: j.publisher, issns: [j.issn, j.eissn].filter(Boolean), asjc: String(j.field).split(';').map(c => c.trim()).filter(Boolean), sourceId: source?.id || null, sourceName: source?.name || null, worksCount: source?.worksCount ?? null, sourceMatch: source ? 'exact-issn' : candidates.length ? 'ambiguous' : 'unresolved', quartile: null, rankingYear: null, rankingSource: null, registrySource: 'Elsevier Scopus Source List March 2026' };
});
const output = { version: 1, generatedAt: new Date().toISOString(), scope: 'Scopus journals classified in Business, Management and Accounting (ASJC 14xx); ranks not supplied by this registry.', registryUrl: 'https://downloads.ctfassets.net/o78em1y1w4i4/7xtaTxNiNcWRTeZkV86eNy/d232405141a2654fdc6dab977f047a6a/ext_list_Mar_2026.xlsx', journals, coverage: { registryJournals: journals.length, resolved: journals.filter(j => j.sourceId).length, ambiguous: journals.filter(j => j.sourceMatch === 'ambiguous').length, unresolved: journals.filter(j => j.sourceMatch === 'unresolved').length, ranked: 0, referencesHarvested: 0 } };
fs.writeFileSync(path.join(data, 'management-journals.json'), JSON.stringify(output));
console.log(JSON.stringify(output.coverage));
