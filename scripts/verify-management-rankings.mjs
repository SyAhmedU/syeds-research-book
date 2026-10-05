import fs from 'node:fs';
import assert from 'node:assert/strict';
import { applyRankings, normalizeTitle } from './management-rankings.mjs';
const read = name => JSON.parse(fs.readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const evidence = read('management-rankings.json'), catalog = read('management-journals.json');
assert.equal(evidence.records.length, 1512);
assert.deepEqual(evidence.coverage.quartiles, { Q3: 344, Q2: 448, Q1: 720 });
assert.equal(new Set(evidence.records.map(r => normalizeTitle(r.name))).size, 1512);
for (const source of catalog.sources) {
  assert(source.scopusSourceId && source.registryEvidence.sheet);
  assert.equal(source.sourceType, source.registryEvidence.sheet === 'Serial Conf. Proc. with Profile' ? 'conference-series' :
    { Journal: 'journal', 'Book Series': 'book-series', 'Trade Journal': 'trade-publication' }[source.sourceTypeRaw]);
  if (!source.quartile) continue;
  const row = evidence.records.find(r => normalizeTitle(r.name) === normalizeTitle(source.name));
  assert(row);
  assert.equal(source.quartile, row.quartile);
  assert.equal(source.highestPercentile, row.highestPercentile);
  assert.equal(source.rankingYear, 2025);
  assert.equal(source.quartileScope, 'highest-across-categories');
  assert.deepEqual(source.rankingEvidence, row.evidence);
}
assert(catalog.journals.every(s => s.sourceType === 'journal'));
assert.equal(catalog.coverage.rankedSources + catalog.ranking.unmatched.length, 1512);
const duplicate = structuredClone(catalog);
const rank = evidence.records.find(r => catalog.journals.some(j => normalizeTitle(j.name) === normalizeTitle(r.name)));
const record = duplicate.sources.find(s => normalizeTitle(s.name) === normalizeTitle(rank.name));
delete record.quartile;
duplicate.sources.push(structuredClone(record));
applyRankings(duplicate, { ...evidence, records: [rank] });
assert(!record.quartile, 'ambiguous registry title must not receive a rank');
assert.equal(duplicate.ranking.unmatched[0].reason, 'ambiguous-registry-title');
const dupEvidence = { ...evidence, records: [rank, rank] };
applyRankings(duplicate, dupEvidence);
assert.equal(duplicate.ranking.unmatched[0].reason, 'duplicate-export-title');
console.log(`PASS: ${evidence.records.length} export rows, ${catalog.coverage.rankedSources} attached rankings, ${catalog.ranking.unmatched.length} retained for review; official source types and ambiguous-match rejection.`);
