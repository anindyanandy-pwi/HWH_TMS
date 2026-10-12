// TMS Control – field work: work records (measurements, work done, stamped photos), offline queue, review, location history, My position.
(function () {
'use strict';
const T = window.TMSC, V = window.TMSC_VIEWS, ST = window.TMSC_STORE, STN = window.STN;
const { call, esc, dmy, modal, toast, S, $, fail, stc } = T;
const role = () => T.role();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const chStr = p => p == null ? '' : Math.floor(p / 1000) + '.' + String(Math.round((p % 1000) * 10) / 10).padStart(3, '0');
const nowIso = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const F = { records: [], local: [], geo: null, flushing: false };
const WORK_TYPES = ['Packing (manual)', 'Re-gauging', 'Liner / pad replacement', 'ERC / fastening renewal', 'Sleeper renewal', 'Sleeper re-spacing / squaring', 'Slewing / realignment', 'Lifting / lowering', 'Machine tamping', 'Ballast recoupment', 'Shallow / manual screening', 'Fish-plated joint attention', 'Glued joint attention', 'Weld attention', 'Rail renewal / replacement', 'Drainage / cess cleaning', 'P&C – switch attention', 'P&C – crossing attention', 'SEJ attention', 'LC approach attention', 'Bridge approach attention', 'Other'];
const MACHINES = ['None (manual)', 'UNIMAT', 'CSM', 'DUOMATIC', 'MPT', 'BCM', 'FRM', 'Other'];
const LIGHT_UNITS = { 'K15-OG': 'FP joints', 'K14-DFWR': 'DFWR removed', 'K13-JOG': 'welds joggled', 'K11-IMR': 'IMR removed' };

// ---------- data ----------
async function loadRecords() {
  try { F.records = await call('records', {}, { cache: true }); } catch (e) { F.records = F.records || []; }
  await loadLocal();
}
async function loadLocal() { try { F.local = (await ST.all('drafts')).map(x => x.value); } catch (e) { F.local = []; } }
function queued() { return F.local.filter(d => d.state === 'queued' || d.state === 'sending').length; }
function recordsOfJob(jobId) {
  const loc = F.local.filter(d => d.jobId === jobId && d.state !== 'draft').map(d => ({ ClientId: d.clientId, Status: d.state === 'error' ? 'Needs correction' : 'Waiting to upload', WorkDate: d.workDate, EnteredBy: S.B.user.Name }));
  return F.records.filter(r => r.JobId === jobId).concat(loc);
}
async function loadGeo() {
  if (F.geo) return F.geo;
  const g = await call('geometry', {}, { cache: true }).catch(() => ({ features: [] }));
  const by = {};
  for (const f of g.features || []) {
    const k = f.s + '|' + f.l; const o = by[k] = by[k] || { curve: [], pxing: [], lc: [], sej: [], glued: [], bridge: [], diamond: [] };
    const x = { no: f.n }; if (f.p != null) x.pos = f.p; else { x.a = f.a; x.b = f.b; } if (f.r != null) x.radius = f.r; if (f.se != null) x.se = f.se; if (f.v != null) x.versine = f.v; if (f.t) x.type = f.t;
    (o[f.k] = o[f.k] || []).push(x);
  }
  for (const k of Object.keys(by)) { const [s, l] = k.split('|'); if (l === '*') continue; const w = by[s + '|*']; if (w) for (const kind in w) by[k][kind] = (by[k][kind] || []).concat(w[kind]); }
  F.geo = new Proxy(by, { get: (o, k) => o[k] || o[String(k).split('|')[0] + '|*'] }); return F.geo;
}
async function start() {
  loadGeo(); flush(); setInterval(flush, 60000); syncBadge();
}
function syncBadge() { const b = $('btnSync'); if (!b) return; const n = queued(); b.classList.toggle('hidden', !n); b.textContent = n ? `↑ ${n} to send` : ''; b.onclick = () => flush(true); }

// ---------- offline queue ----------
const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
async function flush(manual) {
  if (F.flushing) return; F.flushing = true;
  try {
    await loadLocal();
    for (const d of F.local.filter(x => x.state === 'queued')) {
      try {
        d.state = 'sending'; await ST.set('drafts', d.clientId, d); syncBadge();
        const photos = [];
        for (const p of d.photos) {
          let ph = await ST.get('photos', p.clientId);
          if (!ph) continue;
          if (!ph.remote) { const data = await b64(ph.blob); ph.remote = await call('uploadPhoto', { clientId: ph.clientId, recClientId: d.clientId, kind: ph.kind, data, mime: 'image/jpeg', lat: ph.lat, lng: ph.lng, acc: ph.acc, at: ph.at, unit: d.unit, label: ph.label }, { timeout: 180000 }); await ST.set('photos', ph.clientId, ph); }
          photos.push({ kind: ph.kind, id: ph.remote.id, url: ph.remote.url, thumb: ph.remote.thumb, lat: ph.lat, lng: ph.lng, acc: ph.acc, at: ph.at });
        }
        const payload = Object.assign({}, d.payload, { clientId: d.clientId, photos });
        const rec = await call('saveRecord', payload, { timeout: 180000 });
        for (const p of d.photos) await ST.del('photos', p.clientId).catch(() => { });
        await ST.del('drafts', d.clientId);
        F.records = F.records.filter(r => r.RecId !== rec.RecId).concat([rec]);
        const j = S.jobs.find(x => x.JobId === rec.JobId); if (j) j.Status = rec.Status === 'With SSE' ? 'With SSE' : 'Done';
        toast(`Work record ${rec.RecId} sent – now ${rec.Status === 'With SSE' ? 'with the SSE' : 'with the AEN'}`);
      } catch (e) {
        if (e && e.offline) { d.state = 'queued'; await ST.set('drafts', d.clientId, d); break; }
        d.state = 'error'; d.error = (e && e.error) || String(e); await ST.set('drafts', d.clientId, d);
        toast('A work record could not be sent: ' + d.error, true);
      }
    }
  } finally { F.flushing = false; await loadLocal(); syncBadge(); if (T.refreshBanner) T.refreshBanner(); if (S.view === 'records') T.render(); }
  if (manual && !navigator.onLine) toast('No signal – will send automatically when signal returns', true);
}

// ---------- photos: fresh camera photo + GPS, stamped on the picture ----------
function getPos() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) { rej(new Error('This phone does not give a location')); return; }
    navigator.geolocation.getCurrentPosition(p => res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy || 0) }),
      e => rej(new Error(e.code === 1 ? 'Location permission is off. Allow location for this app (phone Settings → Apps → Chrome → Permissions → Location → Allow) and try again.' : 'Could not get the GPS location – go to open sky, switch on location and try again.')), { enableHighAccuracy: true, timeout: 25000, maximumAge: 60000 });
  });
}
function loadImg(file) { return new Promise((res, rej) => { const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => { res(img); URL.revokeObjectURL(url); }; img.onerror = () => rej(new Error('Could not read the photo')); img.src = url; }); }
async function stampPhoto(file, ctx) {
  const maxAge = (S.B.photoMinutes || 10) * 60000;
  if (file.lastModified && Date.now() - file.lastModified > maxAge) throw new Error(`This photo was taken more than ${S.B.photoMinutes || 10} minutes ago. Take a fresh photo with the camera.`);
  const pos = await getPos(); const img = await loadImg(file);
  const m = 1600, s = Math.min(1, m / Math.max(img.width, img.height)); const W = Math.round(img.width * s), H = Math.round(img.height * s);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H);
  const at = nowIso(); const fs = Math.max(14, Math.round(W / 55));
  const lines = [`HWH TMS · ${ctx.title}`, ctx.where, `${at.replace('T', ' ')} · ${pos.lat.toFixed(5)} N, ${pos.lng.toFixed(5)} E ±${pos.acc} m`];
  const bh = Math.round(fs * 1.45 * lines.length + fs * 0.8);
  g.fillStyle = 'rgba(0,0,0,0.62)'; g.fillRect(0, H - bh, W, bh); g.fillStyle = '#fff'; g.font = `600 ${fs}px sans-serif`; g.textBaseline = 'top';
  lines.forEach((t, i) => g.fillText(t, Math.round(fs * 0.6), H - bh + Math.round(fs * 0.4) + i * Math.round(fs * 1.45), W - fs));
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.72));
  return Object.assign({ blob, at, label: lines.join(' | ') }, pos);
}

