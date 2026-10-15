// Shared "is this venue a repository / dataset deposit, not a journal?" rule.
// Used by refresh-openalex.mjs (fetch gate), merge-refresh.mjs (merge + purge)
// and purge-repo-venues.mjs (one-shot clean of the committed tier).
// OpenAlex names institutional repositories "<Repo name> (<University>)" or just
// "<University>"; those are deposits (often future-dated, often duplicates of a
// journal version, often not management) — keep the recent tier journal-grade.
const HOSTS = /zenodo|ssrn|research square|preprints\.org|authorea|biorxiv|medrxiv|arxiv|figshare|researchgate|^osf\b|qeios/i;
const DEPOSIT = /repositor(y|ies)|research online|theses online|\btheses\b|dissertations|scholarworks|dataverse|mendeley data|\bdataset\b|data holdings|dataport|researchdata|data archive|data catalogue|biodata catalyst|^hal\b|open collections|digital commons|e-?prints|dspace|\bcentaur\b|\birdb\b|^biron\b|^clok\b|knowledge commons|cyberleninka|philpapers|^definitions$/i;
// Real journals often carry their university in the name (Vestnik, Visnyk,
// Izvestia, "... Journal (University X)") — never drop those on the institution rule.
const JOURNAL_NAME = /journal|jurnal|review|vestnik|visnyk|izvestia|herald|scientific|partnership|statistics|bulletin|annals|proceedings|series|quarterly|transactions|letters|magazine|studies|institute of educational/i;
const INSTITUTION = (v) =>
  /\([^)]*(Universit|School|College|Institute|Polytechnic)[^)]*\)\s*$/i.test(v) ||
  /^(UC [A-Z]\w+( [A-Z]\w+)*|[\w .'-]*Universit(y|é|ät|à|ad)[\w .,'-]*)$/.test(v);

// DOI registrant prefixes that only ever mint repository / preprint / dataset DOIs.
// The venue label can lie (OpenAlex files hundreds of Zenodo/OSF deposits under
// "Open MIND"), the DOI registrant cannot. PsycTESTS = 10.1037/t<digits> only —
// 10.1037/tra… is the real journal Psychological Trauma.
const REPO_DOI = /^10\.(5281|17605|31234|31235|31219|17632|6084|2139|21203|20944|22541|48550|32388|17613|7302|7273|20372|3886|7910|4121|25384|13140|6082|15496)\/|^10\.1037\/t\d/i;
// "Open MIND" in this data is never the MIT Press journal (10.1162/opmi…) — it is a deposit label.
const FAKE_VENUE = (venue, doi) => /^open mind$/i.test(venue.trim()) && !/^10\.1162\/opmi/i.test(doi);

export const isRepoVenue = (venue = '', doi = '') =>
  HOSTS.test(venue) || DEPOSIT.test(venue) || (INSTITUTION(venue) && !JOURNAL_NAME.test(venue)) ||
  REPO_DOI.test(doi || '') || FAKE_VENUE(venue || '', doi || '');
