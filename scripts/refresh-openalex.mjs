// Refresh the Research Book corpus with RECENT real papers from OpenAlex.
//
// The committed corpus is Syed's hand-coded 24-month workbook (9,388 papers).
// This pulls genuinely recent work (2024→now) so the library reaches 2026+,
// WITHOUT fabricating anything: every record is a real OpenAlex work (DOI,
// title, authors, year, journal, citations all from the API). Crucially, fetched
// papers are STAGED to data/openalex-refresh/ and tagged `addedVia:'openalex'`
// with MACHINE-assigned construct codes — kept distinct from Syed's hand-coding,
// which stays the verified moat. Merging into the main index is a deliberate,
// separate step.
//
// Modes:
//   construct  — for each of the 167 constructs, fetch recent works matching its
//                vocabulary (title/abstract search). [implemented]
//   journal    — resolve each distinct journal to an OpenAlex source, fetch its
//                recent works. [implemented, slower: a resolve step per journal]
//   author     — recent works by OpenAlex AUTHOR IDs (raw names are too noisy).
//                [requires an author-id list; see --authors]
//
// Usage:
//   node scripts/refresh-openalex.mjs --mode construct --since 2024-01-01 --per 50 [--limit N] [--delay 1100]
//
// Resumable: skips DOIs already in the corpus or already staged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'openalex-refresh');
const MAILTO = 'syedfaceprep@gmail.com'; // OpenAlex "polite pool"

function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const MODE  = arg('mode', 'construct');
const SINCE = arg('since', '2024-01-01');
const PER   = parseInt(arg('per', '50'), 10);
const LIMIT = parseInt(arg('limit', '0'), 10) || Infinity;
const DELAY = parseInt(arg('delay', '1100'), 10);