// ---------- the work record editor ----------
const PHOTO_KINDS = { pre: 'Pre-work measurement', post: 'Post-work measurement', site: 'Worksite' };
function jobRange(j) {
  const w = String(j.Location || '').match(/work\s+(\d+)\/(\d+)\s+to\s+(\d+)\/(\d+)/);
  if (w) return [+w[1] * 1000 + +w[2], +w[3] * 1000 + +w[4]];
  const r = String(j.Location || '').match(/(\d+)\/(\d+)\s*[–-]\s*(\d+)\/(\d+)/); if (r) return [+r[1] * 1000 + +r[2], +r[3] * 1000 + +r[4]];
  if (j.Pos !== '' && j.Pos != null && isFinite(+j.Pos)) return [Math.max(0, +j.Pos - 30), +j.Pos + 30];
  return [null, null];
}
async function editor(job, returned) {
  await loadLocal();
  let d = job ? F.local.find(x => x.jobId === job.JobId && x.state !== 'queued' && x.state !== 'sending') : null;
  if (!d && returned && returned.RecId) {
    let full; try { full = await call('record', { id: returned.RecId }); } catch (e) { fail(e); return; }
    d = newDraft(job, full);
  }
  if (!d) d = newDraft(job);
  F.cur = d; S.view = 'editor'; T.render();
}
function newDraft(job, rec) {
  const mode = job ? T.recMode(job) : 'full'; const unit = job ? job.Unit : (S.unit !== '__all' ? S.unit : (S.B.units[0] || {}).unit);
  const segs = (S.B.segments || []).filter(s => s.unit === unit); const seg = (job && segs.find(s => s.lineId === job.LineId)) || segs[0] || {};
  const [a, b] = job ? jobRange(job) : [null, null];
  const d = { clientId: 'C' + uid(), jobId: job ? job.JobId : '', recId: rec ? rec.RecId : '', mode, unit, state: 'draft', created: nowIso(), workDate: S.B.today, workDateTo: S.B.today,
    section: seg.section || '', line: seg.line || '', a: chStr(a), b: chStr(b), speed: seg.speed || null,
    sheet: null, pre: { gx: {}, av: {}, pnc: {} }, post: { gx: {}, av: {}, pnc: {} }, workTypes: [], quantities: {}, men: '', machine: '', constraint: '', remarks: '', qty: '', photos: [], jobTitle: job ? job.Title : 'Work without a job', jobLoc: job ? job.Location : '' };
  if (rec) {
    Object.assign(d, { section: rec.Section || d.section, line: rec.Line || d.line, a: rec.FromM !== '' ? chStr(+rec.FromM) : d.a, b: rec.ToM !== '' ? chStr(+rec.ToM) : d.b, workDate: String(rec.WorkDate).slice(0, 10), workDateTo: String(rec.WorkDateTo).slice(0, 10), workTypes: rec.WorkTypes || [], quantities: rec.Quantities || {}, men: rec.Men, machine: rec.Machine, constraint: rec.Constraint, remarks: rec.Remarks, sheet: rec.sheet || null, pre: rec.pre || d.pre, post: rec.post || d.post, returnReason: rec.ReturnReason, qty: (rec.Quantities || {}).qty || '' });
    d.remotePhotos = rec.Photos || [];
  }
  return d;
}
let saveT = null;
function saveDraft() { clearTimeout(saveT); saveT = setTimeout(() => { if (F.cur) ST.set('drafts', F.cur.clientId, F.cur).then(loadLocal).catch(() => { }); }, 400); }

