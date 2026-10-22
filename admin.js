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
const KIND_NAME = { trcRep: 'Repeated UML peaks / CBML blocks – TMS lists (K8 / K9)', dpc: 'Defects pending for compliance – all categories (K10)', omsPeak: 'OMS peak locations above 0.15 g (km/m)', 'geo-curve': 'Curve register (worksite tagging)', 'geo-pxing': 'P&C register (worksite tagging)', 'geo-lc': 'LC register (worksite tagging)', 'geo-sej': 'SEJ register (worksite tagging)', 'geo-glued': 'Glued joint register (worksite tagging)', 'geo-diamond': 'Diamond crossing register (worksite tagging)', 'geo-bridge': 'Bridge register (worksite tagging)', jog: 'Welds needing joggled plates', weldSum: 'AT weld count', fpSum: 'Main-line FP joint count', inspections: 'Inspection register', assetInsp: 'Latest inspection report', lna: 'Locations needing attention', dfwr: 'DFWR analysis', og: 'Overdue oiling & greasing', fracture: 'Fracture analysis', official: 'TMS item-wise score', jurisdiction: 'Jurisdiction details', tmsJurisdiction: 'Jurisdiction as mapped in TMS', oms: 'OMS comparative summary', imr: 'IMR testing history', weldReg: 'Weld register', fpReg: 'Fish-plated joint register (joint count for K15)', trc: 'TRC km-wise pages', usfd: 'USFD rail / weld defects', atWelds: 'AT welds done / defective', ogSum: 'Oiling & greasing summary per SSE (K15)', usfdHist: 'USFD testing history', weldMonths: 'AT welds done / tested per month (K12)', untested: 'New AT welds not yet tested' };
V.upload = async el => {
  el.innerHTML = T.pageHead('Upload TMS data', 'Admin – reports come from the TMS Collector; every upload is added to the history, nothing older is overwritten') + `<div class="grid2">
    <div><div class="panel"><div class="panelhead"><span>Ready to upload</span><span class="right"><label class="small"><input type="checkbox" id="dfwrDiv" ${U.dfwrDivision ? 'checked' : ''}> DFWR file covers the whole division</label> <label class="small" title="Normally a report identical to the last upload from this computer is not sent again (faster). Tick to send everything."><input type="checkbox" id="sendAll" ${U.sendAll ? 'checked' : ''}> Send unchanged reports too</label></span></div><div id="queue" style="padding:10px 14px"></div>
      <div style="padding:0 14px 14px" class="row"><button id="btnGo" class="btn primary">Upload and recalculate</button><button id="btnClr" class="btn secondary">Clear</button></div></div>
      <div id="pbar" class="hidden" style="margin:0 0 8px;border:1px solid #c9d1dc;background:#fff;padding:8px 10px"><div style="height:10px;background:#e8ecf2;overflow:hidden"><div class="pfill" style="height:10px;width:0;background:#2b6cb0;transition:width .4s"></div></div><div class="ptxt small" style="margin-top:6px"></div></div>
      <style>#pbar.bad .pfill{background:#c53030!important}#pbar.ok .pfill{background:#2f855a!important}#pbar.bad .ptxt{color:#c53030;font-weight:600}</style>
      <div class="plog" id="plog">${esc(U.log.join('\n')) || 'Progress will appear here.'}</div>
      <details id="manual" style="margin-top:16px"${U.manualOpen ? ' open' : ''}><summary style="cursor:pointer;font-weight:600;padding:6px 0">Manual upload (backup) – files or screenshots, when the TMS Collector cannot fetch a report</summary><div style="margin-top:10px"><div id="drop" class="drop" tabindex="0"><svg class="dropsvg" viewBox="0 0 48 48"><path d="M6 14h14l4 4h18v22H6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 36V24m-5 5l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      <div class="droptitle">Click <b>Select files</b> and pick the reports</div><div class="dropsub">TMS PDFs, XLS / XLSX reports, TRC km-wise PNG pages, or a ZIP of them. In the file window you can select many files at once (Ctrl+A or Ctrl+click).</div>
      <div class="btnrow"><button id="pkFiles" class="btn primary">Select files</button><button id="pkFolder" class="btn secondary">Select a whole folder</button></div>
      <div class="dropsub small" style="margin-top:10px">Dragging files onto this box also works in Chrome and Edge. If a dragged file opens in a new tab instead, use the buttons.</div>
      <input id="inFolder" type="file" webkitdirectory multiple hidden><input id="inFiles" type="file" multiple hidden accept=".png,.jpg,.jpeg,.xls,.xlsx,.pdf,.zip,.json"></div>

      <div class="panel" style="margin-top:16px"><div class="panelhead"><span>Screenshots of TMS pages</span><span class="muted">IMR testing history, OMS peaks km-wise comparative summary</span></div>
      <div style="padding:12px"><div id="shotPaste" class="pastebox" tabindex="0">Open the TMS page at normal zoom (100%) → press <b>Windows key + Shift + S</b> and drag over the table (include the column headings) → click here → press <b>Ctrl+V</b>.<br><span class="small">Scroll and repeat until every row is captured; rows seen twice are counted once. Saved screenshots (many at once): <button id="pkShots" class="btn ghost sm">Select screenshot files</button> <button id="pkShotDir" class="btn ghost sm">Select a folder of screenshots</button></span></div>
      <input id="inShots" type="file" multiple hidden accept=".png,.jpg,.jpeg"><input id="inShotDir" type="file" webkitdirectory multiple hidden><div id="shotList" style="margin-top:10px"></div></div></div>
      </div></details></div>
    <div><div class="panel body"><h3 class="sec">Data from TMS</h3><div class="small muted" style="margin-bottom:8px">When each report last arrived and how many records it had. Red: late or empty.</div><div id="chk"><div class="empty">Loading…</div></div></div></div></div>`;
  wireDrop(); wireShots(); drawQueue();
  $('manual').ontoggle = () => { U.manualOpen = $('manual').open; };
  $('sendAll').onchange = e => { U.sendAll = e.target.checked; };
  try {
    U.statusAt = Date.now(); U.statusP = call('dataStatus').then(st => (U.status = st)); const st = await U.statusP;
    // late: more than the expected interval since the last upload; empty: 0 records for a list that is never empty division-wide
    const maxDays = w => /daily/i.test(w) ? 2 : /twice a week/i.test(w) ? 4 : /weekly/i.test(w) ? 8 : /monthly/i.test(w) ? 35 : null;
    const age = d => d ? Math.floor((Date.parse(S.B.today) - Date.parse(String(d).slice(0, 10))) / 864e5) : null;
    $('chk').innerHTML = `<div class="scroll"><table class="t"><thead><tr><th>Report</th><th>Last arrived</th><th>Records</th></tr></thead><tbody>${st.map(r => {
      const a = age(r.last), m = maxDays(r.when); const late = r.last && m != null && a > m; const empty = r.last && +r.records === 0 && !/jurisdiction|Jurisdiction|official|fracture/.test(r.kind);
      const cls = !r.last ? 'od' : late || empty ? 'od' : '';
      return `<tr><td class="wrap">${esc(r.what)}<div class="small muted">expected: ${esc(r.when)}</div></td><td class="${cls}" style="min-width:110px">${r.last ? dmy(r.last) + `<div class="small">${a === 0 ? 'today' : a + ' day(s) ago'} · as on ${dmy(r.asOn)}${late ? ' · <b>late</b>' : ''}${/unchanged/.test(r.note || '') ? ' · unchanged' : ''}</div>` : 'never'}</td><td class="n ${empty ? 'od' : ''}">${r.records ?? ''}${empty ? '<div class="small">empty</div>' : ''}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  } catch (e) { fail(e); }
};
function openManual() { const d = $('manual'); if (d && !d.open) { d.open = true; U.manualOpen = true; } }
function plog(m) { U.log.push(m); const p = $('plog'); if (p) { p.textContent = U.log.join('\n'); p.scrollTop = p.scrollHeight; } if (W.runId) window.postMessage({ __tmsc: 'progress', runId: W.runId, line: String(m).trim() }, location.origin); }
// asset registers TMS Control does not read (rail, sleeper, fastening … – hundreds of MB per run): never opened, never uploaded
const UNUSED_REG = /^AssetRegister_(RAIL|FASTENING|SLEEPER|RAIL_PAD|LINER|Welding_Team|LAND_BOUNDARY|DRAINAGE|EROSION|FORMATION|PROTECTION|WEAK|TUNNEL|TRACK_TYPE|BUFFER|SAND_HUMP|Steel_Channel)/i;
const pause = () => new Promise(r => setTimeout(r, 0));   // lets the page breathe between large files
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
  const ext = f.name.split('.').pop().toLowerCase(), lines = []; let ok = false; const use = { geo: false, trc: false };
  try {
    const buf = await f.arrayBuffer();
    if (ext === 'pdf') {
      if (f.size > 15e6) { lines.push('Very large PDF – will be skipped'); }
      else { const pages = await C.pdfPages(buf); if (C.isRegister(pages)) { const R = C.parseRegister(pages); ok = R.length > 0; lines.push(regText(pages, R)); }
        else { const k = C.classifyPdf(await C.pdfLines(buf)); ok = !!k; use.trc = !!k; lines.push(k ? (C.KINDS[k] || k) + ' – used for the TRC analysis' : 'Not a TMS report this program knows'); } }
    } else {
      const wb = ext === 'xls' ? C.readXLS(buf) : await C.readXLSX(buf);
      for (const sh of wb.sheets) {
        const tag = wb.sheets.length > 1 ? `[${sh.name}] ` : '';
        const k = C.classifyKpiSheet(sh.rows, sh.name);
        if (k === 'jurisdiction') { ok = true; lines.push(tag + `Jurisdiction details – ${sh.rows.length - 1} rows`); continue; }
        if (k) { const r = C.parseKpiSheet(k, sh.rows, sh.name); ok = ok || r.records.length > 0; lines.push(tag + `${KIND_NAME[k] || k} – ${r.records.length} rows${r.records.length ? '' : ' (no rows found – check the file)'}`); if (k !== 'weldReg' && k !== 'fpReg') continue; }
        const g = C.classifySheet(sh.rows, sh.name); if (g) { if (GEO_NAME[g]) use.geo = true; else use.trc = true; }
        if (g && !(k && (k === 'weldReg' || k === 'fpReg') && !GEO_NAME[g])) {
          const recs = C.parseSheet(g, sh.rows); const secs = new Set(recs.map(r => r.section).filter(Boolean));
          if (!k) { ok = ok || recs.length > 0; lines.push(tag + `${GEO_NAME[g] ? GEO_NAME[g] + ' (worksite tagging)' : C.KINDS[g] || g} – ${recs.length} rows, ${secs.size} section(s)${recs.length ? '' : ' (no rows found – check the file)'}`); }
        }
        if (!k && !g) lines.push(tag + 'Not a TMS report this program knows – will be skipped');
      }
    }
  } catch (e) { lines.push('Could not open: ' + (e.message || e)); }
  // a weld / fish-plate register fetched by an older collector lacks the columns TMS Control needs: left out, with the remedy
  if (!ok && /^AssetRegister_(WELD|FISH_PLATE)/i.test(f.name)) { f.__info = { ok: false, unused: true, use, lines: [/WELD/i.test(f.name) ? 'Older weld register without the "Whether joggled" column – left out. Fetch it again with "Asset registers now" in the TMS Collector.' : 'Older fish-plate register without the needed columns – left out. Fetch it again with "Asset registers now" in the TMS Collector.'] }; drawQueue(); return; }
  f.__info = { ok, lines, use }; drawQueue();
}
// e.g. "Curve inspection register – 203 inspections"; a blank form says so
function regText(pages, R) {
  const fk = C.formKind(pages); const types = [...new Set(R.map(r => r.type))];
  const nm = types.length ? types.map(t => C.FORM_NAME[t] || { FP: 'Foot plate', RV: 'Rear vehicle', FOOT: 'On foot', TROLLEY: 'Trolley' }[t] || t).join(' + ') : (C.FORM_NAME[fk] || 'Inspection');
  // report-engine chat (issue 12b): every inspection counts for K16 field days; FP / RV also for K2, on foot / trolley for K3
  const use = types.some(t => t === 'FP' || t === 'RV') ? 'K2 and field days' : types.some(t => t === 'FOOT' || t === 'TROLLEY') ? 'K3 and field days' : 'field days';
  return R.length ? `${nm} register – ${R.length} inspection(s) (counted for ${use})` : `${nm} – no filled-in inspections in this file (blank form?) – will be skipped`;
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
  const have = new Set(U.files.map(f => f.name + '|' + f.size)); const jpg = []; let unused = 0;
  for (const f of list) { if (/\.jpe?g$/i.test(f.name)) { jpg.push(f); continue; } if (UNUSED_REG.test(f.name)) { unused++; continue; } if (/\.(png|xls|xlsx|pdf)$/i.test(f.name) && !/^~\$/.test(f.name) && !have.has(f.name + '|' + f.size)) U.files.push(f); }
  if (jpg.length) addShots(jpg);   // JPG pictures are screenshots, never TRC pages
  if (unused) { const n = `${unused} asset register file(s) TMS Control does not use (rail, sleeper, fastening …) – left out`; if (W.runId) { W.notes.push(n); plog('  ' + n); } else toast(n); }
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
    try { const r = await call(fn, args, opt); P.calls++; return r; }
    catch (e) { if (!e || !e.offline || i >= 2) throw e; plog(`  (no answer from the server – trying again in ${i ? 30 : 10} s)`); await new Promise(r => setTimeout(r, i ? 30000 : 10000)); }
  }
}
const upid = () => 'UP' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const SNAPSHOT = new Set(['lna', 'dfwr', 'og', 'jog', 'untested', 'omsPeak', 'usfd']);   // lists whose missing items are closed
const OPTIONAL_KIND = new Set(['tmsJurisdiction']);   // newer reports: an older server's "Unknown report type" does not stop the upload
const PART = { inspections: 1500, assetInsp: 4000, usfd: 3000 };   // records per server call (each call costs ~30–50 s on the server, so few large calls)
async function send(kind, payload, size) {
  size = size || PART[kind] || 4000;
  const recs = payload.records || []; const id = upid(); const parts = recs.length ? chunk(recs, size) : [[]]; let tot = { inserted: 0, updated: 0, unchanged: 0, closed: 0 };
  const seen = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const a = Object.assign({}, payload, { kind, records: parts[i], uploadId: id, final: last, total: recs.length, parts: parts.length });
    if (last && parts.length > 1 && SNAPSHOT.has(kind)) a.seen = seen;   // earlier parts' items are not closed by the last part
    if (parts.length > 1) P.sub(`part ${i + 1} of ${parts.length}`);
    const r = await callR('ingest', a, { timeout: 360000 }); P.tick();
    for (const k in tot) tot[k] += r[k] || 0;
    if (r.lines) tot.lines = r.lines;   // report-engine chat: lines the server wants in the upload log (e.g. jurisdiction comparison)
    if (!last) for (const x of parts[i]) if (x && x.key) seen.push(x.key);
  }
  return tot;
}
// ---------- progress bar (whole upload): reading the files ~10 %, then every server call moves it ----------
const P = { t0: 0, total: 1, done: 0, label: '', subl: '', stepT0: 0, timer: null, calls: 0, times: [], read: 0, lastPost: '' };
const mmss = ms => { const s = Math.round(ms / 1000); return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s'; };
P.pct = () => Math.min(100, Math.round(10 * P.read + 90 * P.done / Math.max(1, P.total)));
P.show = () => {
  const el = $('pbar'); const pct = P.pct();
  if (el) { el.classList.remove('hidden'); el.querySelector('.pfill').style.width = pct + '%'; el.querySelector('.ptxt').textContent = `${pct} % · ${P.label}${P.subl ? ' – ' + P.subl : ''} · working ${mmss(Date.now() - P.stepT0)} on this step · ${mmss(Date.now() - P.t0)} in all`; }
  const post = pct + '|' + P.label + '|' + P.subl;
  if (W.runId && post !== P.lastPost) { P.lastPost = post; window.postMessage({ __tmsc: 'progress', runId: W.runId, line: `${pct} % – ${P.label}${P.subl ? ' (' + P.subl + ')' : ''}` }, location.origin); }
};
P.begin = () => { Object.assign(P, { t0: Date.now(), stepT0: Date.now(), total: 1, done: 0, label: 'Reading the report files on this computer', subl: '', calls: 0, times: [], read: 0, lastPost: '' }); const el = $('pbar'); if (el) el.classList.remove('bad', 'ok'); clearInterval(P.timer); P.timer = setInterval(P.show, 1000); P.show(); };
P.step = label => { if (P.label && P.stepT0) P.times.push([P.label, Date.now() - P.stepT0]); P.label = label; P.subl = ''; P.stepT0 = Date.now(); P.show(); };
P.sub = t => { P.subl = t; P.show(); };
P.tick = (n = 1) => { P.done += n; P.show(); };
P.end = (ok, msg) => {
  if (P.label && P.stepT0) P.times.push([P.label, Date.now() - P.stepT0]);
  clearInterval(P.timer); P.timer = null; if (ok) P.done = P.total, P.read = 1;
  const el = $('pbar'); if (el) { el.classList.add(ok ? 'ok' : 'bad'); el.querySelector('.pfill').style.width = (ok ? 100 : P.pct()) + '%'; el.querySelector('.ptxt').textContent = msg; }
  if (W.runId) window.postMessage({ __tmsc: 'progress', runId: W.runId, line: msg }, location.origin);
};
// ---------- one server call per report type (speed): files of the same report (one per section / SSE) are sent together ----------
function unionScope(list) {
  if (list.some(s => s && s.division)) return { division: true };
  const sections = new Set(), units = new Set(), lines = new Set();
  for (const s of list) { if (!s) continue; (s.sections || []).forEach(x => x && sections.add(x)); if (s.section) sections.add(s.section); if (s.unit) units.add(s.unit); (s.units || []).forEach(x => units.add(x)); (s.lines || []).forEach(x => lines.add(x)); }
  const o = {}; if (sections.size) o.sections = [...sections]; if (units.size) o.units = [...units]; if (lines.size) o.lines = [...lines]; return o;
}
function mergeSets(sets) {
  const by = new Map();
  for (const s of sets) { const g = by.get(s.kind) || []; g.push(s); by.set(s.kind, g); }
  return [...by.values()].map(g => {
    if (g.length === 1) return Object.assign({ files: 1 }, g[0]);
    const asOn = g.map(s => s.asOn).filter(Boolean).sort().pop() || null;
    const names = g.map(s => s.file).filter(Boolean);
    return { kind: g[0].kind, records: [].concat(...g.map(s => s.records || [])), scope: unionScope(g.map(s => s.scope)), asOn, files: g.length, file: `${g.length} files: ` + names.slice(0, 6).join(', ') + (names.length > 6 ? ` … (+${names.length - 6})` : '') };
  });
}
// ---------- a report identical to the last one sent from this computer is not sent again (speed) ----------
const hashOf = str => { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };
const SENT_DAYS = 6;   // after this many days a report is sent again even when unchanged
// …and only when the server also shows that report arrived at least that recently (a cleared or restored sheet gets everything again)
function serverHas(key, at) { const r = (U.status || []).find(x => x.kind === key); if (!r) return !!U.status; if (!r.last) return false; const t = Date.parse(String(r.last).replace(' ', 'T') + '+05:30'); return !isNaN(t) && t >= at - 120000; }
function sentBefore(key, h) { if (U.sendAll) return false; try { const o = JSON.parse(localStorage.getItem('tmsc.sent.' + key) || 'null'); return !!o && o.h === h && Date.now() - o.at < SENT_DAYS * 864e5 && serverHas(key, o.at); } catch (e) { return false; } }
function markSent(key, h) { try { localStorage.setItem('tmsc.sent.' + key, JSON.stringify({ h, at: Date.now() })); } catch (e) { } }
const fmtRes = (n, r, closedTxt = 'closed (no longer in TMS)') => `${n} row(s): ${r.inserted} new, ${r.updated} changed, ${r.unchanged != null ? r.unchanged : Math.max(0, n - r.inserted - r.updated)} unchanged${r.closed ? `, ${r.closed} ${closedTxt}` : ''}`;
async function runUpload() {
  if (U.running) return;
  const shots = SH.list.filter(x => x.status === 'done');
  if (SH.list.some(x => x.status === 'reading')) { toast('Screenshots are still being read – wait a moment', true); return; }
  const unchecked = shots.filter(x => !x.checked || !x.section || !x.line);
  if (unchecked.length) { toast(`${unchecked.length} screenshot(s) not checked yet. Click "Check" on each (or remove it with ✕), then upload.`, true); openManual(); $('shotList').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (!U.files.length && !shots.length && !W.sets.length && !W.pages.length && !W.usfd.length) { toast('Select files first', true); return; }
  U.running = true; $('btnGo').disabled = true; U.log = []; const t0 = Date.now();
  try { await doUpload(t0); } finally { U.running = false; const b = $('btnGo'); if (b) b.disabled = false; if (P.timer) { clearInterval(P.timer); P.timer = null; } }
}
async function doUpload(t0) {
  P.begin();
  try {
    // what the server already has (for skipping unchanged reports): the page's own status call, or a fresh one if it is old
    try { if (!U.statusP || Date.now() - (U.statusAt || 0) > 10 * 60000) { U.statusAt = Date.now(); U.statusP = call('dataStatus').then(st => (U.status = st)); } await U.statusP; } catch (e) { U.status = null; }
    const pngs = U.files.filter(f => /\.png$/i.test(f.name)); const docs = U.files.filter(f => !/\.png$/i.test(f.name));
    const out = { inspections: [], jurisdiction: null }; const trcFiles = []; const kpiSets = [];
    if (W.runId) for (const n of W.notes) plog('TMS Collector: ' + n);
    plog(`Reading ${docs.length} report file(s) on this computer…`); let fi = 0;
    for (const f of docs) {
      fi++; P.read = fi / Math.max(1, docs.length) * 0.8; await pause(); if (f.__info && f.__info.unused) continue;
      if (docs.length > 20 && fi % 20 === 0) { plog(`  … ${fi} of ${docs.length} file(s) read`); P.sub(`${fi} of ${docs.length} files`); }
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
      // what inspectFile found decides whether a file is read again for the asset registers or the TRC analysis (no info: both)
      if (!used) { const u = f.__info && f.__info.use; if (!u || u.geo || u.trc) trcFiles.push({ name: f.name, size: f.size, buf, geo: !u || u.geo, trc: !u || u.trc }); }
    }
    for (const p of shotSets()) { if (p.records.length) kpiSets.push(p); else plog(`${KIND_NAME[p.kind]} (${p.scope.section} ${p.scope.line}): no rows with values`); }
    if (W.sets.length || W.usfd.length) { plog(`From the TMS Collector: ${W.sets.length} report(s)${W.usfd.length ? `, USFD defects of ${W.usfdLines.length} section-line(s)` : ''}${W.pages.length ? `, ${W.pages.length} TRC km page(s)` : ''}`); kpiSets.push(...W.sets.filter(x => x.records.length || x.kind === 'omsPeak' || x.kind === 'trcRep'));   /* [E] 21-Oct: an empty repeated list still closes the old items */ }
    if (W.usfd.length) { kpiSets.push({ kind: 'usfd', records: W.usfd, scope: { lines: W.usfdLines }, file: 'USFD defects (TMS Collector)' }); const pend = C.pendingIMR(W.usfd); if (pend.length) kpiSets.push({ kind: 'imr', records: pend, scope: {}, file: 'IMRs still in track (TMS Collector)' }); }
    // asset registers for worksite tagging (read here, before the server calls, so the bar knows every call in advance)
    const geo = {}; const geoFiles = trcFiles.filter(tf => tf.geo && /\.xlsx?$/i.test(tf.name)); let gi = 0;
    if (geoFiles.length) plog(`Reading ${geoFiles.length} asset register(s) for worksite tagging…`);
    for (const tf of geoFiles) {
      const ext = tf.name.split('.').pop().toLowerCase(); await pause(); gi++; P.read = 0.8 + 0.2 * gi / geoFiles.length; if (gi % 10 === 0) { plog(`  … ${gi} of ${geoFiles.length}`); P.sub(`asset registers ${gi} of ${geoFiles.length}`); }
      try { const wb = ext === 'xls' ? C.readXLS(tf.buf) : await C.readXLSX(tf.buf); for (const sh of wb.sheets) { const k = C.classifySheet(sh.rows, sh.name); if (!GEO_NAME[k]) continue; const recs = C.parseSheet(k, sh.rows); const g = geo[k] = geo[k] || { recs: [], files: [] }; g.recs.push(...recs); g.files.push(tf.name); } } catch (e) { /* not a register */ }
    }
    P.read = 1;
    // ---- plan: one server call per report type (split only by size); identical reports are not sent again ----
    for (const s of kpiSets) if (s.kind === 'dfwr') s.scope = U.dfwrDivision ? { division: true } : s.scope;
    const sets = mergeSets(kpiSets); const skipped = []; const todo = [];
    let insp = null; if (out.inspections.length) { const seen = new Set(); insp = out.inspections.filter(r => !seen.has(r.key) && seen.add(r.key)).map(r => Object.assign({}, r, { defects: undefined })); }
    const hk = (k, o) => hashOf(JSON.stringify(o));
    if (insp) { const h = hk('inspections', insp); if (sentBefore('inspections', h)) skipped.push({ kind: 'inspections', file: 'Inspection registers', records: insp.length, scope: {} }); else todo.push({ kind: 'inspections', records: insp, scope: {}, file: 'Inspection registers', h, key: 'inspections' }); }
    for (const s of sets) { const key = s.kind; const h = hk(key, { scope: s.scope, records: s.records }); if (sentBefore(key, h)) skipped.push({ kind: s.kind, file: s.file, records: s.records.length, scope: s.scope, asOn: s.asOn }); else todo.push(Object.assign({ h, key }, s)); }
    const geoTodo = []; for (const [k, g] of Object.entries(geo)) { if (!g.recs.length) continue; const h = hk('geo.' + k, g.recs); if (sentBefore('geo.' + k, h)) skipped.push({ kind: 'geo-' + k, file: g.files.join(', '), records: g.recs.length, scope: { sections: [...new Set(g.recs.map(r => r.section).filter(Boolean))] } }); else geoTodo.push({ k, g, h }); }
    const trcPlan = (pngs.length || W.pages.length) ? 1 : 0;
    P.total = 1 + (out.jurisdiction ? 1 : 0) + todo.reduce((a, s) => a + Math.max(1, Math.ceil((s.records || []).length / (PART[s.kind] || 4000))), 0) + geoTodo.reduce((a, x) => a + Math.ceil(x.g.recs.length / 1500), 0) + (trcPlan ? Math.max(2, Math.ceil(W.pages.length * 5 / 6000) + 1) : 0) + (skipped.length ? 1 : 0) + 4;   // recalculation counts 4
    plog(`Server: ${todo.length + geoTodo.length + (out.jurisdiction ? 1 : 0)} report type(s) to send${skipped.length ? `, ${skipped.length} unchanged since the last upload (not sent again)` : ''}${trcPlan ? ', TRC results' : ''}.`);
    if (skipped.length) plog('  unchanged: ' + skipped.map(x => (KIND_NAME[x.kind] || GEO_NAME[String(x.kind).replace(/^geo-/, '')] || x.kind) + ` (${x.records})`).join(' · '));
    if (out.jurisdiction) { P.step('Jurisdiction'); await callR('ingest', { kind: 'jurisdiction', rows: out.jurisdiction, file: 'Jurisdiction Details' }, { timeout: 360000 }); P.tick(); plog('Jurisdiction stored.'); }
    for (const s of todo) {
      const name = s.kind === 'inspections' ? 'Inspection registers' : (KIND_NAME[s.kind] || s.kind);
      P.step(name + (s.files > 1 ? ` (${s.files} files)` : '')); const ts = Date.now();
      let r;
      try { r = await send(s.kind, { records: s.records, scope: s.scope, asOn: s.asOn || S.B.today, file: s.file || name }); }
      catch (e) {
        // a report the server does not take yet (its reader is the report engine's part) is noted, not a reason to stop the upload
        if (OPTIONAL_KIND.has(s.kind) && /Unknown report type/i.test(e.error || e.message || e)) { plog(`${name}: not taken by TMS Control yet (its reader comes with a TMS Control update) – kept for later`); P.tick(Math.max(1, Math.ceil(s.records.length / (PART[s.kind] || 4000)))); continue; }
        throw e;
      }
      const n = s.records.length; const sec = Math.round((Date.now() - ts) / 1000);
      if (s.kind === 'inspections') plog(`Inspection registers: ${n} read – ${r.inserted} new, ${n - r.inserted} already in the history (unchanged) [${sec} s]`);
      else plog(`${name}${s.files > 1 ? ` (${s.files} files)` : ''}: ${fmtRes(n, r)} [${sec} s]`);
      (r.lines || []).forEach(l => plog(l));
      markSent(s.key, s.h);
    }
    for (const x of geoTodo) {
      const { k, g } = x; P.step(GEO_NAME[k]); const ts = Date.now();
      const secs = [...new Set(g.recs.map(r => r.section).filter(Boolean))]; const parts = chunk(g.recs, 1500);
      for (let i = 0; i < parts.length; i++) { if (parts.length > 1) P.sub(`part ${i + 1} of ${parts.length}`); await callR('ingestGeometry', { kind: k, records: parts[i], sections: secs, append: i > 0, file: g.files.join(', ') }, { timeout: 360000 }); P.tick(); }
      plog(`${GEO_NAME[k]}: ${g.recs.length} rows stored for worksite tagging (${secs.length} section(s)) [${Math.round((Date.now() - ts) / 1000)} s]`); markSent('geo.' + k, x.h);
    }
    if (skipped.length) { P.step('Noting the unchanged reports'); try { await callR('noteUploads', { items: skipped.map(x => Object.assign({}, x, { asOn: x.asOn || S.B.today })) }, { timeout: 120000 }); } catch (e) { plog('  (could not note the unchanged reports: ' + (e.error || e.message || e) + ')'); } P.tick(); }
    if (trcPlan) await runTRC(pngs, trcFiles.filter(tf => tf.trc), W.pages);
    P.step('Recalculating KPIs and jobs'); plog('Recalculating KPIs and jobs…'); const tr = Date.now();
    const rr = await callR('refresh', {}, { timeout: 360000 }); P.tick(4);
    plog('Done: ' + Object.entries(rr).filter(([k]) => /^K|tracker/.test(k)).map(([k, v]) => `${k} ${typeof v === 'object' ? `+${v.inserted}/~${v.updated}/-${v.closed}` : v}`).join(' · ') + ` [${Math.round((Date.now() - tr) / 1000)} s]`);
    (rr.recon || []).forEach(l => plog(l));   // report-engine chat: reconciliation of the TMS lists (5b)
    const slow = P.times.slice().sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l, ms]) => `${l} ${mmss(ms)}`).join(', ');
    plog(`Finished in ${mmss(Date.now() - t0)} – ${P.calls} server call(s). Longest steps: ${slow}.`);
    P.end(true, `Finished in ${mmss(Date.now() - t0)} (${P.calls} server calls)`);
    toast('Upload complete'); collectDone(true); U.files = []; SH.list.filter(x => x.checked).forEach(x => URL.revokeObjectURL(x.url)); SH.list = SH.list.filter(x => !x.checked && x.status !== 'done'); drawShots(); drawQueue(); await T.reload();
  } catch (e) {
    const msg = e.error || e.message || e; plog('ERROR: ' + msg);
    P.end(false, `Stopped at "${P.label}" after ${mmss(Date.now() - P.t0)}: ${String(msg).slice(0, 160)}. Click "Upload and recalculate" to try again – reports already stored are not sent twice.`);
    collectDone(false); fail(e);
  }
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
  // identical TRC results (the same runs sent again) are not sent again
  const h = hashOf(JSON.stringify({ lines, blocks, peaks, todo })); if (sentBefore('trc', h)) { plog('  TRC: the same runs as in the last upload – not sent again.'); P.tick(Math.max(0, P.total - P.done - 4)); return; }
  const id = upid(); const bc = chunk(blocks, 6000), pc = chunk(peaks, 6000); const n = Math.max(bc.length, pc.length); const ts = Date.now();
  P.total += Math.max(0, n + 1 - Math.max(2, Math.ceil(W.pages.length * 5 / 6000) + 1));   // the plan guessed the number of calls
  for (let i = 0; i < n; i++) { P.step('TRC results'); P.sub(`part ${i + 1} of ${n + 1}`); await callR('ingestTRC', { uploadId: id, blocks: bc[i] || [], peaks: pc[i] || [], final: false }, { timeout: 360000 }); P.tick(); }
  P.step('TRC jobs'); P.sub(`part ${n + 1} of ${n + 1}`);
  const r = await callR('ingestTRC', { uploadId: id, lines, todo, final: true, file: (pngs.length ? pngs.length + ' TRC pages' : webPages.length + ' TRC km pages (TMS Collector)') }, { timeout: 360000 }); P.tick();
  markSent('trc', h);
  plog(`  TRC jobs: ${r.inserted} new, ${r.updated} changed, ${r.closed || 0} closed / verified by the new run [${Math.round((Date.now() - ts) / 1000)} s]`);
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
  if (SH.list.length) openManual();
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
// jurisdiction as mapped in TMS (collector): one record per stretch of each SSE in-charge / sectional SSE-JE, its stations,
// and the tree itself (Sr DEN › ADEN › SSE in-charge › sectional SSE/JE). The report engine decides how it is used.
function jurTmsRecords(it) {
  const out = []; const k = (...a) => a.map(x => String(x == null ? '' : x)).join('|');
  for (const u of it.units || []) {
    const base = { level: u.level, unitId: u.id, unit: u.name, inCharge: u.inCharge, inChargeId: u.inChargeId, srden: u.srden, aen: u.aen };
    (u.rows || []).forEach((r, i) => out.push(Object.assign({ rowType: 'stretch', key: k('S', u.level, u.id, r.sectionCode || r.section, r.lineCode || r.line, r.fromKm, r.fromM, i) }, base, { section: r.section, sectionCode: r.sectionCode, line: r.line, lineCode: r.lineCode, fromKm: r.fromKm, fromM: r.fromM, toKm: r.toKm, toM: r.toM, lengthKm: r.lengthKm, raw: r.raw })));
    (u.stations || []).forEach((x, i) => out.push(Object.assign({ rowType: 'station', key: k('T', u.level, u.id, i) }, base, { raw: x })));
  }
  for (const n of it.tree || []) out.push({ rowType: 'node', key: k('N', n.level, n.id), level: n.level, unitId: n.id, unit: n.name, parent: n.parent || '' });
  return out;
}
async function addCollected(items) {
  const files = []; const hist = [];
  for (const it of items) {
    try {
      if (it.type === 'file') { const f = new File([it.bytes], it.name); f.__collector = true; files.push(f); continue; }
      if (it.type === 'trc') { const p = C.trcPageFromTables(it.tables, it.name); if (it.meta) { if (it.meta.part) p.part = +it.meta.part; if (it.meta.sensor && !p.sensor) p.sensor = it.meta.sensor; } if (p.blocks.length || Object.keys(p.peaks).length) W.pages.push(p); else W.notes.push(`${it.name}: not a TRC result page – skipped`); continue; }
      if (it.type === 'paste') { const tp = C.tablesFromPaste(stripScripts(it.html), ''); const k = C.classifyPaste(tp.title); const r = k ? C.parsePaste(k, tp) : null; if (r) { r.file = it.name; W.sets.push(r); } else W.notes.push(`${it.name}: page not recognised – skipped`); continue; }
      if (it.type === 'usfd') { const r = C.usfdDefectsFromPage(it.html); if (r.section && r.line) { W.usfd.push(...r.records); W.usfdLines.push(r.section + '|' + r.line); } else W.notes.push(`${it.name}: section / line not found – skipped`); continue; }
      if (it.type === 'usfdHist') { hist.push(...C.usfdHistFromPage(it.html, it.meta || {})); continue; }
      if (it.type === 'ogSum') { const recs = C.ogSumFromPage(it.html); if (recs.length) W.sets.push({ kind: 'ogSum', records: recs, scope: { division: true }, asOn: S.B.today, file: it.name }); continue; }   // [E] 16-Oct (K15)
      if (it.type === 'trcRep') { const pages = [it.html, it.htmlCbml].filter(Boolean); const lists = pages.map(h => C.trcRepKind(h)).filter(Boolean); const recs = [].concat(...pages.map(h => C.trcRepFromPage(h))); if (lists.length) W.sets.push({ kind: 'trcRep', records: recs, scope: { division: true, lists }, asOn: S.B.today, file: it.name }); else W.notes.push(`${it.name}: repeated UML / CBML page not recognised`); continue; }   // [E] 21-Oct (K8 / K9)
      if (it.type === 'dpc') { const recs = C.dpcFromPage(it.html).map(r => { const o = Object.assign({}, r); delete o.days; delete o.asOn; return o; }); if (recs.length || C.isDpcPage(it.html)) W.sets.push({ kind: 'dpc', records: recs, scope: { division: true }, asOn: S.B.today, file: it.name }); else W.notes.push(`${it.name}: defects page not recognised`); continue; }   // [E] 20-Oct (K10: every category incl. Other / loop lines)
      if (it.type === 'atWelds') { const recs = C.atWeldsFromPage(it.html, it.period); if (recs.length) W.sets.push({ kind: 'atWelds', records: recs, scope: { division: true }, asOn: S.B.today, file: it.name }); continue; }
      if (it.type === 'jurisdictionTms') { const recs = jurTmsRecords(it); if (recs.some(r => r.rowType === 'stretch')) W.sets.push({ kind: 'tmsJurisdiction', records: recs, scope: { division: true }, asOn: it.asOn || S.B.today, file: it.name }); else W.notes.push(`${it.name}: no jurisdiction rows`); continue; }
      if (it.type === 'gmt' || it.type === 'tmsChart' || it.health) { W.notes.push(`${it.name || it.type}: kept for track health – not read yet`); continue; }   // [C] 16-Oct: issue 16 (a)(b), never sent to the server
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
  for (const f of U.files) if (f.__collector && f.__info && !f.__info.ok && UNUSED_REG.test(f.name)) { f.__info.unused = true; f.__info.lines = ['Asset register not used by TMS Control – skipped']; }
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
    // grouped and folded (16-Oct: "These settings should be grouped and minimized/collapsible")
    const G = [['KPI rules', /^(K\d+_|JUR_SOURCE)/], ['Work records and jobs', /^(SSE_CHECK_DAYS|PHOTO_|K14_WARN|K1_WARN)/], ['Measurement limits (IRPWM)', /^LIM_/], ['Users and phones', /^(MaxDevices|DEVICE_)/], ['System (written by push.bat – normally not changed)', /./]];
    const grp = G.map(g => ({ t: g[0], rows: [] })); st.settings.forEach(x => { const i = G.findIndex(g => g[1].test(x.Key)); grp[i].rows.push(x); });
    const fold = (title, body, open) => `<details class="panel body setgrp"${open ? ' open' : ''}><summary class="sec" style="cursor:pointer;padding:10px 14px;font-weight:600">${title}</summary><div style="padding:0 14px 12px">${body}</div></details>`;
    const setTable = rows => `<div class="scroll"><table class="t"><thead><tr><th>Setting</th><th>Value</th><th>Meaning</th></tr></thead><tbody>${rows.map(s => `<tr><td class="nw"><b>${esc(s.Key)}</b></td><td><input data-k="${esc(s.Key)}" value="${esc(s.Value)}" style="width:220px;padding:4px 6px;border:1px solid #b9bfc9"></td><td class="small wrap">${esc(s.Note)}</td></tr>`).join('')}</tbody></table></div>`;
    $('setw').innerHTML = `<div class="panel body" style="padding:12px 14px"><div class="row"><button class="btn primary" id="saveSet">Save settings</button><button class="btn secondary" id="recalc">Recalculate now</button><span class="small muted">Open a group to change it. Changes apply at the next recalculation.</span></div></div>`
      + fold('Audit against TMS – trips, field days, pending defects per unit <span class="muted small">(read only)</span>', `<div id="audw"><p class="small">Opens the check (about a minute on the live server).</p><button class="btn sm secondary" id="audGo">Run the audit</button></div>`)   // [E] 20-Oct
      + fold('Line by line – foot plate / trolley as the manual monitoring sheet counts <span class="muted small">(read only, with the trips behind every line)</span>', `<div id="lcw"><p class="small">For every PWI: lines in the jurisdiction, lines fully covered by foot plate / rear vehicle 1st–15th and 16th–end, and by push trolley / on foot (two months, line by line) – each line with the km still missing and the trips that covered it. TMS's own marks count % km short (KPI-2 line-wise, KPI-3 section-wise); both are shown.</p><button class="btn sm secondary" id="lcGo">Show line by line</button></div>`)   // [E] 21-Oct
      + fold('Version check – push.bat, Recalculate, collector <span class="muted small" id="vchkS">(checking…)</span>', `<div id="vchkw"><p class="small">Checking…</p></div>`)   // [E] 17-Oct; opens by itself when something is to do
      + grp.filter(g => g.rows.length).map(g => fold(`${esc(g.t)} <span class="muted small">(${g.rows.length})</span>`, setTable(g.rows))).join('')
      + fold('Target days by job type', `<div class="scroll"><table class="t"><thead><tr><th>Job type</th><th>SSE to complete (days)</th><th>AEN to approve (days)</th><th>Photo required</th><th>Closes by TMS data</th></tr></thead><tbody>${st.targets.map(t => `<tr><td>${esc(t.Description)}<div class="small muted">${esc(t.JobType)} · ${esc(t.KPI)}</div></td><td><input type="number" data-t="${esc(t.JobType)}" data-f="SSEDays" value="${esc(t.SSEDays)}" style="width:80px"></td><td><input type="number" data-t="${esc(t.JobType)}" data-f="AENDays" value="${esc(t.AENDays)}" style="width:80px"></td><td><select data-t="${esc(t.JobType)}" data-f="PhotoRequired"><option ${t.PhotoRequired === 'Yes' ? 'selected' : ''}>Yes</option><option ${t.PhotoRequired !== 'Yes' ? 'selected' : ''}>No</option></select></td><td class="small">${esc(t.ClosedByData)}</td></tr>`).join('')}</tbody></table></div>`)
      + fold('Sheet backups', `<p class="small">Every morning at 05:00 a dated copy of the whole Google Sheet is saved in the Drive folder <b>TMS Control backups</b> (copies are never deleted). Google Sheets also keeps every change under File → Version history.</p>
      <p id="bkInfo">${st.backup && st.backup.last ? 'Last copy: <b>' + esc(String(st.backup.last).replace('T', ' ').slice(0, 16)) + '</b>' : 'No copy made yet.'}${st.backup && st.backup.folderUrl ? ` · <a href="${esc(st.backup.folderUrl)}" target="_blank" rel="noopener">Open the backup folder</a>` : ''}</p>
      <div class="row"><button class="btn secondary" id="bkNow">Back up now</button></div>`)
      + fold('Close old jobs (clean start)', `<div id="csw"><p class="small">Loading…</p></div>`)
      + fold('Jurisdiction: TMS compared with the file', `<div id="jcw">${jurCompareHtml(st.jurCompare, st.jurSource)}</div>`);
    cleanStartPanel();
    const vfill = fresh => window.versionCheck && versionCheck(fresh).then(r => { const w = $('vchkw'); if (!w) return; const n = r.filter(x => x.ok === false).length;
      w.innerHTML = versionHtml(r) + '<div class="row"><button class="btn sm secondary" id="vchkR">Check again</button></div>'; $('vchkR').onclick = () => { $('vchkS').textContent = '(checking…)'; vfill(true); };
      const sm = $('vchkS'); if (sm) sm.innerHTML = n ? `<b style="color:var(--crit)">(${n} to do)</b>` : '(all in order)'; if (n) w.closest('details').open = true; }).catch(() => { });   // [E] 17-Oct
    vfill();
    $('lcGo').onclick = async e => { e.target.disabled = true; e.target.textContent = 'Working…'; try { const r = await call('lineCheck', {}, { timeout: 360000 }); $('lcw').innerHTML = lineCheckHtml(r); } catch (er) { fail(er); e.target.disabled = false; e.target.textContent = 'Show line by line'; } };   // [E] 21-Oct
    $('audGo').onclick = async e => { e.target.disabled = true; e.target.textContent = 'Working…'; try { const r = await call('audit', {}, { timeout: 360000 }); $('audw').innerHTML = auditHtml(r); } catch (er) { fail(er); e.target.disabled = false; e.target.textContent = 'Run the audit'; } };   // [E] 20-Oct
    $('saveSet').onclick = async () => {
      const settings = [...document.querySelectorAll('[data-k]')].map(i => ({ Key: i.dataset.k, Value: i.value }));
      const tm = {}; document.querySelectorAll('[data-t]').forEach(i => { (tm[i.dataset.t] = tm[i.dataset.t] || { JobType: i.dataset.t })[i.dataset.f] = i.value; });
      try { await call('saveSettings', { settings, targets: Object.values(tm) }); toast('Saved'); } catch (e) { fail(e); }
    };
    $('bkNow').onclick = async e => { e.target.disabled = true; try { const r = await call('backupNow', {}, { timeout: 300000 }); $('bkInfo').innerHTML = `Saved: <b>${esc(r.name)}</b> · <a href="${esc(r.url)}" target="_blank" rel="noopener">open the copy</a>`; toast('Backup saved'); } catch (er) { fail(er); } e.target.disabled = false; };
    $('recalc').onclick = async e => { e.target.disabled = true; try { const r = await call('refresh', {}, { timeout: 360000 }); (r.recon || []).forEach(l => toast(l)); toast('Recalculated in ' + r.seconds + ' s'); await T.reload(); } catch (er) { fail(er); } e.target.disabled = false; };
  } catch (e) { fail(e); }
};
// [E] 20-Oct: Audit against TMS – what is stored, per unit, to set against TMS's own registers / dashboard or a manual sheet
// [E] 21-Oct: line by line (the manual monitoring sheet's way of counting) with the trips behind every line
function lineCheckHtml(r) {
  const ty = { FP: 'FP', RV: 'RV', FOOT: 'on foot', TROLLEY: 'trolley' };
  const ev = p => p.done ? `<span class="tag ok">done</span>${p.guess ? ' <span class="tag warn" title="credited because the route name of the trip is not known here">route?</span>' : ''}` : `<span class="tag crit">km ${esc(p.miss)}</span>`;
  const by = p => p.by.map(b => `${esc(String(b.date).slice(8, 10) + '-' + String(b.date).slice(5, 7))} ${esc(ty[b.type] || b.type)} ${esc(b.desig)} ${esc(b.route)} ${esc(b.line)} ${esc(b.km)}${b.guess ? ' (route?)' : ''}`).join('<br>') + (p.byN > p.by.length ? `<br>… ${p.byN - p.by.length} more` : '');
  const pc = (a, n) => n ? Math.round(a / n * 1000) / 10 + ' %' : '–';
  const T = r.units.reduce((a, u) => { a.n += u.n; a.f1 += u.fp1; a.f2 += u.fp2; a.pt += u.pt; return a; }, { n: 0, f1: 0, f2: 0, pt: 0 });
  const sum = `<div class="scroll"><table class="t compact"><thead><tr><th>PWI</th><th>Lines</th><th>FP 1st–15th done</th><th>short</th><th>FP 16th–end done</th><th>short</th><th>Trolley / on foot done</th><th>short</th><th>TMS marks K2 / K3 (forecast)</th></tr></thead><tbody>${r.units.map(u => `<tr><td><b>${esc(u.unit)}</b></td><td class="n">${u.n}</td><td class="n">${u.fp1}</td><td class="n">${u.n - u.fp1 || ''}</td><td class="n">${u.fp2}</td><td class="n">${u.n - u.fp2 || ''}</td><td class="n">${u.pt}</td><td class="n">${u.n - u.pt || ''}</td><td class="n">${[u.k2, u.k3].map(x => x == null || x === '' ? '–' : x).join(' / ')}</td></tr>`).join('')}
    <tr><td><b>Total</b></td><td class="n"><b>${T.n}</b></td><td class="n">${T.f1} (${pc(T.f1, T.n)})</td><td class="n">${T.n - T.f1}</td><td class="n">${T.f2} (${pc(T.f2, T.n)})</td><td class="n">${T.n - T.f2}</td><td class="n">${T.pt} (${pc(T.pt, T.n)})</td><td class="n">${T.n - T.pt}</td><td></td></tr></tbody></table></div>`;
  const det = r.units.map(u => `<details><summary><b>${esc(u.unit)}</b> – ${u.n} lines · FP ${u.fp1} / ${u.fp2} · trolley ${u.pt}</summary><div class="scroll"><table class="t compact"><thead><tr><th>Section · line · km</th><th>FP 1st–15th</th><th>FP 16th–end</th><th>Trolley / on foot (2 months)</th></tr></thead><tbody>${u.lines.map(l => `<tr><td class="nw">${esc(l.section)} · <b>${esc(l.line)}</b> · ${esc(l.km)}${l.speed ? ` <span class="muted">${l.speed} km/h</span>` : ''}</td><td>${ev(l.fp1)}<div class="small muted">${by(l.fp1)}</div></td><td>${ev(l.fp2)}<div class="small muted">${by(l.fp2)}</div></td><td>${ev(l.pt)}<div class="small muted">${by(l.pt)}</div></td></tr>`).join('')}</tbody></table></div></details>`).join('');
  return `<p class="small">Month <b>${esc(r.month)}</b>, as on ${esc(dmy(r.today))}; inspection registers last received ${esc(String(r.lastInspUpload).replace('T', ' ').slice(0, 16))} (trips entered in TMS later are not in yet). A line is "done" only when every km of it is covered – the manual sheet's way; TMS's own marks count the km short, so a line short by 1 km of 90 costs only about 1 %.</p>` + sum + det
    + `<p class="small muted">Lines = the jurisdiction as mapped in TMS (section by section, short stubs and chord / loop lines included – a sheet that leaves them out shows fewer lines). Trolley / on foot: speed > 110 km/h on foot or trolley, else trolley (TMS KPI-3 rule), here line by line; TMS scores it per section-km, so a section covered on one of its lines counts for TMS.</p>`;
}
function auditHtml(r) {
  const dd = a => (a || []).map(d => d.slice(8, 10)).join(' ') || '–';
  const CAT = { PXING_ML: 'P&C ML', PXING_PRL: 'P&C PRL', PXING_JOINT_ML: 'Joint P&C ML', PXING_JOINT_PRL: 'Joint P&C PRL', LWR: 'LWR', SEJ: 'SEJ', BR: 'Bridge', LC: 'LC', CURVE: 'Curve', TRC: 'TRC', OMS: 'OMS', OTHER: 'Other insp.', LOOP: 'Loop line' };
  const cats = o => Object.keys(o || {}).map(k => `${CAT[k] || k} ${o[k].late}/${o[k].open}`).join(', ') || '–';
  const head = `<p class="small">As on <b>${esc(dmy(r.today))}</b>. Inspection rows: ${r.inspections.rows} – ${r.inspections.dateToRepair ? `<b style="color:var(--crit)">${r.inspections.dateToRepair} still with a date one day off (repaired at the next Recalculate)</b>` : 'all dates agree with TMS'}; ${r.inspections.sameAs} duplicate copies set aside. Pending defects from TMS's own list: ${r.dpc.rows ? r.dpc.rows + ' rows since ' + esc(dmy(r.dpc.first)) : '<b>not collected yet – run the TMS Collector (report "Defects pending for compliance")</b>'}.</p>
    <p class="small muted">Days are the dates of the in-charge's trips as stored (TMS Inspection Register: foot plate 20 / 20N, rear vehicle 25; push trolley 19, on foot 26). Pending defects: &gt;10 days / pending, counted the TMS way (both days).</p>`;
  const rows = r.units.map(u => `<tr><td class="nw"><b>${esc(u.unit)}</b></td><td>${dd(u.fp1)}</td><td>${dd(u.fp2)}</td><td>${dd(u.trolley.filter(d => d.slice(0, 7) === r.month))}<br><span class="muted small">prev: ${dd(u.trolley.filter(d => d.slice(0, 7) !== r.month))}</span></td><td class="n">${u.fieldDays}</td>
    <td class="n">${u.dpcLate}/${u.dpcOpen}${u.dpcOpen ? ' <span class="muted">(' + u.dpcPct + ' %)</span>' : ''}</td><td class="small">${esc(cats(u.dpcByCat))}${u.lateList.length ? '<details><summary class="small">list</summary><div class="small">' + u.lateList.map(esc).join('<br>') + '</div></details>' : ''}</td><td class="n">${u.lnaOpen}</td>
    <td class="n">${[u.k2, u.k3, u.k10, u.k16].map(x => x == null || x === '' ? '–' : x).join(' / ')}</td></tr>`).join('');
  return head + `<div class="scroll"><table class="t"><thead><tr><th>Unit</th><th>Foot plate / RV days 1–15</th><th>16–end</th><th>Trolley / on-foot days (this + previous month)</th><th>Field days</th><th>Defects &gt;10 d / pending (TMS)</th><th>By category (&gt;10 d / pending)</th><th>LNA open</th><th>K2 / K3 / K10 / K16 marks</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
// jurisdiction as mapped in TMS (collector, weekly) compared with the Jurisdiction Details file – the KPIs still use the file
function jurCompareHtml(c, src) {
  if (!c) return '<p class="small">Not received yet – the TMS Collector sends "Jurisdiction as mapped in TMS" with its weekly reports.</p>';
  const t = c.totals || {}; const km = m => (m / 1000).toFixed(3); const rng = x => `${km(x.a)}–${km(x.b)}`;
  const tab = (head, rows) => rows.length ? `<div class="scroll"><table class="t compact"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="small muted">None.</p>';
  return `<p class="small">Received ${esc(String(c.when).replace('T', ' ').slice(0, 16))}. TMS: <b>${t.tms?.units}</b> SSE in-charge, ${t.tms?.stretches} stretches, ${t.tms?.km} km · file: ${t.file?.units} units, ${t.file?.stretches} rows, ${t.file?.km} km. ${String(src || 'TMS').toUpperCase() === 'TMS' ? '<b>The KPIs and jobs use the TMS jurisdiction</b> (speed from the file) – setting JUR_SOURCE under KPI rules (File = the file only).' : '<b>The KPIs and jobs use the file</b> – setting JUR_SOURCE = File.'}</p>
    <h4>In TMS, not in the file (${t.onlyTmsKm} km)</h4>${tab(['Section', 'Line', 'km', 'Unit (TMS)'], (c.onlyTms || []).map(x => [x.section, x.line, rng(x), x.unit]))}
    <h4>In the file, not in TMS (${t.onlyFileKm} km)</h4>${tab(['Section', 'Line', 'km', 'Unit (file)'], (c.onlyFile || []).map(x => [x.section, x.line, rng(x), x.unit]))}
    <h4>Different unit (${t.unitDiffKm} km)</h4>${tab(['Section', 'Line', 'km', 'File', 'TMS'], (c.unitDiff || []).map(x => [x.section, x.line, rng(x), x.unit, x.other]))}
    <h4>Different km at the ends of a unit's stretch (${t.kmDiffKm} km)</h4>${tab(['Unit', 'Section', 'Line', 'km', 'Only in'], (c.kmDiff || []).map(x => [x.unit, x.section, x.line, rng(x), x.side === 'tms' ? 'TMS' : 'file']))}`;
}
// one-off clean start (15-Oct-2026): close every job created before 10-10-2026 except TRC jobs; open TMS items come back as fresh jobs
async function cleanStartPanel() {
  const w = $('csw'); if (!w) return;
  try {
    const p = await call('cleanStartPreview', { before: S.B.today });
    w.innerHTML = `<p class="small">Close every open job created before a date you choose (all units, or use "Close jobs created before a date…" on All jobs for one type / unit). Nothing is deleted. Items still open in the latest TMS reports come back as fresh jobs. TRC and chronic jobs stay open unless you tick them.</p>
      <p class="small">Open jobs created before today: <b>${p.count}</b>${p.trcKept ? ` (+ ${p.trcKept} TRC / chronic)` : ''}.${p.done ? ` Last run: ${esc(String(p.done).split(' | ')[0])}.` : ''}</p><div class="row"><button class="btn primary" id="csGo">Close jobs created before a date…</button></div>`;
    $('csGo').onclick = () => T.closeByDate({ before: p.done ? S.B.today : '2026-10-10', done: () => cleanStartPanel() });
  } catch (e) { w.innerHTML = `<p class="od">${esc(e.error || e.message || e)}</p>`; }
}
V.uploads = async el => {
  el.innerHTML = T.pageHead('Upload history', 'Every upload, newest first') + `<div class="panel body" id="uph"><div class="empty">Loading…</div></div>`;
  try { const L = (await call('uploads')).reverse(); $('uph').innerHTML = `<div class="scroll"><table class="t"><thead><tr><th>When</th><th>By</th><th>Report</th><th>File</th><th>As on</th><th>Records</th><th>New</th><th>Closed</th><th>Note</th></tr></thead><tbody>${L.map(u => `<tr><td class="nw">${esc(String(u.When).replace('T', ' '))}</td><td>${esc(u.By)}</td><td>${esc(KIND_NAME[u.Kind] || u.Kind)}</td><td class="small wrap">${esc(u.File)}</td><td class="nw">${dmy(u.AsOn)}</td><td class="n">${u.Records}</td><td class="n">${u.New}</td><td class="n">${u.Closed}</td><td class="small wrap">${esc(u.Note)}</td></tr>`).join('')}</tbody></table></div>`; } catch (e) { fail(e); }
};
if (S.B) T.render();
})();
