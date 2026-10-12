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
const U = { files: [], pastes: [], log: [], running: false, dfwrDivision: true };
const GEO_NAME = { curve: 'Curve register', pxing: 'P&C register', lc: 'LC register', sej: 'SEJ register', glued: 'Glued joint register', diamond: 'Diamond crossing register' };
const KIND_NAME = { 'geo-curve': 'Curve register (worksite tagging)', 'geo-pxing': 'P&C register (worksite tagging)', 'geo-lc': 'LC register (worksite tagging)', 'geo-sej': 'SEJ register (worksite tagging)', 'geo-glued': 'Glued joint register (worksite tagging)', 'geo-diamond': 'Diamond crossing register (worksite tagging)', jog: 'Welds needing joggled plates', weldSum: 'AT weld count', fpSum: 'Main-line FP joint count', inspections: 'Inspection register', assetInsp: 'Latest inspection report', lna: 'Locations needing attention', dfwr: 'DFWR analysis', og: 'Overdue oiling & greasing', fracture: 'Fracture analysis', official: 'TMS item-wise score', jurisdiction: 'Jurisdiction details', oms: 'OMS comparative summary (pasted)', imr: 'IMR history (pasted)', weldReg: 'Weld register', trc: 'TRC km-wise pages' };
V.upload = async el => {
  el.innerHTML = T.pageHead('Upload TMS data', 'Admin – every upload is added to the history; nothing older is overwritten') + `<div class="grid2">
    <div><div id="drop" class="drop" tabindex="0"><svg class="dropsvg" viewBox="0 0 48 48"><path d="M6 14h14l4 4h18v22H6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 36V24m-5 5l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      <div class="droptitle">Click <b>Select files</b> and pick the reports</div><div class="dropsub">TMS PDFs, XLS / XLSX reports, TRC km-wise PNG pages. In the file window you can select many files at once (Ctrl+A or Ctrl+click).</div>
      <div class="btnrow"><button id="pkFiles" class="btn primary">Select files</button><button id="pkFolder" class="btn secondary">Select a whole folder</button></div>
      <div class="dropsub small" style="margin-top:10px">Dragging files onto this box also works in Chrome and Edge. If a dragged file opens in a new tab instead, use the buttons.</div>
      <input id="inFolder" type="file" webkitdirectory multiple hidden><input id="inFiles" type="file" multiple hidden accept=".png,.xls,.xlsx,.pdf"></div>
      <div class="panel" style="margin-top:16px"><div class="panelhead"><span>Paste from a TMS web page</span><span class="muted">for reports that cannot be downloaded (IMR history, OMS comparative summary)</span></div>
      <div style="padding:12px"><div id="paste" class="pastebox" tabindex="0" contenteditable="true">Open the TMS report page → press Ctrl+A then Ctrl+C → click here and press Ctrl+V</div></div></div>
      <div class="panel"><div class="panelhead"><span>Ready to upload</span><span class="right"><label class="small"><input type="checkbox" id="dfwrDiv" ${U.dfwrDivision ? 'checked' : ''}> DFWR file covers the whole division</label></span></div><div id="queue" style="padding:10px 14px"></div>
      <div style="padding:0 14px 14px" class="row"><button id="btnGo" class="btn primary">Upload and recalculate</button><button id="btnClr" class="btn secondary">Clear</button></div></div>
      <div class="plog" id="plog">${esc(U.log.join('\n')) || 'Progress will appear here.'}</div></div>
    <div><div class="panel body"><h3 class="sec">Upload checklist</h3><div id="chk"><div class="empty">Loading…</div></div></div></div></div>`;
  wireDrop(); drawQueue();
  try { const st = await call('dataStatus'); $('chk').innerHTML = `<div class="scroll"><table class="t"><thead><tr><th>Report</th><th>How often</th><th>Last upload</th><th>Records</th></tr></thead><tbody>${st.map(r => `<tr><td class="wrap">${esc(r.what)}</td><td class="nw small">${esc(r.when)}</td><td class="nw">${r.last ? dmy(r.last) + `<div class="small">as on ${dmy(r.asOn)}</div>` : '<span class="od">never</span>'}</td><td class="n">${r.records ?? ''}</td></tr>`).join('')}</tbody></table></div>`; } catch (e) { fail(e); }
};
function plog(m) { U.log.push(m); const p = $('plog'); if (p) { p.textContent = U.log.join('\n'); p.scrollTop = p.scrollHeight; } }
function drawQueue() {
  const q = $('queue'); if (!q) return;
  const png = U.files.filter(f => /\.png$/i.test(f.name)).length, oth = U.files.length - png;
  q.innerHTML = (U.files.length || U.pastes.length) ? `<div>${oth} report file(s), ${png} TRC page(s)${U.pastes.length ? `, ${U.pastes.length} pasted table(s): ${U.pastes.map(p => esc(KIND_NAME[p.kind])).join(', ')}` : ''}</div>` : '<div class="muted">Nothing selected yet.</div>';
}
function addFiles(list) { const have = new Set(U.files.map(f => f.name + '|' + f.size)); for (const f of list) if (/\.(png|xls|xlsx|pdf)$/i.test(f.name) && !/^~\$/.test(f.name) && !have.has(f.name + '|' + f.size)) U.files.push(f); drawQueue(); }
function wireDrop() {
  $('pkFolder').onclick = e => { e.stopPropagation(); $('inFolder').click(); }; $('pkFiles').onclick = e => { e.stopPropagation(); $('inFiles').click(); };
  $('drop').onclick = e => { if (!e.target.closest('button,input')) $('inFiles').click(); }; $('drop').style.cursor = 'pointer';
  const picked = e => { const n = U.files.length; addFiles([...e.target.files]); e.target.value = ''; const a = U.files.length - n; toast(a ? `${a} file(s) added. Click "Upload and recalculate".` : 'No new PDF / XLS / XLSX / PNG files in that selection.', !a); };
  $('inFolder').onchange = picked; $('inFiles').onchange = picked;
  $('btnClr').onclick = () => { U.files = []; U.pastes = []; U.log = []; drawQueue(); $('plog').textContent = 'Progress will appear here.'; };
  $('btnGo').onclick = () => runUpload();
  $('dfwrDiv').onchange = e => U.dfwrDivision = e.target.checked;
  const pb = $('paste');
  pb.onfocus = () => { if (/^Open the TMS/.test(pb.textContent)) pb.textContent = ''; };
  pb.addEventListener('paste', e => {
    e.preventDefault(); const html = e.clipboardData.getData('text/html'), text = e.clipboardData.getData('text/plain');
    const tb = C.tablesFromPaste(html, text); const k = C.classifyPaste(tb.title + ' ' + text.slice(0, 3000));
    if (!k) { toast('This page was not recognised (IMR history or OMS comparative summary expected)', true); return; }
    const r = C.parsePaste(k, { tables: tb.tables, title: text.slice(0, 4000) });
    if (!r || !r.records.length) { toast('No rows found in the pasted page', true); return; }
    U.pastes.push(r); pb.textContent = `Added: ${KIND_NAME[r.kind]} – ${r.records.length} rows. Paste the next page if you have one.`; drawQueue();
  });
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
  if (r.files.length) addFiles(r.files);
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
const upid = () => 'UP' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
async function send(kind, payload, size = 1500) {
  const recs = payload.records || []; const id = upid(); const parts = recs.length ? chunk(recs, size) : [[]]; let tot = { inserted: 0, updated: 0, closed: 0 };
  for (let i = 0; i < parts.length; i++) { const r = await call('ingest', Object.assign({}, payload, { kind, records: parts[i], uploadId: id, final: i === parts.length - 1, total: recs.length })); for (const k in tot) tot[k] += r[k] || 0; }
  return tot;
}
async function runUpload() {
  if (U.running) return; if (!U.files.length && !U.pastes.length) { toast('Select files first', true); return; }
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
          if (C.isRegister(pages)) { const R = C.parseRegister(pages); out.inspections.push(...R); plog(`  ${f.name}: inspection register – ${R.length} inspections (${R[0] ? R[0].type : ''})`); used = true; }
        } else {
          const wb = ext === 'xls' ? C.readXLS(buf) : await C.readXLSX(buf);
          for (const sh of wb.sheets) {
            const k = C.classifyKpiSheet(sh.rows, sh.name); if (!k) continue; used = true;
            if (k === 'jurisdiction') { out.jurisdiction = sh.rows; plog(`  ${f.name}: jurisdiction details`); continue; }
            if (k === 'weldReg') { const w = C.parseKpiSheet(k, sh.rows, sh.name); const d = C.weldDigest(w.records); kpiSets.push({ kind: 'jog', records: d.pending, scope: w.scope, file: f.name }); kpiSets.push({ kind: 'weldSum', records: d.totals, scope: w.scope, file: f.name }); plog(`  ${f.name}: weld register – ${w.records.length} welds, ${d.needing} need joggled plates, ${d.pending.length} not joggled`); used = false; continue; }
            if (k === 'fpReg') { const r = C.parseKpiSheet(k, sh.rows, sh.name); r.file = f.name; kpiSets.push(r); plog(`  ${f.name}: FP joint register – main-line joints counted for K15`); used = false; continue; }
            const r = C.parseKpiSheet(k, sh.rows, sh.name); r.file = f.name; kpiSets.push(r); plog(`  ${f.name}${wb.sheets.length > 1 ? ' [' + sh.name + ']' : ''}: ${KIND_NAME[k]} – ${r.records.length} rows`);
          }
        }
      } catch (e) { plog(`  ${f.name}: could not read – ${e.message}`); continue; }
      if (!used) trcFiles.push({ name: f.name, size: f.size, buf });
    }
    for (const p of U.pastes) kpiSets.push(p);
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
      if (!g.recs.length) continue; const secs = [...new Set(g.recs.map(r => r.section).filter(Boolean))]; const parts = chunk(g.recs, 2000);
      for (let i = 0; i < parts.length; i++) await call('ingestGeometry', { kind: k, records: parts[i], sections: secs, append: i > 0, file: g.files.join(', ') });
      plog(`${GEO_NAME[k]}: ${g.recs.length} rows stored for worksite tagging (${secs.length} section(s))`);
    }
    if (pngs.length) await runTRC(pngs, trcFiles);
    plog('Recalculating KPIs and jobs…'); const rr = await call('refresh'); plog('Done: ' + Object.entries(rr).filter(([k]) => /^K|tracker/.test(k)).map(([k, v]) => `${k} ${typeof v === 'object' ? `+${v.inserted}/~${v.updated}/-${v.closed}` : v}`).join(' · '));
    plog(`Finished in ${Math.round((Date.now() - t0) / 1000)} s.`); toast('Upload complete'); U.files = []; U.pastes = []; drawQueue(); await T.reload();
  } catch (e) { plog('ERROR: ' + (e.error || e.message || e)); fail(e); }
  U.running = false; const b = $('btnGo'); if (b) b.disabled = false;
}
async function runTRC(pngs, trcFiles) {
  plog(`Reading ${pngs.length} TRC page(s)… (pages read before are remembered)`);
  const store = await C.ingest(engine, trcFiles, () => {});
  const pages = await readPages(pngs, (d, n) => { if (d % 25 === 0 || d === n) plog(`  TRC pages ${d} / ${n}`); });
  for (const p of pages) store.pages.push(p);
  const notTrc = pages.filter(p => (p.problems || []).some(x => /Not a TMS km-wise result page/.test(x)));
  if (notTrc.length) plog(`  ${notTrc.length} picture(s) are not TRC km-wise pages and were skipped: ${notTrc.slice(0, 5).map(p => p.file).join('; ')}${notTrc.length > 5 ? ' …' : ''}\n  Screenshots of IMR or OMS pages cannot be read. Open that page in TMS, press Ctrl+A then Ctrl+C, and paste it into the box "Paste from a TMS web page".`);
  const bad = pages.filter(p => p.problems && p.problems.length && !notTrc.includes(p)); if (bad.length) plog(`  ${bad.length} page(s) need attention: ` + bad.slice(0, 5).map(p => p.file + ' (' + p.problems.join(', ') + ')').join('; '));
  const R = C.analyse(store);
  if (!R.lines.length) { plog('  No TRC lines found in the pages.'); return; }
  const lineOf = Object.fromEntries(R.lines.map(l => [l.lineId, l]));
  const lines = R.lines.map(l => ({ lineId: l.lineId, section: l.section, line: l.line, run: l.run, speed: l.speed, blocks: l.blocks, cbml: l.cbml, tmsN: l.tmsN, pml: l.pml, umlPeaks: l.umlPeaks, atRisk: l.atRisk }));
  const blocks = R.blocks.map(b => ({ lineId: b.lineId, section: b.section, line: b.line, run: b.run, km: b.km, block: b.block, irpwm: b.irpwm, MI: b.MI, risk: b.risk, TQIC: b.TQIC }));
  const peaks = R.peaks.map(p => ({ lineId: p.lineId, section: p.section, line: p.line, run: p.run, km: p.km, pos: p.pos, param: p.param, value: p.value, status: p.status }));
  const todo = R.todo.map(t => { const l = lineOf[t.lineId] || {}; return Object.assign({}, t, { section: l.section, line: l.line, run: l.run }); });
  plog(`  TRC: ${lines.length} line(s), ${blocks.length} blocks, ${todo.length} jobs – uploading…`);
  const id = upid(); const bc = chunk(blocks, 3000), pc = chunk(peaks, 3000);
  for (let i = 0; i < Math.max(bc.length, pc.length); i++) await call('ingestTRC', { uploadId: id, blocks: bc[i] || [], peaks: pc[i] || [], final: false });
  const r = await call('ingestTRC', { uploadId: id, lines, todo, final: true, file: pngs.length + ' TRC pages' });
  plog(`  TRC jobs: ${r.inserted} new, ${r.updated} updated, ${r.closed || 0} closed / verified by the new run`);
}

