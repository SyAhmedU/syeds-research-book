// build-construct-lexicon.mjs — canonical CONSTRUCT lexicon (NO AI, No-fab).
//
// A construct = a latent, theoretical concept that gets MEASURED
// (job satisfaction, work engagement, abusive supervision). NOT methods
// (factor analysis), NOT populations (nurses), NOT geographies (China),
// NOT generic nouns (performance), NOT meta-terms (antecedents).
//
// Spine = MERGE of two verified, hand-curated sources for MAX coverage:
//   • ScaleScope — 309 validated construct names (each = what a real scale measures)
//   • Syed's Book — 167 hand-coded OB constructs (minus the ~18 non-constructs),
//     labels cleaned to atomic construct names; ALL identifiers become match
//     synonyms (this is the corpus's own vocabulary → high recall).
// Book↔ScaleScope duplicates are merged (ScaleScope's clean label wins).
//
// Output: data/construct-lexicon.json  { constructs:[{id,label,synonyms[],sources[],bookCodes[]}], ... }
// Run:    node scripts/build-construct-lexicon.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const SS = join(ROOT, '..', 'scalebase', 'client', 'public', 'data', 'scales.json');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const norm = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- Book codes that are NOT constructs (methods / meta / geo / population / sector / catch-all) ----------
const DROP_CODES = new Set([
  '7RSAM', '8A', '11A', '15WB', '23C', '24C', '27CNCPC', '37DWBD', '39DS', '43D',
  '52R', '59FIPSOO', '70FORC', '80HIC', '84HIM', '98MMR', '99MAMAT', '101MMR',
  '104NAOPC', '110OVC', '111PCI', '114POC', '115EP', '123POPC', '124PCOPC',
  '125QROPC', '134MVR', '138LS', '140SMSESMEMSMEMSME', '150SRSRM', '157TTFOBC', '166WDB', '167WRATI',
]);
// Clean construct label for every KEPT Book construct (merges into ScaleScope when the
// normalized label matches an existing one; else becomes a new clean construct).
const LABEL_OVERRIDE = {
  '1ASL': 'Abusive Supervision', '2ACD': 'Career Adaptability', '3ACOB': 'Organizational Commitment',
  '4AARIWS': 'Aging at Work', '5AOWC': 'Organizational Agility', '6AIAW': 'Artificial Intelligence at Work',
  '9TCA': 'Anxiety', '10AVF': 'Attachment', '12AIVM': 'Authenticity', '13AVC': 'Autonomy',
  '14WLBERB': 'Work-Life Balance', '16PMLD': 'Personality', '17BOC': 'Workplace Bullying',
  '18BIVD': 'Burnout', '19COTC': 'Organizational Capabilities', '20FCOPC': 'Psychological Capital',
  '21PCC': 'Protean Career', '22JC': 'Job Characteristics', '25CBOSC': 'Organizational Citizenship Behavior',
  '26OCIVD': 'Organizational Climate', '28CEPC': 'Competitive Climate', '29CIVF': 'Conflict',
  '30PCOC': 'Psychological Contract', '31CPOC': 'Locus of Control', '32CID': 'Coworker Relationships',
  '33CBJC': 'Job Crafting', '34COC': 'Creativity', '35CSRCSR': 'Corporate Social Responsibility',
  '36OCM': 'Organizational Culture', '38DPT': 'Dark Triad Personality', '40DMPC': 'Decision-Making',
  '41JDR': 'Job Demands and Resources', '42JD': 'Job Design', '44DW': 'Workplace Deviance',
  '45DWS': 'Workplace Discrimination', '46DOSC': 'Diversity', '47DC': 'Dynamic Capabilities',
  '48WD': 'Diversity', '49EOSC': 'Job Embeddedness', '50EEIOSC': 'Emotional Intelligence',
  '51EID': 'Employability', '53PE': 'Psychological Empowerment', '54EOEC': 'Psychological Empowerment',
  '55EVC': 'Work Engagement', '56EROSC': 'Social Exchange', '57EWOC': 'Emotional Exhaustion',
  '58EIIPPC': 'Work Experience', '60WFEB': 'Work-Family Enrichment', '61WFI': 'Work-Family Conflict',
  '62FVC': 'Fatigue', '63FID': 'Fear', '64FID': 'Feedback', '65FMOC': 'Person-Environment Fit',
  '66FWOC': 'Workplace Flexibility', '67FIAPOC': 'Flow at Work', '68FLD': 'Followership',
  '69FOC': 'Forgiveness', '71GIIVC': 'Gender', '72GDI': 'Generational Differences', '73GEGW': 'Gig Work',
  '74GOII': 'Goal Orientation', '75GIEVC': 'Gratitude', '76GHRMHRMSP': 'Green Human Resource Management',
  '77GWOSC': 'Team Processes', '78HIIPOC': 'Happiness', '79MHPOC': 'Mental Health',
  '81HPHCWS': 'High-Performance Work Systems', '82WHIM': 'Work-Home Interface', '83WHI': 'Work-Home Interface',
  '85HRMHRMHRDHRD': 'Human Resource Management', '86IIVC': 'Identity', '87IVC': 'Workplace Incivility',
  '88IIP': 'Inclusion', '89IPBOC': 'Job Performance', '90IIDOC': 'Innovation', '91JLMI': 'Job Insecurity',
  '92IRDOC': 'Interpersonal Relationships at Work', '93JIOSC': 'Organizational Justice',
  '94KMKW': 'Knowledge Management', '95OL': 'Organizational Learning', '96WLI': 'Work-Life Integration',
  '97LMELMXT': 'Leader-Member Exchange', '100MM': 'Mindfulness', '102MMCOC': 'Moral Behavior',
  '103MMC': 'Work Motivation', '105NIA': 'Newcomer Socialization', '106OCD': 'Career Development',
  '107OPWD': 'Older Workers', '108OOPC': 'Work Orientation', '109OVC': 'Workplace Ostracism',
  '112PCOPC': 'Work Passion', '113PCD': 'Compensation', '116JP': 'Job Performance',
  '117POF': 'Person-Organization Fit', '118PID': 'Personality', '119OPPB': 'Organizational Politics',
  '120PID': 'Presenteeism', '121POPC': 'Work Pressure', '122POPC': 'Proactive Personality',
  '126ROPC': 'Recovery from Work', '127ROPC': 'Team Reflexivity', '128RWRB': 'Remote Work',
  '129ROPC': 'Resilience', '130SRLM': 'Responsible Leadership', '131RRC': 'Retirement',
  '132WRP': 'Work Role Performance', '133SOC': 'Safety Climate', '135S': 'Self-Efficacy',
  '136SLPS': 'Servant Leadership', '137SOC': 'Organizational Silence', '139SIIHW': 'Sleep',
  '141SIOSC': 'Social Identity', '142SIBSP': 'Social Influence', '143SOPC': 'Workplace Spirituality',
  '144SSVC': 'Work Stress', '145SEO': 'Student Outcomes', '146SOPC': 'Leadership Styles',
  '147SPW': 'Subjective Wellbeing', '148SRDOC': 'Supervisor Support', '149SOPC': 'Sustainability',
  '151TMOC': 'Talent Management', '152TMPOC': 'Task Performance', '153TDPOC': 'Team Performance',
  '154TRWM': 'Telework', '155TAOPC': 'Temporal Focus', '156TMIEOC': 'Time Management',
  '158TTTRCOPC': 'Personality Traits', '159TTCLOC': 'Transformational Leadership', '160TDOIC': 'Trust',
  '161TROC': 'Turnover Intention', '162VWCOC': 'Virtual Teams', '163VBOC': 'Voice Behavior',
  '164VBOEC': 'Pro-Environmental Behavior', '165WOPC': 'Well-Being',
};
function cleanBookLabel(code, name) { return LABEL_OVERRIDE[code] || name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim(); }

