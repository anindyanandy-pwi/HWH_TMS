(function(){
const __m = {};
__m['stations.js'] = (function(){
// Field measurement sheets for a Work Record (manual track measurement, IRPWM 2024).
// Pure functions shared by the phone app (to build and check the sheet) and the server (to re-check what was submitted).
//
// Chainage is handled in metres (km 10 + 995 m = 10995).
// Gauge and cross level: every 3 m from the start of the worksite.
// Alignment / unevenness (both rails): straight track every 3.6 m (7.2 m chord), curves every 10 m (20 m chord, versine).
// Points & crossings: TMS P&C form sections 12 (switch and lead) and 15 (crossing).
// Cross level is written with the LOWER rail: 15L = left rail 15 mm low, 8R = right rail 8 mm low.
// Stored as a signed number: right rail low = +, left rail low = − (same sign as TMS).

const r1 = x => Math.round(x * 10) / 10;

// ---------- chainage ----------
// "10.995" -> 10995 ; "11/342" -> 11342 ; "11.3425" -> 11342.5
function parseCh(s) {
  const t = String(s ?? '').trim().replace(/\s+/g, '');
  let m = t.match(/^(\d{1,4})[./](\d{1,3})(\.\d+)?$/);
  if (m) { const mm = m[2].length === 3 || t.includes('/') ? +m[2] : +(m[2] + '000'.slice(m[2].length)); return +m[1] * 1000 + mm + (m[3] ? +m[3] : 0); }
  m = t.match(/^(\d{1,4})$/); if (m) return +m[1] * 1000;
  return null;
}
function fmtCh(p) { if (p == null || !isFinite(p)) return '—'; const km = Math.floor(p / 1000), m = r1(p - km * 1000); return `${km}/${String(m).includes('.') ? m.toFixed(1) : m}`; }

// ---------- values ----------
function parseG(s) { const t = String(s ?? '').trim(); if (t === '') return null; return /^[+-]?\d{1,2}(\.\d)?$/.test(t) ? +t : NaN; }
function parseXL(s) {
  const t = String(s ?? '').trim().toUpperCase().replace(/\s+/g, ''); if (t === '') return null;
  if (/^0(\.0)?$/.test(t)) return 0;
  const m = t.match(/^(\d{1,3}(\.\d)?)([LR])$/); if (!m) return NaN;
  return m[3] === 'R' ? +m[1] : -m[1];
}
function fmtXL(v) { if (v == null || isNaN(v)) return ''; return v === 0 ? '0' : v > 0 ? `${v}R` : `${-v}L`; }
function parseMM(s) { const t = String(s ?? '').trim(); if (t === '') return null; return /^[+-]?\d{1,3}(\.\d)?$/.test(t) ? +t : NaN; }

// ---------- limits (IRPWM 2024; editable in Settings) ----------
const DEFAULT_LIMITS = {
  gStraight: [-6, 6],         // Para 525(1)(a)
  gCurveHi: [-6, 15],         // Para 525(1)(b) radius 440 m or more
  gCurveLo: [-6, 20],         // Para 525(1)(c) radius less than 440 m ("up to +20 mm")
  curveR: 440,
  gCrossing: [-3, 1],         // TMS P&C form, crossing portion
  twist: 3.5,                 // Para 525(2) mm/m on a 3 m base
  vvar: [[110.5, 10], [110, 15], [50, 20], [0, 40]], // Para 524 station-to-station variation of versine (speed >= x -> mm)
  vvarPct: 20,                // or 20% of the average (design) versine, whichever is more
  alPeak: [[100, 15], [110, 12], [130, 11], [160, 11]], // Para 522 TRC peak (UML) limits, alignment 7.2 m chord
  unPeak: [[100, 20], [110, 17], [130, 15], [160, 13]], // Para 522 TRC peak (UML) limits, unevenness 3.6 m
};
const bySpeed = (tab, sp) => { for (const [top, v] of tab) if ((sp || 0) <= top) return v; return tab[tab.length - 1][1]; };
function vvarLimit(L, speed, desV) {
  let base = 40; for (const [min, v] of L.vvar) if ((speed || 0) >= min) { base = v; break; }
  return Math.max(base, (L.vvarPct / 100) * (+desV || 0));
}
function gaugeLimit(L, ctx) { if (ctx && ctx.R) return ctx.R >= L.curveR ? L.gCurveHi : L.gCurveLo; return L.gStraight; }

// ---------- P&C form (TMS sections 12 and 15) ----------
const PNC_LEAD_ROWS = 12; // ATS/HEEL 0 and stations 1..11
function pncFields() {
  const f = [['12.1', 'g', 'Gauge'], ['12.1', 'xl', 'Cross level'], ['12.2', 'g', 'Gauge'], ['12.2', 'xl', 'Cross level']];
  for (let i = 0; i < PNC_LEAD_ROWS; i++) { f.push(['12.3.' + i, 'mg', 'ML gauge'], ['12.3.' + i, 'mx', 'ML cross level'], ['12.3.' + i, 'tg', 'T/O gauge'], ['12.3.' + i, 'tx', 'T/O cross level']); if (i > 0) f.push(['12.3.' + i, 'tv', 'T/O versine']); }
  for (const s of ['15.1', '15.2', '15.3']) f.push([s, 'mg', 'ML gauge'], [s, 'mx', 'ML cross level'], [s, 'tg', 'T/O gauge'], [s, 'tx', 'T/O cross level']);
  return f;
}
const PNC_LABEL = { '12.1': '12.1 At 450 mm ahead of toe of switch (A)', '12.2': '12.2 At ATS between two stock rails (B)', '15.1': '15.1 1 m ahead of ANC (A)', '15.2': '15.2 150 mm behind ANC (B)', '15.3': '15.3 1 m behind ANC (C)' };

// ---------- build the sheet ----------
// geo: { curve:[{a,b,radius,se,versine,no}], pxing:[{pos,no,type}], lc:[{pos,no}], sej:[{pos,no}], glued:[{pos,no}], bridge:[{a,b,no}] }
function buildSheet({ section, line, a, b, speed }, geo = {}) {
  if (!(a >= 0) || !(b >= 0)) throw new Error('Enter the start and end chainage');
  if (b < a) [a, b] = [b, a];
  if (b - a > 5000) throw new Error('A worksite longer than 5 km is not allowed – split it into separate records');
  if (b - a < 1) b = a + 1;
  const curves = (geo.curve || []).filter(c => c.a <= b && c.b >= a).sort((x, y) => x.a - y.a);
  const inCurve = p => curves.find(c => p >= c.a && p <= c.b) || null;
  const pts = (list, d) => (list || []).filter(x => x.pos >= a - d && x.pos <= b + d);
  const tags = [];
  const straightLen = (() => { let s = b - a; for (const c of curves) s -= Math.min(b, c.b) - Math.max(a, c.a); return Math.max(0, r1(s)); })();
  if (straightLen > 0) tags.push({ kind: 'straight', label: `Straight track ${straightLen} m` });
  for (const c of curves) tags.push({ kind: 'curve', no: c.no, label: `Curve ${c.no || ''} (R ${c.radius || '?'} m, SE ${c.se ?? '?'} mm)`.replace('Curve  (', 'Curve ('), a: c.a, b: c.b, radius: c.radius, se: c.se });
  const pnc = pts(geo.pxing, 0).sort((x, y) => x.pos - y.pos);
  for (const p of pnc) tags.push({ kind: 'pxing', no: p.no, label: `P&C ${p.no || ''}${p.type ? ' (' + p.type + ')' : ''} at ${fmtCh(p.pos)}`, pos: p.pos });
  for (const [k, nm] of [['lc', 'LC'], ['sej', 'SEJ'], ['glued', 'Glued joint'], ['diamond', 'Diamond crossing']]) for (const x of pts(geo[k], 0)) tags.push({ kind: k, no: x.no, label: `${nm} ${x.no || ''} at ${fmtCh(x.pos)}`, pos: x.pos });
  for (const x of (geo.bridge || []).filter(x => x.a <= b && x.b >= a)) tags.push({ kind: 'bridge', no: x.no, label: `Bridge ${x.no || ''} (${fmtCh(x.a)} – ${fmtCh(x.b)})`, a: x.a, b: x.b });
  const nearOf = p => {
    const n = [];
    for (const x of pnc) if (Math.abs(x.pos - p) <= 15) n.push('P&C ' + (x.no || ''));
    for (const x of pts(geo.lc, 0)) if (Math.abs(x.pos - p) <= 5) n.push('LC ' + (x.no || ''));
    for (const x of pts(geo.sej, 0)) if (Math.abs(x.pos - p) <= 3) n.push('SEJ ' + (x.no || ''));
    for (const x of (geo.bridge || [])) if (p >= x.a && p <= x.b) n.push('Bridge ' + (x.no || ''));
    return n.join(', ');
  };
  const gx = [];
  for (let p = a; p <= b + 1e-6; p += 3) gx.push(r1(p));
  if (b - gx[gx.length - 1] >= 1) gx.push(r1(b));
  const gxs = gx.map(p => { const c = inCurve(p); return { pos: p, curve: c ? c.no || 'curve' : null, R: c ? +c.radius || null : null, se: c ? c.se : null, near: nearOf(p) }; });
  const av = [];
  for (let p = a; p <= b + 1e-6; p += 3.6) if (!inCurve(p)) av.push({ pos: r1(p), curve: null, chord: 7.2 });
  for (const c of curves) for (let p = c.a; p <= Math.min(b, c.b) + 1e-6; p += 10) if (p >= a - 1e-6) av.push({ pos: r1(p), curve: c.no || 'curve', chord: 20, R: +c.radius || null, desV: +c.versine || null });
  av.sort((x, y) => x.pos - y.pos);
  return { section, line, a, b, speed: +speed || null, tags, gx: gxs, av, pnc: pnc.map(p => ({ no: p.no || fmtCh(p.pos), pos: p.pos, type: p.type || '', ctx: (c => c ? { R: +c.radius || null } : {})(inCurve(p.pos)) })) };
}

// ---------- check readings ----------
// vals: { gx: {pos: {g, xl}}, av: {pos: {al, ar, ul, ur}}, pnc: {no: {key: {field: value}}} } – raw strings as typed
// returns { bad: [{part, key, field, msg}], missing: [{part, key, field}], invalid: [...], red: {gx:Set, av:Set, pnc:{no:Set}} , n }
function checkSheet(sheet, vals, L = DEFAULT_LIMITS, opts = {}) {
  const out = { bad: [], missing: [], invalid: [], n: 0, red: { gx: [], av: [], pnc: {} } };
  const V = vals || {}; const only = opts.only; // only: {gx:[pos], av:[pos], pnc:{no:[key]}} for post-work sheets
  const want = (part, key) => !only || (part === 'pnc' ? false : (only[part] || []).some(p => Math.abs(p - key) < 0.05));
  const redAdd = (part, key) => { const a = out.red[part]; if (!a.some(x => Math.abs(x - key) < 0.05)) a.push(key); };
  // gauge + cross level
  let prev = null;
  for (const s of sheet.gx) {
    if (!want('gx', s.pos)) { prev = null; continue; }
    const v = (V.gx || {})[String(s.pos)] || {}; const g = parseG(v.g), xl = parseXL(v.xl);
    for (const [f, x] of [['g', g], ['xl', xl]]) { out.n++; if (x === null) out.missing.push({ part: 'gx', key: s.pos, field: f }); else if (isNaN(x)) out.invalid.push({ part: 'gx', key: s.pos, field: f, msg: f === 'g' ? 'Gauge: write a number like -3 or +5' : 'Cross level: write like 15L or 8R (letter = lower rail) or 0' }); }
    const lim = gaugeLimit(L, s);
    if (g != null && !isNaN(g) && (g < lim[0] || g > lim[1])) { out.bad.push({ part: 'gx', key: s.pos, field: 'g', msg: `Gauge ${g > 0 ? '+' : ''}${g} mm outside ${lim[0]}/+${lim[1]}` }); redAdd('gx', s.pos); }
    if (xl != null && !isNaN(xl) && prev && prev.xl != null && !isNaN(prev.xl)) {
      const d = Math.max(1, s.pos - prev.pos); const tw = Math.abs(xl - prev.xl) / d;
      if (tw > L.twist) { out.bad.push({ part: 'gx', key: s.pos, field: 'xl', msg: `Twist ${tw.toFixed(1)} mm/m over ${r1(d)} m (limit ${L.twist})` }); redAdd('gx', s.pos); }
    }
    prev = { pos: s.pos, xl };
  }
  // alignment / versine / unevenness (both rails)
  const lastByRail = {};
  for (const s of sheet.av) {
    if (!want('av', s.pos)) continue;
    const v = (V.av || {})[String(s.pos)] || {};
    for (const f of ['al', 'ar', 'ul', 'ur']) {
      const x = parseMM(v[f]); const req = f === 'al' || f === 'ar';
      if (req) out.n++;
      if (x === null) { if (req) out.missing.push({ part: 'av', key: s.pos, field: f }); continue; }
      if (isNaN(x)) { out.invalid.push({ part: 'av', key: s.pos, field: f, msg: 'Write the value in mm, e.g. 4 or -3' }); continue; }
      const rail = f.endsWith('l') ? 'left' : 'right';
      if (f[0] === 'a') {
        if (s.curve) {
          const k = s.curve + '|' + f; const p = lastByRail[k];
          if (p && s.pos - p.pos <= 10.5) { const lim = vvarLimit(L, sheet.speed, s.desV); const dv = Math.abs(x - p.v); if (dv > lim) { out.bad.push({ part: 'av', key: s.pos, field: f, msg: `Versine ${rail} rail changes ${dv} mm from the last station (limit ${r1(lim)})` }); redAdd('av', s.pos); } }
          lastByRail[k] = { pos: s.pos, v: x };
        } else { const lim = bySpeed(L.alPeak, sheet.speed); if (Math.abs(x) > lim) { out.bad.push({ part: 'av', key: s.pos, field: f, msg: `Alignment ${rail} rail ${x} mm beyond ${lim} mm (7.2 m chord)` }); redAdd('av', s.pos); } }
      } else { const lim = bySpeed(L.unPeak, sheet.speed); if (Math.abs(x) > lim) { out.bad.push({ part: 'av', key: s.pos, field: f, msg: `Unevenness ${rail} rail ${x} mm beyond ${lim} mm` }); redAdd('av', s.pos); } }
    }
  }
  // points & crossings – partial entry allowed; empty boxes are listed as missing but do not block
  const onlyP = only ? (only.pnc || {}) : null;
  for (const P of sheet.pnc || []) {
    const pv = ((V.pnc || {})[P.no]) || {}; const red = out.red.pnc[P.no] = [];
    for (const [key, f] of pncFields()) {
      if (onlyP && !(onlyP[P.no] || []).includes(key)) continue;
      const raw = (pv[key] || {})[f]; const isX = f === 'xl' || f === 'mx' || f === 'tx';
      const x = isX ? parseXL(raw) : f === 'tv' ? parseMM(raw) : parseG(raw);
      if (x === null) { out.missing.push({ part: 'pnc', no: P.no, key, field: f, soft: true }); continue; }
      if (isNaN(x)) { out.invalid.push({ part: 'pnc', no: P.no, key, field: f, msg: isX ? 'Cross level: write like 15L or 8R or 0' : 'Write a number like -3 or +5' }); continue; }
      if (!isX && f !== 'tv') {
        const lim = key.startsWith('15.') ? L.gCrossing : gaugeLimit(L, P.ctx);
        if (x < lim[0] || x > lim[1]) { out.bad.push({ part: 'pnc', no: P.no, key, field: f, msg: `P&C ${P.no} ${key}: gauge ${x > 0 ? '+' : ''}${x} mm outside ${lim[0]}/+${lim[1]}` }); if (!red.includes(key)) red.push(key); }
      }
    }
  }
  out.blocking = out.missing.filter(m => !m.soft).length + out.invalid.length;
  return out;
}

// Stations to re-measure after the work: every station that was out of limit before, plus the job's own TRC / OMS spot.
function postSpots(sheet, preCheck, spots = []) {
  const gx = [...preCheck.red.gx], av = [...preCheck.red.av]; const pnc = {};
  for (const [no, keys] of Object.entries(preCheck.red.pnc || {})) if (keys.length) pnc[no] = [...keys];
  for (const sp of spots) {
    if (sp == null || !isFinite(sp)) continue;
    const ng = sheet.gx.reduce((b, s) => (!b || Math.abs(s.pos - sp) < Math.abs(b.pos - sp) ? s : b), null); if (ng && Math.abs(ng.pos - sp) <= 3 && !gx.includes(ng.pos)) gx.push(ng.pos);
    const na = sheet.av.reduce((b, s) => (!b || Math.abs(s.pos - sp) < Math.abs(b.pos - sp) ? s : b), null); if (na && Math.abs(na.pos - sp) <= 10 && !av.includes(na.pos)) av.push(na.pos);
  }
  return { gx: gx.sort((x, y) => x - y), av: av.sort((x, y) => x - y), pnc };
}

function sheetSummary(sheet) { return sheet.tags.map(t => t.label).join(' · '); }

return { parseCh, fmtCh, parseG, parseXL, fmtXL, parseMM, DEFAULT_LIMITS, vvarLimit, gaugeLimit, PNC_LEAD_ROWS, pncFields, PNC_LABEL, buildSheet, checkSheet, postSpots, sheetSummary };
})();
window.STN = __m["stations.js"];

})();
