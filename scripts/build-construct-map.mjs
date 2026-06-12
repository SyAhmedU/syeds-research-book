// build-construct-map.mjs — construct crosswalk (NO AI).
//
// Links the Book's constructs (hand-coded 167 + recent-tier machine phrases)
// to the theories that use them (TheoryScope catalog `constructs[]`) and the
// scales that measure them (ScaleScope catalog `construct` field) by
// deterministic label matching — exact normalized string, light plural fold.
// Every link points at a real catalog entry; nothing is inferred or invented.
//
// Output: data/constructs.map.json
//   { byCode:   { <hand code> : {theories:[{s,n}], scales:[{id,n,ab}]} },
//     byPhrase: { <recent phrase> : same } }
// Run after theoryscope/scalebase catalog changes or a constructs re-mine:
//   node scripts/build-construct-map.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const HOME = os.homedir();
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));

function norm(s) {
  return s.toLowerCase().replace(/[‐-―−]/g, '-').replace(/[’']/g, "'").replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}
/** label → set of match keys (exact + light plural fold, both directions) */
function keysOf(label) {
  const k = norm(label);
  const out = new Set([k]);
  if (k.endsWith('ies')) out.add(k.slice(0, -3) + 'y');
  else if (k.endsWith('s') && !k.endsWith('ss') && k.length > 4) out.add(k.slice(0, -1));
  else if (k.endsWith('y')) out.add(k.slice(0, -1) + 'ies');
  else out.add(k + 's');
  return out;
}

// ---------- load ----------
const hand = readJson(join(DATA, 'constructs.json'));
const handArr = Array.isArray(hand) ? hand : hand.constructs;
const recent = readJson(join(DATA, 'constructs.recent.json'));
const theories = readJson(join(HOME, 'theoryscope', 'public', 'data', 'theories.json')).theories;
const scales = readJson(join(HOME, 'scalebase', 'client', 'public', 'data', 'scales.json')).scales;
console.log(`[map] ${handArr.length} hand constructs · ${recent.constructs.length} recent phrases · ${theories.length} theories · ${scales.length} scales`);

// match key → hand codes (via the controlled identifier vocabulary)
const keyToCodes = new Map();
for (const c of handArr) {
  for (const id of [c.name, ...(c.identifiers || [])]) {
    for (const k of keysOf(id)) {
      if (!keyToCodes.has(k)) keyToCodes.set(k, new Set());
      keyToCodes.get(k).add(c.code);
    }
  }
}
// match key → recent phrases (phrases are already normalized lowercase)
const keyToPhrases = new Map();
for (const c of recent.constructs) {
  for (const k of keysOf(c.t)) {
    if (!keyToPhrases.has(k)) keyToPhrases.set(k, new Set());
    keyToPhrases.get(k).add(c.t);
  }
}

// ---------- link ----------
const byCode = {};
const byPhrase = {};
const bucket = (store, key) => (store[key] ??= { theories: [], scales: [] });
const pushOnce = (arr, item, idKey) => { if (!arr.some((x) => x[idKey] === item[idKey])) arr.push(item); };

let thLinks = 0, scLinks = 0;
for (const t of theories) {
  for (const label of t.constructs || []) {
    for (const k of keysOf(label)) {
      for (const code of keyToCodes.get(k) || []) { pushOnce(bucket(byCode, code).theories, { s: t.slug, n: t.name }, 's'); thLinks++; }
      for (const ph of keyToPhrases.get(k) || []) { pushOnce(bucket(byPhrase, ph).theories, { s: t.slug, n: t.name }, 's'); thLinks++; }
    }
  }
}
for (const s of scales) {
  for (const k of keysOf(s.construct || '')) {
    for (const code of keyToCodes.get(k) || []) { pushOnce(bucket(byCode, code).scales, { id: s.id, n: s.name, ab: s.abbreviation || '' }, 'id'); scLinks++; }
    for (const ph of keyToPhrases.get(k) || []) { pushOnce(bucket(byPhrase, ph).scales, { id: s.id, n: s.name, ab: s.abbreviation || '' }, 'id'); scLinks++; }
  }
}

const codesLinked = Object.keys(byCode).length;
const phrasesLinked = Object.keys(byPhrase).length;
console.log(`[map] linked: ${codesLinked}/${handArr.length} hand codes, ${phrasesLinked}/${recent.constructs.length} recent phrases`);

writeFileSync(
  join(DATA, 'constructs.map.json'),
  JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'deterministic label match: Book construct vocabulary × TheoryScope constructs[] × ScaleScope construct field — machine-matched, verify',
    theoriesCatalog: theories.length,
    scalesCatalog: scales.length,
    byCode,
    byPhrase,
  }),
);
console.log('[map] wrote data/constructs.map.json');

// quick sample
const sample = Object.entries(byCode).slice(0, 3);
for (const [code, v] of sample) console.log(`  ${code}: ${v.theories.length} theories, ${v.scales.length} scales`);
