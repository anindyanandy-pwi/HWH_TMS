// TMS Control – main app (all roles). Talks to the Apps Script API; works from cached data when there is no signal.
(function () {
'use strict';
const CFG = window.TMSC_CONFIG || {}; const ST = window.TMSC_STORE;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dmy = s => { if (!s) return '—'; const m = String(s).match(/^(\d{4})-(\d\d)-(\d\d)/); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(s); };
const stc = s => 'st ' + String(s || '').replace(/\s+/g, '');
const DEV = (() => { try { let d = localStorage.getItem('tmsc.device'); if (!d) { d = Array.from(crypto.getRandomValues(new Uint32Array(4))).map(x => x.toString(36)).join(''); localStorage.setItem('tmsc.device', d); } return d; } catch (e) { return 'nostorage'; } })();
const UA = (() => { const u = navigator.userAgent; const m = u.match(/Android [\d.]+; ([^;)]+)/) || u.match(/\(([^;)]+)/); return ((m ? m[1] : '') + ' · ' + (/Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : 'Browser')).trim(); })();

// personal link: ?t=… is kept on this phone and removed from the address bar
(() => { const q = new URLSearchParams(location.search); const t = q.get('t'); if (t) { try { localStorage.setItem('tmsc.token', t); } catch (e) { } history.replaceState(null, '', location.pathname); } })();
let TOKEN = ''; try { TOKEN = localStorage.getItem('tmsc.token') || ''; } catch (e) { }
let KEY = ''; try { KEY = localStorage.getItem('tmsc.key') || ''; } catch (e) { }   // phone key from signing in with the mobile number (common link)

// ---------- server calls ----------
function fetchT(url, opt, ms) { return new Promise((res, rej) => { const c = new AbortController(); const t = setTimeout(() => { c.abort(); rej(new Error('timeout')); }, ms); fetch(url, Object.assign({ signal: c.signal }, opt)).then(r => { clearTimeout(t); res(r); }, e => { clearTimeout(t); rej(e); }); }); }
let NET = { ok: true, since: null };
function setNet(ok, cachedAt) {
  NET.ok = ok; const b = $('netbar'); if (!b) return;
  if (ok) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden'); b.textContent = navigator.onLine === false ? `No signal – showing data saved on this phone${cachedAt ? ' (' + String(cachedAt).replace('T', ' ').slice(0, 16) + ')' : ''}. Work records are kept and sent when signal returns.` : `Server not reachable – showing saved data${cachedAt ? ' (' + String(cachedAt).replace('T', ' ').slice(0, 16) + ')' : ''}.`;
}
async function call(fn, args, opt = {}) {
  const body = JSON.stringify({ t: TOKEN, k: TOKEN ? '' : KEY, d: DEV, ua: UA, fn, args: args || {} });
  const ck = opt.cache ? 'c:' + fn + ':' + JSON.stringify(args || {}) : null;
  let r;
  try {
    const res = await fetchT(CFG.API, { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' }, opt.timeout || 120000);
    r = await res.json();
  } catch (e) {
    if (ck) { const c = await ST.get('kv', ck).catch(() => null); if (c) { setNet(false, c.at); return c.data; } }
    if (e && e.message === 'timeout') throw { error: 'The server is still working on this (no answer in ' + Math.round((opt.timeout || 120000) / 1000) + ' s). Open Upload history in a few minutes to see whether it finished before trying again.', timeout: true };
    setNet(false); throw { error: navigator.onLine === false ? 'No signal – this needs the network' : 'Could not reach the server – try again', offline: true };
  }
  setNet(true);
  if (r.ok) { if (ck) ST.set('kv', ck, { at: new Date().toISOString(), data: r.data }).catch(() => { }); return r.data; }
  if (r.access) denied(r.error, r.pending);
  throw r;
}
function denied(msg, pending) {
  $('rail').classList.add('hidden'); $('boot').classList.add('hidden'); $('banner').innerHTML = '';
  const m = esc(String(msg).replace(/^ACCESS(_PENDING)?:\s*/, ''));
  $('views').innerHTML = pending
    ? `<div class="denied" style="border-top-color:var(--warn)"><div class="eyebrow">New phone</div><h2>Waiting for approval</h2><p>${m}</p><p class="muted">Keep this app open or come back later – it checks again every 30 seconds.</p><button class="btn primary" id="reTry">Check now</button><p class="small muted" style="margin-top:14px">Phone: ${esc(UA)}</p></div>`
    : `<div class="denied"><div class="eyebrow">Access</div><h2>Cannot open TMS Control</h2><p>${m}</p><button class="btn primary" id="toJoin">Sign in</button><p class="muted" style="margin-top:12px">Only users added by the division office can open this app.</p></div>`;
  if (!pending) $('toJoin').onclick = () => { try { localStorage.removeItem('tmsc.key'); localStorage.removeItem('tmsc.token'); } catch (e) { } TOKEN = ''; KEY = ''; joinScreen(); };
  if (pending) { $('reTry').onclick = () => location.reload(); clearTimeout(window.__retryT); window.__retryT = setTimeout(() => location.reload(), 30000); }
}
const fail = e => toast((e && e.error) || (e && e.message) || String(e), true);
function toast(msg, bad) { const t = document.createElement('div'); t.className = 'tip'; t.style.cssText = `left:50%;top:60px;transform:translateX(-50%);background:${bad ? '#c62828' : '#14181f'};pointer-events:auto;z-index:200`; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), bad ? 6000 : 2800); }
function modal(html, onOk, okText = 'OK') {
  $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); $('modalOk').textContent = okText; $('modalOk').classList.toggle('hidden', !onOk);
  $('modalOk').onclick = async () => { const r = onOk && await onOk(); if (r !== false) $('modal').classList.add('hidden'); };
  $('modalCancel').onclick = () => $('modal').classList.add('hidden');
}

// ---------- state ----------
const S = { B: null, jobs: [], kpi: null, trc: null, view: null, unit: '__all', f: {}, basis: 'This month', sel: new Set() };
window.TMSC = { call, esc, dmy, modal, toast, S, $, render: () => render(), reload: () => loadAll(), fail, jobTable: (r, o) => jobTable(r, o), stc, DEV, UA, CFG, refreshBanner: () => banner() };
const VIEWS = window.TMSC_VIEWS = {};
const NAVS = {
  JE: [['work', 'My work'], ['records', 'My work records'], ['position', 'My position'], ['done', 'Done & closed']],
  SSE: [['work', 'My work'], ['review', 'Check JE work'], ['records', 'Work records'], ['position', 'My position'], ['kpi', 'KPI detail'], ['done', 'Done & closed']],
  AEN: [['review', 'Approve work'], ['overview', 'Units'], ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['records', 'Work records'], ['position', 'KPI standing'], ['chronic', 'Chronic locations']],
  SRDEN: [['overview', 'Overview'], ['review', 'Pending reviews'], ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['records', 'Work records'], ['position', 'KPI standing'], ['plan', 'Machine plan'], ['chronic', 'Chronic locations']],
  SRDENC: [['overview', 'Division'], ['review', 'Pending reviews'], ['forecast', 'CBML forecast'], ['plan', 'Machine plan'], ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['records', 'Work records'], ['position', 'KPI standing'], ['kpi', 'KPI by unit'], ['chronic', 'Chronic locations']],
  VIEWER: [['overview', 'Division'], ['forecast', 'CBML forecast'], ['plan', 'Machine plan'], ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['position', 'KPI standing'], ['kpi', 'KPI by unit']],
  ADMIN: [['overview', 'Division'], ['review', 'Pending reviews'], ['forecast', 'CBML forecast'], ['plan', 'Machine plan'], ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['records', 'Work records'], ['position', 'KPI standing'], ['kpi', 'KPI by unit'], ['chronic', 'Chronic locations'], ['#Admin'], ['upload', 'Upload data'], ['users', 'Users'], ['settings', 'Settings'], ['uploads', 'Upload history']]
};
const OPEN = ['Open', 'In progress', 'Returned', 'Still defective'];
const isOpen = j => OPEN.includes(j.Status);
const inUnit = x => S.unit === '__all' || x.Unit === S.unit;
const role = () => S.B.user.Role;
const recMode = j => (S.B.recordModes || {})[j.Type] || 'full';
window.TMSC.isOpen = isOpen; window.TMSC.inUnit = inUnit; window.TMSC.role = () => role(); window.TMSC.recMode = recMode; window.TMSC.OPEN = OPEN;

