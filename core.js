const __m = {};
__m['png.js'] = (function(){
// Dependency-free PNG decoder (8-bit RGB / RGBA / grey / palette, non-interlaced).
// Uses the platform DecompressionStream (Chrome/Edge 80+, Node 18+). Returns {w, h, g3}
// where g3[y*w+x] = R+G+B (0..765) – the grey value used by the OCR engine (x3, integer).

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodePNG(arrayBuffer) {
  const b = new Uint8Array(arrayBuffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) throw new Error('Not a PNG image');
  let o = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, plte = null; const idat = [];
  const be32 = p => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  while (o < b.length) {
    const len = be32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const d = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = be32(o + 8); h = be32(o + 12); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') plte = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8) throw new Error('Unsupported PNG bit depth ' + depth);
  if (interlace) throw new Error('Interlaced PNG not supported');
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!bpp) throw new Error('Unsupported PNG colour type ' + ctype);
  let total = 0; idat.forEach(x => total += x.length);
  const z = new Uint8Array(total); let p = 0; idat.forEach(x => { z.set(x, p); p += x.length; });
  const raw = await inflate(z);
  const stride = w * bpp; const cur = new Uint8Array(stride); const prev = new Uint8Array(stride);
  const g3 = new Uint16Array(w * h); const mn = new Uint8Array(w * h);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const r = raw[rp++], a = x >= bpp ? cur[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = r; break;
        case 1: v = r + a; break;
        case 2: v = r + up; break;
        case 3: v = r + ((a + up) >> 1); break;
        case 4: { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c);
          v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); break; }
        default: throw new Error('Bad PNG filter');
      }
      cur[x] = v & 255;
    }
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s;
      if (ctype === 2) { s = cur[3 * x] + cur[3 * x + 1] + cur[3 * x + 2]; mn[row + x] = Math.min(cur[3 * x], cur[3 * x + 1], cur[3 * x + 2]); }
      else if (ctype === 6) { // composite on white
        const al = cur[4 * x + 3];
        s = 0; for (let k = 0; k < 3; k++) s += Math.round((cur[4 * x + k] * al + 255 * (255 - al)) / 255);
      } else if (ctype === 0) s = 3 * cur[x];
      else if (ctype === 4) s = 3 * Math.round((cur[2 * x] * cur[2 * x + 1] + 255 * (255 - cur[2 * x + 1])) / 255);
      else { const i = cur[x] * 3; s = plte[i] + plte[i + 1] + plte[i + 2]; }
      g3[row + x] = s; if (ctype !== 2) mn[row + x] = Math.round(s / 3);
    }
    prev.set(cur);
  }
  return { w, h, g3, mn };
}

return { decodePNG };
})();
__m['ocr.js'] = (function(){
// Glyph-template OCR for TMS "KM Wise Result Report" screenshots (port of the validated Python engine).
// All grey values are R+G+B (x3 scale). Python thresholds: ink<200 -> 600, run<170 -> 510.
const H = 16, MAXW = 11;

class Templates {
  constructor(list) { // list: [{ch, w, q:[H*w ints, unit 1/660]}]
    this.t = list.map(x => ({ ch: x.ch, w: x.w, q: Int16Array.from(x.q) }));
    this.cache = new Map();
  }
  score(img, w) { // img: Int16Array H*w (unit 1/660)
    let key = w + ':'; for (let i = 0; i < img.length; i++) key += String.fromCharCode(img[i] + 32);
    const c = this.cache.get(key); if (c) return c;
    const r = this._score(img, w); this.cache.set(key, r); return r;
  }
  _score(img, w) {
    let best = 9e18, bch = null;
    for (const t of this.t) {
      const wt = t.w; if (Math.abs(w - wt) > 2) continue;
      const W = Math.max(w, wt) + 2;
      for (let oa = 0; oa <= W - w; oa++) for (let ob = 0; ob <= W - wt; ob++) {
        if (Math.abs(oa - ob) > 2) continue;
        let s = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const xa = x - oa, xb = x - ob;
          const a = (xa >= 0 && xa < w) ? img[y * w + xa] : 0;
          const b = (xb >= 0 && xb < wt) ? t.q[y * wt + xb] : 0;
          const d = a - b; s += d * d;
          if (s >= best) break;
        }
        if (s < best) { best = s; bch = t.ch; }
      }
    }
    return [best / 435600, bch];
  }
}

function bands(im, thr3 = 600, x0 = 0, x1 = 1440) {
  const { w, h, g3 } = im; const out = []; let s = -1;
  for (let y = 0; y < h; y++) {
    let any = false; const row = y * w;
    for (let x = x0; x < Math.min(x1, w); x++) if (g3[row + x] < thr3) { any = true; break; }
    if (any && s < 0) s = y;
    if (!any && s >= 0) { out.push([s, y]); s = -1; }
  }
  return out;
}

function borders(im, y, dx = 0) {
  const { w, g3 } = im; const row = y * w;
  const counts = new Map();
  for (let x = 0; x < 1440 + dx && x < w; x++) { const v = g3[row + x]; counts.set(v, (counts.get(v) || 0) + 1); }
  let mode = 0, mc = -1;
  for (const [v, c] of [...counts.entries()].sort((a, b) => a[0] - b[0])) if (c > mc) { mc = c; mode = v; }
  const xs = [12 + dx];
  for (let x = 12 + dx; x < 1434 + dx; x++) if (Math.abs(g3[row + x] - mode) > 24) xs.push(x);
  xs.push(1434 + dx);
  return xs;
}

function runs(im, y0, y1, x0, x1, thr3 = 510) {
  const { w, g3 } = im; const res = []; let s = -1;
  for (let x = x0; x < x1; x++) {
    let ink = false;
    for (let y = y0; y < y1; y++) if (g3[y * w + x] < thr3) { ink = true; break; }
    if (ink && s < 0) s = x;
    if (!ink && s >= 0) { res.push([s, x]); s = -1; }
  }
  if (s >= 0) res.push([s, x1]);
  return res;
}

function gimg(im, ybot, xa, xb, src = 'g3') {
  const { w } = im; const W = xb - xa; const out = new Int16Array(H * W);
  const arr = im[src]; const k = src === 'g3' ? 1 : 3;
  for (let y = 0; y < H; y++) {
    const yy = ybot - H + 1 + y;
    for (let x = 0; x < W; x++) {
      const g = arr[yy * w + xa + x] * k;
      out[y * W + x] = Math.max(0, Math.min(660, 660 - g));
    }
  }
  return out;
}

function readCell(T, im, ybot, x0, x1, ytop, src = 'g3') {
  const rs = runs(im, ytop, ybot + 1, x0 + 1, x1);
  let out = '', cost = 0;
  for (const [xa, xb] of rs) {
    if (xb - xa <= MAXW) {
      const [c, ch] = T.score(gimg(im, ybot, xa, xb, src), xb - xa);
      out += ch || '?'; cost = Math.max(cost, c);
    } else {
      const [s, c] = splitRead(T, im, ybot, xa, xb, src);
      out += s; cost = Math.max(cost, c);
    }
  }
  return [out, cost];
}

function splitRead(T, im, ybot, xa, xb, src) {
  const memo = new Map();
  const solve = (a) => {
    if (a === xb) return [0, ''];
    if (memo.has(a)) return memo.get(a);
    let r = [9e18, ''];
    for (let b = a + 3; b <= Math.min(xb, a + MAXW + 1); b++) {
      const [c, ch] = T.score(gimg(im, ybot, a, b, src), b - a);
      if (ch == null) continue;
      const sub = solve(b); const tot = c + sub[0];
      if (tot < r[0]) r = [tot, ch + sub[1]];
    }
    memo.set(a, r); return r;
  };
  const [c, s] = solve(xa);
  return [s, c / Math.max(1, s.length)];
}

return { H, Templates, bands, borders, runs, gimg, readCell };
})();
__m['page.js'] = (function(){
// Read one TMS km-wise result page (decoded image) into structured values.
const {bands, borders, readCell} = __m['ocr.js'];

const BLKCOLS = ['UN1L', 'UN1R', 'AL1L', 'AL1R', 'AVG', 'RIV1', 'RIL1', 'RIV2', 'RIL2', 'SPD', 'MI_G', 'MI', 'UN2L', 'UN2R', 'AL2L', 'AL2R', 'UNI1', 'ALI1', 'UNI2', 'ALI2', 'TQIS', 'TQIL', 'TQIC'];
const DISTCOLS = ['UN1L', 'UN1R', 'TW1', 'GAUGE', 'AL1L', 'AL1R', 'BAND2', 'UN2L', 'UN2R', 'AL2L', 'AL2R', 'LACC', 'VACC'];
const PARAMS = ['UN1L', 'UN1R', 'TW1', 'AL1L', 'AL1R', 'G', 'UN2L', 'UN2R', 'AL2L', 'AL2R', 'VACCN', 'LACCN'];

function layout(im, dx = 0) {
  const B = bands(im, 600, dx, 1440 + dx);
  const rows = [];
  for (const [a, b] of B) {
    if (b - a < 5) continue; // thin highlight border
    let hdr = b - a > 18;
    if (!hdr) { const y = (a + b) >> 1; hdr = true; for (let x = 14 + dx; x < 30 + dx; x++) if (im.g3[y * im.w + x] >= 675) { hdr = false; break; } }
    rows.push([hdr ? 'H' : 'D', a, b]);
  }
  const info = rows.find(r => r[0] === 'D' && r[1] > 140);
  const groups = []; let cur = null;
  for (const r of rows) {
    if (!info || r[1] <= info[1]) continue;
    if (r[0] === 'H') { if (!cur || cur.data.length) { cur = { hdr: [r], data: [] }; groups.push(cur); } else cur.hdr.push(r); }
    else if (cur) cur.data.push(r);
  }
  return { info, groups, rows };
}

const cellBounds = (im, data, dx) => data.length ? borders(im, data[0][1] - 2, dx) : null;

function readRow(T, im, cb, a, b, n) {
  const out = []; let worst = 0;
  for (let i = 0; i < n; i++) { const [s, c] = readCell(T, im, b - 1, cb[i + 1], cb[i + 2], a); out.push(s); worst = Math.max(worst, c); }
  return [out, worst];
}

function readPage(T, im, dx = 0) {
  const { info, groups } = layout(im, dx);
  const res = { blocks: [], dist: {}, peaks: {}, uml: [], maxcost: 0, warn: [], info, layoutOK: true };
  if (!info || groups.length < 2) { res.layoutOK = false; res.warn.push('Table layout not recognised'); return res; }
  let gi = 0;
  if (groups[0].hdr.length === 2) {
    const blk = groups[0]; const cb = cellBounds(im, blk.data, dx);
    for (const [, a, b] of blk.data) {
      const [lab] = readCell(T, im, b - 1, cb[0], cb[1], a);
      const [vals, c] = readRow(T, im, cb, a, b, 23); res.maxcost = Math.max(res.maxcost, c);
      res.blocks.push([lab, ...vals]);
    }
    gi = 1;
  } else if (groups[0].hdr.length !== 5) res.warn.push('Unexpected header layout');
  const dist = groups[gi]; if (!dist) { res.layoutOK = false; return res; }
  const cbd = cellBounds(im, dist.data, dx);
  ['CBML', 'UML'].forEach((name, k) => {
    const r = dist.data[k]; if (!r) return;
    const [vals, c] = readRow(T, im, cbd, r[1], r[2], 13); res.dist[name] = vals; res.maxcost = Math.max(res.maxcost, c);
  });
  res.kmTqicRow = dist.data[2] || null;
  const pk = groups[gi + 1]; if (!pk) { res.layoutOK = false; return res; }
  const cbp = cellBounds(im, pk.data, dx);
  PARAMS.forEach((p, k) => {
    const r = pk.data[k]; if (!r) return;
    const [vals, c] = readRow(T, im, cbp, r[1], r[2], 20); res.peaks[p] = vals; res.maxcost = Math.max(res.maxcost, c);
  });
  const um = groups[gi + 2];
  if (um && um.data.length) {
    const cbu = cellBounds(im, um.data, dx);
    for (const [, a, b] of um.data) {
      const [vals, c] = readRow(T, im, cbu, a, b, 20); res.maxcost = Math.max(res.maxcost, c);
      // identify parameter by matching (value, dist) pairs with the peak table
      const up = new Set(); for (let j = 0; j < 20; j += 2) if (vals[j] !== '') up.add(vals[j] + '|' + vals[j + 1]);
      let best = null;
      for (const p of PARAMS) {
        const pv = res.peaks[p] || []; let ov = 0;
        for (let j = 0; j < 20; j += 2) if (up.has(pv[j] + '|' + pv[j + 1])) ov++;
        if (ov && (!best || ov > best[0])) best = [ov, p];
      }
      res.uml.push([best ? best[1] : '?', ...vals]);
      if (!best) res.warn.push('UML row parameter not identified');
    }
  }
  return res;
}

return { BLKCOLS, DISTCOLS, PARAMS, layout, readPage };
})();
__m['textocr.js'] = (function(){
// Text-line OCR for the report header (section/line title and info row), template based.
const TH = 20, TMAXW = 16;

function modeOf(im, x0, x1, y0, y1) {
  const m = new Map();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = im.g3[y * im.w + x]; m.set(v, (m.get(v) || 0) + 1); }
  let best = 765, c = -1; for (const [v, n] of m) if (n > c || (n === c && v < best)) { c = n; best = v; }
  return best;
}

function textLines(im, x0, x1, y0, y1, thr3) {
  const out = []; let s = -1;
  for (let y = y0; y < y1; y++) {
    let any = false; for (let x = x0; x < x1; x++) if (im.g3[y * im.w + x] < thr3) { any = true; break; }
    if (any && s < 0) s = y; if (!any && s >= 0) { out.push([s, y]); s = -1; }
  }
  if (s >= 0) out.push([s, y1]);
  return out;
}

function lineRuns(im, top, bot, x0, x1, thr3) {
  const res = []; let s = -1;
  for (let x = x0; x < x1; x++) {
    let ink = false; for (let y = top; y < bot; y++) if (im.g3[y * im.w + x] < thr3) { ink = true; break; }
    if (ink && s < 0) s = x; if (!ink && s >= 0) { res.push([s, x]); s = -1; }
  }
  if (s >= 0) res.push([s, x1]);
  return res;
}

function tglyph(im, top, xa, xb, bg) {
  const W = xb - xa, out = new Int16Array(TH * W);
  for (let y = 0; y < TH; y++) { const yy = top - 1 + y; for (let x = 0; x < W; x++) {
    const g = yy >= 0 && yy < im.h ? im.g3[yy * im.w + xa + x] : bg;
    out[y * W + x] = Math.max(0, Math.min(765, bg - g)); } }
  return out;
}

class TTemplates {
  constructor(list = []) { this.t = list.map(x => ({ ch: x.ch, w: x.w, q: Int16Array.from(x.q) })); this.cache = new Map(); }
  add(ch, q, w) {
    for (const t of this.t) if (t.ch === ch && t.w === w) { let d = 0; for (let i = 0; i < q.length; i++) d += Math.abs(q[i] - t.q[i]); if (d < 30 * q.length / 10) return false; }
    this.t.push({ ch, w, q: Int16Array.from(q) }); return true;
  }
  score(q, w) {
    let key = w + ':'; for (let i = 0; i < q.length; i++) key += String.fromCharCode(q[i] + 32);
    const c = this.cache.get(key); if (c) return c;
    let best = 9e18, bch = null;
    for (const t of this.t) {
      const wt = t.w; if (Math.abs(w - wt) > 2) continue;
      const W = Math.max(w, wt) + 2;
      for (let oa = 0; oa <= W - w; oa++) for (let ob = 0; ob <= W - wt; ob++) {
        if (Math.abs(oa - ob) > 2) continue; let s = 0;
        outer: for (let y = 0; y < TH; y++) for (let x = 0; x < W; x++) {
          const xa = x - oa, xb = x - ob;
          const a = xa >= 0 && xa < w ? q[y * w + xa] : 0, b = xb >= 0 && xb < wt ? t.q[y * wt + xb] : 0;
          s += (a - b) * (a - b); if (s >= best) break outer;
        }
        if (s < best) { best = s; bch = t.ch; }
      }
    }
    const r = [best / (765 * 765 * TH), bch]; this.cache.set(key, r); return r;
  }
  toJSON() { return this.t.map(t => ({ ch: t.ch, w: t.w, q: Array.from(t.q) })); }
}

function readText(T, im, top, bot, x0, x1, thr3, bg) {
  const rs = lineRuns(im, top, bot, x0, x1, thr3); let out = '', worst = 0, prev = null;
  for (const [xa, xb] of rs) {
    if (prev !== null && xa - prev >= 5) out += ' ';
    prev = xb;
    if (xb - xa <= TMAXW) { const [c, ch] = T.score(tglyph(im, top, xa, xb, bg), xb - xa); out += ch || '?'; worst = Math.max(worst, c); }
    else {
      const memo = new Map();
      const solve = a => { if (a === xb) return [0, '']; if (memo.has(a)) return memo.get(a); let r = [9e18, '?'];
        for (let b = a + 2; b <= Math.min(xb, a + TMAXW + 1); b++) { const [c, ch] = T.score(tglyph(im, top, a, b, bg), b - a); if (ch == null) continue; const sub = solve(b); if (c + sub[0] < r[0]) r = [c + sub[0], ch + sub[1]]; }
        memo.set(a, r); return r; };
      const [c, s] = solve(xa); out += s; worst = Math.max(worst, c / Math.max(1, s.length));
    }
  }
  return [out, worst];
}

// Locate header elements. Returns { titleLine:[top,bot], infoBand:[top,bot], bgTitle, bgInfo, dx }
function locateHeader(im, info) {
  // peach title block: band above the info row whose background is not white
  const W = Math.min(im.w, 1440);
  const yInfo = info ? info[1] : 150;
  const px = y => im.g3[y * im.w + 20];
  let y1 = yInfo - 1;
  while (y1 > 6) { const v = px(y1); let same = v < 700; for (let k = 1; k <= 5 && same; k++) same = px(y1 - k) === v; if (same) break; y1--; }
  let y0 = y1; while (y0 > 0 && Math.abs(im.g3[y0 * im.w + 20] - im.g3[y1 * im.w + 20]) < 30) y0--;
  const bgTitle = modeOf(im, 12, W - 10, y0 + 1, y1);
  const lines = textLines(im, 12, W - 10, y0 + 1, y1 + 1, Math.min(300, bgTitle - 150));
  return { titleLines: lines, bgTitle, block: [y0 + 1, y1 + 1] };
}

return { TH, modeOf, textLines, lineRuns, tglyph, TTemplates, readText, locateHeader };
})();
__m['header.js'] = (function(){
// Read section/line (title signature lookup) and run date / km / speed (info-row digit templates).
const {borders} = __m['ocr.js'];
const {lineRuns, tglyph, locateHeader, TTemplates, TH} = __m['textocr.js'];

const INFO_THR = 200, TITLE_THR = 150;

function titleSig(im, tl) {
  const sig = [];
  for (let x = 12; x < Math.min(im.w, 1430); x++) {
    let c = 0; for (let y = tl[0]; y < tl[1]; y++) if (im.g3[y * im.w + x] < TITLE_THR) c++;
    sig.push(c);
  }
  let a = 0, b = sig.length; while (a < b && !sig[a]) a++; while (b > a && !sig[b - 1]) b--;
  return sig.slice(a, b);
}

function sigDistance(s1, s2) {
  if (Math.abs(s1.length - s2.length) > 4) return 1;
  let best = 1, tot = 0; for (const v of s1) tot += v;
  for (let sh = -3; sh <= 3; sh++) {
    let d = 0; const n = Math.max(s1.length, s2.length);
    for (let i = 0; i < n; i++) d += Math.abs((s1[i] || 0) - (s2[i + sh] || 0));
    best = Math.min(best, d / Math.max(1, tot));
  }
  return best;
}

function infoCells(im, info) {
  const xs = borders(im, info[1] - 2);
  // collapse consecutive border pixels
  const b = []; for (const x of xs) if (!b.length || x - b[b.length - 1] > 2) b.push(x);
  return b;
}

function readInfoCell(T, im, info, x0, x1) {
  const rs = lineRuns(im, info[1], info[2], x0 + 2, x1 - 1, INFO_THR);
  let out = '', prev = null, worst = 0;
  for (const [a, b] of rs) {
    if (prev !== null && a - prev >= 6) out += ' ';
    prev = b;
    if (b - a <= 16) { const [c, ch] = T.score(tglyph(im, info[1], a, b, 765), b - a); out += ch || '?'; worst = Math.max(worst, c); }
    else { // split merged run by DP
      const memo = new Map();
      const solve = p => { if (p === b) return [0, '']; if (memo.has(p)) return memo.get(p); let r = [9e18, '?'];
        for (let q = p + 2; q <= Math.min(b, p + 17); q++) { const [c, ch] = T.score(tglyph(im, info[1], p, q, 765), q - p); if (ch == null) continue; const s = solve(q); if (c + s[0] < r[0]) r = [c + s[0], ch + s[1]]; }
        memo.set(p, r); return r; };
      const [c, s] = solve(a); out += s; worst = Math.max(worst, c / Math.max(1, s.length));
    }
  }
  return [out, worst];
}

const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// lib: [{sig, section, line}] ; T: TTemplates for info font
function readHeader(im, info, lib, T) {
  const out = { section: null, line: null, date: null, km: null, kmTo: null, speed: null, trc: null, runNo: null, problems: [] };
  const hd = locateHeader(im, info);
  const tl = hd.titleLines[hd.titleLines.length - 1];
  if (tl) {
    const sig = titleSig(im, tl); out.titleSig = sig; out.titleLine = tl;
    let best = null;
    for (const e of lib) { const d = sigDistance(sig, e.sig); if (!best || d < best.d) best = { d, e }; }
    if (best && best.d < 0.08) { out.section = best.e.section; out.line = best.e.line; }
    else out.problems.push('new-title');
  } else out.problems.push('no-title');
  const b = infoCells(im, info);
  // expected 11 borders -> 10 cells: label,value pairs
  if (b.length >= 11) {
    const cell = k => readInfoCell(T, im, info, b[k], b[k + 1])[0].replace(/\s+/g, '');
    out.trc = cell(1); out.runNo = cell(5);
    const d = out.runNo.match(/^(\d{2})-(\d{2})-(\d{4})/);
    if (d && +d[2] >= 1 && +d[2] <= 12 && +d[1] >= 1 && +d[1] <= 31) out.date = `${d[3]}-${d[2]}-${d[1]}`;
    const k = cell(7).match(/(\d+)TO(\d+)/i); if (k) { out.km = +k[1]; out.kmTo = +k[2]; }
    const s = cell(9).match(/^(\d{2,3})$/); if (s) out.speed = +s[1];
  } else out.problems.push('info-row');
  if (out.date == null) out.problems.push('date');
  if (out.km == null) out.problems.push('km');
  if (out.speed == null) out.problems.push('speed');
  return out;
}

return { INFO_THR, titleSig, sigDistance, infoCells, readInfoCell, readHeader };
})();
__m['xls.js'] = (function(){
// Minimal, dependency-free reader for legacy Excel .xls (BIFF8 inside OLE2 compound file).
// Returns { sheets: [{ name, rows: Array<Array<string|number|null>> }] }

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }
function i32(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); }

function readOLE(buf) {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('Not an OLE2 (.xls) file');
  const secShift = u16(buf, 30), miniShift = u16(buf, 32);
  const SS = 1 << secShift, MSS = 1 << miniShift;
  const nFat = u32(buf, 44), dirStart = u32(buf, 48), miniCutoff = u32(buf, 56);
  const miniFatStart = u32(buf, 60), nMiniFat = u32(buf, 64);
  let difatStart = u32(buf, 68), nDifat = u32(buf, 72);
  const sectorOff = s => (s + 1) * SS;
  // DIFAT -> FAT sector list
  const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) {
    const s = u32(buf, 76 + 4 * i); if (s < 0xfffffffa) fatSecs.push(s);
  }
  while (nDifat-- > 0 && difatStart < 0xfffffffa) {
    const off = sectorOff(difatStart);
    for (let i = 0; i < SS / 4 - 1 && fatSecs.length < nFat; i++) {
      const s = u32(buf, off + 4 * i); if (s < 0xfffffffa) fatSecs.push(s);
    }
    difatStart = u32(buf, off + SS - 4);
  }
  const fat = new Uint32Array(fatSecs.length * SS / 4);
  fatSecs.forEach((s, k) => { const off = sectorOff(s); for (let i = 0; i < SS / 4; i++) fat[k * SS / 4 + i] = u32(buf, off + 4 * i); });
  const chain = (start) => { const out = []; let s = start, guard = 0; while (s < 0xfffffffa && guard++ < 1e7) { out.push(s); s = fat[s]; } return out; };
  const readStream = (start, size) => {
    const secs = chain(start); const out = new Uint8Array(secs.length * SS);
    secs.forEach((s, i) => out.set(buf.subarray(sectorOff(s), sectorOff(s) + SS), i * SS));
    return size == null ? out : out.subarray(0, size);
  };
  const dir = readStream(dirStart);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = u16(dir, o + 64); let name = '';
    for (let i = 0; i < Math.max(0, nameLen / 2 - 1); i++) name += String.fromCharCode(u16(dir, o + 2 * i));
    entries.push({ name, type: dir[o + 66], start: u32(dir, o + 116), size: u32(dir, o + 120) });
  }
  const root = entries[0];
  let miniStream = null, miniFat = null;
  const getMini = () => {
    if (!miniStream) {
      miniStream = readStream(root.start, root.size);
      const mf = readStream(miniFatStart); miniFat = new Uint32Array(mf.buffer, mf.byteOffset, Math.floor(mf.length / 4));
    }
  };
  const readEntry = (e) => {
    if (e.size < miniCutoff && e.type === 2) {
      getMini(); const out = new Uint8Array(Math.ceil(e.size / MSS) * MSS); let s = e.start, i = 0;
      while (s < 0xfffffffa && i * MSS < out.length) { out.set(miniStream.subarray(s * MSS, s * MSS + MSS), i * MSS); s = miniFat[s]; i++; }
      return out.subarray(0, e.size);
    }
    return readStream(e.start, e.size);
  };
  return { entries, readEntry };
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function parseBIFF(wb) {
  // split into records, merge CONTINUE into a list of fragments for SST handling
  const recs = [];
  for (let o = 0; o + 4 <= wb.length;) {
    const t = u16(wb, o), n = u16(wb, o + 2);
    recs.push({ t, d: wb.subarray(o + 4, o + 4 + n), off: o });
    o += 4 + n;
  }
  const sst = []; const formats = {}; const xfFmt = []; const sheets = [];
  let i = 0;
  // ---- globals
  for (; i < recs.length; i++) {
    const r = recs[i];
    if (r.t === 0x0085) { // BOUNDSHEET
      const off = u32(r.d, 0); const vis = r.d[4], kind = r.d[5];
      const name = readShortString(r.d, 6);
      sheets.push({ name, off, kind, rows: [] });
    } else if (r.t === 0x041e) { // FORMAT
      const id = u16(r.d, 0); formats[id] = readLongString([r.d], 2).s;
    } else if (r.t === 0x00e0) { // XF
      xfFmt.push(u16(r.d, 2));
    } else if (r.t === 0x00fc) { // SST
      const frags = [r.d.subarray(8)]; let j = i + 1;
      while (j < recs.length && recs[j].t === 0x003c) { frags.push(recs[j].d); j++; }
      readSST(frags, u32(r.d, 4), sst); i = j - 1;
    } else if (r.t === 0x000a) { i++; break; } // EOF of globals
  }
  const isDateXF = xf => {
    const f = xfFmt[xf]; if (f == null) return false;
    if (BUILTIN_DATE.has(f)) return true;
    const s = formats[f]; if (!s) return false;
    const clean = s.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    return /[dmy]/i.test(clean) && !/^[#0.,%]+$/.test(clean);
  };
  const byOff = new Map(recs.map((r, k) => [r.off, k]));
  for (const sh of sheets) {
    if (sh.kind !== 0) continue; // worksheets only
    let k = byOff.get(sh.off); if (k == null) continue;
    const rows = sh.rows; let pendingFormula = null;
    const set = (r, c, v) => { (rows[r] || (rows[r] = []))[c] = v; };
    const val = (xf, num) => isDateXF(xf) ? excelDate(num) : num;
    for (k = k + 1; k < recs.length; k++) {
      const r = recs[k], d = r.d;
      if (r.t === 0x000a) break;
      switch (r.t) {
        case 0x00fd: set(u16(d, 0), u16(d, 2), sst[u32(d, 6)] ?? ''); break;
        case 0x0203: set(u16(d, 0), u16(d, 2), val(u16(d, 4), new DataView(d.buffer, d.byteOffset + 6, 8).getFloat64(0, true))); break;
        case 0x027e: set(u16(d, 0), u16(d, 2), val(u16(d, 4), rk(d, 6))); break;
        case 0x00bd: { const row = u16(d, 0), c0 = u16(d, 2); const n = (d.length - 6) / 6;
          for (let q = 0; q < n; q++) set(row, c0 + q, val(u16(d, 4 + 6 * q), rk(d, 6 + 6 * q))); break; }
        case 0x0204: set(u16(d, 0), u16(d, 2), readLongString([d], 6).s); break;
        case 0x0006: { const row = u16(d, 0), col = u16(d, 2), xf = u16(d, 4);
          if (d[12] === 0xff && d[13] === 0xff) {
            if (d[6] === 0) pendingFormula = [row, col]; else if (d[6] === 1) set(row, col, d[8] ? 1 : 0);
          } else set(row, col, val(xf, new DataView(d.buffer, d.byteOffset + 6, 8).getFloat64(0, true)));
          break; }
        case 0x0207: if (pendingFormula) { set(pendingFormula[0], pendingFormula[1], readLongString([d], 0).s); pendingFormula = null; } break;
        case 0x0205: set(u16(d, 0), u16(d, 2), d[6]); break; // BOOLERR
      }
    }
  }
  return sheets.filter(s => s.kind === 0).map(s => ({ name: s.name, rows: normRows(s.rows) }));
}

function normRows(rows) {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || []; const a = [];
    for (let c = 0; c < row.length; c++) a[c] = row[c] === undefined ? null : row[c];
    out.push(a);
  }
  return out;
}

function rk(d, o) {
  const v = u32(d, o); let x;
  if (v & 2) x = i32(d, o) >> 2;
  else { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(4, v & 0xfffffffc, true); dv.setUint32(0, 0, true); x = dv.getFloat64(0, true); }
  return (v & 1) ? x / 100 : x;
}

function excelDate(n) {
  // returns ISO date string yyyy-mm-dd (TMS dates have no time we need)
  const ms = Math.round((n - 25569) * 86400000);
  const dt = new Date(ms); if (isNaN(dt)) return n;
  return dt.toISOString().slice(0, 10);
}

function readShortString(d, o) {
  const cch = d[o], flags = d[o + 1]; let s = '';
  if (flags & 1) for (let i = 0; i < cch; i++) s += String.fromCharCode(u16(d, o + 2 + 2 * i));
  else for (let i = 0; i < cch; i++) s += String.fromCharCode(d[o + 2 + i]);
  return s;
}

// read XLUnicodeRichExtendedString from fragment list starting at frags[0][o]
function readLongString(frags, o) {
  const st = { f: 0, o };
  const s = readUniStr(frags, st);
  return { s, st };
}

function readUniStr(frags, st) {
  const need = n => { while (st.f < frags.length && st.o >= frags[st.f].length) { st.o -= frags[st.f].length; st.f++; } };
  const byte = () => { need(); return frags[st.f][st.o++]; };
  const word = () => { const a = byte(); const b = byte(); return a | (b << 8); };
  const dword = () => { const a = word(); const b = word(); return a + b * 65536; };
  need();
  const cch = word(); let flags = byte();
  let cRun = 0, cbExt = 0;
  if (flags & 8) cRun = word();
  if (flags & 4) cbExt = dword();
  let s = ''; let hi = flags & 1;
  for (let n = 0; n < cch; n++) {
    if (st.o >= frags[st.f].length) { st.f++; st.o = 0; if (st.f >= frags.length) break; hi = frags[st.f][st.o++] & 1; }
    if (hi) { const a = frags[st.f][st.o++]; const b = frags[st.f][st.o++]; s += String.fromCharCode(a | (b << 8)); }
    else s += String.fromCharCode(frags[st.f][st.o++]);
  }
  // skip rich runs + ext
  let skip = 4 * cRun + cbExt;
  while (skip > 0 && st.f < frags.length) {
    const avail = frags[st.f].length - st.o;
    if (skip <= avail) { st.o += skip; skip = 0; } else { skip -= avail; st.f++; st.o = 0; }
  }
  return s;
}

function readSST(frags, n, out) {
  const st = { f: 0, o: 0 };
  for (let i = 0; i < n; i++) {
    if (st.f >= frags.length) break;
    out.push(readUniStr(frags, st));
  }
}

function readXLS(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const ole = readOLE(buf);
  const e = ole.entries.find(x => x.name === 'Workbook') || ole.entries.find(x => x.name === 'Book');
  if (!e) throw new Error('No Workbook stream in .xls');
  return { sheets: parseBIFF(ole.readEntry(e)) };
}

