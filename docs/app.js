/* Pakistan Economic Dashboard
 * Fetches live data in the browser from keyless public APIs (World Bank, IMF DataMapper,
 * ExchangeRate-API, fawazahmed0 currency API). Anything that fails falls back to the
 * snapshot in data.json written by collector/collect.py. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const SVG = 'http://www.w3.org/2000/svg';
  const DAY = 864e5;
  const THIS_YEAR = new Date().getFullYear();

  const state = {
    cfg: null,
    snap: null,
    ind: {},                       // id -> {meta, wb, imf, wbFrom, imfFrom}
    fx: { latest: null, history: [], from: null },
    sources: {},                   // worldbank / imf / fx -> {status, text, detail}
    pick: 'inflation',
    range: '20',
    proj: true,
    showTable: false,
  };

  // ---------------------------------------------------------------- helpers
  async function getJSON(url, ms = 20000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        const k = i++;
        try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const sv = (tag, attrs) => {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const timeStr = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };
  const dateStr = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  function fmtFor(unit) {
    const n = (v, d) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    switch (unit) {
      case '%': return { full: (v) => n(v, 1) + '%', tick: (v) => n(v, 0) + '%', unit: '%' };
      case '% of GDP': return { full: (v) => n(v, 1) + '% of GDP', tick: (v) => n(v, 0) + '%', unit: '% of GDP' };
      case 'US$ bn': return { full: (v) => '$' + n(v, 1) + 'bn', tick: (v) => '$' + n(v, 0) + 'bn', unit: 'US$ bn' };
      case 'US$': return { full: (v) => '$' + n(v, 0), tick: (v) => '$' + n(v, 0), unit: 'US$' };
      case 'PKR': return { full: (v) => n(v, 2), tick: (v) => n(v, 0), unit: 'PKR' };
      default: return { full: (v) => n(v, 2) + (unit ? ' ' + unit : ''), tick: (v) => n(v, 1), unit: unit || '' };
    }
  }
  // Tick formatter that keeps one decimal when the tick step is fractional.
  const tickFmt = (f, step) => (v) => (step < 1 ? f.full(v).replace(' of GDP', '') : f.tick(v));

  const scaled = (meta, pts) => (pts || []).map(([x, y]) => [x, y / (meta.scale || 1)]);
  const last = (a) => (a && a.length ? a[a.length - 1] : null);

  // ---------------------------------------------------------------- sources
  async function loadWB(code) {
    const url = `https://api.worldbank.org/v2/country/${state.cfg.country}/indicator/${code}?format=json&per_page=200&date=1980:2100`;
    const j = await getJSON(url);
    if (!Array.isArray(j) || !Array.isArray(j[1])) throw new Error('unexpected response');
    const rows = j[1].filter((r) => r.value != null).map((r) => [+r.date, +r.value]).sort((a, b) => a[0] - b[0]);
    if (!rows.length) throw new Error('no values');
    return rows;
  }

  async function loadIMF(code) {
    const c = state.cfg.country;
    const j = await getJSON(`https://www.imf.org/external/datamapper/api/v1/${code}/${c}`);
    const v = j && j.values && j.values[code] && j.values[code][c];
    if (!v) throw new Error('no values');
    return Object.entries(v).map(([y, x]) => [+y, +x]).filter((r) => isFinite(r[1])).sort((a, b) => a[0] - b[0]);
  }

  async function loadFxLatest() {
    const j = await getJSON('https://open.er-api.com/v6/latest/USD');
    if (j.result !== 'success' || !j.rates || !j.rates.PKR) throw new Error('unexpected response');
    return { rate: j.rates.PKR, time: new Date(j.time_last_update_unix * 1000).toISOString() };
  }

  async function fxOn(date) {
    const urls = [
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.min.json`,
      `https://${date}.currency-api.pages.dev/v1/currencies/usd.min.json`,
    ];
    for (const u of urls) {
      try {
        const j = await getJSON(u, 15000);
        if (j && j.usd && j.usd.pkr) return [Date.parse(j.date), j.usd.pkr];
      } catch (e) { /* try next mirror */ }
    }
    return null;
  }

  async function loadFxHistory() {
    const { history_days, step_days } = state.cfg.fx;
    const now = Date.now();
    const dates = [];
    for (let i = history_days; i >= 1; i -= step_days) dates.push(new Date(now - i * DAY).toISOString().slice(0, 10));
    dates.push('latest');
    const res = await pool(dates, 8, fxOn);
    const byDay = new Map();
    for (const r of res) if (r && isFinite(r[0])) byDay.set(r[0], r[1]);
    const pts = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
    if (pts.length < 5) throw new Error('too few points');
    return pts;
  }

  function allIndicators() {
    return [...state.cfg.worldbank, ...state.cfg.imf_only];
  }

  function seedFromSnapshot() {
    const s = (state.snap && state.snap.ind) || {};
    for (const m of allIndicators()) {
      const sn = s[m.id] || {};
      state.ind[m.id] = {
        meta: m,
        wb: sn.wb || [], wbFrom: sn.wb && sn.wb.length ? 'snapshot' : null,
        imf: sn.imf || [], imfFrom: sn.imf && sn.imf.length ? 'snapshot' : null,
      };
    }
    const fx = (state.snap && state.snap.fx) || {};
    state.fx = { latest: fx.latest || null, history: fx.history || [], from: fx.history && fx.history.length ? 'snapshot' : null };
  }

  function setSource(key, status, text, detail) {
    state.sources[key] = { status, text, detail };
    renderStatus();
  }

  function summarize(key, label, ok, total, failures) {
    const snapTime = state.snap && state.snap.asOf ? ' (snapshot ' + timeStr(state.snap.asOf) + ')' : '';
    const now = new Date().toLocaleTimeString(undefined, { timeStyle: 'short' });
    if (ok === total) setSource(key, 'ok', `${label}: live · ${now}`, '');
    else if (ok > 0) setSource(key, 'stale', `${label}: ${ok}/${total} live, rest from snapshot${snapTime}`, failures.join('\n'));
    else setSource(key, 'fail', `${label}: unreachable, showing snapshot${snapTime}`, failures.join('\n'));
  }

  async function loadWorldBank() {
    setSource('worldbank', 'load', 'World Bank: loading…');
    const list = state.cfg.worldbank;
    const failures = [];
    let ok = 0;
    await pool(list, 6, async (m) => {
      try {
        state.ind[m.id].wb = await loadWB(m.code);
        state.ind[m.id].wbFrom = 'live';
        ok++;
      } catch (e) { failures.push(m.label + ': ' + e.message); }
    });
    summarize('worldbank', 'World Bank', ok, list.length, failures);
  }

  async function loadIMFAll() {
    setSource('imf', 'load', 'IMF WEO: loading…');
    const list = allIndicators().filter((m) => m.imf);
    const failures = [];
    let ok = 0;
    await pool(list, 6, async (m) => {
      try {
        state.ind[m.id].imf = await loadIMF(m.imf);
        state.ind[m.id].imfFrom = 'live';
        ok++;
      } catch (e) { failures.push(m.label + ': ' + e.message); }
    });
    summarize('imf', 'IMF WEO', ok, list.length, failures);
  }

  async function loadFx() {
    setSource('fx', 'load', 'USD/PKR: loading…');
    const [latest, hist] = await Promise.allSettled([loadFxLatest(), loadFxHistory()]);
    const failures = [];
    if (latest.status === 'fulfilled') state.fx.latest = latest.value; else failures.push('latest rate: ' + latest.reason.message);
    if (hist.status === 'fulfilled') { state.fx.history = hist.value; state.fx.from = 'live'; } else failures.push('history: ' + hist.reason.message);
    summarize('fx', 'USD/PKR', 2 - failures.length, 2, failures);
  }

  async function refresh() {
    $('#refresh').disabled = true;
    const jobs = [loadWorldBank(), loadIMFAll(), loadFx()].map((p) => p.then(renderAll));
    await Promise.allSettled(jobs);
    $('#refresh').disabled = false;
  }

  // ---------------------------------------------------------------- chart
  const tip = () => $('#tip');
  const charts = new Set();
  const ro = new ResizeObserver((entries) => entries.forEach((e) => e.target.__draw && e.target.__draw()));

  function niceStep(span, count) {
    const raw = span / Math.max(count, 1);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  /* series: [{name, color, pts:[[x,y]], proj:[[x,y]]}] ; opts: {xType, f, compact, labels} */
  function lineChart(host, series, opts) {
    host.__draw = () => drawChart(host, series, opts);
    host.__draw();
    if (!charts.has(host)) { charts.add(host); ro.observe(host); }
  }

  function drawChart(host, series, o) {
    host.textContent = '';
    const all = series.flatMap((s) => [...s.pts, ...(s.proj || [])]);
    if (!all.length) { host.appendChild(el('div', 'empty', 'No data available')); return; }
    const W = host.clientWidth || 300, H = host.clientHeight || 200;
    const compact = !!o.compact;

    let ymin = Math.min(...all.map((p) => p[1])), ymax = Math.max(...all.map((p) => p[1]));
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    const yStep = niceStep(ymax - ymin, compact ? 2 : 5);
    const y0 = Math.floor(ymin / yStep) * yStep, y1 = Math.ceil(ymax / yStep) * yStep;
    const yt = tickFmt(o.f, yStep);
    const yTicks = [];
    for (let v = y0; v <= y1 + yStep / 2; v += yStep) yTicks.push(+v.toFixed(10));

    const xs = [...new Set(all.map((p) => p[0]))].sort((a, b) => a - b);
    const x0 = xs[0], x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];

    const labelW = Math.max(...yTicks.map((v) => yt(v).length)) * 6.4 + 8;
    const endLabelW = o.labels ? Math.max(...series.map((s) => s.name.length)) * 6.2 + 14 : 0;
    const m = { t: 8, r: Math.max(compact ? 6 : 12, endLabelW), b: 22, l: labelW };
    const pw = Math.max(W - m.l - m.r, 40), ph = Math.max(H - m.t - m.b, 30);
    const X = (x) => m.l + ((x - x0) / (x1 - x0)) * pw;
    const Y = (y) => m.t + (1 - (y - y0) / (y1 - y0)) * ph;

    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', tabindex: '0' });
    svg.setAttribute('aria-label', o.aria || series.map((s) => s.name).join(', '));

    // grid + y ticks
    for (const v of yTicks) {
      svg.appendChild(sv('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), class: v === 0 ? 'base' : 'gridl' }));
      const t = sv('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' });
      t.textContent = yt(v);
      svg.appendChild(t);
    }
    if (!yTicks.includes(0)) svg.appendChild(sv('line', { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, class: 'base' }));

    // x ticks
    const maxTicks = Math.max(2, Math.floor(pw / (o.xType === 'date' ? 80 : 52)));
    if (o.xType === 'date') {
      const first = new Date(x0); first.setDate(1); first.setHours(0, 0, 0, 0);
      const months = [];
      for (let d = new Date(first); d.getTime() <= x1; d.setMonth(d.getMonth() + 1)) if (d.getTime() >= x0) months.push(d.getTime());
      const every = Math.ceil(months.length / maxTicks) || 1;
      months.filter((_, i) => i % every === 0).forEach((ms) => {
        const t = sv('text', { x: X(ms), y: H - 6, 'text-anchor': 'middle', class: 'tick' });
        t.textContent = new Date(ms).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
        svg.appendChild(t);
      });
    } else {
      const span = x1 - x0;
      const step = [1, 2, 5, 10, 20].find((s) => span / s <= maxTicks) || 25;
      for (let yv = Math.ceil(x0 / step) * step; yv <= x1; yv += step) {
        const t = sv('text', { x: X(yv), y: H - 6, 'text-anchor': 'middle', class: 'tick' });
        t.textContent = String(yv);
        svg.appendChild(t);
      }
    }

    // lines
    const pathD = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join('');
    const lineAttrs = { fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
    series.forEach((s) => {
      if (s.pts.length > 1) {
        const p = sv('path', Object.assign({ d: pathD(s.pts) }, lineAttrs));
        p.style.stroke = s.color;
        svg.appendChild(p);
      }
      if (s.proj && s.proj.length) {
        const joined = s.pts.length ? [last(s.pts), ...s.proj] : s.proj;
        const p = sv('path', Object.assign({ d: pathD(joined), 'stroke-dasharray': '5 4' }, lineAttrs));
        p.style.stroke = s.color;
        svg.appendChild(p);
      }
      const end = last(s.proj && s.proj.length ? s.proj : s.pts);
      if (end) {
        const c = sv('circle', { cx: X(end[0]), cy: Y(end[1]), r: compact ? 3 : 4, 'stroke-width': 2 });
        c.style.fill = s.color; c.style.stroke = 'var(--surface)';
        svg.appendChild(c);
      }
    });

    // direct end labels (de-collided)
    if (o.labels) {
      const labs = series.map((s) => {
        const end = last(s.proj && s.proj.length ? s.proj : s.pts);
        return end ? { s, x: X(end[0]) + 8, y: Y(end[1]) + 4 } : null;
      }).filter(Boolean).sort((a, b) => a.y - b.y);
      for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < 13) labs[i].y = labs[i - 1].y + 13;
      labs.forEach((l) => {
        const t = sv('text', { x: l.x, y: l.y, class: 'dlabel' });
        t.textContent = l.s.name;
        svg.appendChild(t);
      });
    }

    // hover layer
    const hair = sv('line', { y1: m.t, y2: m.t + ph, class: 'xhair', visibility: 'hidden' });
    svg.appendChild(hair);
    const dots = series.map((s) => {
      const c = sv('circle', { r: 4.5, 'stroke-width': 2, visibility: 'hidden' });
      c.style.fill = s.color; c.style.stroke = 'var(--surface)';
      svg.appendChild(c);
      return c;
    });
    const hit = sv('rect', { x: m.l - 10, y: 0, width: pw + 20, height: H, fill: 'transparent' });
    svg.appendChild(hit);
    host.appendChild(svg);

    const lookup = series.map((s) => {
      const map = new Map();
      s.pts.forEach((p) => map.set(p[0], { y: p[1], proj: false }));
      (s.proj || []).forEach((p) => map.set(p[0], { y: p[1], proj: true }));
      return map;
    });
    let idx = -1;
    const show = (i, cx, cy) => {
      idx = Math.max(0, Math.min(xs.length - 1, i));
      const x = xs[idx];
      hair.setAttribute('x1', X(x)); hair.setAttribute('x2', X(x)); hair.setAttribute('visibility', 'visible');
      const t = tip();
      t.textContent = '';
      t.appendChild(el('div', 't', o.xType === 'date' ? dateStr(x) : String(x)));
      series.forEach((s, k) => {
        const hitv = lookup[k].get(x);
        if (!hitv) { dots[k].setAttribute('visibility', 'hidden'); return; }
        dots[k].setAttribute('cx', X(x)); dots[k].setAttribute('cy', Y(hitv.y)); dots[k].setAttribute('visibility', 'visible');
        const r = el('div', 'r');
        const key = el('i'); key.style.borderColor = s.color; if (hitv.proj) key.style.borderTopStyle = 'dashed';
        r.append(key, el('b', null, o.f.full(hitv.y)), el('span', null, s.name + (hitv.proj ? ' (projection)' : '')));
        t.appendChild(r);
      });
      t.hidden = false;
      const box = host.getBoundingClientRect();
      const px = cx != null ? cx : box.left + X(x), py = cy != null ? cy : box.top + m.t;
      const tw = t.offsetWidth, th = t.offsetHeight;
      let left = px + 14; if (left + tw > window.innerWidth - 8) left = px - tw - 14;
      let top = py - th / 2; top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
      t.style.left = Math.max(8, left) + 'px'; t.style.top = top + 'px';
    };
    const hide = () => {
      hair.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      tip().hidden = true;
    };
    const nearest = (px) => {
      const xv = x0 + ((px - m.l) / pw) * (x1 - x0);
      let best = 0;
      xs.forEach((v, i) => { if (Math.abs(v - xv) < Math.abs(xs[best] - xv)) best = i; });
      return best;
    };
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      show(nearest(((e.clientX - r.left) / r.width) * W), e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('focus', () => show(xs.length - 1));
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { show(idx - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { show(idx + 1); e.preventDefault(); }
      if (e.key === 'Escape') hide();
    });
  }

  function legend(host, items) {
    host.textContent = '';
    items.forEach((it) => {
      const s = el('span');
      const i = el('i', it.dash ? 'dash' : '');
      i.style.borderColor = it.color;
      s.append(i, document.createTextNode(it.name));
      host.appendChild(s);
    });
  }

  // ---------------------------------------------------------------- views
  function sparkline(host, pts) {
    host.textContent = '';
    if (!pts || pts.length < 2) return;
    const W = 200, H = 34;
    const ys = pts.map((p) => p[1]);
    const mn = Math.min(...ys), mx = Math.max(...ys), sp = mx - mn || 1;
    const x0 = pts[0][0], xsp = last(pts)[0] - x0 || 1;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + (((p[0] - x0) / xsp) * (W - 4) + 2).toFixed(1) + ',' + (H - 3 - ((p[1] - mn) / sp) * (H - 6)).toFixed(1)).join('');
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const p = sv('path', { d, fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' });
    p.style.stroke = 'var(--s1)';
    svg.appendChild(p);
    host.appendChild(svg);
  }

  function kpi(label, value, unitSmall, change, meta, spark) {
    const c = el('div', 'kpi');
    c.appendChild(el('div', 'lab', label));
    const v = el('div', 'val', value);
    if (unitSmall) v.appendChild(el('small', null, unitSmall));
    c.appendChild(v);
    const ch = el('div', 'chg');
    if (change) {
      ch.appendChild(el('span', change.dir > 0 ? 'up' : 'down', (change.dir > 0 ? '▲ ' : change.dir < 0 ? '▼ ' : '■ ') + change.text));
      ch.appendChild(document.createTextNode(' ' + change.ctx));
    }
    c.appendChild(ch);
    if (meta) c.appendChild(el('div', 'chg', meta));
    const s = el('div', 'spark');
    c.appendChild(s);
    sparkline(s, spark);
    return c;
  }

  function annualKpi(id, title) {
    const d = state.ind[id];
    if (!d) return null;
    const f = fmtFor(d.meta.unit);
    const wb = scaled(d.meta, d.wb);
    const L = last(wb);
    if (!L) return kpi(title, '—', '', null, 'No data', null);
    const P = wb.length > 1 ? wb[wb.length - 2] : null;
    let change = null;
    if (P) {
      const diff = L[1] - P[1];
      const pct = d.meta.unit.startsWith('%');
      change = {
        dir: Math.sign(+diff.toFixed(2)),
        text: pct ? Math.abs(diff).toFixed(1) + ' pp' : Math.abs((diff / Math.abs(P[1])) * 100).toFixed(1) + '%',
        ctx: 'vs ' + P[0],
      };
    }
    const imfNow = (d.imf || []).find((p) => p[0] === THIS_YEAR);
    const meta = imfNow ? `IMF ${THIS_YEAR} projection: ${fmtFor(d.meta.unit).full(imfNow[1])}` : 'World Bank';
    const ofGdp = d.meta.unit === '% of GDP';
    const value = ofGdp ? f.full(L[1]).replace(' of GDP', '') : f.full(L[1]);
    return kpi(`${title} · ${L[0]}`, value, ofGdp ? 'of GDP' : '', change, meta, wb.slice(-15));
  }

  function renderKpis() {
    const host = $('#kpis');
    host.textContent = '';
    // FX tile
    const h = state.fx.history;
    const rate = state.fx.latest ? state.fx.latest.rate : (last(h) || [])[1];
    let change = null;
    if (rate && h.length > 2) {
      const target = Date.now() - 30 * DAY;
      const ref = h.reduce((b, p) => (Math.abs(p[0] - target) < Math.abs(b[0] - target) ? p : b), h[0]);
      const pct = ((rate - ref[1]) / ref[1]) * 100;
      change = { dir: Math.sign(+pct.toFixed(2)), text: Math.abs(pct).toFixed(2) + '%', ctx: 'vs 30 days ago' };
    }
    const when = state.fx.latest ? 'Updated ' + timeStr(state.fx.latest.time) : '';
    host.appendChild(kpi('USD/PKR · live', rate ? rate.toFixed(2) : '—', rate ? 'PKR' : '', change, when, h));
    [['inflation', 'CPI inflation'], ['gdp_growth', 'Real GDP growth'], ['reserves', 'Reserves'],
      ['remittances', 'Remittances'], ['ca_gdp', 'Current account']].forEach(([id, t]) => {
      const k = annualKpi(id, t);
      if (k) host.appendChild(k);
    });
  }

  function renderFx() {
    const h = state.fx.history;
    const f = fmtFor('PKR');
    $('#fx-note').textContent = h.length
      ? `PKR per US dollar, ${dateStr(h[0][0])} – ${dateStr(last(h)[0])}${state.fx.from === 'snapshot' ? ' (snapshot)' : ''}`
      : '';
    lineChart($('#fx-chart'), [{ name: 'USD/PKR', color: 'var(--s1)', pts: h }], { xType: 'date', f, aria: 'USD/PKR exchange rate, daily' });
  }

  function rangeFilter(pts) {
    if (state.range === 'all') return pts;
    const from = THIS_YEAR - +state.range;
    return pts.filter((p) => p[0] >= from);
  }

  function explorerSeries(id) {
    const d = state.ind[id];
    const out = [];
    const wb = rangeFilter(scaled(d.meta, d.wb));
    if (wb.length) out.push({ name: 'World Bank (actual)', color: 'var(--s1)', pts: wb });
    // IMF overlay follows the projections toggle; IMF-only indicators always show their actuals.
    if (d.imf && d.imf.length && (state.proj || !wb.length)) {
      const imf = rangeFilter(d.imf);
      out.push({
        name: 'IMF WEO', color: 'var(--s2)',
        pts: imf.filter((p) => p[0] < THIS_YEAR), proj: state.proj ? imf.filter((p) => p[0] >= THIS_YEAR) : [],
      });
    }
    return out;
  }

  function renderExplorer() {
    const d = state.ind[state.pick];
    if (!d) return;
    const f = fmtFor(d.meta.unit);
    const series = explorerSeries(state.pick);
    const srcs = [d.wbFrom && `World Bank (${d.wbFrom})`, d.imfFrom && `IMF (${d.imfFrom})`].filter(Boolean).join(' · ');
    $('#pick-desc').textContent = `${d.meta.label}, ${f.unit}. ${srcs ? 'Source: ' + srcs + '.' : 'No data loaded yet.'}`;
    const items = [];
    series.forEach((s) => {
      items.push({ name: s.name, color: s.color });
      if (s.proj && s.proj.length) items.push({ name: 'IMF projection', color: s.color, dash: true });
    });
    legend($('#pick-legend'), items);
    lineChart($('#pick-chart'), series, { xType: 'year', f, labels: false, aria: d.meta.label });
    renderTable();
  }

  function tableRows() {
    const d = state.ind[state.pick];
    const wb = new Map(scaled(d.meta, d.wb).map((p) => [p[0], p[1]]));
    const imf = new Map((d.imf || []).map((p) => [p[0], p[1]]));
    const years = [...new Set([...wb.keys(), ...imf.keys()])].sort((a, b) => b - a);
    return years.map((y) => [y, wb.get(y), imf.get(y), y >= THIS_YEAR && imf.has(y)]);
  }

  function renderTable() {
    const host = $('#tbl');
    host.hidden = !state.showTable;
    $('#tbl-toggle').textContent = state.showTable ? 'Hide table' : 'Show table';
    if (!state.showTable) return;
    const d = state.ind[state.pick];
    const f = fmtFor(d.meta.unit);
    host.textContent = '';
    const t = el('table');
    const hr = el('tr');
    ['Year', 'World Bank', 'IMF WEO'].forEach((h) => hr.appendChild(el('th', null, h)));
    t.appendChild(el('thead')).appendChild(hr);
    const tb = el('tbody');
    tableRows().forEach(([y, a, b, p]) => {
      const tr = el('tr');
      tr.append(el('td', null, String(y)), el('td', null, a == null ? '—' : f.full(a)), el('td', null, b == null ? '—' : f.full(b) + (p ? ' (proj.)' : '')));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    host.appendChild(t);
  }

  function downloadCsv() {
    const d = state.ind[state.pick];
    const lines = [`year,worldbank_${d.meta.unit.replace(/\W+/g, '_')},imf_weo,imf_is_projection`];
    tableRows().reverse().forEach(([y, a, b, p]) => lines.push([y, a ?? '', b ?? '', b == null ? '' : p].join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `pakistan_${d.meta.id}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function renderTrade() {
    const ex = state.ind.exports, im = state.ind.imports;
    const f = fmtFor('US$ bn');
    const series = [
      { name: 'Exports', color: 'var(--s1)', pts: rangeFilter(scaled(ex.meta, ex.wb)) },
      { name: 'Imports', color: 'var(--s2)', pts: rangeFilter(scaled(im.meta, im.wb)) },
    ];
    legend($('#trade-legend'), series);
    lineChart($('#trade-chart'), series, { xType: 'year', f, labels: true, aria: 'Pakistan exports and imports, US$ bn' });
  }

  function miniCard(title, valueText, unitText, metaText, series, f, xType, onClick) {
    const c = el('div', 'mini');
    c.appendChild(el('div', 'lab', title));
    const v = el('div', 'val', valueText);
    if (unitText) v.appendChild(el('small', null, unitText));
    c.appendChild(v);
    c.appendChild(el('div', 'meta', metaText));
    const ch = el('div', 'chart');
    c.appendChild(ch);
    if (onClick) {
      c.tabIndex = 0;
      c.setAttribute('role', 'button');
      c.addEventListener('click', onClick);
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter') onClick(); });
    }
    return { card: c, draw: () => lineChart(ch, series, { xType, f, compact: true, aria: title }) };
  }

  function renderGrid() {
    const host = $('#grid');
    host.textContent = '';
    const draws = [];
    const groups = {};
    allIndicators().forEach((m) => (groups[m.group] = groups[m.group] || []).push(m));
    Object.keys(groups).forEach((g) => {
      groups[g].forEach((m) => {
        const d = state.ind[m.id];
        const f = fmtFor(m.unit);
        const wb = rangeFilter(scaled(m, d.wb));
        const imf = rangeFilter(d.imf || []);
        let series, L, src;
        if (wb.length) {
          L = last(wb); src = 'World Bank';
          series = [{ name: 'World Bank (actual)', color: 'var(--s1)', pts: wb }];
          const proj = state.proj ? imf.filter((p) => p[0] > L[0] && p[0] >= THIS_YEAR) : [];
          if (proj.length) series.push({ name: 'IMF projection', color: 'var(--s2)', pts: [], proj });
        } else {
          const act = imf.filter((p) => p[0] < THIS_YEAR);
          L = last(act); src = 'IMF WEO';
          series = [{ name: 'IMF WEO', color: 'var(--s2)', pts: act, proj: state.proj ? imf.filter((p) => p[0] >= THIS_YEAR) : [] }];
        }
        const open = () => { state.pick = m.id; $('#pick').value = m.id; renderExplorer(); $('#pick').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
        const mc = miniCard(`${g} · ${m.label}`, L ? f.full(L[1]) : '—', '', L ? `${L[0]} · ${src}` : 'No data', series, f, 'year', open);
        host.appendChild(mc.card);
        draws.push(mc.draw);
      });
    });
    draws.forEach((fn) => fn());
  }

  function renderSbp() {
    const sbp = state.snap && state.snap.sbp;
    const ids = sbp ? Object.keys(sbp.series || {}).filter((k) => (sbp.series[k] || []).length) : [];
    $('#sbp').hidden = !ids.length;
    if (!ids.length) return;
    const host = $('#sbp-grid');
    host.textContent = '';
    const draws = [];
    ids.forEach((k) => {
      const meta = sbp.meta[k] || {};
      const pts = sbp.series[k].map(([d, v]) => [Date.parse(d), v]).filter((p) => isFinite(p[0]));
      const f = fmtFor(meta.unit);
      const L = last(pts);
      const mc = miniCard(meta.label || k, L ? f.full(L[1]) : '—', '', L ? `${dateStr(L[0])} · ${meta.source || 'SBP'}` : 'No data',
        [{ name: meta.label || k, color: 'var(--s1)', pts }], f, 'date');
      host.appendChild(mc.card);
      draws.push(mc.draw);
    });
    draws.forEach((fn) => fn());
  }

  function renderStatus() {
    const host = $('#status');
    host.textContent = '';
    const icon = { ok: '✓', stale: '!', fail: '✕', load: '…' };
    ['worldbank', 'imf', 'fx'].forEach((k) => {
      const s = state.sources[k];
      if (!s) return;
      const p = el('span', 'pill ' + s.status);
      p.append(el('span', 'ic', icon[s.status]), el('span', null, s.text));
      if (s.detail) p.title = s.detail;
      host.appendChild(p);
    });
  }

  function renderAll() {
    renderKpis();
    renderFx();
    renderExplorer();
    renderTrade();
    renderGrid();
    renderSbp();
  }

  // ---------------------------------------------------------------- controls
  function buildPicker() {
    const sel = $('#pick');
    const groups = {};
    allIndicators().forEach((m) => (groups[m.group] = groups[m.group] || []).push(m));
    Object.keys(groups).forEach((g) => {
      const og = document.createElement('optgroup');
      og.label = g;
      groups[g].forEach((m) => {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.label;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = state.pick;
    sel.addEventListener('change', () => { state.pick = sel.value; renderExplorer(); });
    document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      state.range = b.dataset.range;
      renderExplorer(); renderTrade(); renderGrid();
    }));
    $('#proj').addEventListener('change', (e) => { state.proj = e.target.checked; renderExplorer(); renderGrid(); });
    $('#tbl-toggle').addEventListener('click', () => { state.showTable = !state.showTable; renderTable(); });
    $('#csv').addEventListener('click', downloadCsv);
    $('#refresh').addEventListener('click', refresh);
  }

  function initTheme() {
    const order = ['auto', 'light', 'dark'];
    let t = 'auto';
    try { t = localStorage.getItem('pk-theme') || 'auto'; } catch (e) { /* storage unavailable */ }
    const apply = () => {
      if (t === 'auto') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
      $('#theme').textContent = 'Theme: ' + t;
    };
    apply();
    $('#theme').addEventListener('click', () => {
      t = order[(order.indexOf(t) + 1) % order.length];
      try { localStorage.setItem('pk-theme', t); } catch (e) { /* ignore */ }
      apply();
    });
  }

  async function main() {
    initTheme();
    try { state.cfg = await getJSON('config.json'); } catch (e) {
      $('#status').textContent = 'Could not load config.json: ' + e.message;
      return;
    }
    try { state.snap = await getJSON('data.json?' + Date.now()); } catch (e) { state.snap = null; }
    seedFromSnapshot();
    buildPicker();
    renderAll();
    refresh();
  }

  main();
})();
