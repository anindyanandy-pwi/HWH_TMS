// TMS Control – admin tools: upload TMS reports, users, settings. Loaded only for the admin.
(function () {
'use strict';
const T = window.TMSC, V = window.TMSC_VIEWS; const { call, esc, dmy, modal, toast, S, $, fail } = T;
const CORE_SRC = window.__tmscSrc('core');
new Function(CORE_SRC)();
const C = self.CORE;
const MODELS = JSON.parse(window.__tmscSrc('models'));
const MODEL_VER = 'm' + MODELS.body.length + '.' + MODELS.info.length + '.' + MODELS.titles.length + '.' + MODELS.blue.length + '.v3';
let engine = C.makeEngine(MODELS); try { engine.customTitles = JSON.parse(localStorage.getItem('trc.customTitles') || '[]'); } catch (e) { engine.customTitles = []; }
// ---------- OCR cache (IndexedDB) ----------
const DB = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res) => { try { const r = indexedDB.open('trc-analyzer', 1); r.onupgradeneeded = () => r.result.createObjectStore('pages'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); } }));
  return {
    async get(k) { const db = await open(); if (!db) return null; return new Promise(res => { try { const q = db.transaction('pages').objectStore('pages').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); } }); },
    async put(k, v) { const db = await open(); if (!db) return; try { db.transaction('pages', 'readwrite').objectStore('pages').put(v, k); } catch (e) {} },
  };
})();

// ---------- worker pool ----------
function makePool() {
  const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1));
  const src = CORE_SRC + `\nlet E=null;self.onmessage=async e=>{const d=e.data;if(d.models){E=self.CORE.makeEngine(d.models);E.customTitles=d.custom||[];return;}if(d.custom){E.customTitles=d.custom;return;}try{const p=await self.CORE.readTRCPage(E,{name:d.name,size:d.size,buf:d.buf});postMessage({id:d.id,p});}catch(err){postMessage({id:d.id,err:String(err&&err.message||err)});}};`;
  let url, workers = [];
  try { url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); for (let i = 0; i < n; i++) { const w = new Worker(url); w.postMessage({ models: MODELS, custom: engine.customTitles }); workers.push(w); } }
  catch (e) { workers = []; }
  return workers;
}

async function readPages(pngs, onProg) {
  const results = new Array(pngs.length); let done = 0;
  const todo = [];
  for (let i = 0; i < pngs.length; i++) {
    const f = pngs[i]; const key = MODEL_VER + '|' + f.name + '|' + f.size + '|' + (f.lastModified || 0);
    const c = await DB.get(key);
    if (c) { results[i] = c; done++; } else todo.push({ i, f, key });
  }
  onProg(done, pngs.length);
  let workers = todo.length > 3 ? makePool() : [];
  const runMain = async (job) => { const buf = await job.f.arrayBuffer(); return C.readTRCPage(engine, { name: job.f.name, size: job.f.size, buf }); };
  if (!workers.length) {
    for (const job of todo) { try { results[job.i] = await runMain(job); DB.put(job.key, results[job.i]); } catch (e) { results[job.i] = errPage(job.f, e); } onProg(++done, pngs.length); }
    return results;
  }
  await new Promise((resolve) => {
    let next = 0, active = 0, failed = false;
    const pending = new Map();
    const feed = async (w) => {
      if (next >= todo.length) { if (active === 0) resolve(); return; }
      const job = todo[next++]; active++;
      const buf = await job.f.arrayBuffer();
      pending.set(job.i, job); w.postMessage({ id: job.i, name: job.f.name, size: job.f.size, buf }, [buf]);
    };
    for (const w of workers) {
      w.onmessage = e => { const { id, p, err } = e.data; const job = pending.get(id); pending.delete(id); active--;
        results[id] = p || errPage(job.f, err); if (p) DB.put(job.key, p); onProg(++done, pngs.length); feed(w); };
      w.onerror = async ev => { ev.preventDefault(); if (failed) return; failed = true; workers.forEach(x => x.terminate()); // fall back to main thread
        const rest = todo.filter(j => results[j.i] == null);
        for (const job of rest) { try { results[job.i] = await runMain(job); DB.put(job.key, results[job.i]); } catch (e2) { results[job.i] = errPage(job.f, e2); } onProg(++done, pngs.length); }
        resolve(); };
      feed(w);
    }
  });
  workers.forEach(w => w.terminate());
  return results;
}
const errPage = (f, e) => ({ file: f.name, blocks: [], dist: {}, peaks: {}, uml: [], problems: ['Could not read: ' + (e && e.message || e)], section: null, line: null });