return { readXLS };
})();
__m['zip.js'] = (function(){
// Tiny ZIP reader (deflate via platform DecompressionStream) and writer (DEFLATE via CompressionStream).
const enc = new TextEncoder();
let CRC_T = null;
function crc32(b) {
  if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
  let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

async function unzip(arrayBuffer) {
  const b = new Uint8Array(arrayBuffer); const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a zip file');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const files = {};
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
    const data = b.subarray(lho + 30 + lnl + lxl, lho + 30 + lnl + lxl + csize);
    files[name] = { method, data };
    p += 46 + nl + xl + cl;
  }
  return {
    names: Object.keys(files),
    async bytes(name) { const f = files[name]; if (!f) return null; return f.method === 8 ? await pipe(f.data, new DecompressionStream('deflate-raw')) : f.data.slice(); },
    async text(name) { const f = files[name]; if (!f) return null; const raw = f.method === 8 ? await pipe(f.data, new DecompressionStream('deflate-raw')) : f.data; return new TextDecoder().decode(raw); }
  };
}

async function zip(entries) { // entries: [{name, data: string|Uint8Array}]
  const parts = [], central = []; let off = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const comp = await pipe(raw, new CompressionStream('deflate-raw'));
    const nm = enc.encode(e.name), crc = crc32(raw);
    const h = new Uint8Array(30 + nm.length); const d = new DataView(h.buffer);
    d.setUint32(0, 0x04034b50, true); d.setUint16(4, 20, true); d.setUint16(8, 8, true);
    d.setUint32(14, crc, true); d.setUint32(18, comp.length, true); d.setUint32(22, raw.length, true); d.setUint16(26, nm.length, true); h.set(nm, 30);
    parts.push(h, comp);
    const c = new Uint8Array(46 + nm.length); const cd = new DataView(c.buffer);
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(10, 8, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, comp.length, true); cd.setUint32(24, raw.length, true); cd.setUint16(28, nm.length, true); cd.setUint32(42, off, true); c.set(nm, 46);
    central.push(c); off += h.length + comp.length;
  }
  let csz = 0; central.forEach(c => csz += c.length);
  const end = new Uint8Array(22); const ed = new DataView(end.buffer);
  ed.setUint32(0, 0x06054b50, true); ed.setUint16(8, entries.length, true); ed.setUint16(10, entries.length, true); ed.setUint32(12, csz, true); ed.setUint32(16, off, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

return { unzip, zip };
})();
__m['xlsx.js'] = (function(){
// .xlsx reader (first sheet / all sheets -> rows) and writer (styled tables). No dependencies.
const {unzip, zip} = __m['zip.js'];

const unx = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
const colIdx = ref => { let n = 0; for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

async function readXLSX(arrayBuffer) {
  const z = await unzip(arrayBuffer);
  const ss = [];
  const sst = await z.text('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) ss.push(unx([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const wb = await z.text('xl/workbook.xml'); const rels = await z.text('xl/_rels/workbook.xml.rels');
  const relMap = {}; for (const m of (rels || '').matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2];
  for (const m of (rels || '').matchAll(/<Relationship [^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) relMap[m[2]] = m[1];
  const sheets = [];
  for (const m of (wb || '').matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    let t = relMap[m[2]] || ''; t = t.replace(/^\//, ''); if (!t.startsWith('xl/')) t = 'xl/' + t;
    const xml = await z.text(t); if (!xml) continue;
    const rows = [];
    for (const c of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const r = +c[2] - 1, col = colIdx(c[1]), attrs = c[3], inner = c[4] || '';
      const tt = (attrs.match(/t="([^"]+)"/) || [])[1];
      let v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = null;
      if (tt === 's') val = ss[+v] ?? null;
      else if (tt === 'inlineStr') val = unx([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
      else if (tt === 'str') val = v != null ? unx(v) : null;
      else if (v != null) val = +v;
      (rows[r] || (rows[r] = []))[col] = val;
    }
    sheets.push({ name: unx(m[1]), rows: Array.from(rows, r => r ? Array.from(r, x => x === undefined ? null : x) : []) });
  }
  return { sheets };
}

// ---------------- writer ----------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
// style ids: 0 normal,1 header,2 title,3 wrap,4 red,5 orange,6 yellow,7 green,8 grey,9 bold,10 percent,11 italic note
const FILLS = ['F8CBAD', 'FCE4D6', 'FFF2CC', 'E2EFDA', 'EDEDED'];
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
<fonts count="5"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="14"/><color rgb="FF1F3864"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><i/><sz val="9"/><color rgb="FF555555"/><name val="Arial"/></font></fonts>
<fills count="${3 + FILLS.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill>${FILLS.map(c => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/></patternFill></fill>`).join('')}</fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="top"/></xf>
<xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf fontId="2"/>
<xf fontId="0" borderId="1"><alignment vertical="top" wrapText="1"/></xf>
${FILLS.map((c, i) => `<xf fontId="0" fillId="${3 + i}" borderId="1" applyFill="1"><alignment vertical="top" wrapText="1"/></xf>`).join('\n')}
<xf fontId="3" borderId="1" applyFont="1"><alignment vertical="top"/></xf>
<xf fontId="0" numFmtId="164" borderId="1" applyNumberFormat="1"/>
<xf fontId="4"><alignment wrapText="0"/></xf>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
const ST = { normal: 0, header: 1, title: 2, wrap: 3, red: 4, orange: 5, yellow: 6, green: 7, grey: 8, bold: 9, pct: 10, note: 11 };

// sheet: {name, title?, note?, headers:[], rows:[[...]], widths?:[], wrap?:Set(colIdx), styleFn?:(r,c,v)=>styleId, pctCols?:Set}
async function writeXLSX(sheets) {
  const ss = [], ssIdx = new Map();
  const sidx = s => { let i = ssIdx.get(s); if (i === undefined) { i = ss.length; ss.push(s); ssIdx.set(s, i); } return i; };
  const sheetXml = sh => {
    const out = []; let r = 1; const cell = (c, v, st) => {
      const ref = colName(c) + r;
      if (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) return st ? `<c r="${ref}" s="${st}"/>` : '';
      if (typeof v === 'number') return `<c r="${ref}" s="${st}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${st}" t="s"><v>${sidx(String(v))}</v></c>`;
    };
    if (sh.title) { out.push(`<row r="${r}">${cell(0, sh.title, ST.title)}</row>`); r++; }
    if (sh.note) { out.push(`<row r="${r}">${cell(0, sh.note, ST.note)}</row>`); r++; }
    for (const pre of sh.pre || []) { out.push(`<row r="${r}">${pre.map((v, c) => cell(c, v, c === 0 ? ST.bold : ST.normal)).join('')}</row>`); r++; }
    if (sh.title || sh.note || (sh.pre && sh.pre.length)) r++;
    const hr = r;
    if (sh.headers) { out.push(`<row r="${r}" ht="40" customHeight="1">${sh.headers.map((h, c) => cell(c, h, ST.header)).join('')}</row>`); r++; }
    for (const row of sh.rows) {
      out.push(`<row r="${r}">${row.map((v, c) => cell(c, v, sh.styleFn ? (sh.styleFn(row, c, v) ?? (sh.pctCols?.has(c) ? ST.pct : sh.wrap?.has(c) ? ST.wrap : ST.normal)) : (sh.pctCols?.has(c) ? ST.pct : sh.wrap?.has(c) ? ST.wrap : ST.normal))).join('')}</row>`); r++;
    }
    const ncol = sh.headers ? sh.headers.length : 1;
    const cols = (sh.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const freeze = sh.headers ? `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${sh.freezeCols ?? 0}" ySplit="${hr}" topLeftCell="${colName(sh.freezeCols ?? 0)}${hr + 1}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>` : '';
    const af = sh.headers && sh.rows.length ? `<autoFilter ref="A${hr}:${colName(ncol - 1)}${hr + sh.rows.length}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${out.join('')}</sheetData>${af}</worksheet>`;
  };
  const files = [];
  sheets.forEach((sh, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh) }));
  files.push({ name: 'xl/sharedStrings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ss.length}" uniqueCount="${ss.length}">${ss.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>` });
  files.push({ name: 'xl/styles.xml', data: STYLES });
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` });
  files.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>` });
  return zip(files);
}

return { readXLSX, ST, writeXLSX };
})();
__m['pdftext.js'] = (function(){
// Minimal text extractor for simple (iText / standard-font) PDFs such as TMS exception reports.
// Returns array of text lines (items on the same baseline joined by spaces), in reading order.

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
}

const latin1 = b => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };

async function pdfLines(arrayBuffer) {
  const pages = await pdfPages(arrayBuffer, 0); const lines = [];
  for (const pg of pages) for (const r of pg) lines.push(r.cells.map(c => c.txt).join(' '));
  return lines;
}

// Pages -> rows (items within 2.5 units of the same baseline) -> cells {x, txt}. Rows top to bottom.
async function pdfPages(arrayBuffer, tol = 2.5) {
  const b = new Uint8Array(arrayBuffer); const s = latin1(b);
  if (!s.startsWith('%PDF')) throw new Error('Not a PDF');
  const streams = [];
  const re = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g; let m;
  while ((m = re.exec(s))) {
    const body = m[2]; const si = body.indexOf('stream');
    if (si < 0) continue;
    const dict = body.slice(0, si);
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject|\/Length1|\/N 3/.test(dict)) continue;
    let start = m.index + m[0].indexOf('stream') + 6;
    if (s[start] === '\r') start++; if (s[start] === '\n') start++;
    let end = s.indexOf('endstream', start);
    const L = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    if (L) end = Math.min(end, start + +L[1]); else while (end > start && /[\r\n ]/.test(s[end - 1])) end--;
    let data = b.subarray(start, end);
    if (/FlateDecode/.test(dict)) { try { data = await inflate(data); } catch (e) { continue; } }
    streams.push(latin1(data));
  }
  const pages = [];
  for (const cs of streams) {
    if (!/BT[\s\S]*ET/.test(cs)) continue;
    const items = []; let x = 0, y = 0, lx = 0, ly = 0;
    const tok = /\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:\\.|[^\]])*)\]\s*TJ|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|\bBT\b/g;
    let t;
    while ((t = tok.exec(cs))) {
      if (t[0] === 'BT') { x = y = lx = ly = 0; continue; }
      if (t[3] !== undefined) { lx += +t[3]; ly += +t[4]; x = lx; y = ly; continue; }
      if (t[5] !== undefined) { lx = +t[9]; ly = +t[10]; x = lx; y = ly; continue; }
      let txt = '';
      if (t[1] !== undefined) txt = unesc(t[1]);
      else { const parts = t[2].match(/\(((?:\\.|[^\\)])*)\)/g) || []; txt = parts.map(p => unesc(p.slice(1, -1))).join(''); }
      items.push({ x, y, txt });
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of items) { const r = rows.length ? rows[rows.length - 1] : null; if (r && (tol ? Math.abs(r.y - it.y) <= tol : Math.round(r.y) === Math.round(it.y))) r.cells.push(it); else rows.push({ y: it.y, cells: [it] }); }
    rows.forEach(r => { r.cells.sort((a, b) => a.x - b.x); r.cells = r.cells.map(c => ({ x: Math.round(c.x * 10) / 10, txt: c.txt })); });
    pages.push(rows);
  }
  return pages;
}

function unesc(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? String.fromCharCode(parseInt(c, 8))));
}

return { pdfLines, pdfPages };
})();
__m['names.js'] = (function(){
// Section and line name normalisation across TMS reports (TRC page titles, tamping, asset registers).
const ALIASES = [
  ['Bally-Bandel', 'BLY-BDC'], ['Bally-Saktigarh', 'BLY-SKG'], ['Bandel-Saktigarh', 'BDC-SKG'],
  ['Bandel-Katwa Jn', 'BDC-KWA', 'BDC-KWAE Jn', 'BDC-KWAE'], ['Katwa Jn-Azimganj', 'KWAE-AZ', 'KATWAJN-AZIMGANJ'],
  ['Azimganj-Nalhati', 'AZ-NHT'], ['Azimganj-New Farakkha', 'AZ-NFK', 'AZIMGANJ-NEWFARAKKHA'],
  ['Barddhaman-Khana', 'BWN-KAN', 'BWN-KHN'], ['Barddhaman-Katwa', 'BWN-KWAE', 'BWN-KWA'],
  ['Katwa-Ahmadpur', 'KWAE-AMP', 'KATWA-AHMADPUR'], ['Howrah-Bally', 'HWH-BLY'],
  ['HWH-BLY Chord line', 'HWH-BLY Chord', 'Hwh-Bly Chord Line', 'HWH-BLYCHORDLINE'],
  ['Dum Dum Jn-Dankuni', 'DDJ-DKAE', 'DUMDUMJN-DANKUNI'], ['Bhimgara-Sainthia Jn', 'BMGA-SNT', 'BHIMGARA-SAINTHIAJN'],
  ['Saktigarh-Barddhaman', 'SKG-BWN'], ['Howrah - Santragachi', 'Howrah - SRC', 'HWH-SRC'],
  ['Khana-Sainthia', 'KAN-SNT'], ['Sainthia-Nalhati', 'SNT-NHT'], ['Nalhati-Bonidanga Link', 'NHT-BDAG Link'],
  ['Sheoraphuli Jn-Bishnupur', 'SHE-VSU'], ['Rampurhat - Dumka', 'RPH - DUMK'], ['Naihati Jn-Bandel Jn', 'NH-BDC'],
  ['Andul-Dankuni', 'ADL-DKAE'], ['Khanna Jn-Andal Jn', 'KAN-UDL', 'Khana Jn-Andal Jn', 'KHANA-ANDAL'], ['Liluah-Belur Math', 'LLH-BRMH'],
  ['Belanagar- Rajchandrapur', 'BZL - RCD'], ['Rajchandrapur-Bhattanagar', 'RCD-BTNG'], ['Gossaingram-Poradanga', 'GSGB-PRDG'],
  ['Magra-Tribeni Avoiding Line', 'Magra-Tribeni Avoiding line'],
];
const norm = s => String(s || '').toLowerCase().replace(/\bjn\b|junction/g, '').replace(/[^a-z0-9]/g, '');
const MAP = new Map();
for (const g of ALIASES) for (const a of g) MAP.set(norm(a), g[0]);

function sectionName(raw) {
  if (raw == null) return null;
  const k = norm(raw); if (!k) return null;
  if (MAP.has(k)) return MAP.get(k);
  return String(raw).trim().replace(/\s+/g, ' ');
}
function sectionCode(name) {
  const g = ALIASES.find(g => g[0] === name); return g ? g[1] : name;
}

const LINE_DISPLAY = { UP: 'UP', DN: 'DN', REV: 'Rev', UPCH: 'Up Chord', DNCH: 'Dn Chord', '3RD': '3rd Line', SL: 'Single' };
function lineKey(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(up|dn|down)\s*-?\s*(\d)$/))) return (m[1] === 'up' ? 'UP' : 'DN') + m[2];
  if (/up\s*chord/.test(s)) return 'UPCH';
  if (/(dn|down)\s*chord/.test(s)) return 'DNCH';
  if (/rev/.test(s)) return 'REV';
  if (/iii|3rd|third/.test(s)) return '3RD';
  if (/^single|^sl$/.test(s)) return 'SL';
  if (/^up( line)?$|^up\s*main/.test(s)) return 'UP';
  if (/^(dn|down)( line)?$|^(dn|down)\s*main/.test(s)) return 'DN';
  return s.toUpperCase().replace(/\s+/g, ' ');
}
const lineDisplay = k => LINE_DISPLAY[k] || (k && k.replace(/^(UP|DN)(\d)$/, '$1 $2')) || k;
const lineId = (sec, lk) => `${sectionCode(sec)} ${lineDisplay(lk)}`;

