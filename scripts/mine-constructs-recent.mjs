// mine-constructs-recent.mjs — deterministic construct extraction (NO AI).
//
// Pulls construct noun phrases VERBATIM from the recent tier
// (recent.index.json titles + recent.abstracts/*.json) using fixed linguistic
// frames — "the mediating role of X", "effect of X on Y", "relationship
// between X and Y", "antecedents of X", … A phrase is only ever text that
// literally appears inside one of these frames in a real DOI-backed paper;
// nothing is paraphrased, merged or invented. Frequency-gated (≥MIN_PAPERS),
// stop-listed, and cross-referenced against the hand-coded 167-construct
// identifier vocabulary (matches carry the hand code; the hand-coded moat in
// constructs.json is NEVER touched).
//
// Output: data/constructs.recent.json  { meta…, constructs:[{t,n,byYear,dois,code?}] }
// Run:    node scripts/mine-constructs-recent.mjs

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const MIN_PAPERS = 10;
const MAX_DOIS = 6;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));

// ---------- load ----------
console.log('[constructs] loading recent tier…');
const index = readJson(join(DATA, 'recent.index.json'));
const papers = Array.isArray(index) ? index : index.papers;
const abstracts = new Map();
for (const f of readdirSync(join(DATA, 'recent.abstracts')).filter((f) => f.endsWith('.json'))) {
  const shard = readJson(join(DATA, 'recent.abstracts', f));
  for (const [doi, text] of Object.entries(shard)) {
    if (typeof text === 'string' && text.length > 40) abstracts.set(doi, text);
  }
}
console.log(`[constructs] ${papers.length} papers, ${abstracts.size} abstracts`);

const hand = readJson(join(DATA, 'constructs.json'));
const handArr = Array.isArray(hand) ? hand : hand.constructs;
const identToCode = new Map(); // normalized identifier → construct code
for (const c of handArr) {
  for (const id of c.identifiers || []) {
    const k = id.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!identToCode.has(k)) identToCode.set(k, c.code);
  }
  identToCode.set(c.name.toLowerCase(), c.code);
}
console.log(`[constructs] hand vocabulary: ${handArr.length} constructs, ${identToCode.size} identifiers`);

// ---------- extraction frames ----------
// Each frame captures ONE noun phrase slot. The phrase is taken verbatim
// (lowercased, articles trimmed at the edge only).
const NP = String.raw`([A-Za-z][A-Za-z''’-]*(?:[ -][A-Za-z][A-Za-z''’-]*){0,4})`;
const FRAMES = [
  new RegExp(String.raw`\b(?:mediating|moderating|mediated|moderated|buffering|intervening)\s+(?:role|roles|effect|effects|influence)s?\s+of\s+${NP}`, 'gi'),
  new RegExp(String.raw`\b(?:effect|effects|impact|impacts|influence|influences)\s+of\s+${NP}\s+on\b`, 'gi'),
  new RegExp(String.raw`\bon\s+${NP}\s*[:,.]`, 'gi'),
  new RegExp(String.raw`\b(?:relationship|relationships|association|associations|link|links|linkage|nexus|interplay)\s+between\s+${NP}\s+and\b`, 'gi'),
  new RegExp(String.raw`\bbetween\s+[A-Za-z][A-Za-z''’ -]{2,60}?\s+and\s+${NP}\b`, 'gi'),
  new RegExp(String.raw`\b(?:antecedents|determinants|predictors|drivers|consequences|outcomes|dimensions)\s+of\s+${NP}`, 'gi'),
  new RegExp(String.raw`\b${NP}\s+(?:positively|negatively|significantly|directly|indirectly)\s+(?:predicts|predicted|affects|affected|influences|influenced|mediates|moderates|relates)`, 'gi'),
  new RegExp(String.raw`\b${NP}\s+as\s+a\s+(?:mediator|moderator|predictor|buffer)`, 'gi'),
  new RegExp(String.raw`\brole\s+of\s+${NP}\s+in\b`, 'gi'),
];

// edge-trim only — never rewrite the middle of a phrase
const LEAD_TRIM = /^(?:the|a|an|their|its|his|her|our|such|both|either|perceived\s+the|these|those)\s+/i;
const TAIL_TRIM = /\s+(?:of|in|on|at|for|with|among|amongst|towards?|between|and|or)$/i;