V.editor = async el => {
  const d = F.cur; if (!d) { S.view = 'work'; T.render(); return; }
  const full = d.mode === 'full'; const segs = (S.B.segments || []).filter(s => s.unit === d.unit);
  const units = S.B.units.map(u => u.unit);
  el.innerHTML = T.pageHead(full ? 'Work record' : 'Work record (quick)', esc(d.jobTitle) + (d.jobLoc ? ' · ' + esc(d.jobLoc) : ''), `<button class="btn secondary sm right" id="eBack">Back</button>`) +
    (d.returnReason ? `<div class="ban crit">Returned: ${esc(d.returnReason)} – correct and send again.</div>` : '') + (d.error ? `<div class="ban crit">Could not be sent: ${esc(d.error)}</div>` : '') +
    `<div class="panel body"><h3 class="sec">1. Where and when</h3><div class="inner"><div class="row">
      ${d.jobId ? '' : `<div class="fld" style="flex:1"><label>Unit</label><select id="eUnit">${units.map(u => `<option ${u === d.unit ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></div>`}
      ${full ? `<div class="fld" style="flex:2"><label>Line</label><select id="eLine">${segs.map(s => `<option value="${esc(s.section + '|' + s.line)}" ${s.section === d.section && s.line === d.line ? 'selected' : ''}>${esc(s.lineId)} (${STN.fmtCh(s.a)} – ${STN.fmtCh(s.b)})</option>`).join('') || '<option value="">No line found for this unit</option>'}</select></div>
      <div class="fld"><label>Work started at (km.m)</label><input id="eA" inputmode="decimal" placeholder="10.995" value="${esc(d.a)}"></div><div class="fld"><label>Work ended at (km.m)</label><input id="eB" inputmode="decimal" placeholder="11.342" value="${esc(d.b)}"></div>` : ''}
      <div class="fld"><label>Work done on</label><input type="date" id="eD1" max="${S.B.today}" value="${esc(d.workDate)}"></div><div class="fld"><label>Finished on</label><input type="date" id="eD2" max="${S.B.today}" value="${esc(d.workDateTo)}"></div></div>
      ${full ? `<div class="row"><button class="btn primary" id="eMake">${d.sheet ? 'Re-make measurement sheet' : 'Make measurement sheet'}</button><span class="small muted">Gauge &amp; cross level every 3 m · alignment / unevenness every 3.6 m (straight) or versine every 10 m (curve) · P&amp;C form for each turnout</span></div><div id="eTags" class="tags">${d.sheet ? tagsHtml(d.sheet) : ''}</div>` : ''}</div></div>` +
    (full ? `<div class="panel body"><h3 class="sec">2. Measurements BEFORE work (whole stretch) <span class="muted" id="preSum"></span></h3><div class="inner" id="preBox">${d.sheet ? '' : '<div class="empty">Enter the chainage and tap "Make measurement sheet".</div>'}</div></div>` : '') +
    `<div class="panel body"><h3 class="sec">${full ? '3' : '2'}. Work done</h3><div class="inner">${full ? `<div class="chips" id="eTypes">${WORK_TYPES.map(w => `<label class="chip ${d.workTypes.includes(w) ? 'on' : ''}"><input type="checkbox" value="${esc(w)}" ${d.workTypes.includes(w) ? 'checked' : ''}>${esc(w)}</label>`).join('')}</div><div id="eQty" class="row" style="margin-top:8px"></div>
      <div class="row"><div class="fld"><label>Men</label><input id="eMen" inputmode="numeric" value="${esc(d.men)}" style="width:90px"></div><div class="fld"><label>Machine</label><select id="eMach">${MACHINES.map(m => `<option ${m === d.machine ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div></div>`
      : `<div class="row"><div class="fld"><label>Quantity done</label><input id="eQ" inputmode="decimal" value="${esc(d.qty)}" style="width:120px"></div><div class="fld"><label>&nbsp;</label><span>${esc(LIGHT_UNITS[(S.jobs.find(j => j.JobId === d.jobId) || {}).Type] || 'nos.')}</span></div></div>`}
      <div class="fld"><label>Site constraint (if any)</label><textarea id="eCon" placeholder="Block not available, material awaited…">${esc(d.constraint)}</textarea></div><div class="fld"><label>Remarks</label><textarea id="eRem">${esc(d.remarks)}</textarea></div></div></div>` +
    (full ? `<div class="panel body"><h3 class="sec">4. Measurements AFTER work (defect spots only) <span class="muted" id="postSum"></span></h3><div class="inner" id="postBox"><div class="empty">Shown when the measurements before work are entered.</div></div></div>` : '') +
    `<div class="panel body"><h3 class="sec">${full ? '5' : '3'}. Photos – taken now with the camera, location must be on</h3><div class="inner">${(full ? ['pre', 'post', 'site'] : ['site']).map(k => `<div class="phgrp"><div class="row"><b>${PHOTO_KINDS[k]}</b><span class="muted small">at least 1, up to 3</span><label class="btn secondary sm right">Take photo<input type="file" accept="image/*" capture="environment" data-ph="${k}" hidden></label></div><div class="thumbs" id="ph_${k}"></div></div>`).join('')}</div></div>` +
    `<div class="panel body"><div class="inner row"><button class="btn primary" id="eSend">Send</button><button class="btn secondary" id="eSave">Keep as draft</button><button class="btn ghost" id="eDel">Discard draft</button><span class="muted small" id="eMsg">Saved on this phone as you type. If there is no signal it is sent automatically later.</span></div></div>`;
  $('eBack').onclick = () => { saveDraft(); S.view = d.jobId ? 'work' : 'records'; T.render(); };
  const bind = (id, k) => { const x = $(id); if (x) x.oninput = x.onchange = () => { d[k] = x.value; saveDraft(); }; };
  bind('eA', 'a'); bind('eB', 'b'); bind('eD1', 'workDate'); bind('eD2', 'workDateTo'); bind('eMen', 'men'); bind('eMach', 'machine'); bind('eCon', 'constraint'); bind('eRem', 'remarks'); bind('eQ', 'qty');
  if ($('eUnit')) $('eUnit').onchange = () => { d.unit = $('eUnit').value; const s = (S.B.segments || []).find(x => x.unit === d.unit) || {}; d.section = s.section || ''; d.line = s.line || ''; d.speed = s.speed || null; d.sheet = null; saveDraft(); T.render(); };
  if ($('eLine')) $('eLine').onchange = () => { const [s, l] = $('eLine').value.split('|'); d.section = s; d.line = l; const sg = segs.find(x => x.section === s && x.line === l); d.speed = sg ? sg.speed : null; saveDraft(); };
  if ($('eMake')) $('eMake').onclick = async () => {
    const a = STN.parseCh(d.a), b = STN.parseCh(d.b); if (a == null || b == null) { toast('Write the chainage like 10.995 (km.metres)', true); return; }
    if (!d.section) { toast('Choose the line', true); return; }
    try { const geo = await loadGeo(); const g = geo[d.section + '|' + d.line] || {}; d.sheet = STN.buildSheet({ section: d.section, line: d.line, a, b, speed: d.speed }, g); saveDraft(); T.render(); } catch (e) { fail(e); }
  };
  if ($('eTypes')) { $('eTypes').onchange = () => { d.workTypes = [...$('eTypes').querySelectorAll('input:checked')].map(x => x.value); $('eTypes').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.querySelector('input').checked)); drawQty(); saveDraft(); }; drawQty(); }
  function drawQty() { const q = $('eQty'); if (!q) return; q.innerHTML = d.workTypes.map(w => `<div class="fld"><label>${esc(w)} – qty</label><input data-q="${esc(w)}" value="${esc(d.quantities[w] || '')}" placeholder="e.g. 40 sleepers / 120 m" style="width:170px"></div>`).join(''); q.querySelectorAll('[data-q]').forEach(x => x.oninput = () => { d.quantities[x.dataset.q] = x.value; saveDraft(); }); }
  if (full && d.sheet) { drawSheet('pre'); drawSheet('post'); }
  drawPhotos();
  el.querySelectorAll('[data-ph]').forEach(inp => inp.onchange = async () => {
    const f = inp.files[0]; inp.value = ''; if (!f) return; const k = inp.dataset.ph;
    if (d.photos.filter(p => p.kind === k).length + (d.remotePhotos || []).filter(p => p.kind === k).length >= 3) { toast('Up to 3 photos of each kind', true); return; }
    toast('Getting location…');
    try {
      const where = d.mode === 'full' ? `Unit ${d.unit} · ${d.section} ${d.line} ${d.a || ''}–${d.b || ''}` : `Unit ${d.unit} · ${d.jobLoc}`;
      const ph = await stampPhoto(f, { title: `${d.jobId ? 'Job ' + d.jobId : 'Work'} · ${PHOTO_KINDS[k].toUpperCase()}`, where });
      const p = Object.assign({ clientId: 'P' + uid(), kind: k }, ph); await ST.set('photos', p.clientId, p);
      d.photos.push({ clientId: p.clientId, kind: k, at: p.at, lat: p.lat, lng: p.lng, acc: p.acc }); saveDraft(); drawPhotos();
    } catch (e) { modal(`<h3>Photo not taken</h3><p>${esc(e.message)}</p>`); }
  });
  $('eSave').onclick = () => { saveDraft(); toast('Kept on this phone as a draft'); };
  $('eDel').onclick = () => modal('<h3>Discard this draft?</h3><p>The readings and photos entered on this phone will be removed.</p>', async () => { for (const p of d.photos) await ST.del('photos', p.clientId).catch(() => { }); await ST.del('drafts', d.clientId).catch(() => { }); F.cur = null; await loadLocal(); S.view = 'work'; T.render(); }, 'Discard');
  $('eSend').onclick = () => submit(d);
};
function tagsHtml(sh) { return `<div class="small"><b>In this stretch:</b> ${sh.tags.map(t => `<span class="tag t4">${esc(t.label)}</span>`).join(' ')}</div><div class="small muted">${sh.gx.length} gauge / cross-level points · ${sh.av.length} alignment / versine points${sh.pnc.length ? ' · ' + sh.pnc.length + ' P&C form(s)' : ''}</div>`; }
function L() { return S.B.limits || STN.DEFAULT_LIMITS; }
function preCheck(d) { return STN.checkSheet(d.sheet, d.pre, L()); }
function postOnly(d) { const j = S.jobs.find(x => x.JobId === d.jobId); return STN.postSpots(d.sheet, preCheck(d), j && j.Pos !== '' && j.Pos != null ? [+j.Pos] : []); }
function drawSheet(phase) {
  const d = F.cur; const box = $(phase + 'Box'); if (!box || !d.sheet) return; const sh = d.sheet; const vals = d[phase];
  const only = phase === 'post' ? postOnly(d) : null;
  const inOnly = (part, p) => !only || (only[part] || []).some(x => Math.abs(x - p) < 0.05);
  const gx = sh.gx.filter(s => inOnly('gx', s.pos)), av = sh.av.filter(s => inOnly('av', s.pos)); const pncs = sh.pnc.filter(P => !only || (only.pnc[P.no] || []).length);
  if (phase === 'post' && !gx.length && !av.length && !pncs.length) { box.innerHTML = '<div class="empty">No defect spots yet – enter the measurements before work first. Spots outside the limit and the job\'s own TRC / OMS spot appear here.</div>'; return; }
  const v = (part, key, f, sub) => { const o = part === 'pnc' ? (((vals.pnc[sub] || {})[key]) || {}) : ((vals[part][String(key)]) || {}); return o[f] == null ? '' : o[f]; };
  const xlBox = (part, key, f, sub) => { const raw = String(v(part, key, f, sub)); const m = raw.match(/^(\d+(?:\.\d)?)([LR]?)$/i); const n = m ? m[1] : raw.replace(/[LR]/gi, ''), side = m ? m[2].toUpperCase() : ''; return `<span class="xl"><input class="cv" inputmode="decimal" enterkeyhint="next" data-p="${part}" data-k="${key}" data-f="${f}" ${sub ? `data-n="${esc(sub)}"` : ''} data-xl="1" value="${esc(n)}"><button type="button" class="lr ${side ? 'on' : ''}" data-lr="1">${side || 'L/R'}</button></span>`; };
  const num = (part, key, f, sub, ph) => `<input class="cv" inputmode="decimal" enterkeyhint="next" data-p="${part}" data-k="${key}" data-f="${f}" ${sub ? `data-n="${esc(sub)}"` : ''} value="${esc(v(part, key, f, sub))}" placeholder="${ph || ''}">`;
  let h = `<div class="small muted" style="margin-bottom:6px">Gauge: −3 / +5 mm · Cross level: number, then tap L or R for the <b>lower</b> rail (0 = level) · Alignment, versine, unevenness in mm. Red = outside the IRPWM limit.</div>`;
  if (gx.length) h += `<div class="scroll"><table class="t sheet"><thead><tr><th>Point (km/m)</th><th>Gauge</th><th>Cross level</th><th>Track</th></tr></thead><tbody>${gx.map(s => `<tr><td class="nw"><b>${STN.fmtCh(s.pos)}</b></td><td>${num('gx', s.pos, 'g', null, '±mm')}</td><td>${xlBox('gx', s.pos, 'xl')}</td><td class="small muted">${s.R ? 'Curve R' + s.R : 'Straight'}${s.near ? ' · ' + esc(s.near) : ''}</td></tr>`).join('')}</tbody></table></div>`;
  if (av.length) h += `<h4 style="margin:14px 0 6px">Alignment / versine and unevenness – both rails</h4><div class="scroll"><table class="t sheet"><thead><tr><th>Point</th><th>Chord</th><th>Align / versine L</th><th>Align / versine R</th><th>Unevenness L</th><th>Unevenness R</th></tr></thead><tbody>${av.map(s => `<tr><td class="nw"><b>${STN.fmtCh(s.pos)}</b></td><td class="small">${s.curve ? '20 m (curve ' + esc(s.curve) + ')' : '7.2 m'}</td><td>${num('av', s.pos, 'al')}</td><td>${num('av', s.pos, 'ar')}</td><td>${num('av', s.pos, 'ul', null, 'opt.')}</td><td>${num('av', s.pos, 'ur', null, 'opt.')}</td></tr>`).join('')}</tbody></table></div>`;
  for (const P of pncs) {
    const keys = only ? only.pnc[P.no] : null; const show = k => !keys || keys.includes(k);
    h += `<h4 style="margin:14px 0 6px">P&amp;C ${esc(P.no)} ${P.type ? '(' + esc(P.type) + ')' : ''} at ${STN.fmtCh(P.pos)} – TMS form sections 12 and 15 <span class="muted small">(partial entry allowed; empty boxes are shown red)</span></h4>`;
    const two = (k, lbl) => show(k) ? `<div class="pncrow"><span class="pl">${esc(lbl)}</span><span>Gauge ${num('pnc', k, 'g', P.no)}</span><span>Cross level ${xlBox('pnc', k, 'xl', P.no)}</span></div>` : '';
    h += two('12.1', STN.PNC_LABEL['12.1']) + two('12.2', STN.PNC_LABEL['12.2']);
    const leadRows = []; for (let i = 0; i < STN.PNC_LEAD_ROWS; i++) if (show('12.3.' + i)) leadRows.push(i);
    if (leadRows.length) h += `<div class="small" style="margin-top:6px"><b>12.3</b> Gauge and cross level for ML and turnout side; versine of stock rail for turnout side up to end of lead</div><div class="scroll"><table class="t sheet"><thead><tr><th></th><th colspan="2">Main line</th><th colspan="3">Turn out</th></tr><tr><th>Station</th><th>G</th><th>XL</th><th>G</th><th>XL</th><th>Ve</th></tr></thead><tbody>${leadRows.map(i => `<tr><td class="nw">${i === 0 ? 'ATS/HEEL 0' : 'Station ' + i}</td><td>${num('pnc', '12.3.' + i, 'mg', P.no)}</td><td>${xlBox('pnc', '12.3.' + i, 'mx', P.no)}</td><td>${num('pnc', '12.3.' + i, 'tg', P.no)}</td><td>${xlBox('pnc', '12.3.' + i, 'tx', P.no)}</td><td>${i === 0 ? '' : num('pnc', '12.3.' + i, 'tv', P.no)}</td></tr>`).join('')}</tbody></table></div>`;
    const cr = ['15.1', '15.2', '15.3'].filter(show);
    if (cr.length) h += `<div class="small" style="margin-top:6px"><b>15</b> Gauge and cross level at crossing (gauge −3 to +1 mm)</div><div class="scroll"><table class="t sheet"><thead><tr><th></th><th colspan="2">ML</th><th colspan="2">T/O</th></tr><tr><th></th><th>G</th><th>XL</th><th>G</th><th>XL</th></tr></thead><tbody>${cr.map(k => `<tr><td class="nw">${esc(STN.PNC_LABEL[k])}</td><td>${num('pnc', k, 'mg', P.no)}</td><td>${xlBox('pnc', k, 'mx', P.no)}</td><td>${num('pnc', k, 'tg', P.no)}</td><td>${xlBox('pnc', k, 'tx', P.no)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  box.innerHTML = h;
  const setVal = (inp, val) => {
    const p = inp.dataset.p, k = inp.dataset.k, f = inp.dataset.f, n = inp.dataset.n;
    if (p === 'pnc') { const o = vals.pnc[n] = vals.pnc[n] || {}; const r = o[k] = o[k] || {}; r[f] = val; } else { const r = vals[p][k] = vals[p][k] || {}; r[f] = val; }
    saveDraft(); paint(phase);
  };
  const xlVal = inp => { const lr = inp.parentNode.querySelector('.lr'); const s = lr.classList.contains('on') ? lr.textContent : ''; const n = inp.value.trim(); return n === '' ? '' : (+n === 0 ? '0' : n + s); };
  box.querySelectorAll('input.cv').forEach((inp, i, all) => {
    inp.oninput = () => setVal(inp, inp.dataset.xl ? xlVal(inp) : inp.value.trim());
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const nx = all[i + 1]; if (nx) nx.focus(); } };
  });
  box.querySelectorAll('.lr').forEach(b => b.onclick = () => { const cyc = { 'L/R': 'L', L: 'R', R: 'L' }; b.textContent = cyc[b.textContent] || 'L'; b.classList.add('on'); const inp = b.parentNode.querySelector('input'); setVal(inp, xlVal(inp)); });
  paint(phase);
}
function paint(phase) {
  const d = F.cur; const box = $(phase + 'Box'); if (!box || !d.sheet) return;
  const c = phase === 'pre' ? preCheck(d) : STN.checkSheet(d.sheet, d.post, L(), { only: postOnly(d) });
  const key = (p, k, f, n) => p + '|' + (n || '') + '|' + k + '|' + f; const bad = new Map(), miss = new Set();
  for (const b of c.bad) bad.set(key(b.part, b.key, b.field, b.no), b.msg); for (const b of c.invalid) bad.set(key(b.part, b.key, b.field, b.no), b.msg); for (const m of c.missing) miss.add(key(m.part, m.key, m.field, m.no));
  box.querySelectorAll('input.cv').forEach(inp => { const kk = key(inp.dataset.p, inp.dataset.p === 'pnc' ? inp.dataset.k : String(+inp.dataset.k), inp.dataset.f, inp.dataset.n); const kk2 = key(inp.dataset.p, inp.dataset.p === 'pnc' ? inp.dataset.k : +inp.dataset.k, inp.dataset.f, inp.dataset.n); const m = bad.get(kk) || bad.get(kk2); inp.classList.toggle('bad', !!m); inp.title = m || ''; inp.classList.toggle('miss', !m && (miss.has(kk) || miss.has(kk2))); });
  const sum = $(phase + 'Sum'); if (sum) sum.textContent = `– ${c.bad.length} outside limit · ${c.missing.filter(m => !m.soft).length} required empty · ${c.invalid.length} wrongly written${c.missing.some(m => m.soft) ? ' · ' + c.missing.filter(m => m.soft).length + ' P&C boxes empty' : ''}`;
  if (phase === 'pre') { clearTimeout(paint.t); paint.t = setTimeout(() => drawSheet('post'), 600); }
}
async function drawPhotos() {
  const d = F.cur; if (!d) return;
  for (const k of ['pre', 'post', 'site']) {
    const box = $('ph_' + k); if (!box) continue; const items = [];
    for (const p of (d.remotePhotos || []).filter(x => x.kind === k)) items.push(`<a class="th" href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.thumb || '')}" alt=""><span>${esc(String(p.at).replace('T', ' ').slice(5, 16))}</span></a>`);
    for (const p of d.photos.filter(x => x.kind === k)) { const ph = await ST.get('photos', p.clientId).catch(() => null); if (!ph) continue; items.push(`<span class="th"><img src="${URL.createObjectURL(ph.blob)}" alt=""><span>${esc(p.at.replace('T', ' ').slice(5, 16))} ±${p.acc} m</span><button class="x" data-rm="${esc(p.clientId)}">×</button></span>`); }
    box.innerHTML = items.join('') || '<span class="muted small">No photo yet.</span>';
    box.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { await ST.del('photos', b.dataset.rm).catch(() => { }); d.photos = d.photos.filter(p => p.clientId !== b.dataset.rm); saveDraft(); drawPhotos(); });
  }
}
async function submit(d) {
  const full = d.mode === 'full'; const err = [];
  if (!d.workDate) err.push('date of work');
  if (full) {
    if (!d.sheet) err.push('measurement sheet (enter chainage, tap "Make measurement sheet")');
    else { const c = preCheck(d); if (c.blocking) err.push(`${c.blocking} required reading(s) before work are empty or wrongly written`); const q = STN.checkSheet(d.sheet, d.post, L(), { only: postOnly(d) }); if (q.blocking) err.push(`${q.blocking} reading(s) after work at the defect spots are empty or wrongly written`); }
    if (!d.workTypes.length) err.push('work done (tick at least one)');
  } else if (!(+d.qty > 0)) err.push('quantity done');
  const all = (d.remotePhotos || []).concat(d.photos);
  for (const k of full ? ['pre', 'post', 'site'] : ['site']) if (!all.some(p => p.kind === k)) err.push(PHOTO_KINDS[k].toLowerCase() + ' photo');
  if (err.length) { modal(`<h3>Not complete yet</h3><p>Still needed:</p><ul>${err.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`); return; }
  const payload = { jobId: d.jobId, recId: d.recId || undefined, unit: d.unit, mode: d.mode, section: d.section, line: d.line, a: STN.parseCh(d.a), b: STN.parseCh(d.b), workDate: d.workDate, workDateTo: d.workDateTo || d.workDate, workTypes: d.workTypes, quantities: d.quantities, men: d.men, machine: d.machine, constraint: d.constraint, remarks: d.remarks, qty: d.qty, qtyUnit: LIGHT_UNITS[(S.jobs.find(j => j.JobId === d.jobId) || {}).Type] || '', sheet: d.sheet, pre: d.pre, post: d.post };
  if (d.remotePhotos && d.remotePhotos.length) for (const p of d.remotePhotos) { const pc = 'R' + uid(); await ST.set('photos', pc, Object.assign({ clientId: pc, remote: { id: p.id, url: p.url, thumb: p.thumb } }, p)); d.photos.push({ clientId: pc, kind: p.kind }); }
  d.remotePhotos = []; d.payload = payload; d.state = 'queued'; d.error = ''; await ST.set('drafts', d.clientId, d); F.cur = null;
  await loadLocal(); syncBadge(); toast(navigator.onLine === false ? 'Saved on this phone – it will be sent when signal returns' : 'Sending…');
  S.view = d.jobId ? 'work' : 'records'; T.render(); flush();
}

