/* overview.js — the Overview view: "the book, as a landscape".
 *
 * No-fab: every figure is computed from libraryPapers() — the papers currently loaded for the
 * tiers you have switched on — and recomputed when tiers change. Nothing is typed in. Each tier
 * is drawn and counted separately so a machine-tagged record never passes as a hand-coded one.
 * Layout choices (squarified treemap, author row order) are stated in the captions.
 * Every mark opens the Library on exactly those papers.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const TIERS = [
    { key: 'hand', label: 'Hand-coded', test: (p) => !p._recent && !p._management && !p._live, cls: 't-hand' },
    { key: 'recent', label: 'Recent 2024→', test: (p) => p._recent && !p._live, cls: 't-recent' },
    { key: 'mgmt', label: 'All-years import', test: (p) => p._management, cls: 't-mgmt' },
    { key: 'live', label: 'Live', test: (p) => p._live, cls: 't-live' },
  ];
  const BANDS = [
    { key: '90-99', label: 'Top decile', sub: '90–99', test: (v) => v >= 90 },
    { key: '75-89', label: '75–89', sub: '75–89', test: (v) => v >= 75 && v < 90 },
    { key: '50-74', label: '50–74', sub: '50–74', test: (v) => v >= 50 && v < 75 },
    { key: '25-49', label: '25–49', sub: '25–49', test: (v) => v >= 25 && v < 50 },
    { key: 'lt25', label: 'Below 25', sub: '<25', test: (v) => v < 25 },
  ];
  const tierOf = (p) => TIERS.find((t) => t.test(p)) || TIERS[0];
  const bandOf = (v) => (v == null ? null : BANDS.find((b) => b.test(v)));
  const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const $o = (s) => document.querySelector(s);
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // lens: which papers the charts read. 'hand' = the verified hand-coded core (default); 'all' = every loaded tier.
  let LENS = 'hand'; try { if (localStorage.getItem('srb_ov_lens') === 'all') LENS = 'all'; } catch (_) {}

  /* ---------------- data ---------------- */
  function compute(lens) {
    const all = libraryPapers();
    const ps = lens === 'hand' ? all.filter((p) => !p._recent && !p._management && !p._live) : all;
    const D = { ps, n: ps.length, tiers: {}, years: {}, journals: new Map(), authors: new Map(), cites: [], withAbs: 0, oa: 0, doi: 0, banded: 0, constructs: new Set(), yMin: Infinity, yMax: -Infinity };
    for (const t of TIERS) D.tiers[t.key] = 0;
    for (const p of ps) {
      const t = tierOf(p); D.tiers[t.key]++;
      if (p.hasAbstract) D.withAbs++;
      if (p.openAccess) D.oa++;
      if (p.doi) D.doi++;
      const y = +p.year;
      if (y >= 1900 && y <= 2100) {
        if (!D.years[y]) D.years[y] = { hand: 0, recent: 0, mgmt: 0, live: 0 };
        D.years[y][t.key]++;
        if (y < D.yMin) D.yMin = y; if (y > D.yMax) D.yMax = y;
      }
      if (p.scopusPercentile != null) D.banded++;
      if (p.journal) {
        let j = D.journals.get(p.journal); if (!j) D.journals.set(p.journal, (j = { name: p.journal, n: 0, pc: [] }));
        j.n++; if (p.scopusPercentile != null) j.pc.push(p.scopusPercentile);
      }
      for (const a0 of p.authors || []) { const a = (a0 || '').trim(); if (!a) continue; let r = D.authors.get(a); if (!r) D.authors.set(a, (r = { name: a, n: 0, years: [] })); r.n++; if (y) r.years.push(y); }
      if (typeof p.citations === 'number') D.cites.push(p.citations);
      for (const c of p.constructCodes || []) D.constructs.add(c);
    }
    return D;
  }
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  /* ---------------- sections ---------------- */
  function hero(D) {
    const journals = D.journals.size, authors = D.authors.size;
    const tiersOn = TIERS.filter((t) => D.tiers[t.key]);
    $o('#ovLede').innerHTML = D.n
      ? `<b>${fmt(D.n)}</b> papers from <b>${fmt(journals)}</b> journals and sources, by <b>${fmt(authors)}</b> authors, published ${D.yMin}–${D.yMax}. ${pct(D.withAbs, D.n)}% carry an abstract you can read here; ${pct(D.oa, D.n)}% are open access.`
      : 'No papers are loaded for the tiers you have switched on.';
    // provenance ribbon
    const rib = $o('#ovRibbon');
    rib.innerHTML = tiersOn.map((t) => `<button type="button" class="ovr-seg ${t.cls}" style="flex:${D.tiers[t.key]}" data-tier="${t.key}" title="${t.label}: ${fmt(D.tiers[t.key])} papers"></button>`).join('');
    $o('#ovRibbonKey').innerHTML = TIERS.map((t) => `<span class="ovk ${D.tiers[t.key] ? '' : 'off'}"><i class="${t.cls}"></i>${t.label} <b>${fmt(D.tiers[t.key])}</b>${t.key === 'hand' ? '' : ' <em>machine-tagged · verify</em>'}</span>`).join('') +
      (F.recent && F.management ? '' : `<span class="ovk-hint">More tiers can be switched on in Library → <span class="ui">Refine papers &amp; choose corpus tiers</span>.</span>`);
  }

  function ring(v, label, sub) {
    const r = 17, c = 2 * Math.PI * r;
    return `<svg viewBox="0 0 44 44" class="ovv-ring" aria-hidden="true"><circle cx="22" cy="22" r="${r}" class="bg"/><circle cx="22" cy="22" r="${r}" class="fg" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 22 22)"/><text x="22" y="26" text-anchor="middle">${v}%</text></svg><div><b>${label}</b><span>${sub}</span></div>`;
  }
  function vitals(D) {
    const ys = Object.keys(D.years).map(Number).sort((a, b) => a - b);
    const tot = ys.map((y) => Object.values(D.years[y]).reduce((a, b) => a + b, 0)), mx = Math.max(1, ...tot);
    const spark = ys.length ? `<svg viewBox="0 0 120 34" preserveAspectRatio="none" class="ovv-spark" aria-hidden="true"><path d="M0,34 ${ys.map((y, i) => `L${(i / Math.max(1, ys.length - 1) * 120).toFixed(1)},${(34 - tot[i] / mx * 32).toFixed(1)}`).join(' ')} L120,34Z"/></svg>` : '';
    const tiles = [
      `<div class="ovv big"><b>${fmt(D.n)}</b><span>${LENS === 'hand' ? 'hand-coded papers' : 'papers in the loaded tiers'}</span>${spark}</div>`,
      `<div class="ovv"><b>${fmt(S.constructs.length)}</b><span>hand-coded constructs${D.constructs.size ? ` · ${fmt(D.constructs.size)} codes in use here` : ''}</span></div>`,
      `<div class="ovv"><b>${fmt(D.journals.size)}</b><span>journals &amp; sources</span></div>`,
      `<div class="ovv"><b>${fmt(D.authors.size)}</b><span>distinct author names</span></div>`,
      `<div class="ovv ringed">${ring(pct(D.withAbs, D.n), fmt(D.withAbs), 'with an abstract')}</div>`,
      `<div class="ovv ringed">${ring(pct(D.oa, D.n), fmt(D.oa), 'open access')}</div>`,
    ];
    $o('#ovVitals').innerHTML = tiles.join('');
  }

  // ---- the tide: papers per year, stacked by tier ----
  function tide(D) {
    const host = $o('#ovTide'), W = Math.max(320, host.clientWidth), H = W < 640 ? 200 : 250, L = 8, R = 8, T = 18, B = 26;
    host.innerHTML = '';
    const ys = Object.keys(D.years).map(Number); if (!ys.length) return;
    const y0 = Math.max(Math.min(...ys), D.yMax - 60), y1 = D.yMax;      // last 60 years drawn; earlier counted
    const years = []; for (let y = y0; y <= y1; y++) years.push(y);
    const order = ['hand', 'recent', 'mgmt', 'live'];
    const stack = years.map((y) => { const r = D.years[y] || {}; let run = 0; return order.map((k) => { const a = run; run += r[k] || 0; return [a, run]; }); });
    const tot = stack.map((s) => s[s.length - 1][1]), mx = Math.max(1, ...tot);
    const before = ys.filter((y) => y < y0).reduce((a, y) => a + Object.values(D.years[y]).reduce((p, q) => p + q, 0), 0);
    const x = (i) => L + (i / Math.max(1, years.length - 1)) * (W - L - R), yv = (v) => T + (1 - v / mx) * (H - T - B);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ov-svg', role: 'img', 'aria-label': `Papers per year, ${y0}–${y1}, stacked by tier. Peak ${fmt(mx)} in ${years[tot.indexOf(mx)]}.` }, host);
    const defs = el('defs', {}, svg);
    order.forEach((k, ki) => {
      const g = el('linearGradient', { id: `ovTideG${ki}`, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
      el('stop', { offset: 0, class: `stop-${k}`, 'stop-opacity': 0.95 }, g); el('stop', { offset: 1, class: `stop-${k}`, 'stop-opacity': 0.55 }, g);
    });
    for (let d = Math.ceil(y0 / 10) * 10; d <= y1; d += 10) {
      const i = d - y0; el('line', { x1: x(i), x2: x(i), y1: T, y2: H - B + 4, class: 'ov-grid' }, svg);
      const t = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'ov-axis' }, svg); t.textContent = d;
    }
    order.forEach((k, ki) => {
      if (!years.some((_, i) => stack[i][ki][1] > stack[i][ki][0])) return;
      let d = `M${x(0)},${yv(stack[0][ki][1])}`;
      years.forEach((_, i) => { d += ` L${x(i).toFixed(1)},${yv(stack[i][ki][1]).toFixed(1)}`; });
      for (let i = years.length - 1; i >= 0; i--) d += ` L${x(i).toFixed(1)},${yv(stack[i][ki][0]).toFixed(1)}`;
      el('path', { d: d + 'Z', fill: `url(#ovTideG${ki})`, class: `ov-tide t-${k}` }, svg);
    });
    // crest line
    el('path', { d: years.map((_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yv(tot[i]).toFixed(1)}`).join(' '), class: 'ov-crest' }, svg);
    // the hand-coded workbook was coded into 2024: those years are partial, not a decline
    const partialFrom = LENS === 'hand' ? 2024 : null;
    if (partialFrom != null && years.includes(partialFrom)) {
      const i0 = years.indexOf(partialFrom), xs = (x(i0 - 1) + x(i0)) / 2;
      const pat = el('pattern', { id: 'ovHatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
      el('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'ov-hatch' }, pat);
      el('rect', { x: xs, y: T, width: W - R - xs, height: H - B - T, fill: 'url(#ovHatch)' }, svg);
      const pn = el('text', { x: W - R, y: H - B - 8, 'text-anchor': 'end', class: 'ov-note' }, svg); pn.textContent = W < 640 ? `${partialFrom}→ partial` : `${partialFrom}→ partial · coding in progress`;
    }
    const pk = tot.indexOf(mx);
    const pt = el('text', { x: Math.min(W - R, x(pk)) - 4, y: yv(mx) - 6, 'text-anchor': 'end', class: 'ov-note' }, svg); pt.textContent = `${years[pk]} · ${fmt(mx)} papers`;
    if (before) { const bt = el('text', { x: L + 2, y: T + 2, class: 'ov-note faint' }, svg); bt.textContent = `+ ${fmt(before)} earlier than ${y0}`; }
    const scrub = el('line', { y1: T, y2: H - B, class: 'ov-scrub' }, svg);
    const tip = $o('#ovTideTip');
    const at = (e) => { const r = svg.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width * W - L) / (W - L - R) * (years.length - 1)); return Math.max(0, Math.min(years.length - 1, i)); };
    svg.addEventListener('pointermove', (e) => {
      const i = at(e), y = years[i], r = D.years[y] || {};
      scrub.setAttribute('x1', x(i)); scrub.setAttribute('x2', x(i)); scrub.style.opacity = 1;
      tip.innerHTML = `<b>${y}</b> · ${fmt(tot[i])} papers` + order.filter((k) => r[k]).map((k) => ` · <i class="dot t-${k}"></i>${TIERS.find((t) => t.key === k).label} ${fmt(r[k])}`).join('') + ' — click to read them';
    });
    svg.addEventListener('pointerleave', () => { scrub.style.opacity = 0; tip.textContent = 'Hover to read a year; click to open its papers in the Library.'; });
    svg.addEventListener('click', (e) => { const y = years[at(e)]; go(() => { F.yearExact = y; $('#fYear').value = y; F.yMin = F.yMax = null; $('#yMin').value = ''; $('#yMax').value = ''; }); });
    svg.style.cursor = 'pointer';
    tip.textContent = 'Hover to read a year; click to open its papers in the Library.';
  }

  // ---- the bedrock: Scopus percentile strata by decade ----
  function bedrock(D) {
    const host = $o('#ovStrata'); host.innerHTML = '';
    const dec = new Map();
    for (const p of D.ps) {
      const y = +p.year; if (!y) continue; const d = Math.floor(y / 10) * 10;
      let r = dec.get(d); if (!r) dec.set(d, (r = { d, n: 0, none: 0, b: Object.fromEntries(BANDS.map((b) => [b.key, 0])) }));
      r.n++; const b = bandOf(p.scopusPercentile); if (b) r.b[b.key]++; else r.none++;
    }
    const rows = [...dec.values()].sort((a, b) => a.d - b.d).filter((r) => r.n >= 5);
    const small = [...dec.values()].filter((r) => r.n < 5).reduce((a, r) => a + r.n, 0);
    const W = Math.max(320, host.clientWidth), colW = (W - 70) / Math.max(1, rows.length), H = 230, T = 10, B = 40;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ov-svg', role: 'img', 'aria-label': 'Share of papers in each Scopus percentile band, by decade.' }, host);
    const layers = [...BANDS.map((b, i) => ({ ...b, cls: `s${i}` })), { key: 'none', label: 'No percentile', cls: 'snone' }];
    rows.forEach((r, ci) => {
      let acc = 0; const cx = 60 + ci * colW;
      layers.forEach((l) => {
        const v = l.key === 'none' ? r.none : r.b[l.key]; if (!v) return;
        const h = (v / r.n) * (H - T - B), yTop = T + acc; acc += h;
        const rect = el('rect', { x: cx + 3, y: yTop, width: Math.max(2, colW - 6), height: Math.max(0.5, h), rx: 2, class: `ov-stratum ${l.cls}` }, svg);
        const t = el('title', {}, rect); t.textContent = `${r.d}s · ${l.label}${l.sub && l.label !== l.sub ? ` (${l.sub})` : ''}: ${fmt(v)} of ${fmt(r.n)} papers (${pct(v, r.n)}%)${l.key === 'none' ? '' : ' — click to open'}`;
        if (l.key !== 'none') { rect.dataset.band = l.key; rect.dataset.decade = r.d; }
      });
      const t = el('text', { x: cx + colW / 2, y: H - B + 16, 'text-anchor': 'middle', class: 'ov-axis' }, svg); t.textContent = `${r.d}s`;
      const n = el('text', { x: cx + colW / 2, y: H - B + 29, 'text-anchor': 'middle', class: 'ov-axis faint' }, svg); n.textContent = fmt(r.n);
    });
    [0, 50, 100].forEach((v) => { const y = T + (1 - v / 100) * (H - T - B); const t = el('text', { x: 52, y: y + 3, 'text-anchor': 'end', class: 'ov-axis faint' }, svg); t.textContent = `${v}%`; });
    svg.addEventListener('click', (e) => { const r = e.target.closest('[data-band]'); if (!r) return; const d = +r.dataset.decade; go(() => { F.band = r.dataset.band; $('#fBand').value = r.dataset.band; F.yMin = d; F.yMax = d + 9; $('#yMin').value = d; $('#yMax').value = d + 9; F.yearExact = null; $('#fYear').value = ''; }); });
    $o('#ovStrataKey').innerHTML = layers.map((l) => `<span><i class="ov-sw ${l.cls}"></i>${l.label}${l.sub && l.label !== l.sub ? ` <em>${l.sub}</em>` : ''}</span>`).join('') +
      `<span class="ovk-hint">${pct(D.banded, D.n)}% of loaded papers have a paper-level Scopus percentile${small ? `; ${fmt(small)} papers in decades with fewer than five are not drawn` : ''}.</span>`;
  }

  // ---- the canopy: top journals as a squarified treemap ----
  function squarify(items, x, y, w, h) {
    const out = [], total = items.reduce((a, b) => a + b.v, 0); if (!total) return out;
    const scale = (w * h) / total; let rest = items.map((i) => ({ ...i, a: i.v * scale }));
    while (rest.length) {
      const short = Math.min(w, h); let row = [], best = Infinity;
      for (const it of rest) {
        const tr = [...row, it], s = tr.reduce((a, b) => a + b.a, 0), mxA = Math.max(...tr.map((t) => t.a)), mnA = Math.min(...tr.map((t) => t.a));
        const worst = Math.max((short * short * mxA) / (s * s), (s * s) / (short * short * mnA));
        if (worst > best) break; best = worst; row = tr;
      }
      const s = row.reduce((a, b) => a + b.a, 0), thick = s / short; let off = 0;
      for (const it of row) { const len = it.a / thick; out.push(w >= h ? { ...it, x, y: y + off, w: thick, h: len } : { ...it, x: x + off, y, w: len, h: thick }); off += len; }
      if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
      rest = rest.slice(row.length);
    }
    return out;
  }
  function canopy(D) {
    const host = $o('#ovCanopy'); host.innerHTML = '';
    const W = Math.max(320, host.clientWidth), H = W < 640 ? 300 : 360;
    const top = [...D.journals.values()].sort((a, b) => b.n - a.n).slice(0, W < 640 ? 18 : 36);
    const shown = top.reduce((a, j) => a + j.n, 0);
    const cells = squarify(top.map((j) => ({ ...j, v: j.n, med: median(j.pc) })), 0, 0, W, H);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ov-svg ov-canopy', role: 'img', 'aria-label': `The ${top.length} journals with the most papers, sized by papers.` }, host);
    for (const c of cells) {
      const g = el('g', { class: 'ov-leaf', 'data-journal': c.name }, svg);
      const band = c.med == null ? 'none' : c.med >= 90 ? 0 : c.med >= 75 ? 1 : c.med >= 50 ? 2 : c.med >= 25 ? 3 : 4;
      el('rect', { x: c.x + 1.5, y: c.y + 1.5, width: Math.max(0, c.w - 3), height: Math.max(0, c.h - 3), rx: 4, class: `ov-cell c${band}` }, g);
      const t = el('title', {}, g); t.textContent = `${c.name} — ${fmt(c.n)} papers${c.med != null ? ` · median Scopus percentile ${Math.round(c.med)}` : ' · no paper-level percentile'} — click to open`;
      if (c.w > 74 && c.h > 30) {
        const maxCh = Math.floor((c.w - 12) / 6.4), name = c.name.length > maxCh ? c.name.slice(0, maxCh - 1) + '…' : c.name;
        const tn = el('text', { x: c.x + 8, y: c.y + 18, class: 'ov-cell-t' }, g); tn.textContent = name;
        const tv = el('text', { x: c.x + 8, y: c.y + 32, class: 'ov-cell-n' }, g); tv.textContent = fmt(c.n);
      }
    }
    svg.addEventListener('click', (e) => { const g = e.target.closest('[data-journal]'); if (!g) return; go(() => { F.journal = g.dataset.journal; $('#fJournal').value = g.dataset.journal; }); });
    $o('#ovCanopyCap').innerHTML = `The ${top.length} largest of ${fmt(D.journals.size)} journals and sources — ${fmt(shown)} papers, ${pct(shown, D.n)}% of those loaded. Area = papers; shade = the journal's median paper-level Scopus percentile (${document.documentElement.dataset.theme === 'dark' ? 'brighter' : 'darker'} = higher). Placement is a squarified treemap layout, largest first.`;
  }

  // ---- the voices: top authors as strips of paper years ----
  function voices(D) {
    const host = $o('#ovVoices'); host.innerHTML = '';
    const top = [...D.authors.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 24);
    if (!top.length) return;
    const all = top.flatMap((a) => a.years), y0 = Math.min(...all), y1 = Math.max(...all);
    const W = Math.max(320, host.clientWidth), NAME = W < 640 ? 118 : 190, RH = 21, H = top.length * RH + 30, L = NAME + 14, R = 46;
    const x = (y) => L + ((y - y0) / Math.max(1, y1 - y0)) * (W - L - R);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ov-svg', role: 'img', 'aria-label': `The ${top.length} most frequent author names, each paper a dot at its year.` }, host);
    const step = W < 640 ? 10 : 5;
    for (let d = Math.ceil(y0 / step) * step; d <= y1; d += step) { el('line', { x1: x(d), x2: x(d), y1: 4, y2: H - 22, class: 'ov-grid' }, svg); const t = el('text', { x: x(d), y: H - 6, 'text-anchor': 'middle', class: 'ov-axis' }, svg); t.textContent = d; }
    top.forEach((a, i) => {
      const cy = 12 + i * RH, g = el('g', { class: 'ov-voice', 'data-author': a.name }, svg);
      el('rect', { x: 0, y: cy - RH / 2, width: W, height: RH, class: 'ov-voice-bg' }, g);
      const nm = el('text', { x: NAME, y: cy + 4, 'text-anchor': 'end', class: 'ov-voice-n' }, g); nm.textContent = a.name.length > (NAME / 6.6 | 0) ? a.name.slice(0, (NAME / 6.6 | 0) - 1) + '…' : a.name;
      const ys = a.years; if (ys.length) el('line', { x1: x(Math.min(...ys)), x2: x(Math.max(...ys)), y1: cy, y2: cy, class: 'ov-voice-span' }, g);
      const per = {}; for (const y of ys) per[y] = (per[y] || 0) + 1;
      for (const y in per) { const c = el('circle', { cx: x(+y), cy, r: Math.min(8.5, 2.6 + Math.sqrt(per[y]) * 1.6), class: 'ov-voice-d' }, g); const t = el('title', {}, c); t.textContent = `${a.name} · ${y}: ${per[y]} paper${per[y] > 1 ? 's' : ''}`; }
      const c = el('text', { x: W - 4, y: cy + 4, 'text-anchor': 'end', class: 'ov-axis' }, g); c.textContent = a.n;
      const t = el('title', {}, g); t.textContent = `${a.name} — ${a.n} papers, ${Math.min(...ys)}–${Math.max(...ys)} — click to open`;
    });
    svg.addEventListener('click', (e) => { const g = e.target.closest('[data-author]'); if (!g) return; go(() => { F.author = g.dataset.author; syncAuthorSelect(); }); });
  }

  // ---- citations: log-binned distribution ----
  function citations(D) {
    const host = $o('#ovCites'); host.innerHTML = '';
    const c = D.cites; if (!c.length) { host.textContent = 'No citation counts in the loaded papers.'; return; }
    const edges = [0, 1, 3, 10, 30, 100, 300, 1000, 3000, Infinity], labels = ['0', '1–2', '3–9', '10–29', '30–99', '100–299', '300–999', '1k–3k', '3k+'];
    const bins = labels.map(() => 0); for (const v of c) { let i = edges.findIndex((e, k) => v >= e && v < edges[k + 1]); if (i >= 0) bins[i]++; }
    const mx = Math.max(...bins), med = median(c);
    const W = Math.max(320, host.clientWidth), H = 250, B = 34, T = 24, bw = (W - 20) / bins.length;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ov-svg', role: 'img', 'aria-label': `Citation counts of ${fmt(c.length)} papers; median ${med}.` }, host);
    bins.forEach((v, i) => {
      const h = (v / mx) * (H - T - B), x0 = 10 + i * bw;
      const r = el('rect', { x: x0 + 4, y: H - B - h, width: bw - 8, height: Math.max(1, h), rx: 3, class: 'ov-bar' }, svg);
      const tt = el('title', {}, r); tt.textContent = `${labels[i]} citations: ${fmt(v)} papers (${pct(v, c.length)}%)`;
      if (bw > 44 || i % 2 === 0) { const t = el('text', { x: x0 + bw / 2, y: H - B + 15, 'text-anchor': 'middle', class: 'ov-axis' }, svg); t.textContent = labels[i]; }
      if (v) { const n = el('text', { x: x0 + bw / 2, y: H - B - h - 5, 'text-anchor': 'middle', class: 'ov-axis faint' }, svg); n.textContent = bw > 44 ? fmt(v) : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : fmt(v); }
    });
    const mi = edges.findIndex((e, k) => med >= e && med < edges[k + 1]);
    const mxp = 10 + mi * bw + bw / 2; el('line', { x1: mxp, x2: mxp, y1: T - 8, y2: H - B, class: 'ov-median' }, svg);

    $o('#ovCitesCap').innerHTML = `<b>Median: ${med} citation${med === 1 ? '' : 's'}</b> (dashed line). Citation counts as recorded on each paper (OpenAlex/Crossref at the time it was added — they grow over time and differ between sources). ${fmt(c.length)} of ${fmt(D.n)} papers carry a count. Bins widen by roughly ×3 so the long tail stays visible.`;
  }

  function lensBar(ALL) {
    const host = $o('#ovLens'), hand = ALL.tiers.hand, other = ALL.n - hand;
    host.innerHTML = `<span class="ov-kicker">Charts below read</span><div class="ov-seg" role="group" aria-label="Which papers the charts read">` +
      `<button type="button" data-lens="hand" aria-pressed="${LENS === 'hand'}">Hand-coded core · ${fmt(hand)}</button>` +
      `<button type="button" data-lens="all" aria-pressed="${LENS === 'all'}" ${other ? '' : 'disabled'}>All loaded tiers · ${fmt(ALL.n)}</button></div>` +
      `<span class="ovk-hint">${LENS === 'hand' ? 'The verified, hand-coded papers only.' : 'Includes machine-tagged tiers — recent papers carry no paper-level Scopus percentile and few citations yet.'}</span>`;
  }
  // In the hand-coded lens, open the Library on the same papers the chart counted: switch the
  // machine-tagged tiers off for this view (the saved preference in localStorage is left alone).
  function go(setFilters) {
    if (LENS === 'hand') { F.recent = false; F.management = false; const r = $('#fRecent'), m = $('#fManagement'); if (r) r.checked = false; if (m) m.checked = false; }
    setFilters(); S.page = 0; applyAndRender(); setView('library');
  }

  let lastW = 0;
  function render() {
    if (!$o('#v-overview') || typeof libraryPapers !== 'function' || !S.papers || !S.papers.length) return;
    if ($o('#v-overview').classList.contains('hidden')) { window.__ovDirty = true; return; }   // draw when shown (needs real widths)
    window.__ovDirty = false;
    const ALL = compute('all'), D = compute(LENS);
    $o('#ovTideCap').textContent = LENS === 'hand' ? "Each year's height is the hand-coded papers published that year. Hatched years were still being coded." : "Each year's height is the papers published that year, stacked by tier — the hand-coded core at the bottom, machine-tagged tiers above it.";
    hero(ALL); lensBar(ALL); vitals(D); tide(D); bedrock(D); canopy(D); voices(D); citations(D);
    lastW = $o('#v-overview').clientWidth;
    $o('#v-overview').classList.toggle('ov-anim', !reduce());
  }
  window.OV = { render };
  new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new ResizeObserver(() => { const w = $o('#v-overview')?.clientWidth || 0; if (w && Math.abs(w - lastW) > 24) render(); }).observe(document.body);
  $o('#ovRibbon')?.addEventListener('click', () => setView('library'));
  $o('#ovLens')?.addEventListener('click', (e) => { const b = e.target.closest('[data-lens]'); if (!b || b.disabled || b.dataset.lens === LENS) return; LENS = b.dataset.lens; try { localStorage.setItem('srb_ov_lens', LENS); } catch (_) {} render(); });
  if (window.S && S.papers && S.papers.length) render();
})();