return { sectionName, sectionCode, lineKey, lineDisplay, lineId };
})();
__m['sources.js'] = (function(){
// Identify TMS export files and parse them into normalised records. Every source is optional.
const {sectionName, lineKey} = __m['names.js'];

const KINDS = {
  trc: 'TRC km-wise result page', tampSect: 'Sectional tamping', tampTO: 'Turnout tamping', deepScreen: 'Deep screening',
  ballast: 'Ballast register (cushion)', curve: 'Curve register', fpJoint: 'Fish-plated joint register', glued: 'Glued joint register',
  lc: 'Level crossing register', pxing: 'Points & crossings register', diamond: 'Diamond crossing register', sej: 'SEJ register', bridge: 'Bridge register',
  sleeper: 'Sleeper defect exception report', cbmlReport: 'CBML block exception report', tampDue: 'Tamping due (PML/CBML) report',
};

const txt = v => (v == null ? '' : String(v));
const num = v => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
const ch = (km, m) => (num(km) == null ? null : num(km) * 1000 + (num(m) || 0));
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
// returns 'YYYY-MM' (month precision) or null
function ym(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{2})(-\d{2})?/))) return `${m[1]}-${m[2]}`;
  if ((m = s.match(/^(\d{1,2})\/(\d{4})$/))) return `${m[2]}-${m[1].padStart(2, '0')}`;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}`;
  if ((m = s.match(/^([A-Za-z]+)[-\/ ](\d{2,4})$/)) && MON[m[1].toLowerCase()]) { let y = +m[2]; if (y < 100) y += y > 60 ? 1900 : 2000; return `${y}-${String(MON[m[1].toLowerCase()]).padStart(2, '0')}`; }
  return null;
}

function headerMap(rows, must) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i] || []; const names = r.map(x => txt(x).replace(/\s+/g, ' ').trim().toUpperCase());
    if (must.every(k => names.some(n => n === k || n.startsWith(k)))) {
      const map = {}; names.forEach((n, j) => { if (n && map[n] == null) map[n] = j; });
      const get = k => { if (map[k] != null) return map[k]; const f = Object.keys(map).find(n => n.startsWith(k)); return f != null ? map[f] : null; };
      return { row: i, get };
    }
  }
  return null;
}

function classifySheet(rows, sheetName = '') {
  const head = rows.slice(0, 8).map(r => (r || []).map(txt).join(' ')).join(' | ') + ' ' + sheetName;
  const H = head.toUpperCase();
  if (/SECTIONAL TAMPING DETAILS/.test(H)) return 'tampSect';
  if (/TURNOUT TAMPING DETAILS|STATIONS SELECTED/.test(H) && /TURNOUT NO/.test(H)) return 'tampTO';
  if (/DEEP SCREENING REPORT/.test(H)) return 'deepScreen';
  if (/TAMPING DUE AS ON DATE/.test(H)) return 'tampDue';
  if (/DIAMOND/.test(H) && /LINE 1/.test(H)) return 'diamond';
  if (/CURVE REGISTER|RADIUS OF CURVE/.test(H)) return 'curve';
  if (/FISH PLATED JOINT/.test(H)) return 'fpJoint';
  if (/GLUED JOINT/.test(H)) return 'glued';
  if (/LEVEL XING|LEVEL CROSSING/.test(H)) return 'lc';
  if (/POINTS & XING|PXING ID/.test(H)) return 'pxing';
  if (/SEJ REGISTER|SEJ ID/.test(H)) return 'sej';
  if (/BRIDGE REGISTER|BRIDGE ID/.test(H)) return 'bridge';
  if (/BALLAST/.test(H) && /CLEAN CUSHION/.test(H)) return 'ballast';
  return null;
}

function parseSheet(kind, rows) {
  const out = []; const head0 = txt(rows[0]?.[0]);
  if (kind === 'tampSect') {
    const sec = sectionName((head0.match(/Section\s*:\s*([^\n|]+)/) || [])[1]);
    for (const r of rows) {
      const a = ch(r[1], r[2]), b = ch(r[3], r[4]); const lk = lineKey(r[0]);
      if (a == null || b == null || !lk || /^\s*(total|line)\s*$/i.test(txt(r[0]))) continue;
      out.push({ section: sec, line: lk, a, b, date: ym(r[6]), machine: txt(r[7]).trim() || null });
    }
  } else if (kind === 'tampTO') {
    for (const r of rows) {
      if (num(r[0]) == null) continue;
      out.push({ section: sectionName(r[1]), station: txt(r[2]).trim(), line: lineKey(r[3]), toNo: txt(r[4]).trim(), pos: ch(r[5], r[6]), date: ym(r[7]), machine: txt(r[8]).trim() || null });
    }
  } else if (kind === 'deepScreen') {
    for (const r of rows) {
      if (num(r[0]) == null || num(r[3]) == null) continue;
      out.push({ section: sectionName(r[1]), line: lineKey(r[2]), a: ch(r[3], r[4]), b: ch(r[5], r[6]), means: txt(r[8]).trim(), date: ym(r[9]) });
    }
  } else if (kind === 'tampDue') {
    for (const r of rows) {
      if (num(r[0]) == null || !r[1]) continue;
      out.push({ section: sectionName(r[1]), line: lineKey(r[3]), tkm: num(r[4]), pmlDue: num(r[5]), cbmlReq: num(r[6]), cbmlDone: num(r[7]), cbmlDue: num(r[8]), pxReq: num(r[9]), pxDone: num(r[10]), pxDue: num(r[11]) });
    }
  } else {
    const spec = {
      ballast: ['SECTION', 'LINE', 'KM FROM'], curve: ['SECTION', 'LINE', 'KM FROM'], fpJoint: ['SECTION', 'LINE', 'KM FROM'],
      glued: ['SECTION', 'LINE', 'KM FROM'], lc: ['SECTION', 'LOCATION'], pxing: ['LINE', 'KM'], sej: ['SECTION', 'LINE', 'KM FROM'], diamond: ['LINE 1: KM'], bridge: ['BRIDGE NO.', 'KM FROM', 'MET FROM'],
    }[kind];
    const hm = headerMap(rows, spec); if (!hm) return out;
    const g = hm.get;
    for (const r of rows.slice(hm.row + 1)) {
      if (!r || !r.length) continue;
      const sec = sectionName(r[g('SECTION')] ?? r[g('SECTION/STATION')]);
      if (kind === 'ballast') {
        const a = ch(r[g('KM FROM')], r[g('MET FROM')]), b = ch(r[g('KM TO')], r[g('MET TO')]); if (a == null || b == null) continue;
        out.push({ section: sec, line: lineKey(r[g('LINE')]), a, b, clean: num(r[g('CLEAN CUSHION')]), total: num(r[g('TOTAL CUSHION')]), sdate: ym(r[g('SCREENING DATE')]), method: txt(r[g('SCREENING METHOD')]) });
      } else if (kind === 'curve') {
        const a = ch(r[g('KM FROM')], r[g('MET FROM')]), b = ch(r[g('KM TO')], r[g('MET TO')]); if (a == null || b == null) continue;
        out.push({ section: sec, line: lineKey(r[g('LINE')]), a: Math.min(a, b), b: Math.max(a, b), radius: num(r[g('RADIUS OF CURVE')]), degree: num(r[g('DEGREE')]), versine: num(r[g('DESIGN VERSINE')]), se: num(r[g('SUPER ELEVATION')]), no: txt(r[g('CURVE NO')]), type: txt(r[g('CURVE TYPE')]) });
      } else if (kind === 'fpJoint') {
        const p = ch(r[g('KM FROM')], r[g('MET FROM')]); if (p == null) continue;
        out.push({ section: sec, line: lineKey(r[g('LINE')]), pos: p, rail: txt(r[g('LR/RR')]), laid: ym(r[g('MONTH OF LAYING')]), xover: txt(r[g('XOVER')]) });
      } else if (kind === 'glued') {
        const p = ch(r[g('KM FROM')], r[g('MET FROM')]); if (p == null) continue;
        out.push({ section: sec, line: lineKey(r[g('LINE')]), pos: p, rail: txt(r[g('LR/RR')]), laid: ym(r[g('LAYING DATE')]), no: txt(r[g('GLUED JOINT NO')]) });
      } else if (kind === 'bridge') {
        // the register has no line column: a bridge carries every line of its section ('*'); bridges over the track (ROB / FOB) are left out
        const use = txt(r[g('BRIDGE USAGE TYPE')]); if (/^(ROB|FOB)$/i.test(use.trim())) continue;
        const a = ch(r[g('KM FROM')], r[g('MET FROM')]), b = ch(r[g('KM TO')], r[g('MET TO')]); if (a == null) continue;
        out.push({ section: sec || sectionName(r[g('STATION')]), line: '*', a: Math.min(a, b ?? a), b: Math.max(a, b ?? a), no: txt(r[g('BRIDGE NO.')]), type: [txt(r[g('BRIDGE TYPE')]), use, txt(r[g('BRIDGE CATEGORY')])].filter(x => x && !/not applicable/i.test(x)).join(', ') });
      } else if (kind === 'sej') {
        const p = ch(r[g('KM FROM')], r[g('MET FROM')]); if (p == null) continue;
        out.push({ section: sec, station: txt(r[g('STATION')]).trim(), line: lineKey(r[g('LINE')]), pos: p, no: txt(r[g('SEJ NO')]) });
      } else if (kind === 'pxing') {
        const p = ch(r[g('KM')], r[g('M')]); if (p == null) continue;
        out.push({ section: sec, station: txt(r[g('OPERATING STATION')]).trim(), lineType: txt(r[g('LINE TYPE')]), line: lineKey(r[g('LINE')]), pos: p, no: txt(r[g('PXING NO')]), type: txt(r[g('TYPE')]), clean: num(r[g('CLEAN CUSHION')]), total: num(r[g('TOTAL CUSHION')]), lastTamp: ym(r[g('LAST TAMPING DATE')]), lastDS: ym(r[g('LAST DEEP SCREENING')]) });
      } else if (kind === 'diamond') {
        for (const k of ['LINE 1', 'LINE 2']) {
          const p = ch(r[g(k + ': KM')], r[g(k + ': MET')]); if (p == null) continue;
          out.push({ section: sectionName(r[g(k + ': SECTION/STATION')]), line: lineKey(r[g(k + ': LINE/LOOPLINE')]), pos: p, no: txt(r[g('PXING NO')]), type: 'Diamond', lastTamp: ym(r[g('LAST TAMPING DATE')]) });
        }
      } else if (kind === 'lc') {
        const loc = txt(r[g('LOCATION')]);
        for (const part of loc.split(',')) {
          const m = part.trim().match(/^(.+?)-(\d+)\s*km\s*(\d+)\s*m/i); if (!m) continue;
          out.push({ section: sec, line: lineKey(m[1]), pos: +m[2] * 1000 + +m[3], no: txt(r[g('LEVEL CROSSING NO')]), cls: txt(r[g('CLASS')]), manning: txt(r[g('MANNING')]) });
        }
      }
    }
  }
  return out;
}

// ---- PDF reports (from pdfLines) ----
function classifyPdf(lines) {
  const t = lines.slice(0, 6).join(' ').toUpperCase();
  if (/COMPONENT DEFECTS-SLEEPER/.test(t)) return 'sleeper';
  if (/BLOCKS EXCEEDING CBML/.test(t)) return 'cbmlReport';
  return null;
}
const MONS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
function parsePdf(kind, lines) {
  const all = lines.join('\n');
  if (kind === 'sleeper') {
    const m = all.match(/Section:\s*(.+?)\s+Line:\s*(.+?)\s+KM\s*:/); const d = all.match(/RUN Date\s*:\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    const meta = { section: sectionName(m && m[1]), line: lineKey(m && m[2]), run: d ? `${d[3]}-${MONS[d[2].toUpperCase()]}-${d[1].padStart(2, '0')}` : null };
    const rows = [];
    for (const L of lines) { const r = L.trim().match(/^(\d+)\s+([1-5])\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/); if (r) { const v = r.slice(1).map(Number); rows.push({ ...meta, km: v[0], block: v[1], broken: v[2], spalling: v[3], cracked: v[4], misaligned: v[5], dancing: v[6], spacing: v[7] }); } }
    return rows.length ? rows : [{ ...meta, km: null }];
  }
  if (kind === 'cbmlReport') {
    const m = all.match(/SECTION\s*:\s*(.+?)\s+KM\s*:\s*(\d+)\s*To\s*(\d+).*?RUN DATE\s*:\s*(\d{2})-([A-Z]{3})-(\d{2})\s*SPEED BAND\s*:\s*([^\n]+)/i);
    const rows = lines.filter(L => /^\s*\d+\s+[1-5]\s+/.test(L));
    return [{ section: sectionName(m && m[1]), kmFrom: m ? +m[2] : null, kmTo: m ? +m[3] : null, run: m ? `20${m[6]}-${MONS[m[5].toUpperCase()]}-${m[4]}` : null, band: m ? m[7].trim() : null, blocks: rows.length, pct: (all.match(/limits - \(([\d.]*)\)%/) || [])[1] || '' }];
  }
  return [];
}

return { KINDS, ym, classifySheet, parseSheet, classifyPdf, parsePdf };
})();
__m['analysis.js'] = (function(){
// TRC analysis engine: IRPWM 2024 Ch.5 limits + TMS data. Works with whatever sources are present.
const {BLKCOLS, DISTCOLS, PARAMS} = __m['page.js'];
const {lineDisplay, sectionCode} = __m['names.js'];

// ---------------- limits (IRPWM 2024 Para 522) ----------------
const BANDS = [
  { top: 100, label: 'up to 100', UN1: [5.0, 6.8, 20], AL1: [3.3, 4.9, 15], UN2: [null, null, null], AL2: [null, null, null], TW1: [5.0, 7.0], ACC: 0.30,
    G: { s: [-10, 12, -12, 15], c1: [-7, 17, -11, 20], c2: [-6, 22, -8, 25] } },
  { top: 110, label: '>100 to 110', UN1: [3.8, 5.5, 17], AL1: [2.5, 3.9, 12], UN2: [5.4, 7.5, 23], AL2: [4.1, 6.7, 20], TW1: [4.0, 7.0], ACC: 0.30,
    G: { s: [-10, 12, -12, 15], c1: [-7, 17, -11, 20], c2: [-6, 22, -8, 25] } },
  { top: 130, label: '>110 to 130', UN1: [3.3, 4.9, 15], AL1: [2.5, 3.6, 11], UN2: [5.1, 7.4, 22], AL2: [3.5, 5.3, 16], TW1: [4.0, 6.0], ACC: 0.25,
    G: { s: [-10, 12, -12, 15], c1: [-7, 17, -11, 20], c2: [-6, 22, -8, 25] } },
  { top: 160, label: '>130 to 160', UN1: [2.9, 4.4, 13], AL1: [1.9, 3.6, 11], UN2: [4.4, 6.6, 20], AL2: [2.5, 4.9, 15], TW1: [3.5, 5.0], ACC: 0.20,
    G: { s: [-8, 12, -10, 15], c1: [-6, 16, -9, 20], c2: [-6, 22, -8, 25] } },
];
const band = sp => BANDS.find(b => sp <= b.top) || BANDS[BANDS.length - 1];

const n = v => { if (v === '' || v == null) return null; const x = +v; return isFinite(x) ? x : null; };
const maxLR = (r, p) => { const a = r[p + 'L'], b = r[p + 'R']; if (a == null && b == null) return null; return Math.max(a ?? -1e9, b ?? -1e9); };
const ymOf = d => (d ? d.slice(0, 7) : null);
const monthsBetween = (a, b) => { if (!a || !b) return null; const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
const fmtYM = s => { if (!s) return '—'; const [y, m] = s.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1] + '-' + y; };
const kmm = pos => `${Math.floor(pos / 1000)}/${Math.round(pos % 1000)}`;

// ---------------- helpers ----------------
function byLine(recs, section, line) { return (recs || []).filter(r => r.section === section && r.line === line); }
function overlapping(list, a, b) { return list.filter(r => r.a < b && r.b > a); }
function near(list, pos, d) { return list.filter(r => Math.abs(r.pos - pos) <= d); }
function dedupe(recs, keyFn) { const s = new Set(), out = []; for (const r of recs) { const k = keyFn(r); if (!s.has(k)) { s.add(k); out.push(r); } } return out; }

// ---------------- main ----------------
function analyse(store, opts = {}) {
  const pages = store.pages.filter(p => p.section && p.line && p.date && p.km != null);
  const lines = new Map();
  for (const p of pages) { const k = p.section + '|' + p.line; if (!lines.has(k)) lines.set(k, []); lines.get(k).push(p); }
  const result = { lines: [], blocks: [], kms: [], peaks: [], stretches: [], todo: [], yards: [], checks: [], availability: [], crossTMS: [], trend: [] };
  for (const [key, ps] of [...lines.entries()].sort()) {
    const [section, line] = key.split('|');
    const runs = [...new Set(ps.map(p => p.date))].sort();
    const run = runs[runs.length - 1], prev = runs.length > 1 ? runs[runs.length - 2] : null;
    const L = analyseLine(store, section, line, ps.filter(p => p.date === run), run);
    // jobs come from the latest run that recorded each km (laser or contact): km the latest run did not record keep
    // the newest earlier run's findings, labelled with that run
    const latestKm = new Set(ps.filter(p => p.date === run).map(p => p.km)); const best = new Map();
    for (const p of ps.filter(p => p.date !== run && !latestKm.has(p.km)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.part || 0) - (a.part || 0)))) if (!best.has(p.km)) best.set(p.km, p);
    if (best.size) {
      const CL = analyseLine(store, section, line, [...ps.filter(p => p.date === run), ...best.values()], run);
      L.todo = CL.todo.map(t => { const o = best.get(t.km ?? Math.floor((t.pos || 0) / 1000)); return o ? Object.assign(t, { run: o.date, olderRun: true }) : t; });
    }
    L.summary.kms = [...new Set([...latestKm, ...best.keys()])].sort((a, b) => a - b);
    L.summary.sensor = mode(ps.filter(p => p.date === run).map(p => p.sensor).filter(Boolean)) || null;
    if (prev) {
      const P = analyseLine(store, section, line, ps.filter(p => p.date === prev), prev, true);
      const pm = new Map(P.blocks.map(b => [b.km + ':' + b.block, b]));
      for (const b of L.blocks) { const o = pm.get(b.km + ':' + b.block); if (o) { b.prevStatus = o.irpwm; b.prevTMS = o.MI; b.repeat = (o.irpwm === 'N' || o.MI === 'N') && (b.irpwm === 'N' || b.MI === 'N'); } }
      L.summary.prevRun = prev; L.summary.prevCbml = P.summary.cbml; L.summary.prevTqic = P.summary.avgTqic;
      result.trend.push({ lineId: L.summary.lineId, run, prev, cbml: L.summary.cbml, prevCbml: P.summary.cbml, tqic: L.summary.avgTqic, prevTqic: P.summary.avgTqic, repeat: L.blocks.filter(b => b.repeat).length });
    }
    result.lines.push(L.summary); result.blocks.push(...L.blocks); result.kms.push(...L.kms); result.peaks.push(...L.peaks);
    result.stretches.push(...L.stretches); result.todo.push(...L.todo); result.yards.push(...L.yards); result.availability.push(L.avail);
    result.checks.push(...L.checks);
  }
  // cross-check with TMS tamping-due report
  for (const s of result.lines) {
    const t = (store.tampDue || []).find(r => r.section === s.section && r.line === s.line);
    if (t) result.crossTMS.push({ lineId: s.lineId, run: s.run, tkmTMS: t.tkm, kmRecorded: s.kmRecorded, mine: +(s.cbml * 0.2).toFixed(1), miCol: +(s.tmsN * 0.2).toFixed(1), tmsReq: t.cbmlReq, tmsDone: t.cbmlDone, tmsDue: t.cbmlDue, pmlDue: t.pmlDue,
      match: Math.abs(s.cbml * 0.2 - t.cbmlReq) <= 0.25 ? 'Match (≤1 block)' : 'Differs', note: t.tkm < s.kmRecorded * 0.9 ? 'TRC run extends outside HWH section length' : (s.kmRecorded < t.tkm * 0.85 ? 'Some km pages missing' : '') });
    for (const c of (store.cbmlReport || []).filter(r => r.section === s.section && r.run === s.run)) result.checks.push({ lineId: s.lineId, check: `TMS CBML block exception report (run ${s.run}, ${c.band})`, result: `TMS: ${c.blocks} block(s) | calculated: ${s.cbml}`, verdict: c.blocks === s.cbml ? 'MATCH' : 'DIFFERS – check' });
  }
  result.division = summariseDivision(result);
  return result;
}

function analyseLine(store, section, line, pagesIn, run, light = false) {
  const lineId = `${sectionCode(section)} ${lineDisplay(line)}`;
  // one page per km
  const seen = new Set(), pages = [];
  // a run entered in parts may hold the same km twice: the later upload (higher TMS run id) wins
  for (const p of pagesIn.sort((a, b) => a.km - b.km || (b.part || 0) - (a.part || 0))) { if (!seen.has(p.km)) { seen.add(p.km); pages.push(p); } }
  const speed = mode(pages.map(p => p.speed).filter(Boolean)) || 110; const B = band(speed);
  const src = k => byLine(store[k], section, line);
  const curves = src('curve'), fps = src('fpJoint'), gjs = src('glued'), lcs = src('lc'), sejs = src('sej');
  const pxs = [...src('pxing').filter(x => !x.lineType || /main/i.test(x.lineType)), ...src('diamond')];
  const tampS = src('tampSect'), tampT = src('tampTO'), ds = src('deepScreen'), bal = src('ballast');
  const sleeperAll = src('sleeper').filter(r => r.km != null);
  const slRun = sleeperAll.length ? [...new Set(sleeperAll.map(r => r.run))].sort().pop() : null;
  const sleepers = sleeperAll.filter(r => r.run === slRun);
  const curveAt = pos => curves.find(c => pos >= c.a && pos <= c.b);

  const blocks = [], peaks = [], kms = [], checks = [];
  for (const p of pages) {
    const km = p.km;
    // ---- peaks (top-10 lists + TMS UML list)
    const pl = [];
    for (const prm of PARAMS) {
      const v = p.peaks[prm] || [];
      for (let j = 0; j < 10; j++) { const val = n(v[2 * j]), d = n(v[2 * j + 1]); if (val != null && d != null) pl.push({ param: prm, rank: j + 1, value: val, dist: d, src: 'list' }); }
    }
    const umlSet = new Set();
    for (const row of p.uml || []) for (let j = 0; j < 10; j++) { const val = n(row[1 + 2 * j]), d = n(row[2 + 2 * j]); if (val != null && d != null) { umlSet.add(row[0] + '|' + val + '|' + d); pl.push({ param: row[0], rank: j + 1, value: val, dist: d, src: 'uml' }); } }
    const kept = [];
    for (const q of pl) {
      if (q.src === 'list' && umlSet.has(q.param + '|' + q.value + '|' + q.dist)) continue;
      const pos = km * 1000 + q.dist; const cv = curveAt(pos);
      let status = '', limit = '';
      if (q.param === 'G') {
        const g = !cv ? B.G.s : (cv.radius >= 440 ? B.G.c1 : B.G.c2);
        if (q.value < g[2] || q.value > g[3]) { status = 'UML'; limit = `${g[2]}/+${g[3]}`; } else if (q.value < g[0] || q.value > g[1]) { status = 'NBML'; limit = `${g[0]}/+${g[1]}`; }
      } else if (q.param === 'TW1') { const a = Math.abs(q.value); if (a > B.TW1[1] * 3) { status = 'UML'; limit = B.TW1[1] * 3; } else if (a > B.TW1[0] * 3) { status = 'NBML'; limit = B.TW1[0] * 3; } }
      else if (q.param.endsWith('ACCN')) { if (Math.abs(q.value) > B.ACC) { status = 'UML'; limit = B.ACC + ' g'; } }
      else { const lim = B[q.param.slice(0, 3)]?.[2]; if (lim != null && Math.abs(q.value) > lim) { status = 'NBML'; limit = lim; } }
      if (q.src === 'uml') {
        status = 'UML';
        if (q.param === 'G') { const g = !cv ? B.G.s : (cv.radius >= 440 ? B.G.c1 : B.G.c2); limit = `${g[2]}/+${g[3]}`; }
        else if (q.param === 'TW1') limit = B.TW1[1] * 3; else if (q.param.endsWith('ACCN')) limit = B.ACC + ' g'; else limit = 'TMS';
      }
      if (!status) continue;
      kept.push({ ...q, status, limit, pos, block: Math.min(5, Math.floor(q.dist / 200) + 1), curve: cv ? `R${cv.radius}` : '' });
    }
    // cluster within 10 m (same param, status)
    const cl = [];
    for (const grp of groupBy(kept, q => q.param + '|' + q.status)) {
      grp.sort((a, b) => a.dist - b.dist); let cur = null;
      for (const q of grp) { if (cur && q.dist - cur.to <= 10) { cur.to = q.dist; cur.n++; if (Math.abs(q.value) > Math.abs(cur.value)) cur.value = q.value; } else { cur = { ...q, from: q.dist, to: q.dist, n: 1 }; cl.push(cur); } }
    }
    for (const c of cl) {
      const ctx = [];
      const fp = near(fps, c.pos, 5); if (fp.length) ctx.push(`FP joint (${fp.map(x => x.rail).join('/')})`);
      const gj = near(gjs, c.pos, 5); if (gj.length) ctx.push('Glued joint');
      const sj = near(sejs, c.pos, 20); if (sj.length) ctx.push(`SEJ ${sj[0].no}`);
      const lc = near(lcs, c.pos, 30); if (lc.length) ctx.push(`LC ${lc[0].no}`);
      const to = near(pxs, c.pos, 40); if (to.length) ctx.push(`Turnout ${to.map(x => x.no).join(',')}`);
      if (c.curve) ctx.push('Curve ' + c.curve);
      c.context = ctx.join('; ');
      c.loc = `${km}/${Math.round(c.from)}` + (c.to > c.from ? `-${Math.round(c.to)}` : '');
      c.text = `${c.param} ${c.value} @ ${c.loc}` + (c.context ? ` [${c.context}]` : '');
      peaks.push({ lineId, section, line, run, km, ...c });
    }
    // ---- blocks
    const bseen = new Set();
    p.blocks.forEach((row, i) => {
      const lab = String(row[0] || ''); let bn = +lab.slice(-1); if (!(bn >= 1 && bn <= 5)) bn = i + 1;
      if (bseen.has(bn)) return; bseen.add(bn);
      const r = { lineId, section, line, run, speed, km, block: bn };
      BLKCOLS.forEach((c, j) => r[c] = (c === 'MI' || c === 'MI_G') ? (row[j + 1] || '') : n(row[j + 1]));
      r.recorded = ['UN1L', 'UN1R', 'AL1L', 'AL1R'].some(c => r[c] != null);
      if (!r.recorded) return;
      // OCR self-check
      if (r.UNI1 != null && r.ALI1 != null && r.TQIS != null && Math.abs(r.TQIS - (r.UNI1 + r.ALI1) / 2) > 0.02) checks.push({ lineId, check: `OCR check km ${km} B${bn}`, result: 'TQIS ≠ (UNI1+ALI1)/2', verdict: 'Re-check page' });
      r.a = km * 1000 + (bn - 1) * 200; r.b = r.a + 200; r.loc = `${km}/${(bn - 1) * 200} – ${km}/${bn * 200}`;
      let st = '0'; const drv = [];
      for (const prm of ['UN1', 'AL1', 'UN2', 'AL2']) {
        const [pml, nb] = B[prm]; if (pml == null) continue; const v = maxLR(r, prm); if (v == null) continue;
        const sd = (r[prm + 'L'] ?? -1e9) >= (r[prm + 'R'] ?? -1e9) ? 'L' : 'R';
        if (v > nb) { st = 'N'; drv.push(`${prm}${sd} SD ${v.toFixed(2)} > ${nb} (NBML)`); } else if (v > pml) { if (st !== 'N') st = 'P'; drv.push(`${prm}${sd} SD ${v.toFixed(2)} > ${pml} (PML)`); }
      }
      r.irpwm = st; r.drivers = drv.join('; ');
      // closeness to NBML (worst of UN1/AL1/UN2/AL2): 1.0 = at the CBML line
      let rk = 0, rkP = '';
      for (const prm of ['UN1', 'AL1', 'UN2', 'AL2']) { const nb = B[prm][1]; const v = maxLR(r, prm); if (nb == null || v == null) continue; if (v / nb > rk) { rk = v / nb; rkP = `${prm}${(r[prm + 'L'] ?? -1e9) >= (r[prm + 'R'] ?? -1e9) ? 'L' : 'R'} SD ${v.toFixed(2)} vs NBML ${nb}`; } }
      r.risk = +rk.toFixed(3); r.riskBy = rkP;
      r.atRisk = st !== 'N' && r.MI !== 'N' && rk >= 0.85;
      r.gauge = r.MI_G === '4' ? 'UML' : r.MI_G === '3' ? 'NBML' : '';
      const bp = cl.filter(c => c.block === bn);
      r.nbml = bp.filter(c => c.status === 'NBML'); r.uml = bp.filter(c => c.status === 'UML');
      r.nbmlN = r.nbml.length; r.umlN = r.uml.length;
      r.nbmlList = r.nbml.map(c => c.text).join('; '); r.umlList = r.uml.map(c => c.text).join('; ');
      // context
      const cvs = overlapping(curves, r.a, r.b); r.curve = cvs.map(c => `R${c.radius}${c.no ? ' (C' + c.no + ')' : ''}`).join(', ');
      const tos = pxs.filter(x => x.pos >= r.a && x.pos < r.b); r.turnouts = tos.map(x => x.no + (x.lastTamp ? ` (tamped ${fmtYM(x.lastTamp)})` : '')).join(', ');
      r.toCleanMin = tos.length ? Math.min(...tos.map(x => x.clean ?? 999)) : null; if (r.toCleanMin === 999) r.toCleanMin = null;
      r.lc = lcs.filter(x => x.pos >= r.a - 30 && x.pos < r.b + 30).map(x => x.no).join(', ');
      r.sej = sejs.filter(x => x.pos >= r.a && x.pos < r.b).map(x => x.no).join(', ');
      r.fpN = fps.filter(x => x.pos >= r.a && x.pos < r.b).length; r.gjN = gjs.filter(x => x.pos >= r.a && x.pos < r.b).length;
      // history
      const ts = overlapping(tampS, r.a, r.b).filter(t => t.date);
      r.tampLast = ts.length ? ts.map(t => t.date).sort().pop() : null; r.tampMachine = [...new Set(ts.filter(t => t.date === r.tampLast).map(t => t.machine))].join(', ');
      const tto = tampT.filter(t => t.pos >= r.a && t.pos < r.b && t.date); if (tto.length) { const d = tto.map(t => t.date).sort().pop(); if (!r.tampLast || d > r.tampLast) { r.tampLastTO = d; } }
      const dss = overlapping(ds, r.a, r.b).filter(t => t.date); r.dsLast = dss.length ? dss.map(t => t.date).sort().pop() : null;
      const bb = overlapping(bal, r.a, r.b).filter(t => t.clean != null); r.cleanMin = bb.length ? Math.min(...bb.map(t => t.clean)) : null; r.totalMin = bb.length ? Math.min(...bb.filter(t => t.total != null).map(t => t.total)) : null;
      if (!isFinite(r.totalMin)) r.totalMin = null;
      const sl = sleepers.filter(s => s.km === km && s.block === bn);
      r.slCracked = sl.length ? sl.reduce((a, s) => a + s.cracked + s.spalling, 0) : (sleepers.length ? 0 : null);
      r.slMisaligned = sl.length ? sl.reduce((a, s) => a + s.misaligned, 0) : (sleepers.length ? 0 : null);
      r.slRun = sleepers.length ? slRun : null;
      blocks.push(r);
    });
  }
  // ---- decisions per block
  const hasTamp = tampS.length > 0, hasBal = bal.length > 0, hasDS = ds.length > 0;
  const runYM = ymOf(run);
  for (const r of blocks) {
    r.problem = r.irpwm !== '0' || r.MI === 'N' || r.MI === 'P' || r.nbmlN > 0 || r.umlN > 0 || r.gauge !== '';
    const flags = [];
    let state = '';
    if (r.problem) {
      if (!hasTamp) state = 'Pending (no tamping data)';
      else if (r.tampLast && r.tampLast > runYM) { state = 'Attended after TRC run'; flags.push(`Tamped ${fmtYM(r.tampLast)} (${r.tampMachine}) after TRC run ${fmtYM(runYM)}`); }
      else if (r.tampLast && r.tampLast === runYM) { state = 'Check: tamped in run month'; flags.push(`Tamped ${fmtYM(r.tampLast)} – same month as TRC run`); }
      else state = 'Pending';
      const mo = monthsBetween(r.tampLast, runYM);
      if (r.tampLast && mo != null && mo > 0 && mo <= 12 && (r.irpwm !== '0' || r.MI === 'N' || r.MI === 'P')) flags.push(`Tamping not holding: tamped ${fmtYM(r.tampLast)} (${mo} months before run), still ${r.irpwm === 'N' ? 'CBML' : r.MI === 'N' ? 'TMS MI = N' : 'over PML'}`);
      if (r.tampLast && mo != null && mo > 24) flags.push(`Last tamped ${fmtYM(r.tampLast)} (over 2 years before run)`);
    }
    const lim = speed >= 130 ? 200 : 150;
    if (r.cleanMin != null && r.cleanMin < lim) flags.push(`Clean cushion ${r.cleanMin} mm < ${lim} mm (Para 636(2)(e))`);
    if (r.toCleanMin != null && r.toCleanMin < 200 && r.turnouts) flags.push(`Turnout clean cushion ${r.toCleanMin} mm < 200 mm`);
    if (r.problem && r.dsLast && monthsBetween(r.dsLast, runYM) > 120) flags.push(`Last deep screening ${fmtYM(r.dsLast)} (>10 yrs)`);
    if (r.problem && r.slCracked >= 5) flags.push(`${r.slCracked} cracked/spalled sleepers (report ${r.slRun})`);
    r.state = state; r.rootCause = flags.join('; ');
    r.priority = (r.umlN > 0 || r.gauge === 'UML') ? '1-Urgent' : (r.irpwm === 'N' || r.MI === 'N') ? '2-Tamping (CBML block)' : (r.nbmlN > 0 || r.gauge === 'NBML') ? '3-Spot attention' : (r.irpwm === 'P' || r.MI === 'P') ? '4-Planned (PML)' : '';
    r.actions = blockActions(r, speed);
    r.action = r.actions.join('; ');
  }
  // ---- yards & block sections (P&C / SEJ based, Para 523(3))
  const yards = [];
  const stByName = groupBy(pxs.filter(x => x.station), x => x.station);
  for (const g of stByName) { const ps2 = g.map(x => x.pos); yards.push({ lineId, station: g[0].station, a: Math.min(...ps2) - 50, b: Math.max(...ps2) + 50, n: g.length }); }
  yards.sort((a, b) => a.a - b.a);
  for (const r of blocks) { const y = yards.find(y => r.a < y.b && r.b > y.a); r.zone = y ? `Yard ${y.station}` : 'Block section'; }
  const zones = [];
  if (blocks.length) {
    let cur = null;
    for (const r of [...blocks].sort((a, b) => a.a - b.a)) {
      if (!cur || cur.zone !== r.zone) { cur = { lineId, zone: r.zone, from: r.a, to: r.b, blocks: 0, overPML: 0, cbml: 0 }; zones.push(cur); }
      cur.to = r.b; cur.blocks++; if (r.irpwm !== '0') cur.overPML++; if (r.irpwm === 'N') cur.cbml++;
    }
    for (const z of zones) { z.pct = z.blocks ? z.overPML / z.blocks : 0; z.limit = z.zone.startsWith('Yard') ? 0.5 : 0.4; z.through = z.pct > z.limit && z.blocks >= (z.zone.startsWith('Yard') ? 3 : 5) && z.overPML >= 3; z.loc = `${kmm(z.from)} – ${kmm(z.to)}`; }
  }
  // ---- stretches
  const stretches = [];
  const cand = blocks.filter(r => r.irpwm === 'N' || r.MI === 'N').sort((a, b) => a.a - b.a);
  let grp = [];
  const flush = () => {
    if (!grp.length) return;
    const a = grp[0].a, b = grp[grp.length - 1].b; const inside = blocks.filter(r => r.a >= a && r.b <= b);
    const id = `${lineId} T${String(stretches.length + 1).padStart(2, '0')}`;
    inside.forEach(r => r.stretch = id);
    const drv = [...new Set(grp.flatMap(r => r.drivers.split('; ').filter(Boolean)))];
    const attended = inside.filter(r => r.problem).every(r => r.state === 'Attended after TRC run');
    stretches.push({ id, lineId, run, speed, from: kmm(a), to: kmm(b), a, b, length: b - a, cbml: grp.filter(r => r.irpwm === 'N').length, tmsN: grp.filter(r => r.MI === 'N').length, gaps: inside.length - grp.length,
      kind: drv.some(d => d.startsWith('AL')) && drv.some(d => d.startsWith('UN')) ? 'lift + lining' : drv.some(d => d.startsWith('AL')) ? 'lining' : 'lift + pack',
      drivers: drv.join('; ') || 'TMS MI = N', turnouts: inside.map(r => r.turnouts).filter(Boolean).join(', '), lowCushion: inside.some(r => r.rootCause.includes('Clean cushion')), attended });
    grp = [];
  };
  for (const r of cand) { if (grp.length && r.a - grp[grp.length - 1].b > 200) flush(); grp.push(r); }
  flush();
  // ---- km summary
  for (const p of pages) {
    const kb = blocks.filter(r => r.km === p.km); const kp = peaks.filter(q => q.km === p.km);
    const d = (b, c) => n((p.dist[b] || [])[DISTCOLS.indexOf(c)]) || 0;
    const k = { lineId, section, line, run, speed, km: p.km, recorded: kb.length > 0, kmTqic: p.kmTqic ?? null, blocks: kb.length,
      cbml: kb.filter(r => r.irpwm === 'N').length, cbmlList: kb.filter(r => r.irpwm === 'N').map(r => 'B' + r.block).join(', '), tmsN: kb.filter(r => r.MI === 'N').length,
      pml: kb.filter(r => r.irpwm !== '0').length,
      pUN1: d('CBML', 'UN1L') + d('CBML', 'UN1R'), pAL1: d('CBML', 'AL1L') + d('CBML', 'AL1R'), pTW1: d('CBML', 'TW1'), pUN2: d('CBML', 'UN2L') + d('CBML', 'UN2R'), pAL2: d('CBML', 'AL2L') + d('CBML', 'AL2R'),
      uTW1: d('UML', 'TW1'), uG: d('UML', 'GAUGE'), uACC: d('UML', 'LACC') + d('UML', 'VACC'),
      gN: kb.filter(r => r.gauge === 'NBML').length, gU: kb.filter(r => r.gauge === 'UML').length,
      worstGauge: kb.length ? Math.min(...kb.map(r => r.AVG ?? 0)) : null, tqic: kb.length ? avg(kb.map(r => r.TQIC).filter(v => v != null)) : null,
      curve: [...new Set(kb.map(r => r.curve).filter(Boolean))].join(', '), action: kmAction(kb) };
    k.cbmlPeaks = k.pUN1 + k.pAL1 + k.pTW1 + k.pUN2 + k.pAL2; k.umlPeaks = k.uTW1 + k.uG + k.uACC;
    k.score = k.umlPeaks * 10 + k.gU * 10 + k.cbml * 5 + k.gN * 2 + k.cbmlPeaks;
    kms.push(k);
  }
  for (const k of kms) k.rank = k.score > 0 ? 1 + kms.filter(x => x.score > k.score).length : null;
  // ---- to-do
  const landmarks = [
    ...lcs.map(x => ({ pos: x.pos, name: `LC ${x.no}` })), ...pxs.map(x => ({ pos: x.pos, name: `Turnout ${x.no}${x.station ? ' (' + x.station + ')' : ''}` })),
    ...sejs.map(x => ({ pos: x.pos, name: `SEJ ${x.no || ''}`.trim() })), ...gjs.map(x => ({ pos: x.pos, name: 'Glued joint' })),
    ...curves.flatMap(c => [{ pos: c.a, name: `Curve R${c.radius} start` }, { pos: c.b, name: `Curve R${c.radius} end` }]),
  ].filter(x => x.pos != null && isFinite(x.pos));
  const todo = light ? [] : buildTodo({ lineId, run, speed, B, blocks, peaks, stretches, zones, kms, landmarks });
  // ---- availability
  const avail = { lineId, section, line, run, speed, pages: pages.length, kmFrom: pages.length ? pages[0].km : null, kmTo: pages.length ? pages[pages.length - 1].km : null,
    sources: { tampSect: tampS.length, tampTO: tampT.length, deepScreen: ds.length, ballast: bal.length, curve: curves.length, fpJoint: fps.length, glued: gjs.length, lc: lcs.length, pxing: pxs.length, sej: sejs.length, sleeper: sleepers.length ? `${sleepers.length} (run ${slRun})` : 0, cbmlReport: (store.cbmlReport || []).filter(r => r.section === section && r.run === run).length, tampDue: (store.tampDue || []).filter(r => r.section === section && r.line === line).length } };
  const summary = { lineId, section, line, run, speed, band: B.label, kmRecorded: kms.filter(k => k.recorded).length, blocks: blocks.length,
    cbml: blocks.filter(r => r.irpwm === 'N').length, tmsN: blocks.filter(r => r.MI === 'N').length, pml: blocks.filter(r => r.irpwm !== '0').length,
    cbmlPeaks: sum(kms.map(k => k.cbmlPeaks)), umlPeaks: sum(kms.map(k => k.umlPeaks)), umlGauge: sum(kms.map(k => k.uG)), umlTwist: sum(kms.map(k => k.uTW1)),
    gaugeBlocks: blocks.filter(r => r.gauge).length, stretches: stretches.length, tampKm: sum(stretches.map(s => s.length)) / 1000,
    avgTqic: avg(kms.map(k => k.kmTqic ?? k.tqic).filter(v => v != null)), attended: blocks.filter(r => r.state === 'Attended after TRC run').length,
    pending: blocks.filter(r => r.problem && r.state.startsWith('Pending')).length, atRisk: blocks.filter(r => r.atRisk).length, problems: blocks.filter(r => r.problem).length,
    throughZones: zones.filter(z => z.through).map(z => `${z.zone} ${z.loc} (${Math.round(z.pct * 100)}%)`).join('; ') };
  summary.pctCbml = summary.blocks ? summary.cbml / summary.blocks : 0; summary.pctPml = summary.blocks ? summary.pml / summary.blocks : 0;
  summary.through = summary.pctPml > 0.4;
  return { summary, blocks, kms, peaks, stretches, todo, yards: zones, avail, checks };
}

function blockActions(r, speed) {
  const a = [];
  const txt = ' ' + r.umlList + ' ' + r.nbmlList;
  if (r.umlN > 0 || r.gauge === 'UML') a.push('Impose SR; attend before relaxing (Para 523(1))');
  if (r.gauge || / G -?\d/.test(txt)) { const neg = [...txt.matchAll(/ G (-?[\d.]+) @/g)].map(m => +m[1]); const tight = (neg.length ? avg(neg) : (r.AVG ?? 0)) < 0; a.push(`Gauge correction (${tight ? 'tight' : 'wide'}): liners/ERC/rail-seat, square sleepers`); }
  if (/ TW1 /.test(txt)) a.push('Correct cross-level/twist at peak');
  if (/FP joint/.test(txt)) a.push('Attend fish-plated joint(s): pack joint sleepers, tighten fish bolts, check low/battered joint');
  if (/Glued joint/.test(txt)) a.push('Attend glued joint(s)');
  if (/SEJ/.test(txt)) a.push('Attend SEJ (gap, packing, fastenings)');
  if (/LC /.test(txt)) a.push('Attend LC approach (packing, drainage)');
  if (r.rootCause.includes('Clean cushion') && (r.irpwm !== '0' || r.MI === 'N')) a.push('Deep screening / ballast recoup before tamping (cushion low)');
  if (r.irpwm === 'N' || r.MI === 'N') {
    const d = r.drivers; const kind = d.includes('AL') && d.includes('UN') ? 'lift + lining' : d.includes('AL') ? 'lining' : 'lift + pack';
    a.push(`Machine tamping (${kind}) of full block`);
    if (d.includes('AL') && r.curve) a.push(`Versine survey & realignment of curve ${r.curve} (Para 524)`);
  } else if (/ (UN|AL)[12][LR] /.test(txt)) a.push('Spot packing / lining by MPT');
  if (r.turnouts && (r.irpwm === 'N' || r.MI === 'N')) a.push(`Tamp whole turnout(s) ${r.turnouts.split(' (')[0]} with block (Para 523(2)(iii))`);
  if (/ ACCN /.test(txt) || /ACCN/.test(txt)) a.push('Locate ride defect (joint/weld/SEJ/LC/bridge)');
  if (r.slCracked >= 5) a.push(`Replace ${r.slCracked} cracked/spalled sleepers first`);
  if (!a.length && r.priority.startsWith('4')) a.push('Planned through-tamping list');
  return a;
}

function kmAction(kb) {
  const d = new Map();
  for (const r of kb) for (const x of r.actions) { const k = x.replace(/\(Para.*?\)/, '').trim(); if (!d.has(k)) d.set(k, []); d.get(k).push('B' + r.block); }
  return [...d.entries()].map(([k, v]) => `${k}: ${v.join(',')}`).join(' | ');
}

// ---------------- To-Do: one row per worksite, exact chainage, defect-specific action ----------------
const PNAME = { UN1: 'Unevenness (short wave)', UN2: 'Unevenness (long wave)', AL1: 'Alignment (short wave)', AL2: 'Alignment (long wave)', TW1: 'Twist', G: 'Gauge', VACCN: 'Vertical ride acceleration', LACCN: 'Lateral ride acceleration' };
const RUNOUT = { G: 5, TW1: 6, UN1: 10, AL1: 10, UN2: 20, AL2: 20, VACCN: 10, LACCN: 10 }; // suggested work extent either side of the defect (m)
const baseOf = prm => /^(UN|AL)[12][LR]$/.test(prm) ? prm.slice(0, 3) : prm;
const sideOf = prm => /^(UN|AL)[12][LR]$/.test(prm) ? (prm.endsWith('L') ? 'left rail' : 'right rail') : '';
const fmtV = v => (v > 0 ? '+' : '') + (+v).toFixed(Math.abs(v) < 1 ? 2 : 1);

// plain-language defect description
function defectText(p) {
  const b = baseOf(p.param), side = sideOf(p.param);
  const lim = p.limit === 'TMS' ? 'beyond UML (TMS list)' : `${p.status} limit ${p.limit}${typeof p.limit === 'number' ? ' mm' : /g$/.test(p.limit) ? '' : ' mm'}${p.src === 'uml' ? ' (TMS UML list)' : ''}`;
  const at = `at ${p.loc}`;
  if (b === 'G') return `${p.value < 0 ? 'TIGHT' : 'WIDE'} gauge ${fmtV(p.value)} mm ${at}${p.curve ? ' (curve ' + p.curve + ')' : ' (straight)'} – ${lim}`;
  if (b === 'TW1') return `TWIST ${Math.abs(p.value)} mm on 3 m base (${(Math.abs(p.value) / 3).toFixed(1)} mm/m) ${at} – ${lim}`;
  if (b === 'UN1' || b === 'UN2') return `${b === 'UN1' ? 'UNEVENNESS short wave' : 'UNEVENNESS long wave'} ${fmtV(p.value)} mm on ${side} ${at} – ${lim}`;
  if (b === 'AL1' || b === 'AL2') return `${b === 'AL1' ? 'ALIGNMENT short wave' : 'ALIGNMENT long wave'} ${fmtV(p.value)} mm on ${side} ${at} – ${lim}`;
  if (b === 'VACCN' || b === 'LACCN') return `${b === 'VACCN' ? 'VERTICAL' : 'LATERAL'} ride acceleration ${p.value} g ${at} – ${lim}`;
  return `${p.param} ${p.value} ${at} – ${lim}`;
}

// field action + cause-check for one defect (plain words, IRPWM paras)
function defectSteps(p, from, to) {
  const b = baseOf(p.param), side = sideOf(p.param), ext = `${from}–${to}`, v = `${fmtV(p.value)}${/ACC/.test(b) ? ' g' : ' mm'} @ ${p.loc}`;
  if (b === 'G') return p.value < 0
    ? { act: `TIGHT GAUGE ${v}: gauge every sleeper ${ext}, mark "G−" (Para 606(3)); fit correct liners, re-drive ERCs, square sleepers, re-gauge (Para 627)`, check: 'Tight gauge: wrong/displaced liners, over-driven ERCs, skewed sleepers, rail creep' }
    : { act: `WIDE GAUGE ${v}: gauge every sleeper ${ext}, mark "G+" (Para 606(3)); replace worn liners/pads/ERCs, renew cracked sleepers, re-gauge (Para 627)`, check: 'Wide gauge: worn/broken liners, loose/missing ERCs, worn pads, cracked sleepers' + (p.curve ? ', outer-rail side wear' : '') };
  if (b === 'TW1') return { act: `TWIST ${Math.abs(p.value)} mm @ ${p.loc}: cross-level every sleeper ${ext}, mark "C" (Para 606(3)); pack LOW rail by MPT/off-track tamper till level uniform`, check: 'Twist: hanging/void sleepers, loose ballast, poor drainage' };
  if (b === 'UN1' || b === 'UN2') return { act: `UNEVENNESS ${side.toUpperCase()} ${v}: mark dip/hump on rail web; lift & pack ${ext} by MPT/off-track tamper (Para 606(1))`, check: 'Unevenness: short/loose ballast, wet or pumping spot, hanging sleepers, joint/weld dip' };
  if (b === 'AL1' || b === 'AL2') return { act: `ALIGNMENT ${side.toUpperCase()} ${v}: mark kink on rail foot; slew/line ${ext} by MPT` + (p.curve ? `; on curve ${p.curve} take versines ±50 m, correct per Para 524` : ''), check: 'Alignment: weak shoulder ballast, sleeper end-spacing' + (p.curve ? ', curve versine variation' : '') };
  if (b === 'VACCN' || b === 'LACCN') return { act: `${b === 'VACCN' ? 'VERTICAL' : 'LATERAL'} ACCELERATION ${v}: walk ${ext}, find and correct the ride defect`, check: 'Ride defect: joint/weld dip, battered rail end, SEJ, LC or bridge approach' };
  return { act: `${p.param} ${v}: attend ${ext}`, check: '' };
}
function assetSteps(ctx) {
  const s = [];
  if (/FP joint/.test(ctx)) s.push('Fish-plated joint here: loosen plates, lift & pack ≥3 sleepers each side (Para 606(4)); check gap, bolts, battered ends (Para 620)');
  if (/Glued joint/.test(ctx)) s.push('Glued joint here: check dip, packing of joint sleepers, end-post and bolts (Para 622)');
  if (/SEJ/.test(ctx)) s.push('SEJ here: check gap/tongue rail, packing and fastenings');
  if (/LC /.test(ctx)) s.push('LC approach here: pack approaches, check drainage and check-rail/flangeway');
  const t = ctx.match(/Turnout ([^;]+)/); if (t) s.push(`Turnout ${t[1]} here: check gauge & cross-level at toe/switch/crossing; pack crossing and lead`);
  return s;
}
function landmarkNear(landmarks, pos) {
  let best = null; for (const l of landmarks) { const d = l.pos - pos; if (Math.abs(d) <= 500 && (!best || Math.abs(d) < Math.abs(best.d))) best = { ...l, d }; }
  if (!best) return '—';
  return Math.abs(best.d) < 3 ? `${best.name} @ ${kmm(best.pos)} (at the spot)` : `${best.name} @ ${kmm(best.pos)} – ${Math.round(Math.abs(best.d))} m towards ${best.d > 0 ? 'higher' : 'lower'} km`;
}
// short history fields for the blocks touching a worksite
function histFields(list, speed) {
  const L = list.filter(Boolean); const lim = speed >= 130 ? 200 : 150;
  const tl = L.map(r => r.tampLast).filter(Boolean).sort().pop();
  const tr = tl ? L.find(r => r.tampLast === tl) : null;
  const cm = L.map(r => r.cleanMin).filter(v => v != null); const c = cm.length ? Math.min(...cm) : null;
  const ds = L.map(r => r.dsLast).filter(Boolean).sort().pop();
  const sl = L.map(r => r.slCracked).filter(v => v != null); const slN = sl.length ? sum(sl) : null;
  const states = [...new Set(L.filter(r => r.problem).map(r => r.state).filter(Boolean))];
  const after = states.length === 1 && states[0] === 'Attended after TRC run';
  return {
    tamped: tl ? `${fmtYM(tl)}${tr && tr.tampMachine ? ' (' + tr.tampMachine + ')' : ''}${after ? ' – AFTER TRC run' : ''}` : (L.some(r => r.state === 'Pending (no tamping data)') ? 'no tamping data' : 'not in tamping records'),
    cushion: c != null ? `${c} mm${c < lim ? ` – LOW (< ${lim})` : ''}` : '—',
    ds: ds ? fmtYM(ds) : '—',
    sleepers: slN != null ? (slN ? `${slN} cracked/spalled` : 'none reported') : '—',
    state: states.join(' / ') || '—',
    hint: after ? 'Tamped after TRC run – field-check, confirm in next run' : states.includes('Check: tamped in run month') ? 'Tamped in run month – field-check first' : '',
  };
}
const blocksAt = (blocks, a, b) => blocks.filter(r => r.a < b && r.b > a);

function buildTodo({ lineId, run, speed, B, blocks, peaks, stretches, zones, kms, landmarks }) {
  const T = [];
  const inStretch = pos => stretches.find(s => pos >= s.a && pos < s.b);
  // ---- worksites from peak defects (cluster all parameters within 25 m)
  const sites = [];
  for (const p of [...peaks].sort((a, b) => a.pos - b.pos)) {
    const lo = p.km * 1000 + p.from, hi = p.km * 1000 + p.to, ro = RUNOUT[baseOf(p.param)] || 10;
    const last = sites[sites.length - 1];
    if (last && lo - last.hi <= 25) { last.list.push(p); last.hi = Math.max(last.hi, hi); last.wa = Math.min(last.wa, lo - ro); last.wb = Math.max(last.wb, hi + ro); }
    else sites.push({ list: [p], lo, hi, wa: lo - ro, wb: hi + ro });
  }
  for (const s of sites) {
    const uml = s.list.filter(p => p.status === 'UML');
    const str = inStretch(s.lo);
    if (!uml.length && str) continue;           // NBML inside a tamping stretch – cleared by the machine
    const wa = Math.max(0, Math.round(s.wa)), wb = Math.round(s.wb);
    const ordered = [...uml, ...s.list.filter(p => p.status !== 'UML')];
    const ctx = [...new Set(s.list.map(p => p.context).filter(Boolean).flatMap(c => c.split('; ')))].join('; ');
    const steps = [];
    if (uml.length) steps.push('Impose suitable SR now; relax only after attention (Para 523(1))');
    const checks = [];
    const kindKey = p => { const b = baseOf(p.param); return b === 'G' ? 'G' + (p.value < 0 ? '-' : '+') : b + sideOf(p.param); };
    for (const grp of groupBy(ordered, kindKey)) {
      const d = defectSteps(grp[0], kmm(wa), kmm(wb));
      steps.push(d.act + (grp.length > 1 ? ` (also ${grp.slice(1).map(p => fmtV(p.value) + ' @ ' + p.loc).join(', ')})` : ''));
      if (d.check && !checks.includes(d.check)) checks.push(d.check);
    }
    for (const x of assetSteps(ctx)) steps.push(x);
    if (str) steps.push(`Also inside machine-tamping stretch ${str.from}–${str.to}`);
    const H = histFields(blocksAt(blocks, ordered[0].pos, ordered[0].pos + 1), speed);
    const kind = [...new Set(ordered.map(p => { const b = baseOf(p.param); return b === 'G' ? (p.value < 0 ? 'tight gauge' : 'wide gauge') : b === 'TW1' ? 'twist' : /^UN/.test(b) ? 'unevenness' : /^AL/.test(b) ? 'alignment' : 'ride acceleration'; }))].join(' + ');
    const at = s.hi - s.lo < 1 ? kmm(s.lo) : `${kmm(s.lo)} – ${kmm(s.hi)}`;
    T.push(job({
      pri: uml.length ? 1 : 3, cat: uml.length ? '1. URGENT – UML defect (SR)' : '3. Spot attention – NBML defect', lineId, km: s.list[0].km,
      at, from: kmm(wa), to: kmm(wb), length: wb - wa, block: [...new Set(s.list.map(p => `${p.km}/B${p.block}`))].join(', '),
      defect: ordered.map(defectText).join('\n'), type: kind, near: ctx || '—', landmark: landmarkNear(landmarks, s.lo),
      what: steps.map((x, i) => `${i + 1}) ${x}`).join('\n'), check: checks.join('\n'),
      when: uml.length ? 'Immediately (SR now)' : 'Within 4 weeks, before next TRC run (Para 523(2)(i))',
      why: `TRC run ${run}: ${uml.length ? uml.length + ' UML' : ''}${uml.length && ordered.length > uml.length ? ' + ' : ''}${ordered.length > uml.length ? (ordered.length - uml.length) + ' NBML' : ''} defect location(s)`,
      blocks: 0, peaks: ordered.length, ...H }));
  }
  // ---- mean gauge (TMS MI-G) blocks
  for (const grp of runsOf(blocks.filter(r => r.gauge), 0)) {
    const u = grp.some(r => r.gauge === 'UML'); const a = grp[0].a, b = grp[grp.length - 1].b;
    const avgG = avg(grp.map(r => r.AVG).filter(v => v != null)) ?? 0; const tight = avgG < 0;
    const H = histFields(grp, speed);
    T.push(job({ pri: u ? 1 : 3, cat: u ? '1. URGENT – mean gauge beyond UML' : '3. Re-gauging – mean gauge NBML', lineId, km: grp[0].km,
      at: `${kmm(a)} – ${kmm(b)}`, from: kmm(a), to: kmm(b), length: b - a, block: grp.map(r => `${r.km}/B${r.block}`).join(', '),
      defect: grp.map(r => `Mean gauge ${fmtV(r.AVG)} mm over ${r.loc} (TMS MI-G ${r.MI_G}: ${r.MI_G === '4' ? 'UML' : 'NBML'})`).join('\n'), type: tight ? 'tight gauge (whole block)' : 'wide gauge (whole block)',
      near: [...new Set(grp.map(r => r.curve).filter(Boolean))].map(c => 'Curve ' + c).join('; ') || '—', landmark: landmarkNear(landmarks, a),
      what: [u ? 'Impose suitable SR now; relax only after attention (Para 523(1))' : null,
        `Through gauge check at every 3rd sleeper ${kmm(a)} to ${kmm(b)}; mark "G${tight ? '−' : '+'}" (Para 606(3))`,
        tight ? 'Tight over whole block – check liner type/position, over-driven ERCs, sleeper skew, rail creep' : 'Wide over whole block – check worn liners/GFN, rail pads, ERC toe load, rail side-wear, sleeper rail-seat wear',
        'Correct & re-gauge; replace defective fittings/sleepers (Para 627, 605(4)(h))'].filter(Boolean).map((x, i) => `${i + 1}) ${x}`).join('\n'),
      when: u ? 'Within 1 week (SR till done)' : 'Within 4 weeks', why: `TRC run ${run}: TMS mean-gauge flag in ${grp.length} block(s)`, blocks: 0, peaks: 0, ...H }));
  }
  // ---- deep screening before tamping
  const lim = speed >= 130 ? 200 : 150;
  for (const grp of runsOf(blocks.filter(r => r.problem && r.cleanMin != null && r.cleanMin < lim), 1)) {
    const a = grp[0].a, b = grp[grp.length - 1].b; const H = histFields(grp, speed);
    T.push(job({ pri: 2, cat: '2. Deep screening before tamping', lineId, km: grp[0].km, at: `${kmm(a)} – ${kmm(b)}`, from: kmm(a), to: kmm(b), length: b - a,
      block: grp.map(r => `${r.km}/B${r.block}`).join(', '),
      defect: grp.map(r => `${r.loc}: clean cushion ${r.cleanMin} mm (need ≥ ${lim}); ${r.irpwm === 'N' ? 'CBML block' : r.MI === 'N' ? 'TMS MI = N' : r.irpwm === 'P' ? 'over PML' : 'peak defects'}`).join('\n'), type: 'low clean ballast cushion',
      near: [...new Set(grp.flatMap(r => [r.curve && 'Curve ' + r.curve, r.turnouts && 'Turnouts ' + r.turnouts]).filter(Boolean))].join('; ') || '—', landmark: landmarkNear(landmarks, a),
      what: [`Deep screen ${kmm(a)} to ${kmm(b)} (BCM) – or ballast recoup + shoulder screening where DS not possible`, 'Then tamp the stretch (Para 605(3)(a): ≥150 mm clean cushion needed for tamping)', `Para 636(2)(e): DS when clean cushion < ${lim} mm at this speed`].map((x, i) => `${i + 1}) ${x}`).join('\n'),
      when: 'Next DS / BCM block', why: `Ballast register: cushion below ${lim} mm in defective block(s)`, blocks: grp.filter(r => r.irpwm === 'N').length, peaks: 0, ...H }));
  }
  // ---- machine tamping stretches
  for (const s of stretches) {
    const inside = blocks.filter(r => r.a >= s.a && r.b <= s.b);
    const pk = peaks.filter(p => p.pos >= s.a && p.pos < s.b && p.status === 'NBML').sort((x, y) => Math.abs(y.value) - Math.abs(x.value));
    const gaps = inside.filter(r => !(r.irpwm === 'N' || r.MI === 'N'));
    const H = histFields(inside, speed);
    const steps = [
      `Pre-tamping (Para 605(4)): fill ballast where short, tighten fastenings, renew broken sleepers, square sleepers/re-gauge, attend hogged joints`,
      `Tamp ${s.from} to ${s.to} (${s.length} m) – ${s.kind === 'lining' ? 'lining mode (slew)' : s.kind === 'lift + lining' ? 'lift + lining mode' : 'lift + pack mode'}, with DTS`,
      gaps.length ? `Includes gap block(s) ${gaps.map(r => r.loc).join(', ')} (Para 523(2)(ii))` : null,
      s.turnouts ? `Tamp whole turnout(s) ${s.turnouts} with the block (Para 523(2)(iii))` : null,
      /AL/.test(s.drivers) && inside.some(r => r.curve) ? `Curve ${[...new Set(inside.map(r => r.curve).filter(Boolean))].join(', ')}: versine survey before tamping (Para 605(4)(k), 524)` : null,
      s.lowCushion ? 'Clean cushion low inside – deep screen first (see job 2. Deep screening)' : null,
      'Post-tamping check & fastening tightening (Para 605(6))'].filter(Boolean);
    T.push(job({ pri: 2, cat: '2. Machine tamping – CBML stretch', lineId, km: Math.floor(s.a / 1000), at: `${s.from} – ${s.to}`, from: s.from, to: s.to, length: s.length,
      block: inside.map(r => `${r.km}/B${r.block}`).join(', '),
      defect: inside.filter(r => r.drivers).map(r => `${r.loc}: ${r.drivers.split('; ').filter(d => /NBML/.test(d)).join(', ') || (r.MI === 'N' ? 'TMS MI = N' : r.drivers.split('; ').join(', '))}`).join('\n') + (pk.length ? `\nWorst spots: ${pk.slice(0, 4).map(p => `${p.param} ${fmtV(p.value)} @ ${p.loc}`).join('; ')}` : ''),
      type: s.kind, near: [...new Set(inside.flatMap(r => [r.curve && 'Curve ' + r.curve, r.turnouts && 'Turnouts ' + r.turnouts, r.lc && 'LC ' + r.lc, r.sej && 'SEJ ' + r.sej]).filter(Boolean))].join('; ') || '—',
      landmark: landmarkNear(landmarks, s.a), what: steps.map((x, i) => `${i + 1}) ${x}`).join('\n'), when: 'Before next TRC run',
      why: `TRC run ${run}: ${s.cbml} CBML block(s)${s.tmsN > s.cbml ? `, ${s.tmsN} with TMS MI = N` : ''}; also clears ${pk.length} NBML spot(s)`, blocks: s.cbml, peaks: pk.length, ...H }));
  }
  // ---- sleepers
  for (const r of blocks.filter(r => r.slCracked >= 5)) {
    const H = histFields([r], speed);
    T.push(job({ pri: 3, cat: '3. Sleeper renewal before tamping', lineId, km: r.km, at: r.loc, from: kmm(r.a), to: kmm(r.b), length: 200, block: `${r.km}/B${r.block}`,
      defect: `${r.slCracked} cracked/spalled sleepers${r.slMisaligned ? `, ${r.slMisaligned} misaligned` : ''} in ${r.loc} (TMS sleeper report ${r.slRun})`, type: 'sleepers', near: '—', landmark: landmarkNear(landmarks, r.a),
      what: [`Locate the sleepers in ${r.loc} from the TMS sleeper exception report`, 'Casual renewal of cracked/spalled sleepers (Para 625); square misaligned ones', 'Pack renewed sleepers'].map((x, i) => `${i + 1}) ${x}`).join('\n'),
      when: 'Within 4 weeks; before tamping', why: 'TMS sleeper exception report', blocks: 0, peaks: 0, ...H }));
  }
  // ---- at risk of turning CBML at next run (SD >= 85 % of NBML) – pre-emptive tamping
  for (const grp of runsOf(blocks.filter(r => r.atRisk && !r.stretch && r.state !== 'Attended after TRC run'), 1)) {
    const a = grp[0].a, b = grp[grp.length - 1].b; const inside = blocks.filter(r => r.a >= a && r.b <= b); const H = histFields(inside, speed);
    const worst = grp.reduce((x, y) => y.risk > x.risk ? y : x);
    const al = grp.some(r => /^AL/.test(r.riskBy)), un = grp.some(r => /^UN/.test(r.riskBy));
    T.push(job({ pri: 3, cat: '3. Pre-emptive tamping – at risk of CBML', lineId, km: grp[0].km, at: `${kmm(a)} – ${kmm(b)}`, from: kmm(a), to: kmm(b), length: b - a,
      block: grp.map(r => `${r.km}/B${r.block}`).join(', '),
      defect: grp.map(r => `${r.loc}: ${r.riskBy} (${Math.round(r.risk * 100)}% of CBML limit)`).join('\n'), type: `at risk – ${al && un ? 'lift + lining' : al ? 'lining' : 'lift + pack'}`,
      near: [...new Set(inside.flatMap(r => [r.curve && 'Curve ' + r.curve, r.turnouts && 'Turnouts ' + r.turnouts]).filter(Boolean))].join('; ') || '—', landmark: landmarkNear(landmarks, a),
      what: [`Tamp ${kmm(a)} to ${kmm(b)} (${b - a} m) – ${al && un ? 'lift + lining' : al ? 'lining' : 'lift + pack'} – in the same machine block as nearby CBML stretches`,
        'Do it before the next TRC run: these blocks are within 15% of the CBML (NBML) SD limit and will likely be counted as CBML next time',
        'If machine not available: spot packing/lining of the worst peaks by MPT'].map((x, i) => `${i + 1}) ${x}`).join('\n'),
      when: 'Before next TRC run', why: `Worst block ${worst.loc} at ${Math.round(worst.risk * 100)}% of limit`, blocks: 0, peaks: 0, ...H }));
  }
  // ---- through tamping
  for (const z of zones.filter(z => z.through)) {
    const inside = blocks.filter(r => r.a >= z.from && r.b <= z.to); const H = histFields(inside, speed);
    T.push(job({ pri: 4, cat: '4. Through tamping proposal', lineId, km: Math.floor(z.from / 1000), at: z.loc, from: kmm(z.from), to: kmm(z.to), length: z.to - z.from, block: `${z.blocks} blocks`,
      defect: `${z.zone}: ${z.overPML} of ${z.blocks} blocks over PML (${Math.round(z.pct * 100)}%; limit ${z.limit * 100}%)`, type: 'through tamping', near: z.zone, landmark: landmarkNear(landmarks, z.from),
      what: [`Propose through tamping of ${z.zone.toLowerCase()} ${z.loc} (Para 523(3))`, 'Check ballast cushion before including in machine programme'].map((x, i) => `${i + 1}) ${x}`).join('\n'),
      when: 'Next machine programme', why: 'Para 523(3) PML criterion', blocks: 0, peaks: 0, ...H }));
  }
  return T.sort((x, y) => x.pri - y.pri || x.pos - y.pos);
}
function job(o) {
  const r = { pri: o.pri, cat: o.cat, lineId: o.lineId, km: o.km, at: o.at, from: o.from, to: o.to, length: o.length, block: o.block, defect: o.defect, type: o.type, near: o.near, landmark: o.landmark,
    what: o.what, check: o.check || '', when: o.when, why: o.why, tamped: o.tamped, cushion: o.cushion, ds: o.ds, sleepers: o.sleepers, state: o.state, blocks: o.blocks, peaks: o.peaks, hint: o.hint };
  r.history = [`Tamped: ${r.tamped}`, `Cushion: ${r.cushion}`, `DS: ${r.ds}`, `Sleepers: ${r.sleepers}`].join(' · ');
  const m = String(o.from).match(/^(\d+)\/(\d+)/); r.pos = m ? +m[1] * 1000 + +m[2] : 0;
  r.status = r.hint ? 'Verify' : 'Pending';
  return r;
}

function runsOf(list, gapBlocks) { const s = [...list].sort((a, b) => a.a - b.a); const out = []; let g = []; for (const r of s) { if (g.length && r.a - g[g.length - 1].b > gapBlocks * 200) { out.push(g); g = []; } g.push(r); } if (g.length) out.push(g); return out; }
function groupBy(list, f) { const m = new Map(); for (const x of list) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return [...m.values()]; }
function mode(a) { const m = new Map(); a.forEach(x => m.set(x, (m.get(x) || 0) + 1)); let b = null, c = 0; for (const [k, v] of m) if (v > c) { b = k; c = v; } return b; }
const sum = a => a.reduce((x, y) => x + (y || 0), 0);
const avg = a => a.length ? sum(a) / a.length : null;

function summariseDivision(R) {
  const L = R.lines;
  return { lines: L.length, blocks: sum(L.map(l => l.blocks)), cbml: sum(L.map(l => l.cbml)), pml: sum(L.map(l => l.pml)), cbmlPeaks: sum(L.map(l => l.cbmlPeaks)), umlPeaks: sum(L.map(l => l.umlPeaks)),
    km: sum(L.map(l => l.kmRecorded)), tampKm: sum(L.map(l => l.tampKm)), todo: R.todo.length, urgent: R.todo.filter(t => t.pri === 1).length, attended: sum(L.map(l => l.attended)), pending: sum(L.map(l => l.pending)) };
}

return { BANDS, band, dedupe, analyse };
})();
__m['pipeline.js'] = (function(){
// File ingestion: identify each file, read it, and build the data store for analysis.
const {decodePNG} = __m['png.js'];
const {Templates, readCell} = __m['ocr.js'];
const {readPage} = __m['page.js'];
const {readHeader} = __m['header.js'];
const {TTemplates} = __m['textocr.js'];
const {readXLS} = __m['xls.js'];
const {readXLSX} = __m['xlsx.js'];
const {pdfLines} = __m['pdftext.js'];
const {classifySheet, parseSheet, classifyPdf, parsePdf, KINDS} = __m['sources.js'];
const {sectionName, lineKey} = __m['names.js'];
const {dedupe} = __m['analysis.js'];

function makeEngine(models) {
  return { body: new Templates(models.body), blue: new Templates(models.blue), info: new TTemplates(models.info), titles: models.titles.slice(), customTitles: [] };
}

const KEYS = {
  tampSect: r => [r.section, r.line, r.a, r.b, r.date, r.machine].join('|'), tampTO: r => [r.section, r.station, r.line, r.toNo, r.pos, r.date].join('|'),
  deepScreen: r => [r.section, r.line, r.a, r.b, r.date].join('|'), ballast: r => [r.section, r.line, r.a, r.b].join('|'), curve: r => [r.section, r.line, r.a, r.b].join('|'),
  fpJoint: r => [r.section, r.line, r.pos, r.rail].join('|'), glued: r => [r.section, r.line, r.pos, r.rail].join('|'), lc: r => [r.section, r.line, r.pos].join('|'),
  pxing: r => [r.section, r.line, r.pos, r.no].join('|'), diamond: r => [r.section, r.line, r.pos, r.no].join('|'), sej: r => [r.section, r.line, r.pos].join('|'),
  sleeper: r => [r.section, r.line, r.run, r.km, r.block].join('|'), cbmlReport: r => [r.section, r.run, r.band].join('|'), tampDue: r => [r.section, r.line].join('|'),
};

function emptyStore() { const s = { pages: [], files: [] }; for (const k of Object.keys(KEYS)) s[k] = []; return s; }

// files: [{name, size, buf: ArrayBuffer}] ; onProgress(i, n, msg)
async function ingest(engine, files, onProgress = () => {}, cache = null) {
  const store = emptyStore();
  let i = 0;
  for (const f of files) {
    i++; const ext = (f.name.split('.').pop() || '').toLowerCase();
    const info = { name: f.name, kind: null, records: 0, note: '' };
    try {
      if (ext === 'png') {
        onProgress(i, files.length, 'Reading TRC page ' + f.name);
        const p = await readTRCPage(engine, f, cache);
        info.kind = 'trc'; info.records = p.blocks.length; info.note = p.problems.length ? p.problems.join(', ') : `${p.section || '?'} ${p.line || '?'} km ${p.km} (${p.date})`;
        info.page = p; store.pages.push(p);
      } else if (ext === 'xls' || ext === 'xlsx') {
        onProgress(i, files.length, 'Reading ' + f.name);
        const wb = ext === 'xls' ? readXLS(f.buf) : await readXLSX(f.buf);
        for (const sh of wb.sheets) {
          const k = classifySheet(sh.rows, sh.name); if (!k) continue;
          const recs = parseSheet(k, sh.rows); store[k].push(...recs); info.kind = k; info.records += recs.length;
        }
        if (!info.kind) info.note = 'Not a recognised TMS report – ignored';
      } else if (ext === 'pdf') {
        onProgress(i, files.length, 'Reading ' + f.name);
        if (f.size > 8e6) { info.note = 'Large PDF (manual?) – ignored'; }
        else { const L = await pdfLines(f.buf); const k = classifyPdf(L); if (k) { const recs = parsePdf(k, L); store[k].push(...recs); info.kind = k; info.records = recs.length; } else info.note = 'Not a recognised TMS report – ignored'; }
      } else info.note = 'File type not used';
    } catch (e) { info.note = 'Could not read: ' + e.message; }
    store.files.push(info);
  }
  for (const k of Object.keys(KEYS)) store[k] = dedupe(store[k], KEYS[k]);
  return store;
}

async function readTRCPage(engine, f, cache) {
  const key = f.name + '|' + f.size;
  if (cache && cache.has(key)) return cache.get(key);
  const im = await decodePNG(f.buf);
  const r = readPage(engine.body, im);
  const out = { file: f.name, blocks: r.blocks, dist: r.dist, peaks: r.peaks, uml: r.uml, problems: [...r.warn], section: null, line: null, date: null, km: null, speed: null };
  if (!r.layoutOK) { out.problems.push('Not a TMS km-wise result page, or zoom/crop differs (capture at 100% zoom)'); }
  else {
    const h = readHeader(im, r.info, [...engine.titles, ...engine.customTitles], engine.info);
    Object.assign(out, { section: h.section ? sectionName(h.section) : null, line: h.line ? lineKey(h.line) : null, date: h.date, km: h.km, kmTo: h.kmTo, speed: h.speed, trc: h.trc, runNo: h.runNo, titleSig: h.titleSig });
    if (h.problems.includes('new-title')) {
      out.problems.push('new-title');
      if (h.titleLine) { const [t0, t1] = h.titleLine; const y0 = Math.max(0, t0 - 4), y1 = Math.min(im.h, t1 + 4), w = Math.min(im.w, 1440); const d = new Uint8Array(w * (y1 - y0)); for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) d[(y - y0) * w + x] = Math.round(im.g3[y * im.w + x] / 3); out.titleCrop = { w, h: y1 - y0, data: Array.from(d) }; }
    } else { delete out.titleSig; out.problems.push(...h.problems.filter(x => x !== 'new-title')); }
    // KM-wise TQIC (blue text) using min-channel image
    if (r.kmTqicRow) { const [, a, b] = r.kmTqicRow; const [s] = readCell(engine.blue, im, b - 1, 140, 600, a, 'mn'); const m = s.match(/(\d+\.?\d*)$/); out.kmTqic = m ? +m[1] : null; }
    // filename fallback (script-named files) if header unreadable
    const fm = f.name.match(/KM(\d+)-(\d+)_(.+)_(\d{4}-\d\d-\d\d)\.png$/i);
    if (fm) { if (out.km == null) out.km = +fm[1]; if (!out.date) out.date = fm[4]; }
  }
  if (cache) cache.set(key, out);
  return out;
}


return { makeEngine, emptyStore, ingest, readTRCPage, KINDS };
})();
__m['report.js'] = (function(){
// Excel workbook from the analysis result.
const {writeXLSX, ST} = __m['xlsx.js'];
const {BANDS} = __m['analysis.js'];
const {KINDS} = __m['sources.js'];

const pri = v => String(v || '').charAt(0);
const priStyle = v => ({ 1: ST.red, 2: ST.orange, 3: ST.yellow }[pri(v)] ?? null);
const SRC_ORDER = ['tampSect', 'tampTO', 'deepScreen', 'ballast', 'curve', 'fpJoint', 'glued', 'lc', 'pxing', 'sej', 'sleeper', 'cbmlReport', 'tampDue'];

async function buildWorkbook(R, store, statusMap = {}) {
  const S = [];
  const D = R.division;
  S.push({ name: 'Read me', title: 'TRC analysis – Howrah Division', note: `Generated ${new Date().toLocaleString()} from ${store.files.length} files. Lines analysed: ${R.lines.length}.`, headers: ['Item', 'Value / meaning'], widths: [42, 120], wrap: new Set([1]), rows: [
    ['CBML blocks (IRPWM SD calc)', `${D.cbml} of ${D.blocks} blocks`], ['Blocks over PML', D.pml], ['CBML peaks (TMS count)', D.cbmlPeaks], ['UML peaks (TMS count)', D.umlPeaks], ['Machine tamping required', `${D.tampKm.toFixed(1)} km`], ['Jobs in To-Do plan', `${D.todo} (urgent ${D.urgent})`],
    ['', ''], ['Sheet: To-Do plan', 'One row per worksite in priority order: exact defect chainage, work extent, defect in plain words, step-by-step action, likely cause, nearby asset/landmark, history and status. "Verify" = already tamped after the TRC run.'],
    ['Sheet: Data checklist', 'Which TMS reports were found for each line, and what is missing. Add missing files and run again – results update automatically.'],
    ['Sheet: Line summary', 'One row per line: CBML blocks, % over PML, peaks, tamping km, through-tamping zones.'], ['Sheet: KM-wise', 'One row per km with counts, priority score and block-wise actions.'],
    ['Sheet: Block-wise', 'One row per 200 m block: SD values, TMS MI vs IRPWM, peaks in block, curve/turnout/LC/SEJ, tamping / deep screening / cushion history, root cause, action.'],
    ['Sheet: Peak locations', 'Every NBML / UML defect location (peaks within 10 m grouped) with nearest asset.'], ['Sheet: Tamping stretches', 'CBML blocks merged with gaps ≤ 200 m (Para 523(2)(ii)).'],
    ['Sheet: Zones', 'Block sections and yards (from P&C register) with % blocks over PML (40 % / 50 % rule, Para 523(3)).'], ['Sheet: Checks', 'Cross-checks with TMS reports and reading checks.'],
    ['', ''], ['CBML', 'TMS "CBML" = IRPWM 2024 NBML. Block is CBML when the worse of left/right rail SD exceeds NBML SD for the sectional speed band (Para 522).'],
    ['Priority 1', 'UML peak or mean gauge beyond UML – speed restriction and immediate attention (Para 523(1)).'], ['Priority 2', 'CBML block – machine tamping (with deep screening first where clean cushion is low).'],
    ['Priority 3', 'Isolated NBML peak / mean gauge NBML / sleeper renewal – spot attention.'], ['Priority 4', 'Over PML only – planned / through tamping.'],
    ['Note', 'Gauge limits use curve radius from the curve register where available; otherwise straight-track limits. TMS sleeper reports may be from an earlier run than the TRC run – date shown.'] ] });
  // data checklist
  S.push({ name: 'Data checklist', title: 'Data used for each line', note: 'Numbers = records found for the line. "—" = not supplied. Add the missing TMS reports to the folder and run again.',
    headers: ['Line', 'TRC run', 'Speed', 'KM pages', 'KM range', ...SRC_ORDER.map(k => KINDS[k])], widths: [24, 11, 7, 8, 10, ...SRC_ORDER.map(() => 12)],
    rows: R.availability.map(a => [a.lineId, a.run, a.speed, a.pages, `${a.kmFrom}–${a.kmTo}`, ...SRC_ORDER.map(k => a.sources[k] || '—')]),
    styleFn: (row, c, v) => c >= 5 ? (v === '—' ? ST.grey : ST.green) : null });
  S.push({ name: 'Files read', headers: ['File', 'Recognised as', 'Records', 'Note'], widths: [50, 30, 10, 70], rows: store.files.map(f => [f.name, f.kind ? (KINDS[f.kind] || f.kind) : '—', f.records, f.note]) });
  // to-do
  S.push({ name: 'To-Do plan', title: 'TO-DO PLAN – one row per worksite: exact location, defect found, what to do',
    note: '"Defect at" = chainage of the defect as recorded by TRC (km/m). "Work from/to" = suggested extent to attend either side. Locate on ground from the km post / nearest landmark; search ±10 m for TRC location error. Order: 1 Urgent (SR) → 2 deep screening & machine tamping → 3 spot / gauge / sleepers → 4 through tamping.',
    headers: ['S.No', 'Priority', 'Category', 'Line', 'Defect at (km/m)', 'Work from (km/m)', 'Work to (km/m)', 'Length (m)', 'TRC block', 'Defect found (TRC)', 'Type of attention', 'What to do (steps)', 'Look for (likely cause)', 'Near asset', 'Nearest landmark', 'Target', 'Last tamped', 'Clean cushion', 'Last deep screening', 'Sleepers', 'State', 'Status hint', 'Status', 'Date done', 'Remarks'],
    widths: [5, 7, 24, 16, 15, 11, 11, 7, 10, 55, 18, 70, 38, 26, 30, 18, 20, 14, 11, 14, 18, 24, 11, 11, 20], wrap: new Set([2, 9, 10, 11, 12, 13, 14, 15, 16, 20, 21]), freezeCols: 5,
    rows: R.todo.map((t, i) => [i + 1, t.pri, t.cat, t.lineId, t.at, t.from, t.to, t.length, t.block, t.defect, t.type, t.what, t.check || '', t.near, t.landmark, t.when, t.tamped, t.cushion, t.ds, t.sleepers, t.state, t.hint || '', statusMap[jobKey(t)]?.status || t.status, statusMap[jobKey(t)]?.date || '', statusMap[jobKey(t)]?.remark || '']),
    styleFn: (row, c) => c === 1 ? priStyle(row[1]) : c === 22 && row[22] === 'Done' ? ST.green : (c === 17 && /LOW/.test(row[17])) ? ST.orange : (c === 16 && /AFTER/.test(row[16])) ? ST.green : null });
  // line summary
  S.push({ name: 'Line summary', title: 'Line-wise summary', headers: ['Line', 'Run date', 'Speed', 'Band', 'KM recorded', 'Blocks', 'CBML blocks', '% CBML', 'TMS MI = N', 'Over PML', '% over PML', 'CBML peaks (TMS)', 'UML peaks (TMS)', 'UML gauge', 'UML twist', 'Gauge MI-G blocks', 'Tamping stretches', 'Tamping km', 'Avg KM TQIC', 'Defective blocks', 'Attended after run', 'Pending', 'Through-tamping zones (>40% BS / >50% yard)', 'Previous run', 'Prev CBML'],
    widths: [24, 11, 7, 11, 8, 8, 8, 8, 8, 8, 8, 9, 9, 8, 8, 9, 9, 9, 9, 9, 9, 9, 50, 11, 9], pctCols: new Set([7, 10]), wrap: new Set([22]),
    rows: R.lines.map(l => [l.lineId, l.run, l.speed, l.band, l.kmRecorded, l.blocks, l.cbml, l.pctCbml, l.tmsN, l.pml, l.pctPml, l.cbmlPeaks, l.umlPeaks, l.umlGauge, l.umlTwist, l.gaugeBlocks, l.stretches, +l.tampKm.toFixed(1), l.avgTqic != null ? +l.avgTqic.toFixed(2) : null, l.problems, l.attended, l.pending, l.throughZones, l.prevRun || '', l.prevCbml ?? '']) });
  S.push({ name: 'KM-wise', headers: ['Line', 'Run', 'Speed', 'KM', 'Recorded', 'KM TQIC', 'Blocks', 'CBML blocks', 'Which', 'TMS MI=N', 'Over PML', 'CBML pk UN1', 'CBML pk AL1', 'CBML pk TW1', 'CBML pk UN2', 'CBML pk AL2', 'CBML peaks', 'UML twist', 'UML gauge', 'UML accn', 'UML total', 'Gauge NBML blk', 'Gauge UML blk', 'Worst mean gauge', 'Curve', 'Score', 'Rank in line', 'Action plan (block-wise)'],
    widths: [24, 11, 7, 6, 9, 8, 7, 8, 12, 8, 8, 7, 7, 7, 7, 7, 8, 7, 7, 7, 8, 8, 8, 8, 14, 7, 7, 80], wrap: new Set([27]), freezeCols: 4,
    rows: R.kms.map(k => [k.lineId, k.run, k.speed, k.km, k.recorded ? 'Yes' : 'Not recorded', k.kmTqic, k.blocks, k.cbml, k.cbmlList, k.tmsN, k.pml, k.pUN1, k.pAL1, k.pTW1, k.pUN2, k.pAL2, k.cbmlPeaks, k.uTW1, k.uG, k.uACC, k.umlPeaks, k.gN, k.gU, k.worstGauge, k.curve, k.score, k.rank, k.action]),
    styleFn: (row, c) => (c === 20 && row[20] > 0) ? ST.red : (c === 7 && row[7] > 0) ? ST.orange : (c === 4 && row[4] !== 'Yes') ? ST.grey : null });
  S.push({ name: 'Block-wise', headers: ['Line', 'Run', 'Speed', 'KM', 'Block', 'Location', 'UN1 L', 'UN1 R', 'AL1 L', 'AL1 R', 'UN2 L', 'UN2 R', 'AL2 L', 'AL2 R', 'Mean gauge', 'TQIC', 'TMS MI', 'IRPWM calc', 'SD exceedance', 'MI-G', 'NBML peaks', 'NBML list', 'UML peaks', 'UML list', 'Zone', 'Curve', 'Turnouts', 'LC', 'SEJ', 'FP joints', 'Glued joints', 'Last tamping', 'Machine', 'Last DS', 'Clean cushion min', 'Sleepers cracked+spalled', 'Sleepers misaligned', 'State', 'Root cause', 'Priority', 'Action', 'Stretch', 'Prev run status', '% of CBML limit', 'At risk of CBML'],
    widths: [22, 10, 6, 6, 6, 16, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 6, 8, 34, 6, 7, 40, 7, 40, 14, 14, 26, 8, 8, 7, 7, 10, 12, 10, 9, 9, 9, 22, 50, 18, 60, 20, 10, 9, 9], wrap: new Set([18, 21, 23, 26, 38, 40]), freezeCols: 5,
    rows: R.blocks.map(b => [b.lineId, b.run, b.speed, b.km, b.block, b.loc, b.UN1L, b.UN1R, b.AL1L, b.AL1R, b.UN2L, b.UN2R, b.AL2L, b.AL2R, b.AVG, b.TQIC, b.MI, { N: 'CBML', P: 'PML', 0: '-' }[b.irpwm], b.drivers, b.MI_G, b.nbmlN, b.nbmlList, b.umlN, b.umlList, b.zone, b.curve, b.turnouts, b.lc, b.sej, b.fpN, b.gjN, b.tampLast, b.tampMachine, b.dsLast, b.cleanMin, b.slCracked, b.slMisaligned, b.state, b.rootCause, b.priority, b.action, b.stretch || '', b.prevStatus ? ({ N: 'CBML', P: 'PML', 0: '-' }[b.prevStatus] + (b.repeat ? ' (repeat)' : '')) : '', b.risk != null ? Math.round(b.risk * 100) : null, b.atRisk ? 'YES' : '']),
    styleFn: (row, c) => c === 17 ? (row[17] === 'CBML' ? ST.red : row[17] === 'PML' ? ST.yellow : null) : c === 39 ? priStyle(row[39]) : c === 37 ? (String(row[37]).startsWith('Attended') ? ST.green : String(row[37]).startsWith('Pending') ? ST.orange : null) : null });
  S.push({ name: 'Tamping stretches', headers: ['Stretch', 'Line', 'Run', 'Speed', 'From', 'To', 'Length (m)', 'CBML blocks', 'TMS MI=N blocks', 'Gap blocks', 'Type', 'What is out', 'Turnouts inside', 'Low cushion inside', 'All attended after run'],
    widths: [26, 22, 10, 6, 10, 10, 9, 9, 9, 8, 14, 60, 30, 9, 10], wrap: new Set([11, 12]), rows: R.stretches.map(s => [s.id, s.lineId, s.run, s.speed, s.from, s.to, s.length, s.cbml, s.tmsN, s.gaps, s.kind, s.drivers, s.turnouts, s.lowCushion ? 'Yes' : '', s.attended ? 'Yes' : '']) });
  S.push({ name: 'Peak locations', headers: ['Line', 'Run', 'KM', 'From (m)', 'To (m)', 'Location', 'Block', 'Parameter', 'Worst value', 'Samples', 'Limit', 'Band', 'Source', 'Near'],
    widths: [22, 10, 6, 8, 8, 12, 6, 9, 9, 7, 10, 7, 12, 40], wrap: new Set([13]), rows: R.peaks.map(p => [p.lineId, p.run, p.km, p.from, p.to, p.loc, p.block, p.param, p.value, p.n, String(p.limit), p.status, p.src === 'uml' ? 'TMS UML list' : 'Top-10 list', p.context]),
    styleFn: (row, c) => c === 11 && row[11] === 'UML' ? ST.red : null });
  S.push({ name: 'Zones', title: 'Block sections and yards (yards from P&C register: first to last turnout ±50 m)', headers: ['Line', 'Zone', 'Location', 'Blocks', 'Over PML', 'CBML', '% over PML', 'Limit', 'Through tamping?'],
    widths: [22, 18, 24, 8, 8, 8, 9, 7, 12], pctCols: new Set([6, 7]), rows: R.yards.map(z => [z.lineId, z.zone, z.loc, z.blocks, z.overPML, z.cbml, z.pct, z.limit, z.through ? 'YES' : '']), styleFn: (row, c) => c === 8 && row[8] === 'YES' ? ST.red : null });
  const chk = [...R.checks.map(c => [c.lineId, c.check, c.result, c.verdict]), ...R.crossTMS.map(c => [c.lineId, 'TMS Tamping-due report (CBML plain-track TKM)', `TMS required ${c.tmsReq} km (done ${c.tmsDone}) | calculated ${c.mine} km | MI-column basis ${c.miCol} km`, c.match + (c.note ? ' – ' + c.note : '')]),
    ...store.pages.filter(p => p.problems.length).map(p => [p.section || '?', 'Page: ' + p.file, p.problems.join(', '), 'Recapture or check'])];
  S.push({ name: 'Checks', headers: ['Line', 'Check', 'Result', 'Verdict'], widths: [22, 50, 70, 40], wrap: new Set([1, 2, 3]), rows: chk, styleFn: (row, c) => c === 3 ? (/MATCH|Match/.test(row[3]) ? ST.green : ST.yellow) : null });
  if (R.trend.length) S.push({ name: 'Trend', headers: ['Line', 'Run', 'Previous run', 'CBML now', 'CBML before', 'Avg TQIC now', 'Avg TQIC before', 'Repeat CBML blocks'], widths: [22, 11, 11, 9, 9, 10, 10, 10], rows: R.trend.map(t => [t.lineId, t.run, t.prev, t.cbml, t.prevCbml, t.tqic && +t.tqic.toFixed(2), t.prevTqic && +t.prevTqic.toFixed(2), t.repeat]) });
  const lim = []; for (const b of BANDS) { for (const p of ['UN1', 'AL1', 'UN2', 'AL2']) lim.push([b.label, p, b[p][0] ?? '-', b[p][1] ?? '-', b[p][2] ?? '-', '-']); lim.push([b.label, 'TW1 (3 m base)', '-', `${b.TW1[0]} mm/m (${b.TW1[0] * 3} mm)`, '-', `${b.TW1[1]} mm/m (${b.TW1[1] * 3} mm)`]); lim.push([b.label, 'Gauge isolated straight / R≥440 / R<440', '-', `${b.G.s[0]}/+${b.G.s[1]} ; ${b.G.c1[0]}/+${b.G.c1[1]} ; ${b.G.c2[0]}/+${b.G.c2[1]}`, '-', `${b.G.s[2]}/+${b.G.s[3]} ; ${b.G.c1[2]}/+${b.G.c1[3]} ; ${b.G.c2[2]}/+${b.G.c2[3]}`]); lim.push([b.label, 'Accelerations', '-', '-', '-', b.ACC + ' g']); }
  S.push({ name: 'Limits used', title: 'IRPWM 2024 Para 522 limits', headers: ['Speed band (km/h)', 'Parameter', 'PML SD', 'NBML/CBML', 'NBML peak (mm)', 'UML'], widths: [14, 36, 9, 34, 12, 34], rows: lim });
  return writeXLSX(S);
}

const jobKey = t => [t.lineId, t.cat, t.from, t.to].join('|');

return { buildWorkbook, jobKey };
})();
__m['registers.js'] = (function(){
// TMS inspection registers (iText PDFs): Foot plate, Rear vehicle, On foot, Trolley.
// Input: pdfPages() output. Output: one record per inspection.

const TITLE = /(FOOT PLATE|REAR VEHICLE|ON FOOT|TROLLEY) INSPECTION REGISTER/i;
const TYPE = { 'FOOT PLATE': 'FP', 'REAR VEHICLE': 'RV', 'ON FOOT': 'FOOT', 'TROLLEY': 'TROLLEY' };
const LABELS = ['Route', 'Section', 'Line', 'KM Stretch', 'Train No.', 'Engine No.', 'Loco Pilot', 'Coach No.', 'Guard Name', 'Inspection Date', 'Entry Date', 'Inspecting Official', 'Asst. Loco Pilot', 'Type of Inspection'];
const DATE = /(\d\d)\/(\d\d)\/(\d{4})/;
const iso = s => { const m = String(s || '').match(DATE); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

function isRegister(pages) { return pages.slice(0, 2).some(pg => pg.slice(0, 3).some(r => r.cells.some(c => TITLE.test(c.txt)))) || !!formKind(pages); }

function parseRegister(pages) {
  if (!pages.slice(0, 2).some(pg => pg.slice(0, 3).some(r => r.cells.some(c => TITLE.test(c.txt))))) { const fk = formKind(pages); if (fk) return parseForms(pages, fk); }
  const out = []; let cur = null, mode = 'head', orphan = null, wantDesig = false;
  const finish = () => { if (cur) { finalize(cur); out.push(cur); } cur = null; };
  for (const pg of pages) for (const row of pg) {
    const texts = row.cells.map(c => c.txt.trim()).filter(Boolean);
    if (!texts.length) continue;
    const t = texts.find(x => TITLE.test(x));
    if (t) { finish(); cur = { type: TYPE[t.match(TITLE)[1].toUpperCase()], f: {}, defects: [], remarks: [] }; mode = 'head'; orphan = null; wantDesig = false; continue; }
    if (!cur) continue;
    if (mode === 'head') {
      if (wantDesig && /^\(.*\)$/.test(texts.join(' '))) { cur.f['Inspecting Official'] = (cur.f['Inspecting Official'] || '') + ' ' + texts.join(' '); wantDesig = false; continue; }
      if (texts.length === 1 && texts[0].startsWith(':')) { orphan = texts[0].slice(1).trim(); continue; }
      const cells = row.cells.map(c => c.txt.trim());
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]; if (!c) continue;
        const inl = c.match(/^(Section|Line|KM Stretch)\s*:\s*(.*)$/);
        if (inl) { cur.f[inl[1]] = inl[2].trim(); continue; }
        if (LABELS.includes(c)) {
          const nx = cells[i + 1];
          if (nx != null && nx.startsWith(':')) { cur.f[c] = nx.slice(1).trim(); i++; if (c === 'Inspecting Official' && !/\(.+\)\s*$/.test(cur.f[c])) wantDesig = true; }   // the designation often stands alone on the next row
          else if (c === 'Inspecting Official') { cur.f[c] = orphan || ''; orphan = null; wantDesig = true; }
        }
      }
      if (/^Sr\.?$/.test(texts[0]) || texts.includes('Location From')) mode = 'defhead';
      continue;
    }
    const line = texts.join(' ');
    if (/^General Remarks/.test(line)) { mode = 'remarks'; continue; }
    if (mode === 'defhead') { if (/^(km|Kilometer)\b/i.test(texts[0])) mode = 'defects'; continue; }
    if (mode === 'defects') {
      if (DATE.test(texts[texts.length - 1]) && texts.length >= 6) cur.defects.push({ cells: texts, compliance: iso(texts[texts.length - 1]) });
      else if (/^Remark:/.test(line) && cur.defects.length) cur.defects[cur.defects.length - 1].remark = line.replace(/^Remark:\s*/, '');
      continue;
    }
    if (mode === 'remarks') { if (/^Compliance$|^Date$/.test(line)) continue; if (/^\d+\.\s/.test(line) || !cur.remarks.length) cur.remarks.push(line); else cur.remarks[cur.remarks.length - 1] += ' ' + line; }
  }
  finish();
  return out;
}

function finalize(r) {
  const f = r.f;
  r.route = (f['Route'] || f['Section'] || '').replace(/\s+/g, ' ').trim();
  r.line = (f['Line'] || '').trim();
  const ks = (f['KM Stretch'] || '').match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
  r.kmA = ks ? +ks[1] : null; r.kmB = ks ? +ks[2] : null;
  const dates = String(f['Inspection Date'] || '').match(/\d\d\/\d\d\/\d{4}/g) || [];
  r.date = iso(dates[0]); r.dateTo = iso(dates[1] || dates[0]);
  r.entry = iso(f['Entry Date']);
  const off = String(f['Inspecting Official'] || '').replace(/\s+/g, ' ').trim();
  const m = off.match(/^(.*?)\s*\((.+)\)\s*$/);
  r.official = m ? m[1].trim() : off; r.desig = m ? m[2].trim().toUpperCase().replace(/\s+/g, '') : '';
  const u = r.desig.match(/^SSE\/P\.?WAY\/(.+)$/); r.unit = u ? u[1] : null;
  r.subType = f['Type of Inspection'] || '';
  r.train = f['Train No.'] || '';
  r.key = [r.type, r.date, r.desig, r.route, r.line, r.kmA, r.kmB, (f['Inspection Date'] || '').slice(11, 16)].join('|');
  r.defectN = r.defects.length; r.remarkN = r.remarks.length;
  delete r.f;
}

// ---------- asset inspection registers (TMS): curve, P&C, diamond, LC, LWR, ballast, rail, sleeper ----------
// One record per inspection (an asset or stretch, a date, who). Kept as inspection history; readings are not used yet.
const FORMS = [
  ['PXING_JOINT', /^JOINT INSPECTION OF POINTS AND CROSSINGS?/i],
  ['USFD', /INSPECTION OF USFD MACHINE AND WORK/i],
  ['PXING_INT', /PROFORMA FOR INTERMEDIATE INSPECTION OF POINTS/i],
  ['PXING', /PROFORMA FOR INSPECTION OF POINTS AND CROSSING/i],
  ['CURVE', /^CURVE INSPECTION REGISTER/i],
  ['LC', /^LEVEL CROSSINGS? INSPECTION BOOK/i],
  ['LWR', /^CHART OF MOVEMENT OF LWR/i],
  ['BALLAST', /^BALLAST INSPECTION REGISTER/i],
  ['RAIL', /^RAIL INSPECTION REGISTER/i],
  ['SLEEPER', /^SLEEPER INSPECTION REGISTER/i]
];
const FORM_NAME = { OTHER: 'Other inspections', USFD: 'USFD machine & work inspection', PXING_JOINT: 'Joint P&C inspection (with S&T)', GENERIC: 'Inspection', CURVE: 'Curve inspection', PXING: 'P&C inspection', DIAMOND: 'Diamond crossing inspection', PXING_INT: 'Intermediate P&C inspection', LC: 'Level crossing inspection', LWR: 'LWR movement chart', BALLAST: 'Ballast inspection', RAIL: 'Rail inspection', SLEEPER: 'Sleeper inspection' };
const txt = r => r.cells.map(c => c.txt.trim()).filter(Boolean);
// "Other Inspections" (AT welding at site, yard line, night, gang, TR/DS site, monsoon patrolling, office & store …): a title line,
// then "Inspecting Official : name (designation)" and "Inspection Date : dd/mm/yyyy" on one row
const isOtherHead = r => { const t = txt(r); return t.some(x => /^Inspecting Official$/i.test(x)) && t.some(x => /^Inspection Date$/i.test(x)); };
// any other register page: a date label and an official (general fallback, so a new feature type is not lost)
const DATE_LBL = /^(Inspection Date|Date of Inspection|Inspected on|Date)\s*:?\s*(\d\d\/\d\d\/\d{4})?/i;
const WHO_LBL = /^(Inspecting Official|Inspected By|Inspection Authority|Machine Inspected By|Inspecting Officer|Name of Inspecting Official)\b/i;
function genericPage(pg) { const t = pg.map(r => txt(r).join(' | ')).join('\n'); return /(Inspection Date|Date of Inspection)/i.test(t) && /(Inspecting Official|Inspected By|Inspection Authority|Inspecting Officer|Signature of PWI)/i.test(t) && D.test(t); }
function formKind(pages) {
  for (const pg of pages.slice(0, 2)) for (const r of pg.slice(0, 4)) for (const c of r.cells) { const t = c.txt.trim(); for (const [k, re] of FORMS) if (re.test(t)) return k; }
  if (pages.slice(0, 2).some(pg => pg.slice(0, 3).some(r => r.cells.some(c => TITLE.test(c.txt))))) return null;   // FP / RV / on foot / trolley register
  if (pages.slice(0, 2).some(pg => pg.slice(0, 8).some(isOtherHead))) return 'OTHER';
  if (pages.slice(0, 3).some(genericPage)) return 'GENERIC';
  return null;
}
const D = /(\d\d)\/(\d\d)\/(\d{4})/;
const dmy = s => { const m = String(s || '').match(D); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const kmOf = s => { s = String(s || ''); let m = s.match(/(-?\d+)\s*km\s*(\d+)\s*m/i); if (m) return +m[1] + +m[2] / 1000; m = s.match(/(-?\d+(?:\.\d+)?)/); return m ? +m[1] : null; };
const clean = s => String(s || '').replace(/^[:\-\s]+/, '').replace(/\s+/g, ' ').trim();
// designation as used elsewhere: SSE/P.WAY/<unit>; a sectional SSE becomes SSE/P.WAY/SEC/<unit> (not the in-charge)
function normDesig(d) {
  let x = String(d || '').toUpperCase().replace(/\s+/g, ''); const sec = /\((SECTIONAL|SEC)\)$/.test(x); x = x.replace(/\((SECTIONAL|SEC)\)$/, '');
  x = x.replace(/^(SSE|JE)\/(P\.?WAY|PW)\//, '$1/P.WAY/'); if (sec && /^SSE\/P\.WAY\/[^/]+$/.test(x)) x = x.replace('SSE/P.WAY/', 'SSE/P.WAY/SEC/');
  return x;
}
const unitOfDesig = d => { const m = normDesig(d).match(/^(?:SSE|JE)\/P\.WAY\/(?:\d+\/|SEC\/)?([A-Z0-9()]+)$/); return m ? m[1] : null; };
// value of a label: "Label : value" in one cell, or the label cell followed by ": value" / "value"
function field(rows, re) {
  for (const r of rows) { const cs = r.cells.filter(c => c.txt.trim()); for (let i = 0; i < cs.length; i++) { const t = cs[i].txt.trim(); const m = t.match(re); if (!m) continue; const rest = clean(t.slice(m[0].length)); if (rest) return rest; if (cs[i + 1]) return clean(cs[i + 1].txt); return ''; } }
  return '';
}
// the cells to the right of a label on its row, split into the two inspection columns at x = mid
function cols(rows, re, mid) {
  for (let k = 0; k < rows.length; k++) { const cs = rows[k].cells.filter(c => c.txt.trim()); const i = cs.findIndex(c => re.test(c.txt.trim())); if (i < 0) continue; const o = [[], []]; cs.slice(i + 1).forEach(c => o[c.x < mid ? 0 : 1].push(clean(c.txt))); return { k, v: o.map(a => a.filter(Boolean).join(' ')) }; }
  return null;
}
function rec(type, f) {
  const desig = normDesig(f.desig);
  const r = { type, subType: f.subType || '', asset: f.asset || '', route: clean(f.route), line: clean(f.line), kmA: f.kmA ?? null, kmB: f.kmB ?? f.kmA ?? null, date: f.date, dateTo: f.date, entry: f.entry || null, official: clean(f.official), desig, unit: unitOfDesig(desig), defects: [], remarks: [], defectN: 0, remarkN: 0, station: f.station || '' };
  r.key = [type, r.asset, r.route, r.line, r.date, r.desig, r.kmA, r.kmB].join('|');
  return r;
}
function parseForms(pages, kind) {
  if (kind === 'GENERIC') { const out = []; pages.forEach(pg => { if (!genericPage(pg)) return; try { out.push(...P.GENERIC(pg)); } catch (e) { } }); const seen = new Set(); return out.filter(r => r.date && !seen.has(r.key) && seen.add(r.key)); }
  const all = []; pages.forEach(pg => pg.forEach(r => all.push(r)));
  if (kind === 'OTHER') {   // one record per titled block
    const out = []; const heads = []; all.forEach((r, i) => { if (isOtherHead(r)) heads.push(i); });
    heads.forEach((h, n) => { const rows = all.slice(Math.max(0, h - 1), n + 1 < heads.length ? heads[n + 1] - 1 : all.length); try { out.push(...P.OTHER(rows)); } catch (e) { } });
    const seen = new Set(); return out.filter(r => r.date && !seen.has(r.key) && seen.add(r.key));
  }
  const re = FORMS.find(f => f[0] === kind)[1];
  const starts = []; all.forEach((r, i) => { if (r.cells.some(c => re.test(c.txt.trim()))) starts.push(i); });
  const out = [];
  starts.forEach((a, n) => { const rows = all.slice(n === 0 ? Math.max(0, a - 2) : a, starts[n + 1] ?? all.length); try { out.push(...(P[kind] || (() => []))(rows)); } catch (e) { /* one damaged form does not stop the file */ } });
  const seen = new Set(); return out.filter(r => r.date && !seen.has(r.key) && seen.add(r.key));
}
const P = {
  CURVE(rows) {
    const route = field(rows, /^Section\/Station\s*:?/i), line = field(rows, /^Line\s*:?/i), no = field(rows, /^Curve No\.?\s*:?/i);
    const from = kmOf(field(rows, /^From\s*:?/i)), to = kmOf(field(rows, /^To\s*:?/i));
    const hd = rows.find(r => r.cells.some(c => /Details of Inspection/i.test(c.txt))); if (!hd) return [];
    const dates = [null, null]; hd.cells.forEach(c => { const d = dmy(c.txt); if (d && /Details of Inspection/i.test(c.txt)) dates[c.x < 300 ? 0 : 1] = d; });
    const nm = cols(rows, /^Inspecting off?ic?i?al/i, 300), dg = cols(rows, /^Designation/i, 300), en = cols(rows, /^Entry Date/i, 300);
    return [0, 1].filter(i => dates[i]).map(i => rec('CURVE', { asset: 'Curve ' + no, subType: 'Curve ' + no, route, line, kmA: from, kmB: to, date: dates[i], official: nm && nm.v[i], desig: dg && dg.v[i], entry: en && dmy(en.v[i]) }));
  },
  PXING(rows) {
    if (rows.some(r => r.cells.some(c => /Diamond Crossing|Annexure-2\/6\s*\(D\)/i.test(c.txt)))) return P.DIAMOND(rows);
    const route = field(rows, /^Section\/Station\s*:?/i), station = field(rows, /^Operating Station\s*:?/i), no = field(rows, /^Point No\.?\s*:?/i), at = kmOf(field(rows, /^Location\s*:?/i));
    const dr = rows.find(r => r.cells.filter(c => D.test(c.txt) && /^\d\d\/\d\d\/\d{4}$/.test(c.txt.trim())).length && r.cells.some(c => /with Date/i.test(c.txt)));
    if (!dr) return [];
    const dates = [null, null]; dr.cells.forEach(c => { if (/^\d\d\/\d\d\/\d{4}$/.test(c.txt.trim())) dates[c.x < 320 ? 0 : 1] = dmy(c.txt); });
    const by = [null, null]; rows.forEach(r => r.cells.forEach(c => { const m = c.txt.trim().match(/^Done By:\s*(.+)$/i); if (m) by[c.x < 320 ? 0 : 1] = m[1]; }));
    const nm = cols(rows, /^\d*\.?\s*Inspecting Official/i, 320), dg = cols(rows, /^\d*\.?\s*Designation/i, 320), en = cols(rows, /^\d*\.?\s*Entry Date/i, 320);
    // names often wrap onto the rows just above and below the label
    if (nm) [nm.k - 1, nm.k + 1].forEach(k => { const r = rows[k]; if (!r || r.cells.some(c => c.x < 100 && c.txt.trim())) return; r.cells.forEach(c => { const t = clean(c.txt); if (t && /^[A-Za-z .]+$/.test(t)) { const i = c.x < 320 ? 0 : 1; nm.v[i] = k < nm.k ? (t + ' ' + nm.v[i]).trim() : (nm.v[i] + ' ' + t).trim(); } }); });
    return [0, 1].filter(i => dates[i]).map(i => rec('PXING', { asset: 'Point ' + no, subType: 'Point ' + no + (station ? ' (' + station + ')' : ''), station, route, line: '', kmA: at, date: dates[i], official: nm && nm.v[i], desig: (dg && dg.v[i]) || by[i], entry: en && dmy(en.v[i]) }));
  },
  DIAMOND(rows) {
    const no = field(rows, /^Point No\.?\s*:?/i), station = field(rows, /^Operating Station\s*:?/i);
    const route = field(rows, /^Section\/Station\s*1?\s*:/i), line = field(rows, /^Line\s*1?\s*:/i), at = kmOf(field(rows, /^Location\s*:\s*(?=\d)/i));
    const date = dmy(field(rows, /^Inspection Date\s*:?/i)); if (!date) return [];
    return [rec('DIAMOND', { asset: 'Point ' + no, subType: 'Diamond ' + no + (station ? ' (' + station + ')' : ''), station, route, line, kmA: at, date, official: field(rows, /^Inspecting off?ic?i?al\s*:?/i), desig: field(rows, /^Designation\s*:?/i), entry: dmy(field(rows, /^Entry Date\s*:?/i)) })];
  },
  LC(rows) {
    const route = field(rows, /^Section\s*:/i), no = field(rows, /^Crossing No\.?\s*:/i), gate = field(rows, /^Gate Type\s*:/i), at = kmOf(field(rows, /^Location\s*:/i));
    const dates = [null, null]; for (const r of rows.slice(0, 14)) { const cs = r.cells.filter(c => /^\d\d\/\d\d\/\d{4}/.test(c.txt.trim())); if (cs.length && r.cells.every(c => !c.txt.trim() || /^\d\d\/\d\d\/\d{4}/.test(c.txt.trim()))) { cs.forEach(c => dates[c.x < 400 ? 0 : 1] = dmy(c.txt)); break; } }
    const nm = cols(rows, /^Inspection Authority\s*:?/i, 400), dg = cols(rows, /^Designation\s*:?/i, 400), en = cols(rows, /^Entry Date\s*:?/i, 400);
    return [0, 1].filter(i => dates[i]).map(i => rec('LC', { asset: 'LC ' + no, subType: 'LC ' + no + (gate ? ' (' + gate + ')' : ''), route, line: '', kmA: at, date: dates[i], official: nm && nm.v[i], desig: dg && dg.v[i], entry: en && dmy(en.v[i]) }));
  },
  LWR(rows) {
    const t = rows.map(r => txt(r).join(' ')).join('\n');
    const no = (t.match(/LWR\/CWR No\.?:\s*([^\s|]+)/i) || [])[1] || ''; const kms = [...t.matchAll(/at km\s*(-?\d+(?:\.\d+)?)/gi)].map(m => +m[1]);
    const ds = new Set(); rows.forEach(r => { const c = r.cells.find(c => c.txt.trim()); if (c && c.x < 60 && /^\d\d\/\d\d\/\d{4}$/.test(c.txt.trim())) ds.add(dmy(c.txt)); });
    const official = field(rows, /^Measured by:?/i), desig = field(rows, /^Designation:?/i), entry = dmy(field(rows, /^Entry Date:?/i));
    return [...ds].map(d => rec('LWR', { asset: 'LWR ' + no, subType: 'LWR ' + no, route: '', line: '', kmA: kms.length ? Math.min(...kms) : null, kmB: kms.length ? Math.max(...kms) : null, date: d, official, desig, entry }));
  },
  BALLAST(rows) { return P._stretch('BALLAST', rows); },
  RAIL(rows) { return P._stretch('RAIL', rows); },
  _stretch(type, rows) {
    const date = dmy(field(rows, /^Inspection Date\s*:?/i)); if (!date) return [];
    return [rec(type, { route: field(rows, /^Section\s*:?/i), line: field(rows, /^Line\s*:?/i), kmA: kmOf(field(rows, /^Location From\s*:/i) || field(rows, /^Location From\s*$/i)), kmB: kmOf(field(rows, /^Location To\s*:/i) || field(rows, /^Location To\s*$/i)), date, desig: field(rows, /^Inspection Authority\s*:?/i) })];
  },
  SLEEPER(rows) {
    const date = dmy(field(rows, /^Inspection Date\s*:?/i)); if (!date) return [];
    const off = field(rows, /^Inspecting Official\s*:?/i); const m = off.match(/^(.*?)\s+-\s+(\S+.*)$/);
    const lines = new Set(), kms = [];
    // columns by position (a blank "to" metre would otherwise shift the counts into the location)
    rows.forEach(r => { const cs = r.cells.filter(c => c.txt.trim()); if (!cs.length || !/line$/i.test(cs[0].txt.trim())) return; const at = (lo, hi) => { const c = cs.find(c => c.x >= lo && c.x < hi && /^\d+$/.test(c.txt.trim())); return c ? +c.txt.trim() : null; };
      const k1 = at(80, 130), m1 = at(130, 180), k2 = at(180, 230), m2 = at(230, 280); if (k1 == null) return; lines.add(cs[0].txt.trim()); kms.push(k1 + (m1 || 0) / 1000); if (k2 != null) kms.push(k2 + (m2 || 0) / 1000); });
    return [rec('SLEEPER', { route: field(rows, /^Section\s*:?/i), line: [...lines].join(', '), kmA: kms.length ? Math.min(...kms) : null, kmB: kms.length ? Math.max(...kms) : null, date, official: m ? m[1] : off, desig: m ? m[2] : '' })];
  },
  PXING_INT() { return []; },
  // 97 Other Inspections: title row, then the official "name (designation)" / date row, Route or Station, Location or Line
  OTHER(rows) {
    const h = rows.findIndex(isOtherHead); if (h < 0) return [];
    const title = h > 0 ? txt(rows[h - 1]).join(' ') : ''; const head = rows[h].cells.filter(c => c.txt.trim());
    const val = re => { const i = head.findIndex(c => re.test(c.txt.trim())); return i >= 0 && head[i + 1] ? clean(head[i + 1].txt) : ''; };
    let off = val(/^Inspecting Official$/i); const date = dmy(val(/^Inspection Date$/i)); if (!date) return [];
    // the designation often wraps onto the next row(s) under the name: "(SSE/P.WAY/BWN(W))", or ")" alone
    for (let k = h + 1; k < Math.min(rows.length, h + 3) && !/\(.+\)\s*$/.test(off); k++) { const cs = rows[k].cells.filter(c => c.txt.trim() && c.x > 90 && c.x < 290); if (!cs.length || rows[k].cells.some(c => c.txt.trim() && c.x < 90)) break; off = (off + ' ' + cs.map(c => c.txt.trim()).join(' ')).replace(/\s+/g, ' ').trim(); }
    const m = off.match(/^(.*?)\s*\((.+)\)\s*$/);
    const top = rows.slice(h, h + 4);
    const loc = field(top, /^Location\s*:?$/i); const kms = [...loc.matchAll(/(-?\d+)\s*km\s*(\d+)\s*m/gi)].map(x => +x[1] + +x[2] / 1000);
    return [rec('OTHER', { subType: /^[A-Za-z][A-Za-z &/().,-]{3,80}$/.test(title) ? title : 'Other inspection', route: field(top, /^Route\s*:?$/i) || field(top, /^Station\s*:?$/i), line: field(top, /^Line(\/Loop Line)?\s*:?$/i), kmA: kms.length ? Math.min(...kms) : null, kmB: kms.length ? Math.max(...kms) : null, date, official: m ? m[1] : off, desig: m ? m[2] : '', entry: dmy(field(top, /^Entry Date\s*:?$/i)) })];
  },
  // 99 Of USFD Work: "INSPECTION OF USFD MACHINE AND WORK OF PWI(USFD)"
  USFD(rows) {
    const date = dmy(field(rows, /^Date of Inspection\s*:?/i)); if (!date) return [];
    const from = kmOf(field(rows, /^Location From\s*:?/i)), to = kmOf(field(rows, /^Location To\s*:?/i));
    return [rec('USFD', { subType: 'USFD machine & work', route: field(rows, /^Section\/Station\s*:?/i), line: field(rows, /^Line\/Loopline\/Xover\s*:?/i), kmA: from, kmB: to ?? from, date, official: field(rows, /^Machine Inspected By\s*:?/i), desig: field(rows, /^Designation\s*:?/i) })];
  },
  // 28 Points & Crossing (Joint) – joint inspection with S&T; the P-Way official signs on the right ("Signature of PWI with Date")
  PXING_JOINT(rows) {
    const date = dmy(field(rows, /^Date of Inspection\s*:?/i)); if (!date) return [];
    const no = field(rows, /^Point No\.?\s*:?/i), station = field(rows, /^Operating Station\s*:?/i), at = kmOf(field(rows, /^Location\s*:?$/i) || field(rows, /^Location\s*:/i));
    let official = '', desig = '';
    const k = rows.findIndex(r => r.cells.some(c => /Signature of PWI/i.test(c.txt)));
    if (k >= 0) { const x0 = rows[k].cells.find(c => /Signature of PWI/i.test(c.txt)).x - 60;
      for (const r of rows.slice(k + 1, k + 8)) for (const c of r.cells) { if (c.x < x0) continue; const t = clean(c.txt); if (!t) continue; const m = t.match(/^\((.+)\)$/); if (m) { if (!desig) desig = m[1]; } else if (!official && !desig) official = t; } }
    return [rec('PXING_JOINT', { asset: 'Point ' + no, subType: 'Joint P&C, point ' + no + (station ? ' (' + station + ')' : ''), station, route: field(rows, /^Section\/Station\s*:?/i), line: '', kmA: at, date, official, desig, entry: dmy(field(rows, /^Entry Date\s*:?/i)) })];
  },
  // general fallback for any other register page
  GENERIC(pg) {
    const rows = pg; let date = null, who = '', desig = '';
    for (const r of rows) { const cs = r.cells.filter(c => c.txt.trim()); for (let i = 0; i < cs.length; i++) { const t = cs[i].txt.trim();
      if (!date && /^(Inspection Date|Date of Inspection)/i.test(t)) date = dmy(t) || dmy(cs[i + 1] && cs[i + 1].txt);
      if (!who && WHO_LBL.test(t)) who = clean(t.replace(WHO_LBL, '')) || clean(cs[i + 1] && cs[i + 1].txt);
      if (!desig && /^Designation\b/i.test(t)) desig = clean(t.replace(/^Designation\s*:?/i, '')) || clean(cs[i + 1] && cs[i + 1].txt); } }
    if (!date) return [];
    const m = who.match(/^(.*?)\s*\((.+)\)\s*$/); if (m) { who = m[1]; desig = desig || m[2]; }
    if (!desig) { const d = rows.map(r => txt(r).join(' ')).find(t => /^\(\s*(SSE|JE|ADEN|AEN|DEN|Sr\.?\s*DEN)[^)]*\)$/i.test(t)); if (d) desig = d.replace(/[()]/g, '').trim(); }
    const title = (rows.map(r => txt(r).join(' ')).find(t => /[A-Za-z]{4}/.test(t)) || '').slice(0, 80);
    return [rec('GENERIC', { subType: title, route: field(rows, /^(Section\/Station|Section|Route|Station)\s*:?/i), line: field(rows, /^Line\s*:?/i), kmA: kmOf(field(rows, /^Location( From)?\s*:?/i)) , date, official: who, desig })];
  }   // sample seen so far is a blank form; a filled sample is needed to read it
};


return { isRegister, parseRegister, FORM_NAME, normDesig, formKind };
})();
__m['tmsreports.js'] = (function(){
// TMS KPI report parsers (Excel exports and pasted web tables). Each returns {kind, asOn, scope, records}.
const {sectionName, lineKey} = __m['names.js'];

const iso = s => {
  if (s == null || s === '') return null;
  if (typeof s === 'number' && s > 20000 && s < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + s * 864e5); return d.toISOString().slice(0, 10); }
  const t = String(s).trim(); let m = t.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/(\d{4})-(\d\d)-(\d\d)/); if (m) return m[0];
  m = t.match(/^([A-Za-z]{3})-(\d{4})$/); if (m) { const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[1].toLowerCase()) / 3 + 1; if (mo > 0) return `${m[2]}-${String(mo).padStart(2, '0')}-01`; }
  return null;
};

const isMainOG = (station, sections) => sections.includes(sectionName(station)) || /^[A-Z]{2,5}-[A-Z]{2,5}/.test(String(station || ''));
const S = v => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const N = v => { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(x) ? x : null; };
const unitOf = d => { const m = String(d || '').toUpperCase().replace(/\s+/g, '').match(/^SSE\/P\.?WAY\/(.+)$/); return m ? m[1] : null; };
const flat = rows => rows.slice(0, 3).map(r => (r || []).map(S).join(' ')).join(' ');
const titleOf = rows => S((rows[0] || [])[0]);
const grab = (t, re) => { const m = t.match(re); return m ? S(m[1]) : null; };

// ---------- classification of a sheet ----------
function classifyKpiSheet(rows, name = '') {
  const t = flat(rows).toLowerCase();
  if (/item wise score/.test(t)) return 'official';
  if (/oms inspection/.test(t) && /peak locations exceeding/.test(t)) return 'omsPeak';
  if (/latest inspection report|last inspection report/.test(t)) return 'assetInsp';
  if (/fracture analysis/.test(t)) return 'fracture';
  if (/location needing attention/.test(t)) return 'lna';
  if (/dfwr/.test(t)) return 'dfwr';
  if (/oiling\s*&\s*greasing/.test(t)) return 'og';
  if (/section/.test(t) && /equivalent section/.test(t)) return 'jurisdiction';
  if (rows.slice(0, 40).some(r => (r || []).some(c => /^WHETHER\s+JOGGLED$/i.test(S(c))))) return 'weldReg';
  if (rows.slice(0, 40).some(r => (r || []).some(c => /^MONTH OF LAST OILING AND GREASING$/i.test(S(c))))) return 'fpReg';
  return null;
}

function parseKpiSheet(kind, rows, sheetName = '') {
  const P = { official, assetInsp, fracture, lna, dfwr, og, weldReg, fpReg, omsPeak }[kind];
  return P ? P(rows, sheetName) : null;
}

// OMS inspection – peak locations exceeding prescribed limits (km/m), one block per section and line.
// Snapshot per section: a peak missing from a later file of the same section is closed (the next OMS run cleared it).
function omsPeak(rows) {
  const asOn = iso(grab(S((rows[1] || [])[0]) + ' ' + flat(rows), /Reporting Date:\s*([\d\/]+)/));
  const recs = [], secs = new Set(); let cur = null, H = null;
  for (const r of rows) {
    const c0 = S((r || [])[0]);
    const sm = c0.match(/^Section:\s*(.+?)\s+Line:\s*(\S+(?:\s\d)?)\s+Sectional Speed:\s*(\d+)/i);
    if (sm) {
      const raw = sm[1].trim(); const pm = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/); const nm = pm ? pm[1] : raw, code = pm ? pm[2] : '';
      let section = sectionName(nm); if (section === nm && code && sectionName(code) !== code) section = sectionName(code);
      cur = { section, line: sm[2].toUpperCase(), speed: +sm[3] }; secs.add(section); H = null; continue;
    }
    if (/^Sr\.?\s*No/i.test(c0)) { const h = r.map(x => S(x).toLowerCase()); const f = re => h.findIndex(x => re.test(x)); H = { sse: f(/^sse/), loc: f(/^location/), v: f(/^vertical/), l: f(/^lateral/), date: f(/^run date/), run: f(/^run no/) }; continue; }
    if (!cur || !H || N(c0) == null || H.loc < 0) continue;
    const km = N(r[H.loc]), m = N(r[H.loc + 1]); if (km == null) continue;
    const v = H.v >= 0 ? N(r[H.v]) : null, l = H.l >= 0 ? N(r[H.l]) : null;
    const sse = H.sse >= 0 ? S(r[H.sse]) : ''; const run = H.run >= 0 ? S(r[H.run]) : '';
    const rec = { section: cur.section, line: cur.line, speed: cur.speed, km, m: m == null ? 0 : m, vertical: v, lateral: l, value: Math.max(v || 0, l || 0), dir: (l || 0) > (v || 0) ? 'Lateral' : 'Vertical', date: iso(H.date >= 0 ? r[H.date] : null) || (/^\d{4}-\d\d-\d\d/.test(run) ? run.slice(0, 10) : null), run, sse, unit: unitOf(sse) };
    rec.key = ['OMSPEAK', rec.section, lineKey(rec.line), rec.km, rec.m, rec.run || rec.date].join('|');
    recs.push(rec);
  }
  return { kind: 'omsPeak', asOn, scope: { sections: [...secs] }, records: recs, lines: rows.filter(r => /^Section:/i.test(S((r || [])[0]))).length };
}

// Official item-wise score popup (TMS performance matrix)
function official(rows) {
  const t = rows.slice(0, 2).map(r => S(r[0])).join(' ');
  const unit = unitOf(grab(t, /Jurisdiction of\s+(\S+)/)); const proc = iso(grab(t, /Processing Date:\s*([\d\/]+)/)); const rep = iso(grab(t, /Reporting Date:\s*([\d\/]+)/));
  const marks = {};
  for (const r of rows) { const k = N(r[0]); if (k >= 1 && k <= 16 && N(r[3]) != null) marks['K' + k] = N(r[3]); }
  const tot = rows.find(r => S(r[0]) === 'Total');
  return { kind: 'official', asOn: proc, scope: { unit }, records: [{ unit, procDate: proc, reportDate: rep, total: tot ? N(tot[3]) : null, ...marks }] };
}

// Latest inspection report: one sheet per asset type (LWR, Curve, P-Xing, L-Xing)
function assetInsp(rows, sheetName) {
  const type = /lwr/i.test(sheetName) ? 'LWR' : /curve/i.test(sheetName) ? 'CURVE' : /p-?xing/i.test(sheetName) ? 'PXING' : /l-?xing/i.test(sheetName) ? 'LXING' : sheetName.toUpperCase();
  const H = (rows[1] || []).map(S); const ci = k => H.findIndex(h => h.toLowerCase().includes(k));
  const iLat = ci('latest inspection'), iSSE = H.findIndex(h => h === 'SSE'), iJE = H.findIndex(h => h === 'JE'), iPax = ci('passenger'), iLoc = ci('location'), iNo = H.findIndex(h => /No\.$/.test(h));
  const recs = [];
  for (const r of rows.slice(3)) {
    if (!r || !S(r[0])) continue;
    const rec = { type, section: S(r[0]), id: S(r[iNo >= 0 ? iNo : 2]), sse: S(r[iSSE]), unit: unitOf(r[iSSE]), je: S(r[iJE]), lastJE: iso(r[iLat]), lastSSE: iso(r[iLat + 1]), lastADEN: iso(r[iLat + 2]) };
    if (type === 'LXING') { rec.line = ''; rec.loc = S(r[2]); const m = rec.loc.match(/(\d+)km\s*(\d+)m/); rec.km = m ? +m[1] : null; rec.m = m ? +m[2] : null; rec.manned = S(r[3]); }
    else if (type === 'PXING') { rec.line = S(r[1]); rec.station = S(r[2]); rec.km = N(r[iLoc]); rec.m = N(r[iLoc + 1]); rec.pax = S(r[iPax]) === 'Yes'; }
    else { rec.line = S(r[1]); rec.km = N(r[iLoc]); rec.m = N(r[iLoc + 1]); rec.kmB = N(r[iLoc + 2]); rec.mB = N(r[iLoc + 3]); }
    rec.key = [type, rec.section, rec.line, rec.id, rec.km, rec.m, rec.unit].join('|');
    recs.push(rec);
  }
  return { kind: 'assetInsp', asOn: null, scope: { type }, records: recs };
}

// Rail / weld fracture analysis
function fracture(rows) {
  const t = S(rows[0][0]); const H = (rows[1] || []).map(S); const weld = H.some(h => /Welding Date|Type of Weld/i.test(h)); const iF = H.findIndex(h => /Fracture Date/i.test(h));
  const recs = [];
  for (const r of rows.slice(3)) {
    if (N(r[0]) == null) continue;
    const rec = { type: weld ? 'WELD' : 'RAIL', section: sectionName(S(r[1])), line: S(r[2]), rail: S(r[3]), km: N(r[4]), m: N(r[5]), date: iso(r[iF]), detail: weld ? S(r[9]) : S(r[12]) };
    rec.key = [rec.type, rec.section, rec.line, rec.rail, rec.km, rec.m, rec.date].join('|');
    recs.push(rec);
  }
  const period = t.match(/Period:\s*([\d\/]+)\s*to\s*([\d\/]+)/);
  return { kind: 'fracture', asOn: period ? iso(period[2]) : null, scope: { section: sectionName(grab(t, /Section\/Station\s*:\s*(.+?)\s+(?:Rail|Weld) Fracture/) || ''), type: weld ? 'WELD' : 'RAIL', from: period ? iso(period[1]) : null }, records: recs };
}

// Locations needing attention (open defects) – snapshot per section
function lna(rows) {
  const t = S(rows[0][0]); const section = grab(t, /Section:\s*(.+?)\s+Location\s*:/); const asOn = iso(grab(t, /As on Date:\s*([\d\/]+)/));
  const recs = [];
  for (const r of rows.slice(3)) {
    if (N(r[0]) == null) continue;
    const rec = { section: section ? sectionName(section) : '', feature: S(r[1]), number: S(r[2]), item: S(r[3]), km: N(r[4]), m: N(r[5]), kmB: N(r[6]), mB: N(r[7]), post: S(r[8]), line: S(r[9]), by: S(r[10]), unit: unitOf(r[10]) || (S(r[10]).split('/').pop() || null), date: iso(r[11]) };
    rec.key = ['LNA', rec.section, rec.line, rec.feature, rec.number, rec.item, rec.km, rec.m, rec.date].join('|');
    recs.push(rec);
  }
  return { kind: 'lna', asOn, scope: { sections: section ? [sectionName(section)] : [...new Set(recs.map(r => r.section))] }, records: recs };
}

// DFWR analysis (USFD defects) – snapshot
function dfwr(rows) {
  const recs = [];
  for (const r of rows.slice(2)) {
    if (!S(r[0]) || !/^\d+$/.test(S(r[0]))) continue;
    const rec = { section: sectionName(S(r[1])), line: S(r[2]), rail: S(r[3]), km: N(r[4]), m: N(r[5]), postFrom: S(r[6]), postTo: S(r[7]), date: iso(r[8]), defect: S(r[9]), railSection: S(r[10]) };
    rec.key = ['DFWR', rec.section, rec.line, rec.rail, rec.km, rec.m, rec.date].join('|');
    recs.push(rec);
  }
  return { kind: 'dfwr', asOn: null, scope: { sections: [...new Set(recs.map(r => r.section))] }, records: recs };
}

// Overdue oiling & greasing of FP joints – snapshot per SSE unit
function og(rows) {
  const t = S(rows[0][0]); const unit = unitOf(grab(t, /jurisdiction of:\s*(\S+)/i));
  const recs = [];
  for (const r of rows.slice(3)) {
    if (N(r[0]) == null) continue;
    const st = S(r[1]); const rec = { unit, station: st, main: /-/.test(st) || st.length > 6, line: S(r[2]), rail: S(r[3]), km: N(r[4]), m: N(r[5]), last: iso(r[6]), next: iso(r[7]), elongated: S(r[8]), crack: S(r[9]) };
    rec.key = ['OG', unit, rec.station, rec.line, rec.rail, rec.km, rec.m].join('|');
    recs.push(rec);
  }
  return { kind: 'og', asOn: null, scope: { unit }, records: recs };
}

// Weld asset register – summary only (AT welds, joggled or not, welded in last 6 months)
function weldReg(rows) {
  const hi = rows.findIndex(r => (r || []).some(c => /^WHETHER\s+JOGGLED$/i.test(S(c)))); const H = rows[hi].map(S);
  const c = k => H.indexOf(k); const iSec = c('SECTION'), iLine = c('LINE'), iType = c('WELD TYPE'), iDate = c('DATE OF WELDING'), iJog = c('WHETHER JOGGLED'), iKm = c('KM FROM'), iM = c('MET FROM'), iStn = c('STATION'), iX = c('XOVER'), iRes = c('LAST USFD INSP. RESULT'), iWT = c('LAST USFD TESTING DATE(WELD)');
  const recs = [];
  for (const r of rows.slice(hi + 1)) {
    if (!r || !S(r[iType])) continue;
    const at = /thermit|\bAT\b/i.test(S(r[iType]));
    recs.push({ section: sectionName(S(r[iSec]) || S(r[iStn]) || S(r[iX])), main: !!S(r[iSec]), line: S(r[iLine]) || S(r[iX]), rail: S(r[c('LR OR RR')]), km: N(r[iKm]), m: N(r[iM]), at, type: S(r[iType]), date: iso(r[iDate]), joggled: /^yes$/i.test(S(r[iJog])), usfd: S(r[iRes]), usfdWeld: iso(r[iWT]) });
  }
  return { kind: 'weldReg', asOn: null, scope: { sections: [...new Set(recs.map(r => r.section))] }, records: recs };
}
// [E] K12 (TMS AT Welds Done/Defective report: "Defective % based on latest testing of welds done during the period"): latest USFD result other than good
const weldDefective = res => { const s = String(res || '').trim(); return !!s && !/^(GW|OK|-|NIL|GOOD|UNTESTED|NOT TESTED)$/i.test(s) && !/untested/i.test(s); };
// K13: welds that need joggled fish plates = new AT welds until tested + any defective weld (user's rule, 11.10.2026)
function weldDigest(recs) {
  const needs = r => /untested/i.test(r.usfd) || (r.usfd && !/^(GW|-|OK)$/i.test(r.usfd)) || (r.at && (!r.usfdWeld || (r.date && r.usfdWeld < r.date)));
  const pending = recs.filter(r => needs(r) && !r.joggled).map(r => ({ section: r.section, line: r.line, rail: r.rail, km: r.km, m: r.m, date: r.date, type: r.type, usfd: r.usfd, key: ['JOG', r.section, r.line, r.rail, r.km, r.m, r.date].join('|') }));
  const tot = {}; for (const r of recs) if (r.at) { const k = [r.section, r.line, r.km].join('|'); tot[k] = (tot[k] || 0) + 1; }
  const totals = Object.entries(tot).map(([k, n]) => { const [section, line, km] = k.split('|'); return { section, line, km: +km, count: n }; });
  // K12: AT welds done and tested per month (last two years) – the denominator of "% welds defective in initial testing"
  const mon = {}; const from = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 7);
  for (const r of recs) { if (!r.at || !r.date || r.date.slice(0, 7) < from) continue; const k = [r.section, r.line, r.km, r.date.slice(0, 7)].join('|'); const o = mon[k] = mon[k] || { done: 0, tested: 0, defective: 0 }; o.done++; if (r.usfdWeld && r.usfdWeld >= r.date) { o.tested++; if (weldDefective(r.usfd)) o.defective++; } }
  const months = Object.entries(mon).map(([k, v]) => { const [section, line, km, month] = k.split('|'); return { section, line, km: +km, month, done: v.done, tested: v.tested, defective: v.defective }; });
  // new AT welds not yet given their first USFD test (K12 reminder jobs)
  const untested = recs.filter(r => r.at && r.date && r.date.slice(0, 7) >= from && (!r.usfdWeld || r.usfdWeld < r.date)).map(r => ({ section: r.section, line: r.line, rail: r.rail, km: r.km, m: r.m, date: r.date, type: r.type, key: ['UT', r.section, r.line, r.rail, r.km, r.m, r.date].join('|') }));
  return { pending, totals, months, untested, needing: recs.filter(needs).length };
}
// FP joint register -> main-line (block section) joints per section/line/km, for the K15 denominator
function fpReg(rows) {
  const hi = rows.findIndex(r => (r || []).some(c => /^MONTH OF LAST OILING AND GREASING$/i.test(S(c)))); const H = rows[hi].map(S); const c = k => H.indexOf(k);
  const tot = {};
  for (const r of rows.slice(hi + 1)) { const sec = S(r[c('SECTION')]); if (!sec) continue; const k = [sectionName(sec), S(r[c('LINE')]), N(r[c('KM FROM')])].join('|'); tot[k] = (tot[k] || 0) + 1; }
  const recs = Object.entries(tot).map(([k, n]) => { const [section, line, km] = k.split('|'); return { section, line, km: +km, count: n }; });
  return { kind: 'fpSum', asOn: null, scope: { division: true }, records: recs };
}

// ---------- pasted web tables (TMS pages copied with Ctrl+A, Ctrl+C) ----------
// input: {html, text}; returns tables as arrays of rows of cell strings
function tablesFromPaste(html, text) {
  const out = [];
  if (html && /<table/i.test(html) && typeof DOMParser !== 'undefined') {
    // a space before every tag keeps cell texts apart in the page text (SECTION : x LINE : y …); cell values are trimmed anyway
    const doc = new DOMParser().parseFromString(String(html).replace(/</g, ' <'), 'text/html');
    for (const tb of doc.querySelectorAll('table')) {
      const rows = [];
      for (const tr of tb.querySelectorAll('tr')) { const r = []; for (const c of tr.children) { const v = S(c.textContent); const span = +c.getAttribute('colspan') || 1; r.push(v); for (let i = 1; i < span; i++) r.push(''); } if (r.some(Boolean)) rows.push(r); }
      if (rows.length) out.push(rows);
    }
    return { tables: out, title: S(doc.body ? doc.body.textContent : '').slice(0, 2000) };
  }
  const rows = String(text || '').split(/\r?\n/).map(l => l.split('\t').map(S)).filter(r => r.some(Boolean));
  return { tables: [rows], title: String(text || '').slice(0, 2000) };
}
function classifyPaste(title) {
  const t = String(title).toLowerCase();
  if (/oms peaks km wise comparative summary/.test(t)) return 'omsCompare';
  if (/oms report/.test(t)) return 'omsRun';
  if (/imr/.test(t)) return 'imr';
  return null;
}
function parsePaste(kind, { tables, title }) {
  const t = S(title);
  if (kind === 'omsCompare') {
    const section = grab(t, /SECTION\s*:\s*(.+?)\s+LINE/i), line = grab(t, /LINE\s*:\s*(\S+)/i);
    const runs = [...t.matchAll(/RUN\s*\d+\s*:\s*([A-Z]{3}-\d\d)\/?([\w-]*)/gi)].map(m => ({ month: m[1], id: m[2] }));
    const recs = [];
    for (const rows of tables) for (const r of rows) {
      const sr = N(r[0]), km = N(r[1]); if (sr == null || km == null || N(r[2]) == null) continue;
      runs.forEach((ru, i) => { const v = N(r[3 + i * 3]), l = N(r[4 + i * 3]); if (v || l) recs.push({ section: sectionName(section || ''), line, km, run: ru.id || ru.month, runMonth: ru.month, runIdx: i + 1, vertical: v || 0, lateral: l || 0 }); });
    }
    return { kind: 'oms', asOn: iso(grab(t, /PRINTED ON\s*-\s*([\d\/]+)/i)), scope: { section: sectionName(section || ''), line }, records: recs, runs };
  }
  if (kind === 'imr') {
    const section = grab(t, /Section\s*:\s*(.+?)\s+Line\s*:/i), line = grab(t, /Line\s*:\s*(.+?)\s+of the period/i);
    const recs = [];
    // header cells may carry sort-arrow characters; a scrolling TMS table may put its header in a separate table just before the rows
    const hd = c => S(c).replace(/[^A-Za-z ]+$/, '').trim();
    let lastH = null;
    for (const rows of tables) {
      let hi = rows.findIndex(r => r.some(c => /^Removed on$/i.test(hd(c)))), H;
      if (hi >= 0) { H = rows[hi].map(hd); lastH = H; } else if (lastH && rows.some(r => r.length === lastH.length && N(r[0]) != null)) { H = lastH; hi = -1; } else continue;
      const iRem = H.findIndex(c => /^Removed on$/i.test(c)); const iTest = H.findIndex(c => /Date of (Testing|First Detection)/i.test(c)); const iStat = H.findIndex(c => /^Status$/i.test(c));
      for (const r of rows.slice(hi + 1)) {
        if (N(r[0]) == null || N(r[1]) == null) continue;
        const rec = { section: sectionName(section || ''), line, km: N(r[1]), m: N(r[2]), rail: S(r.find(c => /^(LR|RR)$/.test(S(c))) || ''), status: S(r[iStat]), tested: iso(r[iTest]), removed: iso(r[iRem]) };
        rec.days = rec.tested && rec.removed ? Math.round((Date.parse(rec.removed) - Date.parse(rec.tested)) / 864e5) : null;
        rec.key = ['IMR', rec.section, lineKey(rec.line), rec.km, rec.m, rec.rail, rec.tested].join('|');   // same key as IMRs seen in the USFD defect lists
        if (!recs.some(x => x.key === rec.key)) recs.push(rec);
      }
    }
    return { kind: 'imr', asOn: null, scope: { section: sectionName(section || ''), line }, records: recs };
  }
  return null;
}

return { isMainOG, classifyKpiSheet, parseKpiSheet, weldDefective, weldDigest, tablesFromPaste, classifyPaste, parsePaste, isoDate: iso };
})();
__m['tmstable.js'] = (function(){
// Small HTML table reader that needs no browser DOM (used by the uploader and by the TMS Collector).
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCharCode(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const clean = s => decode(String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/[\s ]+/g, ' ').trim();
const strip = html => String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|select|textarea)\b[\s\S]*?<\/\1>/gi, '');

// Leaf tables (tables that contain no other table) in document order; each = rows of cell texts.
// A cell spanning n columns is followed by n-1 empty cells so columns stay aligned.
function htmlTables(html) {
  const s = strip(html); const out = []; const stack = []; const re = /<(\/?)(table|tr|td|th)\b([^>]*)>/gi; let m, cell = null, last = 0;
  while ((m = re.exec(s))) {
    const close = m[1] === '/', tag = m[2].toLowerCase();
    if (cell && (tag === 'td' || tag === 'th' || tag === 'tr' || tag === 'table')) { cell.t += s.slice(last, m.index); const T = stack[stack.length - 1]; if (T && T.rows.length) { const r = T.rows[T.rows.length - 1]; r.push(clean(cell.t)); for (let i = 1; i < cell.span; i++) r.push(''); } cell = null; }
    if (tag === 'table') { if (!close) { if (stack.length) stack[stack.length - 1].hasChild = true; stack.push({ rows: [], hasChild: false }); } else { const T = stack.pop(); if (T && !T.hasChild) out.push(T.rows.filter(r => r.some(c => c !== ''))); } }
    else if (tag === 'tr' && !close && stack.length) stack[stack.length - 1].rows.push([]);
    else if ((tag === 'td' || tag === 'th') && !close && stack.length) { const T = stack[stack.length - 1]; if (!T.rows.length) T.rows.push([]); const sp = /colspan\s*=\s*["']?(\d+)/i.exec(m[3]); cell = { t: '', span: sp ? Math.min(+sp[1], 60) : 1 }; }
    last = re.lastIndex;
  }
  return out.filter(t => t.length);
}
// Visible text of a page (titles carry section, line, period …)
function htmlText(html) { return clean(strip(html).replace(/<\/(p|div|tr|h\d|table|li)>/gi, ' \n ')); }
function htmlTitle(html) { const m = /<title>([\s\S]*?)<\/title>/i.exec(html || ''); return m ? clean(m[1]) : ''; }


return { decode, htmlTables, htmlText, htmlTitle };
})();
__m['tmshtml.js'] = (function(){
// TMS web pages as data (no screenshots): a small HTML table reader that works without a browser DOM,
// and converters from the TMS Collector's page tables to the records the uploader already understands.
const {sectionName, lineKey} = __m['names.js'];
const {PARAMS, BLKCOLS, DISTCOLS} = __m['page.js'];

const {decode, htmlTables, htmlText, htmlTitle} = __m['tmstable.js'];


// ---------- TRC km-wise result page (TRCNewReportController) -> the same page record the screenshot reader makes ----------
const isoDMY = s => { const m = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const isoDMonY = s => { const m = /^(\d{1,2})-([a-z]{3})-(\d{2,4})/i.exec(String(s || '').trim()); if (!m || !MON[m[2].toLowerCase()]) return null; const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`; };
function isTrcKmPage(text) { return /TRC TRACK RECORDING RESULT/i.test(text) && /PEAK INFORMATION/i.test(text); }
function trcPageFromTables(tables, file = 'TRC page') {
  const out = { file, blocks: [], dist: {}, peaks: {}, uml: [], problems: [], section: null, line: null, date: null, km: null, kmTo: null, speed: null, trc: null, runNo: null, kmTqic: null, source: 'web' };
  const all = tables.flat();
  const title = (all.find(r => r.some(c => /TRACK RECORDING RESULT/i.test(c))) || []).join(' ');
  const sm = /SECTION\s*:\s*(.+?)\s*,\s*LINE\s*:\s*(.+?)\s*$/i.exec(title);
  if (sm) { out.section = sectionName(sm[1]); out.line = lineKey(sm[2]); out.lineName = sm[2].trim(); }
  const info = all.find(r => r.some(c => /^RUN NO/i.test(c)));
  if (info) {
    const v = lab => { const i = info.findIndex(c => lab.test(c)); return i >= 0 ? String(info[i + 1] || '').trim() : ''; };
    out.trc = v(/^TRC NO/i); out.runNo = v(/^RUN NO/i).replace(/\s+/g, '');
    out.date = isoDMY(out.runNo) || isoDMonY(v(/^RUN DATE/i)) || isoDMY(v(/^RUN DATE/i));
    const k = /(\d+)\s*TO\s*(\d+)/i.exec(v(/^KM\s*:/i)); if (k) { out.km = +k[1]; out.kmTo = +k[2]; }
    const sp = /^(\d{2,3})$/.exec(v(/^SECTIONAL SPEED/i)); if (sp) out.speed = +sp[1];
  }
  // laser and contact pages differ: contact has TW1 in the blocks, no RIV2/RIL2/MI-G, and no GAUGE in the peak distribution.
  // Columns are taken by their headings and put in the laser order the analysis uses.
  out.sensor = /CONTACT SENSOR/i.test(title) ? 'contact' : /LASER/i.test(title) ? 'laser' : null;
  const ALIAS = { RIV: 'RIV1', RIL: 'RIL1', 'MI-G': 'MI_G' };
  let mode = '', bh = null, dh = null;
  for (const t of tables) for (const r of t) {
    const a = String(r[0] || '').trim(), j = r.join(' ');
    if (/PEAK DISTRIBUTION/i.test(j)) { mode = 'dist'; continue; }
    if (/PEAK WORST THAN UML|PEAK WORSE THAN UML/i.test(j)) { mode = 'uml'; continue; }
    if (/PEAK INFORMATION/i.test(j)) { mode = 'peak'; continue; }
    const tq = /KM Wise TQIC\s*-?\s*(-?\d+(?:\.\d+)?)/i.exec(j); if (tq) { out.kmTqic = +tq[1]; continue; }
    if (a === 'LOC' && r.some(c => /^UN1L$/i.test(String(c).trim()))) { bh = r.slice(1).map(c => { const h = String(c).trim().toUpperCase(); return ALIAS[h] || h; }); continue; }
    if (a === 'BAND' && mode === 'dist') { let n = 0; dh = r.slice(1).map(c => { const h = String(c).trim().toUpperCase(); return h === 'BAND' ? (n++ ? 'BAND3' : 'BAND2') : h; }); continue; }
    if (/^Blk\s*\d/i.test(a)) {
      let row;
      if (bh) row = [a, ...BLKCOLS.map(c => { const i = bh.indexOf(c); return i >= 0 ? String(r[i + 1] ?? '').trim() : ''; })];
      else { row = r.slice(0, 24).map(c => String(c).trim()); while (row.length < 24) row.push(''); }
      if (out.sensor === 'contact') row[1 + BLKCOLS.indexOf('AVG')] = '';   // contact "AVG" is not the laser mean gauge – not used
      out.blocks.push(row); continue;
    }
    if (mode === 'dist' && (a === 'CBML' || a === 'UML')) {
      let v; if (dh) v = DISTCOLS.map(c => { const i = dh.indexOf(c); return i >= 0 ? String(r[i + 1] ?? '').trim() : ''; });
      else { v = r.slice(1, 14).map(c => String(c).trim()); while (v.length < 13) v.push(''); }
      out.dist[a] = v; continue;
    }
    if ((mode === 'peak' || mode === 'uml') && PARAMS.includes(a)) { const v = r.slice(1, 21).map(c => String(c).trim()); while (v.length < 20) v.push(''); if (mode === 'peak') out.peaks[a] = v; else if (v.some(Boolean)) out.uml.push([a, ...v]); }
  }
  if (!out.section || !out.line) out.problems.push('section/line not found on the page');
  if (out.km == null) out.problems.push('km');
  if (!out.date) out.problems.push('date');
  if (!out.blocks.length && !Object.keys(out.peaks).length) out.problems.push('Not a TMS km-wise result page');
  return out;
}