// whole-phrase junk (not constructs): study furniture, methods, geographies, populations
const STOP_PHRASES = new Set([
  'this study', 'the study', 'the present study', 'present study', 'this research', 'this paper', 'this article',
  'the research', 'study', 'research', 'paper', 'article', 'literature', 'the literature', 'findings', 'results',
  'the findings', 'the results', 'data', 'the data', 'analysis', 'the analysis', 'the model', 'model', 'models',
  'the relationship', 'relationship', 'relationships', 'the role', 'role', 'sample', 'the sample', 'participants',
  'respondents', 'the authors', 'authors', 'evidence', 'the effect', 'effect', 'effects', 'the impact', 'impact',
  'the influence', 'influence', 'covid-19', 'covid-19 pandemic', 'the covid-19 pandemic', 'pandemic', 'the pandemic',
  'employees', 'employee', 'workers', 'organizations', 'organisations', 'firms', 'companies', 'managers', 'teachers',
  'nurses', 'students', 'leaders', 'women', 'men', 'china', 'india', 'pakistan', 'indonesia', 'nigeria', 'vietnam',
  'the workplace', 'workplace', 'the organization', 'the organisation', 'work', 'the work', 'the field', 'practice',
  'theory', 'the theory', 'the framework', 'framework', 'the mediating role', 'mediating role', 'moderating role',
  'structural equation modeling', 'structural equation modelling', 'regression analysis', 'factor analysis',
  'confirmatory factor analysis', 'exploratory factor analysis', 'a survey', 'the survey', 'survey', 'questionnaire',
  'the questionnaire', 'interviews', 'a case study', 'case study', 'the case', 'future research', 'further research',
  'the context', 'context', 'the other hand', 'other hand', 'one hand', 'the one hand', 'this end', 'the basis',
  'the moderating role', 'the mediating effect', 'the moderating effect', 'the extent', 'terms', 'addition',
  'the relationships', 'these relationships', 'this relationship', 'turn', 'order', 'contrast', 'particular',
  'a result', 'the results show', 'the impact of', 'line', 'light', 'response', 'sum', 'fact', 'general', 'total',
  'average', 'the number', 'the level', 'levels', 'the levels', 'the degree', 'the importance', 'importance',
  'the development', 'development', 'the implementation', 'implementation', 'the adoption', 'use', 'the use',
]);
// any-word junk — phrases containing these are study furniture, not constructs
const STOP_WORDS = /\b(study|studies|paper|article|author|authors|hypothes\w*|questionnaire|respondent\w*|participant\w*|dataset|databases?|literature|bibliometric|prisma|google|scopus|web of science|chapter|journal|systematic review|meta-analys\w*|this|these|those|we|our|their|which|that|results?|findings?|implication\w*|limitation\w*|method\w*|approach|sectional|longitudinal|qualitative|quantitative|empirical|conceptual)\b/i;

function cleanPhrase(raw) {
  let p = raw.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  for (let prev = ''; prev !== p; ) { prev = p; p = p.replace(LEAD_TRIM, '').replace(TAIL_TRIM, ''); }
  if (p.length < 4 || p.length > 60) return null;
  const words = p.split(' ');
  if (words.length > 5) return null;
  if (STOP_PHRASES.has(p)) return null;
  if (STOP_WORDS.test(p)) return null;
  if (!/^[a-z]/.test(p) || /\d/.test(p)) return null;
  if (words.length === 1 && p.length < 5) return null;
  return p;
}

// ---------- scan ----------
console.log('[constructs] scanning…');
const agg = new Map(); // phrase → {n, byYear, dois:[], seen:Set}
let scanned = 0;
const t0 = Date.now();
for (const p of papers) {
  const doi = p.doi || p.id;
  const text = `${p.title || ''}. ${abstracts.get(doi) || ''}`;
  if (text.length < 25) continue;
  const found = new Set();
  for (const re of FRAMES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const ph = cleanPhrase(m[1]);
      if (ph) found.add(ph);
    }
  }
  for (const ph of found) {
    let rec = agg.get(ph);
    if (!rec) agg.set(ph, (rec = { n: 0, byYear: {}, dois: [] }));
    rec.n++;
    if (p.year) rec.byYear[p.year] = (rec.byYear[p.year] || 0) + 1;
    if (rec.dois.length < MAX_DOIS) rec.dois.push(doi);
  }
  if (++scanned % 20000 === 0) console.log(`[constructs] ${scanned}/${papers.length} (${((Date.now() - t0) / 1000) | 0}s)`);
}
console.log(`[constructs] raw phrases: ${agg.size}`);

// ---------- gate + crosswalk ----------
const out = [];
for (const [t, rec] of agg) {
  if (rec.n < MIN_PAPERS) continue;
  const code = identToCode.get(t);
  out.push({ t, n: rec.n, byYear: rec.byYear, dois: rec.dois, ...(code ? { code } : {}) });
}
out.sort((a, b) => b.n - a.n);
const linked = out.filter((c) => c.code).length;
console.log(`[constructs] kept ${out.length} phrases (≥${MIN_PAPERS} papers) — ${linked} map to hand codes, ${out.length - linked} new`);

writeFileSync(
  join(DATA, 'constructs.recent.json'),
  JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'recent tier (OpenAlex 2024→) titles + abstracts — verbatim frame extraction, no AI',
    papersScanned: papers.length,
    abstracts: abstracts.size,
    minPapers: MIN_PAPERS,
    method: 'fixed linguistic frames (mediating role of X / effect of X on Y / between X and Y / antecedents of X …); phrases verbatim, frequency-gated; machine-extracted — verify',
    handLinked: linked,
    count: out.length,
    constructs: out,
  }),
);
console.log(`[constructs] wrote data/constructs.recent.json`);
console.log('\nTop 30:');
for (const c of out.slice(0, 30)) console.log(`  ${String(c.n).padStart(5)}  ${c.t}${c.code ? '  → ' + c.code : ''}`);