const stripBom = (s) => s.replace(/^﻿/, '');
const readJson = (f) => JSON.parse(stripBom(fs.readFileSync(path.join(DATA, f), 'utf8')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OpenAlex returns abstracts as an inverted index {word:[positions]} — rebuild.
function invertedToText(inv) {
  if (!inv) return '';
  const out = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) out[p] = w;
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

async function oa(url) {
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + `mailto=${MAILTO}`);
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  return res.json();
}

// Repository hosts are not journals — a "venue" like Zenodo/SSRN/Figshare is a
// deposit, often a duplicate of a journal version. Keep the tier journal-grade.
const REPO_VENUE = /zenodo|ssrn|research square|preprints\.org|authorea|biorxiv|medrxiv|arxiv|figshare|researchgate|^osf\b|qeios/i;

// Map an OpenAlex work → an SRB-shaped record (+ separate abstract). Machine-tagged.
function workToRecord(w, constructCode) {
  const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
  if (!doi) return null;
  const venue = w.primary_location?.source?.display_name || w.host_venue?.display_name || '';
  if (REPO_VENUE.test(venue)) return null;
  // Drop records with obviously-broken year metadata (OpenAlex has stray
  // far-future dates); keep up to next year for legit early-access/forthcoming.
  const yr = w.publication_year;
  if (typeof yr === 'number' && (yr > new Date().getFullYear() + 1 || yr < 1950)) return null;
  const abstract = invertedToText(w.abstract_inverted_index);
  return {
    rec: {
      id: doi,
      doi,
      title: w.display_name || w.title || '',
      authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
      year: w.publication_year,
      journal: w.primary_location?.source?.display_name || w.host_venue?.display_name || '',
      citations: w.cited_by_count ?? 0,
      type: w.type || 'article',
      openAccess: !!w.open_access?.is_oa,
      oaUrl: w.open_access?.oa_url || null,
      constructCodes: constructCode ? [constructCode] : [],
      hasAbstract: !!abstract,
      absSrc: 'openalex',
      addedVia: `openalex-${MODE}`,
      addedAt: new Date().toISOString().slice(0, 10),
    },
    abstract,
  };
}

function loadStaged(name) {
  const p = path.join(OUT, name);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(stripBom(fs.readFileSync(p, 'utf8'))); } catch { return {}; }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`[refresh] mode=${MODE} since=${SINCE} per=${PER}`);

  // Existing DOIs (corpus + committed recent tier + any prior staged run) — never re-add.
  const existing = new Set();
  for (const p of readJson('papers.index.json')) existing.add((p.doi || p.id).toLowerCase());
  try { for (const p of readJson('recent.index.json')) existing.add((p.doi || p.id).toLowerCase()); } catch { /* tier not built yet */ }
  const stagedRecs = loadStaged(`${MODE}.papers.json`);
  const stagedAbs = loadStaged(`${MODE}.abstracts.json`);
  for (const k of Object.keys(stagedRecs)) existing.add(k.toLowerCase());
  console.log(`[refresh] corpus+recent+staged DOIs known: ${existing.size}`);

  // ── Author mode: recent work by the corpus's prolific authors. Resolve each
  // author to their EXACT OpenAlex author ID via a paper we already hold (match
  // the name inside that work's authorships) — reliable, unlike name search.
  if (MODE === 'author') {
    Object.assign(stagedRecs, loadStaged('author.papers.json'));
    Object.assign(stagedAbs, loadStaged('author.abstracts.json'));
    for (const k of Object.keys(stagedRecs)) existing.add(k.toLowerCase());

    const MINPAPERS = parseInt(arg('minpapers', '4'), 10);
    const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    const keyOf = (s) => { const t = norm(s).split(' ').filter(Boolean); if (!t.length) return ''; return t[t.length - 1] + '|' + (t[0][0] || ''); }; // lastname|first-initial

    const aMap = new Map(); // name → { count, doi }
    for (const p of readJson('papers.index.json')) {
      const d = (p.doi || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
      for (const name of (p.authors || [])) {
        const nm = String(name).trim(); if (!nm) continue;
        let e = aMap.get(nm); if (!e) { e = { count: 0, doi: null }; aMap.set(nm, e); }
        e.count++; if (!e.doi && d) e.doi = d;
      }
    }
    let authors = [...aMap.entries()].filter(([, e]) => e.count >= MINPAPERS && e.doi)
      .sort((a, b) => b[1].count - a[1].count).map(([name, e]) => ({ name, doi: e.doi }));
    if (Number.isFinite(LIMIT)) authors = authors.slice(0, LIMIT);
    console.log(`[refresh] ${authors.length} prolific authors (≥${MINPAPERS} corpus papers) to resolve`);

    // Batch-resolve DOIs → author.id by matching the name in that work's authorships.
    const name2id = new Map();
    for (let i = 0; i < authors.length; i += 40) {
      const chunk = authors.slice(i, i + 40);
      const filter = 'doi:' + chunk.map(a => encodeURIComponent(a.doi)).join('|');
      try {
        const data = await oa(`https://api.openalex.org/works?filter=${filter}&select=doi,authorships&per-page=50`);
        const byDoi = new Map();
        for (const w of data.results || []) byDoi.set((w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase(), w.authorships || []);
        for (const a of chunk) {
          const want = keyOf(a.name);
          const hit = (byDoi.get(a.doi.toLowerCase()) || []).find(au => keyOf(au.author && au.author.display_name) === want && au.author && au.author.id);
          if (hit) name2id.set(a.name, String(hit.author.id).split('/').pop());
        }
      } catch { /* skip chunk */ }
      if (i % 200 === 0) console.log(`  resolving ${i}/${authors.length}… (${name2id.size} ids)`);
      await sleep(DELAY);
    }
    console.log(`[refresh] resolved ${name2id.size}/${authors.length} authors to OpenAlex IDs`);

    let processed = 0, added = 0, withAbs = 0;
    const t0 = Date.now();
    for (const [, aid] of name2id) {
      processed++;
      try {
        const data = await oa(`https://api.openalex.org/works?filter=from_publication_date:${SINCE},authorships.author.id:${aid}&sort=publication_date:desc&per-page=${PER}`);
        for (const w of data.results || []) {
          const built = workToRecord(w, null);
          if (!built) continue;
          const doi = built.rec.doi;
          if (existing.has(doi)) continue;
          if (!built.rec.journal) continue; // require a real venue (quality)
          existing.add(doi);
          stagedRecs[doi] = built.rec;
          if (built.abstract) { stagedAbs[doi] = built.abstract; withAbs++; }
          added++;
        }
      } catch { /* skip */ }
      if (processed % 20 === 0) {
        console.log(`  [${processed}/${name2id.size}] +${added} new (${(processed / ((Date.now() - t0) / 1000)).toFixed(1)} a/s)`);
        fs.writeFileSync(path.join(OUT, 'author.papers.json'), JSON.stringify(stagedRecs));
        fs.writeFileSync(path.join(OUT, 'author.abstracts.json'), JSON.stringify(stagedAbs));
      }
      await sleep(DELAY);
    }
    fs.writeFileSync(path.join(OUT, 'author.papers.json'), JSON.stringify(stagedRecs));
    fs.writeFileSync(path.join(OUT, 'author.abstracts.json'), JSON.stringify(stagedAbs));
    console.log(`[refresh] author done: resolved ${name2id.size} authors · ${added} new papers staged (${withAbs} w/ abstract) · total ${Object.keys(stagedRecs).length}`);
    return;
  }

  // ── Journal-by-DOI mode: resolve each corpus journal to its EXACT OpenAlex
  // source via a DOI we already hold (reliable — no fuzzy name matching), then
  // fetch that source's recent works. Stages into the same journal.* files.
  if (MODE === 'journal-doi') {
    Object.assign(stagedRecs, loadStaged('journal.papers.json'));
    Object.assign(stagedAbs, loadStaged('journal.abstracts.json'));
    for (const k of Object.keys(stagedRecs)) existing.add(k.toLowerCase());

    const jDoi = new Map(); // journal → one representative bare DOI
    for (const p of readJson('papers.index.json')) {
      const j = (p.journal || '').trim();
      const d = (p.doi || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
      if (j && d && !jDoi.has(j)) jDoi.set(j, d);
    }
    const entries = [...jDoi.entries()];
    console.log(`[refresh] ${entries.length} journals with a representative DOI — resolving sources…`);

    // Batch-resolve DOIs → source ids (40 per request).
    const jSource = new Map(); // journal → { id, name }
    for (let i = 0; i < entries.length; i += 40) {
      const chunk = entries.slice(i, i + 40);
      const filter = 'doi:' + chunk.map(([, d]) => encodeURIComponent(d)).join('|');
      try {
        const data = await oa(`https://api.openalex.org/works?filter=${filter}&select=doi,primary_location&per-page=50`);
        const byDoi = new Map();
        for (const w of data.results || []) {
          const wd = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
          const s = w.primary_location?.source;
          if (wd && s?.id) byDoi.set(wd, s);
        }
        for (const [j, d] of chunk) { const s = byDoi.get(d.toLowerCase()); if (s) jSource.set(j, { id: String(s.id).split('/').pop(), name: s.display_name }); }
      } catch { /* skip chunk */ }
      if (i % 400 === 0) console.log(`  resolving ${i}/${entries.length}… (${jSource.size} resolved)`);
      await sleep(DELAY);
    }
    console.log(`[refresh] resolved ${jSource.size}/${entries.length} journals to OpenAlex sources`);

    let processed = 0, added = 0, withAbs = 0;
    const t0 = Date.now();
    for (const [, src] of jSource) {
      if (processed >= LIMIT) break;
      processed++;
      try {
        const data = await oa(`https://api.openalex.org/works?filter=from_publication_date:${SINCE},primary_location.source.id:${src.id}&sort=publication_date:desc&per-page=${PER}`);
        for (const w of data.results || []) {
          const built = workToRecord(w, null);
          if (!built) continue;
          const doi = built.rec.doi;
          if (existing.has(doi)) continue;
          existing.add(doi);
          if (!built.rec.journal) built.rec.journal = src.name;
          stagedRecs[doi] = built.rec;
          if (built.abstract) { stagedAbs[doi] = built.abstract; withAbs++; }
          added++;
        }
      } catch { /* skip */ }
      if (processed % 20 === 0) {
        console.log(`  [${processed}/${jSource.size}] +${added} new (${(processed / ((Date.now() - t0) / 1000)).toFixed(1)} j/s)`);
        fs.writeFileSync(path.join(OUT, 'journal.papers.json'), JSON.stringify(stagedRecs));
        fs.writeFileSync(path.join(OUT, 'journal.abstracts.json'), JSON.stringify(stagedAbs));
      }
      await sleep(DELAY);
    }
    fs.writeFileSync(path.join(OUT, 'journal.papers.json'), JSON.stringify(stagedRecs));
    fs.writeFileSync(path.join(OUT, 'journal.abstracts.json'), JSON.stringify(stagedAbs));
    console.log(`[refresh] journal-doi done: resolved ${jSource.size} sources · ${added} new papers staged (${withAbs} w/ abstract) · total ${Object.keys(stagedRecs).length}`);
    return;
  }

  // ── Journal mode: recent works from each journal already in the corpus ──────
  if (MODE === 'journal') {
    const counts = new Map();
    for (const p of readJson('papers.index.json')) { const j = (p.journal || '').trim(); if (j) counts.set(j, (counts.get(j) || 0) + 1); }
    const journals = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n); // most-represented first
    console.log(`[refresh] ${journals.length} distinct journals in corpus`);
    const tok = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
    let processed = 0, added = 0, resolved = 0, withAbs = 0;
    const t0 = Date.now();
    for (const name of journals) {
      if (processed >= LIMIT) break;
      processed++;
      // Resolve the journal name → an OpenAlex source, verifying token overlap so
      // we don't fetch a wrong same-ish-named venue.
      let src = null;
      try { const sd = await oa(`https://api.openalex.org/sources?search=${encodeURIComponent(name)}&per-page=1`); src = sd.results?.[0]; } catch { /* skip */ }
      if (!src) { await sleep(DELAY); continue; }
      const a = tok(name), b = tok(src.display_name); let ov = 0; for (const w of a) if (b.has(w)) ov++;
      if (a.size && ov / a.size < 0.5) { await sleep(DELAY); continue; } // wrong journal — skip
      resolved++;
      const sid = String(src.id).split('/').pop();
      let newForJ = 0;
      try {
        const data = await oa(`https://api.openalex.org/works?filter=from_publication_date:${SINCE},primary_location.source.id:${sid}&sort=publication_date:desc&per-page=${PER}`);
        for (const w of data.results || []) {
          const built = workToRecord(w, null);
          if (!built) continue;
          const doi = built.rec.doi;
          if (existing.has(doi)) continue;
          existing.add(doi);
          if (!built.rec.journal) built.rec.journal = src.display_name;
          stagedRecs[doi] = built.rec;
          if (built.abstract) { stagedAbs[doi] = built.abstract; withAbs++; }
          added++; newForJ++;
        }
      } catch { /* skip */ }
      if (processed % 10 === 0) {
        console.log(`  [${processed}/${journals.length}] resolved ${resolved} · +${added} new (${(processed / ((Date.now() - t0) / 1000)).toFixed(1)} j/s)`);
        fs.writeFileSync(path.join(OUT, 'journal.papers.json'), JSON.stringify(stagedRecs));
        fs.writeFileSync(path.join(OUT, 'journal.abstracts.json'), JSON.stringify(stagedAbs));
      }
      await sleep(DELAY);
    }
    fs.writeFileSync(path.join(OUT, 'journal.papers.json'), JSON.stringify(stagedRecs));
    fs.writeFileSync(path.join(OUT, 'journal.abstracts.json'), JSON.stringify(stagedAbs));
    console.log(`[refresh] journal done: ${processed} journals · ${resolved} resolved · ${added} new papers staged (${withAbs} w/ abstract) · total ${Object.keys(stagedRecs).length}`);
    return;
  }

  if (MODE !== 'construct') { console.log(`[refresh] unknown mode '${MODE}'`); return; }

  const constructs = readJson('constructs.json');
  let processed = 0, added = 0, withAbs = 0;
  const t0 = Date.now();

  for (const c of constructs) {
    if (processed >= LIMIT) break;
    processed++;
    // Precision gate vocabulary: all identifier terms ≥5 chars. A kept result
    // must verbatim mention one of these, so the machine construct tag is
    // grounded — not a loose relevance hit.
    const ids = (c.identifiers || []).map((s) => String(s).toLowerCase()).filter((s) => s.length >= 5);
    // Recall: real papers rarely use Syed's composite category NAME, so search
    // the name PLUS its most specific 2–4-word identifier phrases and union the
    // hits (capped to bound query volume).
    const phrases = [...new Set((c.identifiers || []).map((s) => String(s).trim())
      .filter((s) => { const w = s.split(/\s+/).length; return w >= 2 && w <= 4 && s.length >= 6; }))];
    const queries = [...new Set([c.name, ...phrases])].slice(0, 6);

    let newForC = 0, dropped = 0;
    for (const query of queries) {
      const url = `https://api.openalex.org/works?filter=from_publication_date:${SINCE},title_and_abstract.search:${encodeURIComponent(query)}&sort=publication_date:desc&per-page=${PER}`;
      let data;
      try { data = await oa(url); } catch { await sleep(DELAY); continue; }
      for (const w of data.results || []) {
        const built = workToRecord(w, c.code);
        if (!built) continue;
        const doi = built.rec.doi;
        if (existing.has(doi)) continue;
        const hay = (built.rec.title + ' ' + built.abstract).toLowerCase();
        if (ids.length && !ids.some((t) => hay.includes(t))) { dropped++; continue; } // off-construct
        if (!built.rec.journal) { dropped++; continue; }                                // bare preprint/dataset
        existing.add(doi);
        stagedRecs[doi] = built.rec;
        if (built.abstract) { stagedAbs[doi] = built.abstract; withAbs++; }
        added++; newForC++;
      }
      await sleep(DELAY);
    }
    console.log(`  [${processed}/${constructs.length}] ${c.code} ${c.name} → ${queries.length}q · +${newForC} new · -${dropped} filtered (total +${added}) · ${(processed / ((Date.now() - t0) / 1000)).toFixed(1)} c/s`);

    if (processed % 10 === 0) {
      fs.writeFileSync(path.join(OUT, `${MODE}.papers.json`), JSON.stringify(stagedRecs));
      fs.writeFileSync(path.join(OUT, `${MODE}.abstracts.json`), JSON.stringify(stagedAbs));
    }
  }

  fs.writeFileSync(path.join(OUT, `${MODE}.papers.json`), JSON.stringify(stagedRecs));
  fs.writeFileSync(path.join(OUT, `${MODE}.abstracts.json`), JSON.stringify(stagedAbs));
  console.log(`[refresh] done: ${processed} constructs · ${added} new papers staged (${withAbs} with abstracts) · total staged now ${Object.keys(stagedRecs).length}`);
  console.log(`[refresh] staged → ${path.join(OUT, MODE + '.papers.json')} (machine-tagged addedVia:'openalex-${MODE}', NOT merged into the hand-coded index)`);
}

main().catch((e) => { console.error('[refresh] fatal:', e); process.exit(1); });
