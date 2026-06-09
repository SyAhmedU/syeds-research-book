// Merge the staged OpenAlex refresh (construct + journal modes) into a single
// lazy-loaded "recent" tier the SRB site can show alongside the hand-coded
// corpus — WITHOUT touching papers.index.json (the hand-coded moat stays clean).
//
// Output: data/recent.index.json  (array, no abstracts — eager-on-toggle)
//         data/recent.abstracts.json (doi → abstract, lazy)
//
// Re-runnable: just run it again after the journal fetch finishes to refresh the
// snapshot. Dedups by DOI (construct tags win), drops junk-dated records, and
// never includes a DOI already in the hand-coded index.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const REF = path.join(DATA, 'openalex-refresh');
const NEXT_YEAR = new Date().getFullYear() + 1;

const stripBom = (s) => s.replace(/^﻿/, '');
function readJsonSafe(p, fallback) {
  try { return JSON.parse(stripBom(fs.readFileSync(p, 'utf8'))); } catch { return fallback; }
}

// Hand-coded DOIs — never duplicate one of Syed's records into the recent tier.
const handCoded = new Set();
for (const p of readJsonSafe(path.join(DATA, 'papers.index.json'), [])) handCoded.add((p.doi || p.id).toLowerCase());

const merged = new Map();   // doi → record
const abstracts = {};

for (const mode of ['construct', 'journal', 'author']) {
  const recs = readJsonSafe(path.join(REF, `${mode}.papers.json`), {});
  const abs = readJsonSafe(path.join(REF, `${mode}.abstracts.json`), {});
  for (const [doi, rec] of Object.entries(recs)) {
    const key = doi.toLowerCase();
    if (handCoded.has(key)) continue;                         // already Syed's
    if (typeof rec.year === 'number' && (rec.year > NEXT_YEAR || rec.year < 1950)) continue; // junk date
    if (!rec.title || !rec.journal) continue;                 // need a real title + venue
    const prev = merged.get(key);
    if (prev) {
      // Union construct codes (construct mode tags them; journal mode leaves []).
      const codes = new Set([...(prev.constructCodes || []), ...(rec.constructCodes || [])]);
      prev.constructCodes = [...codes];
    } else {
      merged.set(key, { ...rec });
    }
    if (abs[doi] && !abstracts[doi]) abstracts[doi] = abs[doi];
  }
}

const out = [...merged.values()];

// Construct-tag the journal/author papers (which arrive untagged) by matching
// each construct's hand-curated identifier vocabulary VERBATIM (word-bounded)
// against the paper's title + abstract — so the recent tier is navigable by the
// corpus's 167-construct spine too. Machine/heuristic, like construct-fetch mode
// (and badged auto-fetched); only fills EMPTY constructCodes, never overrides.
const constructs = readJsonSafe(path.join(DATA, 'constructs.json'), []);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = constructs.map((c) => {
  const ids = [...new Set((c.identifiers || []).map((s) => String(s).trim()).filter((s) => s.length >= 5))];
  return ids.length ? { code: c.code, re: new RegExp('\\b(' + ids.map(escRe).join('|') + ')\\b', 'i') } : null;
}).filter(Boolean);
let newlyTagged = 0, newTags = 0;
for (const p of out) {
  if (p.constructCodes && p.constructCodes.length) continue; // keep hand-coded / construct-fetch tags
  const hay = (p.title + ' ' + (abstracts[p.id] || '')).slice(0, 4000);
  const codes = [];
  for (const m of matchers) { if (m.re.test(hay)) { codes.push(m.code); if (codes.length >= 5) break; } }
  if (codes.length) { p.constructCodes = codes; newlyTagged++; newTags += codes.length; }
}
console.log(`[merge] construct-tagged ${newlyTagged} previously-untagged papers (${newTags} tags, ≤5 each, identifier-verbatim)`);

fs.writeFileSync(path.join(DATA, 'recent.index.json'), JSON.stringify(out));

// Abstracts are sharded by DOI hash into data/recent.abstracts/<NN>.json so no
// single file approaches GitHub's 100 MB limit as the tier grows; the client
// loads only the shard a given paper needs. (Index stays one file — metadata-only.)
const SHARDS = 16;
const shardOf = (doi) => { let h = 0; for (let i = 0; i < doi.length; i++) h = (h * 31 + doi.charCodeAt(i)) >>> 0; return String(h % SHARDS).padStart(2, '0'); };
const ABSDIR = path.join(DATA, 'recent.abstracts');
fs.rmSync(ABSDIR, { recursive: true, force: true });
fs.mkdirSync(ABSDIR, { recursive: true });
const buckets = {};
for (const [doi, ab] of Object.entries(abstracts)) { const sh = shardOf(doi); (buckets[sh] || (buckets[sh] = {}))[doi] = ab; }
for (let i = 0; i < SHARDS; i++) { const sh = String(i).padStart(2, '0'); fs.writeFileSync(path.join(ABSDIR, `${sh}.json`), JSON.stringify(buckets[sh] || {})); }
try { fs.rmSync(path.join(DATA, 'recent.abstracts.json')); } catch { /* old monolith gone */ }

const byYear = {};
for (const r of out) byYear[r.year] = (byYear[r.year] || 0) + 1;
const tagged = out.filter((r) => r.constructCodes && r.constructCodes.length).length;
console.log(`[merge] recent tier: ${out.length} papers (${Object.keys(abstracts).length} w/ abstract)`);
console.log(`[merge] construct-tagged: ${tagged} · journal-only (untagged): ${out.length - tagged}`);
console.log(`[merge] distinct journals: ${new Set(out.map((r) => r.journal)).size}`);
console.log(`[merge] by year:`, JSON.stringify(Object.fromEntries(Object.entries(byYear).filter(([y]) => +y >= 2023).sort())));
console.log(`[merge] → data/recent.index.json + data/recent.abstracts/<00-${String(SHARDS - 1).padStart(2, '0')}>.json`);
