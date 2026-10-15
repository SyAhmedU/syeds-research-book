// Shared "is this venue a repository / dataset deposit, not a journal?" rule.
// Used by refresh-openalex.mjs (fetch gate), merge-refresh.mjs (merge + purge)
// and purge-repo-venues.mjs (one-shot clean of the committed tier).
// OpenAlex names institutional repositories "<Repo name> (<University>)" or just
// "<University>"; those are deposits (often future-dated, often duplicates of a
// journal version, often not management) — keep the recent tier journal-grade.
const HOSTS = /zenodo|ssrn|research square|preprints\.org|authorea|biorxiv|medrxiv|arxiv|figshare|researchgate|^osf\b|qeios/i;
const DEPOSIT = /repositor(y|ies)|research online|theses online|\btheses\b|dissertations|scholarworks|dataverse|mendeley data|\bdataset\b|data holdings|dataport|researchdata|data archive|data catalogue|biodata catalyst|^hal\b|open collections|digital commons|e-?prints|dspace|\bcentaur\b|\birdb\b|^biron\b|^clok\b|knowledge commons/i;
// Real journals often carry their university in the name (Vestnik, Visnyk,
// Izvestia, "... Journal (University X)") — never drop those on the institution rule.
const JOURNAL_NAME = /journal|jurnal|review|vestnik|visnyk|izvestia|herald|scientific|partnership|statistics|bulletin|annals|proceedings|series|quarterly|transactions|letters|magazine|studies|institute of educational/i;
const INSTITUTION = (v) =>
  /\([^)]*(Universit|School|College|Institute|Polytechnic)[^)]*\)\s*$/i.test(v) ||
  /^(UC [A-Z]\w+( [A-Z]\w+)*|[\w .'-]*Universit(y|é|ät|à|ad)[\w .,'-]*)$/.test(v);

export const isRepoVenue = (venue = '') =>
  HOSTS.test(venue) || DEPOSIT.test(venue) || (INSTITUTION(venue) && !JOURNAL_NAME.test(venue));