// ---------- validity guards ----------
const AMBIGUOUS_BARE = new Set(['flow', 'voice', 'fit', 'power', 'agency', 'control', 'trust', 'identity', 'conflict', 'stress', 'silence', 'support', 'performance', 'attitude', 'capital', 'climate', 'culture']);
const GENERIC = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'and', 'or', 'work', 'job', 'role', 'self', 'social', 'context', 'behavior', 'behaviour', 'effect', 'impact', 'study', 'model', 'general', 'positive', 'negative', 'state', 'trait', 'level', 'process', 'factor', 'employee', 'organizational', 'organisational', 'abuse', 'abusive', 'dark', 'side']);
const okSyn = (s) => {
  const n = norm(s);
  return n.length >= 4 && !AMBIGUOUS_BARE.has(n) && !(n.split(' ').length === 1 && GENERIC.has(n));
};

// ---------- morphological variants (conservative) ----------
function variants(term, opts = {}) {
  const t = norm(term);
  const out = new Set([t]);
  const add = (x) => x && x.length >= 4 && out.add(x);
  const spellPairs = (s) => [
    s.replace(/behaviour/g, 'behavior').replace(/organisation/g, 'organization').replace(/isation\b/g, 'ization').replace(/ise\b/g, 'ize'),
    s.replace(/behavior/g, 'behaviour').replace(/organization/g, 'organisation').replace(/ization\b/g, 'isation').replace(/ize\b/g, 'ise'),
  ];
  spellPairs(t).forEach(add);
  if (t.includes('-')) [...out].forEach((v) => add(v.replace(/-/g, ' ')));
  if (opts.plural) {
    [...out].forEach((v) => {
      const w = v.split(' '); const last = w[w.length - 1];
      if (/s$/.test(last)) return;
      if (/[bcdfghjklmnpqrstvwxz]y$/.test(last)) add([...w.slice(0, -1), last.slice(0, -1) + 'ies'].join(' '));
      else if (/(x|ch|sh|ss)$/.test(last)) add([...w.slice(0, -1), last + 'es'].join(' '));
      else add([...w.slice(0, -1), last + 's'].join(' '));
    });
  }
  return [...out].filter(okSyn);
}