// ---------- sign in on the common link (the plain app address): mobile number + name + designation, no approval ----------
async function joinScreen() {
  $('rail').classList.add('hidden'); $('boot').classList.add('hidden'); $('banner').innerHTML = '';
  const draw = inner => { $('views').innerHTML = `<div class="denied" style="max-width:520px"><div class="eyebrow">HWH TMS Control · Howrah Division</div><h2>Sign in</h2>${inner}<p class="small muted" style="margin-top:16px">Phone: ${esc(UA)}</p></div>`; };
  draw('<div class="empty">Loading…</div>');
  let O; try { O = await call('joinOptions'); } catch (e) { draw(`<p class="od">${esc((e && e.error) || e)}</p><button class="btn primary" onclick="location.reload()">Try again</button>`); return; }
  const v = { mobile: '', name: '', post: '', charge: '' };
  const chargeSel = post => { const P = O.posts.find(x => x.id === post); if (!P || !P.need) return '';
    const list = P.need === 'unit' ? O.units.map(u => [u.unit, u.unit + (u.label && u.label !== u.unit ? ' – ' + u.label : '')]) : (P.need === 'aen' ? O.aens : O.srdens).map(x => [x, x]);
    return `<div class="fld"><label>${P.need === 'unit' ? 'Unit (SSE section)' : P.need === 'aen' ? 'AEN charge' : 'Sr DEN charge'}</label><select id="jCh"><option value="">– choose –</option>${list.map(([k, t]) => `<option value="${esc(k)}" ${k === v.charge ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`; };
  const ask = msg => {
    draw(`<p>Enter your details once. The app then opens directly on this phone.</p>${msg ? `<p class="od">${esc(msg)}</p>` : ''}
      <div class="fld"><label>Mobile number</label><input id="jMob" inputmode="tel" autocomplete="tel" maxlength="16" placeholder="10-digit mobile number" value="${esc(v.mobile)}" style="font-size:17px"></div>
      <div class="fld"><label>Full name</label><input id="jName" autocomplete="name" maxlength="60" placeholder="e.g. Ravi Das" value="${esc(v.name)}" style="font-size:17px"></div>
      <div class="fld"><label>Designation</label><select id="jPost"><option value="">– choose –</option>${O.posts.map(p => `<option value="${esc(p.id)}" ${p.id === v.post ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
      <div id="jChBox">${chargeSel(v.post)}</div><button class="btn primary" id="jGo" style="margin-top:6px">Sign in</button>`);
    const keep = () => { v.mobile = $('jMob').value; v.name = $('jName').value; v.post = $('jPost').value; v.charge = $('jCh') ? $('jCh').value : ''; };
    $('jPost').onchange = () => { keep(); v.charge = ''; $('jChBox').innerHTML = chargeSel(v.post); };
    $('jGo').onclick = () => { keep(); const P = O.posts.find(x => x.id === v.post);
      const miss = []; if (String(v.mobile).replace(/\D/g, '').length < 10) miss.push('mobile number'); if (v.name.trim().length < 3) miss.push('full name'); if (!P) miss.push('designation'); else if (P.need && !v.charge) miss.push(P.need === 'unit' ? 'unit' : 'charge');
      if (miss.length) { ask('Fill in: ' + miss.join(', ')); return; } go(); };
  };
  const go = async pick => {
    const b = $('jGo'); if (b) b.disabled = true;
    try {
      const r = await call('join', Object.assign({}, v, { pick }));
      if (r.choose) { draw(`<p>More than one person is registered with this number. Who are you?</p>${r.choose.map(c => `<button class="btn secondary" style="display:block;margin:6px 0;width:100%;text-align:left" data-p="${esc(c.id)}"><b>${esc(c.name)}</b> · ${esc(c.role)}${c.scope ? ' · ' + esc(c.scope) : ''}</button>`).join('')}`); $('views').querySelectorAll('[data-p]').forEach(x => x.onclick = () => go(x.dataset.p)); return; }
      try { localStorage.setItem('tmsc.key', r.key); localStorage.removeItem('tmsc.token'); } catch (e) { }
      location.reload();
    } catch (e) { ask((e && e.error) || String(e)); }
  };
  ask('');
}
async function boot() {
  if (!CFG.API) { $('boot').innerHTML = '<div class="denied"><h2>Not set up</h2><p>The app address of the server is missing (config.js). The admin has to run push.bat.</p></div>'; return; }
  if (!TOKEN && !KEY) { joinScreen(); return; }
  try {
    S.B = await call('bootstrap', {}, { cache: true });
    const u = S.B.user; $('who').classList.remove('hidden'); $('whoRole').textContent = u.RoleName; $('whoName').textContent = u.Name; $('whoScope').textContent = u.Scope ? '· ' + u.Scope : '';
    fillUnits();
    $('selUnit').onchange = () => { S.unit = $('selUnit').value; render(); };
    $('railFoot').innerHTML = `${esc(S.B.app.name)} v${esc(S.B.app.version)} · app ${esc(CFG.VERSION || '')}<br>Today ${dmy(S.B.today)}`;
    S.view = (NAVS[role()] || NAVS.VIEWER)[0][0];
    $('rail').classList.remove('hidden');
    if (role() === 'ADMIN') await loadAdmin();
    await loadAll();
    if (window.TMSC_FIELD) window.TMSC_FIELD.start();
  } catch (e) { if (!e.access) { $('boot').innerHTML = `<div class="denied"><h2>Could not load</h2><p>${esc(e.error || e)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`; } }
}
// admin tools (file readers, OCR models) are loaded only for the admin
async function loadAdmin() {
  try {
    const [core, models, shotmodel] = await Promise.all(['core.js', 'models.json', 'shotmodel.json'].map(f => fetch(f + '?v=' + CFG.VERSION).then(r => { if (!r.ok) throw new Error(f); return r.text(); })));
    const src = { core, models, shotmodel }; window.__tmscSrc = k => src[k];
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'admin.js?v=' + CFG.VERSION; s.onload = res; s.onerror = () => rej(new Error('admin.js')); document.body.appendChild(s); });
  } catch (e) { toast('Admin tools could not be loaded (' + e.message + '). Upload needs signal.', true); }
}
function fillUnits() {
  const units = S.B.units.map(x => x.unit).sort();
  $('selUnit').innerHTML = (units.length > 1 ? `<option value="__all">All units (${units.length})</option>` : '') + units.map(x => `<option>${esc(x)}</option>`).join('') + (units.length ? '' : '<option value="__all">No units yet</option>');
  if (units.length === 1) S.unit = units[0]; else if (S.unit !== '__all' && !units.includes(S.unit)) S.unit = '__all';
  $('selUnit').value = S.unit;
  $('railUnitWrap').classList.toggle('hidden', units.length < 2 && (role() === 'SSE' || role() === 'JE'));
}
async function loadAll() {
  $('btnReload').disabled = true;
  try {
    const [jobs, kpi, B] = await Promise.all([call('jobs', {}, { cache: true }), call('kpi', {}, { cache: true }), call('bootstrap', {}, { cache: true })]);
    S.B = Object.assign(S.B, B); fillUnits();
    S.jobs = jobs; S.kpi = kpi;
    if (['SRDENC', 'ADMIN', 'VIEWER', 'SRDEN'].includes(role())) S.trc = await call('trc', {}, { cache: true });
    if (window.TMSC_FIELD) await window.TMSC_FIELD.loadRecords();
    $('boot').classList.add('hidden'); render();
  } catch (e) { if (!e.access) fail(e); }
  $('btnReload').disabled = false;
}
$('btnReload').onclick = () => loadAll();
$('btnHelp').onclick = () => modal(helpHtml());
window.addEventListener('online', () => { setNet(true); if (window.TMSC_FIELD) window.TMSC_FIELD.flush(); });