// ---------- USFD defects of one section-line (GangDefectsSecDetails.jsp) ----------
// Rail defects and weld defects tables -> records {kind:'RAIL'|'WELD', km, m, rail, status, …}
const N = v => { const s = String(v ?? '').replace(/,/g, '').trim(); if (s === '' || s === '-') return null; const n = Number(s); return isNaN(n) ? null : n; };
const isoAny = s => isoDMY(s) || isoDMonY(s);
function usfdDefectsFromPage(html) {
  const text = htmlText(html); const tables = htmlTables(html);
  const sec = /Section\s*:\s*(.+?)\s+Line\s*:\s*(.+?)(?:\s+Reporting|\s+Search|\s+Rail Defects|$)/i.exec(text);
  const section = sec ? sectionName(sec[1]) : null, lineName = sec ? sec[2].trim() : null;
  const recs = []; let kind = null, H = null;
  for (const t of tables) for (const r of t) {
    const j = r.join(' ').trim();
    if (/^Rail Defects$/i.test(j)) { kind = 'RAIL'; H = null; continue; }
    if (/^Weld Defects$/i.test(j)) { kind = 'WELD'; H = null; continue; }
    if (/^Sr\.?\s*No/i.test(r[0])) { H = r.map(c => c.replace(/[↑↓\s]+$/, '').trim().toLowerCase()); continue; }
    if (!kind || N(r[0]) == null || N(r[1]) == null) continue;
    const rec = { kind, section, line: lineName, km: N(r[1]), m: N(r[2]), rail: (r.find(c => /^(LR|RR)$/.test(String(c).trim())) || '').trim(), status: (r.find(c => /^(IMR|IMRW|OBS|OBSW|DFWN|DFWO|DFWR|DFW|REM|RE|SPL)\b/i.test(String(c).trim())) || '').trim() };
    const dates = r.map(isoAny).filter(Boolean);
    if (kind === 'RAIL') { rec.tested = dates[0] || null; rec.gmt = N(r[r.findIndex(c => isoAny(c)) + 1]); }
    else { rec.welded = dates[0] || null; rec.detected = dates[1] || null; rec.weldType = (r.find(c => /weld/i.test(c)) || '').trim(); }
    rec.key = ['USFD', kind, section, lineName, rec.km, rec.m, rec.rail, kind === 'RAIL' ? rec.tested : rec.welded].join('|');
    recs.push(rec);
  }
  return { kind: 'usfd', section, line: lineName, records: recs };
}

