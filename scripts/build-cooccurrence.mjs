// build-cooccurrence.mjs — STEP 2/2 of the matrix rebuild (NO AI).
//
// Reads construct-memberships.json (each paper's REAL construct set) and counts,
// for every pair of constructs, how many papers study BOTH. Also carries the
// per-construct totals + expected/lift inputs the coverage-gap layer needs.
// Counting only — no relationship SIGN is inferred (No-fab: the corpus records
// co-occurrence, not effect direction).
//
// Output: data/construct-cooccurrence.json
//   { N, constructs:[{id,label,n}], pairs:[[i,j,n], …]  (i<j, n>=2) }
// Run:    node scripts/build-cooccurrence.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));

const mem = readJson(join(DATA, 'construct-memberships.json'));
const constructs = mem.constructs.map((c) => ({ id: c.id, label: c.label, n: c.n }));
const C = constructs.length;

// pair counts via a flat map keyed i*C+j (i<j)
const pairCount = new Map();
let N = 0, pairIncrements = 0;
for (const doi in mem.memberships) {
  const ids = mem.memberships[doi];
  if (ids.length >= 1) N++;
  if (ids.length < 2) continue;
  const s = [...new Set(ids)].sort((a, b) => a - b);
  for (let a = 0; a < s.length; a++)
    for (let b = a + 1; b < s.length; b++) {
      const k = s[a] * C + s[b];
      pairCount.set(k, (pairCount.get(k) || 0) + 1);
      pairIncrements++;
    }
}

const pairs = [];
for (const [k, n] of pairCount) {
  if (n < 2) continue;
  pairs.push([Math.floor(k / C), k % C, n]);
}
pairs.sort((a, b) => b[2] - a[2]);

writeFileSync(join(DATA, 'construct-cooccurrence.json'), JSON.stringify({
  version: 1,
  generatedAt: new Date().toISOString(),
  source: 'construct-memberships.json — pairwise co-occurrence counts (papers studying both). Counting only; no effect sign.',
  N,
  papersWithPair: [...pairCount.values()].filter((n) => n >= 2).length,
  constructs,
  pairs,
}));

console.log(`[cooc] N(≥1 construct)=${N}  distinct pairs(≥2)=${pairs.length}  totalPairIncrements=${pairIncrements}`);
const lbl = (i) => constructs[i].label;
console.log('\nTop 30 co-studied construct pairs:');
for (const [i, j, n] of pairs.slice(0, 30)) console.log(`  ${String(n).padStart(5)}  ${lbl(i)}  ×  ${lbl(j)}`);