// pending-review banner – on every screen from SSE upwards, so finished work never sits unreviewed
function banner() {
  const el = $('banner'); if (!el || !S.B) return; const p = S.B.pending || {}; const r = role(); const out = [];
  const q = window.TMSC_FIELD ? window.TMSC_FIELD.queued() : 0;
  if (q) out.push(`<div class="ban warn"><b>${q}</b> work record(s) saved on this phone, waiting for signal to upload. <a href="#" data-go="records">See them</a></div>`);
  if (p.returned) out.push(`<div class="ban crit"><b>${p.returned}</b> of your work record(s) returned – correct and send again. <a href="#" data-go="records">Open</a></div>`);
  if (r === 'SSE' && p.review) out.push(`<div class="ban ${p.reviewOver ? 'crit' : 'warn'}"><b>${p.review}</b> JE work record(s) waiting for your check${p.reviewOver ? ` – <b>${p.reviewOver}</b> beyond time` : ''}. <a href="#" data-go="review">Check now</a></div>`);
  if (r === 'AEN' && p.review) out.push(`<div class="ban ${p.reviewOver ? 'crit' : 'warn'}"><b>${p.review}</b> work record(s) waiting for your approval${p.reviewOver ? ` – <b>${p.reviewOver}</b> beyond time` : ''}. <a href="#" data-go="review">Approve now</a></div>`);
  if (['SRDEN', 'SRDENC', 'ADMIN'].includes(r) && (p.sse || p.aen)) out.push(`<div class="ban ${p.sseOver || p.aenOver ? 'crit' : 'warn'}">Waiting for review: <b>${p.sse || 0}</b> with SSEs${p.sseOver ? ` (${p.sseOver} late)` : ''} · <b>${p.aen || 0}</b> with AENs${p.aenOver ? ` (${p.aenOver} late)` : ''}. <a href="#" data-go="review">See who</a></div>`);
  el.innerHTML = out.join('');
  el.querySelectorAll('[data-go]').forEach(a => a.onclick = e => { e.preventDefault(); S.view = a.dataset.go; S.f = {}; render(); });
}