// ---------- AT welds done / defective (ATWeldsDoneDefectiveReport.jsp, division row) ----------
function atWeldsFromPage(html, period) {
  const recs = [];
  for (const t of htmlTables(html)) {
    const hi = t.findIndex(r => r.some(c => /No\. of AT Welds Done/i.test(c))); if (hi < 0) continue;
    const H = t[hi].map(c => c.toLowerCase());
    const col = re => H.findIndex(c => re.test(c));
    const iDone = col(/welds done/), iTest = col(/welds tested/), iUn = col(/untested/), iDef = col(/defec/i), iPct = col(/%/);
    for (const r of t.slice(hi + 1)) { if (N(r[iDone]) == null) continue; recs.push({ unit: r[0], done: N(r[iDone]), tested: N(r[iTest]), untested: N(r[iUn]), defective: N(r[iDef]), pct: N(r[iPct]), from: period && period.from, to: period && period.to }); }
  }
  return recs;
}

// ---------- official item-wise score (PopUpPerformanceMatrix_ItemWiseDetails.jsp) as rows for the existing parser ----------
function rowsFromPage(html) {
  const tables = htmlTables(html); const text = htmlText(html);
  // the Excel export starts with two title rows: "Item Wise Score … Jurisdiction of X" and "Processing Date … Reporting Date …"
  const head = [];
  const j = /In the Jurisdiction of\s*(\S+)/i.exec(text); const pd = /Processing Date:\s*([\d\/]+)/i.exec(text); const rd = /Reporting Date:\s*([\d\/]+)/i.exec(text);
  head.push([`Item Wise Score ${j ? 'In the Jurisdiction of ' + j[1] : ''}`]); head.push([`Processing Date: ${pd ? pd[1] : ''} Reporting Date: ${rd ? rd[1] : ''}`]);
  return head.concat(...tables);
}

