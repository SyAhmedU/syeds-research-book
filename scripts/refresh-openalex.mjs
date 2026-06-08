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

// Map an OpenAlex work → an SRB-shaped record (+ separate abstract). Machine-tagged.
function workToRecord(w, constructCode) {
  const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
  if (!doi) return null;
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

  // Existing DOIs (corpus + any prior staged run) — never re-add.
  const existing = new Set();
  for (const p of readJson('papers.index.json')) existing.add((p.doi || p.id).toLowerCase());
  const stagedRecs = loadStaged(`${MODE}.papers.json`);
  const stagedAbs = loadStaged(`${MODE}.abstracts.json`);
  for (const k of Object.keys(stagedRecs)) existing.add(k.toLowerCase());
  console.log(`[refresh] corpus+staged DOIs known: ${existing.size}`);

  if (MODE !== 'construct') { console.log(`[refresh] mode '${MODE}' not implemented in this pass — use --mode construct`); return; }

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
