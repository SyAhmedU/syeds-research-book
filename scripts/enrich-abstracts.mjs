// Enrich missing abstracts for Syed's Research Book from REAL DOI records only.
// Crossref (polite pool) -> OpenAlex fallback. Resumable via data/_abstract-cache.json.
// NO FABRICATION: abstracts come verbatim from the paper's own DOI record; never generated.
//
//   node scripts/enrich-abstracts.mjs [--limit N]   # fetch + cache (network)
//   node scripts/enrich-abstracts.mjs --merge        # write cached abstracts into papers.json
//
// After --merge, run scripts/split-data.ps1 to regenerate the index + abstracts files.
import fs from 'fs';
import path from 'path';

const DATA   = path.join(process.env.USERPROFILE, 'syeds-research-book', 'data');
const PAPERS = path.join(DATA, 'papers.json');
const CACHE  = path.join(DATA, '_abstract-cache.json');
const MAILTO = 'syedfaceprep@gmail.com';
const UA     = `SyedsResearchBook/1.0 (mailto:${MAILTO})`;
const CONCURRENCY = 5;

const args  = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? +args[args.indexOf('--limit') + 1] : Infinity;
const MERGE = args.includes('--merge');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// JATS / HTML -> plain text; reject too-short or placeholder strings
function clean(s){
  if(!s) return null;
  let t = String(s).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^abstract[:\s.\-]*/i, '').trim();
  if(t.length < 60) return null;
  if(/^abstract not found$/i.test(t)) return null;
  return t;
}
function fromInverted(idx){
  if(!idx) return null;
  const words = [];
  for(const [w, ps] of Object.entries(idx)) for(const p of ps) words[p] = w;
  return clean(words.filter(Boolean).join(' '));
}

async function crossref(doi){
  try{
    const r = await fetch(`https://api.crossref.org/works/${doi}?mailto=${MAILTO}`, { headers:{ 'User-Agent': UA } });
    if(!r.ok) return null;
    const j = await r.json();
    return clean(j?.message?.abstract);
  }catch{ return null; }
}
async function openalex(doi){
  try{
    const r = await fetch(`https://api.openalex.org/works/https://doi.org/${doi}?mailto=${MAILTO}`, { headers:{ 'User-Agent': UA } });
    if(!r.ok) return null;
    const j = await r.json();
    return fromInverted(j?.abstract_inverted_index);
  }catch{ return null; }
}

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); // strip UTF-8 BOM
function loadCache(){ try{ return readJson(CACHE); }catch{ return {}; } }
function saveCache(c){ fs.writeFileSync(CACHE, JSON.stringify(c)); }

const papers = readJson(PAPERS);

if(MERGE){
  const cache = loadCache();
  let filled = 0, bySrc = { crossref:0, openalex:0 };
  for(const p of papers){
    if(p.abstract || !p.doi) continue;
    const hit = cache[p.doi];
    if(hit && hit.a){ p.abstract = hit.a; p.absSrc = hit.s; filled++; bySrc[hit.s] = (bySrc[hit.s]||0)+1; }
  }
  // mark in-sheet abstracts so provenance is explicit
  for(const p of papers){ if(p.abstract && !p.absSrc) p.absSrc = 'sheet'; }
  fs.writeFileSync(PAPERS, '﻿' + JSON.stringify(papers)); // leading BOM to match the converter; run split-data.ps1 next
  console.log(`MERGE: filled ${filled} abstracts (crossref ${bySrc.crossref}, openalex ${bySrc.openalex}). papers.json rewritten.`);
  process.exit(0);
}

// ---- fetch mode ----
const cache = loadCache();
const todo = papers.filter(p => !p.abstract && p.doi && !(p.doi in cache)).slice(0, LIMIT);
console.log(`missing+doi to fetch: ${todo.length} (cache already has ${Object.keys(cache).length})`);

let done = 0, hitC = 0, hitO = 0, miss = 0, sinceSave = 0;
async function worker(queue){
  while(queue.length){
    const p = queue.shift();
    let a = await openalex(p.doi); let s = a ? 'openalex' : null;   // OpenAlex is the richer source for this corpus
    if(!a){ a = await crossref(p.doi); s = a ? 'crossref' : null; }
    cache[p.doi] = a ? { a, s } : { n: 1 };
    if(a){ s === 'crossref' ? hitC++ : hitO++; } else miss++;
    done++; sinceSave++;
    if(sinceSave >= 100){ saveCache(cache); sinceSave = 0; console.log(`  ${done}/${todo.length}  crossref:${hitC} openalex:${hitO} miss:${miss}`); }
    await sleep(80);
  }
}
const q = todo.slice();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(q)));
saveCache(cache);
console.log(`DONE fetch: ${done} processed | crossref ${hitC} | openalex ${hitO} | none ${miss} | recovered ${hitC+hitO}/${todo.length}`);