// ---------- ScaleScope spine ----------
if (!existsSync(SS)) { console.error('ScaleScope snapshot not found:', SS); process.exit(1); }
const scalesDoc = readJson(SS);
const scales = Array.isArray(scalesDoc) ? scalesDoc : scalesDoc.scales || [];
const entries = [];                       // canonical construct entries
const byNorm = new Map();                 // norm(label) -> entry
const synIndex = new Map();               // synonym -> entry (first writer wins)
function ensure(label, source) {
  const k = norm(label);
  if (byNorm.has(k)) return byNorm.get(k);
  const e = { id: slug(label), label, synonyms: new Set(), sources: new Set([source]), bookCodes: new Set() };
  entries.push(e); byNorm.set(k, e); return e;
}
function addSyn(e, syn, plural) {
  for (const v of variants(syn, { plural })) {
    e.synonyms.add(v);
    if (!synIndex.has(v)) synIndex.set(v, e);
  }
}
for (const s of scales) {
  const name = (s.construct || '').trim();
  if (!name || AMBIGUOUS_BARE.has(norm(name))) continue;
  const e = ensure(name, 'scalescope');
  addSyn(e, name, true);
}
const ssCount = entries.length;
console.log(`[lexicon] ScaleScope spine: ${ssCount} constructs`);

// ---------- merge in Book constructs ----------
const bookDoc = readJson(join(DATA, 'constructs.json'));
const book = Array.isArray(bookDoc) ? bookDoc : bookDoc.constructs;

let merged = 0, added = 0, dropped = 0;
for (const c of book) {
  if (DROP_CODES.has(c.code)) { dropped++; continue; }
  const label = cleanBookLabel(c.code, c.name);
  const exists = byNorm.has(norm(label));
  const target = ensure(label, exists ? 'book' : 'book');   // ensure() reuses on exact norm match
  if (exists) merged++; else added++;
  target.sources.add('book');
  target.bookCodes.add(c.code);
  addSyn(target, label, true);
  for (const id of (c.identifiers || [])) if (okSyn(id)) addSyn(target, id, false);
}
console.log(`[lexicon] Book: ${merged} merged into ScaleScope, ${added} added new, ${dropped} dropped (non-constructs)`);

// ---------- emit ----------
const constructs = entries
  .map((e) => ({ id: e.id, label: e.label, synonyms: [...e.synonyms].sort((a, b) => b.length - a.length), sources: [...e.sources], bookCodes: [...e.bookCodes] }))
  .sort((a, b) => a.label.localeCompare(b.label));

writeFileSync(join(DATA, 'construct-lexicon.json'), JSON.stringify({
  version: 2,
  generatedAt: new Date().toISOString(),
  definition: 'A construct = a latent theoretical concept that is measured. Methods, populations, geographies, meta-terms and generic nouns are excluded.',
  spine: 'ScaleScope validated constructs + Syed Book OB constructs (non-constructs dropped, labels cleaned), merged. Book identifiers = match synonyms.',
  count: constructs.length,
  fromScaleScope: ssCount,
  fromBookAdded: added,
  bookMerged: merged,
  synonymCount: constructs.reduce((n, c) => n + c.synonyms.length, 0),
  constructs,
}, null, 1));

console.log(`\n[lexicon] wrote data/construct-lexicon.json — ${constructs.length} constructs, ${constructs.reduce((n, c) => n + c.synonyms.length, 0)} synonyms`);
console.log('\nNew constructs added from your Book (label — bookCodes):');
for (const c of constructs.filter((c) => c.sources.includes('book') && !c.sources.includes('scalescope')).slice(0, 60)) {
  console.log(`  ${c.label}  [${c.bookCodes.join(',')}]`);
}
