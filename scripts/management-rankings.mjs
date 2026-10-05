// Ranking values are authentic export evidence; identity attachment is title-based.
// Do not fuzzy-match or present the highest quartile as a management-category rank.
export const normalizeTitle = value => String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export function applyRankings(catalog, evidence) {
  if (!evidence) return catalog;
  const journals = new Map(), records = new Map();
  for (const journal of catalog.sources || catalog.journals) {
    const key = normalizeTitle(journal.name);
    journals.set(key, [...(journals.get(key) || []), journal]);
  }
  for (const rank of evidence.records) {
    const key = normalizeTitle(rank.name);
    records.set(key, [...(records.get(key) || []), rank]);
  }
  const unmatched = [], counts = {};
  let ranked = 0;
  for (const [key, ranks] of records) {
    const candidates = journals.get(key) || [];
    if (ranks.length !== 1 || candidates.length !== 1) {
      for (const rank of ranks) unmatched.push({ name: rank.name, quartile: rank.quartile, evidence: rank.evidence,
        reason: ranks.length !== 1 ? 'duplicate-export-title' : candidates.length ? 'ambiguous-registry-title' : 'no-exact-journal-title' });
      continue;
    }
    const rank = ranks[0], journal = candidates[0];
    Object.assign(journal, { quartile: rank.quartile, quartileScope: rank.quartileScope,
      rankingYear: rank.rankingYear, rankingYearBasis: rank.rankingYearBasis,
      rankingSource: evidence.source, rankingMatch: 'unique-exact-normalized-title',
      rankingTitle: rank.name, rankingEvidence: rank.evidence, citeScore: rank.citeScore,
      highestPercentile: rank.highestPercentile, highestPercentileCategory: rank.highestPercentileCategory,
      highestPercentileRank: rank.rank, highestPercentileCategoryTotal: rank.categoryTotal });
    ranked++;
    counts[rank.quartile] = (counts[rank.quartile] || 0) + 1;
  }
  catalog.ranking = { year: evidence.rankingYear, source: evidence.source, scope: evidence.quartileScope,
    identityMatch: 'unique-exact-normalized-title · verify', evidencePath: 'management-rankings.json',
    unmatched, exportedRecords: evidence.records.length, exportedQuartiles: evidence.coverage.quartiles };
  catalog.coverage.rankedSources = ranked;
  catalog.coverage.rankedSourceQuartiles = counts;
  catalog.coverage.ranked = catalog.journals.filter(j => j.quartile).length;
  catalog.coverage.rankedQuartiles = Object.fromEntries(['Q1', 'Q2', 'Q3', 'Q4'].map(q => [q, catalog.journals.filter(j => j.quartile === q).length]));
  catalog.coverage.rankingUnmatched = unmatched.length;
  catalog.coverage.q1q2ResolvedSources = new Set(catalog.journals.filter(j =>
    ['Q1', 'Q2'].includes(j.quartile) && j.sourceId).map(j => j.sourceId)).size;
  catalog.scope = 'Scopus March 2026 management journal registry (ASJC 14xx), with separately sourced highest-category CiteScore quartiles; title attachment is machine-matched, verify.';
  return catalog;
}