// ---------- users ----------
V.users = async el => {
  el.innerHTML = T.pageHead('Users', 'Only users listed here can open the app – each with a personal link', `<button class="btn primary right" id="addU">Add user</button>`) + `<div class="panel body" id="ulist"><div class="empty">Loading…</div></div>`;
  $('addU').onclick = () => userForm();
  try { const L = await call('users'); drawUsers(L); } catch (e) { fail(e); }
};
function drawUsers(L) {
  $('ulist').innerHTML = `<div class="scroll"><table class="t"><thead><tr><th>Name</th><th>Role</th><th>Scope</th><th>Contact</th><th>Status</th><th>Phones</th><th>Last seen</th><th></th></tr></thead><tbody>${L.map(u => `<tr><td><b>${esc(u.Name)}</b></td><td>${esc(u.RoleName)}</td><td>${esc(u.Scope)}</td><td class="small">${esc(u.Email)}<br>${esc(u.Mobile)}</td><td>${u.Status === 'Active' ? '<span class="tag tg">Active</span>' : '<span class="tag t1">' + esc(u.Status) + '</span>'}</td><td class="n">${u.Devices} / ${u.MaxDevices || 2}${u.Pending ? `<div class="od">${u.Pending} waiting</div>` : ''}</td><td class="nw small">${esc(String(u.LastSeen || '—').replace('T', ' '))}</td>
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
      <div style="padding:12px 14px" class="row"><button class="btn primary" id="saveSet">Save settings</button><button class="btn secondary" id="recalc">Recalculate now</button></div></div>`;
    $('saveSet').onclick = async () => {
      const settings = [...document.querySelectorAll('[data-k]')].map(i => ({ Key: i.dataset.k, Value: i.value }));
      const tm = {}; document.querySelectorAll('[data-t]').forEach(i => { (tm[i.dataset.t] = tm[i.dataset.t] || { JobType: i.dataset.t })[i.dataset.f] = i.value; });
      try { await call('saveSettings', { settings, targets: Object.values(tm) }); toast('Saved'); } catch (e) { fail(e); }
    };
    $('recalc').onclick = async e => { e.target.disabled = true; try { const r = await call('refresh'); toast('Recalculated in ' + r.seconds + ' s'); await T.reload(); } catch (er) { fail(er); } e.target.disabled = false; };
  } catch (e) { fail(e); }
};
V.uploads = async el => {
  el.innerHTML = T.pageHead('Upload history', 'Every upload, newest first') + `<div class="panel body" id="uph"><div class="empty">Loading…</div></div>`;
  try { const L = (await call('uploads')).reverse(); $('uph').innerHTML = `<div class="scroll"><table class="t"><thead><tr><th>When</th><th>By</th><th>Report</th><th>File</th><th>As on</th><th>Records</th><th>New</th><th>Closed</th><th>Note</th></tr></thead><tbody>${L.map(u => `<tr><td class="nw">${esc(String(u.When).replace('T', ' '))}</td><td>${esc(u.By)}</td><td>${esc(KIND_NAME[u.Kind] || u.Kind)}</td><td class="small wrap">${esc(u.File)}</td><td class="nw">${dmy(u.AsOn)}</td><td class="n">${u.Records}</td><td class="n">${u.New}</td><td class="n">${u.Closed}</td><td class="small wrap">${esc(u.Note)}</td></tr>`).join('')}</tbody></table></div>`; } catch (e) { fail(e); }
};
if (S.B) T.render();
})();