// ---------- records list, record view, review ----------
const recRow = r => `<tr data-r="${esc(r.RecId)}" style="cursor:pointer"><td class="nw">${dmy(r.WorkDate)}</td><td>${esc(r.Unit)}</td><td class="wrap">${esc(r.Mode === 'full' ? `${r.LineId || ''} ${STN.fmtCh(+r.FromM)}–${STN.fmtCh(+r.ToM)}` : (S.jobs.find(j => j.JobId === r.JobId) || {}).Title || r.JobId)}<div class="small muted">${esc((r.WorkTypes || []).join(', '))}</div></td><td>${esc(r.EnteredBy)}</td><td><span class="${stc(r.Status)}">${esc(r.Status)}</span>${r.Result ? `<div class="small"><b>${esc(r.Result)}</b></div>` : ''}</td><td class="small">${(r.PreSummary || {}).outside != null ? `${r.PreSummary.outside} red before · ${(r.PostSummary || {}).stillOutside ?? '—'} red after` : ''}</td></tr>`;
V.records = el => {
  const mine = role() === 'JE'; const loc = F.local;
  const R = F.records.filter(r => T.inUnit(r) && (!mine || r.EnteredById === S.B.user.UserId));
  const f = S.f.rs || '';
  const rows = R.filter(r => !f || r.Status === f).sort((a, b) => String(b.SubmittedOn).localeCompare(String(a.SubmittedOn)));
  el.innerHTML = T.pageHead(mine ? 'My work records' : 'Work records', T.scopeText(), ['JE', 'SSE', 'ADMIN'].includes(role()) ? `<button class="btn secondary sm right" id="newRec">New record (work without a job)</button>` : '') +
    (loc.length ? `<div class="panel body"><h3 class="sec">On this phone</h3><div class="scroll"><table class="t"><thead><tr><th>Created</th><th>Job</th><th>State</th><th></th></tr></thead><tbody>${loc.map(x => `<tr><td class="nw">${esc(String(x.created).replace('T', ' ').slice(0, 16))}</td><td class="wrap">${esc(x.jobTitle)}<div class="small muted">${esc(x.jobLoc || '')}</div></td><td>${x.state === 'draft' ? 'Draft' : x.state === 'error' ? `<span class="od">Needs correction: ${esc(x.error)}</span>` : 'Waiting for signal to upload'}</td><td>${x.state === 'queued' || x.state === 'sending' ? '' : `<button class="btn ghost sm" data-ed="${esc(x.clientId)}">Open</button>`}</td></tr>`).join('')}</tbody></table></div></div>` : '') +
    `<div class="panel body"><div class="tablebar"><b>${rows.length}</b><select id="rsF"><option value="">Any status</option>${['With SSE', 'With AEN', 'Returned', 'Approved'].map(s => `<option ${f === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>${rows.length ? `<div class="scroll"><table class="t"><thead><tr><th>Work date</th><th>Unit</th><th>Where / work</th><th>Entered by</th><th>Status</th><th>Readings</th></tr></thead><tbody>${rows.map(recRow).join('')}</tbody></table></div>` : '<div class="empty">No work records yet.</div>'}</div>`;
  $('rsF').onchange = () => { S.f.rs = $('rsF').value; T.render(); };
  el.querySelectorAll('tr[data-r]').forEach(tr => tr.onclick = () => openRecord(tr.dataset.r));
  el.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => { F.cur = F.local.find(x => x.clientId === b.dataset.ed); if (F.cur.state === 'error') F.cur.state = 'draft'; S.view = 'editor'; T.render(); });
  if ($('newRec')) $('newRec').onclick = () => editor(null);
};
V.review = el => {
  const r = role(); const p = S.B.pending || {};
  const want = r === 'SSE' ? ['With SSE'] : r === 'AEN' ? ['With AEN'] : ['With SSE', 'With AEN'];
  const R = F.records.filter(x => T.inUnit(x) && want.includes(x.Status)).sort((a, b) => String(a.SubmittedOn).localeCompare(String(b.SubmittedOn)));
  const by = {}; for (const x of F.records.filter(x => T.inUnit(x) && ['With SSE', 'With AEN'].includes(x.Status))) { const k = x.Status === 'With SSE' ? 'SSE ' + x.Unit : 'AEN ' + (x.AEN || '—'); by[k] = (by[k] || 0) + 1; }
  el.innerHTML = T.pageHead(r === 'SSE' ? 'Check JE work' : r === 'AEN' ? 'Approve work' : 'Pending reviews', r === 'SSE' ? 'Records entered by your JEs – check readings and photos, then send to the AEN or return' : r === 'AEN' ? 'Check readings (red = outside limit), photos (time and GPS) and the work done, then approve or return' : 'Work done in the field that is still waiting for SSE / AEN review') +
    (['SRDEN', 'SRDENC', 'ADMIN'].includes(r) ? `<div class="kpis"><div class="kpi ${p.sseOver ? 'crit' : 'warn'}"><div class="l">With SSEs</div><div class="v">${p.sse || 0}</div><div class="s">${p.sseOver || 0} beyond ${'time'}</div></div><div class="kpi ${p.aenOver ? 'crit' : 'warn'}"><div class="l">With AENs</div><div class="v">${p.aen || 0}</div><div class="s">${p.aenOver || 0} beyond time</div></div></div><div class="panel body"><h3 class="sec">Who has it</h3><div class="inner">${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="tag t3" style="margin:2px">${esc(k)}: ${n}</span>`).join(' ') || '<span class="muted">Nothing pending.</span>'}</div></div>` : '') +
    `<div class="panel body">${R.length ? `<div class="scroll"><table class="t"><thead><tr><th>Work date</th><th>Unit</th><th>Where / work</th><th>Entered by</th><th>Status</th><th>Readings</th></tr></thead><tbody>${R.map(recRow).join('')}</tbody></table></div>` : '<div class="empty">Nothing waiting.</div>'}</div>`;
  el.querySelectorAll('tr[data-r]').forEach(tr => tr.onclick = () => openRecord(tr.dataset.r));
};
async function openRecord(id) {
  const loc = F.local.find(x => x.clientId === id); if (loc) { F.cur = loc; S.view = 'editor'; T.render(); return; }
  S.view = 'record'; F.openId = id; T.render();
}
V.record = async el => {
  el.innerHTML = '<div class="empty">Loading…</div>';
  let r; try { r = await call('record', { id: F.openId }, { cache: true }); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.error || e)}</div>`; return; }
  const ro = role(); const Lm = r.limits || L();
  const canFwd = r.Status === 'With SSE' && (ro === 'SSE' || ro === 'ADMIN'); const canApp = r.Status === 'With AEN' && (ro === 'AEN' || ro === 'ADMIN') && r.EnteredById !== S.B.user.UserId;
  const canRet = (r.Status === 'With SSE' && (ro === 'SSE' || ro === 'ADMIN')) || (r.Status === 'With AEN' && (ro === 'AEN' || ro === 'ADMIN'));
  const canFix = r.Status === 'Returned' && (r.EnteredById === S.B.user.UserId || ro === 'SSE' || ro === 'ADMIN');
  const ph = k => (r.Photos || []).filter(p => p.kind === k).map(p => `<a class="th" href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.thumb || '')}" alt="" loading="lazy"><span>${esc(String(p.at).replace('T', ' ').slice(0, 16))}<br>${(+p.lat).toFixed(5)}, ${(+p.lng).toFixed(5)} ±${esc(p.acc)} m · <a href="https://maps.google.com/?q=${esc(p.lat)},${esc(p.lng)}" target="_blank" rel="noopener">map</a></span></a>`).join('') || '<span class="muted small">—</span>';
  const dl = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
  el.innerHTML = T.pageHead('Work record ' + esc(r.RecId), `${esc(r.Unit)} · ${r.job ? esc(r.job.Title) + ' · ' + esc(r.job.Location) : 'work without a job'}`, `<button class="btn secondary sm right" id="rBack">Back</button>`) +
    `<div class="panel body"><div class="inner"><div class="row"><span class="${stc(r.Status)}">${esc(r.Status)}</span>${r.Result ? `<span class="tag ${r.Result === 'Held' ? 'tg' : r.Result === 'Failed' ? 't1' : 't3'}">Next run: ${esc(r.Result)}</span>` : ''}${r.ReturnReason ? `<span class="od">Returned: ${esc(r.ReturnReason)}</span>` : ''}</div>
    <dl class="dl">${dl('Worksite', r.Mode === 'full' ? `<b>${esc(r.LineId)} ${STN.fmtCh(+r.FromM)} – ${STN.fmtCh(+r.ToM)}</b> (${Math.round(+r.ToM - +r.FromM)} m)` : '')}${dl('Assets in it', esc((r.Assets || []).join(' · ')))}${dl('Work done on', dmy(r.WorkDate) + (r.WorkDateTo && r.WorkDateTo !== r.WorkDate ? ' to ' + dmy(r.WorkDateTo) : ''))}
    ${dl('Work', esc((r.WorkTypes || []).map(w => w + (r.Quantities && r.Quantities[w] ? ' – ' + r.Quantities[w] : '')).join('\n')))}${r.Mode === 'light' ? dl('Quantity', esc((r.Quantities || {}).qty + ' ' + ((r.Quantities || {}).unit || ''))) : ''}${dl('Men / machine', esc([r.Men, r.Machine].filter(Boolean).join(' · ')))}${dl('Site constraint', esc(r.Constraint))}${dl('Remarks', esc(r.Remarks))}
    ${dl('Entered by', esc(`${r.EnteredBy} (${r.EnteredRole}) · ${String(r.SubmittedOn).replace('T', ' ').slice(0, 16)}`))}${dl('Checked by SSE', r.SSEOn ? esc(`${r.SSEBy} · ${String(r.SSEOn).replace('T', ' ').slice(0, 16)}`) : '')}${dl('Approved by AEN', r.AENOn ? esc(`${r.AENBy} · ${String(r.AENOn).replace('T', ' ').slice(0, 16)}`) : '')}
    ${dl('Before work', r.PreSummary && r.PreSummary.gx != null ? esc(`${r.PreSummary.outside} reading(s) outside limit`) + (r.PreSummary.flags || []).slice(0, 12).map(f => `<div class="small od">${esc(f)}</div>`).join('') : '')}${dl('After work', r.PostSummary && r.PostSummary.spots != null ? esc(`${r.PostSummary.spots} spot(s) re-measured · ${r.PostSummary.stillOutside} still outside limit`) + (r.PostSummary.flags || []).slice(0, 12).map(f => `<div class="small od">${esc(f)}</div>`).join('') : '')}</dl></div></div>` +
    `<div class="panel body"><h3 class="sec">Photos</h3><div class="inner">${r.Mode === 'full' ? `<div class="phgrp"><b>Pre-work measurement</b><div class="thumbs">${ph('pre')}</div></div><div class="phgrp"><b>Post-work measurement</b><div class="thumbs">${ph('post')}</div></div>` : ''}<div class="phgrp"><b>Worksite</b><div class="thumbs">${ph('site')}</div></div></div></div>` +
    (r.sheet ? `<div class="panel body"><h3 class="sec">Readings</h3><div class="inner" id="rRead">${readingsTable(r.sheet, r.pre, r.post, Lm, r.job, false)}</div></div>` : '') +
    `<div class="panel body"><h3 class="sec">Notes</h3><div class="inner">${(r.Notes || []).map(n => `<div class="small"><b>${esc(n.by)}</b> ${esc(String(n.when).replace('T', ' ').slice(0, 16))}: ${esc(n.note)}</div>`).join('') || '<span class="muted small">None.</span>'}</div></div>` +
    `<div class="panel body"><div class="inner">${canFwd || canApp || canRet ? `<div class="fld"><label>Remark (required to return)</label><textarea id="rNote"></textarea></div><div class="row">${canFwd ? '<button class="btn primary" id="rFwd">Checked – send to AEN</button>' : ''}${canApp ? '<button class="btn primary" id="rApp">Approve</button>' : ''}${canRet ? '<button class="btn secondary" id="rRet">Return with reason</button>' : ''}</div>` : ''}
      ${canFix ? '<button class="btn primary" id="rFix">Correct and send again</button>' : ''}${['SSE', 'JE', 'AEN', 'SRDEN', 'SRDENC', 'ADMIN'].includes(ro) && !canFwd && !canApp ? `<div class="fld" style="margin-top:10px"><label>Add a dated note${r.Status === 'Approved' ? ' (the record itself is locked)' : ''}</label><textarea id="rN2"></textarea></div><button class="btn secondary sm" id="rNote2">Add note</button>` : ''}
      <button class="btn ghost sm" id="rHist" style="margin-top:10px">Location history</button></div></div>`;
  const wireAll = () => { const c = $('rAll'); if (c) c.onchange = () => { $('rRead').innerHTML = readingsTable(r.sheet, r.pre, r.post, Lm, r.job, c.checked); wireAll(); }; }; wireAll();
  if (canFwd || canApp) { const bar = document.createElement('div'); bar.className = 'actbar'; bar.innerHTML = `<span class="small">${canFwd ? 'Checked everything?' : 'Ready to approve?'}</span><button class="btn primary sm" id="rJump">Go to ${canFwd ? 'send / return' : 'approve / return'}</button>`; el.prepend(bar); $('rJump').onclick = () => $('rNote').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  $('rBack').onclick = () => { S.view = ['SSE', 'AEN'].includes(ro) && ['With SSE', 'With AEN'].includes(r.Status) ? 'review' : 'records'; T.render(); };
  const act = async (action, note, btn) => { btn.disabled = true; try { const nr = await call('recordAction', { id: r.RecId, action, note }); F.records = F.records.filter(x => x.RecId !== nr.RecId).concat([nr]); toast({ forward: 'Sent to AEN', approve: 'Approved – record locked', 'return': 'Returned', note: 'Note added' }[action]); S.B.pending = await call('pending').catch(() => S.B.pending); if (action === 'note') T.render(); else { S.view = 'review'; await T.reload(); } } catch (e) { fail(e); btn.disabled = false; } };
  if ($('rFwd')) $('rFwd').onclick = e => act('forward', $('rNote').value, e.target);
  if ($('rApp')) $('rApp').onclick = e => act('approve', $('rNote').value, e.target);
  if ($('rRet')) $('rRet').onclick = e => { if (!$('rNote').value.trim()) { toast('Write the reason for returning', true); return; } act('return', $('rNote').value, e.target); };
  if ($('rNote2')) $('rNote2').onclick = e => act('note', $('rN2').value, e.target);
  if ($('rFix')) $('rFix').onclick = () => editor(r.job || null, r);
  $('rHist').onclick = () => r.JobId ? history({ jobId: r.JobId }) : history({ section: r.Section, line: r.Line, a: +r.FromM, b: +r.ToM });
};
function readingsTable(sh, pre, post, Lm, job, all) {
  const cp = STN.checkSheet(sh, pre || {}, Lm); const only = STN.postSpots(sh, cp, job && job.Pos !== '' ? [+job.Pos] : []); const cq = STN.checkSheet(sh, post || {}, Lm, { only });
  const badSet = c => { const s = new Set(); for (const b of c.bad) s.add(b.part + '|' + (b.no || '') + '|' + b.key + '|' + b.field); return s; }; const B1 = badSet(cp), B2 = badSet(cq);
  const cell = (vals, set, part, key, f, n) => { const o = part === 'pnc' ? (((vals || {}).pnc || {})[n] || {})[key] || {} : (((vals || {})[part] || {})[String(key)] || {}); const v = o[f]; if (v == null || v === '') return '<td class="muted">·</td>'; return `<td class="${set.has(part + '|' + (n || '') + '|' + key + '|' + f) ? 'redv' : ''}">${esc(v)}</td>`; };
  const has = (vals, part, pos) => { const o = ((vals || {})[part] || {})[String(pos)]; return o && Object.values(o).some(v => v !== '' && v != null); };
  const keepG = s => all || cp.red.gx.some(x => Math.abs(x - s.pos) < 0.05) || has(post, 'gx', s.pos); const keepA = s => all || cp.red.av.some(x => Math.abs(x - s.pos) < 0.05) || has(post, 'av', s.pos);
  let h = `<div class="row small"><span class="muted">Red = outside the limit. "After" columns are filled only at the defect spots.</span><label class="right"><input type="checkbox" id="rAll" ${all ? 'checked' : ''}> show all ${sh.gx.length + sh.av.length} points (now: only red points and points measured after work)</label></div><div class="scroll"><table class="t sheet compact"><thead><tr><th>Point</th><th>Gauge before</th><th>XL before</th><th>Gauge after</th><th>XL after</th></tr></thead><tbody>${sh.gx.filter(keepG).map(s => `<tr><td class="nw">${STN.fmtCh(s.pos)}${s.R ? ' <span class="small muted">R' + s.R + '</span>' : ''}</td>${cell(pre, B1, 'gx', s.pos, 'g')}${cell(pre, B1, 'gx', s.pos, 'xl')}${cell(post, B2, 'gx', s.pos, 'g')}${cell(post, B2, 'gx', s.pos, 'xl')}</tr>`).join('')}</tbody></table></div>`;
  h += `<div class="scroll" style="margin-top:10px"><table class="t sheet compact"><thead><tr><th>Point</th><th>Chord</th><th>AL/Ve L</th><th>AL/Ve R</th><th>UN L</th><th>UN R</th><th>after AL/Ve L</th><th>after AL/Ve R</th></tr></thead><tbody>${sh.av.filter(keepA).map(s => `<tr><td class="nw">${STN.fmtCh(s.pos)}</td><td class="small">${s.curve ? '20 m' : '7.2 m'}</td>${cell(pre, B1, 'av', s.pos, 'al')}${cell(pre, B1, 'av', s.pos, 'ar')}${cell(pre, B1, 'av', s.pos, 'ul')}${cell(pre, B1, 'av', s.pos, 'ur')}${cell(post, B2, 'av', s.pos, 'al')}${cell(post, B2, 'av', s.pos, 'ar')}</tr>`).join('')}</tbody></table></div>`;
  for (const P of sh.pnc || []) {
    if (!all && !(cp.red.pnc[P.no] || []).length) { h += `<div class="small" style="margin-top:8px">P&amp;C ${esc(P.no)}: no reading outside limit (tick "show all" to see the form)</div>`; continue; }
    const keys = ['12.1', '12.2']; for (let i = 0; i < STN.PNC_LEAD_ROWS; i++) keys.push('12.3.' + i); keys.push('15.1', '15.2', '15.3');
    h += `<h4 style="margin:12px 0 4px">P&amp;C ${esc(P.no)}</h4><div class="scroll"><table class="t sheet compact"><thead><tr><th>Position</th><th>ML G</th><th>ML XL</th><th>T/O G</th><th>T/O XL</th><th>T/O Ve</th></tr></thead><tbody>${keys.map(k => { const two = k === '12.1' || k === '12.2'; return `<tr><td class="nw small">${esc(STN.PNC_LABEL[k] || (k.startsWith('12.3.') ? '12.3 ' + (k.endsWith('.0') ? 'ATS/HEEL 0' : 'station ' + k.split('.')[2]) : k))}</td>${two ? cell(pre, B1, 'pnc', k, 'g', P.no) + cell(pre, B1, 'pnc', k, 'xl', P.no) + '<td></td><td></td><td></td>' : cell(pre, B1, 'pnc', k, 'mg', P.no) + cell(pre, B1, 'pnc', k, 'mx', P.no) + cell(pre, B1, 'pnc', k, 'tg', P.no) + cell(pre, B1, 'pnc', k, 'tx', P.no) + (k.startsWith('12.3.') ? cell(pre, B1, 'pnc', k, 'tv', P.no) : '<td></td>')}</tr>`; }).join('')}</tbody></table></div>`;
  }
  return h;
}

