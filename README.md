# Syed's Research Book

A browsable, filterable, time-flowed view of a **24-month systematic-review corpus** —
**9,388 unique papers** across **167 management / organizational-behavior constructs**, every
paper DOI-keyed and Scopus-graded. Reference-tier sibling to ScholarScope / TheoryScope /
FallacyScope; the literature *spine* the rest of the suite reads from.

> **NO FABRICATION.** Every record is Syed's own hand-verified coding, transformed (never
> invented) from the source workbook. Gap-filling (missing abstracts) may only pull from real
> DOI records (Crossref / OpenAlex).

Single-file app (`index.html`, no build) — same pattern as ScholarScope / FallacyScope. It
fetches the JSON in `data/` at runtime, so it must be served over HTTP (file:// blocks fetch).

```powershell
# run locally
cd syeds-research-book ; python -m http.server 8000   # then open http://localhost:8000
```

## Status
- **Phase 0 — DONE:** deterministic `xlsx → JSON` conversion + cleaning. (`scripts/convert-xlsx.ps1`)
- **Phase 1 — DONE:** data split (index + lazy abstracts) + the app — **Library** (search · construct ·
  year · Scopus tier · OA · sort, paginated), **Constructs** taxonomy, **Overview** (stats, by-decade,
  Scopus bands, top journals), paper detail modal with **PaperCards** handoff + DOI/OA/RG/CP/Sci-Hub
  links. Verified headlessly (boots, 9,388 papers, filters, modal, all views).
- **Phase 2 — DONE:** record-type cleaning + **Map** (construct co-occurrence force graph) + **Trends**
  (construct × year surge heatmap). **Published** → GitHub Pages, live below.
- **Next:** deeper suite handoffs + catalog-grounding for ResearchFlow (Phase 3–4) · DOI-based abstract
  enrichment for the ~56% without an in-sheet abstract.

**Live:** https://syahmedu.github.io/syeds-research-book/

## App views
- **Library** — the full 9,388-paper corpus; client-side filter/sort over an in-memory index; 50/page.
- **Constructs** — the 167-construct taxonomy with keyword vocabularies; click → Library filtered to it.
- **Map** — construct co-occurrence force graph (edges = papers shared between two constructs); click a node → Library filtered to it.
- **Trends** — construct × year surge heatmap (rows = busiest constructs, columns = years, darker = more papers); click a row → its papers.
- **Overview** — counts + by-decade + Scopus-band distributions + top journals (computed live from the data).

## Data (`data/`)
Generated from the source workbook (NOT committed — 27 MB, Google Drive id
`1ZnImdN4SjXAod0TLq7Qwob0yZeiwIZhG`).

- **`papers.json`** — canonical full export, unique papers (deduped by DOI). Fields: `id, doi, title,
  briefTitle, authors[], year, citations, journal, scopusCategory, scopusPercentile, publisher,
  openAccess, oaUrl, abstract, rgUrl, connectedPapersUrl, scihubUrl, bibtexUrl, constructCodes[]`.
- **`papers.index.json`** — same minus `abstract`, plus `hasAbstract` — the file the app loads eagerly.
- **`abstracts.json`** — `{ paperId: abstract }` for the 4,115 papers with an abstract; loaded lazily.
- **`constructs.json`** — 167 clusters: `{ no, code, name, identifiers[], paperCountSheet, paperCount }`.
- **`memberships.json`** — `{ c: constructCode, p: paperId }` edges (the co-occurrence graph).
- **`summary.json`** — counts + distributions + cleaning report.

## Regenerate
```powershell
# 1. download the source workbook (anyone-with-link):
#    https://docs.google.com/spreadsheets/d/1ZnImdN4SjXAod0TLq7Qwob0yZeiwIZhG/export?format=xlsx
powershell -ExecutionPolicy Bypass -File scripts/convert-xlsx.ps1 -Xlsx <path-to.xlsx> -OutDir data
powershell -ExecutionPolicy Bypass -File scripts/split-data.ps1
```
Pure transforms, no dependencies (uses .NET `System.IO.Compression`).

## Cleaning applied
- Dedup by normalized DOI; rows with no DOI dropped (4; logged in `summary.droppedNoDoi`).
- Years kept only if 1900–2026 (219 impossible values nulled).
- `Abstract Not Found` → null abstract; `Journal Name Not Found` → null journal.
- HTML entities fully decoded (handles double-encoded `&amp;amp;`).
- Master tabs verified to add no papers beyond the clusters (`summary.masterOrphanDois = 0`).

## Known follow-ups
- Some literal placeholders survive in source fields (`N/A`, `No Link Available`) → could be nulled.
- ~56% of papers have no in-sheet abstract → fetchable via DOI later.
- Non-article records (PsycTESTS/PsycEXTRA datasets, SSRN preprints) could be typed/flagged.