function nav() {
  const N = NAVS[role()] || NAVS.VIEWER; const J = S.jobs.filter(inUnit); const p = S.B.pending || {};
  const cnt = { work: J.filter(isOpen).length, review: p.review || ((p.sse || 0) + (p.aen || 0)) || '', urgent: J.filter(j => j.Overdue || (isOpen(j) && +j.Priority === 1)).length, jobs: J.filter(isOpen).length, chronic: J.filter(j => j.Type === 'CHRONIC' && isOpen(j)).length, plan: J.filter(j => /TRC-(TAMP|RISK|THROUGH|DS)/.test(j.Type) && isOpen(j)).length, phones: p.devices || '' };
  $('nav').innerHTML = N.map(x => x[0][0] === '#' ? `<div class="navgrp">${x[0].slice(1)}</div>` : `<button data-k="${x[0]}" class="${x[0] === S.view ? 'on' : ''}"><span>${x[1]}</span><span class="cnt${(x[0] === 'urgent' || x[0] === 'review' || x[0] === 'phones') && cnt[x[0]] ? ' crit' : ''}">${cnt[x[0]] ?? ''}</span></button>`).join('');
  $('nav').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.view = b.dataset.k; S.f = {}; S.sel = new Set(); render(); window.scrollTo(0, 0); };
}
function render() {
  if (!S.B) return; nav(); banner();
  const v = VIEWS[S.view] || VIEWS.jobs; $('views').innerHTML = `<div class="view on" id="v_${S.view}"></div>`;
  try { const r = v($('v_' + S.view)); if (r && r.catch) r.catch(e => fail(e)); } catch (e) { console.error(e); $('v_' + S.view).innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`; }
}
function pageHead(title, crumbs, extra = '') { return `<div class="pagehead"><div class="crumbs">${crumbs || 'Howrah Division'}</div><div class="phrow"><h1>${title}</h1>${extra}</div></div>`; }
window.TMSC.pageHead = pageHead;

// ---------- job list helpers ----------
const prTag = p => `<span class="tag t${+p || 4}">${+p === 1 ? 'P1 Urgent' : 'P' + (+p || 4)}</span>`;
window.TMSC.prTag = prTag;
const gone = j => j.TmsGone && isOpen(j) || (j.TmsGone && (j.Status === 'Done' || j.Status === 'With SSE'));
const goneTag = j => gone(j) ? `<span class="od" title="TMS no longer shows this job; it stays open here until the SSE / AEN confirm">Closed in TMS, not here (since ${dmy(j.TmsGone)})</span>` : '';
window.TMSC.goneTag = goneTag;
function jobCard(j) {
  return `<div class="jc p${+j.Priority || 4}" data-job="${esc(j.JobId)}"><div class="row">${prTag(j.Priority)}<span class="${stc(j.Status)}">${esc(j.Status)}</span>${goneTag(j)}${j.Overdue ? `<span class="od">Overdue (${j.Overdue === 'AEN' ? 'approval' : 'target ' + dmy(j.Target)})</span>` : ''}<span class="muted right">${esc(j.TypeName)}</span></div>
    <div class="t">${esc(j.Title)}</div><div class="l">${esc(j.Location)}</div>${j.Near ? `<div class="muted">Near: ${esc(j.Near)}</div>` : ''}
    <div class="m"><span>Unit ${esc(j.Unit || '—')}</span><span>Target ${dmy(j.Target)}</span>${j.Check ? `<span><b>${esc(j.Check)}</b></span>` : ''}${j.ReturnReason ? `<span class="od">Returned: ${esc(j.ReturnReason)}</span>` : ''}</div></div>`;
}
window.TMSC.jobCard = jobCard;
function jobTable(rows, opts = {}) {
  if (!rows.length) return `<div class="empty">Nothing here.</div>`;
  const sk = S.f.sort || 'pri'; const sorted = [...rows].sort((a, b) => sk === 'target' ? String(a.Target || '9').localeCompare(String(b.Target || '9')) : sk === 'unit' ? String(a.Unit).localeCompare(String(b.Unit)) || (+a.Pos || 0) - (+b.Pos || 0) : ((+a.Priority || 4) - (+b.Priority || 4)) || String(a.Target || '9').localeCompare(String(b.Target || '9')));
  const view = sorted.slice(0, opts.limit || 500); const sel = opts.select;
  return `<div class="scroll"><table class="t"><thead><tr>${sel ? '<th><input type="checkbox" id="selAll" title="Select all shown"></th>' : ''}<th data-s="pri">Priority</th><th data-s="unit">Unit</th><th>Type</th><th>Location</th><th>Work</th><th data-s="target">Target</th><th>Status</th></tr></thead><tbody>${view.map(j => `<tr data-job="${esc(j.JobId)}" style="cursor:pointer">${sel ? `<td class="selc"><input type="checkbox" data-sel="${esc(j.JobId)}" ${S.sel.has(j.JobId) ? 'checked' : ''}></td>` : ''}<td>${prTag(j.Priority)}</td><td class="nw">${esc(j.Unit || '—')}</td><td class="small">${esc(j.TypeName)}</td><td class="nw"><span class="loc" style="font-size:13px">${esc(j.Location)}</span></td><td class="wrap">${esc(j.Title)}${j.Check ? `<div class="small"><b>${esc(j.Check)}</b></div>` : ''}</td><td class="nw">${dmy(j.Target)}${j.Overdue ? `<div class="od">overdue${j.Overdue === 'AEN' ? ' (AEN)' : ''}</div>` : ''}</td><td><span class="${stc(j.Status)}">${esc(j.Status)}</span>${gone(j) ? `<div class="od small">Closed in TMS, not here</div>` : ''}</td></tr>`).join('')}</tbody></table></div>${sorted.length > view.length ? `<div class="pager">${sorted.length} jobs – showing first ${view.length}; use the filters</div>` : `<div class="pager">${sorted.length} job(s)</div>`}`;
}
document.addEventListener('click', e => {
  if (e.target.closest('.selc') || e.target.id === 'selAll') return;
  const r = e.target.closest('[data-job]'); if (r && !e.target.closest('.drawer')) { openJob(r.dataset.job); return; }
  const th = e.target.closest('th[data-s]'); if (th) { S.f.sort = th.dataset.s; render(); }
});
function filters(rows, opts = {}) {
  const types = [...new Set(rows.map(j => j.TypeName))].sort(); const units = [...new Set(rows.map(j => j.Unit).filter(Boolean))].sort();
  const f = S.f;
  const out = rows.filter(j => (!f.type || j.TypeName === f.type) && (!f.st || (f.st === 'open' ? isOpen(j) : f.st === 'overdue' ? !!j.Overdue : f.st === 'tmsgone' ? gone(j) : j.Status === f.st)) && (!f.u || j.Unit === f.u) && (!f.q || (j.Title + ' ' + j.Location + ' ' + j.Defect + ' ' + j.JobId).toLowerCase().includes(f.q)));
  const bar = `<div class="tablebar"><b>${out.length}</b>
    <select data-f="type"><option value="">All types</option>${types.map(t => `<option ${f.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
    <select data-f="st"><option value="">Any status</option>${[['open', 'Open (all)'], ['overdue', 'Overdue'], ['tmsgone', 'Closed in TMS, not here'], ['With SSE', 'With SSE (JE work)'], ['Done', 'Awaiting AEN'], ['Approved', 'Approved'], ['Verified', 'Verified'], ['Closed', 'Closed'], ['Returned', 'Returned'], ['Still defective', 'Still defective']].map(([v, t]) => `<option value="${v}" ${f.st === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    ${units.length > 1 && !opts.noUnit ? `<select data-f="u"><option value="">All units</option>${units.map(u => `<option ${f.u === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>` : ''}
    <input data-f="q" type="search" placeholder="Search location, km, defect" value="${esc(f.q || '')}" style="padding:5px 8px;border:1px solid #b9bfc9;border-radius:2px;min-width:200px"></div>`;
  return { out, bar };
}
function wireFilters(root) { root.querySelectorAll('[data-f]').forEach(el => { el.onchange = () => { S.f[el.dataset.f] = el.dataset.f === 'q' ? el.value.trim().toLowerCase() : el.value; S.sel = new Set(); render(); }; }); }
window.TMSC.filters = filters; window.TMSC.wireFilters = wireFilters;

// ---------- views ----------
VIEWS.work = el => {
  const J = S.jobs.filter(inUnit); const t = S.B.today; const week = new Date(Date.parse(t) + 7 * 864e5).toISOString().slice(0, 10);
  const lostBy = kpiLost(); const gain = j => lostBy[j.KPI] || 0;
  const groups = [
    ['Overdue', J.filter(j => isOpen(j) && j.Overdue === 'SSE')],
    ['Returned / still defective', J.filter(j => j.Status === 'Returned' || j.Status === 'Still defective')],
    ['Urgent (speed restriction)', J.filter(j => isOpen(j) && !j.Overdue && +j.Priority === 1 && j.Status !== 'Returned')],
    ['Due this week', J.filter(j => isOpen(j) && !j.Overdue && +j.Priority !== 1 && j.Status !== 'Returned' && j.Target && !(j.Target > week))],
    ['Other open work – biggest KPI gain first', J.filter(j => isOpen(j) && !j.Overdue && +j.Priority !== 1 && j.Status !== 'Returned' && j.Status !== 'Still defective' && (!j.Target || j.Target > week))],
    ['Work recorded – with SSE / AEN for review', J.filter(j => j.Status === 'Done' || j.Status === 'With SSE')]
  ];
  const u = S.unit === '__all' ? 'All my units' : 'Unit ' + S.unit;
  el.innerHTML = pageHead('My work', u, `<span class="muted right">${J.filter(isOpen).length} open · ${J.filter(j => j.Overdue).length} overdue</span>`) + kpiStrip() +
    groups.filter(g => g[1].length).map(g => `<h3 class="sec" style="margin:18px 0 8px;background:none;border:none;padding:0">${g[0]} <span class="muted">(${g[1].length})</span></h3><div class="cards">${g[1].sort((a, b) => gain(b) - gain(a) || (+a.Priority || 4) - (+b.Priority || 4) || String(a.Target).localeCompare(String(b.Target))).slice(0, 200).map(jobCard).join('')}</div>`).join('') +
    (J.filter(isOpen).length || J.some(j => j.Status === 'Done') ? '' : `<div class="empty">No open work. Well done.</div>`);
};
function kpiRow(unit) { return (S.kpi?.kpi || []).filter(k => k.Unit === unit && k.Basis === 'This month').sort((a, b) => String(b.Period).localeCompare(String(a.Period)))[0]; }
function kpiLost() { const out = {}; if (S.unit === '__all') return out; const r = kpiRow(S.unit); if (!r) return out; for (const [k, d] of Object.entries(S.B.kpiDefs || {})) if (r[k] !== '' && r[k] != null) out[k] = d.max - +r[k]; return out; }
function kpiStrip() {
  if (S.unit === '__all' || !S.kpi) return '';
  const r = kpiRow(S.unit); if (!r) return ''; const st = S.kpi.standings || []; const rank = st.findIndex(x => x.unit === S.unit) + 1;
  const low = Object.keys(S.B.kpiNames).filter(k => r[k] !== '' && r[k] != null && +r[k] < ((S.B.kpiDefs || {})[k] || {}).max);
  return `<div class="kpis"><div class="kpi ${r.Total >= 78 ? 'ok' : r.Total >= 70 ? 'warn' : 'crit'}" data-go="position" style="cursor:pointer"><div class="l">KPI forecast (this month)</div><div class="v">${r.Total}<small>/ 82</small></div><div class="s">${rank ? `Rank ${rank} of ${st.length} · ` : ''}${low.length ? 'losing marks in ' + low.join(', ') : 'full marks on all items with data'} – tap for what to do</div></div></div>`;
}
document.addEventListener('click', e => { const g = e.target.closest('.kpis [data-go]'); if (g) { S.view = g.dataset.go; render(); } });
VIEWS.done = el => { const J = S.jobs.filter(j => inUnit(j) && !isOpen(j)); const F = filters(J); el.innerHTML = pageHead('Done & closed', 'Last 45 days') + `<div class="panel body">${F.bar}${jobTable(F.out)}</div>`; wireFilters(el); };
VIEWS.jobs = el => {
  const J = S.jobs.filter(inUnit); if (!S.f.st && S.f.st !== '') S.f.st = 'open'; const F = filters(J); const adm = role() === 'ADMIN';
  el.innerHTML = pageHead('All jobs', scopeText(), adm ? `<span class="muted right small">Admin: tick jobs to close / delete them</span>` : '') + `<div class="panel body">${F.bar}${adm ? adminBar(F.out) : ''}${jobTable(F.out, { select: adm })}</div>`; wireFilters(el);
  if (adm) wireAdmin(el, F.out);
};
VIEWS.urgent = el => { const J = S.jobs.filter(j => inUnit(j) && (j.Overdue || (isOpen(j) && +j.Priority === 1))); const F = filters(J); el.innerHTML = pageHead('Overdue & urgent', scopeText()) + `<div class="panel body">${F.bar}${jobTable(F.out)}</div>`; wireFilters(el); };
VIEWS.chronic = el => { const J = S.jobs.filter(j => inUnit(j) && j.Type === 'CHRONIC'); el.innerHTML = pageHead('Chronic locations', 'Same 200 m block defective in the last 3 TRC runs – root-cause work, not repeated tamping. Open a job and tap "Location history" to compare earlier work.') + `<div class="panel body">${jobTable(J)}</div>`; };
function scopeText() { return S.unit === '__all' ? (S.B.user.Scope || 'Howrah Division') : 'Unit ' + S.unit; }
window.TMSC.scopeText = scopeText;

// ---------- admin: close / delete jobs (work done before the system started, or wrong jobs) ----------
function adminBar(rows) {
  return `<div class="tablebar adminbar"><span><b id="selN">${S.sel.size}</b> selected</span><button class="btn secondary sm" data-ad="close">Close as already done</button><button class="btn secondary sm" data-ad="delete">Delete (wrong job)</button><span class="muted">or</span><button class="btn ghost sm" data-ad="closeAll">Close all ${rows.length} in this filter…</button></div>`;
}
function wireAdmin(el, rows) {
  el.querySelectorAll('[data-sel]').forEach(c => c.onchange = () => { c.checked ? S.sel.add(c.dataset.sel) : S.sel.delete(c.dataset.sel); $('selN').textContent = S.sel.size; });
  const all = $('selAll'); if (all) all.onchange = () => { el.querySelectorAll('[data-sel]').forEach(c => { c.checked = all.checked; all.checked ? S.sel.add(c.dataset.sel) : S.sel.delete(c.dataset.sel); }); $('selN').textContent = S.sel.size; };
  el.querySelectorAll('[data-ad]').forEach(b => b.onclick = () => {
    const act = b.dataset.ad; const many = act === 'closeAll'; const ids = many ? rows.map(j => j.JobId) : [...S.sel];
    if (!ids.length) { toast('Tick the jobs first', true); return; }
    const verb = act === 'delete' ? 'Delete' : 'Close as already done';
    modal(`<h3>${verb}: ${ids.length} job(s)</h3><p>${act === 'delete' ? 'Use this for jobs that are wrong. They are hidden from all lists but kept in the history with your reason.' : 'Use this for work already done before the system started. The jobs are closed and will not reopen from the same TMS data.'}</p><div class="fld"><label>Reason (required)</label><textarea id="adR" placeholder="${act === 'delete' ? 'e.g. duplicate of job …, location not in our jurisdiction' : 'e.g. attended in Sept 2026 before the system started (register entry …)'}"></textarea></div>`, async () => {
      const reason = $('adR').value.trim(); if (reason.length < 5) { toast('Write the reason', true); return false; }
      try { const r = await call('adminJobs', { ids, action: act === 'delete' ? 'delete' : 'close', reason }); toast(`${r.count} job(s) ${act === 'delete' ? 'deleted' : 'closed'}`); S.sel = new Set(); await loadAll(); } catch (e) { fail(e); return false; }
    }, verb);
  });
}

VIEWS.overview = el => {
  const r = role(); const level = r === 'AEN' ? 'Unit' : r === 'SRDEN' ? 'AEN' : 'SrDEN';
  const J = S.jobs.filter(inUnit); const t = S.B.today; const m0 = t.slice(0, 8) + '01';
  const groups = {}; const unitMeta = Object.fromEntries(S.B.units.map(u => [u.unit, u]));
  for (const j of J) { const g = level === 'Unit' ? j.Unit : level === 'AEN' ? (j.AEN || unitMeta[j.Unit]?.aen) : (j.SrDEN || unitMeta[j.Unit]?.srden); const o = groups[g || '—'] = groups[g || '—'] || { open: 0, od: 0, p1: 0, wait: 0, odA: 0, done: 0, gone: 0, units: new Set() }; o.units.add(j.Unit); if (isOpen(j)) o.open++; if (gone(j)) o.gone++; if (j.Overdue === 'SSE') o.od++; if (isOpen(j) && +j.Priority === 1) o.p1++; if (j.Status === 'Done' || j.Status === 'With SSE') o.wait++; if (j.Overdue === 'AEN') o.odA++; if ((j.Status === 'Approved' || j.Status === 'Verified' || (j.Status === 'Closed' && j.ApprovedOn)) && String(j.ApprovedOn || j.ClosedOn) >= m0) o.done++; }
  const kp = {}; for (const k of (S.kpi?.kpi || [])) if (k.Basis === 'This month' && inUnit(k)) { const g = level === 'Unit' ? k.Unit : level === 'AEN' ? unitMeta[k.Unit]?.aen : unitMeta[k.Unit]?.srden; (kp[g] = kp[g] || []).push(+k.Total || 0); }
  const avg = a => a && a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '—';
  const tot = Object.values(groups).reduce((a, o) => { for (const k of ['open', 'od', 'p1', 'wait', 'odA', 'done', 'gone']) a[k] = (a[k] || 0) + o[k]; return a; }, {});
  el.innerHTML = pageHead(r === 'AEN' ? 'Units' : r === 'SRDEN' ? 'Overview' : 'Division overview', scopeText()) +
    `<div class="kpis"><div class="kpi ${tot.od ? 'crit' : 'ok'}"><div class="l">Open jobs</div><div class="v">${tot.open || 0}</div><div class="s">${tot.od || 0} overdue at SSE</div></div><div class="kpi ${tot.p1 ? 'crit' : 'ok'}"><div class="l">Urgent (SR)</div><div class="v">${tot.p1 || 0}</div><div class="s">UML defects / overdue inspections</div></div><div class="kpi ${tot.odA ? 'warn' : 'ok'}"><div class="l">Work waiting for review</div><div class="v">${tot.wait || 0}</div><div class="s">${tot.odA || 0} beyond approval time</div></div><div class="kpi acc"><div class="l">Approved this month</div><div class="v">${tot.done || 0}</div><div class="s">since ${dmy(m0)}</div></div><div class="kpi ${tot.gone ? 'crit' : 'ok'}" id="kGone" style="cursor:pointer"><div class="l">Closed in TMS, not here</div><div class="v">${tot.gone || 0}</div><div class="s">open here although TMS shows them closed – not updated in the app</div></div></div>` + reconPanel() +
    `<div class="panel body"><div class="scroll"><table class="t"><thead><tr><th>${level === 'SrDEN' ? 'Sr DEN' : level}</th><th>Open</th><th>Overdue (SSE)</th><th>Urgent open</th><th>Waiting review</th><th>Overdue (AEN)</th><th>Approved this month</th><th>Closed in TMS, not here</th><th>KPI forecast (avg of units)</th></tr></thead><tbody>${Object.entries(groups).sort().map(([g, o]) => `<tr data-g="${esc(g)}" style="cursor:pointer"><td class="nw"><b>${esc(g)}</b></td><td class="n">${o.open}</td><td class="n">${o.od ? `<span class="od">${o.od}</span>` : 0}</td><td class="n">${o.p1}</td><td class="n">${o.wait}</td><td class="n">${o.odA ? `<span class="od">${o.odA}</span>` : 0}</td><td class="n">${o.done}</td><td class="n">${o.gone ? `<span class="od">${o.gone}</span>` : 0}</td><td class="n">${avg(kp[g])}</td></tr>`).join('')}</tbody></table></div></div>`;
  el.querySelectorAll('tr[data-g]').forEach(tr => tr.onclick = () => { const g = tr.dataset.g; if (level === 'Unit') { S.unit = g; $('selUnit').value = g; } S.view = 'urgent'; render(); });
  if ($('kGone') && VIEWS.jobs) $('kGone').onclick = () => { S.f.st = 'tmsgone'; S.view = 'jobs'; render(); };
  el.querySelectorAll('[data-rc]').forEach(b => b.onclick = () => modal(`<h3>Flag the jobs no longer in TMS</h3><p>${esc(b.dataset.txt)}</p><p>Confirm only if the upload was complete (all sections of this list came in). The jobs are then flagged "Closed in TMS, not here"; nothing is closed.</p>`, async () => {
    try { const r = await call('reconConfirm', { type: b.dataset.rc }, { timeout: 360000 }); toast('Done'); (r.recon || []).forEach(l => toast(l)); await loadAll(); } catch (e) { fail(e); return false; }
  }, 'Confirm and flag'));
};
// last upload's reconciliation of the TMS lists (admin): "N closed in TMS – M already closed here, K flagged"; held lists wait for the admin
function reconPanel() {
  const R = S.B.recon; if (role() !== 'ADMIN' || !R || !(R.lists || []).length) return '';
  const nm = { 'K1-INSP': 'Inspections due (K1)', 'K7-OMS': 'Repeated OMS peaks (K7)', 'K10-DEFECT': 'Locations needing attention (K10)', 'K11-IMR': 'IMR (K11)', 'K13-JOG': 'Joggled fish plates (K13)', 'K14-DFWR': 'DFWR (K14)', 'K15-OG': 'Oiling & greasing (K15)' };
  const rows = R.lists.map(r => { const txt = r.held ? `${r.gone} of ${r.open} open jobs (${Math.round(r.gone / Math.max(1, r.open) * 100)} %) are no longer in TMS after one upload` : ''; return `<tr><td>${esc(nm[r.type] || r.type)}</td><td class="n">${r.open}</td><td class="n">${r.gone}</td><td class="n">${r.held ? '–' : r.already}</td><td class="n">${r.held ? '–' : r.flagged ? `<span class="od">${r.flagged}</span>` : 0}</td><td>${r.held ? `<span class="od">Held – sharp drop</span> <button class="btn secondary sm" data-rc="${esc(r.type)}" data-txt="${esc(nm[r.type] + ': ' + txt)}">Check and confirm</button>` : 'OK'}</td></tr>`; }).join('');
  return `<div class="panel body"><h3 class="sec">TMS lists after the last upload <span class="muted small">– ${esc(String(R.when).replace('T', ' ').slice(0, 16))}</span></h3><div class="scroll"><table class="t"><thead><tr><th>List</th><th>Open here before</th><th>Closed in TMS</th><th>Already closed here</th><th>Flagged</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

const KMAX = k => ((S.B.kpiDefs || {})[k] || {}).max || 5;
VIEWS.kpi = el => {
  const all = (S.kpi?.kpi || []).filter(k => inUnit(k)); const basis = S.basis;
  const rows = all.filter(k => k.Basis === basis); const off = {}; for (const o of (S.kpi?.official || [])) if (!off[o.Unit] || o.ProcDate > off[o.Unit].ProcDate) off[o.Unit] = o;
  const K = Object.keys(S.B.kpiNames);
  const cls = (k, v) => v === '' || v == null ? 'mkn' : +v >= KMAX(k) ? 'mk5' : +v >= KMAX(k) - 1 ? 'mk4' : +v >= 3 ? 'mk3' : +v >= 2 ? 'mk2' : 'mk0';
  el.innerHTML = pageHead('KPI by unit', basis === 'This month' ? 'Marks the unit will get on the coming 1st if no further work is done – open the jobs to save the marks' : 'Last month as calculated – compare with the official TMS score (red outline = differs)',
    `<div class="right row"><button class="btn ${basis === 'This month' ? 'primary' : 'secondary'} sm" data-b="This month">This month</button><button class="btn ${basis === 'Last month' ? 'primary' : 'secondary'} sm" data-b="Last month">Last month vs TMS</button></div>`) +
    `<div class="panel body"><div class="scroll"><table class="t km"><thead><tr><th>Unit</th>${K.map(k => `<th title="${esc(S.B.kpiNames[k])}">${k}</th>`).join('')}<th>Total / 82</th>${basis === 'Last month' ? '<th>TMS total</th>' : ''}</tr></thead><tbody>${rows.sort((a, b) => String(a.Unit).localeCompare(String(b.Unit))).map(r => `<tr><td class="nw"><b>${esc(r.Unit)}</b><div class="small">${dmy(r.AsOn)}</div></td>${K.map(k => { const d = (r.Detail || {})[k] || {}; const o = off[r.Unit]; const mis = basis === 'Last month' && o && d.src === 'calc' && o[k] !== '' && +o[k] !== +r[k]; return `<td class="m ${cls(k, r[k])} ${mis ? 'mis' : ''}" data-u="${esc(r.Unit)}" data-k="${k}" style="cursor:pointer" title="${esc(S.B.kpiNames[k])} – ${esc(d.src || '')}">${r[k] === '' || r[k] == null ? '–' : r[k]}${d.src && /^official/.test(d.src) ? '<sup>*</sup>' : ''}</td>`; }).join('')}<td class="n"><b>${r.Total}</b></td>${basis === 'Last month' ? `<td class="n">${off[r.Unit] ? off[r.Unit].Total : '—'}</td>` : ''}</tr>`).join('') || `<tr><td colspan="19" class="empty">No KPI data yet – the admin has to upload TMS reports.</td></tr>`}</tbody></table></div>
    <div class="legend"><span>* = no data uploaded for this item: the latest official TMS marks are shown</span><span>– = no data</span><span>Click a cell for details and to add a remark / site constraint</span></div></div>`;
  el.querySelectorAll('[data-b]').forEach(b => b.onclick = () => { S.basis = b.dataset.b; render(); });
  el.querySelectorAll('td[data-k]').forEach(td => td.onclick = () => kpiCell(td.dataset.u, td.dataset.k, rows.find(r => r.Unit === td.dataset.u)));
};
function kpiCell(unit, k, r) {
  const d = (r.Detail || {})[k] || {}; const notes = (S.kpi.notes || []).filter(n => n.Unit === unit && n.KPI === k).slice(-5).reverse();
  const off = (S.kpi.official || []).filter(o => o.Unit === unit).sort((a, b) => String(b.ProcDate).localeCompare(String(a.ProcDate)))[0];
  const canNote = ['SSE', 'JE', 'AEN', 'SRDEN', 'SRDENC', 'ADMIN'].includes(role());
  modal(`<h3>${esc(unit)} · ${k} – ${esc(S.B.kpiNames[k])}</h3><dl class="dl"><dt>Marks (${esc(r.Basis)})</dt><dd><b>${r[k] === '' ? '—' : r[k]}</b> of ${KMAX(k)}</dd><dt>Value</dt><dd>${d.v == null ? '—' : d.v + (k === 'K16' ? ' days' : ' %')}</dd><dt>Source</dt><dd>${esc(d.src || '—')}</dd><dt>Details</dt><dd class="small">${esc(JSON.stringify(d.d || {}, null, 1)).replace(/[{}"]/g, '')}</dd><dt>Official TMS</dt><dd>${off ? `${off[k]} (processing date ${dmy(off.ProcDate)})` : '—'}</dd></dl>
    <div class="actbox"><h4>Remarks / site constraints for ${k}</h4>${notes.map(n => `<div class="small"><b>${esc(n.Name)}</b> ${dmy(n.When)}: ${esc(n.Note)}</div>`).join('') || '<div class="small muted">None yet.</div>'}
    ${canNote ? `<div class="fld" style="margin-top:8px"><textarea id="kn" placeholder="e.g. Block not available on UP line since 12-Oct; trolley inspection planned 20-Oct"></textarea></div>` : ''}</div>`,
    canNote ? async () => { const v = $('kn').value.trim(); if (!v) return true; try { await call('unitNote', { unit, kpi: k, note: v }); toast('Remark saved'); S.kpi = await call('kpi', {}, { cache: true }); } catch (e) { fail(e); return false; } } : null, 'Save remark');
}
window.TMSC.kpiCell = kpiCell; window.TMSC.kpiRow = kpiRow;

VIEWS.forecast = el => {
  const runs = S.trc?.runs || []; const latest = {}; for (const r of runs) if (!latest[r.LineId] || r.Run > latest[r.LineId].Run) latest[r.LineId] = r;
  const J = S.jobs; const units = new Set(S.B.units.map(u => u.unit));
  const per = {};
  for (const r of Object.values(latest)) for (const [u, c] of Object.entries(r.UnitCounts || {})) { if (!units.has(u) || !inUnit({ Unit: u })) continue; const o = per[u] = per[u] || { cbml: 0, uml: 0, risk: 0, planned: 0, approved: 0, umlDone: 0 }; o.cbml += c.cbml; o.uml += c.uml; o.risk += c.atRisk || 0; }
  const blocksIn = j => (String(j.Extra?.block || '').match(/B\d/g) || []).length;
  for (const j of J) { if (!per[j.Unit]) continue; if (j.Type === 'TRC-TAMP') { const n = blocksIn(j); per[j.Unit].planned += n; if (j.ApprovedOn && j.Status !== 'Deleted') per[j.Unit].approved += n; } if (j.Type === 'TRC-UML' && j.ApprovedOn && j.Status !== 'Deleted') per[j.Unit].umlDone++; }
  const rows = Object.entries(per).sort(); const T = rows.reduce((a, [, o]) => { for (const k in o) a[k] = (a[k] || 0) + o[k]; return a; }, {});
  const f = (a, b) => Math.max(0, a - b);
  el.innerHTML = pageHead('CBML forecast for the next TRC run', 'From the latest TRC run of each line and the tamping jobs in this app') +
    `<div class="kpis"><div class="kpi crit"><div class="l">CBML blocks now</div><div class="v">${T.cbml || 0}</div><div class="s">latest run of each line</div></div><div class="kpi warn"><div class="l">If approved work holds</div><div class="v">${f(T.cbml || 0, T.approved || 0)}</div><div class="s">${T.approved || 0} block(s) in approved tamping jobs</div></div><div class="kpi ok"><div class="l">If all planned tamping is done</div><div class="v">${f(T.cbml || 0, T.planned || 0)}</div><div class="s">${T.planned || 0} block(s) in tamping jobs</div></div><div class="kpi warn"><div class="l">At risk of turning CBML</div><div class="v">${T.risk || 0}</div><div class="s">SD ≥ 85% of NBML limit</div></div><div class="kpi crit"><div class="l">UML peaks now</div><div class="v">${T.uml || 0}</div><div class="s">${T.umlDone || 0} attended & approved</div></div></div>` +
    `<div class="panel body"><div class="scroll"><table class="t"><thead><tr><th>Unit</th><th>CBML now</th><th>In tamping jobs</th><th>Approved</th><th>Forecast if approved work holds</th><th>Forecast if all planned done</th><th>At risk</th><th>UML now</th><th>UML approved</th></tr></thead><tbody>${rows.map(([u, o]) => `<tr><td><b>${esc(u)}</b></td><td class="n">${o.cbml}</td><td class="n">${o.planned}</td><td class="n">${o.approved}</td><td class="n">${f(o.cbml, o.approved)}</td><td class="n">${f(o.cbml, o.planned)}</td><td class="n">${o.risk}</td><td class="n">${o.uml}</td><td class="n">${o.umlDone}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No TRC run uploaded yet.</td></tr>'}</tbody></table></div><div class="legend"><span>K9 (CBML) and K8 (UML) score on the % reduction between runs: more than 25% reduction gives full marks.</span></div></div>`;
};
VIEWS.plan = el => {
  const J = S.jobs.filter(j => inUnit(j) && /^TRC-(TAMP|RISK|THROUGH|DS)$/.test(j.Type) && !['Verified', 'Closed'].includes(j.Status));
  const by = {}; for (const j of J) (by[j.LineId] = by[j.LineId] || []).push(j);
  const len = j => { const m = String(j.Location).match(/,\s*(\d+)\s*m\)/); return m ? +m[1] : 0; };
  el.innerHTML = pageHead('Machine plan', 'Tamping stretches, pre-emptive tamping, deep screening and through-tamping proposals – grouped by line, in km order', `<button class="btn secondary sm right" onclick="window.print()">Print</button>`) +
    (Object.keys(by).sort().map(l => { const L = by[l].sort((a, b) => (+a.Pos || 0) - (+b.Pos || 0)); return `<div class="panel"><div class="panelhead"><span>${esc(l)}</span><span class="muted">${L.length} item(s) · ${(L.filter(j => j.Type !== 'TRC-DS').reduce((a, j) => a + len(j), 0) / 1000).toFixed(2)} km tamping · ${(L.filter(j => j.Type === 'TRC-DS').reduce((a, j) => a + len(j), 0) / 1000).toFixed(2)} km deep screening</span></div><div class="scroll"><table class="t"><thead><tr><th>Priority</th><th>Unit</th><th>Stretch</th><th>Work</th><th>Why</th><th>Target</th><th>Status</th></tr></thead><tbody>${L.map(j => `<tr data-job="${esc(j.JobId)}" style="cursor:pointer"><td>${prTag(j.Priority)}</td><td>${esc(j.Unit)}</td><td class="nw"><b>${esc(j.Location)}</b></td><td>${esc(j.TypeName)}<div class="small">${esc(j.Title)}</div></td><td class="small wrap">${esc(String(j.Defect).split('\n').slice(0, 3).join('; '))}</td><td class="nw">${dmy(j.Target)}</td><td><span class="${stc(j.Status)}">${esc(j.Status)}</span></td></tr>`).join('')}</tbody></table></div></div>`; }).join('') || '<div class="empty">No machine work planned.</div>');
};

// ---------- job drawer ----------
async function openJob(id) {
  const d = $('drawer'); const j0 = S.jobs.find(x => x.JobId === id); if (!j0) return;
  drawJob(j0, null); d.classList.add('on');
  try { const r = await call('job', { id }, { cache: true }); drawJob(r.job, r.log); } catch (e) { if (!e.offline) fail(e); }
}
function drawJob(j, log) {
  const d = $('drawer'); const r = role(); const h = j.Extra?.history || {}; const mode = recMode(j);
  const dl = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
  let acts = '';
  const recs = window.TMSC_FIELD ? window.TMSC_FIELD.recordsOfJob(j.JobId) : [];
  if (['JE', 'SSE', 'ADMIN'].includes(r) && OPEN.includes(j.Status)) {
    if (mode === 'none' && gone(j) && ['SSE', 'ADMIN'].includes(r)) acts += `<div class="actbox"><h4>Closed in TMS, not here</h4><p class="small">TMS stopped showing this job on ${dmy(j.TmsGone)}. Confirm when it was done; the AEN then approves and the job closes.</p><div class="row"><div class="fld"><label>Done on</label><input type="date" id="cfD" max="${S.B.today}" value="${String(j.TmsGone).slice(0, 10)}"></div></div><div class="fld"><label>What was done (register entry, date …)</label><textarea id="cfN"></textarea></div><button class="btn primary" id="aConf">Confirm done</button></div>`;
    else if (mode === 'none') acts += `<div class="actbox"><h4>Closes by itself</h4><p class="small">This is an inspection job. It closes automatically when the TMS register uploaded by the division office shows the inspection.</p></div>`;
    else acts += `<div class="actbox"><h4>Record the work done</h4><p class="small">${mode === 'full' ? 'Worksite chainage, measurements before work (whole stretch) and after work (defect spots), work done and photos (pre-work measurement, post-work measurement, worksite). Works without signal – it is sent when signal returns.' : 'Date, quantity done and worksite photos. Works without signal.'}</p>${gone(j) ? `<p class="small od">TMS stopped showing this job on ${dmy(j.TmsGone)}. It stays open here until the work is recorded and approved.</p>` : ''}<button class="btn primary" id="aRec">${j.Status === 'Returned' ? 'Correct and send again' : 'Record work done'}</button></div>`;
  }
  if (recs.length) acts += `<div class="actbox"><h4>Work record${recs.length > 1 ? 's' : ''}</h4>${recs.map(x => `<div class="row" style="margin:4px 0"><span class="${stc(x.Status)}">${esc(x.Status)}</span><span>${esc(x.RecId || 'not sent yet')} · ${dmy(x.WorkDate)} · ${esc(x.EnteredBy || '')}</span>${x.Result ? `<b>${esc(x.Result)}</b>` : ''}<button class="btn ghost sm" data-rec="${esc(x.RecId || x.ClientId)}">Open</button></div>`).join('')}</div>`;
  if ((r === 'AEN' || r === 'ADMIN') && j.Status === 'Done' && !recs.length) acts += `<div class="actbox"><h4>AEN approval (marked done before work records were introduced)</h4><div class="fld"><label>Remark / reason (required to return)</label><textarea id="aNote2"></textarea></div><div class="row"><button class="btn primary" id="aApprove">Approve</button><button class="btn secondary" id="aReturn">Return to SSE</button></div></div>`;
  acts += `<div class="actbox"><h4>Location history</h4><p class="small">Earlier TRC / OMS results, inspections, jobs and work records with photos at this location.</p><button class="btn secondary sm" id="aHist">Show location history</button></div>`;
  if (['SSE', 'JE', 'AEN', 'SRDEN', 'SRDENC', 'ADMIN'].includes(r)) acts += `<div class="actbox"><h4>Add remark</h4><div class="fld"><textarea id="aNote3" placeholder="Site constraint, block not available, material awaited…"></textarea></div><button class="btn secondary sm" id="aNoteBtn">Save remark</button></div>`;
  d.innerHTML = `<div class="dhead"><div style="flex:1">${prTag(j.Priority)} <span class="${stc(j.Status)}">${esc(j.Status)}</span> ${goneTag(j)} ${j.Overdue ? `<span class="od">Overdue</span>` : ''}<h2>${esc(j.Title)}</h2><div class="muted">${esc(j.TypeName)} · Job ${esc(j.JobId)}</div></div><button class="btn secondary sm" id="dClose">Close</button></div>
  <div class="dbody"><dl class="dl">${dl('Exact location', `<b class="loc">${esc(j.Location)}</b>`)}${dl('Unit', esc(j.Unit))}${dl('Near', esc(j.Near))}${dl('Defect found', esc(j.Defect))}${dl('What to do', esc(j.Action))}${dl('Look for', esc(j.LookFor))}
  ${h.tamped ? dl('History', esc(`Last tamped: ${h.tamped}\nClean cushion: ${h.cushion}\nLast deep screening: ${h.ds}\nSleepers: ${h.sleepers}`)) : ''}${dl('Source', esc(j.Source))}${dl('Created', dmy(j.Created))}${dl('Target', dmy(j.Target))}
  ${dl('Done', j.DoneOn ? esc(`${dmy(j.DoneOn)} by ${j.DoneBy}`) + (j.Photo ? ` · <a href="${esc(j.Photo)}" target="_blank" rel="noopener">photo</a>` : '') : '')}${dl('Approved', j.ApprovedOn ? esc(`${dmy(j.ApprovedOn)} by ${j.ApprovedBy}`) : '')}${dl('Returned', esc(j.ReturnReason))}${dl('Check by data', esc(j.Check))}${j.Extra?.prev ? dl('Earlier jobs here', esc(j.Extra.prev.join(', ') + (j.Extra.repeat ? ` – ${j.Extra.repeat} of them attended before` : ''))) : ''}${dl('Closed', j.ClosedOn ? esc(`${dmy(j.ClosedOn)} – ${j.CloseReason}`) : '')}${dl('Remarks', esc(j.SSENote))}</dl>
  ${acts}<h3 class="sec" style="background:none;padding:12px 0 6px;border:none">History</h3><div class="log">${log ? (log.map(l => `<div><b>${esc(l.Name)}</b> · ${esc(l.Action)} ${l.From || l.To ? `<span class="muted">(${esc(l.From)} → ${esc(l.To)})</span>` : ''}<div class="muted">${esc(String(l.When).replace('T', ' '))}${l.Note ? ' – ' + esc(l.Note) : ''}${l.Photo ? ` · <a href="${esc(l.Photo)}" target="_blank" rel="noopener">photo</a>` : ''}</div></div>`).join('') || '<div class="muted">No changes yet.</div>') : '<div class="muted">Loading…</div>'}</div></div>`;
  $('dClose').onclick = () => d.classList.remove('on');
  const act = async (action, args, btn) => { btn.disabled = true; try { const nj = await call('jobAction', Object.assign({ id: j.JobId, action }, args)); const i = S.jobs.findIndex(x => x.JobId === j.JobId); if (i >= 0) S.jobs[i] = nj; toast('Saved'); const r2 = await call('job', { id: j.JobId }); drawJob(r2.job, r2.log); render(); } catch (e) { fail(e); btn.disabled = false; } };
  if ($('aRec')) $('aRec').onclick = () => { d.classList.remove('on'); window.TMSC_FIELD.editor(j, recs.find(x => x.Status === 'Returned')); };
  d.querySelectorAll('[data-rec]').forEach(b => b.onclick = () => { d.classList.remove('on'); window.TMSC_FIELD.openRecord(b.dataset.rec); });
  if ($('aHist')) $('aHist').onclick = () => { d.classList.remove('on'); window.TMSC_FIELD.history({ jobId: j.JobId }, j); };
  if ($('aConf')) $('aConf').onclick = e => act('confirmTms', { date: $('cfD').value, note: $('cfN').value }, e.target);
  if ($('aApprove')) $('aApprove').onclick = e => act('approve', { note: $('aNote2').value }, e.target);
  if ($('aReturn')) $('aReturn').onclick = e => act('return', { note: $('aNote2').value }, e.target);
  if ($('aNoteBtn')) $('aNoteBtn').onclick = e => act('note', { note: $('aNote3').value }, e.target);
}
window.TMSC.openJob = openJob;

function helpHtml() {
  const r = role();
  const common = `<h3>How this works</h3><ul><li>Every job is one piece of field work with its exact location and what to do. Jobs come from the TMS data uploaded by the division office (TRC, OMS, inspections, defects, DFWR, oiling & greasing).</li><li>Work done is recorded in a <b>work record</b>: work done, photos of the handwritten measurement sheets (before and after) and worksite photos with time and GPS location. It works without signal and is sent automatically when signal returns.</li><li>JE work is checked by the SSE, then approved by the AEN. After approval the record is locked.</li><li>The next TRC run / TMS data judges approved work: <b>Held</b>, <b>Improved</b> or <b>Failed</b>.</li></ul>`;
  const per = { JE: `<h3>JE</h3><ol><li><b>My work</b>: open a job, tap <b>Record work done</b>.</li><li>Enter the worksite chainage and the work done.</li><li>Photograph the handwritten measurement sheets – before work and after work (camera or gallery). Readings are not typed.</li><li>Take the worksite photos in the app (location must be on).</li><li>Returned records show at the top – correct and send again.</li></ol>`,
    SSE: `<h3>SSE</h3><ol><li><b>Check JE work</b>: open each record, check the measurement sheet photos and site photos, then <b>Send to AEN</b> or <b>Return</b> with the reason.</li><li>Your own records go straight to the AEN.</li><li><b>My position</b> shows marks lost per KPI item and exactly what to do to win them back.</li></ol>`,
    AEN: `<h3>AEN</h3><ol><li><b>Approve work</b>: check the measurement sheet photos (before and after) and site photos (time, GPS), then Approve or Return.</li></ol>` };
  return common + (per[r] || `<h3>Monitoring</h3><p>The banner at the top shows work waiting for review at SSE and AEN level. KPI standing shows every unit's marks and rank.</p>`) + `<p class="muted">This phone stays signed in. Do not let others use it to enter work in your name. A phone not used for 90 days is signed out – sign in again with your mobile number, name and designation.</p>`;
}
document.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') boot();
})();
