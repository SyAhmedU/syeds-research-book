// Build data/corpus-snapshot.json — a compact, CORS-served grounding file for the suite
// (same pattern as TheoryScope's theories.json / ScaleScope's scales.json).
// Per construct: name + keyword vocab + the top real papers (by citations) with DOIs.
// Downstream (ResearchFlow's literature stage) token-ranks constructs vs the query and
// feeds the matched REAL papers into the prompt so the AI cites verified work, not inventions.
import fs from 'fs';
import path from 'path';

const DATA = path.join(process.env.USERPROFILE, 'syeds-research-book', 'data');
const readJson = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8').replace(/^﻿/, ''));

const papers = readJson('papers.json');
const constructs = readJson('constructs.json');
const TOP = 6, KW = 8;

const byCode = {};
for (const c of constructs) byCode[c.code] = [];
for (const p of papers) for (const code of (p.constructCodes || [])) if (byCode[code]) byCode[code].push(p);

const firstAuthor = a => (!a || !a.length) ? '' : (a.length > 1 ? a[0] + ' et al.' : a[0]);

const out = constructs.map(c => {
  const top = byCode[c.code].slice()
    .sort((x, y) => (y.citations || 0) - (x.citations || 0)
                 || (y.scopusPercentile || -1) - (x.scopusPercentile || -1)
                 || (y.year || 0) - (x.year || 0))
    .slice(0, TOP)
    .map(p => ({ t: p.title, a: firstAuthor(p.authors), y: p.year, doi: p.doi, j: p.journal, c: p.citations || 0 }));
  return { code: c.code, name: c.name, keywords: (c.identifiers || []).slice(0, KW), n: byCode[c.code].length, top };
});

const snap = {
  generatedAt: new Date().toISOString(),
  source: "Syed's Research Book",
  url: "https://syahmedu.github.io/syeds-research-book/",
  totalPapers: papers.length,
  constructs: out,
};
const fp = path.join(DATA, 'corpus-snapshot.json');
fs.writeFileSync(fp, JSON.stringify(snap));
console.log(`corpus-snapshot.json: ${out.length} constructs, ${(fs.statSync(fp).size / 1024).toFixed(0)} KB`);