// ---------- USFD testing history of one rail / weld defect (PopUpRailUSFDHistory.jsp / PopUpWeldUSFDHistory.jsp) ----------
// meta = the defect it belongs to {kind, section, line, km, m, rail, asset}
function usfdHistFromPage(html, meta = {}) {
  const out = [];
  for (const t of htmlTables(html)) {
    const hi = t.findIndex(r => r.some(c => /^Testing Date$/i.test(String(c).replace(/[↑↓\s]+$/, '').trim())));
    if (hi < 0) continue;
    for (const r of t.slice(hi + 1)) {
      if (N(r[0]) == null) continue; const date = isoAny(r[1]); if (!date) continue;
      const rec = { asset: meta.asset || '', kind: meta.kind || '', section: meta.section, line: meta.line, km: meta.km, m: meta.m, rail: meta.rail || '', date, testType: r[2] || '', visual: r[3] || '', position: r[4] || '', probe: r[5] || '', echo: N(r[9]) ?? N(r[8]), classOld: r[10] || '', classNew: r[11] || '', joggled: r[12] || '', testedBy: r[13] || '' };
      rec.key = ['UT', meta.kind || '', meta.section, meta.line, meta.km, meta.m, meta.rail || '', date, rec.testType].join('|');
      out.push(rec);
    }
  }
  return out;
}
// IMRs still in track (rail IMR, weld IMRW) from the defect lists -> IMR records without a removal date (K11 jobs)
function pendingIMR(defects) {
  return defects.filter(d => /^IMRW?\b/i.test(d.status || '')).map(d => {
    const tested = d.kind === 'RAIL' ? d.tested : (d.detected || d.welded);
    const rec = { section: d.section, line: d.line, km: d.km, m: d.m, rail: d.rail, status: d.status, tested, removed: '', days: null };
    rec.key = ['IMR', rec.section, lineKey(rec.line), rec.km, rec.m, rec.rail, rec.tested].join('|');
    return rec;
  }).filter(r => r.tested);
}