// ---------- upload view ----------
const U = { files: [], log: [], running: false, dfwrDivision: true };
const GEO_NAME = { curve: 'Curve register', pxing: 'P&C register', lc: 'LC register', sej: 'SEJ register', glued: 'Glued joint register', diamond: 'Diamond crossing register', bridge: 'Bridge register' };
const KIND_NAME = { omsPeak: 'OMS peak locations above 0.15 g (km/m)', 'geo-curve': 'Curve register (worksite tagging)', 'geo-pxing': 'P&C register (worksite tagging)', 'geo-lc': 'LC register (worksite tagging)', 'geo-sej': 'SEJ register (worksite tagging)', 'geo-glued': 'Glued joint register (worksite tagging)', 'geo-diamond': 'Diamond crossing register (worksite tagging)', 'geo-bridge': 'Bridge register (worksite tagging)', jog: 'Welds needing joggled plates', weldSum: 'AT weld count', fpSum: 'Main-line FP joint count', inspections: 'Inspection register', assetInsp: 'Latest inspection report', lna: 'Locations needing attention', dfwr: 'DFWR analysis', og: 'Overdue oiling & greasing', fracture: 'Fracture analysis', official: 'TMS item-wise score', jurisdiction: 'Jurisdiction details', oms: 'OMS comparative summary', imr: 'IMR testing history', weldReg: 'Weld register', fpReg: 'Fish-plated joint register (joint count for K15)', trc: 'TRC km-wise pages', usfd: 'USFD rail / weld defects', atWelds: 'AT welds done / defective', usfdHist: 'USFD testing history', weldMonths: 'AT welds done / tested per month (K12)', untested: 'New AT welds not yet tested' };
V.upload = async el => {
  el.innerHTML = T.pageHead('Upload TMS data', 'Admin – every upload is added to the history; nothing older is overwritten') + `<div class="grid2">
    <div><div id="drop" class="drop" tabindex="0"><svg class="dropsvg" viewBox="0 0 48 48"><path d="M6 14h14l4 4h18v22H6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 36V24m-5 5l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      <div class="droptitle">Click <b>Select files</b> and pick the reports</div><div class="dropsub">TMS PDFs, XLS / XLSX reports, TRC km-wise PNG pages, or a ZIP of them. In the file window you can select many files at once (Ctrl+A or Ctrl+click).</div>
      <div class="btnrow"><button id="pkFiles" class="btn primary">Select files</button><button id="pkFolder" class="btn secondary">Select a whole folder</button></div>
      <div class="dropsub small" style="margin-top:10px">Dragging files onto this box also works in Chrome and Edge. If a dragged file opens in a new tab instead, use the buttons.</div>
      <input id="inFolder" type="file" webkitdirectory multiple hidden><input id="inFiles" type="file" multiple hidden accept=".png,.jpg,.jpeg,.xls,.xlsx,.pdf,.zip,.json"></div>

      <div class="panel" style="margin-top:16px"><div class="panelhead"><span>Screenshots of TMS pages</span><span class="muted">IMR testing history, OMS peaks km-wise comparative summary</span></div>
      <div style="padding:12px"><div id="shotPaste" class="pastebox" tabindex="0">Open the TMS page at normal zoom (100%) → press <b>Windows key + Shift + S</b> and drag over the table (include the column headings) → click here → press <b>Ctrl+V</b>.<br><span class="small">Scroll and repeat until every row is captured; rows seen twice are counted once. Saved screenshots (many at once): <button id="pkShots" class="btn ghost sm">Select screenshot files</button> <button id="pkShotDir" class="btn ghost sm">Select a folder of screenshots</button></span></div>
      <input id="inShots" type="file" multiple hidden accept=".png,.jpg,.jpeg"><input id="inShotDir" type="file" webkitdirectory multiple hidden><div id="shotList" style="margin-top:10px"></div></div></div>
      <div class="panel"><div class="panelhead"><span>Ready to upload</span><span class="right"><label class="small"><input type="checkbox" id="dfwrDiv" ${U.dfwrDivision ? 'checked' : ''}> DFWR file covers the whole division</label></span></div><div id="queue" style="padding:10px 14px"></div>
      <div style="padding:0 14px 14px" class="row"><button id="btnGo" class="btn primary">Upload and recalculate</button><button id="btnClr" class="btn secondary">Clear</button></div></div>
      <div class="plog" id="plog">${esc(U.log.join('\n')) || 'Progress will appear here.'}</div></div>
    <div><div class="panel body"><h3 class="sec">Upload checklist</h3><div id="chk"><div class="empty">Loading…</div></div></div></div></div>`;
  wireDrop(); wireShots(); drawQueue();
  try { const st = await call('dataStatus'); $('chk').innerHTML = `<div class="scroll"><table class="t"><thead><tr><th>Report</th><th>How often</th><th>Last upload</th><th>Records</th></tr></thead><tbody>${st.map(r => `<tr><td class="wrap">${esc(r.what)}</td><td class="nw small">${esc(r.when)}</td><td class="nw">${r.last ? dmy(r.last) + `<div class="small">as on ${dmy(r.asOn)}</div>` : '<span class="od">never</span>'}</td><td class="n">${r.records ?? ''}</td></tr>`).join('')}</tbody></table></div>`; } catch (e) { fail(e); }
};
function plog(m) { U.log.push(m); const p = $('plog'); if (p) { p.textContent = U.log.join('\n'); p.scrollTop = p.scrollHeight; } }
function drawQueue() {
  const q = $('queue'); if (!q) return;
  const png = U.files.filter(f => /\.png$/i.test(f.name)).length, docs = U.files.filter(f => !/\.png$/i.test(f.name));
  const sh = SH.list.filter(x => x.status === 'done'), un = sh.filter(x => !x.checked).length;
  const web = W.sets.length + W.pages.length + W.usfd.length;
  if (!U.files.length && !sh.length && !web) { q.innerHTML = '<div class="muted">Nothing selected yet.</div>'; return; }
  const bad = docs.filter(f => f.__info && !f.__info.ok && !f.__info.unused).length;
  // every report file is opened on this computer as soon as it is picked, so it is clear what will be taken from it before anything is uploaded
  q.innerHTML = `<div>${docs.length} report file(s), ${png} TRC page(s)${sh.length ? `, ${sh.length} screenshot(s)${un ? ` – <span class="od">${un} not checked yet</span>` : ' – checked'}` : ''}${bad ? ` · <span class="od">${bad} file(s) not recognised – they will be skipped</span>` : ''}</div>
    ${web ? webQueueHtml() : ''}${docs.length ? `<table class="t fileq"><tbody>${docs.map(f => `<tr class="${f.__info && !f.__info.ok && !f.__info.unused ? 'dbt' : ''}"><td class="small wrap">${esc(f.name)}</td><td class="small wrap">${f.__info ? f.__info.lines.map(l => esc(l)).join('<br>') : '<span class="muted">opening…</span>'}</td></tr>`).join('')}</tbody></table>` : ''}`;
}
// what the upload will take from one report file (read here, nothing is sent)
async function inspectFile(f) {
  const ext = f.name.split('.').pop().toLowerCase(), lines = []; let ok = false;
  try {
    const buf = await f.arrayBuffer();
    if (ext === 'pdf') {
      if (f.size > 15e6) { lines.push('Very large PDF – will be skipped'); }
      else { const pages = await C.pdfPages(buf); if (C.isRegister(pages)) { const R = C.parseRegister(pages); ok = R.length > 0; lines.push(regText(pages, R)); }
        else { const k = C.classifyPdf(await C.pdfLines(buf)); ok = !!k; lines.push(k ? (C.KINDS[k] || k) + ' – used for the TRC analysis' : 'Not a TMS report this program knows'); } }
    } else {
      const wb = ext === 'xls' ? C.readXLS(buf) : await C.readXLSX(buf);
      for (const sh of wb.sheets) {
        const tag = wb.sheets.length > 1 ? `[${sh.name}] ` : '';
        const k = C.classifyKpiSheet(sh.rows, sh.name);
        if (k === 'jurisdiction') { ok = true; lines.push(tag + `Jurisdiction details – ${sh.rows.length - 1} rows`); continue; }
        if (k) { const r = C.parseKpiSheet(k, sh.rows, sh.name); ok = ok || r.records.length > 0; lines.push(tag + `${KIND_NAME[k] || k} – ${r.records.length} rows${r.records.length ? '' : ' (no rows found – check the file)'}`); if (k !== 'weldReg' && k !== 'fpReg') continue; }
        const g = C.classifySheet(sh.rows, sh.name);
        if (g && !(k && (k === 'weldReg' || k === 'fpReg') && !GEO_NAME[g])) {
          const recs = C.parseSheet(g, sh.rows); const secs = new Set(recs.map(r => r.section).filter(Boolean));
          if (!k) { ok = ok || recs.length > 0; lines.push(tag + `${GEO_NAME[g] ? GEO_NAME[g] + ' (worksite tagging)' : C.KINDS[g] || g} – ${recs.length} rows, ${secs.size} section(s)${recs.length ? '' : ' (no rows found – check the file)'}`); }
        }
        if (!k && !g) lines.push(tag + 'Not a TMS report this program knows – will be skipped');
      }
    }
  } catch (e) { lines.push('Could not open: ' + (e.message || e)); }
  f.__info = { ok, lines }; drawQueue();
}
// e.g. "Curve inspection register – 203 inspections"; a blank form says so
function regText(pages, R) {
  const fk = C.formKind(pages); const types = [...new Set(R.map(r => r.type))];
  const nm = types.length ? types.map(t => C.FORM_NAME[t] || { FP: 'Foot plate', RV: 'Rear vehicle', FOOT: 'On foot', TROLLEY: 'Trolley' }[t] || t).join(' + ') : (C.FORM_NAME[fk] || 'Inspection');
  return R.length ? `${nm} register – ${R.length} inspection(s)` : `${nm} – no filled-in inspections in this file (blank form?) – will be skipped`;
}
// a ZIP is opened here and the reports inside are added one by one
async function fromZip(f) {
  try { const z = await C.unzip(await f.arrayBuffer()); const out = [];
    for (const n of z.names) { if (/\/$/.test(n) || /(^|\/)(__MACOSX|~\$)/.test(n) || !/\.(png|jpe?g|xls|xlsx|pdf)$/i.test(n)) continue; const b = await z.bytes(n); out.push(new File([b], n.split('/').pop(), { type: '' })); }
    if (!out.length) toast(f.name + ': no reports inside the ZIP', true); return out;
  } catch (e) { toast(f.name + ': could not open the ZIP – ' + (e.message || e), true); return []; }
}
async function addFilesZ(list) {
  const flat = [];
  for (const f of list) {
    if (/\.zip$/i.test(f.name)) flat.push(...await fromZip(f));
    else if (/\.json$/i.test(f.name)) { try { const b = JSON.parse(await f.text()); if (b && b.format === 'tmsc-bundle' && Array.isArray(b.items)) { const items = b.items.map(it => { if (it.b64) { const bin = atob(it.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return Object.assign({}, it, { b64: undefined, bytes: u.buffer }); } return it; }); await addCollected(items); toast(`${f.name}: ${items.length} page(s) from the TMS Collector added`); } else toast(f.name + ': not a TMS Collector file', true); } catch (e) { toast(f.name + ': could not read – ' + e.message, true); } }
    else flat.push(f);
  }
  addFiles(flat);
}
function addFiles(list) {
  const have = new Set(U.files.map(f => f.name + '|' + f.size)); const jpg = [];
  for (const f of list) { if (/\.jpe?g$/i.test(f.name)) { jpg.push(f); continue; } if (/\.(png|xls|xlsx|pdf)$/i.test(f.name) && !/^~\$/.test(f.name) && !have.has(f.name + '|' + f.size)) U.files.push(f); }
  if (jpg.length) addShots(jpg);   // JPG pictures are screenshots, never TRC pages
  drawQueue();
  (async () => { for (const f of U.files) if (!/\.png$/i.test(f.name) && !f.__info) await inspectFile(f); })();
}
function wireDrop() {
  $('pkFolder').onclick = e => { e.stopPropagation(); $('inFolder').click(); }; $('pkFiles').onclick = e => { e.stopPropagation(); $('inFiles').click(); };
  $('drop').onclick = e => { if (!e.target.closest('button,input')) $('inFiles').click(); }; $('drop').style.cursor = 'pointer';
  const picked = async e => { const n = U.files.length; const L = [...e.target.files]; e.target.value = ''; await addFilesZ(L); const a = U.files.length - n; toast(a ? `${a} file(s) added. Click "Upload and recalculate".` : 'No new PDF / XLS / XLSX / PNG / ZIP files in that selection.', !a); };
  $('inFolder').onchange = picked; $('inFiles').onchange = picked;
  $('btnClr').onclick = () => { U.files = []; U.log = []; SH.list.forEach(x => URL.revokeObjectURL(x.url)); SH.list = []; drawShots(); $('plog').textContent = 'Progress will appear here.'; };
  $('btnGo').onclick = () => runUpload();
  $('dfwrDiv').onchange = e => U.dfwrDivision = e.target.checked;
}
let dragDepth = 0;
const isFileDrag = e => { const t = e.dataTransfer && e.dataTransfer.types; return !!t && [...t].some(x => x === 'Files' || x === 'application/x-moz-file'); };
document.addEventListener('dragenter', e => { if (!isFileDrag(e)) return; dragDepth++; $('dropveil').classList.remove('hidden'); });
document.addEventListener('dragleave', e => { if (!isFileDrag(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropveil').classList.add('hidden'); });
// Called by the page guard (Index) for a drop anywhere on the page, on any screen.
window.TMSC_DROP = async dt => {
  dragDepth = 0; $('dropveil').classList.add('hidden');
  const p = filesFromDrop(dt); // reads the drop list at once – the browser empties it after the event
  const r = await p; const before = U.files.length;
  if (r.files.length) await addFilesZ(r.files);
  else if (r.blocked) { modal('<h3>Folder could not be read</h3><p>The browser did not allow this page to open the dropped folder. Open the folder, select the files inside (Ctrl+A) and drag those, or use <b>Select files</b>.</p>'); return; }
  const added = U.files.length - before;
  if (S.view !== 'upload' && S.B && S.jobs) { S.view = 'upload'; T.render(); }
  if (added) toast(`${added} file(s) added. Check the list, then click "Upload and recalculate".`);
  else if (r.files.length) toast('These files are already in the list, or are not PDF / XLS / XLSX / PNG files.', true);
};
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].filter(i => i.kind === 'file'); const plain = [...(dt.files || [])];
  if (!items.length) return { files: plain };
  const handles = items.map(i => { try { return i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : null; } catch (e) { return null; } });
  const entries = items.map(i => { try { return i.webkitGetAsEntry ? i.webkitGetAsEntry() : null; } catch (e) { return null; } });
  const asFiles = items.map(i => { try { return i.getAsFile(); } catch (e) { return null; } });
  const out = []; let blocked = false;
  const walkHandle = async h => { for await (const ch of h.values()) { if (ch.kind === 'file') out.push(await ch.getFile()); else await walkHandle(ch); } };
  const walkEntry = async en => { if (en.isFile) { out.push(await new Promise((res, rej) => en.file(res, rej))); return; } const rd = en.createReader(); let b; do { b = await new Promise((res, rej) => rd.readEntries(res, rej)); for (const x of b) await walkEntry(x); } while (b.length); };
  for (let k = 0; k < items.length; k++) {
    const en = entries[k]; if (!(en && en.isDirectory)) { if (asFiles[k]) out.push(asFiles[k]); continue; }
    const before = out.length; let ok = false;
    try { const h = handles[k] ? await handles[k] : null; if (h && h.kind === 'directory') { await walkHandle(h); ok = true; } } catch (e) { out.length = before; }
    if (!ok) { try { await walkEntry(en); ok = true; } catch (e) { out.length = before; } }
    if (!ok) blocked = true;
  }
  return { files: out, blocked: blocked && !out.length };
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
// Upload parts are safe to send twice (rows are matched by key), so a part that got no answer is sent again after a pause before giving up.
async function callR(fn, args, opt) {
  for (let i = 0; ; i++) {
    try { return await call(fn, args, opt); }
    catch (e) { if (!e || !e.offline || i >= 2) throw e; plog(`  (no answer from the server – trying again in ${i ? 30 : 10} s)`); await new Promise(r => setTimeout(r, i ? 30000 : 10000)); }
  }
}
const upid = () => 'UP' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
async function send(kind, payload, size = 1500) {
  const recs = payload.records || []; const id = upid(); const parts = recs.length ? chunk(recs, size) : [[]]; let tot = { inserted: 0, updated: 0, closed: 0 };
  for (let i = 0; i < parts.length; i++) { const r = await callR('ingest', Object.assign({}, payload, { kind, records: parts[i], uploadId: id, final: i === parts.length - 1, total: recs.length }), { timeout: 330000 }); for (const k in tot) tot[k] += r[k] || 0; }
  return tot;
}
async function runUpload() {
  if (U.running) return;
  const shots = SH.list.filter(x => x.status === 'done');
  if (SH.list.some(x => x.status === 'reading')) { toast('Screenshots are still being read – wait a moment', true); return; }
  const unchecked = shots.filter(x => !x.checked || !x.section || !x.line);
  if (unchecked.length) { toast(`${unchecked.length} screenshot(s) not checked yet. Click "Check" on each (or remove it with ✕), then upload.`, true); $('shotList').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (!U.files.length && !shots.length && !W.sets.length && !W.pages.length && !W.usfd.length) { toast('Select files first', true); return; }
  U.running = true; $('btnGo').disabled = true; U.log = []; const t0 = Date.now();
  try {
    const pngs = U.files.filter(f => /\.png$/i.test(f.name)); const docs = U.files.filter(f => !/\.png$/i.test(f.name));
    const out = { inspections: [], jurisdiction: null }; const trcFiles = []; const kpiSets = [];
    plog(`Reading ${docs.length} report file(s) on this computer…`);
    for (const f of docs) {
      const buf = await f.arrayBuffer(); const ext = f.name.split('.').pop().toLowerCase(); let used = false;
      try {
        if (ext === 'pdf') {
          if (f.size > 15e6) { plog(`  ${f.name}: very large PDF – skipped`); continue; }
          const pages = await C.pdfPages(buf);
          if (C.isRegister(pages)) { const R = C.parseRegister(pages); out.inspections.push(...R); plog(`  ${f.name}: ${regText(pages, R)}`); used = R.length > 0; }
        } else {
          const wb = ext === 'xls' ? C.readXLS(buf) : await C.readXLSX(buf);
          for (const sh of wb.sheets) {
            const k = C.classifyKpiSheet(sh.rows, sh.name); if (!k) continue; used = true;
            if (k === 'jurisdiction') { out.jurisdiction = sh.rows; plog(`  ${f.name}: jurisdiction details`); continue; }
            if (k === 'weldReg') { const w = C.parseKpiSheet(k, sh.rows, sh.name); const d = C.weldDigest(w.records); kpiSets.push({ kind: 'jog', records: d.pending, scope: w.scope, file: f.name }); kpiSets.push({ kind: 'weldSum', records: d.totals, scope: w.scope, file: f.name }); kpiSets.push({ kind: 'weldMonths', records: d.months, scope: w.scope, file: f.name }); kpiSets.push({ kind: 'untested', records: d.untested, scope: w.scope, file: f.name }); plog(`  ${f.name}: weld register – ${w.records.length} welds, ${d.needing} need joggled plates, ${d.pending.length} not joggled`); used = false; continue; }
            if (k === 'fpReg') { const r = C.parseKpiSheet(k, sh.rows, sh.name); r.file = f.name; kpiSets.push(r); plog(`  ${f.name}: FP joint register – main-line joints counted for K15`); used = false; continue; }
            const r = C.parseKpiSheet(k, sh.rows, sh.name); r.file = f.name; kpiSets.push(r); plog(`  ${f.name}${wb.sheets.length > 1 ? ' [' + sh.name + ']' : ''}: ${KIND_NAME[k]} – ${r.records.length} rows`);
          }
        }
      } catch (e) { plog(`  ${f.name}: could not read – ${e.message}`); continue; }
      if (!used) trcFiles.push({ name: f.name, size: f.size, buf });
    }
    for (const p of shotSets()) { if (p.records.length) kpiSets.push(p); else plog(`${KIND_NAME[p.kind]} (${p.scope.section} ${p.scope.line}): no rows with values`); }
    if (W.sets.length || W.usfd.length) { plog(`From the TMS Collector: ${W.sets.length} report(s)${W.usfd.length ? `, USFD defects of ${W.usfdLines.length} section-line(s)` : ''}${W.pages.length ? `, ${W.pages.length} TRC km page(s)` : ''}`); kpiSets.push(...W.sets.filter(x => x.records.length || x.kind === 'omsPeak')); }
    if (W.usfd.length) { kpiSets.push({ kind: 'usfd', records: W.usfd, scope: { lines: W.usfdLines }, file: 'USFD defects (TMS Collector)' }); const pend = C.pendingIMR(W.usfd); if (pend.length) kpiSets.push({ kind: 'imr', records: pend, scope: {}, file: 'IMRs still in track (TMS Collector)' }); }
    if (out.jurisdiction) { plog('Uploading jurisdiction…'); await call('ingest', { kind: 'jurisdiction', rows: out.jurisdiction, file: 'Jurisdiction Details' }); }
    if (out.inspections.length) { const seen = new Set(); const recs = out.inspections.filter(r => !seen.has(r.key) && seen.add(r.key)).map(r => Object.assign({}, r, { defects: undefined })); plog(`Uploading ${recs.length} inspections…`); const r = await send('inspections', { records: recs, file: 'Inspection registers' }, 400); plog(`  ${r.inserted} new inspection(s) added to the history`); }
    for (const s of kpiSets) {
      const scope = s.kind === 'dfwr' ? (U.dfwrDivision ? { division: true } : s.scope) : s.scope;
      const asOn = s.asOn || S.B.today;
      const r = await send(s.kind, { records: s.records, scope, asOn, file: s.file || KIND_NAME[s.kind] }, s.kind === 'assetInsp' || /Sum$/.test(s.kind) ? 2500 : 1500);
      plog(`${KIND_NAME[s.kind]}: ${r.inserted} new, ${r.updated} updated${r.closed ? ', ' + r.closed + ' closed (no longer in TMS)' : ''}`);
    }
    // asset registers: stored on the server so a worksite can be tagged with its curves, P&C, LC, SEJ… and the measuring points laid out
    const geo = {};
    for (const tf of trcFiles) {
      const ext = tf.name.split('.').pop().toLowerCase(); if (ext !== 'xls' && ext !== 'xlsx') continue;
      try { const wb = ext === 'xls' ? C.readXLS(tf.buf) : await C.readXLSX(tf.buf); for (const sh of wb.sheets) { const k = C.classifySheet(sh.rows, sh.name); if (!GEO_NAME[k]) continue; const recs = C.parseSheet(k, sh.rows); const g = geo[k] = geo[k] || { recs: [], files: [] }; g.recs.push(...recs); g.files.push(tf.name); } } catch (e) { /* not a register */ }
    }
    for (const [k, g] of Object.entries(geo)) {
      if (!g.recs.length) continue; const secs = [...new Set(g.recs.map(r => r.section).filter(Boolean))]; const parts = chunk(g.recs, 1500);
      for (let i = 0; i < parts.length; i++) { await callR('ingestGeometry', { kind: k, records: parts[i], sections: secs, append: i > 0, file: g.files.join(', ') }, { timeout: 330000 }); if (parts.length > 1) plog(`  ${GEO_NAME[k]}: part ${i + 1} of ${parts.length} stored`); }
      plog(`${GEO_NAME[k]}: ${g.recs.length} rows stored for worksite tagging (${secs.length} section(s))`);
    }
    if (pngs.length || W.pages.length) await runTRC(pngs, trcFiles, W.pages);
    plog('Recalculating KPIs and jobs…'); const rr = await call('refresh'); plog('Done: ' + Object.entries(rr).filter(([k]) => /^K|tracker/.test(k)).map(([k, v]) => `${k} ${typeof v === 'object' ? `+${v.inserted}/~${v.updated}/-${v.closed}` : v}`).join(' · '));
    plog(`Finished in ${Math.round((Date.now() - t0) / 1000)} s.`); toast('Upload complete'); collectDone(true); U.files = []; SH.list.filter(x => x.checked).forEach(x => URL.revokeObjectURL(x.url)); SH.list = SH.list.filter(x => !x.checked && x.status !== 'done'); drawShots(); drawQueue(); await T.reload();
  } catch (e) { plog('ERROR: ' + (e.error || e.message || e)); collectDone(false); fail(e); }
  U.running = false; const b = $('btnGo'); if (b) b.disabled = false;
}
// km list -> "2-44,46,50-52" (which km a line's latest data covers; jobs outside it are not closed by this run)
function kmRanges(kms) { const a = [...new Set(kms || [])].sort((x, y) => x - y); const out = []; for (let i = 0; i < a.length; i++) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(i === j ? '' + a[i] : a[i] + '-' + a[j]); i = j; } return out.join(','); }
async function runTRC(pngs, trcFiles, webPages = []) {
  if (pngs.length) plog(`Reading ${pngs.length} TRC page(s)… (pages read before are remembered)`);
  const store = await C.ingest(engine, trcFiles, () => {});
  const pages = pngs.length ? await readPages(pngs, (d, n) => { if (d % 25 === 0 || d === n) plog(`  TRC pages ${d} / ${n}`); }) : [];
  if (webPages.length) { plog(`  ${webPages.length} TRC km page(s) read from TMS as text (no screenshots)`); pages.push(...webPages); }
  for (const p of pages) store.pages.push(p);
  const notTrc = pages.filter(p => (p.problems || []).some(x => /Not a TMS km-wise result page/.test(x)));
  if (notTrc.length) { plog(`  ${notTrc.length} picture(s) are not TRC km-wise pages – moved to "Screenshots of TMS pages". Check them there and click Upload again.`); const names = new Set(notTrc.map(p => p.file)); addShots(pngs.filter(f => names.has(f.name))); }
  const bad = pages.filter(p => p.problems && p.problems.length && !notTrc.includes(p)); if (bad.length) plog(`  ${bad.length} page(s) need attention: ` + bad.slice(0, 5).map(p => p.file + ' (' + p.problems.join(', ') + ')').join('; '));
  const R = C.analyse(store);
  if (!R.lines.length) { plog('  No TRC lines found in the pages.'); return; }
  const lineOf = Object.fromEntries(R.lines.map(l => [l.lineId, l]));
  const lines = R.lines.map(l => ({ lineId: l.lineId, section: l.section, line: l.line, run: l.run, speed: l.speed, blocks: l.blocks, cbml: l.cbml, tmsN: l.tmsN, pml: l.pml, umlPeaks: l.umlPeaks, atRisk: l.atRisk, sensor: l.sensor || '', kms: kmRanges(l.kms) }));
  const blocks = R.blocks.map(b => ({ lineId: b.lineId, section: b.section, line: b.line, run: b.run, km: b.km, block: b.block, irpwm: b.irpwm, MI: b.MI, risk: b.risk, TQIC: b.TQIC }));
  const peaks = R.peaks.map(p => ({ lineId: p.lineId, section: p.section, line: p.line, run: p.run, km: p.km, pos: p.pos, param: p.param, value: p.value, status: p.status }));
  const todo = R.todo.map(t => { const l = lineOf[t.lineId] || {}; return Object.assign({}, t, { section: l.section, line: l.line, run: t.run || l.run }); });   // a km the latest run did not record keeps its earlier run
  plog(`  TRC: ${lines.length} line(s), ${blocks.length} blocks, ${todo.length} jobs – uploading…`);
  const id = upid(); const bc = chunk(blocks, 3000), pc = chunk(peaks, 3000);
  for (let i = 0; i < Math.max(bc.length, pc.length); i++) await call('ingestTRC', { uploadId: id, blocks: bc[i] || [], peaks: pc[i] || [], final: false });
  const r = await call('ingestTRC', { uploadId: id, lines, todo, final: true, file: pngs.length + ' TRC pages' });
  plog(`  TRC jobs: ${r.inserted} new, ${r.updated} updated, ${r.closed || 0} closed / verified by the new run`);
}

// ---------- screenshots of TMS pages (IMR testing history, OMS comparative summary) ----------
// Read on this computer, shown next to the picture for checking, and uploaded only after the admin confirms them.
const SH = { list: [], seq: 0, T: null, ready: null, workers: [], jobs: new Map(), queue: [] };
const SHOT_KIND = { imr: 'IMR testing history', oms: 'OMS comparative summary' };
function shotSetup() {
  if (SH.ready) return SH.ready;
  SH.ready = (async () => {
    let base = []; try { base = JSON.parse(window.__tmscSrc('shotmodel') || '[]'); } catch (e) {}
    let extra = []; try { extra = await call('ocrModel'); } catch (e) { /* offline: base set only */ }
    const all = base.concat(extra || []); SH.T = new C.ShotTemplates(all);
    try {
      const src = CORE_SRC + `\nlet T=null;self.onmessage=e=>{const d=e.data;if(d.templates){T=new self.CORE.ShotTemplates(d.templates);return;}if(d.add){for(const x of d.add)T.push(x.ch,Uint8Array.from(x.q),x.w);return;}try{const im={w:d.w,h:d.h,g3:new Uint16Array(d.buf)};postMessage({id:d.id,r:self.CORE.readShot(T,im,d.name)});}catch(err){postMessage({id:d.id,err:String(err&&err.message||err)});}};`;
      // several readers side by side, so a batch of screenshots is read quickly
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
      for (let i = 0; i < n; i++) { const w = new Worker(url); w.postMessage({ templates: all }); w.busy = false;
        w.onmessage = e => { w.busy = false; const j = SH.jobs.get(e.data.id); SH.jobs.delete(e.data.id); if (j) j(e.data); pumpShots(); }; SH.workers.push(w); }
    } catch (e) { SH.workers = []; }
    return SH.T;
  })();
  return SH.ready;
}
// PNG is decoded by the app itself (exact pixel values, as when the reader was trained); JPG by the browser
async function decodeImage(blob) {
  const buf = await blob.arrayBuffer(); const sig = new Uint8Array(buf, 0, 4);
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) { const im = await C.decodePNG(buf); return { w: im.w, h: im.h, g3: im.g3 }; }
  let bm; try { bm = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); } catch (e) { bm = await createImageBitmap(blob); }
  const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bm, 0, 0);
  return C.imageFromRGBA(c.width, c.height, x.getImageData(0, 0, c.width, c.height).data);
}
function readInWorker(sh, img) {
  if (!SH.workers.length) return Promise.resolve().then(() => ({ r: C.readShot(SH.T, img, sh.name) }));
  return new Promise(res => { SH.queue.push({ res, img, name: sh.name }); pumpShots(); });
}
function pumpShots() {
  for (const w of SH.workers) { if (w.busy || !SH.queue.length) continue; const q = SH.queue.shift(); const id = ++SH.seq; SH.jobs.set(id, q.res); w.busy = true; const buf = q.img.g3.slice().buffer; w.postMessage({ id, w: q.img.w, h: q.img.h, buf, name: q.name }, [buf]); }
}
const normName = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
function lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
function segSections() { return [...new Set((S.B.segments || []).map(s => s.section).filter(Boolean))].sort(); }
function segLines(sec) { const m = new Map(); for (const s of S.B.segments || []) if (s.section === sec && s.line && !m.has(s.line)) m.set(s.line, s.lineName || s.line); return [...m.entries()]; }
function suggestSection(txt) { const t = normName(txt); if (t.length < 4) return ''; let best = '', bd = 99; for (const s of segSections()) { const d = lev(t, normName(s)); if (d < bd) { bd = d; best = s; } } return bd <= Math.max(2, Math.round(t.length * 0.25)) ? best : ''; }
function suggestLine(sec, txt) {
  if (!sec || !txt) return ''; const L = segLines(sec); const k = C.lineKey(txt);
  const hit = L.find(([l, n]) => C.lineKey(l) === k || C.lineKey(n) === k); if (hit) return hit[0];
  const w = String(txt).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3); const near = L.filter(([l]) => lev(w, String(C.lineKey(l) || l).toUpperCase()) <= 1);   // a misread letter, e.g. UR for UP
  return near.length === 1 ? near[0][0] : '';
}
async function addShots(blobs) {
  await shotSetup(); if (!S.B.segments || !S.B.segments.length) toast('Upload the Jurisdiction Details first – sections and lines come from it.', true);
  const sorted = [...blobs].sort((x, y) => String(x.label || x.name).localeCompare(String(y.label || y.name), undefined, { numeric: true }));   // Windows names screenshots by time
  const added = sorted.map(b => { const sh = { id: 'S' + (++SH.seq), name: b.label || b.name || `Pasted screenshot ${SH.list.length + 1}`, blob: b, url: URL.createObjectURL(b), status: 'reading', r: null, section: '', line: '', checked: false }; SH.list.push(sh); return sh; });
  drawShots();
  await Promise.all(added.map(async sh => {
    try {
      const img = await decodeImage(sh.blob); sh.img = img;
      const res = await readInWorker(sh, img); if (res.err) throw new Error(res.err);
      sh.r = res.r; sh.status = sh.r.kind && sh.r.kind !== 'mixed' ? 'done' : 'unknown';
      sh.doubt = sh.r.tables.reduce((a, t) => a + t.rows.reduce((b, r) => b + r.doubt, 0) + (t.runs || []).filter(x => x.doubt).length, 0);
      sh.rows = sh.r.tables.reduce((a, t) => a + t.rows.length, 0);
    } catch (e) { sh.status = 'error'; sh.err = e.message || String(e); }
    drawShots();
  }));
  // section / line: from the page title when it can be read, else the same as the screenshot before it (IMR pages show the title only on top)
  for (const sh of added) {
    if (sh.status !== 'done') continue; const i = SH.list.indexOf(sh);
    const prev = SH.list.slice(0, i).filter(x => x.r && x.r.kind === sh.r.kind && x.section).pop();
    sh.section = suggestSection(sh.r.sectionText) || (prev ? prev.section : ''); sh.line = suggestLine(sh.section, sh.r.lineText) || (prev && prev.section === sh.section ? prev.line : '');
    sh.asOn = sh.r.printed || (prev ? prev.asOn : '') || S.B.today;
  }
  drawShots();
}
function drawShots() {
  const el = $('shotList'); if (!el) return;
  if (!SH.list.length) { el.innerHTML = '<div class="muted small">No screenshots yet.</div>'; drawQueue(); return; }
  const secs = segSections(); const todo = SH.list.filter(x => x.status === 'done' && !x.checked), reading = SH.list.filter(x => x.status === 'reading').length;
  const bar = `<div class="shotbatch"><div class="small"><b>${SH.list.length}</b> screenshot(s)${reading ? ` · <span class="muted">${reading} being read…</span>` : ''} · ${todo.length ? `<span class="od">${todo.length} to check</span>` : 'all checked'}</div>
    ${todo.length ? `<div class="shotctl"><span class="small muted">Set for all unchecked:</span><select id="bSec"><option value="">Section…</option>${secs.map(x => `<option>${esc(x)}</option>`).join('')}</select><select id="bLine"><option value="">Line…</option></select><button class="btn secondary sm" id="bApply">Apply to all</button>
      <button class="btn primary sm" id="bCheck"${reading ? ' disabled' : ''}>Check all (${todo.reduce((a, x) => a + (x.doubt || 0), 0)} doubtful value(s))</button></div>` : ''}</div>`;
  el.innerHTML = bar + SH.list.map(sh => {
    const st = sh.status === 'reading' ? '<span class="muted">reading…</span>' : sh.status === 'error' ? `<span class="od">could not read: ${esc(sh.err)}</span>` : sh.status === 'unknown' ? `<span class="od">${esc((sh.r.notes || [])[0] || 'Not an IMR history or OMS comparative summary page')}</span>` : `<b>${esc(SHOT_KIND[sh.r.kind])}</b> · ${sh.rows} rows`;
    const ok = sh.status === 'done';
    return `<div class="shotrow${ok && !sh.checked ? ' todo' : ''}" data-id="${sh.id}"><div class="shotname"><span class="small">${esc(sh.name)}</span> <span class="small">${st}</span>
        <span class="right">${ok ? (sh.checked ? '<span class="tag tg">Checked</span>' : sh.doubt ? `<span class="tag t1">${sh.doubt} doubtful</span>` : '<span class="tag">Not checked</span>') : ''}<button class="btn ghost sm" data-a="del" title="Remove from the list">✕</button></span></div>
      ${ok ? `<div class="shotctl"><select data-f="section"><option value="">Section…</option>${secs.map(s => `<option ${s === sh.section ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select data-f="line"><option value="">Line…</option>${segLines(sh.section).map(([l, n]) => `<option value="${esc(l)}" ${l === sh.line ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
        <button class="btn ${sh.checked ? 'ghost' : 'primary'} sm" data-a="check">${sh.checked ? 'Open' : 'Check against picture'}</button></div>` : ''}</div>`;
  }).join('');
  if ($('bSec')) {
    $('bSec').onchange = () => { $('bLine').innerHTML = '<option value="">Line…</option>' + segLines($('bSec').value).map(([l, n]) => `<option value="${esc(l)}">${esc(n)}</option>`).join(''); };
    $('bApply').onclick = () => { const sc = $('bSec').value, ln = $('bLine').value; if (!sc || !ln) { toast('Choose both section and line', true); return; } SH.list.filter(x => x.status === 'done' && !x.checked).forEach(x => { x.section = sc; x.line = ln; }); drawShots(); };
    $('bCheck').onclick = () => checkAll();
  }
  el.querySelectorAll('.shotrow').forEach(tr => {
    const sh = SH.list.find(x => x.id === tr.dataset.id);
    tr.querySelectorAll('select').forEach(s => s.onchange = () => { sh[s.dataset.f] = s.value; if (s.dataset.f === 'section') sh.line = ''; sh.checked = false; drawShots(); });
    const b = tr.querySelector('[data-a=check]'); if (b) b.onclick = () => checkShot(sh);
    tr.querySelector('[data-a=del]').onclick = () => { URL.revokeObjectURL(sh.url); SH.list = SH.list.filter(x => x !== sh); drawShots(); };
  });
  drawQueue();
}

// ---------- check one screenshot against its picture ----------
const IMR_F = [['sr', 'Sr.No.'], ['km', 'km'], ['m', 'm'], ['rail', 'LR/RR'], ['status', 'Status'], ['tested', 'Date of testing'], ['removed', 'Removed on']];
const VALID = { sr: v => /^\d{1,4}$/.test(v), km: v => /^\d{1,4}$/.test(v), m: v => /^\d{1,4}(\.\d{1,3})?$/.test(v) && +v <= 1200, rail: v => /^(LR|RR)$/.test(v), status: v => /^[A-Z ()]{3,12}$/.test(v) && /IMR/.test(v),
  tested: v => validDate(v), removed: v => !v || validDate(v), cnt: v => !v || /^\d{1,3}$/.test(v) };
function validDate(v) { const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(v); if (!m) return false; const d = new Date(+m[3], +m[2] - 1, +m[1]); return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 && +m[3] >= 1990 && d <= new Date(Date.now() + 864e5); }
function checkShot(sh) {
  const r = sh.r; let ov = $('shotChk'); if (!ov) { ov = document.createElement('div'); ov.id = 'shotChk'; ov.className = 'shotchk'; document.body.appendChild(ov); }
  const secs = segSections();
  // every value sits under its own piece of the picture, so it can be compared at a glance
  const crop = b => b ? `<canvas class="crop" data-box="${b.join(',')}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"></canvas>` : '';
  const cellIn = (ti, ri, k, c, f) => `<div class="pair">${crop(c.box)}<input class="sv${c.doubt ? ' bad' : ''}" data-t="${ti}" data-r="${ri}" data-k="${k}" data-f="${f}" value="${esc(c.text)}" spellcheck="false" autocomplete="off" style="width:${Math.max(44, c.box ? c.box[2] - c.box[0] : 60)}px"></div>`;
  let body = '';
  r.tables.forEach((t, ti) => {
    if (t.kind === 'imr') body += `<table class="t shotgrid"><thead><tr>${IMR_F.map(([, n]) => `<th>${n}</th>`).join('')}</tr></thead><tbody>${t.rows.map((row, ri) => `<tr class="${row.doubt ? 'dbt' : ''}">${IMR_F.map(([k]) => `<td>${cellIn(ti, ri, k, row.cells[k], k)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    if (t.kind === 'oms') {
      body += `<div class="runs">${t.runs.map((ru, i) => `<div class="pair run">${crop(ru.box)}<input class="sv${ru.doubt ? ' bad' : ''}" data-t="${ti}" data-run="${i}" value="${esc(ru.text)}" spellcheck="false" style="width:${ru.box[2] - ru.box[0]}px"></div>`).join('')}</div>`;
      body += `<table class="t shotgrid oms"><thead><tr><th>Sr</th><th>km</th>${t.runs.map(ru => `<th colspan="2">Run ${ru.idx}<div class="small">V · L</div></th>`).join('')}</tr></thead><tbody>${t.rows.map((row, ri) => `<tr class="${row.doubt ? 'dbt' : ''}"><td>${cellIn(ti, ri, 'sr', row.cells.sr, 'sr')}</td><td>${cellIn(ti, ri, 'km', row.cells.km, 'km')}</td>${t.runs.map((ru, i) => `<td>${cellIn(ti, ri, 'v' + i, row.cells['v' + i], 'cnt')}</td><td>${cellIn(ti, ri, 'l' + i, row.cells['l' + i], 'cnt')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    if (t.problems.length) body += `<div class="od small">${esc(t.problems.join('; '))} – this table was not read. Take the screenshot again with the whole table heading visible.</div>`;
  });
  ov.innerHTML = `<div class="shotbar"><b>${esc(sh.name)}</b> <span class="muted">${esc(SHOT_KIND[r.kind])}</span>
      <label>Section <select id="ckSec"><option value="">– choose –</option>${secs.map(s => `<option ${s === sh.section ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <label>Line <select id="ckLine"></select></label>${r.kind === 'oms' ? `<label>As on <input id="ckAsOn" type="date" value="${esc(sh.asOn || '')}"></label>` : ''}
      <span class="right"><button class="btn secondary" id="ckZoom">Picture 100%</button><button class="btn secondary" id="ckClose">Close</button><button class="btn primary" id="ckOk">Values agree with the picture – confirm</button></span></div>
    <div class="shotpic" id="ckPic"><canvas id="ckCv"></canvas></div>
    <div class="shothelp">Each value is shown under its piece of the screenshot. Compare them – above all the ones in <b class="od">red</b> – and correct a value if it differs. Dates as dd/mm/yyyy, cross rail LR or RR. Corrections teach the reader, so the same mistake does not come back.</div>
    <div class="shotvals">${body}</div>`;
  const fillLines = () => { $('ckLine').innerHTML = `<option value="">– choose –</option>` + segLines($('ckSec').value).map(([l, n]) => `<option value="${esc(l)}" ${l === sh.line ? 'selected' : ''}>${esc(n)}</option>`).join(''); };
  $('ckSec').onchange = () => { sh.line = ''; fillLines(); }; fillLines();
  // picture with all read cells framed; doubtful ones in red
  const cv = $('ckCv'), img = new Image(); let full = false, hi = null;
  const draw = () => {
    const pw = $('ckPic').clientWidth - 4, sc = full ? 1 : Math.min(1, pw / sh.img.w); cv.width = Math.round(sh.img.w * sc); cv.height = Math.round(sh.img.h * sc);
    const x = cv.getContext('2d'); x.drawImage(img, 0, 0, cv.width, cv.height); x.lineWidth = 1;
    r.tables.forEach(t => { t.rows.forEach(row => Object.values(row.cells).forEach(c => { if (!c.box || (!c.text && !c.doubt)) return; x.strokeStyle = c.doubt ? 'rgba(200,20,20,.9)' : 'rgba(20,120,60,.45)'; x.strokeRect(c.box[0] * sc + .5, c.box[1] * sc + .5, (c.box[2] - c.box[0]) * sc, (c.box[3] - c.box[1]) * sc); }));
      (t.runs || []).forEach(ru => { x.strokeStyle = ru.doubt ? 'rgba(200,20,20,.9)' : 'rgba(20,120,60,.45)'; x.strokeRect(ru.box[0] * sc + .5, ru.box[1] * sc + .5, (ru.box[2] - ru.box[0]) * sc, (ru.box[3] - ru.box[1]) * sc); }); });
    if (hi) { x.lineWidth = 3; x.strokeStyle = '#0a58ca'; x.strokeRect(hi[0] * sc - 2, hi[1] * sc - 2, (hi[2] - hi[0]) * sc + 4, (hi[3] - hi[1]) * sc + 4); const p = $('ckPic'); p.scrollTop = Math.max(0, hi[1] * sc - p.clientHeight / 2); p.scrollLeft = Math.max(0, hi[0] * sc - p.clientWidth / 2); }
  };
  img.onload = () => { draw(); ov.querySelectorAll('canvas.crop').forEach(c => { const [x0, y0, x1, y1] = c.dataset.box.split(',').map(Number); c.getContext('2d').drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0); }); }; img.src = sh.url;
  $('ckZoom').onclick = () => { full = !full; $('ckZoom').textContent = full ? 'Fit picture' : 'Picture 100%'; draw(); };
  ov.querySelectorAll('input.sv').forEach(inp => inp.onfocus = () => { const t = r.tables[+inp.dataset.t]; hi = inp.dataset.run != null ? t.runs[+inp.dataset.run].box : t.rows[+inp.dataset.r].cells[inp.dataset.k].box; draw(); });
  ov.querySelectorAll('input.sv').forEach(inp => inp.oninput = () => inp.classList.remove('bad'));
  const close = () => { ov.remove(); drawShots(); };
  $('ckClose').onclick = close;
  $('ckOk').onclick = async () => {
    const sec = $('ckSec').value, line = $('ckLine').value; if (!sec || !line) { toast('Choose the section and the line of this report', true); return; }
    const errs = []; const changed = [];
    ov.querySelectorAll('input.sv').forEach(inp => {
      const t = r.tables[+inp.dataset.t]; let v = inp.value.trim().toUpperCase().replace(/\s+/g, ' ');
      if (inp.dataset.run != null) { const ru = t.runs[+inp.dataset.run]; const p = C.parseRun(v); if (!p.ok) { errs.push(inp); return; } if (p.text !== ru.text) changed.push({ lines: ru.lines, text: v }); ru.text = p.text; ru.month = p.month; ru.id = p.id; ru.doubt = false; return; }
      if (inp.dataset.f !== 'status') v = v.replace(/\s+/g, ''); const c = t.rows[+inp.dataset.r].cells[inp.dataset.k];
      if (!VALID[inp.dataset.f](v)) { errs.push(inp); return; }
      if (v !== c.text && v) changed.push({ line: c.line, text: v }); c.text = v; c.doubt = false;
    });
    if (errs.length) { errs.forEach(i => i.classList.add('bad')); errs[0].focus(); toast(`${errs.length} value(s) are not in the right form – see the red boxes`, true); return; }
    r.tables.forEach(t => t.rows.forEach(row => row.doubt = 0));
    sh.section = sec; sh.line = line; if ($('ckAsOn')) sh.asOn = $('ckAsOn').value || S.B.today; sh.checked = true; sh.doubt = 0;
    close(); if (changed.length) learnFrom(sh, changed);
  };
}
// ---------- check a whole batch: only the doubtful values, each under its piece of its screenshot ----------
const fieldOf = k => /^[vl]\d+$/.test(k) ? 'cnt' : k;
const LABEL = { sr: 'Sr.No.', km: 'km', m: 'm', rail: 'LR/RR', status: 'Status', tested: 'Date of testing', removed: 'Removed on' };
// the same row seen in two screenshots must read the same; where it does not, both are marked doubtful
function crossCheck(shots) { C.crossCheck(shots.map(x => x.r)); }
function checkAll() {
  const shots = SH.list.filter(x => x.status === 'done' && !x.checked);
  if (!shots.length) return;
  const noLine = shots.filter(x => !x.section || !x.line);
  if (noLine.length) { toast(`${noLine.length} screenshot(s) have no section / line yet – use "Set for all unchecked" or the boxes on each screenshot`, true); return; }
  crossCheck(SH.list.filter(x => x.status === 'done'));
  let ov = $('shotChk'); if (!ov) { ov = document.createElement('div'); ov.id = 'shotChk'; ov.className = 'shotchk'; document.body.appendChild(ov); }
  const items = []; let clean = 0;
  shots.forEach((sh, si) => sh.r.tables.forEach((t, ti) => {
    (t.runs || []).forEach((ru, i) => { if (ru.doubt) items.push({ si, ti, run: i, box: ru.box, text: ru.text, label: `RUN ${ru.idx} heading` }); });
    t.rows.forEach((row, ri) => Object.entries(row.cells).forEach(([k, c]) => {
      const bad = !VALID[fieldOf(k)](c.text);
      if (c.doubt || bad) items.push({ si, ti, ri, k, box: c.box, text: c.text, label: `${t.kind === 'oms' && /^[vl]/.test(k) ? `Run ${+k.slice(1) + 1} ${k[0] === 'v' ? 'vertical' : 'lateral'}` : LABEL[k] || k} · Sr ${row.cells.sr ? row.cells.sr.text : '?'}, km ${row.cells.km ? row.cells.km.text : '?'}` });
      else if (c.text) clean++;
    }));
  }));
  const crop = b => b ? `<canvas class="crop" data-box="${b.join(',')}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"></canvas>` : '';
  const groups = shots.map((sh, si) => { const its = items.filter(x => x.si === si); return its.length ? `<div class="bgroup" data-si="${si}"><div class="small"><b>${esc(sh.name)}</b> · ${esc(SHOT_KIND[sh.r.kind])} · ${esc(sh.section)} ${esc(sh.line)}</div><div class="bitems">${its.map(it => `<div class="pair bitem">${crop(it.box)}<span class="small muted">${esc(it.label)}</span><input class="sv bad" data-n="${items.indexOf(it)}" value="${esc(it.text)}" spellcheck="false" autocomplete="off" style="width:${Math.max(90, it.box ? it.box[2] - it.box[0] : 90)}px"></div>`).join('')}</div></div>` : ''; }).join('');
  ov.innerHTML = `<div class="shotbar"><b>Check ${shots.length} screenshot(s)</b> <span class="muted">${items.length} doubtful value(s) · ${clean} value(s) read cleanly</span>
      <span class="right"><button class="btn secondary" id="ckClose">Close</button><button class="btn primary" id="ckOk">Confirm all ${shots.length} screenshot(s)</button></span></div>
    <div class="shothelp">${items.length ? 'Only the doubtful values are shown, each under its piece of the screenshot. Correct any that differ from the picture. A value that is read twice (overlapping screenshots) and differs is shown here too.' : 'Every value was read cleanly and the overlapping screenshots agree.'} To look at a whole screenshot, close this and click "Open" / "Check against picture" on it.</div>
    <div class="shotvals">${groups || '<div class="empty">Nothing doubtful.</div>'}</div>`;
  shots.forEach((sh, si) => { const g = ov.querySelector(`.bgroup[data-si="${si}"]`); if (!g) return; const img = new Image(); img.onload = () => g.querySelectorAll('canvas.crop').forEach(c => { const [x0, y0, x1, y1] = c.dataset.box.split(',').map(Number); c.getContext('2d').drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0); }); img.src = sh.url; });
  ov.querySelectorAll('input.sv').forEach(inp => inp.oninput = () => inp.classList.remove('bad'));
  $('ckClose').onclick = () => { ov.remove(); drawShots(); };
  $('ckOk').onclick = () => {
    const errs = [], changed = new Map();
    ov.querySelectorAll('input.sv').forEach(inp => {
      const it = items[+inp.dataset.n], sh = shots[it.si], t = sh.r.tables[it.ti]; let v = inp.value.trim().toUpperCase().replace(/\s+/g, ' ');
      if (it.run != null) { const ru = t.runs[it.run], p = C.parseRun(v); if (!p.ok) { errs.push(inp); return; } if (p.text !== ru.text) (changed.get(sh) || changed.set(sh, []).get(sh)).push({ lines: ru.lines, text: v }); Object.assign(ru, { text: p.text, month: p.month, id: p.id, doubt: false }); return; }
      if (it.k !== 'status') v = v.replace(/\s+/g, ''); const c = t.rows[it.ri].cells[it.k];
      if (!VALID[fieldOf(it.k)](v)) { errs.push(inp); return; }
      if (v && v !== c.text) (changed.get(sh) || changed.set(sh, []).get(sh)).push({ line: c.line, text: v }); c.text = v; c.doubt = false;
    });
    if (errs.length) { errs.forEach(i => i.classList.add('bad')); errs[0].focus(); errs[0].scrollIntoView({ block: 'center' }); toast(`${errs.length} value(s) are not in the right form – see the red boxes`, true); return; }
    for (const sh of shots) { sh.r.tables.forEach(t => t.rows.forEach(r => { r.doubt = 0; Object.values(r.cells).forEach(c => c.doubt = false); })); sh.checked = true; sh.doubt = 0; }
    ov.remove(); drawShots(); toast(`${shots.length} screenshot(s) checked – click "Upload and recalculate"`);
    for (const [sh, ch] of changed) learnFrom(sh, ch);
  };
}
// corrected values become new glyph samples (kept on the server, shared by every admin PC)
async function learnFrom(sh, changed) {
  try {
    const G = C.greyShot(sh.img); const add = [];
    for (const ch of changed) {
      if (ch.line) add.push(...C.learnShot(SH.T, G, ch.line, ch.text));
      else if (ch.lines && ch.lines.length) add.push(...C.learnShot(SH.T, G, ch.lines[ch.lines.length - 1].line, ch.text));
    }
    if (!add.length) return;
    SH.workers.forEach(w => w.postMessage({ add }));
    for (let i = 0; i < add.length; i += 100) await call('ocrLearn', { glyphs: add.slice(i, i + 100) });
    toast(`Reader learnt ${add.length} new character shape(s) from your corrections`);
  } catch (e) { /* learning is optional */ }
}
function shotSets() {
  const done = SH.list.filter(s => s.status === 'done'); const sets = new Map();
  for (const s of done) { const k = [s.r.kind, s.section, s.line].join('|'); if (!sets.has(k)) sets.set(k, { kind: s.r.kind, section: s.section, line: s.line, shots: [] }); sets.get(k).shots.push(s); }
  return [...sets.values()].map(g => {
    if (g.kind === 'imr') return { kind: 'imr', records: C.imrRecords(g.shots.map(s => s.r), g.section, g.line), scope: { section: g.section, line: g.line }, asOn: S.B.today, file: g.shots.map(s => s.name).join(', ') };
    const o = C.omsRecords(g.shots.map(s => s.r), g.section, g.line); const asOn = g.shots.map(s => s.asOn).filter(Boolean).sort().pop() || S.B.today;
    return { kind: 'oms', records: o.records, runs: o.runs, scope: { section: g.section, line: g.line }, asOn, file: g.shots.map(s => s.name).join(', ') };
  });
}
function onShotPaste(e) {
  if (S.view !== 'upload' || !$('shotPaste')) return;
  const items = [...(e.clipboardData && e.clipboardData.items || [])].filter(i => i.kind === 'file' && /^image\//.test(i.type));
  if (!items.length) { if (e.target && e.target.closest && e.target.closest('#shotPaste')) { e.preventDefault(); toast('No picture on the clipboard. Take the screenshot first (Windows key + Shift + S), then press Ctrl+V here.', true); } return; }
  e.preventDefault();
  const t = new Date(); const stamp = [t.getHours(), t.getMinutes(), t.getSeconds()].map(x => String(x).padStart(2, '0')).join('.');
  addShots(items.map((i, k) => { const f = i.getAsFile(); const n = `Pasted ${stamp}${items.length > 1 ? '-' + (k + 1) : ''}.png`; try { return new File([f], n, { type: f.type || 'image/png' }); } catch (er) { return Object.assign(f, { label: n }); } }));
}
function wireShots() {
  if (!$('shotPaste')) return;
  if (!SH.pasteWired) { SH.pasteWired = true; document.addEventListener('paste', onShotPaste); }
  $('pkShots').onclick = e => { e.stopPropagation(); $('inShots').click(); };
  $('pkShotDir').onclick = e => { e.stopPropagation(); $('inShotDir').click(); };
  const pick = e => { const have = new Set(SH.list.map(x => x.name + '|' + x.blob.size)); const f = [...e.target.files].filter(x => /\.(png|jpe?g)$/i.test(x.name) && !have.has(x.name + '|' + x.size)); e.target.value = ''; if (f.length) addShots(f); else toast('No new PNG / JPG pictures in that selection', true); };
  $('inShots').onchange = pick; $('inShotDir').onchange = pick;
  drawShots();
}

// ---------- TMS Collector (Chrome extension): reports fetched from TMS arrive here as files and page data ----------
const W = { sets: [], pages: [], usfd: [], usfdLines: [], notes: [], runId: null, auto: false };
const stripScripts = h => String(h || '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
function webQueueHtml() {
  const rows = [];
  for (const x of W.sets) rows.push([x.file || KIND_NAME[x.kind], `${KIND_NAME[x.kind] || x.kind} – ${x.records.length} rows`]);
  if (W.usfd.length) rows.push(['USFD defects', `${W.usfd.length} rail / weld defect(s) on ${W.usfdLines.length} section-line(s); ${C.pendingIMR(W.usfd).length} IMR(s) still in track`]);
  if (W.pages.length) { const by = {}; for (const p of W.pages) { const k = `${p.section} ${p.lineName || p.line} – run ${p.date}`; by[k] = (by[k] || 0) + 1; } for (const [k, n] of Object.entries(by)) rows.push([k, `TRC km-wise result – ${n} km page(s), read as text`]); }
  for (const n of W.notes) rows.push(['Note', n]);
  return `<div class="small" style="margin-top:6px"><b>From the TMS Collector</b></div><table class="t fileq"><tbody>${rows.map(r => `<tr><td class="small wrap">${esc(r[0])}</td><td class="small wrap">${esc(r[1])}</td></tr>`).join('')}</tbody></table>`;
}
// items: [{type:'file', name, bytes} | {type:'trc', name, tables} | {type:'paste', name, html} | {type:'usfd', name, html} | {type:'usfdHist', name, html, meta} | {type:'atWelds', name, html, period} | {type:'official', name, html}]
async function addCollected(items) {
  const files = []; const hist = [];
  for (const it of items) {
    try {
      if (it.type === 'file') { const f = new File([it.bytes], it.name); f.__collector = true; files.push(f); continue; }
      if (it.type === 'trc') { const p = C.trcPageFromTables(it.tables, it.name); if (it.meta) { if (it.meta.part) p.part = +it.meta.part; if (it.meta.sensor && !p.sensor) p.sensor = it.meta.sensor; } if (p.blocks.length || Object.keys(p.peaks).length) W.pages.push(p); else W.notes.push(`${it.name}: not a TRC result page – skipped`); continue; }
      if (it.type === 'paste') { const tp = C.tablesFromPaste(stripScripts(it.html), ''); const k = C.classifyPaste(tp.title); const r = k ? C.parsePaste(k, tp) : null; if (r) { r.file = it.name; W.sets.push(r); } else W.notes.push(`${it.name}: page not recognised – skipped`); continue; }
      if (it.type === 'usfd') { const r = C.usfdDefectsFromPage(it.html); if (r.section && r.line) { W.usfd.push(...r.records); W.usfdLines.push(r.section + '|' + r.line); } else W.notes.push(`${it.name}: section / line not found – skipped`); continue; }
      if (it.type === 'usfdHist') { hist.push(...C.usfdHistFromPage(it.html, it.meta || {})); continue; }
      if (it.type === 'atWelds') { const recs = C.atWeldsFromPage(it.html, it.period); if (recs.length) W.sets.push({ kind: 'atWelds', records: recs, scope: { division: true }, asOn: S.B.today, file: it.name }); continue; }
      if (it.type === 'official') { const r = C.parseKpiSheet('official', C.rowsFromPage(it.html), ''); if (r && r.records.length && r.records[0].unit) { r.file = it.name; W.sets.push(r); } else W.notes.push(`${it.name}: score page not recognised`); continue; }
    } catch (e) { W.notes.push(`${it.name || it.type}: could not read – ${e.message || e}`); }
  }
  if (hist.length) { const seen = new Set(); W.sets.push({ kind: 'usfdHist', records: hist.filter(r => !seen.has(r.key) && seen.add(r.key)), scope: {}, file: 'USFD testing history (TMS Collector)' }); }
  if (files.length) await addFilesZ(files);
  drawQueue();
}
function collectDone(ok) {
  if (!W.runId) return;
  window.postMessage({ __tmsc: 'result', runId: W.runId, ok, log: U.log.slice(-40) }, location.origin);
  W.runId = null; W.sets = []; W.pages = []; W.usfd = []; W.usfdLines = []; W.notes = [];
}
async function startCollected(m) {
  if (U.running) { window.postMessage({ __tmsc: 'result', runId: m.runId, ok: false, log: ['An upload is already running on this page – try again when it finishes.'] }, location.origin); return; }
  W.runId = m.runId; W.auto = !!m.auto;
  if (S.view !== 'upload') { S.view = 'upload'; T.render(); await new Promise(r => setTimeout(r, 300)); }
  plog(`TMS Collector: ${m.items.length} item(s) received (run ${m.runId})`);
  await addCollected(m.items);
  // wait until every report file has been opened and checked on this computer (a weekly run brings ~100 register files)
  const unread = () => U.files.filter(f => !/\.png$/i.test(f.name) && !f.__info).length; const t0 = Date.now(); let said = 0;
  while (unread() && Date.now() - t0 < 3600e3) { await new Promise(r => setTimeout(r, 1000)); if (Date.now() - said > 30e3) { said = Date.now(); const docs = U.files.filter(f => !/\.png$/i.test(f.name)).length; plog(`  checking report files on this computer – ${docs - unread()} of ${docs} done…`); } }
  // asset registers this program does not read (from an older collector) are skipped quietly instead of stopping the upload
  // only registers TMS Control really does not read are skipped quietly; an unread weld / fish plate / curve … register is a problem
  for (const f of U.files) if (f.__collector && f.__info && !f.__info.ok && /^AssetRegister_(RAIL|FASTENING|SLEEPER|RAIL_PAD|LINER|Welding_Team|LAND_BOUNDARY|DRAINAGE|EROSION|FORMATION|PROTECTION|WEAK|TUNNEL|TRACK_TYPE|BUFFER|SAND_HUMP|Steel_Channel)/i.test(f.name)) { f.__info.unused = true; f.__info.lines = ['Asset register not used by TMS Control – skipped']; }
  drawQueue();
  const bad = U.files.filter(f => f.__info && !f.__info.ok && !f.__info.unused).length;
  if (W.auto && !bad && !SH.list.length) { plog('Everything recognised – uploading.'); runUpload(); }
  else { const why = bad ? `${bad} file(s) not recognised` : SH.list.length ? 'screenshots in the list need checking' : 'automatic upload is off'; plog(`Check the list and click "Upload and recalculate" (${why}).`); toast('Collected reports are ready to upload – check the list', !!bad); window.postMessage({ __tmsc: 'waiting', runId: m.runId, why }, location.origin); }
}
window.addEventListener('message', e => {
  if (e.source !== window || !e.data || typeof e.data !== 'object') return;
  if (e.data.__tmsc === 'ping') window.postMessage({ __tmsc: 'ready', role: 'admin' }, location.origin);
  if (e.data.__tmsc === 'collect' && Array.isArray(e.data.items)) startCollected(e.data);
});
window.postMessage({ __tmsc: 'ready', role: 'admin' }, location.origin);

// ---------- users ----------
V.users = async el => {
  el.innerHTML = T.pageHead('Users', 'Only users listed here can open the app', `<button class="btn primary right" id="addU">Add user</button>`) + `<div class="panel body" id="clink"></div><div class="panel body" id="ulist"><div class="empty">Loading…</div></div>`;
  call('commonLink').then(r => { const msg = `HWH TMS Control – open this link on your phone in Chrome and sign in with your mobile number, name and designation: ${r.link}`; $('clink').innerHTML = `<h3 class="sec">Common link for everyone</h3><div class="inner"><p class="small">Send this one link to all staff (e.g. the WhatsApp group). Each person signs in once with mobile number, name and designation and can use the app at once – no approval. A new person is added to this list automatically (marked "self-registered"); switch off anyone who should not be here. Personal links keep working.</p><div class="row"><input id="clUrl" readonly value="${esc(r.link)}" style="flex:1;min-width:220px"><button class="btn secondary sm" id="clCopy">Copy message</button></div></div>`; $('clCopy').onclick = async () => { try { await navigator.clipboard.writeText(msg); toast('Message with the link copied'); } catch (e) { $('clUrl').select(); toast('Select and copy the link', true); } }; }).catch(() => { });
  $('addU').onclick = () => userForm();
  try { const L = await call('users'); drawUsers(L); } catch (e) { fail(e); }
};
function drawUsers(L) {
  $('ulist').innerHTML = `<div class="scroll"><table class="t"><thead><tr><th>Name</th><th>Role</th><th>Scope</th><th>Contact</th><th>Status</th><th>Phones</th><th>Last seen</th><th></th></tr></thead><tbody>${L.map(u => `<tr><td><b>${esc(u.Name)}</b>${/self/i.test(u.CreatedBy || '') ? `<div class="small"><span class="tag t3">self-registered</span> ${esc(dmy(u.Created))}</div>` : ''}</td><td>${esc(u.RoleName)}</td><td>${esc(u.Scope)}</td><td class="small">${esc(u.Email)}<br>${esc(u.Mobile)}</td><td>${u.Status === 'Active' ? '<span class="tag tg">Active</span>' : '<span class="tag t1">' + esc(u.Status) + '</span>'}</td><td class="n">${u.Devices} / ${u.MaxDevices || 2}</td><td class="nw small">${esc(String(u.LastSeen || '—').replace('T', ' '))}</td>
    <td class="nw">${u.HasLink ? `<button class="btn ghost sm" data-a="show" data-id="${u.UserId}">Show link</button><button class="btn ghost sm" data-a="link" data-id="${u.UserId}">New link</button>` : `<button class="btn primary sm" data-a="link" data-id="${u.UserId}">Make link</button>`}<button class="btn ghost sm" data-a="dev" data-id="${u.UserId}">Reset phones</button><button class="btn ghost sm" data-a="${u.Status === 'Active' ? 'off' : 'on'}" data-id="${u.UserId}">${u.Status === 'Active' ? 'Switch off' : 'Switch on'}</button><button class="btn ghost sm" data-a="edit" data-id="${u.UserId}">Edit</button></td></tr>`).join('')}</tbody></table></div>`;
  $('ulist').querySelectorAll('button[data-a]').forEach(b => b.onclick = async () => {
    const id = b.dataset.id, a = b.dataset.a;
    try {
      if (a === 'show') { const r = await call('userLink', { id }); showLink(r); return; }
      if (a === 'link') { const has = b.textContent !== 'Make link'; if (has && !confirm('Create a new link? The old link stops working on every phone.')) return; const r = await call('reissueUser', { id }); showLink(r); }
      if (a === 'dev') { if (!confirm('Remove all approved phones of this user? Each phone will need approval again.')) return; await call('resetDevices', { id }); toast('Phones reset – the next phone needs approval again'); }
      if (a === 'off' || a === 'on') await call('setUserStatus', { id, status: a === 'off' ? 'Inactive' : 'Active' });
      if (a === 'edit') { const L = await call('users'); userForm(L.find(x => x.UserId === id)); return; }
      drawUsers(await call('users'));
    } catch (e) { fail(e); }
  });
}
function userForm(u) {
  const B = S.B; const roles = Object.entries(B.roles);
  modal(`<h3>${u ? 'Edit user' : 'Add user'}</h3><div class="fld"><label>Name and designation</label><input id="fN" value="${esc(u?.Name || '')}" placeholder="e.g. Sunil Kumar, SSE/P.Way/LLH"></div>
    <div class="row"><div class="fld" style="flex:1"><label>Email</label><input id="fE" value="${esc(u?.Email || '')}"></div><div class="fld" style="flex:1"><label>Mobile (for WhatsApp)</label><input id="fM" value="${esc(u?.Mobile || '')}"></div></div>
    <div class="row"><div class="fld" style="flex:1"><label>Role</label><select id="fR">${roles.map(([k, v]) => `<option value="${k}" ${u?.Role === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div><div class="fld" style="flex:1"><label>Unit / AEN / Sr DEN</label><select id="fS"></select></div></div>
    <div class="fld"><label>Phones allowed (blank = default 2)</label><input id="fD" type="number" min="1" max="5" value="${esc(u?.MaxDevices || '')}"></div>`, async () => {
    const o = { Name: $('fN').value.trim(), Email: $('fE').value.trim(), Mobile: $('fM').value.trim(), Role: $('fR').value, Scope: $('fS').value, MaxDevices: $('fD').value };
    try { if (u) { o.UserId = u.UserId; await call('updateUser', o); toast('Saved'); } else { const r = await call('createUser', o); setTimeout(() => showLink(r), 50); } drawUsers(await call('users')); } catch (e) { fail(e); return false; }
  }, u ? 'Save' : 'Create user and link');
  const fill = () => { const r = $('fR').value; const opts = r === 'SSE' || r === 'JE' ? B.allUnits : r === 'AEN' ? B.aens : r === 'SRDEN' ? B.srdens : []; $('fS').innerHTML = opts.length ? opts.sort().map(x => `<option ${u?.Scope === x ? 'selected' : ''}>${esc(x)}</option>`).join('') : '<option value="">Whole division</option>'; };
  $('fR').onchange = fill; fill();
}
function showLink(r) {
  const msg = `HWH TMS Control – your personal link (do not forward):\n${r.link}`;
  const mob = String(r.user.Mobile || '').replace(/\D/g, ''); const wa = `https://wa.me/${mob.length === 10 ? '91' + mob : mob}?text=${encodeURIComponent(msg)}`;
  modal(`<h3>Personal link for ${esc(r.user.Name)}</h3><p>Send this link to the user. When they open it, the phone is registered and needs approval (by their AEN / Sr DEN or you, on "Phone approvals"). Up to ${r.user.MaxDevices || 2} phone(s).</p><div class="linkbox" id="lnk">${esc(r.link)}</div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="cpy">Copy link</button><a class="btn secondary" target="_blank" rel="noopener" href="${esc(wa)}">Send on WhatsApp</a><a class="btn secondary" href="mailto:${esc(r.user.Email || '')}?subject=${encodeURIComponent('HWH TMS Control – personal link')}&body=${encodeURIComponent(msg)}">Send by email</a></div>`);
  $('cpy').onclick = () => { navigator.clipboard.writeText(r.link).then(() => toast('Copied')); };
}

// ---------- settings ----------
V.settings = async el => {
  el.innerHTML = T.pageHead('Settings', 'Rules and target days – changes apply at the next recalculation') + `<div id="setw"><div class="empty">Loading…</div></div>`;
  try {
    const st = await call('settings');
    $('setw').innerHTML = `<div class="panel body"><h3 class="sec">Settings</h3><div class="scroll"><table class="t"><thead><tr><th>Setting</th><th>Value</th><th>Meaning</th></tr></thead><tbody>${st.settings.map(s => `<tr><td class="nw"><b>${esc(s.Key)}</b></td><td><input data-k="${esc(s.Key)}" value="${esc(s.Value)}" style="width:220px;padding:4px 6px;border:1px solid #b9bfc9"></td><td class="small wrap">${esc(s.Note)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="panel body"><h3 class="sec">Target days by job type</h3><div class="scroll"><table class="t"><thead><tr><th>Job type</th><th>SSE to complete (days)</th><th>AEN to approve (days)</th><th>Photo required</th><th>Closes by TMS data</th></tr></thead><tbody>${st.targets.map(t => `<tr><td>${esc(t.Description)}<div class="small muted">${esc(t.JobType)} · ${esc(t.KPI)}</div></td><td><input type="number" data-t="${esc(t.JobType)}" data-f="SSEDays" value="${esc(t.SSEDays)}" style="width:80px"></td><td><input type="number" data-t="${esc(t.JobType)}" data-f="AENDays" value="${esc(t.AENDays)}" style="width:80px"></td><td><select data-t="${esc(t.JobType)}" data-f="PhotoRequired"><option ${t.PhotoRequired === 'Yes' ? 'selected' : ''}>Yes</option><option ${t.PhotoRequired !== 'Yes' ? 'selected' : ''}>No</option></select></td><td class="small">${esc(t.ClosedByData)}</td></tr>`).join('')}</tbody></table></div>
      <div style="padding:12px 14px" class="row"><button class="btn primary" id="saveSet">Save settings</button><button class="btn secondary" id="recalc">Recalculate now</button></div></div>
      <div class="panel body"><h3 class="sec">Sheet backups</h3><p class="small">Every morning at 05:00 a dated copy of the whole Google Sheet is saved in the Drive folder <b>TMS Control backups</b> (copies are never deleted). Google Sheets also keeps every change under File → Version history.</p>
      <p id="bkInfo">${st.backup && st.backup.last ? 'Last copy: <b>' + esc(String(st.backup.last).replace('T', ' ').slice(0, 16)) + '</b>' : 'No copy made yet.'}${st.backup && st.backup.folderUrl ? ` · <a href="${esc(st.backup.folderUrl)}" target="_blank" rel="noopener">Open the backup folder</a>` : ''}</p>
      <div class="row"><button class="btn secondary" id="bkNow">Back up now</button></div></div>`;
    $('saveSet').onclick = async () => {
      const settings = [...document.querySelectorAll('[data-k]')].map(i => ({ Key: i.dataset.k, Value: i.value }));
      const tm = {}; document.querySelectorAll('[data-t]').forEach(i => { (tm[i.dataset.t] = tm[i.dataset.t] || { JobType: i.dataset.t })[i.dataset.f] = i.value; });
      try { await call('saveSettings', { settings, targets: Object.values(tm) }); toast('Saved'); } catch (e) { fail(e); }
    };
    $('bkNow').onclick = async e => { e.target.disabled = true; try { const r = await call('backupNow', {}, { timeout: 300000 }); $('bkInfo').innerHTML = `Saved: <b>${esc(r.name)}</b> · <a href="${esc(r.url)}" target="_blank" rel="noopener">open the copy</a>`; toast('Backup saved'); } catch (er) { fail(er); } e.target.disabled = false; };
    $('recalc').onclick = async e => { e.target.disabled = true; try { const r = await call('refresh'); toast('Recalculated in ' + r.seconds + ' s'); await T.reload(); } catch (er) { fail(er); } e.target.disabled = false; };
  } catch (e) { fail(e); }
};
V.uploads = async el => {
  el.innerHTML = T.pageHead('Upload history', 'Every upload, newest first') + `<div class="panel body" id="uph"><div class="empty">Loading…</div></div>`;
  try { const L = (await call('uploads')).reverse(); $('uph').innerHTML = `<div class="scroll"><table class="t"><thead><tr><th>When</th><th>By</th><th>Report</th><th>File</th><th>As on</th><th>Records</th><th>New</th><th>Closed</th><th>Note</th></tr></thead><tbody>${L.map(u => `<tr><td class="nw">${esc(String(u.When).replace('T', ' '))}</td><td>${esc(u.By)}</td><td>${esc(KIND_NAME[u.Kind] || u.Kind)}</td><td class="small wrap">${esc(u.File)}</td><td class="nw">${dmy(u.AsOn)}</td><td class="n">${u.Records}</td><td class="n">${u.New}</td><td class="n">${u.Closed}</td><td class="small wrap">${esc(u.Note)}</td></tr>`).join('')}</tbody></table></div>`; } catch (e) { fail(e); }
};
if (S.B) T.render();
})();
