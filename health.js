// [H] Track health – the top layer of TMS Control (track-health chat, 19-Oct-2026; design: project doc claude/HWH_Track_Health_DESIGN.md).
// Part 1 = ENGINE (pure functions, no page access – also loaded by platform/test/t_health.mjs):
//   TMS Track Health Monitoring Chart files + GMT file  ->  200 m cells (TMS figures, labelled as TMS)
//   cells + records already in TMS Control (TRC peaks / blocks, USFD, OMS peaks, fractures, jobs …)  ->  signals, index, roll-ups.
// Part 2 = SCREENS (division health, line strip chart, cell card, admin "Track health data" page), drawn with the design system (ui.js tokens).
(function (root) {
'use strict';

// ======================================================================= ENGINE
const HE = (function () {
  const P = (km, m) => (+km || 0) * 10000 + (+m || 0);            // position: km*10000 + m (TMS km can be longer than 1000 m – no overlap)
  const kmOf = p => Math.floor(p / 10000), mOf = p => p - kmOf(p) * 10000;
  const cellOf = m => Math.max(0, Math.min(4, Math.floor((+m || 0) / 200)));   // 200 m cell in the km; cell 4 takes the rest of a long km
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const p2 = n => String(n).padStart(2, '0');
  const yy = (y, now) => { y = +y; if (y >= 100) return y; const c = (now || 2026) % 100; return y <= c + 1 ? 2000 + y : 1900 + y; };
  // 'Mar-25' / 'Feb-22 Dept. Machine' -> '2025-03'; '20251122-DTE' / '20260822' -> '2025-11-22'; '16/02/2025' or '09/04/26(B)' -> ISO
  function dateOf(s, now) {
    s = String(s == null ? '' : s).trim(); let m;
    if ((m = s.match(/^(\d{4})(\d\d)(\d\d)/))) return `${m[1]}-${m[2]}-${m[3]}`;
    if ((m = s.match(/^(\d\d?)\/(\d\d?)\/(\d{2,4})/))) return `${yy(m[3], now)}-${p2(m[2])}-${p2(m[1])}`;
    if ((m = s.match(/^([A-Za-z]{3})[a-z]*[-\s'](\d{2,4})/)) && MON[m[1].toLowerCase()]) return `${yy(m[2], now)}-${p2(MON[m[1].toLowerCase()])}`;
    return null;
  }
  const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : null; };
  const EMPTY = v => v == null || v === '' || v === '0' || v === '-' || v === 0;
  // a chart layer = [[span,…], [span,…]] (sub-rows) or [span,…]; span {locationfrom, meterfrom, locationto, meterto, railsection, railsecdesc}
  function subs(raw) {
    if (!raw) return [];
    if (raw.pieces) return subs([].concat(...raw.pieces.map(p => (Array.isArray(p.data) && Array.isArray(p.data[0]) ? p.data[0] : p.data) || [])));
    if (!Array.isArray(raw)) return [];
    return raw.length && Array.isArray(raw[0]) ? raw : [raw];
  }
  function spans(list, keepZero) {
    const out = [];
    for (const x of list || []) {
      if (!x || typeof x !== 'object') continue;
      let a = P(x.locationfrom, x.meterfrom), b = P(x.locationto, x.meterto);
      if (b < a) { const t = a; a = b; b = t; }
      const v = x.railsection, d = x.railsecdesc;
      if (!keepZero && EMPTY(v) && EMPTY(d)) continue;
      out.push([a, b, v == null ? '' : String(v), d == null ? '' : String(d)]);
    }
    return out.sort((p, q) => p[0] - q[0]);
  }
  // value of a span list over [c0,c1): the span covering most of it (dominant), or every overlapping one
  function over(list, c0, c1) { const r = []; for (const s of list) { if (s[0] >= c1) break; const o = Math.min(s[1], c1) - Math.max(s[0], c0); if (o > 0 || (s[0] === s[1] && s[0] >= c0 && s[0] < c1)) r.push([s, Math.max(o, 0)]); } return r; }
  function dom(list, c0, c1) { let best = null, bo = -1; for (const [s, o] of over(list, c0, c1)) if (o > bo) { best = s; bo = o; } return best; }

  // ---------- one TMS chart file (TMS Collector 'tmsChart') ----------
  function parseChart(f, N, now) {
    const sec = N.sectionName(f.section) || f.section, lk = N.lineKey(f.line) || f.line;
    const lid = `${N.sectionCode(sec)} ${N.lineDisplay(lk)}`;
    const L = f.layers || {}; const g = k => subs(L[k]); const s0 = (k, i = 0, z) => spans(g(k)[i], z);
    const D = {   // compact span lists for the strip chart: [a, b, value]
      rsL: s0('getRailSection_LR', 0), gdL: s0('getRailSection_LR', 1), roL: s0('getRailSection_LR', 2), lyL: s0('getRailSection_LR', 3), cgL: s0('getRailSection_LR', 4),
      rsR: s0('getRailSection_RR', 0), gdR: s0('getRailSection_RR', 1), roR: s0('getRailSection_RR', 2), lyR: s0('getRailSection_RR', 3), cgR: s0('getRailSection_RR', 4),
      gy: s0('getTrafficDensity'), lt: s0('getLastTamping'), frm: s0('getMachineTamping_FRM'), bcm: s0('getMachineTamping_BCM'),
      trr: s0('getTRRRenewal'), tsr: s0('getTSRRenewal'), tfr: s0('getTFRRenewal'), tbr: s0('getTBRRenewal'), tftr: s0('getTFTRRenewal'), twr: s0('getTWRRenewal'), isd: s0('getISDRenewal'),
      cush: s0('getBallast', 0), ds: s0('getBallast', 1), bal: s0('getBallast', 2), slT: s0('getSleeper', 0), slD: s0('getSleeper', 1), slY: s0('getSleeper', 2),
      fF: s0('getFasteningMstDtl_F'), fR: s0('getFasteningMstDtl_R'), fL: s0('getFasteningMstDtl_L'),
      wf: s0('getWeekFormation'), cl: s0('getCriticalLocation'), sr: s0('getSpeedRestriction'),
      utL: s0('getUSFDRailTesting_LR'), utR: s0('getUSFDRailTesting_RR'), cv: s0('getCurve'), br: s0('getBridge'), lwL: s0('getLwrSwrFwp_LR'), lwR: s0('getLwrSwrFwp_RR'), dst: s0('getLwrDestressingDate')
    };
    // extent of the line: every span of every layer (the section's authority range)
    let a = Infinity, b = -Infinity;
    for (const k in L) for (const sub of subs(L[k])) for (const x of sub || []) { if (!x || x.locationfrom == null) continue; const p = P(x.locationfrom, x.meterfrom), q = P(x.locationto, x.meterto); if (/^getFracture/.test(k)) continue; a = Math.min(a, p, q); b = Math.max(b, p, q); }
    if (!isFinite(a)) { a = P(f.kmFrom, 0); b = P(f.kmTo, 0); }
    // TMS track geometry index per km, last three runs: 'A~84~1~09/04/26(B)~87~13/12/25(c)~72~22/01/25(b)'
    const tg = [];
    for (const x of subs(L.getTRCTgi)[0] || []) {
      const p = String(x.railsection || '').split('~'); if (p.length < 4 || EMPTY(p[1])) continue;
      const runs = []; for (const [vi, di] of [[1, 3], [4, 5], [6, 7]]) { const v = num(p[vi]); if (v == null) continue; const dd = dateOf(p[di], now); runs.push([v, dd, (String(p[di] || '').match(/\(([A-Za-z])\)/) || [])[1] || '']); }
      if (runs.length) tg.push([+x.locationfrom, p[0], runs]);
    }
    // USFD defects per km 'km#count'; fractures this year / last year / the year before 'Weld~id~RR~16/02/2025~7~558'
    const ud = {}; for (const x of subs(L.getUSFDDefectDtl)[0] || []) { const q = String(x.railsection || '').split('#'); if (q.length === 2 && +q[1] > 0) ud[+q[0]] = +q[1]; }
    const fr = []; for (const k of ['getFractureDetails_0', 'getFractureDetails_1', 'getFractureDetails_2']) for (const x of subs(L[k])[0] || []) { const q = String(x.railsection || '').split('~'); if (q.length >= 6) fr.push([q[0], q[2], dateOf(q[3], now), +q[4], +q[5], q[1]]); }
    // ---- 200 m cells
    const cells = [];
    for (let km = kmOf(a); km <= kmOf(b); km++) {
      for (let ci = 0; ci < 5; ci++) {
        const c0 = P(km, ci * 200), c1 = ci < 4 ? P(km, ci * 200 + 200) : P(km + 1, 0);
        if (c1 <= a || c0 >= b) continue;
        const v = (list, f2) => { const s = dom(list, c0, c1); return s ? (f2 ? f2(s[2], s[3]) : s[2]) : null; };
        const any = (list) => over(list, c0, c1).map(z => z[0]);
        const laid = [v(D.lyL, x => dateOf(x, now)), v(D.lyR, x => dateOf(x, now))].filter(Boolean).sort()[0] || null;
        const cg = Math.max(-1, ...[v(D.cgL, num), v(D.cgR, num)].filter(x => x != null));
        const ut = [v(D.utL, x => dateOf(x, now)), v(D.utR, x => dateOf(x, now))].filter(Boolean).sort()[0] || null;
        const srs = any(D.sr).map(s => num(s[2])).filter(x => x > 0);
        const lt = dom(D.lt, c0, c1); const ltd = lt ? String(lt[2]).split('-') : null;
        let rn = null; for (const [k, nm] of [['trr', 'TRR'], ['tsr', 'TSR'], ['tfr', 'TFR'], ['tbr', 'TBR'], ['tftr', 'TFTR'], ['twr', 'TWR'], ['isd', 'ISD']]) { const s = dom(D[k], c0, c1); if (!s) continue; const y = (String(s[2]).match(/(\d\d)-(\d\d)$/) || [])[1]; if (y && (!rn || +y > rn[1])) rn = [nm + ' ' + String(s[2]).replace(/^\d+\//, ''), +y]; }
        const cl = any(D.cl).map(s => s[2] || s[3]).filter(x => !EMPTY(x));
        const cv = any(D.cv).map(s => String(s[2]).split('$')[0]).filter(x => !EMPTY(x));
        const br = any(D.br).map(s => String(s[2]).split('$')[0]).filter(x => !EMPTY(x));
        const lw = v(D.lwL, (x, d) => d || String(x).charAt(0));
        cells.push([km, ci, v(D.rsL) || v(D.rsR), v(D.gdL) || v(D.gdR), laid, cg >= 0 ? cg : null, v(D.gy, x => num(x)),
          ltd && ltd[0] ? dateOf(ltd[0], now) : null, ltd && ltd[1] ? ltd[1] : null, v(D.ds, x => dateOf(x, now)),
          any(D.wf).some(s => s[2] === '1') ? 1 : 0, cl.length ? cl.join(', ') : null, srs.length ? Math.min(...srs) : null, ut,
          cv.length ? [...new Set(cv)].join(',') : null, br.length ? [...new Set(br)].join(',') : null, lw || null, rn ? rn[0] : null, v(D.slT)]);
      }
    }
    const det = {}; for (const k in D) det[k] = D[k].map(s => s[3] && s[3] !== s[2] ? [s[0], s[1], s[2], s[3]] : [s[0], s[1], s[2]]);
    return { meta: { lid, sec, line: f.line, lk, rc: f.sectionCode || '', lc: f.lineCode || '', a, b, at: f.fetchedAt || '' }, cells, tg, ud, fr, det };
  }
  // cell array -> object
  const CF = ['km', 'ci', 'rs', 'rg', 'rl', 'cg', 'gy', 'lt', 'lm', 'ds', 'wf', 'cl', 'sr', 'ut', 'cv', 'br', 'lw', 'rn', 'sl'];
  const cellObj = a => { const o = {}; CF.forEach((k, i) => { o[k] = a[i]; }); return o; };

  // ---------- GMT file (TMS Collector 'gmt'): GMT per section / line / km stretch / year ----------
  function parseGmt(f, N) {
    const by = {};
    for (const r of f.records || []) {
      if (r.gmt == null || r.fromKm == null || r.toKm == null) continue;
      const sec = N.sectionName(r.section) || r.section, lk = N.lineKey(r.line) || r.line; const lid = `${N.sectionCode(sec)} ${N.lineDisplay(lk)}`;
      (by[lid] = by[lid] || []).push([r.finYear, P(r.fromKm, r.fromM), P(r.toKm, r.toM), +r.gmt, r.source === 'Auto' ? 'A' : 'M']);
    }
    for (const k in by) by[k].sort((p, q) => String(p[0]).localeCompare(String(q[0])) || p[1] - q[1]);
    return { at: f.asOn || '', fullOn: f.fullOn || '', years: f.years || [], by };
  }

  // ---------- the whole set -> the stored document (cells, small) + one detail per line (strip chart) ----------
  function buildDoc(charts, gmt, N, now) {
    const lines = [], details = {}; const seen = {};
    for (const f of charts) {
      const r = parseChart(f, N, now);
      if (seen[r.meta.lid]) continue; seen[r.meta.lid] = 1;   // the same line twice: first file wins (files are named by section + line)
      lines.push(Object.assign({}, r.meta, { c: r.cells, t: r.tg, u: r.ud, f: r.fr }));
      details[r.meta.lid] = { lid: r.meta.lid, meta: r.meta, det: r.det, gmt: gmt && gmt.by[r.meta.lid] || [] };
    }
    lines.sort((p, q) => p.lid.localeCompare(q.lid));
    const at = charts.map(f => f.fetchedAt || '').sort().pop() || '';
    return { doc: { v: 1, at, gmtAt: gmt ? gmt.at : '', cf: CF, lines }, details, gmtLines: gmt ? Object.keys(gmt.by).length : 0 };
  }

  // ---------- rules (Settings HEALTH_RULES; defaults to be confirmed by the user – IRPWM / RDSO figures where they exist) ----------
  const RULES = {
    w: { geo: 30, ride: 15, rail: 20, weld: 15, struct: 10, assets: 5, attn: 5 }, cap: 40,           // confirmed by the user 16-Oct
    score: { Good: 100, Watch: 70, Act: 40, Urgent: 10 },
    tgi: { watch: 80, act: 50, urgent: 36 },          // TMS track geometry index (TGI) per km: below 80 Watch, below 50 Act, below 36 Urgent
    tgiDrop: 10,                                      // TGI fell by this much since the run before: shown as falling
    peak: { UML: 'Urgent', NBML: 'Act' }, blockRisk: 0.85,
    oms: { watch: 0.15, act: 0.20, urgent: 0.30 },    // OMS peak acceleration (g)
    life: { '04': 800, '03': 525 }, lifeWatch: 0.9,   // rail life in GMT by TMS rail-section code (04 = 60 kg, 03 = 52 kg)
    usfdDays: 365, fractMonths: 12, dsYears: 10
  };
  const LV = ['Good', 'Watch', 'Act', 'Urgent']; const lvi = s => LV.indexOf(s);
  const worse = (a, b) => (a == null ? b : b == null ? a : lvi(b) > lvi(a) ? b : a);
  const SIG = [['geo', 'Geometry'], ['ride', 'Ride'], ['rail', 'Rail'], ['weld', 'Welds'], ['struct', 'Track structure'], ['assets', 'Special assets'], ['attn', 'Attention']];
  const addM = (iso, months) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(String(a).slice(0, 10).padEnd(10, '-01').replace(/-$/, '') + 'T00:00:00Z')) / 864e5);
  const isoD = s => { s = String(s || ''); return s.length === 7 ? s + '-01' : s.slice(0, 10); };

  // sig (server 'healthData'): peaks [lid,km,m,param,value,status,run,day], blocks [lid,km,block,irpwm,mi,risk,tqic,run,day],
  //   items [lid,km,m,kind,sub,status,date,value], fract [lid,km,m,type,date], jobs [lid,km,m,type,overdue,prio,id,title], has {usfd,omspeak,trc}
  function evaluate(doc, sig, rules, today, units) {
    const R = Object.assign({}, RULES, rules || {}); for (const k of ['w', 'score', 'tgi', 'peak', 'oms', 'life']) R[k] = Object.assign({}, RULES[k], (rules || {})[k] || {});
    sig = sig || {}; today = today || new Date().toISOString().slice(0, 10);
    const key = (lid, km, ci) => lid + '|' + km + '|' + ci;
    const at = {}; const put = (lid, km, m, o) => { const k = key(lid, +km, cellOf(m)); (at[k] = at[k] || []).push(o); };
    // TRC: per km only the newest run counts
    const newest = {}; const nk = (lid, km) => lid + '|' + km;
    for (const p of sig.peaks || []) { const k = nk(p[0], p[1]); if (!newest[k] || String(p[7] || '') > newest[k]) newest[k] = String(p[7] || ''); }
    for (const b of sig.blocks || []) { const k = nk(b[0], b[1]); if (!newest[k] || String(b[8] || '') > newest[k]) newest[k] = String(b[8] || ''); }
    for (const p of sig.peaks || []) if (String(p[7] || '') === newest[nk(p[0], p[1])]) put(p[0], p[1], +p[2] - +p[1] * 1000, { t: 'peak', p });   // TRCPeaks.Pos = km*1000 + m
    for (const b of sig.blocks || []) if (String(b[8] || '') === newest[nk(b[0], b[1])]) { const k = key(b[0], +b[1], Math.max(0, Math.min(4, (+b[2] || 1) - 1))); (at[k] = at[k] || []).push({ t: 'block', b }); }
    for (const i of sig.items || []) put(i[0], i[1], i[2], { t: 'item', i });
    for (const f of sig.fract || []) put(f[0], f[1], f[2], { t: 'fract', f });
    for (const j of sig.jobs || []) put(j[0], j[1], j[2], { t: 'job', j });
    const segs = (units || []).map(u => ({ unit: u.unit, lid: u.lid, a: Math.min(+u.a, +u.b), b: Math.max(+u.a, +u.b) }));
    const unitOf = (lid, km, ci) => { const pos = km * 1000 + ci * 200 + 100; for (const s of segs) if (s.lid === lid && pos >= s.a && pos < s.b) return s.unit; return ''; };
    const fractSince = addM(today, -R.fractMonths);
    const out = [];
    (doc.lines || []).forEach((L, li) => {
      const tgk = {}; for (const t of L.t || []) tgk[t[0]] = t;
      const ffr = {}; for (const x of L.f || []) { const k = x[3] + '|' + cellOf(x[4]); (ffr[k] = ffr[k] || []).push(x); }
      for (const a of L.c || []) {
        const c = cellObj(a); const st = {}, why = {}; const add = (s, lv, txt) => { st[s] = worse(st[s], lv); if (txt) (why[s] = why[s] || []).push([lv, txt]); };
        const here = at[key(L.lid, c.km, c.ci)] || [];
        // geometry: TMS TGI of the km (TMS figure) + peaks / blocks of the newest TRC run in this 200 m
        const t = tgk[c.km];
        if (t && t[2][0]) {
          const [v, d] = t[2][0]; const prev = t[2][1];
          const lv = v < R.tgi.urgent ? 'Urgent' : v < R.tgi.act ? 'Act' : v < R.tgi.watch ? 'Watch' : 'Good';
          add('geo', lv, `TMS TGI ${v} on km ${c.km}${d ? ' (run ' + d + ')' : ''}${prev && prev[0] - v >= R.tgiDrop ? `, falling from ${prev[0]}` : ''}`);
        }
        for (const h of here) {
          if (h.t === 'peak') { const p = h.p; const lv = R.peak[p[5]]; if (lv) add('geo', lv, `${p[5]} peak ${p[3]} ${p[4]} at ${p[1]}/${Math.round(+p[2] - +p[1] * 1000)} (run ${p[6]})`); }
          if (h.t === 'block') { const b = h.b; if (b[3] === 'N') add('geo', 'Act', `block ${b[1]}/${b[2]} beyond CBML (run ${b[7]})`); else if (b[4] === 'N') add('geo', 'Act', `block ${b[1]}/${b[2]} MI beyond limit (run ${b[7]})`); else if (+b[5] >= R.blockRisk) add('geo', 'Watch', `block ${b[1]}/${b[2]} at risk ${(+b[5]).toFixed(2)} (run ${b[7]})`); }
        }
        if (st.geo == null && (t || (sig.has && sig.has.trc && sig.has.trc[L.lid]))) st.geo = 'Good';
        // ride: OMS peaks (open in TMS) in this 200 m
        for (const h of here) if (h.t === 'item' && h.i[3] === 'OMSPEAK') { const g = +h.i[7]; const lv = g >= R.oms.urgent ? 'Urgent' : g >= R.oms.act ? 'Act' : g >= R.oms.watch ? 'Watch' : null; if (lv) add('ride', lv, `OMS peak ${g} g${h.i[4] ? ' ' + h.i[4] : ''}${h.i[6] ? ' (' + h.i[6] + ')' : ''}`); }
        if (st.ride == null && sig.has && sig.has.omspeak) st.ride = 'Good';
        // rail: USFD rail defects, fractures, GMT carried vs rail life (TMS), last USFD test (TMS)
        for (const h of here) {
          if (h.t === 'item' && h.i[3] === 'USFD' && h.i[4] === 'RAIL') { const s = String(h.i[5] || '').toUpperCase(); const lv = /^IMR/.test(s) ? 'Urgent' : 'Watch'; add('rail', lv, `USFD rail defect ${s || '?'} at ${h.i[1]}/${h.i[2]}`); }
          if (h.t === 'fract' && String(h.f[4] || '') >= fractSince) add(/WELD/i.test(h.f[3]) ? 'weld' : 'rail', 'Act', `${/WELD/i.test(h.f[3]) ? 'weld' : 'rail'} fracture ${h.f[4]} at ${h.f[1]}/${h.f[2]}`);
        }
        for (const x of ffr[c.km + '|' + c.ci] || []) if (x[2] && x[2] >= fractSince) add(/weld/i.test(x[0]) ? 'weld' : 'rail', 'Act', `TMS: ${String(x[0]).toLowerCase()} fracture ${x[2]} ${x[1]} at ${x[3]}/${x[4]}`);
        const life = R.life[c.rs];
        if (c.cg != null && life) { const f = c.cg / life; if (f >= 1) add('rail', 'Act', `rail has carried ${c.cg} GMT – life ${life} GMT reached (TMS)`); else if (f >= R.lifeWatch) add('rail', 'Watch', `rail has carried ${c.cg} of ${life} GMT (TMS)`); }
        if (c.ut && daysBetween(c.ut, today) > R.usfdDays) add('rail', 'Watch', `last USFD test ${c.ut} (TMS) – over ${R.usfdDays} days`);
        if (st.rail == null && (c.cg != null || c.ut || c.rl)) st.rail = 'Good';
        // welds: USFD weld defects, DFWR, untested AT welds, joggled, O&G overdue
        for (const h of here) if (h.t === 'item') {
          const k = h.i[3], s = String(h.i[5] || '').toUpperCase();
          if (k === 'USFD' && h.i[4] === 'WELD') add('weld', /^IMR/.test(s) ? 'Urgent' : /^DFW/.test(s) ? 'Act' : 'Watch', `USFD weld defect ${s || '?'} at ${h.i[1]}/${h.i[2]}`);
          if (k === 'DFWR') add('weld', 'Act', `DFWR weld at ${h.i[1]}/${h.i[2]}`);
          if (k === 'UNTESTED') add('weld', 'Watch', `AT weld not yet USFD tested at ${h.i[1]}/${h.i[2]}`);
          if (k === 'JOG') add('weld', 'Watch', `joggled fish-plated weld at ${h.i[1]}/${h.i[2]}`);
          if (k === 'OG') add('weld', 'Watch', `oiling & greasing overdue at ${h.i[1]}/${h.i[2]}`);
        }
        if (st.weld == null && sig.has && sig.has.usfd) st.weld = 'Good';
        // track structure: deep screening age, weak formation, critical location (TMS)
        if (c.ds) { const yrs = daysBetween(c.ds, today) / 365.25; if (yrs > R.dsYears) add('struct', 'Watch', `deep screened ${c.ds} (TMS) – ${Math.floor(yrs)} years ago`); }
        if (c.wf) add('struct', 'Watch', 'weak formation (TMS)');
        if (c.cl) add('struct', 'Watch', `critical location: ${c.cl} (TMS)`);
        if (st.struct == null && (c.ds || c.sl)) st.struct = 'Good';
        // attention: open jobs here, LNA, speed restriction in force
        for (const h of here) {
          if (h.t === 'job') { const j = h.j; add('attn', j[4] ? 'Act' : +j[5] === 1 ? 'Act' : 'Watch', `job ${j[6]} ${j[3]}${j[4] ? ' – overdue' : ''}`); }
          if (h.t === 'item' && h.i[3] === 'LNA') add('attn', 'Watch', `location needing attention${h.i[6] ? ' (' + h.i[6] + ')' : ''}`);
        }
        if (c.sr) add('attn', 'Watch', `speed restriction ${c.sr} km/h (TMS)`);
        if (st.attn == null) st.attn = 'Good';
        // combined index: weighted score of the signals that have data; any Urgent caps it
        let sw = 0, ss = 0, lvl = null;
        for (const [k] of SIG) { if (st[k] == null) continue; sw += R.w[k] || 0; ss += (R.w[k] || 0) * R.score[st[k]]; lvl = worse(lvl, st[k]); }
        let idx = sw ? ss / sw : null; if (idx != null && lvl === 'Urgent') idx = Math.min(idx, R.cap);
        out.push({ li, lid: L.lid, km: c.km, ci: c.ci, c, unit: unitOf(L.lid, c.km, c.ci), st, why, idx: idx == null ? null : Math.round(idx), lvl });
      }
    });
    return out;
  }
  function rollup(cells, by) {
    const g = {};
    for (const x of cells) { const k = by(x); if (k == null) continue; const o = g[k] = g[k] || { key: k, n: 0, sum: 0, cnt: 0, Good: 0, Watch: 0, Act: 0, Urgent: 0 }; o.n++; if (x.idx != null) { o.sum += x.idx; o.cnt++; } if (x.lvl) o[x.lvl]++; }
    return Object.values(g).map(o => Object.assign(o, { idx: o.cnt ? Math.round(o.sum / o.cnt) : null, km: +(o.n * 0.2).toFixed(1) }));
  }
  return { P, kmOf, mOf, cellOf, dateOf, parseChart, parseGmt, buildDoc, evaluate, rollup, RULES, LV, SIG, CF, cellObj, worse };
})();
root.HEALTH_ENGINE = HE;
if (typeof module !== 'undefined' && module.exports) module.exports = HE;

// ======================================================================= SCREENS
if (typeof document === 'undefined' || !root.TMSC || !root.TMSC_VIEWS) return;
const T = root.TMSC, V = root.TMSC_VIEWS; const { call, esc, dmy, modal, toast, S, $ } = T;
const UI = root.UI;
const B = s => UI ? UI.bi(s) : { p: s, s: '' };
const tt = s => UI ? UI.t(s) : s;
const lab = s => { const b = B(s); return `${esc(b.p)}${b.s ? ` <span class="small" style="font-weight:500;opacity:.8">· ${esc(b.s)}</span>` : ''}`; };
const ring = (v, max, o) => UI ? UI.ring(v, max, o) : (v == null ? '—' : v);
const head = (t, c, x) => T.pageHead ? T.pageHead(t, c, x) : `<h1>${esc(t)}</h1>`;
if (UI && UI.HI) Object.assign(UI.HI, {   // [H] Hindi words for the track-health screens
  'Track health': 'रेलपथ स्वास्थ्य', 'Track health data': 'रेलपथ स्वास्थ्य डेटा', 'Line chart': 'लाइन चार्ट', 'Health index': 'स्वास्थ्य सूचकांक',
  'Good': 'ठीक', 'Watch': 'निगरानी', 'Act': 'कार्रवाई', 'Urgent': 'तत्काल', 'Geometry': 'ज्यामिति', 'Ride': 'राइड', 'Rail': 'रेल', 'Welds': 'वेल्ड',
  'Track structure': 'रेलपथ संरचना', 'Special assets': 'विशेष परिसंपत्तियाँ', 'Attention': 'ध्यान', 'Section-lines': 'खंड-लाइनें', 'Weakest stretches': 'सबसे कमज़ोर हिस्से',
  'Units': 'इकाइयाँ', 'TMS figures': 'टीएमएस आँकड़े', 'Index': 'सूचकांक'
});
const LVC = { Good: 'var(--ok)', Watch: 'var(--caut)', Act: 'var(--warn)', Urgent: 'var(--crit)' };
const WOP = .42;   // Watch = a pale shade of its colour, so it stands apart from Act (amber) in bars and charts
const bgS = lv => lv ? `background:${LVC[lv]}${lv === 'Watch' ? ';opacity:' + WOP : ''}` : 'background:var(--fill)';
const LVB = { Good: 'var(--okbg)', Watch: 'var(--cautbg)', Act: 'var(--warnbg)', Urgent: 'var(--critbg)' };
const tag = lv => lv ? `<span class="tag" style="background:${LVB[lv]};color:${LVC[lv]}">${esc(tt(lv))}</span>` : '<span class="tag" style="background:var(--fill);color:var(--muted)">no data</span>';
const css = document.createElement('style');
css.textContent = `.hstrip{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--fill);min-width:120px}
.hstrip i{display:block;height:100%;flex:1 1 0}
.hlines{display:grid;gap:2px}
.hline{display:grid;grid-template-columns:minmax(150px,230px) 1fr 54px;gap:12px;align-items:center;padding:9px 14px;border:0;background:none;text-align:left;font:inherit;color:inherit;cursor:pointer;border-radius:12px}
.hline:hover,.hline:focus-visible{background:var(--fill)}
.hline .n{font-weight:600}.hline .k{font-size:12px;color:var(--sub)}
.hchart{display:flex;border-top:1px solid var(--line2)}
.hchart .labs{flex:none;width:170px;border-right:1px solid var(--line2);background:var(--surface);position:sticky;left:0;z-index:1}
.hchart .labs div,.hchart .rowl{height:22px;line-height:22px;font-size:12px;padding:0 10px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hchart .labs .grp{color:var(--ink);font-weight:600;background:var(--fill)}
.hchart .sc{overflow-x:auto;flex:1 1 auto}
.hchart svg text{font-size:10px;fill:var(--ink)}
.hchart svg .tick{fill:var(--sub)}
.hchart svg rect.c{cursor:pointer}
.hleg{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--sub);padding:10px 18px}
.hleg i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:5px}
.hcard table{width:100%;border-collapse:collapse}.hcard td,.hcard th{padding:6px 8px;border-bottom:1px solid var(--line2);text-align:left;vertical-align:top;font-size:13px}
.hcard ul{margin:0;padding-left:16px}
@media (max-width:640px){.hline{grid-template-columns:1fr 46px}.hline .hstrip{grid-column:1 / span 2;grid-row:2}.hchart .labs{width:104px}}`;
document.head.appendChild(css);

// ---------- menu: Track health first for officers, after "My work" for JE / SSE; data page for the admin ----------
const NV = T.NAVS || {};
for (const r of Object.keys(NV)) {
  const N = NV[r]; if (N.some(x => x[0] === 'health')) continue;
  const at = (r === 'JE' || r === 'SSE') ? 1 : 0; N.splice(at, 0, ['health', 'Track health']);
  if (r === 'ADMIN') { const i = N.findIndex(x => x[0] === 'upload'); N.splice(i >= 0 ? i + 1 : N.length, 0, ['healthdata', 'Track health data']); }
}

// ---------- data ----------
const H = { d: null, ev: null, loading: null, lines: {}, line: null };
function rulesNow() { return (H.d && H.d.rules) || {}; }
async function load(force) {
  if (H.loading) return H.loading;
  H.loading = (async () => {
    try {
      const d = await call('healthData', {}, { cache: true, timeout: 240000 });
      const doc = d.cells ? JSON.parse(d.cells) : null;
      H.d = Object.assign({}, d, { doc }); H.ev = doc ? HE.evaluate(doc, d.sig, d.rules, d.today, d.units) : [];
      H.unitOf = Object.fromEntries((d.units || []).map(u => [u.unit, u]));
    } finally { H.loading = null; }
  })();
  return H.loading;
}
const wide = () => ['ADMIN', 'SRDENC', 'VIEWER'].includes(T.role());
const myUnits = () => new Set((S.B.units || []).map(u => u.unit));
function inScope(x) { if (S.unit !== '__all') return x.unit === S.unit; if (wide()) return true; return myUnits().has(x.unit); }
const lineName = L => `${L.sec} · ${L.line}`;
const where = x => `${x.lid} km ${x.km} / ${x.ci * 200}–${x.ci < 4 ? x.ci * 200 + 200 : 'end'} m`;
function mainWhy(x) { if (!x.lvl) return ''; for (const [k] of HE.SIG) { const w = (x.why[k] || []).filter(z => z[0] === x.lvl); if (w.length) return `${tt(HE.SIG.find(s => s[0] === k)[1])}: ${w[0][1]}`; } return ''; }

// the admin's Version check banner (report-engine chat) – shown on Track health too, which is the admin's first screen
const vban = () => T.role() === 'ADMIN' && T.versionBanner ? '<div id="vbanner"></div>' : '';
const vbanGo = () => { if (T.role() === 'ADMIN' && T.versionBanner && $('vbanner')) T.versionBanner().catch(() => { }); };
function emptyState(el, title) {
  const adm = T.role() === 'ADMIN';
  el.innerHTML = head(title || 'Track health', T.scopeText ? T.scopeText() : '') + vban() + `<div class="panel"><div class="inner" style="padding:22px">
    <p><b>No track-health data yet.</b></p><p class="small">${adm ? 'Open <a href="#" id="hgo">Track health data</a> and load the files from <code>TMS KPI\\Track health monitoring\\TMS data</code> (TMS chart data of every section-line and the GMT file, saved by the TMS Collector).' : 'The admin loads the TMS chart data. Ask the admin to open "Track health data".'}</p></div></div>`;
  const a = el.querySelector('#hgo'); if (a) a.onclick = e => { e.preventDefault(); S.view = 'healthdata'; T.render(); };
  vbanGo();
}

// ---------- division / unit health ----------
V.health = async el => {
  if (!H.d) { el.innerHTML = head('Track health') + vban() + '<div class="busy"><div class="eyebrow">Loading</div><h2>Track health…</h2><div class="bar"><div style="width:50%"></div></div></div>'; vbanGo(); try { await load(); } catch (e) { T.fail ? T.fail(e) : toast(e.error || String(e), true); return; } if (S.view !== 'health') return; }
  if (!H.d.doc) return emptyState(el);
  const C = H.ev.filter(inScope); const D = H.d.doc; const m = H.d.meta || {};
  const n = C.length, km = (n * 0.2).toFixed(1); const by = { Good: 0, Watch: 0, Act: 0, Urgent: 0 }; let sum = 0, cnt = 0;
  for (const x of C) { if (x.lvl) by[x.lvl]++; if (x.idx != null) { sum += x.idx; cnt++; } }
  const avg = cnt ? Math.round(sum / cnt) : null;
  const card = (cls, l, v, s) => { const b = B(l); return `<div class="kpi ${cls}"><div class="l">${esc(b.p)}</div>${b.s ? `<div class="lh">${esc(b.s)}</div>` : ''}<div class="v">${v}</div><div class="s">${s}</div></div>`; };
  const kmOf = k => (by[k] * 0.2).toFixed(1) + ' km';
  // lines in scope, in TMS order
  const lineIdx = {}; C.forEach(x => { (lineIdx[x.li] = lineIdx[x.li] || []).push(x); });
  const lines = Object.keys(lineIdx).map(Number).map(li => ({ L: D.lines[li], cells: lineIdx[li] })).sort((p, q) => p.L.sec.localeCompare(q.L.sec) || p.L.line.localeCompare(q.L.line));
  const strip = cells => `<span class="hstrip" aria-hidden="true">${cells.map(x => `<i style="${bgS(x.lvl)}"></i>`).join('')}</span>`;
  const lavg = cells => { const v = cells.filter(x => x.idx != null); return v.length ? Math.round(v.reduce((a, x) => a + x.idx, 0) / v.length) : null; };
  // units (when more than one in scope)
  const U = HE.rollup(C, x => x.unit || null).sort((p, q) => (p.idx ?? 999) - (q.idx ?? 999));
  const worst = C.filter(x => x.idx != null && (x.lvl === 'Urgent' || x.lvl === 'Act')).sort((p, q) => p.idx - q.idx || (q.lvl === 'Urgent') - (p.lvl === 'Urgent')).slice(0, 40);
  el.innerHTML = head('Track health', T.scopeText ? T.scopeText() : '', `<span class="small" style="color:var(--sub)">TMS chart data of ${dmy(String(m.chartAt || '').slice(0, 10))}${m.gmtAt ? ' · GMT ' + dmy(m.gmtAt) : ''}</span>`) + vban() +
    `<div class="ovtop"><div class="hero">${ring(avg, 100, { size: 132, stroke: 14, sub: 'of 100' })}<div><div class="ht">${lab('Health index')}</div><div class="hh">${n ? km + ' km of track' : 'No track in your charge'}</div><div class="hs">${n} cells of 200 m · weighted from geometry, ride, rail, welds, track structure and attention; any Urgent signal caps a cell at ${(rulesNow().cap || HE.RULES.cap)}</div></div></div>` +
    `<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">${card('ok', 'Good', kmOf('Good'), by.Good + ' cells')}${card('', 'Watch', kmOf('Watch'), by.Watch + ' cells')}${card(by.Act ? 'warn' : 'ok', 'Act', kmOf('Act'), by.Act + ' cells')}${card(by.Urgent ? 'crit' : 'ok', 'Urgent', kmOf('Urgent'), by.Urgent + ' cells')}</div></div>` +
    (U.length > 1 ? `<div class="h2row"><h2>${lab('Units')}</h2></div><div class="ucards">${U.map(o => `<button type="button" class="ucard" data-u="${esc(o.key)}"><div class="uh">${ring(o.idx, 100, { size: 54 })}<div style="min-width:0"><div class="un">${esc(o.key)}</div><div class="us">${esc((H.unitOf[o.key] || {}).label || '')} · ${o.km} km</div></div></div><div class="uf"><div><b class="${o.Urgent ? 'c' : ''}">${o.Urgent}</b>${esc(tt('Urgent'))}</div><div><b>${o.Act}</b>${esc(tt('Act'))}</div><div><b>${o.Watch}</b>${esc(tt('Watch'))}</div><div><b>${o.Good}</b>${esc(tt('Good'))}</div></div></button>`).join('')}</div>` : '') +
    `<div class="panel"><div class="panelhead">${lab('Section-lines')} <span class="small" style="font-weight:400;color:var(--sub)">· each bar is the line from start to end, one colour per 200 m · open a line for its chart</span></div><div class="hlines" style="padding:6px">${lines.map(o => `<button type="button" class="hline" data-l="${esc(o.L.lid)}"><span><span class="n">${esc(lineName(o.L))}</span><br><span class="k">${esc(o.L.lid)} · km ${HE.kmOf(o.L.a)}–${HE.kmOf(o.L.b)} · ${(o.cells.length * 0.2).toFixed(1)} km</span></span>${strip(o.cells)}<span>${ring(lavg(o.cells), 100, { size: 40 })}</span></button>`).join('') || '<div class="empty">No section-line in your charge has TMS chart data.</div>'}</div>
    <div class="hleg">${['Good', 'Watch', 'Act', 'Urgent'].map(l => `<span><i style="${bgS(l)}"></i>${esc(tt(l))}</span>`).join('')}<span><i style="background:var(--fill)"></i>no data</span></div></div>` +
    `<div class="panel"><div class="panelhead">${lab('Weakest stretches')} <span class="small" style="font-weight:400;color:var(--sub)">· Act and Urgent cells, lowest index first</span></div>${worst.length ? `<div class="scroll"><table class="t"><thead><tr><th>Location</th><th>Unit</th><th>Index</th><th>Level</th><th>Main reason</th></tr></thead><tbody>${worst.map((x, i) => `<tr data-c="${i}" style="cursor:pointer"><td>${esc(where(x))}</td><td>${esc(x.unit || '—')}</td><td><b>${x.idx}</b></td><td>${tag(x.lvl)}</td><td class="small">${esc(mainWhy(x))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty" style="padding:18px">No cell at Act or Urgent.</div>'}</div>`;
  el.querySelectorAll('.ucard[data-u]').forEach(b => b.onclick = () => { S.unit = b.dataset.u; if ($('selUnit')) $('selUnit').value = S.unit; T.render(); });
  el.querySelectorAll('.hline[data-l]').forEach(b => b.onclick = () => { H.line = b.dataset.l; S.view = 'healthline'; T.render(); root.scrollTo(0, 0); });
  el.querySelectorAll('tr[data-c]').forEach(tr => tr.onclick = () => cellCard(worst[+tr.dataset.c]));
  vbanGo();
};

// ---------- one section-line: strip chart (km along; one band per signal, then the TMS figures) ----------
V.healthline = async el => {
  if (!H.d) { el.innerHTML = '<div class="busy"><h2>Loading…</h2></div>'; try { await load(); } catch (e) { T.fail ? T.fail(e) : toast(e.error || String(e), true); return; } if (S.view !== 'healthline') return; }
  if (!H.d.doc) return emptyState(el, 'Line chart');
  const C = H.ev.filter(inScope); const lids = [...new Set(C.map(x => x.lid))].sort();
  if (!lids.length) return emptyState(el, 'Line chart');
  if (!H.line || !lids.includes(H.line)) H.line = lids[0];
  const D = H.d.doc; const L = D.lines.find(l => l.lid === H.line); const cells = C.filter(x => x.lid === H.line).sort((p, q) => p.km - q.km || p.ci - q.ci);
  const cw = 16, gap = 6; const kms = [...new Set(cells.map(x => x.km))]; const kmX = {}; let x0 = 0; for (const k of kms) { kmX[k] = x0; x0 += 5 * cw + gap; }
  const W = Math.max(x0, 300); const X = x => kmX[x.km] + x.ci * cw;
  const tgi = {}; for (const t of L.t || []) tgi[t[0]] = t;
  const rows = [];   // [label, group?, draw(cell) -> svg]
  const box = (x, y, lv, title) => `<rect class="c" data-k="${x.km}|${x.ci}" x="${X(x)}" y="${y}" width="${cw - 1}" height="20" rx="3" fill="${lv ? LVC[lv] : 'var(--fill)'}"${lv === 'Watch' ? ' fill-opacity="' + WOP + '"' : ''}><title>${esc(title)}</title></rect>`;
  const txt = (x, y, s) => s == null || s === '' ? '' : `<text x="${X(x) + cw / 2}" y="${y + 14}" text-anchor="middle">${esc(String(s))}</text>`;
  rows.push(['Health index', 1, (x, y) => box(x, y, x.lvl, `${where(x)} – index ${x.idx ?? '—'} (${x.lvl || 'no data'})`)]);
  for (const [k, nm] of HE.SIG) rows.push([nm, 0, (x, y) => box(x, y, x.st[k], `${nm}: ${x.st[k] || 'no data'}${(x.why[k] || []).length ? ' – ' + x.why[k].map(w => w[1]).join('; ') : ''}`)]);
  rows.push(['TMS figures', 1, () => '']);
  const yr = s => s ? String(s).slice(2, 4) : '';
  const ageCol = (iso, warnY, critY) => { if (!iso) return 'var(--fill)'; const y = (Date.parse(H.d.today) - Date.parse(String(iso).slice(0, 7) + '-01')) / 3.156e10; return y > critY ? 'var(--critbg)' : y > warnY ? 'var(--cautbg)' : 'var(--okbg)'; };
  rows.push(['TGI per km (TMS)', 0, (x, y) => { const t = tgi[x.km]; if (!t || x.ci !== 2) return ''; const v = t[2][0][0]; return `<text x="${X(x) + cw / 2}" y="${y + 14}" text-anchor="middle" style="font-weight:600;fill:${v < 36 ? 'var(--crit)' : v < 50 ? 'var(--warn)' : v < 80 ? 'var(--caut)' : 'var(--ok)'}">${v}</text>`; }]);
  rows.push(['GMT per year (TMS)', 0, (x, y) => x.ci === 2 && x.c.gy != null ? txt(x, y, Math.round(x.c.gy)) : '']);
  rows.push(['Rail laid (year)', 0, (x, y) => `<rect x="${X(x)}" y="${y}" width="${cw - 1}" height="20" rx="3" fill="${ageCol(x.c.rl, 15, 25)}"><title>${esc('Rail laid ' + (x.c.rl || '—') + ', section ' + (x.c.rs || '—') + ', grade ' + (x.c.rg || '—'))}</title></rect>${txt(x, y, yr(x.c.rl))}`]);
  rows.push(['Cumulative GMT (TMS)', 0, (x, y) => { const life = (Object.assign({}, HE.RULES.life, rulesNow().life || {}))[x.c.rs]; const f = x.c.cg != null && life ? x.c.cg / life : null; return `<rect x="${X(x)}" y="${y}" width="${cw - 1}" height="20" rx="3" fill="${f == null ? 'var(--fill)' : f >= 1 ? 'var(--critbg)' : f >= .9 ? 'var(--cautbg)' : 'var(--okbg)'}"><title>${esc('Cumulative GMT ' + (x.c.cg ?? '—') + (life ? ' of ' + life : ''))}</title></rect>` + (x.ci % 2 === 0 ? txt(x, y, x.c.cg != null ? Math.round(x.c.cg) : '') : ''); }]);
  rows.push(['Last tamping', 0, (x, y) => `<rect x="${X(x)}" y="${y}" width="${cw - 1}" height="20" rx="3" fill="${ageCol(x.c.lt, 2, 4)}"><title>${esc('Last tamping ' + (x.c.lt || '—') + ' ' + (x.c.lm || ''))}</title></rect>${txt(x, y, yr(x.c.lt))}`]);
  rows.push(['Deep screening', 0, (x, y) => `<rect x="${X(x)}" y="${y}" width="${cw - 1}" height="20" rx="3" fill="${ageCol(x.c.ds, 10, 15)}"><title>${esc('Deep screened ' + (x.c.ds || '—'))}</title></rect>${txt(x, y, yr(x.c.ds))}`]);
  rows.push(['USFD last test', 0, (x, y) => `<rect x="${X(x)}" y="${y}" width="${cw - 1}" height="20" rx="3" fill="${ageCol(x.c.ut, 1, 2)}"><title>${esc('Last USFD test ' + (x.c.ut || '—'))}</title></rect>`]);
  rows.push(['Speed restriction', 0, (x, y) => x.c.sr ? `<rect x="${X(x)}" y="${y}" width="${cw - 1}" height="20" rx="3" fill="var(--warnbg)"><title>${esc('Speed restriction ' + x.c.sr + ' km/h')}</title></rect>${txt(x, y, x.c.sr)}` : '']);
  rows.push(['Curve / bridge / LWR', 0, (x, y) => { const o = []; if (x.c.cv) o.push('curve ' + x.c.cv); if (x.c.br) o.push('bridge ' + x.c.br); if (x.c.lw) o.push(x.c.lw === 'L' ? 'LWR' : x.c.lw === 'S' ? 'SWR' : x.c.lw === 'F' ? 'fish-plated' : x.c.lw); return o.length ? `<rect x="${X(x)}" y="${y}" width="${cw - 1}" height="20" rx="3" fill="var(--accentbg)"><title>${esc(o.join(', '))}</title></rect>${txt(x, y, x.c.cv ? 'C' : x.c.br ? 'B' : '')}` : ''; }]);
  const rowH = 22, top = 24; const Hh = top + rows.length * rowH;
  let svg = `<svg width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(L.lid)} strip chart">`;
  for (const k of kms) svg += `<text class="tick" x="${kmX[k]}" y="14">km ${k}</text>`;
  rows.forEach((r, i) => { const y = top + i * rowH; if (r[1] && r[0] === 'TMS figures') { svg += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="var(--fill)"></rect>`; return; } for (const x of cells) svg += r[2](x, y); });
  svg += '</svg>';
  const sel = `<select id="hsel" aria-label="Section-line">${lids.map(l => { const ll = D.lines.find(z => z.lid === l); return `<option value="${esc(l)}"${l === H.line ? ' selected' : ''}>${esc(ll ? lineName(ll) : l)}</option>`; }).join('')}</select>`;
  const lc = cells.filter(x => x.idx != null); const la = lc.length ? Math.round(lc.reduce((a, x) => a + x.idx, 0) / lc.length) : null;
  el.innerHTML = head('Line chart', `<a href="#" id="hback">${esc(tt('Track health'))}</a> › ${esc(L.lid)}`, sel) +
    `<div class="panel"><div class="panelhead" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${ring(la, 100, { size: 46 })}<span><b>${esc(lineName(L))}</b><br><span class="small" style="font-weight:400;color:var(--sub)">km ${HE.kmOf(L.a)}–${HE.kmOf(L.b)} · ${(cells.length * 0.2).toFixed(1)} km · TMS chart data ${dmy(String(L.at || '').slice(0, 10))} · tap a box for the cell's card</span></span></div>
    <div class="hchart"><div class="labs"><div style="height:${top}px"></div>${rows.map(r => `<div class="${r[1] ? 'grp' : ''}">${esc(tt(r[0]))}</div>`).join('')}</div><div class="sc">${svg}</div></div>
    <div class="hleg">${['Good', 'Watch', 'Act', 'Urgent'].map(l => `<span><i style="${bgS(l)}"></i>${esc(tt(l))}</span>`).join('')}<span><i style="background:var(--fill)"></i>no data</span><span>TMS rows: shade = age (green recent, amber older, red old); numbers = year (2 digits), GMT or km/h</span></div></div>`;
  el.querySelector('#hsel').onchange = e => { H.line = e.target.value; T.render(); };
  el.querySelector('#hback').onclick = e => { e.preventDefault(); S.view = 'health'; T.render(); };
  el.querySelectorAll('rect.c').forEach(r => r.onclick = () => { const [km, ci] = r.dataset.k.split('|').map(Number); const x = cells.find(z => z.km === km && z.ci === ci); if (x) cellCard(x); });
};

// ---------- the card of one 200 m cell ----------
async function cellCard(x) {
  const c = x.c; const L = H.d.doc.lines[x.li]; const t = (L.t || []).find(z => z[0] === x.km);
  const row = (k, v) => v == null || v === '' ? '' : `<tr><th style="width:42%">${esc(k)}</th><td>${esc(String(v))}</td></tr>`;
  const sigs = HE.SIG.map(([k, nm]) => `<tr><th>${esc(tt(nm))}</th><td>${tag(x.st[k])}${(x.why[k] || []).length ? `<ul>${x.why[k].map(w => `<li><span style="color:${LVC[w[0]]};font-weight:600">${esc(tt(w[0]))}</span> – ${esc(w[1])}</li>`).join('')}</ul>` : ''}</td></tr>`).join('');
  const html = `<div class="hcard"><h3 style="margin:0 0 4px">${esc(lineName(L))} · km ${x.km} / ${x.ci * 200}–${x.ci < 4 ? x.ci * 200 + 200 : 'end'} m</h3>
    <div class="small" style="color:var(--sub);margin-bottom:12px">${esc(x.lid)} · unit ${esc(x.unit || '—')}${x.unit && H.unitOf[x.unit] ? ' · ' + esc(H.unitOf[x.unit].aen || '') : ''}</div>
    <div style="display:flex;gap:16px;align-items:center;margin-bottom:12px">${ring(x.idx, 100, { size: 70 })}<div>${tag(x.lvl)}<div class="small" style="margin-top:6px;color:var(--sub)">Index = weighted signals; an Urgent signal caps it at ${rulesNow().cap || HE.RULES.cap}.</div></div></div>
    <table><tbody>${sigs}</tbody></table>
    <h4 style="margin:16px 0 6px">${esc(tt('TMS figures'))}</h4><table><tbody>
    ${row('TGI (TMS), last runs', t ? t[2].map(r => `${r[0]}${r[1] ? ' (' + dmy(r[1]) + ')' : ''}`).join(' · ') + (t[1] ? ' – grade ' + t[1] : '') : '')}
    ${row('Rail section / grade code', [c.rs, c.rg].filter(Boolean).join(' / '))}${row('Rail laid', c.rl)}${row('Cumulative GMT on the rail', c.cg)}${row('GMT per year (latest)', c.gy)}
    ${row('Last tamping', c.lt ? c.lt + (c.lm ? ' (' + c.lm + ')' : '') : '')}${row('Deep screened', c.ds)}${row('Sleeper type code', c.sl)}${row('Last USFD rail test', c.ut)}
    ${row('Renewal', c.rn)}${row('Speed restriction', c.sr ? c.sr + ' km/h' : '')}${row('Weak formation', c.wf ? 'yes' : '')}${row('Critical location', c.cl)}
    ${row('Curve', c.cv)}${row('Bridge', c.br)}${row('LWR / SWR', c.lw === 'L' ? 'LWR' : c.lw === 'S' ? 'SWR' : c.lw === 'F' ? 'fish-plated track' : c.lw)}
    </tbody></table><div id="hgmt" class="small" style="margin-top:12px;color:var(--sub)">GMT by year: loading…</div></div>`;
  modal(html, null);
  try {
    let d = H.lines[x.lid]; if (!d) { const r = await call('healthLine', { lid: x.lid }, { cache: true, timeout: 180000 }); d = H.lines[x.lid] = r.json ? JSON.parse(r.json) : null; }
    const box = $('hgmt'); if (!box) return;
    const p = HE.P(x.km, x.ci * 200 + 100); const ys = {}; for (const g of (d && d.gmt) || []) if (p >= g[1] && p < g[2]) { if (!ys[g[0]] || g[4] === 'A') ys[g[0]] = g; }
    const list = Object.values(ys).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    box.innerHTML = list.length ? `<b>GMT by year (TMS GMT summary)</b><br>${list.slice(-10).map(g => `${esc(g[0])}: <b>${g[3]}</b>${g[4] === 'M' ? ' (manual)' : ''}`).join(' · ')}` : 'GMT by year: not in the TMS GMT summary for this stretch.';
  } catch (e) { const box = $('hgmt'); if (box) box.textContent = 'GMT by year: could not load (' + (e.error || e) + ')'; }
}

// ---------- admin: load the TMS Collector's track-health files ----------
V.healthdata = async el => {
  const m0 = H.d ? H.d.meta : null;
  el.innerHTML = head('Track health data', 'Admin') +
    `<div class="panel"><div class="panelhead">Stored now</div><div class="inner" id="hnow" style="padding:16px 18px">${m0 ? metaText(m0) : 'Checking…'}</div></div>
    <div class="panel"><div class="panelhead">Load the TMS Collector's files</div><div class="inner" style="padding:16px 18px">
      <p class="small">Choose the folder <code>TMS KPI\\Track health monitoring\\TMS data</code> (it holds <code>GMT\\gmt_all_years.json</code> and <code>Chart data\\tmsChart_….json</code>), or pick the files. They are read on this computer; only the 200 m summary and the line details are sent – in one call.</p>
      <div class="row" style="gap:10px;flex-wrap:wrap"><label class="btn secondary">Choose folder…<input id="hdir" type="file" webkitdirectory directory multiple hidden></label><label class="btn secondary">Choose files…<input id="hfiles" type="file" accept=".json" multiple hidden></label></div>
      <div id="hprev" style="margin-top:14px"></div></div></div>
    <div class="panel"><div class="panelhead">Rules (thresholds and weights)</div><div class="inner" style="padding:16px 18px" id="hrules"></div></div>`;
  const now = el.querySelector('#hnow');
  if (!H.d) { try { await load(); } catch (e) { now.textContent = 'Could not read: ' + (e.error || e); } }
  now.innerHTML = H.d && H.d.meta ? metaText(H.d.meta) : 'No track-health data stored yet.';
  drawRules(el.querySelector('#hrules'));
  const pick = async files => {
    const box = el.querySelector('#hprev'); const N = self.CORE; if (!N || !N.sectionName) { box.innerHTML = '<div class="ban crit">The admin tools are not loaded (needs signal). Reload the page.</div>'; return; }
    const js = [...files].filter(f => /\.json$/i.test(f.name)); if (!js.length) { box.innerHTML = '<div class="ban warn">No .json file in what you chose.</div>'; return; }
    box.innerHTML = `Reading ${js.length} file(s)…`;
    const charts = [], skipped = []; let gmtF = null;
    for (const f of js) { try { const o = JSON.parse(await f.text()); if (o.type === 'tmsChart' || o.recipe === 'tmsChart') charts.push(o); else if (o.type === 'gmt' || o.recipe === 'gmt') { if (!gmtF || String(o.asOn || '') > String(gmtF.asOn || '')) gmtF = o; } else skipped.push(f.name); } catch (e) { skipped.push(f.name + ' (not readable)'); } }
    if (!charts.length) { box.innerHTML = `<div class="ban warn">No TMS chart file among them${skipped.length ? ' (skipped: ' + esc(skipped.slice(0, 5).join(', ')) + ')' : ''}.</div>`; return; }
    const names = { sectionName: N.sectionName, sectionCode: N.sectionCode, lineKey: N.lineKey, lineDisplay: N.lineDisplay };
    const gmt = gmtF ? HE.parseGmt(gmtF, names) : null; const yearNow = +String(S.B.today || '').slice(0, 4) || new Date().getFullYear();
    const r = HE.buildDoc(charts, gmt, names, yearNow);
    const cells = r.doc.lines.reduce((a, l) => a + l.c.length, 0); const docS = JSON.stringify(r.doc); const det = {}; let detN = 0; for (const k in r.details) { det[k] = JSON.stringify(r.details[k]); detN += det[k].length; }
    const old = r.doc.lines.filter(l => l.at && (Date.parse(S.B.today) - Date.parse(l.at.slice(0, 10))) / 864e5 > 14).length;
    box.innerHTML = `<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><div class="kpi"><div class="l">Section-lines</div><div class="v">${r.doc.lines.length}</div><div class="s">TMS chart files ${dmy(String(r.doc.at).slice(0, 10))}</div></div><div class="kpi"><div class="l">Cells of 200 m</div><div class="v">${cells}</div><div class="s">${(cells * 0.2).toFixed(0)} km of track</div></div><div class="kpi ${gmt ? '' : 'warn'}"><div class="l">GMT</div><div class="v">${gmt ? r.gmtLines : '—'}</div><div class="s">${gmt ? 'lines with GMT history · ' + esc(gmt.at) : 'no GMT file chosen'}</div></div><div class="kpi"><div class="l">To send</div><div class="v">${((docS.length + detN) / 1048576).toFixed(1)} MB</div><div class="s">one call</div></div></div>
      ${old ? `<div class="ban warn">${old} line file(s) are more than two weeks old – fetch "Chart data now" in the TMS Collector for fresh figures.</div>` : ''}${skipped.length ? `<div class="small">Skipped: ${esc(skipped.slice(0, 8).join(', '))}${skipped.length > 8 ? ' …' : ''}</div>` : ''}
      <button class="btn primary" id="hsend" style="margin-top:10px">Save to TMS Control</button> <span id="hmsg" class="small"></span>`;
    box.querySelector('#hsend').onclick = async () => {
      const b = box.querySelector('#hsend'), msg = box.querySelector('#hmsg'); b.disabled = true; msg.textContent = 'Sending… (up to a few minutes)';
      try { const res = await call('healthIngest', { doc: docS, details: det, files: charts.length + (gmtF ? 1 : 0), gmtLines: r.gmtLines }, { timeout: 360000 }); msg.textContent = (res.lines || []).join(' '); toast('Track health data saved'); H.d = null; H.lines = {}; await load(); now.innerHTML = metaText(H.d.meta); }
      catch (e) { msg.textContent = 'Not saved: ' + (e.error || e); b.disabled = false; }
    };
  };
  el.querySelector('#hdir').onchange = e => pick(e.target.files); el.querySelector('#hfiles').onchange = e => pick(e.target.files);
};
function metaText(m) { return `<b>${m.lines}</b> section-lines · <b>${m.cells}</b> cells of 200 m · TMS chart data of ${dmy(String(m.chartAt || '').slice(0, 10))}${m.gmtAt ? ' · GMT ' + dmy(m.gmtAt) : ' · no GMT'} · saved ${dmy(String(m.when || '').slice(0, 10))} ${String(m.when || '').slice(11, 16)} by ${esc(m.by || '')}`; }
function drawRules(box) {
  const R = Object.assign({}, HE.RULES, rulesNow()); for (const k of ['w', 'tgi', 'oms', 'life']) R[k] = Object.assign({}, HE.RULES[k], (rulesNow() || {})[k] || {});
  const f = (k, v, label, step) => `<label class="small" style="display:inline-flex;flex-direction:column;gap:3px;margin:0 14px 10px 0">${esc(label)}<input data-r="${k}" type="number" step="${step || 1}" value="${esc(v)}" style="width:96px"></label>`;
  box.innerHTML = `<p class="small">Defaults: weights and the Urgent cap confirmed by the user (16-Oct); the other figures are starting values to be checked against IRPWM / RDSO – change them here. Every change is logged in Upload history.</p>
    <div><b class="small">Weights</b><br>${HE.SIG.map(([k, nm]) => f('w.' + k, R.w[k], nm)).join('')}${f('cap', R.cap, 'Urgent caps index at')}</div>
    <div><b class="small">TMS TGI per km (below = level)</b><br>${f('tgi.watch', R.tgi.watch, 'Watch below')}${f('tgi.act', R.tgi.act, 'Act below')}${f('tgi.urgent', R.tgi.urgent, 'Urgent below')}${f('tgiDrop', R.tgiDrop, 'Falling: drop of')}</div>
    <div><b class="small">OMS peak (g)</b><br>${f('oms.watch', R.oms.watch, 'Watch from', .01)}${f('oms.act', R.oms.act, 'Act from', .01)}${f('oms.urgent', R.oms.urgent, 'Urgent from', .01)}</div>
    <div><b class="small">Rail and structure</b><br>${f('life.04', R.life['04'], 'Rail life GMT – 60 kg (04)')}${f('life.03', R.life['03'], 'Rail life GMT – 52 kg (03)')}${f('lifeWatch', R.lifeWatch, 'Watch at share of life', .05)}${f('usfdDays', R.usfdDays, 'USFD test older than (days)')}${f('fractMonths', R.fractMonths, 'Fracture within (months)')}${f('dsYears', R.dsYears, 'Deep screening older than (years)')}</div>
    <button class="btn secondary" id="hrsave">Save rules</button> <button class="btn ghost" id="hrdef">Back to defaults</button> <span class="small" id="hrmsg"></span>`;
  const save = async rules => { const msg = box.querySelector('#hrmsg'); msg.textContent = 'Saving…'; try { await call('healthSaveRules', { rules }, { timeout: 180000 }); H.d = null; await load(); drawRules(box); box.querySelector('#hrmsg').textContent = 'Saved – the screens use the new rules.'; } catch (e) { msg.textContent = 'Not saved: ' + (e.error || e); } };
  box.querySelector('#hrsave').onclick = () => { const out = {}; box.querySelectorAll('[data-r]').forEach(i => { const v = parseFloat(i.value); if (!isFinite(v)) return; const p = i.dataset.r.split('.'); if (p.length === 2) { out[p[0]] = out[p[0]] || {}; out[p[0]][p[1]] = v; } else out[p[0]] = v; }); save(out); };
  box.querySelector('#hrdef').onclick = () => save({});
}
const rb = $('btnReload'); if (rb) rb.addEventListener('click', () => { H.d = null; H.ev = null; H.lines = {}; }, true);   // Refresh also re-reads the health data
T.health = { load: () => load(true), state: H };

})(typeof window !== 'undefined' ? window : globalThis);