// ---------- location history (compare work quality when a peak repeats) ----------
async function history(q, job) { F.histQ = q; F.histJob = job || null; S.view = 'history'; T.render(); }
V.history = async el => {
  el.innerHTML = '<div class="empty">Loading location history…</div>';
  let h; try { h = await call('history', F.histQ, { cache: true }); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.error || e)}</div>`; return; }
  const runs = [...new Set(h.peaks.map(p => p.run).concat(h.blocks.map(b => b.run)))].sort().reverse();
  const recs = h.records.sort((a, b) => String(b.WorkDate).localeCompare(String(a.WorkDate)));
  const resTag = r => r.Result ? `<span class="tag ${r.Result === 'Held' ? 'tg' : r.Result === 'Failed' ? 't1' : 't3'}">${esc(r.Result)}</span>` : (r.Status === 'Approved' ? '<span class="tag t4">waiting for next run</span>' : '');
  const thumbs = r => (r.Photos || []).slice(0, 6).map(p => `<a class="th sm" href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.thumb || '')}" alt="" loading="lazy"><span>${esc(p.kind)}</span></a>`).join('');
  el.innerHTML = T.pageHead('Location history', `${esc(h.lineId)} · ${STN.fmtCh(h.a)} – ${STN.fmtCh(h.b)}`, `<button class="btn secondary sm right" id="hBack">Back</button>`) +
    (recs.length > 1 || recs.some(r => r.Result === 'Failed') ? `<div class="ban warn">Work has been recorded here ${recs.length} time(s). Compare what was done and the readings before / after with the result at the next run.</div>` : '') +
    `<div class="panel body"><h3 class="sec">Work done here (newest first)</h3>${recs.length ? `<div class="scroll"><table class="t"><thead><tr><th>Work date</th><th>Stretch</th><th>Work</th><th>Readings</th><th>Photos</th><th>Status / result</th></tr></thead><tbody>${recs.map(r => `<tr data-r="${esc(r.RecId)}" style="cursor:pointer"><td class="nw">${dmy(r.WorkDate)}<div class="small">${esc(r.EnteredBy)}</div></td><td class="nw">${r.FromM !== '' ? STN.fmtCh(+r.FromM) + '–' + STN.fmtCh(+r.ToM) : '—'}</td><td class="wrap small">${esc((r.WorkTypes || []).join(', '))}${r.Machine ? '<br>' + esc(r.Machine) : ''}</td><td class="small">${(r.PreSummary || {}).outside != null ? `${r.PreSummary.outside} red before → ${(r.PostSummary || {}).stillOutside} after` : ''}</td><td><div class="thumbs">${thumbs(r)}</div></td><td><span class="${stc(r.Status)}">${esc(r.Status)}</span><br>${resTag(r)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No work recorded here yet.</div>'}</div>` +
    `<div class="panel body"><h3 class="sec">TRC results by run</h3>${runs.length ? `<div class="scroll"><table class="t"><thead><tr><th>Run</th><th>Peaks here</th><th>Blocks (CBML / MI=N / at risk)</th></tr></thead><tbody>${runs.map(run => `<tr><td class="nw"><b>${esc(run)}</b></td><td class="small">${h.peaks.filter(p => p.run === run).map(p => `${STN.fmtCh(p.pos)} ${esc(p.param)} ${esc(p.value)} (${esc(p.status)})`).join('<br>') || '—'}</td><td class="small">${h.blocks.filter(b => b.run === run).map(b => `${b.km}/B${b.block} ${b.irpwm === 'N' ? 'CBML' : b.mi === 'N' ? 'MI=N' : 'at risk'}`).join(', ') || '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No TRC peaks or bad blocks here in the uploaded runs.</div>'}</div>` +
    `<div class="panel body"><h3 class="sec">OMS peaks</h3>${h.oms.length ? `<div class="scroll"><table class="t"><thead><tr><th>Run</th><th>km</th><th>Vertical</th><th>Lateral</th></tr></thead><tbody>${h.oms.sort((a, b) => String(b.run).localeCompare(String(a.run))).map(o => `<tr><td>${esc(o.month || o.run)}</td><td>${o.km}</td><td class="n">${o.vertical}</td><td class="n">${o.lateral}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No OMS peaks here.</div>'}</div>` +
    `<div class="panel body"><h3 class="sec">Jobs here</h3>${T.jobTable(h.jobs)}</div>`;
  $('hBack').onclick = () => { S.view = 'work'; T.render(); };
  el.querySelectorAll('tr[data-r]').forEach(tr => tr.onclick = () => openRecord(tr.dataset.r));
};

// ---------- My position: marks lost per KPI item and what to do ----------
function bandAdvice(def, v, marks) {
  if (!def || !def.bands || v == null) return '';
  if (def.kind === 'red') return marks >= def.max ? 'Keep the reduction above 25% at the next run' : 'Reduce by more than 25% at the next run for full marks (10% → 2, 25% → 3)';
  if (def.kind === 'days') return marks >= def.max ? '' : `Field days needed: 16 for full marks (now ${v})`;
  if (def.kind === 'removed') { const nb = def.bands.find(b => b[1] > marks); return nb ? `Remove more DFWRs: above ${nb[0]}% removed gives ${nb[1]}` : ''; }
  const better = def.bands.filter(b => b[1] > marks).sort((a, b) => b[1] - a[1]);
  if (!better.length) return '';
  const nx = def.bands.filter(b => b[1] > marks).sort((a, b) => a[1] - b[1])[0];
  return `Now ${v}${def.name.match(/days/i) ? '' : ' %'} short. Bring it to ${nx[0] === 0 ? '0' : '≤ ' + nx[0]} for ${nx[1]} marks${better[0][1] !== nx[1] ? `; 0 for ${def.max}` : ''}`;
}
V.position = el => {
  const st = S.kpi?.standings || []; const defs = S.B.kpiDefs || {}; const units = S.B.units.map(u => u.unit);
  const u = S.unit !== '__all' ? S.unit : (units.length === 1 ? units[0] : null);
  const stand = `<div class="panel body"><h3 class="sec">Division standing this month (all ${st.length} units)</h3><div class="scroll"><table class="t compact"><thead><tr><th>Rank</th><th>Unit</th><th>KPI forecast</th><th>Gap to unit above</th></tr></thead><tbody>${st.map((x, i) => `<tr data-u="${esc(x.unit)}" class="${x.unit === u ? 'ok' : ''}" style="cursor:pointer"><td class="n">${i + 1}</td><td><b>${esc(x.unit)}</b></td><td class="n">${x.total}</td><td class="n">${i ? (st[i - 1].total - x.total).toFixed(1) : '—'}</td></tr>`).join('')}</tbody></table></div></div>`;
  if (!u) { el.innerHTML = T.pageHead('KPI standing', 'Choose a unit (top left) or tap a row to see what each unit has to do') + stand; el.querySelectorAll('tr[data-u]').forEach(tr => tr.onclick = () => { if (units.includes(tr.dataset.u)) { S.unit = tr.dataset.u; $('selUnit').value = S.unit; T.render(); } }); return; }
  const r = T.kpiRow(u); const rank = st.findIndex(x => x.unit === u) + 1; const above = rank > 1 ? st[rank - 2] : null;
  const J = S.jobs.filter(j => j.Unit === u && T.isOpen(j));
  const items = Object.keys(defs).map(k => { const d = (r && r.Detail || {})[k] || {}; const m = r && r[k] !== '' && r[k] != null ? +r[k] : null; return { k, def: defs[k], m, lost: m == null ? 0 : defs[k].max - m, v: d.v, src: d.src, jobs: J.filter(j => j.KPI === k) }; }).sort((a, b) => b.lost - a.lost || b.jobs.length - a.jobs.length);
  el.innerHTML = T.pageHead('My position – ' + esc(u), 'What the unit will score on the coming 1st if nothing more is done, and what to do to win marks back') +
    `<div class="kpis"><div class="kpi ${r && r.Total >= 78 ? 'ok' : 'warn'}"><div class="l">KPI forecast</div><div class="v">${r ? r.Total : '—'}<small>/ 82</small></div><div class="s">${r ? 'marks lost on items with data: ' + items.reduce((t, x) => t + x.lost, 0) + (items.some(x => x.m == null) ? ` · ${items.filter(x => x.m == null).length} item(s) without data` : '') : 'no data yet'}</div></div><div class="kpi acc"><div class="l">Rank in division</div><div class="v">${rank || '—'}<small>/ ${st.length}</small></div><div class="s">${above ? `${(above.total - (r ? r.Total : 0)).toFixed(1)} marks behind ${esc(above.unit)}` : rank === 1 ? 'top of the division' : ''}</div></div><div class="kpi warn"><div class="l">Open jobs that score</div><div class="v">${J.filter(j => j.KPI).length}</div><div class="s">open the items below</div></div></div>` +
    `<div class="panel body"><div class="scroll"><table class="t"><thead><tr><th>Item</th><th>Marks</th><th>Lost</th><th>What to do</th><th>Open jobs</th></tr></thead><tbody>${items.map(x => `<tr data-k="${x.k}" style="cursor:pointer"><td><b>${x.k}</b> ${esc(x.def.name)}</td><td class="n">${x.m == null ? '–' : x.m} / ${x.def.max}${x.src && /^official/.test(x.src) ? '<sup>*</sup>' : ''}</td><td class="n">${x.lost ? `<span class="od">${x.lost}</span>` : 0}</td><td class="small wrap">${esc(x.lost ? bandAdvice(x.def, x.v, x.m) : (x.m == null ? 'No data uploaded' : 'Full marks – keep it'))}</td><td class="n">${x.jobs.length ? `<b>${x.jobs.length}</b>` : ''}</td></tr>`).join('')}</tbody></table></div><div class="legend"><span>Tap an item to see its jobs and the calculation</span><span>* official TMS marks (no data uploaded for this item)</span></div></div>` + stand;
  el.querySelectorAll('tr[data-k]').forEach(tr => tr.onclick = () => { const x = items.find(i => i.k === tr.dataset.k); modal(`<h3>${x.k} – ${esc(x.def.name)}</h3><p>${esc(x.lost ? bandAdvice(x.def, x.v, x.m) : 'Full marks.')}</p>${x.jobs.length ? `<div class="cards">${x.jobs.slice(0, 50).map(T.jobCard).join('')}</div>` : '<p class="muted">No open jobs for this item.</p>'}<p><button class="btn ghost sm" id="kDet">Calculation details</button></p>`); $('kDet').onclick = () => { if (r) T.kpiCell(u, x.k, r); }; });
  el.querySelectorAll('tr[data-u]').forEach(tr => tr.onclick = () => { if (units.includes(tr.dataset.u)) { S.unit = tr.dataset.u; $('selUnit').value = S.unit; T.render(); } });
};
document.addEventListener('click', e => { const c = e.target.closest('.modal .jc[data-job]'); if (c) { $('modal').classList.add('hidden'); } });

V.quality = async el => {
  el.innerHTML = '<div class="empty">Loading…</div>';
  let q; try { q = await call('quality', {}, { cache: true }); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.error || e)}</div>`; return; }
  q = q.filter(x => T.inUnit({ Unit: x.unit })).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  el.innerHTML = T.pageHead('Work quality', 'Of the approved work, how much held at the next TRC run / TMS data. Held = defect gone; Improved = better but still there; Failed = still defective.') +
    `<div class="panel body">${q.length ? `<div class="scroll"><table class="t"><thead><tr><th>Unit</th><th>Approved records</th><th>Held</th><th>Improved</th><th>Failed</th><th>Waiting for next run</th><th>Quality</th></tr></thead><tbody>${q.map(x => `<tr><td><b>${esc(x.unit)}</b></td><td class="n">${x.approved}</td><td class="n">${x.held}</td><td class="n">${x.improved}</td><td class="n">${x.failed ? `<span class="od">${x.failed}</span>` : 0}</td><td class="n">${x.waiting}</td><td class="n"><b>${x.pct == null ? '—' : x.pct + ' %'}</b></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No approved work records yet.</div>'}</div>`;
};
V.phones = async el => {
  el.innerHTML = '<div class="empty">Loading…</div>';
  let L0; try { L0 = await call('deviceRequests'); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.error || e)}</div>`; return; }
  const draw = L => {
    el.innerHTML = T.pageHead('Phone approvals', 'A personal link opens only on phones approved here. Approve only if the person tells you this is their phone; reject anything you do not recognise (a forwarded link).') +
      `<div class="panel body">${L.length ? `<div class="scroll"><table class="t"><thead><tr><th>Person</th><th>Role / unit</th><th>Phone</th><th>Asked on</th><th>Phones in use</th><th></th></tr></thead><tbody>${L.map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.role)}<div class="small">${esc(x.scope)}</div></td><td class="small">${esc(x.ua || 'unknown')}</td><td class="nw small">${esc(String(x.at).replace('T', ' ').slice(0, 16))}</td><td class="n">${x.approved} / ${x.max}${x.approved >= x.max ? '<div class="small muted">oldest is replaced</div>' : ''}</td><td class="nw"><button class="btn primary sm" data-ok="1" data-u="${esc(x.userId)}" data-d="${esc(x.deviceId)}">Approve</button> <button class="btn secondary sm" data-ok="0" data-u="${esc(x.userId)}" data-d="${esc(x.deviceId)}">Reject</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No phones waiting for approval.</div>'}</div>`;
    el.querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => { b.disabled = true; try { const nl = await call('decideDevice', { userId: b.dataset.u, deviceId: b.dataset.d, ok: b.dataset.ok === '1' }); toast(b.dataset.ok === '1' ? 'Phone approved' : 'Phone rejected'); S.B.pending = await call('pending').catch(() => S.B.pending); T.refreshBanner(); draw(nl); } catch (e) { fail(e); b.disabled = false; } });
  };
  draw(L0);
};

window.TMSC_FIELD = { start, loadRecords, queued, recordsOfJob, editor, openRecord, history, flush };
})();
