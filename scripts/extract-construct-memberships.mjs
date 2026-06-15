// extract-construct-memberships.mjs — STEP 1/2 of the matrix rebuild (NO AI).
//
// Scans every recent-tier paper's TITLE + ABSTRACT and records which canonical
// constructs (from construct-lexicon.json) are actually mentioned — verbatim,
// word-boundary, case-insensitive. Replaces the single fetch-tag each paper
// carried (constructCodes) with its REAL multi-construct membership.
//
// Output: data/construct-memberships.json
//   { constructs:[{id,label,n,byYear}], memberships:{ "<doi>":[constructIdx,…] }, dist, … }
// Run:    node scripts/extract-construct-memberships.mjs

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const normText = (s) =>
  s.toLowerCase().replace(/[’‘]/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- lexicon -> matcher ----------
const lex = readJson(join(DATA, 'construct-lexicon.json'));
const constructs = lex.constructs.map((c) => ({ id: c.id, label: c.label, n: 0, byYear: {} }));
const idxById = new Map(constructs.map((c, i) => [c.id, i]));

// synonym -> Set(constructIdx); then one big word-boundaried alternation, longest first.
const synToIdx = new Map();
for (let i = 0; i < lex.constructs.length; i++) {
  for (const syn of lex.constructs[i].synonyms) {
    const s = normText(syn).trim();
    if (s.length < 4) continue;
    if (!synToIdx.has(s)) synToIdx.set(s, new Set());
    synToIdx.get(s).add(i);
  }
}
const syns = [...synToIdx.keys()].sort((a, b) => b.length - a.length);
console.log(`[scan] ${constructs.length} constructs, ${syns.length} unique synonyms`);
// chunk the alternation to keep each regex sane; alnum boundaries handle spaces/hyphens.
const CHUNK = 1200;
const matchers = [];
for (let i = 0; i < syns.length; i += CHUNK) {
  const part = syns.slice(i, i + CHUNK).map(esc).join('|');
  matchers.push(new RegExp(`(?<![a-z0-9])(?:${part})(?![a-z0-9])`, 'g'));
}

// ---------- load papers + abstracts ----------
console.log('[scan] loading recent tier…');
const index = readJson(join(DATA, 'recent.index.json'));
const papers = Array.isArray(index) ? index : index.papers;
const abstracts = new Map();
for (const f of readdirSync(join(DATA, 'recent.abstracts')).filter((f) => f.endsWith('.json'))) {
  const shard = readJson(join(DATA, 'recent.abstracts', f));
  for (const [doi, text] of Object.entries(shard)) {
    if (typeof text === 'string' && text.length > 30) abstracts.set(doi, text);
  }
}
console.log(`[scan] ${papers.length} papers, ${abstracts.size} abstracts`);

// ---------- scan ----------
const memberships = {};
const dist = { 0: 0, 1: 0, 2: 0, '3plus': 0 };
let scanned = 0, withAbs = 0;
const t0 = Date.now();
for (const p of papers) {
  const doi = p.doi || p.id;
  const abs = abstracts.get(doi) || '';
  if (abs) withAbs++;
  const text = normText(`${p.title || ''}. ${abs}`);
  if (text.length < 25) { dist[0]++; continue; }
  const hits = new Set();
  for (const re of matchers) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) for (const i of synToIdx.get(m[0])) hits.add(i);
  }
  const ids = [...hits];
  if (ids.length === 0) dist[0]++;
  else {
    dist[ids.length === 1 ? 1 : ids.length === 2 ? 2 : '3plus']++;
    memberships[doi] = ids;
    for (const i of ids) {
      constructs[i].n++;
      if (p.year) constructs[i].byYear[p.year] = (constructs[i].byYear[p.year] || 0) + 1;
    }
  }
  if (++scanned % 20000 === 0) console.log(`[scan] ${scanned}/${papers.length} (${((Date.now() - t0) / 1000) | 0}s)`);
}

// ---------- emit ----------
constructs.forEach((c) => { /* keep byYear small-ish; fine as-is */ });
writeFileSync(join(DATA, 'construct-memberships.json'), JSON.stringify({
  version: 1,
  generatedAt: new Date().toISOString(),
  source: 'recent tier titles+abstracts × construct-lexicon.json — verbatim word-boundary match, no AI',
  papersScanned: papers.length,
  abstractsPresent: withAbs,
  withConstruct: Object.keys(memberships).length,
  dist,
  constructs,
  memberships,
}));

const ranked = [...constructs].map((c, i) => ({ ...c, i })).sort((a, b) => b.n - a.n);
console.log(`\n[scan] done in ${((Date.now() - t0) / 1000) | 0}s`);
console.log(`[scan] coverage — 0:${dist[0]}  1:${dist[1]}  2:${dist[2]}  3+:${dist['3plus']}  (≥2 = ${dist[2] + dist['3plus']})`);
console.log('\nTop 25 constructs by papers:');
for (const c of ranked.slice(0, 25)) console.log(`  ${String(c.n).padStart(6)}  ${c.label}`);
console.log('\nBottom (never matched):', ranked.filter((c) => c.n === 0).length, 'of', constructs.length);