// ---------- [E] K15: overdue oiling & greasing summary per SSE (FishPlateAnalysisSummary.jsp after "HWH", 16-Oct-2026) ----------
// columns: Authority | main+loop total, overdue | main total, overdue | loop total, overdue. TMS's K15 counts main + loop line joints.
function ogSumFromPage(html) {
  const out = [];
  for (const t of htmlTables(html)) for (const r of t) {
    const a = String(r[0] || '').trim(); const m = /^SSE\/P\.?\s*WAY\/(.+)$/i.exec(a); if (!m) continue;
    const n = r.slice(1, 7).map(N); if (n.length < 6 || n.some(x => x == null)) continue;
    out.push({ unit: m[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase(), total: n[0], overdue: n[1], mainTotal: n[2], mainOverdue: n[3], loopTotal: n[4], loopOverdue: n[5] });
  }
  const seen = new Set(); return out.filter(x => !seen.has(x.unit) && seen.add(x.unit));
}

return { isTrcKmPage, trcPageFromTables, usfdDefectsFromPage, atWeldsFromPage, rowsFromPage, usfdHistFromPage, pendingIMR, ogSumFromPage, decode, htmlTables, htmlText, htmlTitle };
})();
__m['kpi.js'] = (function(){
// KPI engine – SSE/P-Way In-charge Performance Matrix (TMS KPI calculation method).
// Pure functions: used in the admin browser and in Apps Script (bundled).
const {sectionName, sectionCode, lineKey} = __m['names.js'];

// ---------- mark bands (KPI calculation method PDF) ----------
const SHORT5 = [[0, 5], [5, 4], [15, 3], [25, 2], [Infinity, 0]];          // % shortfall -> marks (0 exactly = max)
const RED5 = [[0, 0], [10, 2], [25, 3], [Infinity, 5]];                     // % reduction (<=0 -> 0)
const KPI = {
  K1: { max: 10, name: 'Scheduled inspections (P&C, curve, LWR, LC)', bands: [[0, 10], [1, 8], [2, 5], [5, 2], [Infinity, 0]], kind: 'short' },
  K2: { max: 5, name: 'Foot plate / rear vehicle inspection', bands: SHORT5, kind: 'short' },
  K3: { max: 5, name: 'On foot / push trolley inspection', bands: SHORT5, kind: 'short' },
  K4: { max: 5, name: 'Bridge inspection', bands: SHORT5, kind: 'short' },
  K5: { max: 5, name: 'Rail fractures (reduction)', bands: RED5, kind: 'red' },
  K6: { max: 5, name: 'Weld fractures (reduction)', bands: RED5, kind: 'red' },
  K7: { max: 5, name: 'Repeated OMS peak locations (reduction)', bands: RED5, kind: 'red' },
  K8: { max: 5, name: 'UML peaks – TRC (reduction)', bands: RED5, kind: 'red' },
  K9: { max: 5, name: 'CBML blocks – TRC (reduction)', bands: RED5, kind: 'red' },
  K10: { max: 5, name: 'Defects pending > 10 days', bands: SHORT5, kind: 'short' },
  K11: { max: 5, name: 'IMRs removed after > 3 days', bands: SHORT5, kind: 'short' },
  K12: { max: 5, name: 'Defective welds in initial testing', bands: [[0, 5], [0.5, 4], [1, 3], [2, 2], [Infinity, 0]], kind: 'short' },
  K13: { max: 5, name: 'Joggling of AT welds pending', bands: [[0, 5], [0.1, 4], [0.15, 3], [0.25, 2], [Infinity, 0]], kind: 'short' },
  K14: { max: 4, name: 'DFWR > 90 days removed', bands: [[4.999, 0], [10, 1], [15, 2], [25, 3], [Infinity, 4]], kind: 'removed' },
  K15: { max: 4, name: 'Overdue oiling & greasing of FP joints', bands: [[0, 4], [5, 3], [15, 2], [25, 1], [Infinity, 0]], kind: 'short' },
  K16: { max: 4, name: 'Field visit days', kind: 'days' },
};
function marks(k, v) {
  const d = KPI[k]; if (v == null || isNaN(v)) return null;
  if (d.kind === 'days') return v >= 16 ? 4 : v >= 11 ? 3 : v >= 7 ? 2 : 0;
  if (d.kind === 'red') { if (v <= 0) return 0; for (const [lim, m] of d.bands.slice(1)) if (v <= lim) return m; return d.max; }
  if (d.kind === 'removed') { for (const [lim, m] of d.bands) if (v <= lim) return m; return d.max; }
  const r = Math.round(v * 1000) / 1000;
  if (r <= 0) return d.bands[0][1];
  for (const [lim, m] of d.bands.slice(1)) if (r <= lim) return m;
  return 0;
}
// % reduction used by K5–K9: (previous - current) / previous. No previous and no current = full marks (nothing to reduce).
function reduction(prev, cur) { if (!prev) return cur ? -100 : 100; return (prev - cur) / prev * 100; }

// ---------- jurisdiction ----------
const normUnit = u => String(u || '').toUpperCase().replace(/\s+/g, '').replace(/^SSE\/P\.?WAY\//, '').replace(/[^A-Z0-9]/g, '');
// unit of an official from designation: SSE/P.WAY/BWN(W) -> BWNW (in-charge), JE/PW/1/BMG -> BMG
function desigUnit(desig) { const d = String(desig || '').toUpperCase().replace(/\s+/g, ''); const m = d.match(/^(SSE|JE)\/(?:P\.?WAY|PW)\/(?:\d+\/|ML\/|YD\/|SEC\/)?(.+)$/); return m ? m[2].replace(/\/SEC$/, '').replace(/[^A-Z0-9]/g, '') : null; }
const isInCharge = desig => /^SSE\/P\.?WAY\/[^\/]+$|^SSE\/P\.?WAY\/[A-Z]+\([A-Z]+\)$/.test(String(desig || '').toUpperCase().replace(/\s+/g, ''));

// rows: Jurisdiction Details sheet rows (header in first 2 rows). Returns {units:[{srden,aen,unit,segs}], byUnit}
function buildJurisdiction(rows) {
  const units = new Map(); let sd = '', aen = '', unit = '', lastSpeed = {};
  for (const r of rows) {
    if (!r || r.length < 11) continue;
    const km1 = r[7], km2 = r[9];
    if (typeof km1 !== 'number' || typeof km2 !== 'number') { if (r[0]) sd = String(r[0]).trim(); if (r[1]) aen = String(r[1]).trim(); if (r[2]) unit = String(r[2]).trim(); continue; }
    if (r[0]) sd = String(r[0]).trim(); if (r[1]) aen = String(r[1]).trim(); if (r[2]) unit = String(r[2]).trim();
    const u = normUnit(unit); if (!u) continue;
    const sec = sectionName(String(r[3] || '').trim()); const line = lineKey(String(r[5] || '').trim());
    const sk = u + '|' + sec; let speed = typeof r[12] === 'number' ? r[12] : null; if (speed != null) lastSpeed[sk] = speed; else speed = lastSpeed[sk] ?? null;
    if (!units.has(u)) units.set(u, { srden: sd, aen, unit: u, label: unit.replace(/\s+/g, ''), segs: [] });
    units.get(u).segs.push({ section: sec, sectionCode: String(r[4] || '').trim(), line, lineName: String(r[5] || '').trim(), a: km1 * 1000 + (+r[8] || 0), b: km2 * 1000 + (+r[10] || 0), lengthKm: +r[11] || null, speed });
  }
  // second pass: speed missing for a whole unit-section -> take the section's speed from any unit
  const secSpeed = {}; for (const u of units.values()) for (const s of u.segs) if (s.speed != null) secSpeed[s.section] = s.speed;
  for (const u of units.values()) for (const s of u.segs) if (s.speed == null) s.speed = secSpeed[s.section] ?? null;
  return { units: [...units.values()], byUnit: Object.fromEntries([...units.entries()]) };
}
function unitForLocation(J, section, line, pos) {
  const sec = sectionName(section), ln = lineKey(line);
  for (const u of J.units) for (const s of u.segs) if (s.section === sec && (!ln || s.line === ln || !s.line) && pos >= s.a && pos <= s.b) return u.unit;
  for (const u of J.units) for (const s of u.segs) if (s.section === sec && pos >= s.a && pos <= s.b) return u.unit;
  // TRC / OMS runs are recorded against their own section but the km run on past its ends (chainage is continuous along the
  // route): look in the sections that join this one on the same line (one starts where this one ends) …
  const mine = []; for (const u of J.units) for (const s of u.segs) if (s.section === sec && (!ln || s.line === ln)) mine.push(s);
  if (mine.length) {
    // a joining section shares a station with this one (BLY in Howrah-Bally / Bally-Bandel) and starts where this one ends
    // (or ends where it starts) on the same line – sections of other routes can have the same km numbers
    const lo0 = Math.min(...mine.map(s => s.a)), hi0 = Math.max(...mine.map(s => s.b));
    const stn = n => new Set(String(sectionCode(n) || '').toUpperCase().replace(/KWAE?|KWA/g, 'KWA').replace(/KHN/g, 'KAN').split(/[-\s]+/).filter(x => /^[A-Z]{2,5}$/.test(x)));
    const me = stn(sec);
    if (pos < lo0 || pos > hi0) for (const u of J.units) for (const s of u.segs) if (s.section !== sec && (!ln || s.line === ln) && pos >= s.a && pos <= s.b) {
      const other = stn(s.section); if (![...other].some(x => me.has(x))) continue;
      const rng = []; for (const v of J.units) for (const t of v.segs) if (t.section === s.section && t.line === s.line) rng.push(t.a, t.b);
      const oLo = Math.min(...rng), oHi = Math.max(...rng);
      if ((pos > hi0 && Math.abs(oLo - hi0) <= 50) || (pos < lo0 && Math.abs(oHi - lo0) <= 50)) return u.unit;
    }
    // … else a gap in the jurisdiction table or a yard just past the section's first / last km: the nearest stretch of this section
    // and line within 1 km (further out is another division's track – e.g. beyond Azimganj–New Farakka 181 km)
    if (pos > lo0 - 1000 && pos < hi0 + 1000) { let best = null, bd = 1001; for (const u of J.units) for (const s of u.segs) if (s.section === sec && (!ln || s.line === ln)) { const d = pos < s.a ? s.a - pos : pos > s.b ? pos - s.b : 0; if (d < bd) { bd = d; best = u.unit; } } if (best) return best; }
  }
  return null;
}

// ---------- coverage (K2, K3) – counted in km units like TMS (km a..b inclusive) ----------
const kmSet = (a, b) => { const o = []; for (let k = Math.floor(a / 1000); k <= Math.floor(Math.max(a, b - 1) / 1000); k++) o.push(k); return o; };
// Foot plate / rear vehicle trips are entered against train routes; routes of two codes (and a few others) are named here.
// Chainage along these routes is the same as in the sections' own registers (km from Howrah / Khana).
const ROUTES = {
  'HWH-GZB': ['HWH-BLY Chord line', 'Howrah-Bally', 'Bally-Saktigarh', 'Saktigarh-Barddhaman', 'Barddhaman-Khana'],
  'KAN-KEU': ['Khana-Sainthia', 'Sainthia-Nalhati', 'Nalhati-Bonidanga Link'],
  'HWH-NGP': ['Howrah - Santragachi'], 'HWH NGP': ['Howrah - Santragachi']
};
function routeSections(route) {
  const r = String(route || '').trim();
  const rk = r.toUpperCase().replace(/\s*-\s*/g, '-').replace(/\s+/g, ' '); if (ROUTES[rk]) return ROUTES[rk];
  const codes = r.split('-').map(s => s.trim());
  if (codes.length >= 3 && codes.every(c => /^[A-Z]{2,5}$/.test(c))) { const out = []; for (let i = 0; i + 1 < codes.length; i++) out.push(sectionName(codes[i] + '-' + codes[i + 1])); return out; }
  return [sectionName(r)];
}
function inspectorMatches(insp, unit, who) {
  if (who === 'any') return true;
  if (desigUnit(insp.desig) !== unit) return false;
  return who === 'incharge' ? isInCharge(insp.desig) : true;   // 'unit': any official of the unit (in-charge, sectional SSE, JE)
}
// [E] 21-Oct: which inspections covered a key (section|line|km) – for the line-by-line check (opts.evidence = Map)
const evid = (M, key, i, guess) => { const [sec, ln] = key.split('|'); const k2 = sec + '|' + ln; const L = M.get(k2) || []; if (!L.some(x => x.i === i)) { L.push({ i, guess }); M.set(k2, L); } };
function coverage(unitObj, inspections, from, to, opts = {}) {
  // Default basis = section-km (lines running parallel are covered by one inspection – IRPWM Table 1B note); opts.lineWise = per line.
  const lw = !!opts.lineWise; const need = new Map(); // key section|line|km -> seg (fastest seg kept)
  const wt = new Map();   // opts.measure 'length': each km unit weighs the length of track in it (km), else 1
  for (const s of unitObj.segs) { if (opts.segFilter && !opts.segFilter(s)) continue; for (const k of kmSet(s.a, s.b)) { const key = `${s.section}|${lw ? s.line : '*'}|${k}`; const o = need.get(key); if (!o || (s.speed || 0) > (o.speed || 0)) need.set(key, s); const len = Math.max(0, Math.min(s.b, (k + 1) * 1000) - Math.max(s.a, k * 1000)) / 1000; wt.set(key, Math.max(wt.get(key) || 0, len)); } }
  const done = new Set(); const by = new Map();
  for (const i of inspections) {
    if (i.date < from || i.date > to) continue;
    if (opts.types && !opts.types.includes(i.type)) continue;
    if (!inspectorMatches(i, unitObj.unit, opts.who || 'incharge')) continue;
    const ln = lineKey(i.line); const secs = routeSections(i.route); let hit = false;
    // opts.endExclusive (KM_END = exclusive): "KM Stretch 98 - 128" covers track 98.000–128.000, not the km beyond 128.000
    const lo = Math.min(i.kmA, i.kmB), hi = Math.max(i.kmA, i.kmB), top = opts.endExclusive && hi > lo ? hi - 1 : hi;
    for (const sec of secs) for (let k = lo; k <= top; k++) {
      const key = `${sec}|${lw ? ln : '*'}|${k}`; const seg = need.get(key); if (!seg) continue;
      hit = true; if (opts.accept && !opts.accept(i, seg)) continue;
      done.add(key); if (!by.has(key)) by.set(key, i.date); if (opts.evidence) evid(opts.evidence, key, i, false);
    }
    // a route this program does not know (e.g. a new train route): an official of the unit inspected his own track, so the
    // unit's sections on the same line and km stand for it
    if (!hit && (opts.who || 'incharge') !== 'any' && !secs.some(sec => unitObj.segs.some(s => s.section === sec))) {
      for (const s of unitObj.segs) { if (opts.segFilter && !opts.segFilter(s)) continue; if (s.line !== ln) continue;
        for (const k of kmSet(s.a, s.b)) { if (k < lo || k > top) continue; const key = `${s.section}|${lw ? s.line : '*'}|${k}`; const seg = need.get(key); if (!seg) continue; if (opts.accept && !opts.accept(i, seg)) continue; done.add(key); if (!by.has(key)) by.set(key, i.date); if (opts.evidence) evid(opts.evidence, key, i, true); } }
    }
  }
  const missing = [...need.keys()].filter(k => !done.has(k)).map(k => { const [section, line, km] = k.split('|'); return { section, line, km: +km }; });
  if (opts.measure === 'length') { const W = k => wt.get(k) || 0; const tot = [...need.keys()].reduce((x, k) => x + W(k), 0), mis = [...need.keys()].filter(k => !done.has(k)).reduce((x, k) => x + W(k), 0);
    return { total: need.size, covered: done.size, missing, pct: tot ? mis / tot * 100 : 0, km: Math.round(tot * 100) / 100, kmMissing: Math.round(mis * 100) / 100 }; }
  return { total: need.size, covered: done.size, missing, pct: need.size ? missing.length / need.size * 100 : 0 };
}

const pad = n => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function monthRange(ym) { const [y, m] = ym.split('-').map(Number); return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` }; }
function prevMonth(ym, n = 1) { let [y, m] = ym.split('-').map(Number); m -= n; while (m < 1) { m += 12; y--; } return `${y}-${pad(m)}`; }

// ---------- running month (basis 'This month'): forecast for the coming 1st ----------
// opts.asOf = today when ym is the running month. A period that has not started does not count; a period still running is judged
// at the present pace (work so far against the share of the period gone by), so days still to come are not counted as failure.
const dmyS = d => d ? `${d.slice(8, 10)}-${d.slice(5, 7)}` : '';
const dayCount = (a, b) => daysBetween(a, b) + 1;
// shortfall % of a coverage result for a period of len days of which el have gone by
const paceShort = (c, el, len) => { if (!c.total) return 0; if (el >= len) return c.pct; const done = 1 - c.pct / 100; return Math.max(0, 100 * (1 - done * len / el)); };   // share covered (km units or km of track) against the share of the period gone by
const r1 = v => Math.round(v * 10) / 10;

// K2: whole jurisdiction by FP/RV in each fortnight of month ym; average shortfall
function kpiK2(unitObj, insp, ym, opts = {}) {
  const [y, m] = ym.split('-').map(Number); const ld = lastDay(y, m);
  const a1 = `${ym}-01`, b1 = `${ym}-15`, a2 = `${ym}-16`, b2 = `${ym}-${pad(ld)}`; const now = opts.asOf && opts.asOf <= b2 ? opts.asOf : null;
  const f1 = coverage(unitObj, insp, a1, b1, { ...opts, types: ['FP', 'RV'] });
  const f2 = coverage(unitObj, insp, a2, b2, { ...opts, types: ['FP', 'RV'] });
  if (!now) { const v = (f1.pct + f2.pct) / 2; return { value: v, marks: marks('K2', v), detail: { f1, f2, basis: 'Both fortnights (month over)' } }; }
  if (now <= b1) {   // 1st fortnight only
    const el = dayCount(a1, now), v = paceShort(f1, el, 15);
    return { value: v, marks: marks('K2', v), detail: { f1, f2, forecast: true, basis: `Forecast on the 1st fortnight: ${f1.covered} of ${f1.total} km covered in ${el} of 15 days` + (el < 15 ? ` (at this pace ${r1(v)} % short)` : ` (${r1(v)} % short)`) + ' – the 2nd fortnight has not started' } };
  }
  // the running 2nd fortnight counts for the share of its days gone by (on the 16th it barely counts; on the last day fully)
  const el = dayCount(a2, now), len = dayCount(a2, b2), s2 = paceShort(f2, el, len), w = el / len, v = (f1.pct + s2 * w) / (1 + w);
  return { value: v, marks: marks('K2', v), detail: { f1, f2, forecast: true, basis: `Forecast: 1st fortnight ${r1(f1.pct)} % short + 2nd fortnight so far ${f2.covered} of ${f2.total} km in ${el} of ${len} days (at this pace ${r1(s2)} % short; counted for the ${el} day(s) gone by)` } };
}
// K3: previous two months; speed > 110 -> push trolley or on foot; <= 110 -> push trolley (opts.footOK lets foot count everywhere)
function kpiK3(unitObj, insp, ym, opts = {}) {
  const from = monthRange(prevMonth(ym, 1)).from, to = monthRange(ym).to;
  const accept = (i, seg) => i.type === 'TROLLEY' || (i.type === 'FOOT' && (opts.footOK || (seg.speed != null && seg.speed > 110)));
  const c = coverage(unitObj, insp, from, to, { ...opts, types: ['FOOT', 'TROLLEY'], accept });
  const now = opts.asOf && opts.asOf < to ? opts.asOf : null;
  if (!now) return { value: c.pct, marks: marks('K3', c.pct), detail: { ...c, basis: `Two months ${dmyS(from)} to ${dmyS(to)} (over)` } };
  const el = dayCount(from, now), len = dayCount(from, to), v = paceShort(c, el, len);
  return { value: v, marks: marks('K3', v), detail: { ...c, forecast: true, basis: `Forecast: ${c.covered} of ${c.total} km covered in ${el} of ${len} days of the two months ${dmyS(from)} to ${dmyS(to)} (at this pace ${r1(v)} % short; ${r1(c.pct)} % not yet covered)` } };
}
// K16: distinct field days of the in-charge in month ym (from all inspection records available)
function kpiK16(unit, insp, ym, who = 'incharge', asOf = null, opts = {}) {
  const { from, to } = monthRange(ym); const days = new Set();
  const byType = {};   // every inspection recorded in TMS counts (TMS rule): FP/RV, on foot, trolley, asset registers, joint P&C, USFD, other …
  // [E] 22-Oct: opts.exclude = register types not counted (setting K16_EXCLUDE), opts.dateTo = a trip ending on a later day counts that day too
  const ex = new Set((opts.exclude || []).map(x => String(x).trim().toUpperCase()).filter(Boolean));
  const add = (i, d) => { if (d >= from && d <= to) { days.add(d); (byType[i.type] = byType[i.type] || new Set()).add(d); } };
  for (const i of insp) if (!ex.has(String(i.type).toUpperCase()) && inspectorMatches(i, unit, who)) { add(i, i.date); if (opts.dateTo && i.dateTo && i.dateTo > i.date) add(i, i.dateTo); }
  const n = days.size; const bt = {}; for (const t of Object.keys(byType).sort()) bt[t] = byType[t].size; const now = asOf && asOf < to ? asOf : null;
  if (!now) return { value: n, marks: marks('K16', n), detail: { days: [...days].sort(), byType: bt, basis: 'Whole month (over)' } };
  const el = dayCount(from, now), len = dayCount(from, to), f = Math.min(len, Math.round(n * len / el));
  return { value: f, marks: marks('K16', f), detail: { days: [...days].sort(), byType: bt, soFar: n, forecast: true, basis: `Forecast: ${n} field day(s) in ${el} of ${len} days – at this pace ${f} by month end` } };
}

// ---------- dates ----------
// first 10 characters of a 'yyyy-mm-dd…' value (a stored time part is ignored); null when it is not a date
const day = v => { const m = String(v == null ? '' : v).trim().match(/^\d{4}-\d\d-\d\d/); return m ? m[0] : null; };
const addMonths = (d, n) => { d = day(d); if (!d) return ''; const [y, m, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const ld = lastDay(t.getUTCFullYear(), t.getUTCMonth() + 1); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(Math.min(dd, ld))}`; };
const addDays = (d, n) => { d = day(d); return d ? new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10) : ''; };
const daysBetween = (a, b) => { a = day(a); b = day(b); return a && b ? Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) : NaN; };
const nextFirst = d => addMonths(d.slice(0, 8) + '01', 1);

// ---------- K1: scheduled inspections (Latest inspection report) ----------
// Calibrated on TMS scores of 01.10.2026 (LLH, HGY, BMG, BDC all 0% overdue): latest of JE / SSE / ADEN dates; editable in Settings.
const K1_DEFAULTS = { PXING_PAX: 3, PXING_OTHER: 12, CURVE: 12, LWR: 6, LXING: 2, STALE_DAYS: 365 };
const K1W = { PXING: 0.3, CURVE: 0.3, LWR: 0.2, LXING: 0.2 };
function assetDue(a, per = K1_DEFAULTS) {
  const last = [a.lastJE, a.lastSSE, a.lastADEN].filter(Boolean).sort().pop() || null;
  const months = a.type === 'PXING' ? (a.pax ? per.PXING_PAX : per.PXING_OTHER) : per[a.type];
  return { last, due: last && months ? addMonths(last, months) : null, months };
}
// TMS: K1 on the 1st of the month; an asset due that day is not yet overdue (due < asOn). 16-Oct-2026: the BDC / NDAE / BZLE P&C that
// looked "last inspected 30-06, due 30-09" were really 01-07 / 01-10 – the sheet read every date a day early (01_Store DATE FIX).
// [E] 16-Oct-2026 (user: PKR curve 19up "overdue" is not true in TMS): TMS counts an inspection as overdue only when its DUE MONTH
// is over – inspected 02-10-2025, yearly → due October 2026 → overdue from 1-Nov. On the 1st this is the same as "due < 1st".
// Checked on TMS's Latest Inspection Report 16-Oct: by the month rule the division has 4 overdue items, by the day rule 118.
const k1Overdue = (due, asOn) => !!due && String(due).slice(0, 7) < String(asOn).slice(0, 7);
// soonUntil (running month): marks from what is overdue on asOn (month rule); assets due in the running month (before soonUntil, the
// coming 1st) are listed as "due this month" (reminders) – they become overdue on the 1st if not inspected.
function kpiK1(unit, assets, asOn, per = K1_DEFAULTS, soonUntil = null) {
  const mine = assets.filter(a => a.unit === unit); const by = {}; const list = [];
  for (const a of mine) { const d = assetDue(a, per); const t = by[a.type] = by[a.type] || { n: 0, over: 0, never: 0 }; if (!d.last) { t.never++; list.push({ ...a, ...d, over: false, never: true }); continue; } const stale = d.due < asOn && daysBetween(d.due, asOn) > (per.STALE_DAYS ?? 365); if (stale) { t.stale = (t.stale || 0) + 1; list.push({ ...a, ...d, over: false, stale: true }); continue; } t.n++; const over = k1Overdue(d.due, asOn); if (over) t.over++; list.push({ ...a, ...d, over }); }
  let v = 0, w = 0; for (const t of Object.keys(K1W)) if (by[t] && by[t].n) { v += K1W[t] * by[t].over / by[t].n * 100; w += K1W[t]; }
  const value = w ? v : null; // weights of asset types the unit has
  const slim = a => ({ type: a.type, id: a.id, section: a.section, line: a.line, km: a.km, m: a.m, station: a.station, last: a.last, due: a.due });
  const over = list.filter(a => a.over).sort((x, y) => String(x.due).localeCompare(String(y.due))).map(slim);
  const soon = soonUntil ? list.filter(a => !a.over && !a.never && !a.stale && a.due && a.due < soonUntil).sort((x, y) => String(x.due).localeCompare(String(y.due))).map(slim) : [];
  const basis = soonUntil ? `Forecast: overdue as on today (${asOn.slice(8, 10)}-${asOn.slice(5, 7)} – due month over); ${soon.length} due this month – inspect them before ${soonUntil.slice(8, 10)}-${soonUntil.slice(5, 7)} to keep the marks` : `As on ${asOn.slice(8, 10)}-${asOn.slice(5, 7)}-${asOn.slice(0, 4)} (TMS method: on the 1st of the month – due that day is not overdue)`;
  return { value, marks: value == null ? null : marks('K1', value), detail: { byType: by, over, soon, basis }, list };
}

// ---------- K5/K6: fractures in month vs same month last year ----------
function kpiFracture(unit, fractures, J, type, ym) {
  const ly = (+ym.slice(0, 4) - 1) + ym.slice(4);
  const mine = fractures.filter(f => f.type === type && unitForLocation(J, f.section, f.line, (f.km || 0) * 1000 + (f.m || 0)) === unit);
  const cur = mine.filter(f => f.date && f.date.slice(0, 7) === ym).length, prev = mine.filter(f => f.date && f.date.slice(0, 7) === ly).length;
  const v = reduction(prev, cur); return { value: v, marks: marks(type === 'RAIL' ? 'K5' : 'K6', v), detail: { cur, prev, ym, ly } };
}

// ---------- K10: defects pending > 10 days (Locations needing attention) ----------
function openOn(items, d) { return items.filter(i => i.firstSeen <= d && (!i.closedOn || i.closedOn > d)); }
// [E] 20-Oct: "pending since" counted the TMS way – both days (inspected 10/10 = 11 days on 20/10); late = more than 10 such days
const pendingDays = (date, asOn) => { const d = daysBetween(date, asOn); return isNaN(d) ? null : d + 1; };
function kpiK10(unit, lnaItems, asOn) {
  const open = openOn(lnaItems.filter(i => i.unit === unit), asOn);
  const late = open.filter(i => i.date && pendingDays(i.date, asOn) > 10);
  const v = open.length ? late.length / open.length * 100 : 0;
  const cat = {}; late.forEach(i => { const c = i.cat || 'LNA'; cat[c] = (cat[c] || 0) + 1; });
  return { value: v, marks: marks('K10', v), detail: { open: open.length, late: late.length, over7: open.filter(i => i.date && pendingDays(i.date, asOn) > 7).length, lateByCat: cat } };
}

// K10 as TMS does it: % pending > 10 days on the 1st, 11th and 21st, averaged. Only dates on which defect lists were already
// being collected count (before that the open list is not known); with none of them, the single date asked for.
function kpiK10avg(unit, lnaItems, dates, firstData, fallback) {
  const use = dates.filter(d => firstData && d >= firstData);
  if (!use.length) { const r = kpiK10(unit, lnaItems, fallback); r.detail.dates = [fallback]; return r; }
  const per = use.map(d => ({ d, r: kpiK10(unit, lnaItems, d) }));
  const v = per.reduce((a, x) => a + x.r.value, 0) / per.length;
  return { value: v, marks: marks('K10', v), detail: { dates: use, byDate: per.map(x => ({ date: x.d, pct: Math.round(x.r.value * 100) / 100, open: x.r.detail.open, late: x.r.detail.late })), open: per[per.length - 1].r.detail.open, late: per[per.length - 1].r.detail.late } };
}
// [E] 20-Oct: K10 per date from the best list collected on that date – TMS's "Defects Pending for Compliance" (every category) from the
// day it was first collected, before that "Locations needing attention". sources: [{name, from (first date), items}] best first.
function kpiK10mix(unit, sources, dates, fallback) {
  const pick = d => sources.find(s => s.from && d >= s.from && s.items.length);
  let use = dates.map(d => ({ d, s: pick(d) })).filter(x => x.s);
  if (!use.length) { const s = pick(fallback) || sources.find(x => x.items.length); if (!s) return null; use = [{ d: fallback, s }]; }
  const per = use.map(x => ({ d: x.d, src: x.s.name, r: kpiK10(unit, x.s.items, x.d) }));
  const v = per.reduce((a, x) => a + x.r.value, 0) / per.length; const L = per[per.length - 1].r.detail;
  return { value: v, marks: marks('K10', v), detail: { dates: per.map(x => x.d), byDate: per.map(x => ({ date: x.d, src: x.src, pct: Math.round(x.r.value * 100) / 100, open: x.r.detail.open, late: x.r.detail.late, lateByCat: x.r.detail.lateByCat })), open: L.open, late: L.late, lateByCat: L.lateByCat } };
}
// K12: % of AT welds found defective in their first (initial) USFD testing, welds done in the six months up to month ym.
// welds: [{unit, month, done, tested}] from the weld register; defects: USFD weld defects seen in TMS (kept even after removal)
function kpiK12(unit, welds, defects, ym, initialDays = 180, rule = 'latest') {   // [E] 22-Oct: rule 'early' = defects found within initialDays of welding (setting K12_RULE)
  const from = prevMonth(ym, 5);
  const inWin = m => m >= from && m <= ym;
  const mine = welds.filter(w => w.unit === unit && inWin(w.month));
  const done = mine.reduce((a, w) => a + (+w.done || 0), 0), tested = mine.reduce((a, w) => a + (+w.tested || 0), 0);
  // [E] 16-Oct: TMS rule (AT Welds Done/Defective report) – welds done in the six months whose LATEST USFD result is defective, of those tested.
  // Used when the weld register gave the latest result (WeldMonths.Defective); else the older reading from USFD defect lists below.
  if (rule !== 'early' && mine.some(w => w.defective != null && w.defective !== '')) { const def = mine.reduce((a, w) => a + (+w.defective || 0), 0);
    if (!tested) return { value: null, marks: def ? 0 : null, detail: { done, tested, defective: def, from, to: ym } };
    const v = def / tested * 100; return { value: v, marks: marks('K12', v), detail: { done, tested, defective: def, from, to: ym, basis: `Latest USFD result: ${def} of ${tested} tested AT welds (done ${from} to ${ym}) defective` } }; }
  const seen = new Set(); const bad = [];
  for (const d of defects) {
    if (d.unit !== unit || d.kind !== 'WELD' || !d.welded || !inWin(d.welded.slice(0, 7))) continue;
    const det = d.detected || d.firstSeen; const dd = det ? daysBetween(d.welded, det) : NaN; if (!(dd >= 0 && dd <= initialDays)) continue; if (String(det).slice(0, 10) > monthRange(ym).to) continue;   // found after the month: not in that month's score
    const k = [d.section, d.line, d.km, d.m, d.rail].join('|'); if (seen.has(k)) continue; seen.add(k); bad.push(d);
  }
  if (!tested) return { value: null, marks: bad.length ? 0 : null, detail: { done, tested, defective: bad.length, from, to: ym } };
  const v = bad.length / tested * 100;
  return { value: v, marks: marks('K12', v), detail: { done, tested, defective: bad.length, from, to: ym, list: bad.slice(0, 30).map(d => `${d.section} ${d.line} ${d.km}/${d.m} ${d.rail} ${d.status} (welded ${d.welded}, found ${d.detected || d.firstSeen})`) } };
}

// ---------- K14: DFWR older than 90 days removed during month ----------
function kpiK14(unit, dfwrItems, J, ym, today, forecast = false) {
  const mine = dfwrItems.filter(i => (i.unit || unitForLocation(J, i.section, i.line, (i.km || 0) * 1000 + (i.m || 0))) === unit);
  const { from, to } = monthRange(ym); const end = today && today < to ? today : to;
  const base = openOn(mine, from).filter(i => i.date && daysBetween(i.date, from) > 90);
  const removed = base.filter(i => i.closedOn && i.closedOn <= end);
  let v = base.length ? removed.length / base.length * 100 : null;
  const pending90 = openOn(mine, end).filter(i => i.date && daysBetween(i.date, end) > 90);
  const detail = { base: base.length, removed: removed.length, pending90: pending90.length, open: openOn(mine, end).length, basis: 'Whole month (over)' };
  if (forecast && end < to && v != null) {   // month still running: removals so far at the present pace
    const el = dayCount(from, end), len = dayCount(from, to), f = Math.min(base.length, removed.length * len / el); v = f / base.length * 100;
    detail.forecast = true; detail.basis = `Forecast: ${removed.length} of ${base.length} DFWR (older than 90 days on the 1st) removed in ${el} of ${len} days – at this pace ${Math.round(f)} by month end`;
  }
  return { value: v, marks: v == null ? (pending90.length ? 0 : 4) : marks('K14', v), detail };
}

// ---------- K15: overdue oiling & greasing (count; % needs FP-joint total) ----------
// K15: TMS counts main-line joints only (block-section joints; station / yard lines excluded) – user, 11.10.2026
// [E] 16-Oct: TMS counts MAIN + LOOP line joints (FishPlateAnalysisSummary: TAK 44 of 964 = 4.6 % → 3, GRAE 67 of 652 = 10.3 % → 2,
// both = TMS; main line alone had 0 overdue everywhere). sum = TMS's own summary row for the unit taken on or before asOn.
function kpiK15(unit, ogItems, asOn, fpTotal, sum = null) {
  if (sum && +sum.total > 0) { const v = +sum.overdue / +sum.total * 100; return { value: v, marks: marks('K15', v), detail: { overdue: +sum.overdue, fpTotal: +sum.total, main: [+sum.mainOverdue, +sum.mainTotal], loop: [+sum.loopOverdue, +sum.loopTotal], date: sum.date, basis: `TMS summary of ${String(sum.date).slice(8, 10)}-${String(sum.date).slice(5, 7)}: ${sum.overdue} of ${sum.total} FP joints (main + loop line) overdue` } }; }
  const open = openOn(ogItems.filter(i => i.unit === unit), asOn).filter(i => !i.next || i.next.slice(0, 7) < asOn.slice(0, 7));
  const v = fpTotal ? open.length / fpTotal * 100 : null;
  return { value: v, marks: v == null ? null : marks('K15', v), detail: { overdue: open.length, fpTotal: fpTotal || null } };
}

// ---------- K7: repeated OMS peak locations (km with peaks in two consecutive runs) ----------
function omsRepeated(rows) { // rows of one section+line: {km, runIdx(1=latest), vertical, lateral}
  const byRun = {}; for (const r of rows) if ((r.vertical || 0) + (r.lateral || 0) > 0) (byRun[r.runIdx] = byRun[r.runIdx] || new Set()).add(r.km);
  const rep = i => { const a = byRun[i] || new Set(), b = byRun[i + 1] || new Set(); return [...a].filter(k => b.has(k)); };
  return { latest: rep(1), previous: rep(2) };
}
function kpiK7(unit, oms, J) {
  const groups = {}; for (const r of oms) (groups[r.section + '|' + r.line] = groups[r.section + '|' + r.line] || []).push(r);
  let cur = 0, prev = 0; const locs = [];
  for (const [k, rows] of Object.entries(groups)) {
    const [section, line] = k.split('|'); const rr = omsRepeated(rows);
    for (const km of rr.latest) if (unitForLocation(J, section, line, km * 1000 + 500) === unit) { cur++; locs.push({ section, line, km }); }
    for (const km of rr.previous) if (unitForLocation(J, section, line, km * 1000 + 500) === unit) prev++;
  }
  if (!Object.keys(groups).length) return { value: null, marks: null, detail: {} };
  const v = reduction(prev, cur); return { value: v, marks: marks('K7', v), detail: { cur, prev }, list: locs };
}

// ---------- K8/K9: TRC counts per unit (latest run vs previous run) ----------
// [E] 21-Oct: K8 / K9 as TMS counts them – REPEATED UML peak locations / repeated CBML blocks of the SSE (TMS dashboard lists,
// see trcrep.js) open on the day of the marks, compared with the 1st of the month before (% reduction, the K5–K9 bands).
// None open = full marks; open ones without a known count a month earlier = no reduction shown = 0 (what TMS gave in September).
function kpiTRCrep(k, items, unit, asOn, prevOn) {
  const mine = items.filter(i => i.unit === unit); const open = openOn(mine, asOn);
  const cur = open.length; const prev = prevOn ? openOn(mine, prevOn).length : null;
  const list = open.slice(0, 30).map(i => [i.section, i.line, i.km != null ? i.km + '/' + (i.m == null ? '' : i.m) : '', i.block != null ? 'block ' + i.block : '', i.run ? 'run ' + i.run : '', i.repeated != null ? 'repeated ' + i.repeated + '×' : ''].filter(Boolean).join(' '));
  const what = k === 'K8' ? 'repeated UML peak locations' : 'repeated CBML blocks';
  if (!cur) return { value: prev ? 100 : 0, marks: KPI[k].max, detail: { cur, prev, list, basis: `TMS rule: no ${what} on TMS's list for this SSE` } };
  if (prev == null) return { value: null, marks: 0, detail: { cur, prev, list, basis: `TMS rule: ${cur} ${what} on TMS's list; the count a month earlier is not known here, so no reduction can be shown (0 marks)` } };
  const v = reduction(prev, cur);
  return { value: v, marks: marks(k, v), detail: { cur, prev, list, basis: `TMS rule: ${what} on TMS's list – ${prev} a month earlier, ${cur} now` } };
}
function kpiTRC(k, cur, prev) { if (cur == null) return { value: null, marks: null, detail: {} }; const v = reduction(prev, cur); return { value: prev == null ? null : v, marks: prev == null ? null : marks(k, v), detail: { cur, prev } }; }

// ---------- K11: IMRs (tested in month) removed after more than 3 days ----------
function kpiK11(unit, imr, J, ym) {
  const mine = imr.filter(r => r.tested && r.tested.slice(0, 7) === ym && unitForLocation(J, r.section, r.line, (r.km || 0) * 1000 + (r.m || 0)) === unit);
  if (!mine.length) return { value: 0, marks: 5, detail: { n: 0, late: 0 } };
  const late = mine.filter(r => r.days == null ? true : r.days > 3).length; const v = late / mine.length * 100;
  return { value: v, marks: marks('K11', v), detail: { n: mine.length, late } };
}

// ---------- K13: joggling pending = welds needing joggled plates (new AT welds until tested, defective welds) not joggled ----------
function kpiK13(unit, jogItems, atTotal, asOn) {
  const open = openOn(jogItems.filter(i => i.unit === unit), asOn);
  if (!atTotal) return { value: null, marks: open.length ? 0 : null, detail: { pending: open.length, atWelds: 0 } };
  const v = open.length / atTotal * 100; return { value: v, marks: marks('K13', v), detail: { pending: open.length, atWelds: atTotal } };
}

// ---------- jurisdiction as mapped in TMS (collector, kind 'tmsJurisdiction') vs the Jurisdiction Details file ----------
// TMS names: unit "SSE/P.WAY/BWN(W)" → BWNW, "SSE/P.Way/SNT" → SNT, "SSE/PW/SRP" → SRP (not a P-Way in-charge → null);
// line "Down Line" → DN, "Up Line 1" → UP1, "Reversible Line" → REV, "Down Chord Line" → DNCH; section via sectionName.
const tmsUnit = name => { const m = String(name || '').toUpperCase().replace(/\s+/g, '').match(/^SSE\/(?:P\.?WAY|PW)\/(.+)$/); return m ? m[1].replace(/[^A-Z0-9]/g, '') : null; };
const tmsLine = l => lineKey(String(l || '').replace(/\bline\b/ig, ' ').replace(/\s+/g, ' ').trim()) || '';
// segs: [{unit, section, line, a, b}] (metres). Pieces shorter than tol metres are ignored.
function compareJurisdiction(fileSegs, tmsSegs, tol = 50) {
  const norm = s => ({ unit: s.unit, section: sectionName(s.section) || '', line: tmsLine(s.line), a: Math.min(+s.a, +s.b), b: Math.max(+s.a, +s.b) });
  const F = fileSegs.map(norm), T = tmsSegs.map(norm); const key = s => s.section + '|' + s.line;
  const by = (L) => { const m = new Map(); L.forEach(s => { const k = key(s); if (!m.has(k)) m.set(k, []); m.get(k).push(s); }); return m; };
  const fb = by(F), tb = by(T); const keys = [...new Set([...fb.keys(), ...tb.keys()])].sort();
  const out = { onlyTms: [], onlyFile: [], unitDiff: [], kmDiff: [] };
  const minus = (s, others) => { let p = [[s.a, s.b]]; for (const o of others) p = p.flatMap(([a, b]) => (o.b <= a || o.a >= b) ? [[a, b]] : [[a, Math.max(a, o.a)], [Math.min(b, o.b), b]].filter(([x, y]) => y - x > 0)); return p.filter(([a, b]) => b - a >= tol); };
  const push = (list, o) => { const l = list[list.length - 1]; if (l && l.section === o.section && l.line === o.line && l.unit === o.unit && l.other === o.other && Math.abs(l.b - o.a) <= tol) l.b = Math.max(l.b, o.b); else list.push(o); };
  for (const k of keys) {
    const fs = (fb.get(k) || []).sort((x, y) => x.a - y.a), ts = (tb.get(k) || []).sort((x, y) => x.a - y.a); const [section, line] = k.split('|');
    // a piece one side has and the other does not: km difference when it continues the same unit's stretch on the other side, else missing
    const side = (A, B, only, tag) => { for (const s of A) for (const [a, b] of minus(s, B)) {
      const near = B.some(o => o.unit === s.unit && (Math.abs(o.a - b) <= tol || Math.abs(o.b - a) <= tol));
      push(near ? out.kmDiff : only, { unit: s.unit, section, line, a, b, side: tag }); } };
    side(ts, fs, out.onlyTms, 'tms'); side(fs, ts, out.onlyFile, 'file');
    for (const t of ts) for (const f of fs) { const a = Math.max(t.a, f.a), b = Math.min(t.b, f.b); if (b - a >= tol && t.unit !== f.unit) push(out.unitDiff, { section, line, a, b, unit: f.unit, other: t.unit }); }
  }
  const km = L => Math.round(L.reduce((x, s) => x + (s.b - s.a), 0) / 100) / 10;
  out.totals = { file: { stretches: F.length, km: km(F), units: new Set(F.map(s => s.unit)).size }, tms: { stretches: T.length, km: km(T), units: new Set(T.map(s => s.unit)).size }, onlyTmsKm: km(out.onlyTms), onlyFileKm: km(out.onlyFile), unitDiffKm: km(out.unitDiff), kmDiffKm: km(out.kmDiff) };
  return out;
}

// ---------- [E] 21-Oct: line by line, the way the manual monitoring sheet counts (a line is "done" only when every km of it is covered) ----------
// For each section-line of the unit: foot plate / rear vehicle 1st–15th and 16th–end of month ym (TMS KPI-2 basis, line-wise), and
// push trolley / on foot over the two months (TMS KPI-3 window, here line by line – TMS itself counts KPI-3 by section-km).
// Each line lists the km still not covered and the trips that covered it (date, type, official, route, km) – the evidence to check
// against the TMS register. guess = credited because the trip's route name is unknown here (same line + km of the unit's own track).
function lineStatus(unitObj, insp, ym, opts = {}) {
  const [y, m] = ym.split('-').map(Number); const ld = lastDay(y, m);
  const a1 = `${ym}-01`, b1 = `${ym}-15`, a2 = `${ym}-16`, b2 = `${ym}-${pad(ld)}`;
  const run = (from, to, extra) => { const ev = new Map(); const c = coverage(unitObj, insp, from, to, { ...opts, lineWise: true, evidence: ev, ...extra }); return { c, ev }; };
  const fp1 = run(a1, b1, { types: ['FP', 'RV'] }), fp2 = run(a2, b2, { types: ['FP', 'RV'] });
  const from3 = monthRange(prevMonth(ym, 1)).from;
  const accept = (i, seg) => i.type === 'TROLLEY' || (i.type === 'FOOT' && (seg.speed != null && seg.speed > 110));
  const pt = run(from3, b2, { types: ['FOOT', 'TROLLEY'], accept, who: opts.who3 || opts.who });
  const lines = []; const seen = new Set();
  for (const s of unitObj.segs) { const k = s.section + '|' + s.line; if (seen.has(k)) continue; seen.add(k); lines.push({ section: s.section, line: s.line, segs: unitObj.segs.filter(x => x.section === s.section && x.line === s.line) }); }
  const part = (R, L) => { const miss = R.c.missing.filter(x => x.section === L.section && x.line === L.line).map(x => x.km).sort((p, q) => p - q);
    const by = (R.ev.get(L.section + '|' + L.line) || []).map(e => ({ date: e.i.date, type: e.i.type, desig: e.i.desig || '', official: e.i.official || '', route: e.i.route || '', line: e.i.line || '', km: [e.i.kmA, e.i.kmB].join('–'), guess: e.guess }))
      .sort((p, q) => p.date < q.date ? -1 : 1);
    return { done: !miss.length, miss: kmRuns(miss), by: by.slice(0, 6), byN: by.length, guess: by.length > 0 && by.every(x => x.guess) }; };
  return lines.map(L => ({ section: L.section, line: L.line, km: L.segs.map(s => `${r1(s.a / 1000)}–${r1(s.b / 1000)}`).join(', '), speed: Math.max(...L.segs.map(s => s.speed || 0)) || null,
    fp1: part(fp1, L), fp2: part(fp2, L), pt: part(pt, L) }));
}
const kmRuns = ks => { const out = []; let a = null, p = null; for (const k of ks) { if (a == null) { a = p = k; continue; } if (k === p + 1) { p = k; continue; } out.push(a === p ? String(a) : a + '–' + p); a = p = k; } if (a != null) out.push(a === p ? String(a) : a + '–' + p); return out.join(', '); };

return { KPI, marks, reduction, desigUnit, isInCharge, buildJurisdiction, unitForLocation, routeSections, inspectorMatches, coverage, monthRange, prevMonth, kpiK2, kpiK3, kpiK16, day, addMonths, addDays, daysBetween, nextFirst, K1_DEFAULTS, assetDue, k1Overdue, kpiK1, kpiFracture, openOn, pendingDays, kpiK10, kpiK10avg, kpiK10mix, kpiK12, kpiK14, kpiK15, omsRepeated, kpiK7, kpiTRCrep, kpiTRC, kpiK11, kpiK13, tmsUnit, tmsLine, compareJurisdiction, lineStatus, normUnit };
})();
__m['dpc.js'] = (function(){
// [E] 20-Oct-2026: TMS dashboard item 7 "Defects Pending for Compliance" – the detail page
// PopUpDefectsOnMainLineDetails.jsp?authlvl=5&cond=HWH&repflag=100&days= lists EVERY pending defect of the division in one page,
// one table per category (P-Xing ML / PRL, joint P-Xing ML / PRL, LWR, SEJ, bridge, LC, curve, TRC, OMS, Other inspections,
// defects on loop lines). Each row names the SSE TMS charges it to, the inspection date and "Pending Since Days" (TMS counts both
// days: inspected 10/10 shows 11 days on 20/10). This is TMS's own K10 basis (KPI-10 "Defects Pending for Compliance (>10 Days)").
// Works without a browser DOM (Apps Script tests, Node, the admin page).
const {decode} = __m['tmstable.js'];
const {tmsUnit} = __m['kpi.js'];

const DPC_CATS = {
  pxingtableml: 'PXING_ML', pxingtableprl: 'PXING_PRL', pxingjointtableml: 'PXING_JOINT_ML', pxingjointtableprl: 'PXING_JOINT_PRL',
  lwrtable: 'LWR', sejtable: 'SEJ', brtable: 'BR', lctable: 'LC', curvetable: 'CURVE', trctable: 'TRC', omstable: 'OMS',
  othertable: 'OTHER', looptable: 'LOOP'
};
const DPC_NAME = { PXING_ML: 'Points & crossings (main line)', PXING_PRL: 'Points & crossings (passenger running loop)', PXING_JOINT_ML: 'Joint P&C inspection (main line)',
  PXING_JOINT_PRL: 'Joint P&C inspection (PRL)', LWR: 'LWR', SEJ: 'SEJ', BR: 'Bridge', LC: 'Level crossing', CURVE: 'Curve', TRC: 'TRC', OMS: 'OMS',
  OTHER: 'Other inspections (foot plate / rear vehicle / trolley …)', LOOP: 'Loop line' };
// categories that "Locations needing attention" does not hold (their jobs come from this list)
const DPC_ONLY = ['OTHER', 'LOOP'];

const strip = s => decode(String(s == null ? '' : s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const isoDMY = s => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
const num = s => { const t = String(s == null ? '' : s).trim(); return t !== '' && !isNaN(+t) ? +t : null; };

function dpcFromPage(html) {
  html = String(html || '');
  const text = strip(html);
  const rep = /Reporting Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(text); const asOn = rep ? isoDMY(rep[1]) : null;
  const out = []; const seen = {};
  const re = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi; let m;
  while ((m = re.exec(html))) {
    const id = (/\bid\s*=\s*["']?([\w-]+)/i.exec(m[1]) || [])[1]; const cat = id && DPC_CATS[id.toLowerCase()]; if (!cat) continue;
    const rows = [...m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => [...r[1].matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi)]
      .map(c => ({ th: c[1].toLowerCase() === 'th', span: +((/colspan\s*=\s*["']?(\d+)/i.exec(c[2]) || [])[1] || 1), t: strip(c[3]) })));
    const hi = rows.findIndex(r => r.some(c => /^SSE$/i.test(c.t))); if (hi < 0) continue;
    const head = rows[hi]; const sub = rows[hi + 1] && rows[hi + 1].length && rows[hi + 1].every(c => c.th) ? rows[hi + 1] : [];
    const cols = []; let si = 0;
    head.forEach(c => { if (c.span > 1) { for (let k = 0; k < c.span; k++) cols.push((c.t + ' ' + ((sub[si++] || {}).t || '')).trim()); } else cols.push(c.t); });
    const ci = rx => cols.findIndex(c => rx.test(c));
    const iSSE = ci(/^SSE$/i), iSec = ci(/^Section$/i), iLine = ci(/^(Loop )?Line$/i), iStn = ci(/Station/i), iAsset = ci(/(No\.|Asset Name)/i),
      iType = ci(/Type of Inspection/i), iKm = ci(/^Location( From)? km$/i), iM = ci(/^Location( From)? m$/i), iKmTo = ci(/^Location To km$/i), iMTo = ci(/^Location To m$/i),
      iPost = ci(/^POST$/i), iDef = ci(/^Defect$/i), iDays = ci(/Pending\s*Since\s*Days/i), iDate = ci(/(^Inspection Details Date$|^Date of Inspection$)/i),
      iBy = ci(/(^Inspection Details Authority$|^Inspected By$)/i), iAden = ci(/^ADEN$/i);
    for (const r of rows.slice(hi + 1)) {
      if (!r.length || !/^\d+$/.test(r[0].t) || r.some(c => c.th)) continue;
      const v = i => (i >= 0 && r[i] ? r[i].t : '');
      const sse = v(iSSE); const date = isoDMY(v(iDate));
      const o = { cat, sse, unit: tmsUnit(sse) || '', aden: v(iAden), section: v(iSec), line: v(iLine), station: v(iStn), asset: v(iAsset), type: v(iType),
        km: num(v(iKm)), m: num(v(iM)), kmTo: num(v(iKmTo)), mTo: num(v(iMTo)), post: v(iPost), defect: v(iDef), date, by: v(iBy), days: num(v(iDays)), asOn };
      const base = ['DPC', cat, o.unit, o.section, o.line, o.station, o.asset, o.km, o.m, date, o.defect].join('|');
      seen[base] = (seen[base] || 0) + 1; o.key = seen[base] > 1 ? base + '|' + seen[base] : base;
      out.push(o);
    }
  }
  return out;
}
// "Pending since days" the way TMS counts it (both days counted)
function dpcDays(date, asOn) { if (!date || !asOn) return null; return Math.round((Date.parse(asOn + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 864e5) + 1; }
const isDpcPage = html => /id\s*=\s*["']?(pxingtableML|othertable|looptable)\b/i.test(String(html || ''));   // 20-Oct: the tables decide (the title may be spelt "Defects - Pending …")

return { DPC_CATS, DPC_NAME, DPC_ONLY, dpcFromPage, dpcDays, isDpcPage };
})();
__m['trcrep.js'] = (function(){
// [E] 21-Oct-2026: K8 / K9 the way TMS counts them. Found live (read-only, 21-Oct): TMS's September marks K9 = 0 for exactly the
// 9 SSEs on the TMS dashboard list "Repeated Blocks having CBML" (PopUpNBMLRepeatedLocDetails.jsp) and 5 for everyone else
// (23/23); K8 = 0 for every SSE on "Repeated UML Peaks" (PopUpRepeatedTRCUMLPeakLocations.jsp) whose run was before the 1st.
// So KPI-8 / KPI-9 "% reduction in UML peaks / CBML blocks in TRC" count REPEATED locations (a peak / block found again in
// the following run), like K7 for OMS – not all UML peaks / CBML blocks of the latest run (that rule matched only 5/19 and 9/19).
// Each list = one table #datatable: Sr# | Railway | Division | Sr.DEN | ADEN | SSE | TMS Section | Line | Block Section/Yard |
// Location From km m | Location To km m | (Block No.) | Section Speed | Route Classification | TRC Run Date | TRC Run No. |
// Repeated Count | links. Works without a browser DOM (Apps Script tests, Node, the admin page).
const {decode} = __m['tmstable.js'];
const {tmsUnit} = __m['kpi.js'];

const strip = s => decode(String(s == null ? '' : s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const isoDMY = s => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
const num = s => { const t = String(s == null ? '' : s).trim(); return t !== '' && !isNaN(+t) ? +t : null; };

/** which list a page is: 'UML' | 'CBML' | null */
function trcRepKind(html) {
  const h = String(html || '');
  if (!/Repeated\s*(<br\s*\/?>)?\s*Count/i.test(h)) return null;
  if (/Repeated\s+Blocks\s+having\s+CBML/i.test(h) || /Block\s*No\./i.test(h)) return 'CBML';
  if (/Repeated\s+UML\s+Peaks/i.test(h) || /UML\s*Peaks/i.test(h)) return 'UML';
  return null;
}
const isTrcRepPage = html => !!trcRepKind(html);

/** rows of one list: {list, sse, unit, section, line, place, km, m, kmTo, mTo, block, speed, route, run, runNo, repeated, key} */
function trcRepFromPage(html) {
  html = String(html || ''); const list = trcRepKind(html); if (!list) return [];
  const out = []; const seen = {};
  const re = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi; let m;
  while ((m = re.exec(html))) {
    const rows = [...m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => [...r[1].matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi)]
      .map(c => ({ th: c[1].toLowerCase() === 'th', span: +((/colspan\s*=\s*["']?(\d+)/i.exec(c[2]) || [])[1] || 1), t: strip(c[3]) })));
    const hi = rows.findIndex(r => r.some(c => /^SSE$/i.test(c.t)) && r.some(c => /Repeated\s*Count/i.test(c.t))); if (hi < 0) continue;
    const head = rows[hi]; const sub = rows[hi + 1] && rows[hi + 1].length && rows[hi + 1].every(c => c.th) ? rows[hi + 1] : [];
    const cols = []; let si = 0;
    head.forEach(c => { if (c.span > 1) { for (let k = 0; k < c.span; k++) cols.push((c.t + ' ' + ((sub[si++] || {}).t || '')).trim()); } else cols.push(c.t); });
    const ci = rx => cols.findIndex(c => rx.test(c));
    const iSSE = ci(/^SSE$/i), iSec = ci(/^TMS Section$|^Section$/i), iLine = ci(/^Line$/i), iPlace = ci(/Block Section/i), iKm = ci(/^Location From km$/i), iM = ci(/^Location From m$/i),
      iKmTo = ci(/^Location To km$/i), iMTo = ci(/^Location To m$/i), iBlock = ci(/^Block No\.?$/i), iSpeed = ci(/Section Speed/i), iRoute = ci(/Route/i),
      iRun = ci(/TRC Run Date/i), iRunNo = ci(/TRC Run No/i), iRep = ci(/Repeated\s*Count/i);
    for (const r of rows.slice(hi + 1)) {
      if (!r.length || !/^\d+$/.test(r[0].t) || r.some(c => c.th)) continue;
      const v = i => (i >= 0 && r[i] ? r[i].t : '');
      const sse = v(iSSE);
      const o = { list, sse, unit: tmsUnit(sse) || '', section: v(iSec), line: v(iLine), place: v(iPlace), km: num(v(iKm)), m: num(v(iM)), kmTo: num(v(iKmTo)), mTo: num(v(iMTo)),
        block: num(v(iBlock)), speed: num(v(iSpeed)), route: v(iRoute), run: isoDMY(v(iRun)), runNo: v(iRunNo), repeated: num(v(iRep)) };
      // the key leaves out the run: the same location found again in a later run stays one item (its run / count are updated)
      const base = ['R' + list, o.unit, o.section, o.line, o.km, o.m, o.block == null ? '' : o.block].join('|');
      seen[base] = (seen[base] || 0) + 1; o.key = seen[base] > 1 ? base + '|' + seen[base] : base;
      out.push(o);
    }
  }
  return out;
}

return { trcRepKind, isTrcRepPage, trcRepFromPage };
})();
__m['shotocr.js'] = (function(){
// Screenshot reader for TMS web report pages (OMS peaks comparative summary, OMS accn. peaks, IMR testing history …).
// Dependency-free: finds the table grid (row bands and cell borders) and reads each cell with glyph templates
// learnt from TMS screenshots. Works on images from decodePNG() / canvas: {w, h, g3} with g3 = R+G+B.

const OH = 15, OMAXW = 14;   // glyph window height (rows) and widest single glyph (px)
const CUT = 120;                     // ink threshold (0..255) used to separate glyphs

function grey(im) { const n = im.w * im.h, g = new Uint8Array(n); for (let i = 0; i < n; i++) g[i] = Math.round(im.g3[i] / 3); return { w: im.w, h: im.h, g }; }

function rowMode(G, y, x0 = 0, x1 = G.w) { const hst = new Uint32Array(256); for (let x = x0; x < x1; x++) hst[G.g[y * G.w + x]]++; let b = 0; for (let v = 1; v < 256; v++) if (hst[v] > hst[b]) b = v; return [b, hst[b] / (x1 - x0)]; }

// horizontal bands of one background colour (table rows, header blocks, gaps)
function bands(G) {
  const m = []; for (let y = 0; y < G.h; y++) m.push(rowMode(G, y));
  const out = []; let s = 0;
  for (let y = 1; y <= G.h; y++) if (y === G.h || Math.abs(m[y][0] - m[s][0]) > 3) { out.push({ y0: s, y1: y, bg: m[s][0] }); s = y; }
  return out;
}

// vertical cell borders inside a group of bands: a column of constant colour, different from the background, in most bands
function columns(G, bl, x0 = 0, x1 = G.w) {
  const W = x1 - x0, score = new Float32Array(W);
  for (const b of bl) {
    for (let x = x0; x < x1; x++) {
      let mn = 255, mx = 0, sum = 0, n = 0;
      for (let y = b.y0 + 2; y < b.y1 - 2; y++) { const v = G.g[y * G.w + x]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++; }
      if (n && mx - mn <= 6 && Math.abs(sum / n - b.bg) >= 4) score[x - x0]++;
    }
  }
  const xs = []; for (let i = 0; i < W; i++) if (score[i] >= bl.length * 0.6) xs.push(i + x0);
  const grp = []; for (const x of xs) { const g = grp[grp.length - 1]; if (g && x - g[g.length - 1] <= 1) g.push(x); else grp.push([x]); }
  // a long run touching the picture edge is page margin + the table's outer border: keep only its inner end
  const br = grp.map(g => g.length <= 3 ? [g[0], g[g.length - 1]] : g[0] <= x0 + 1 ? [g[g.length - 1], g[g.length - 1]] : g[g.length - 1] >= x1 - 2 ? [g[0], g[0]] : null).filter(Boolean);
  const cols = []; for (let i = 0; i + 1 < br.length; i++) if (br[i + 1][0] - br[i][1] > 4) cols.push({ x0: br[i][1] + 1, x1: br[i + 1][0] });
  return cols;
}

// ink 0..255 relative to the local background
function inkAt(G, x, y, bg) { const v = bg - G.g[y * G.w + x]; return v > 0 ? v : 0; }

// text lines (rows that carry ink) inside a box
function textLines(G, y0, y1, x0, x1, bg, thr = 70) {
  const out = []; let s = -1;
  for (let y = y0; y < y1; y++) {
    let any = false; for (let x = x0; x < x1; x++) if (inkAt(G, x, y, bg) >= thr) { any = true; break; }
    if (any && s < 0) s = y; if (!any && s >= 0) { out.push([s, y]); s = -1; }
  }
  if (s >= 0) out.push([s, y1]);
  return out.filter(([a, b]) => b - a >= 3);
}

// glyph bitmap: OH rows from top-2, values scaled so the darkest ink of the line = 255
function glyph(G, top, xa, xb, bg, scale) {
  const W = xb - xa, q = new Uint8Array(OH * W);
  for (let y = 0; y < OH; y++) { const yy = top - 2 + y; if (yy < 0 || yy >= G.h) continue; for (let x = 0; x < W; x++) q[y * W + x] = Math.min(255, Math.round(inkAt(G, xa + x, yy, bg) * scale)); }
  return q;
}

const NORM = 255 * 255 * OH * 6;
const SHIFTS = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];     // absolute: unexplained ink costs the same whatever the glyph width
const qsum = q => { let t = 0; for (let i = 0; i < q.length; i++) t += q[i]; return t; };
// a digit glyph that carries a decimal point at its edge (bad cut while learning) must not become a template
function dotAppendix(ch, q, w) {
  if (!/[013-9]/.test(ch) || w < 4) return false;
  let yb = -1; for (let y = OH - 1; y >= 0 && yb < 0; y--) for (let x = 0; x < w; x++) if (q[y * w + x] >= 60) { yb = y; break; }
  if (yb < 4) return false;
  const bottomOnly = x => { let lo = 0, hi = 0; for (let y = 0; y < OH; y++) { const v = q[y * w + x]; if (y >= yb - 2) hi = Math.max(hi, v); else lo = Math.max(lo, v); } return hi >= 60 && lo < 40; };
  return bottomOnly(w - 1) || (ch !== '9' && bottomOnly(0));
}
class ShotTemplates {
  constructor(list = []) { this.t = []; this.cache = new Map(); for (const x of list) this.push(x.ch, Uint8Array.from(x.q), x.w); }
  push(ch, q, w) { this.t.push({ ch, w, q, s: qsum(q) }); this.cache.clear(); }
  add(ch, q, w, tol = 0.012) { let mx = 0; for (let i = 0; i < q.length; i++) if (q[i] > mx) mx = q[i]; if (mx < 110 || dotAppendix(ch, q, w)) return false; for (const t of this.t) if (t.ch === ch && t.w === w && this.dist(q, w, t) < tol) return false; this.push(ch, Uint8Array.from(q), w); return true; }
  // squared difference over the best small shift (x ±1, y ±1), divided by NORM; stops early once above `bound`
  dist(q, w, t, bound = Infinity, qs) {
    const wt = t.w, tq = t.q, lim = bound * NORM;
    if (qs != null) { const d = qs - t.s; if (d * d / (OH * (Math.max(w, wt) + 2)) >= lim) return Infinity; }   // Cauchy–Schwarz lower bound
    let bestS = lim;
    for (const [r, dy] of SHIFTS) {   // template origin at x = r relative to the query, rows moved by dy
      const xs = Math.min(0, r), xe = Math.max(w, r + wt); let s = 0;
      outer: for (let y = 0; y < OH; y++) { const yb = y + dy, rowB = yb >= 0 && yb < OH; for (let x = xs; x < xe; x++) {
        const A = x >= 0 && x < w ? q[y * w + x] : 0, xb = x - r, B = rowB && xb >= 0 && xb < wt ? tq[yb * wt + xb] : 0;
        if (A !== B) { s += (A - B) * (A - B); if (s >= bestS) break outer; } } }
      if (s < bestS) bestS = s;
    }
    return bestS >= lim ? Infinity : bestS / NORM;
  }
  widths(alpha) { const k = 'W|' + (alpha || ''); let r = this.cache.get(k); if (r) return r; let lo = 99, hi = 0; for (const t of this.t) if (!alpha || alpha.includes(t.ch)) { lo = Math.min(lo, t.w); hi = Math.max(hi, t.w); } r = [Math.max(1, lo - 1), Math.min(OMAXW, hi + 1)]; this.cache.set(k, r); return r; }
  key(q, w) { let k = w + ':'; for (let i = 0; i < q.length; i++) k += String.fromCharCode(q[i] + 32); return k; }
  // best match (optionally only among the characters in alpha) → [ch, dist]
  best(q, w, alpha) {
    const key = this.key(q, w) + '|' + (alpha || ''); const c = this.cache.get(key); if (c !== undefined) return c;
    const qs = qsum(q); let r = null, bd = Infinity;
    for (const t of this.t) { if (Math.abs(w - t.w) > 1 || (alpha && !alpha.includes(t.ch))) continue; const d = this.dist(q, w, t, bd, qs); if (d < bd) { bd = d; r = [t.ch, d]; } }
    if (this.cache.size > 300000) this.cache.clear();
    this.cache.set(key, r); return r;
  }
  dist1(q, w, ch) { const r = this.best(q, w, ch); return r ? r[1] : null; }
  toJSON() { return this.t.map(t => ({ ch: t.ch, w: t.w, q: Array.from(t.q) })); }
}

// column ink profile of one text line: max ink in each column
const LOW = 32;               // a column with less ink than this is blank
function profile(G, top, bot, x0, x1, bg) { const p = new Uint8Array(Math.max(0, x1 - x0)); for (let x = x0; x < x1; x++) { let m = 0; for (let y = top; y < bot; y++) { const v = inkAt(G, x, y, bg); if (v > m) m = v; } p[x - x0] = m; } return p; }
// words: runs of ink columns separated by >= 3 blank columns → [[a,b)…]
function words(G, top, bot, x0, x1, bg) {
  const p = profile(G, top, bot, x0, x1, bg), out = []; let s = -1, last = -9;
  for (let i = 0; i < p.length; i++) if (p[i] >= LOW) { if (s < 0) s = i; else if (i - last > 3) { out.push([s + x0, last + 1 + x0]); s = i; } last = i; }
  if (s >= 0) out.push([s + x0, last + 1 + x0]);
  return out;
}
// atoms (kept for training bootstrap): runs of ink columns, gap >= 1
function atoms(G, top, bot, x0, x1, bg) {
  const p = profile(G, top, bot, x0, x1, bg), out = []; let s = -1;
  for (let i = 0; i <= p.length; i++) { const ink = i < p.length && p[i] >= LOW; if (ink && s < 0) s = i; if (!ink && s >= 0) { out.push([s + x0, i + x0]); s = -1; } }
  return out;
}
function cellScale(G, top, bot, xa, xb, bg) { let mx = 0; for (let y = top; y < bot; y++) for (let x = xa; x < xb; x++) { const v = inkAt(G, x, y, bg); if (v > mx) mx = v; } return mx ? Math.min(2.2, 255 / mx) : 1; }

// best reading of one word [a,b): DP over every column; a glyph starts and ends on ink, blank columns are skipped
const PEN = 0.0025;
function readWord(T, G, top, bot, a, b, bg, scale, alpha) {
  const W = b - a, p = profile(G, top, bot, a, b, bg), best = new Array(W + 1).fill(null); best[W] = [0, '', 0, [], []]; const [wlo, whi] = T.widths(alpha);
  for (let i = W - 1; i >= 0; i--) {
    let r = null;
    if (p[i] < LOW) { best[i] = best[i + 1]; continue; }
    let jmax = i + 1; while (jmax < W && !(p[jmax] < LOW && (jmax + 1 >= W || p[jmax + 1] < LOW)) && jmax - i < whi) jmax++;   // a glyph never spans a gap of two blank columns
    for (let j = i + wlo; j <= jmax; j++) {
      if (p[j - 1] < LOW || !best[j]) continue;
      const sc = T.best(glyph(G, top, a + i, a + j, bg, scale), j - i, alpha); if (!sc) continue;
      const tot = sc[1] + PEN + best[j][0];
      if (!r || tot < r[0]) r = [tot, sc[0] + best[j][1], 1 + best[j][2], [sc[1]].concat(best[j][3]), [[a + i, a + j]].concat(best[j][4])];
    }
    best[i] = r;
  }
  return best[0];
}
// read one text line in a box → {text, cost (mean per glyph), worst (largest glyph distance)}
function readLine(T, G, top, bot, x0, x1, bg, alpha) {
  const Wd = words(G, top, bot, x0, x1, bg); if (!Wd.length) return { text: '', cost: 0, worst: 0, n: 0 };
  const scale = cellScale(G, top, bot, Wd[0][0], Wd[Wd.length - 1][1], bg);
  let text = '', cost = 0, n = 0, worst = 0; const segs = [];
  for (const [a, b] of Wd) {
    const r = readWord(T, G, top, bot, a, b, bg, scale, alpha) || [1, '?', 1, [1], [[a, b]]];
    if (text) text += ' '; text += r[1]; cost += r[0]; n += r[2]; for (const d of r[3]) if (d > worst) worst = d; segs.push(...r[4].map((x, i) => [r[1][i], x[0], x[1], r[3][i]]));
  }
  return { text, cost: n ? cost / n : 0, worst, n, segs, x0: Wd[0][0], x1: Wd[Wd.length - 1][1] };
}
// forced alignment of a known text (training / learning from corrections): returns [[ch, xa, xb]…] or null
function alignLine(T, G, top, bot, x0, x1, bg, txt, unknown = 0.12) {
  const Wd = words(G, top, bot, x0, x1, bg), ch = [...String(txt).replace(/\s+/g, '')];
  if (!Wd.length || !ch.length) return null;
  const a = Wd[0][0], b = Wd[Wd.length - 1][1], n = ch.length, W = b - a, p = profile(G, top, bot, a, b, bg);
  const scale = cellScale(G, top, bot, a, b, bg), has = new Set(T.t.map(t => t.ch));
  // best[i][c]: cost to read columns [i,W) as ch[c..]; blank columns are skipped free
  const best = Array.from({ length: W + 1 }, () => new Array(n + 1).fill(null)); best[W][n] = [0, null];
  for (let i = W - 1; i >= 0; i--) for (let c = n; c >= 0; c--) {
    let r = null;
    if (p[i] < LOW && best[i + 1][c]) r = [best[i + 1][c][0], [i + 1, c, null]];
    let jmax = i + 1; while (jmax < W && !(p[jmax] < LOW && (jmax + 1 >= W || p[jmax + 1] < LOW)) && jmax - i < OMAXW) jmax++;
    if (c < n && p[i] >= LOW) for (let j = i + 1; j <= jmax; j++) {
      if (p[j - 1] < LOW || !best[j][c + 1]) continue;
      const d = has.has(ch[c]) ? T.dist1(glyph(G, top, a + i, a + j, bg, scale), j - i, ch[c]) : unknown + (j - i < 2 ? 0.2 : 0);
      if (d == null) continue;
      const tot = d + best[j][c + 1][0];
      if (!r || tot < r[0]) r = [tot, [j, c + 1, [ch[c], a + i, a + j]]];
    }
    best[i][c] = r;
  }
  if (!best[0][0]) return null;
  const out = []; let i = 0, c = 0; while (i < W) { const st = best[i][c]; if (!st) return null; const [ni, nc, seg] = st[1]; if (seg) out.push(seg); i = ni; c = nc; }
  return { segs: out, scale, cost: best[0][0][0] / n };
}

// table layout: row bands of body rows (white / light grey / highlighted), the header band above, and cell borders
function layoutTables(G) {
  const B = bands(G).filter(b => b.y1 - b.y0 >= 6);
  const isBody = b => b.bg >= 225 && b.y1 - b.y0 >= 14 && b.y1 - b.y0 <= 40;
  const groups = []; let cur = null;
  for (const b of B) { if (isBody(b)) { if (cur && b.y0 - cur[cur.length - 1].y1 <= 4) cur.push(b); else { cur = [b]; groups.push(cur); } } else if (b.y1 - b.y0 > 6) cur = null; }
  const out = [];
  for (const grp of groups) {
    const head = B.filter(b => b.y1 <= grp[0].y0 + 3 && b.y1 >= grp[0].y0 - 12 && b.bg < 225 && b.y1 - b.y0 >= 14).pop() || null;
    const cols = columns(G, grp.length >= 2 ? grp : grp.concat(head ? [head] : []));
    if (cols.length < 2) continue;
    const rows = grp.map(b => {
      // text line of the row = most common first ink line over the cells (cell interiors only, borders excluded)
      const tops = {}, bots = {};
      for (const c of cols) { const L = textLines(G, b.y0 + 1, b.y1 - 1, c.x0 + 2, c.x1 - 2, b.bg); if (!L.length) continue; const t = L[0][0]; tops[t] = (tops[t] || 0) + 1; bots[t] = Math.max(bots[t] || 0, L[L.length - 1][1]); }
      const ks = Object.keys(tops).map(Number); let top = b.y0 + 4, bot = b.y1 - 4;
      if (ks.length) { const t = ks.reduce((p, q) => tops[q] > tops[p] || (tops[q] === tops[p] && q < p) ? q : p); top = t; bot = Math.max(...ks.filter(k => Math.abs(k - t) <= 3).map(k => bots[k])); }
      const partial = b.y1 - b.y0 < 15 || top <= b.y0 + 1 || bot >= b.y1 - 1;
      return { y0: b.y0, y1: b.y1, bg: b.bg, partial, top, bot };
    });
    out.push({ header: head ? { y0: head.y0, y1: head.y1, bg: head.bg } : null, cols, rows });
  }
  return out;
}
// read every table in a screenshot. Returns {G, tables:[{header, cols, rows:[{y0,y1,bg,partial,cells:[{text,cost}]}]}]}
function readTables(T, im) {
  const G = im.g ? im : grey(im);
  const tables = layoutTables(G);
  for (const t of tables) for (const r of t.rows) r.cells = t.cols.map(c => readLine(T, G, r.top, r.bot + 1, c.x0 + 2, c.x1 - 2, r.bg));
  return { G, tables };
}

// free text block (titles, run headers): all lines inside a box
function readBlock(T, G, y0, y1, x0, x1, bg) {
  if (bg == null) bg = rowMode(G, y0, x0, x1)[0];
  return textLines(G, y0, y1, x0, x1, bg).map(([a, b]) => readLine(T, G, a, b + 1, x0, x1, bg).text);
}
// background of a box = most common grey value
function rowBg(G, y0, y1, x0, x1) { const h = new Uint32Array(256); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) h[G.g[y * G.w + x]]++; let b = 0; for (let v = 1; v < 256; v++) if (h[v] > h[b]) b = v; return b; }

return { OH, grey, bands, columns, textLines, glyph, ShotTemplates, LOW, profile, words, atoms, readLine, alignLine, layoutTables, readTables, readBlock, rowBg };
})();
__m['shots.js'] = (function(){
// Reads screenshots of TMS web report pages into records:
//   IMR testing history (rail / weld / SEJ-turnout defect tables)  → kind 'imr'
//   OMS peaks km-wise comparative summary                           → kind 'oms'
// Every value keeps its place on the picture and a doubt flag, so the admin can check it against the picture before upload.
const {grey, layoutTables, readLine, textLines, rowBg, bands, alignLine, glyph, ShotTemplates} = __m['shotocr.js'];

const AL = { int: '0123456789', num: '0123456789.', date: '0123456789/', rail: 'LR', status: 'IMRSTW()', any: null,
  probe: '0123456789/.LRIMSTW()-', run: 'RUN0123456789:', runid: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/_' };
const DOUBT = 0.035;           // glyph distance above which a value is shown as doubtful
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function imageFromRGBA(w, h, data) { const g3 = new Uint16Array(w * h); for (let i = 0, j = 0; i < g3.length; i++, j += 4) g3[i] = data[j] + data[j + 1] + data[j + 2]; return { w, h, g3 }; }

function cell(T, G, row, col, alpha) {
  const x0 = col.x0 + 2, x1 = col.x1 - 2; const r = readLine(T, G, row.top, row.bot + 1, x0, x1, row.bg, alpha);
  return { text: r.text, worst: r.worst, box: [col.x0, row.y0, col.x1, row.y1], line: [row.top, row.bot + 1, x0, x1, row.bg] };
}
const nz = s => String(s || '').replace(/\s+/g, '');
const isDate = s => /^(\d\d)\/(\d\d)\/(\d{4})$/.test(s) && (() => { const [d, m, y] = s.split('/').map(Number); return d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1990 && y <= 2100; })();
const isoOf = s => { const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(s); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const isInt = s => /^\d{1,4}$/.test(s);
const isNum = s => /^\d{1,4}(\.\d{1,3})?$/.test(s);

// which column holds what, from a few sample rows read with a small alphabet
function sampleCols(T, G, tb) {
  const rows = tb.rows.filter(r => !r.partial).slice(0, 5);
  return tb.cols.map(col => rows.map(r => nz(cell(T, G, r, col, AL.probe).text)));
}
function srColumn(S) {
  const F = S.map(c => c.filter(Boolean));
  for (let c = 0; c < F.length; c++) { const v = F[c].map(Number); if (F[c].length >= 2 && F[c].every(isInt) && v.every((x, i) => i === 0 || x === v[i - 1] + 1)) return c; }
  for (let c = 0; c < F.length; c++) if (F[c].length && F[c].filter(isInt).length >= F[c].length * 0.8) return c;
  return -1;
}
const share = (arr, f) => arr.length ? arr.filter(f).length / arr.length : 0;

// ---------- classify one screenshot ----------
function readShot(T, im, name = '') {
  const G = im.g ? im : grey(im);
  const tables = layoutTables(G);
  const out = { name, w: G.w, h: G.h, kind: null, tables: [], title: '', notes: [] };
  // top text (titles) – used to suggest section / line / date
  const big = tables.filter(t => t.cols.length >= 6); const firstTop = big.length ? Math.min(...big.map(t => (t.header || t.rows[0]).y0)) : G.h;
  out.title = titleText(T, G, Math.max(0, firstTop - 260), firstTop);
  for (const tb of tables) {
    if (tb.rows.length < 1 || tb.cols.length < 6) continue;
    const S = sampleCols(T, G, tb);
    const stat = S.findIndex(c => share(c.filter(Boolean), v => /MR/.test(v)) >= 0.6 && c.some(Boolean));
    if (stat >= 0) { out.tables.push(readIMR(T, G, tb, S, stat)); continue; }
    if (tb.cols.length >= 9) { const o = readOMS(T, G, tb, S); if (o) out.tables.push(o); }
  }
  const kinds = [...new Set(out.tables.map(t => t.kind))];
  out.kind = kinds.length === 1 ? kinds[0] : kinds.length ? 'mixed' : null;
  if (!out.kind && /ACCN|RUN\s*NO|PEAKS?\)/i.test(out.title)) out.notes.push('OMS accn. peaks page – not used. Take the "OMS Peaks KM Wise Comparative Summary" page instead.');
  const t = out.title.replace(/\s+/g, ' ');
  let m;
  if ((m = /SECTION\s*:?\s*([A-Za-z][A-Za-z .-]+?)\s+LIN\w*\s*:/i.exec(t))) out.sectionText = m[1];
  if ((m = /LIN\w*\s*:\s*([A-Za-z0-9]+(?: Line)?)/i.exec(t))) out.lineText = m[1].trim();
  if ((m = /PRI\w*\s*O\w*\s*[-.:]?\s*(\d\d\/\d\d\/\d{4})/i.exec(t) || /(\d\d\/\d\d\/\d{4})/.exec(t))) out.printed = isoOf(m[1]);
  return out;
}
// text lines of a band, ignoring ruling lines (rows or columns inked over most of their length)
function cleanLines(G, y0, y1, bg) {
  const H = y1 - y0, ink = (x, y) => bg - G.g[y * G.w + x] >= 70; const colBad = new Uint8Array(G.w);
  for (let x = 0; x < G.w; x++) { let n = 0; for (let y = y0; y < y1; y++) if (ink(x, y)) n++; if (n > H * 0.7) colBad[x] = 1; }
  const rows = []; for (let y = y0; y < y1; y++) { let n = 0; for (let x = 0; x < G.w; x++) if (!colBad[x] && ink(x, y)) n++; rows.push(n > 0 && n < G.w * 0.4); }
  const out = []; let s = -1; for (let i = 0; i <= H; i++) { const on = i < H && rows[i]; if (on && s < 0) s = i; if (!on && s >= 0) { out.push([y0 + s, y0 + i]); s = -1; } }
  return out;
}
function titleText(T, G, y0, y1) {
  if (y1 - y0 < 8) return '';
  const out = [];
  for (const b of bands(G)) {
    if (b.y1 <= y0 || b.y0 >= y1 || b.bg < 235 || b.y1 - b.y0 < 8) continue;
    for (const [a, c] of cleanLines(G, Math.max(b.y0, y0), Math.min(b.y1, y1), b.bg)) {
      if (c - a < 6 || c - a > 16 || out.length >= 6) continue;
      out.push(readLine(T, G, a, c + 1, 0, G.w, b.bg).text);
    }
  }
  return out.join('\n');
}

// ---------- IMR testing history ----------
function readIMR(T, G, tb, S, stat) {
  const sr = srColumn(S); const dateCol = c => share(S[c].filter(Boolean), v => /^\d\d\/?\d\d\/?\d{4}$/.test(v)) >= 0.6;
  let test = stat + 1; while (test < S.length && !dateCol(test)) test++;
  let rem = S.length - 1; while (rem > test && !dateCol(rem)) rem--;
  let rail = -1, best = 0; S.forEach((c, i) => { const f = share(c.filter(Boolean), v => /^[LR1I.]{1,3}R$/.test(v) && v.length <= 3); if (f > best) { best = f; rail = i; } });
  const t = { kind: 'imr', box: [tb.cols[0].x0, (tb.header || tb.rows[0]).y0, tb.cols[tb.cols.length - 1].x1, tb.rows[tb.rows.length - 1].y1], rows: [], problems: [] };
  if (sr < 0 || rem <= test || test >= S.length) { t.problems.push('Columns not recognised'); if (globalThis.SHOT_DEBUG) console.log(JSON.stringify(S)); return t; }
  const cols = { sr, km: sr + 1, m: sr + 2, rail, status: stat, tested: test, removed: rem === test ? -1 : rem };
  const spec = { sr: 'int', km: 'int', m: 'num', rail: 'rail', status: 'status', tested: 'date', removed: 'date' };
  for (const row of tb.rows) {
    if (row.partial) continue;
    const r = { cells: {}, box: [tb.cols[0].x0, row.y0, tb.cols[tb.cols.length - 1].x1, row.y1] };
    for (const [k, c] of Object.entries(cols)) { if (c < 0) { r.cells[k] = { text: '', worst: 0 }; continue; } const v = cell(T, G, row, tb.cols[c], AL[spec[k]]); v.text = fixText(spec[k], v.text); r.cells[k] = v; }
    if (!r.cells.sr.text && !r.cells.km.text) continue;
    check(r, { sr: isInt, km: isInt, m: v => isNum(v) && +v <= 1200, rail: v => /^(LR|RR)$/.test(v), status: v => /^(IMR|SR IMR|TR IMR|IMR\(W\)|[A-Z]{1,3} ?IMR(\(W\))?)$/.test(v), tested: isDate, removed: v => !v || isDate(v) });
    t.rows.push(r);
  }
  t.cols = cols; return t;
}

// ---------- OMS peaks km-wise comparative summary ----------
function readOMS(T, G, tb, S) {
  const sr = srColumn(S); if (sr < 0 || tb.cols.length < sr + 6) return null;
  const nRuns = Math.floor((tb.cols.length - sr - 3) / 3); if (nRuns < 1) return null;
  // run headers: text in the grey band(s) above the column header, over each group of three columns
  const head = tb.header; if (!head) return null;
  const B = bands(G).filter(b => b.y1 <= head.y0 + 1 && b.y1 >= head.y0 - 60 && b.bg < 235);
  const y0 = B.length ? Math.min(...B.map(b => b.y0)) : head.y0 - 34;
  const runs = [];
  for (let i = 0; i < nRuns; i++) {
    const c0 = tb.cols[sr + 3 + i * 3], c2 = tb.cols[sr + 5 + i * 3]; const x0 = c0.x0 + 2, x1 = c2.x1 - 2;
    const bg = rowBg(G, y0, head.y0, x0, x1); const L = textLines(G, y0, head.y0, x0, x1, bg).filter(([a, b]) => b - a >= 5);
    const lines = L.map(([a, b]) => { const r = readLine(T, G, a, b + 1, x0, x1, bg); return { text: r.text, worst: r.worst, line: [a, b + 1, x0, x1, bg] }; });
    const run = parseRun(lines.map(l => l.text).join(' '));
    runs.push({ idx: i + 1, lines, box: [c0.x0, y0, c2.x1, head.y0], text: run.text, month: run.month, id: run.id, ok: run.ok, doubt: !run.ok || run.fixed || Math.max(0, ...lines.map(l => l.worst)) > DOUBT });
  }
  if (!runs.some(r => /RUN/.test(r.lines.map(l => l.text).join(' ')))) return null;
  // runs run from the newest month backwards: a year that disagrees with both neighbours is a misread
  runs.forEach((ru, i) => { const p = runs[i - 1], n = runs[i + 1]; if (!ru.month || !p || !n || !p.month || !n.month) return; const y = ru.month.slice(-2), py = p.month.slice(-2), ny = n.month.slice(-2);
    if (py === ny && y !== py) { ru.month = ru.month.slice(0, -2) + py; ru.text = `${ru.month}/${ru.id}`; ru.doubt = true; } });
  const t = { kind: 'oms', box: [tb.cols[0].x0, y0, tb.cols[tb.cols.length - 1].x1, tb.rows[tb.rows.length - 1].y1], runs, rows: [], problems: [] };
  for (const row of tb.rows) {
    if (row.partial) continue;
    const r = { cells: {}, box: [tb.cols[0].x0, row.y0, tb.cols[tb.cols.length - 1].x1, row.y1] };
    r.cells.sr = cell(T, G, row, tb.cols[sr], AL.int); r.cells.km = cell(T, G, row, tb.cols[sr + 1], AL.int);
    if (!nz(r.cells.sr.text) && !nz(r.cells.km.text)) continue;
    for (const k of ['sr', 'km']) r.cells[k].text = nz(r.cells[k].text);
    for (let i = 0; i < nRuns; i++) {
      const v = cell(T, G, row, tb.cols[sr + 3 + i * 3], AL.int), l = cell(T, G, row, tb.cols[sr + 4 + i * 3], AL.int);
      v.text = nz(v.text); l.text = nz(l.text); r.cells['v' + i] = v; r.cells['l' + i] = l;
    }
    const f = { sr: isInt, km: isInt }; for (let i = 0; i < nRuns; i++) { f['v' + i] = v => !v || isInt(v); f['l' + i] = v => !v || isInt(v); }
    check(r, f);
    t.rows.push(r);
  }
  t.cols = { sr, nRuns }; return t;
}
function parseRun(s) {
  const t = String(s).toUpperCase().replace(/\s+/g, ' ').trim().replace(/^.*?RUN\s*\d+\s*[:.]?\s*/, '');
  // "MON-YY/ID": anchor on "YY/" – the month letters are before it, the run id after it
  const m = /^([^0-9]*?)[-:.]?\s*([0-9.:]{1,2})\s*\/\s*([0-9A-Z][0-9A-Z_:.\- ]*)$/.exec(t);
  if (!m) return { text: t, ok: false };
  let id = m[3].replace(/\s+/g, '').replace(/[^0-9A-Z]+$/, ''), fixed = false;
  const d = /^(\d{4})[-:.]?(\d\d)[-:.]?(\d\d)[_:.-]?(\d+)$/.exec(id); if (d) { const nid = `${d[1]}-${d[2]}-${d[3]}_${d[4]}`; fixed = nid !== id; id = nid; }
  let mon = m[1].replace(/[^A-Z]/g, ''), yy = m[2];
  if (!MONTHS.includes(mon)) {
    // a dated run id carries the month itself; otherwise the closest month name (one letter may be wrong or missing)
    const near = MONTHS.filter(x => lev1(x, mon));
    if (d && +d[2] >= 1 && +d[2] <= 12) mon = MONTHS[+d[2] - 1]; else if (near.length === 1) mon = near[0];
    fixed = true;
  }
  if (!/^\d\d$/.test(yy)) { if (d) yy = d[1].slice(2); fixed = true; }
  const month = `${mon}-${yy}`;
  const ok = MONTHS.includes(mon) && /^\d\d$/.test(yy) && (/^\d{4}-\d\d-\d\d_\d+$/.test(id) || /^\d{1,5}[A-Z]?$/.test(id)) && (!d || (MONTHS.indexOf(mon) + 1 === +d[2] && d[1].slice(2) === yy));
  return { text: `${month}/${id}`, month, id, ok, fixed };
}
// true when a and b differ by at most one letter (changed, missing or extra)
function lev1(a, b) {
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, e = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++e > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } }
  return e + (a.length - i) + (b.length - j) <= 1;
}
function fixText(type, s) {
  s = nz(s);
  if (type === 'num') s = s.replace(/\.{2,}/g, '.').replace(/^\./, '').replace(/\.$/, '');
  if (type === 'date') s = s.replace(/\/{2,}/g, '/');
  if (type === 'status') s = s.replace(/^(SR|TR)(?=IMR)/, '$1 ');
  return s;
}
function check(r, f) {
  r.doubt = 0;
  for (const [k, c] of Object.entries(r.cells)) { c.bad = !!(f[k] && !f[k](c.text)); c.doubt = c.bad || c.worst > DOUBT; if (c.doubt) r.doubt++; }
}

// ---------- checks across screenshots ----------
// The same TMS row read on two overlapping screenshots must agree; Sr.No. runs on by one; IMR rows are in km order.
// Any disagreement makes the values doubtful, so a misread that still looks valid is shown to the admin.
function crossCheck(results) {
  const seen = new Map();
  for (const r of results) for (const t of r.tables) {
    const sig = t.kind + ':' + (t.kind === 'imr' ? t.cols.status + '/' + t.cols.removed : t.runs.map(x => x.text).join(','));
    let prev = null;
    for (const row of t.rows) {
      const c = row.cells; const sr = +c.sr.text;
      if (prev && c.sr.text && prev.cells.sr.text && sr !== +prev.cells.sr.text + 1) mark(row, 'sr', 'Sr.No. does not follow the row above');
      if (t.kind === 'imr' && prev && /^\d+$/.test(c.km.text) && /^\d+$/.test(prev.cells.km.text) && +c.km.text < +prev.cells.km.text) { mark(row, 'km', 'km smaller than the row above'); mark(prev, 'km', 'km larger than the row below'); }
      if (c.sr.text) { const k = sig + '|' + c.sr.text, o = seen.get(k);
        // a true overlap agrees on nearly every value; a row of another TMS page with the same Sr.No. agrees on few
        if (o) { const fs = Object.keys(c).filter(f => f !== 'sr' && o.cells[f]); const same = fs.filter(f => o.cells[f].text === c[f].text).length;
          if (same < fs.length && same >= fs.length - 2 && same >= 2) for (const f of fs) if (o.cells[f].text !== c[f].text) { mark(row, f, 'read differently on another screenshot'); mark(o, f, 'read differently on another screenshot'); } }
        else seen.set(k, row); }
      prev = row;
    }
  }
  return results;
}
function mark(row, f, why) { const c = row.cells[f]; if (!c || c.doubt) return; c.doubt = true; c.why = why; row.doubt = (row.doubt || 0) + 1; }

// ---------- records ----------
// shot tables + admin choices → records for the server; values the admin corrected are in cell.text already
function imrRecords(shots, section, line) {
  const recs = [], seen = new Set();
  for (const sh of shots) for (const t of sh.tables) if (t.kind === 'imr') for (const r of t.rows) {
    const c = r.cells; const rec = { section, line, km: +c.km.text, m: +c.m.text, rail: c.rail.text, status: c.status.text, tested: isoOf(c.tested.text), removed: isoOf(c.removed.text) };
    if (!rec.tested || !isInt(c.km.text)) continue;
    rec.days = rec.tested && rec.removed ? Math.round((Date.parse(rec.removed) - Date.parse(rec.tested)) / 864e5) : null;
    rec.key = ['IMR', rec.section, rec.line, rec.km, rec.m, rec.rail, rec.tested].join('|');
    if (!seen.has(rec.key)) { seen.add(rec.key); recs.push(rec); }
  }
  return recs;
}
function omsRecords(shots, section, line) {
  const recs = [], seen = new Map(), runs = [];
  for (const sh of shots) for (const t of sh.tables) if (t.kind === 'oms') {
    t.runs.forEach(ru => { if (!runs.some(x => x.id === ru.id && x.month === ru.month)) runs.push({ month: ru.month, id: ru.id }); });
    for (const r of t.rows) {
      const km = +r.cells.km.text; if (!isInt(r.cells.km.text)) continue;
      t.runs.forEach((ru, i) => { const v = +r.cells['v' + i].text || 0, l = +r.cells['l' + i].text || 0; if (!v && !l) return;
        const k = [km, ru.id || ru.month].join('|'); if (seen.has(k)) return;
        const rec = { section, line, km, run: ru.id || ru.month, runMonth: ru.month, runIdx: ru.idx, vertical: v, lateral: l }; seen.set(k, rec); recs.push(rec); });
    }
  }
  return { records: recs, runs };
}

// ---------- learning from corrections ----------
// text = the value the admin confirmed for this cell; adds glyph variants so the same misread does not happen again
function learn(T, G, line, text) {
  const [top, bot, x0, x1, bg] = line; const al = alignLine(T, G, top, bot, x0, x1, bg, text, 0.12); if (!al || al.cost > 0.06) return [];
  const added = [];
  for (const [ch, a, b] of al.segs) { const q = glyph(G, top, a, b, bg, al.scale); if (T.add(ch, q, b - a)) added.push({ ch, w: b - a, q: Array.from(q) }); }
  return added;
}


return { DOUBT, imageFromRGBA, readShot, parseRun, crossCheck, imrRecords, omsRecords, learn, grey, ShotTemplates };
})();
__m['core.js'] = (function(){
// Public surface of the engine (used by UI and by workers).
const {makeEngine, ingest, readTRCPage, emptyStore} = __m['pipeline.js'];
const {analyse, dedupe, BANDS} = __m['analysis.js'];
const {buildWorkbook, jobKey} = __m['report.js'];
const {KINDS, classifySheet, parseSheet, classifyPdf, parsePdf} = __m['sources.js'];
const {lineDisplay, sectionCode, sectionName, lineKey} = __m['names.js'];
const {readXLS} = __m['xls.js'];
const {readXLSX} = __m['xlsx.js'];
const {pdfLines, pdfPages} = __m['pdftext.js'];
const {isRegister, parseRegister, FORM_NAME, formKind} = __m['registers.js'];
const {unzip} = __m['zip.js'];
const {classifyKpiSheet, parseKpiSheet, tablesFromPaste, classifyPaste, parsePaste, weldDigest} = __m['tmsreports.js'];
const {sigDistance} = __m['header.js'];
const {decodePNG} = __m['png.js'];
const {htmlTables, htmlText, trcPageFromTables, isTrcKmPage, usfdDefectsFromPage, usfdHistFromPage, atWeldsFromPage, rowsFromPage, pendingIMR, ogSumFromPage} = __m['tmshtml.js'];
const {dpcFromPage, isDpcPage, DPC_NAME} = __m['dpc.js'];   // [E] 20-Oct: Defects Pending for Compliance (K10)
const {trcRepFromPage, isTrcRepPage, trcRepKind} = __m['trcrep.js'];   // [E] 21-Oct: repeated UML peaks / CBML blocks (K8 / K9)
const {readShot, crossCheck, imageFromRGBA, imrRecords, omsRecords, learn: learnShot, parseRun, ShotTemplates, grey: greyShot} = __m['shots.js'];

const CORE = { makeEngine, ingest, readTRCPage, emptyStore, analyse, dedupe, BANDS, buildWorkbook, jobKey, KINDS, classifySheet, parseSheet, classifyPdf, parsePdf, lineDisplay, sectionCode, sectionName, lineKey, readXLS, readXLSX, pdfLines, pdfPages, isRegister, parseRegister, FORM_NAME, formKind, unzip, classifyKpiSheet, parseKpiSheet, tablesFromPaste, classifyPaste, parsePaste, weldDigest, sigDistance, readShot, imageFromRGBA, imrRecords, omsRecords, learnShot, parseRun, ShotTemplates, greyShot, decodePNG, crossCheck, htmlTables, htmlText, trcPageFromTables, isTrcKmPage, usfdDefectsFromPage, usfdHistFromPage, atWeldsFromPage, rowsFromPage, pendingIMR, ogSumFromPage, dpcFromPage, isDpcPage, DPC_NAME, trcRepFromPage, isTrcRepPage, trcRepKind };

return { CORE };
})();
self.CORE = __m["core.js"].CORE;
