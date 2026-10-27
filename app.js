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
// [E] 23-Oct: invite link / QR ?i=… – kept for this tab only and removed from the address bar
(() => { const q = new URLSearchParams(location.search); const i = q.get('i'); if (i) { try { sessionStorage.setItem('tmsc.invite', i); } catch (e) { } history.replaceState(null, '', location.pathname); } })();
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
  if (r.access) denied(r.error, r.pending, r.pend);
  throw r;
}
// sign-in / access screens: logo, product name in both languages, credit (redesign 16-Oct)
function signinWrap(inner) {
  document.body.classList.add('signedout'); const A = window.UI ? UI.APP : null;
  return A ? `<div class="signin"><img class="slogo" src="${A.logo}" alt=""><h1>${A.name}</h1><div class="shi">${A.nameHi}</div><div class="sorg">${A.org} · ${A.orgHi}</div>${inner}<div class="creditcard">${UI.credit({ br: true, full: true })}</div></div>` : inner;
}
function denied(msg, pending, pend) {
  $('rail').classList.add('hidden'); $('boot').classList.add('hidden'); $('banner').innerHTML = '';
  if (pending && pend) { waitScreen(pend, null); return; }   // [E] 23-Oct: personal link on a further phone – QR + code for the AEN / admin
  const m = esc(String(msg).replace(/^ACCESS(_PENDING)?:\s*/, ''));
  $('views').innerHTML = signinWrap(pending
    ? `<div class="denied" style="border-top-color:var(--warn)"><div class="eyebrow">New phone</div><h2>Waiting for approval</h2><p>${m}</p><p class="muted">Keep this app open or come back later – it checks again every 30 seconds.</p><button class="btn primary" id="reTry">Check now</button><p class="small muted" style="margin-top:14px">Phone: ${esc(UA)}</p></div>`
    : `<div class="denied"><div class="eyebrow">Access</div><h2>Cannot open TMS Control</h2><p>${m}</p><button class="btn primary" id="toJoin">Sign in</button><p class="muted" style="margin-top:12px">Only users added by the division office can open this app.</p></div>`);
  if (!pending) $('toJoin').onclick = () => { try { localStorage.removeItem('tmsc.key'); localStorage.removeItem('tmsc.token'); } catch (e) { } TOKEN = ''; KEY = ''; joinScreen(); };
  if (pending) { $('reTry').onclick = () => location.reload(); clearTimeout(window.__retryT); window.__retryT = setTimeout(() => location.reload(), 30000); }
}
const fail = e => toast((e && e.error) || (e && e.message) || String(e), true);
function toast(msg, bad) { const t = document.createElement('div'); t.className = 'tip'; t.style.cssText = `left:50%;top:70px;transform:translateX(-50%);${bad ? 'background:var(--crit);color:#fff;' : ''}pointer-events:auto;z-index:200;border-radius:12px;padding:10px 16px`; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), bad ? 6000 : 2800); }
function modal(html, onOk, okText = 'OK') {
  $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); $('modalOk').textContent = okText; $('modalOk').classList.toggle('hidden', !onOk);
  $('modalOk').disabled = false;
  $('modalOk').onclick = async () => { const b = $('modalOk'); if (b.disabled) return; b.disabled = true; b.textContent = 'Working…';   // long server calls: show that it is running
    let r; try { r = onOk && await onOk(); } finally { b.disabled = false; b.textContent = okText; } if (r !== false) $('modal').classList.add('hidden'); };
  $('modalCancel').onclick = () => $('modal').classList.add('hidden');
}

// ---------- state ----------
const S = { B: null, jobs: [], kpi: null, trc: null, view: null, unit: '__all', f: {}, basis: 'This month', sel: new Set() };
window.TMSC = { call, esc, dmy, modal, toast, S, $, render: () => render(), reload: () => loadAll(), fail, jobTable: (r, o) => jobTable(r, o), stc, DEV, UA, CFG, refreshBanner: () => banner() };
const VIEWS = window.TMSC_VIEWS = {};
const REMIND = { 'K1-INSP': 'Scheduled inspections (P&C / curve / LWR / LC)', 'K2-FP': 'Foot plate / rear vehicle – km not covered', 'K3-TROLLEY': 'Push trolley / on foot – km not covered', 'K16-DAYS': 'Field visit days' };
const rems = () => (S.B.reminders || []).filter(inUnit);
const planDue = () => (S.B.planDue || []).filter(x => S.unit === '__all' || x.u === S.unit);   // [E] 24-Oct: in-charge's TMS plan still to inspect
const NAVS = {
  JE: [['work', 'My work'], ['insp', 'Inspections due'], ['records', 'My work records'], ['position', 'My position'], ['done', 'Done & closed']],
  SSE: [['work', 'My work'], ['insp', 'Inspections due'], ['review', 'Check JE work'], ['records', 'Work records'], ['position', 'My position'], ['kpi', 'KPI detail'], ['done', 'Done & closed']],
  AEN: [['review', 'Approve work'], ['access', 'Sign-in approvals'] /* [E] 23-Oct */, ['insp', 'Inspections due'], ['overview', 'Units'], ['lag', 'Lagging units'] /* [E] 22-Oct */, ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['records', 'Work records'], ['position', 'KPI standing'], ['chronic', 'Chronic locations']],
  SRDEN: [['overview', 'Overview'], ['lag', 'Lagging units'] /* [E] 22-Oct */, ['insp', 'Inspections due'], ['review', 'Pending reviews'], ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['records', 'Work records'], ['position', 'KPI standing'], ['plan', 'Machine plan'], ['chronic', 'Chronic locations']],
  SRDENC: [['overview', 'Division'], ['lag', 'Lagging units'] /* [E] 22-Oct */, ['insp', 'Inspections due'], ['review', 'Pending reviews'], ['forecast', 'CBML forecast'], ['plan', 'Machine plan'], ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['records', 'Work records'], ['position', 'KPI standing'], ['kpi', 'KPI by unit'], ['chronic', 'Chronic locations']],
  VIEWER: [['overview', 'Division'], ['lag', 'Lagging units'] /* [E] 22-Oct */, ['insp', 'Inspections due'], ['forecast', 'CBML forecast'], ['plan', 'Machine plan'], ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['position', 'KPI standing'], ['kpi', 'KPI by unit']],
  ADMIN: [['overview', 'Division'], ['lag', 'Lagging units'] /* [E] 22-Oct */, ['insp', 'Inspections due'], ['review', 'Pending reviews'], ['forecast', 'CBML forecast'], ['plan', 'Machine plan'], ['urgent', 'Overdue & urgent'], ['jobs', 'All jobs'], ['records', 'Work records'], ['position', 'KPI standing'], ['kpi', 'KPI by unit'], ['chronic', 'Chronic locations'], ['#Admin'], ['access', 'Sign-in approvals'] /* [E] 23-Oct */, ['upload', 'Upload data'], ['users', 'Users'], ['settings', 'Settings'], ['uploads', 'Upload history']]
};
const OPEN = ['Open', 'In progress', 'Returned', 'Still defective'];
const isOpen = j => OPEN.includes(j.Status);
const inUnit = x => S.unit === '__all' || x.Unit === S.unit;
const role = () => S.B.user.Role;
const recMode = j => (S.B.recordModes || {})[j.Type] || 'full';
window.TMSC.NAVS = NAVS;   // [H] 19-Oct: health.js adds its menu entries (Track health)
window.TMSC.versionBanner = () => versionBanner();   // [H] 19-Oct: the admin's Version check banner also on Track health (the admin's first screen)
window.TMSC.isOpen = isOpen; window.TMSC.inUnit = inUnit; window.TMSC.role = () => role(); window.TMSC.recMode = recMode; window.TMSC.OPEN = OPEN;

// ---------- [E] 23-Oct: SECURE SIGN-IN – the plain link gives a request (QR + 6-digit code) that the AEN (own JEs / SSEs) or the admin
// approves; an invite link / QR signs the phone in once. Nobody gets in on a mobile number alone. ----------
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, '0')).join('');
const fmtCode = c => String(c || '').replace(/(\d{3})(\d{3})/, '$1 $2');
const signDraw = (title, inner) => { $('rail').classList.add('hidden'); $('boot').classList.add('hidden'); $('banner').innerHTML = ''; $('views').innerHTML = signinWrap(`<div class="denied"><h2>${window.UI ? UI.title(title) : title}</h2>${inner}<p class="small muted" style="margin-top:16px">Phone: ${esc(UA)}</p></div>`); };
/** waiting for the approver: QR (request id + code) and the code to read out; key = this phone's own key (plain link), null = personal link */
function waitScreen(p, key) {
  const qr = window.TMSC_QR ? TMSC_QR.svg('TMSC1|' + p.req + '|' + p.code, 220) : '';
  let stop = false; const until = Date.parse(String(p.expires).replace(' ', 'T') + '+05:30');
  const draw = (msg, done) => signDraw('Waiting for approval', `<p><b>${esc(p.name || '')}</b>${p.role ? ' · ' + esc(p.role) : ''}${p.scope ? ' · ' + esc(p.scope) : ''}</p>
    <p>This phone is not signed in yet. Show this to <b>${esc(p.approver || 'your AEN or the division office')}</b> – they scan the QR, or you read out the code on a call.</p>
    <div style="text-align:center;margin:12px 0">${qr}<div style="font:700 34px/1.2 ui-monospace,Consolas,monospace;letter-spacing:4px;margin-top:8px" id="wCode">${fmtCode(p.code)}</div><div class="small muted" id="wLeft"></div></div>
    ${msg ? `<p class="${done ? 'od' : 'muted'}">${esc(msg)}</p>` : '<p class="small muted">This page opens by itself as soon as it is approved.</p>'}
    <button class="btn secondary" id="wAgain">Start again</button>`);
  const again = () => { stop = true; try { localStorage.removeItem('tmsc.pend'); } catch (e) { } if (key) { try { localStorage.removeItem('tmsc.pendkey'); } catch (e) { } joinScreen(); } else location.reload(); };
  draw(''); $('wAgain').onclick = again;
  const tick = async () => {
    if (stop) return; const left = Math.max(0, Math.round((until - Date.now()) / 1000)); const el = $('wLeft'); if (el) el.textContent = left ? `code valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} min` : 'code expired';
    if (!left) { draw('The code has expired – start again for a new one.', true); $('wAgain').onclick = again; return; }
    try {
      if (key) { const r = await call('reqStatus', { req: p.req, key });
        if (r.status === 'approved') { stop = true; try { localStorage.setItem('tmsc.key', key); localStorage.removeItem('tmsc.token'); localStorage.removeItem('tmsc.pend'); localStorage.removeItem('tmsc.pendkey'); } catch (e) { } location.reload(); return; }
        if (r.status === 'rejected') { stop = true; try { localStorage.removeItem('tmsc.pend'); } catch (e) { } draw(`Not approved${r.by ? ' by ' + r.by : ''}. Speak to your AEN or the division office.`, true); $('wAgain').onclick = again; return; }
        if (r.status === 'expired') { draw('The code has expired – start again for a new one.', true); $('wAgain').onclick = again; return; } }
      else { const res = await fetchT(CFG.API, { method: 'POST', body: JSON.stringify({ t: TOKEN, k: '', d: DEV, ua: UA, fn: 'bootstrap', args: {} }), headers: { 'Content-Type': 'text/plain;charset=utf-8' } }, 60000).then(x => x.json());
        if (res.ok) { stop = true; location.reload(); return; } }
    } catch (e) { }
    setTimeout(tick, key ? 4000 : 8000);
  };
  setTimeout(tick, 1000);
}
/** an invite link / QR: this phone is signed in once as the invited person */
async function inviteScreen(inv) {
  signDraw('Sign in', '<div class="empty">Opening your invite…</div>');
  const key = newKey();
  try { const r = await call('acceptInvite', { i: inv, key }); try { sessionStorage.removeItem('tmsc.invite'); localStorage.setItem('tmsc.key', key); localStorage.removeItem('tmsc.token'); } catch (e) { }
    signDraw('Welcome', `<p><b>${esc(r.name)}</b> · ${esc(r.role)}${r.scope ? ' · ' + esc(r.scope) : ''}</p><p>This phone is now signed in. Opening the app…</p>`); setTimeout(() => location.reload(), 1200); }
  catch (e) { try { sessionStorage.removeItem('tmsc.invite'); } catch (x) { } signDraw('Invite', `<p class="od">${esc((e && e.error) || e)}</p><button class="btn primary" id="iJoin">Sign in another way</button>`); $('iJoin').onclick = () => joinScreen(); }
}
// sign in on the plain link: mobile number → a request (QR + code) for the AEN / admin; a number not in the staff list adds name and designation
async function joinScreen() {
  try { const p = JSON.parse(localStorage.getItem('tmsc.pend') || 'null'), k = localStorage.getItem('tmsc.pendkey'); if (p && k && Date.parse(String(p.expires).replace(' ', 'T') + '+05:30') > Date.now()) { waitScreen(p, k); return; } } catch (e) { }
  const draw = inner => signDraw('Sign in', inner);
  draw('<div class="empty">Loading…</div>');
  let O; try { O = await call('joinOptions'); } catch (e) { draw(`<p class="od">${esc((e && e.error) || e)}</p><button class="btn primary" onclick="location.reload()">Try again</button>`); return; }
  let key = ''; try { key = localStorage.getItem('tmsc.pendkey') || ''; if (!key) { key = newKey(); localStorage.setItem('tmsc.pendkey', key); } } catch (e) { key = newKey(); }
  const v = { mobile: '', name: '', post: '', charge: '', details: false };
  const chargeSel = post => { const P = O.posts.find(x => x.id === post); if (!P || !P.need) return '';
    const list = P.need === 'unit' ? O.units.map(u => [u.unit, u.unit + (u.label && u.label !== u.unit ? ' – ' + u.label : '')]) : (P.need === 'aen' ? O.aens : O.srdens).map(x => [x, x]);
    return `<div class="fld"><label>${P.need === 'unit' ? 'Unit (SSE section)' : P.need === 'aen' ? 'AEN charge' : 'Sr DEN charge'}</label><select id="jCh"><option value="">– choose –</option>${list.map(([k, t]) => `<option value="${esc(k)}" ${k === v.charge ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`; };
  const ask = msg => {
    draw(`${v.details ? '<p>This number is not in the division\'s staff list. Give your details – your AEN or the division office will check and approve.</p>' : '<p>Enter your mobile number. Your AEN or the division office then approves this phone – or open the invite link they sent you.</p>'}${msg ? `<p class="od">${esc(msg)}</p>` : ''}
      <div class="fld"><label>Mobile number</label><input id="jMob" inputmode="tel" autocomplete="tel" maxlength="16" placeholder="10-digit mobile number" value="${esc(v.mobile)}" style="font-size:17px"></div>
      ${v.details ? `<div class="fld"><label>Full name</label><input id="jName" autocomplete="name" maxlength="60" placeholder="e.g. Ravi Das" value="${esc(v.name)}" style="font-size:17px"></div>
      <div class="fld"><label>Designation</label><select id="jPost"><option value="">– choose –</option>${O.posts.map(p => `<option value="${esc(p.id)}" ${p.id === v.post ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
      <div id="jChBox">${chargeSel(v.post)}</div>` : ''}<button class="btn primary" id="jGo" style="margin-top:6px">${v.details ? 'Send for approval' : 'Next'}</button>`);
    const keep = () => { v.mobile = $('jMob').value; if (v.details) { v.name = $('jName').value; v.post = $('jPost').value; v.charge = $('jCh') ? $('jCh').value : ''; } };
    if (v.details) $('jPost').onchange = () => { keep(); v.charge = ''; $('jChBox').innerHTML = chargeSel(v.post); };
    $('jGo').onclick = () => { keep(); const miss = []; if (String(v.mobile).replace(/\D/g, '').length < 10) miss.push('mobile number');
      if (v.details) { const P = O.posts.find(x => x.id === v.post); if (v.name.trim().length < 3) miss.push('full name'); if (!P) miss.push('designation'); else if (P.need && !v.charge) miss.push(P.need === 'unit' ? 'unit' : 'charge'); }
      if (miss.length) { ask('Fill in: ' + miss.join(', ')); return; } go(); };
  };
  const go = async pick => {
    const b = $('jGo'); if (b) b.disabled = true;
    try {
      const r = await call('join', Object.assign({ mobile: v.mobile, key }, v.details ? { name: v.name, post: v.post, charge: v.charge } : {}, { pick }));
      if (r.choose) { draw(`<p>More than one person is registered with this number. Who are you?</p>${r.choose.map(c => `<button class="btn secondary" style="display:block;margin:6px 0;width:100%;text-align:left" data-p="${esc(c.id)}"><b>${esc(c.name)}</b> · ${esc(c.role)}${c.scope ? ' · ' + esc(c.scope) : ''}</button>`).join('')}`); $('views').querySelectorAll('[data-p]').forEach(x => x.onclick = () => go(x.dataset.p)); return; }
      if (r.needDetails) { v.details = true; ask(''); return; }
      if (r.pending) { try { localStorage.setItem('tmsc.pend', JSON.stringify(r.pending)); } catch (e) { } waitScreen(r.pending, key); return; }
      ask('Unexpected answer from the server – try again.');
    } catch (e) { ask((e && e.error) || String(e)); }
  };
  ask('');
}
// [E] 22-Oct: every user, every start – if the website already has a newer build than this page (a saved copy on the device), clear the
// saved copy and load the new one (once per build; offline or no answer = carry on with what is here).
async function freshCheck() {
  try { const site = await fetch('build.json?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null); const have = CFG.VERSION || '';
    if (!site || !site.web || !have || site.web <= have) return false;
    const k = 'tmsc.heal.' + site.web; if (sessionStorage.getItem(k)) return false; sessionStorage.setItem(k, '1');
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    if (window.caches) for (const x of await caches.keys()) await caches.delete(x);
    location.reload(); return true;
  } catch (e) { return false; }
}
async function boot() {
  if (window.__TMSC_HEALING || await freshCheck()) return;
  if (!CFG.API) { $('boot').innerHTML = '<div class="denied"><h2>Not set up</h2><p>The app address of the server is missing (config.js). The admin has to run push.bat.</p></div>'; return; }
  let INV = ''; try { INV = sessionStorage.getItem('tmsc.invite') || ''; } catch (e) { }
  if (INV) { inviteScreen(INV); return; }   // [E] 23-Oct: invite link / QR
  if (!TOKEN && !KEY) { joinScreen(); return; }
  try {
    S.B = await call('bootstrap', {}, { cache: true });
    const u = S.B.user; $('who').classList.remove('hidden'); $('whoRole').textContent = u.RoleName; $('whoName').textContent = u.Name; $('whoScope').textContent = u.Scope ? '· ' + u.Scope : '';
    fillUnits();
    $('selUnit').onchange = () => { S.unit = $('selUnit').value; render(); };
    if (window.UI) UI.defaultLang(u.Role);
    $('railFoot').innerHTML = (window.UI ? UI.credit({ br: true }) + '<div style="margin-top:6px">' : '<div>') + `v${esc(S.B.app.version)} · app ${esc(CFG.VERSION || '')} · today ${dmy(S.B.today)}</div>`;
    // [C] 22-Oct: staff who run the TMS Collector (Users → "May upload collected TMS data") get the upload page too
    if (role() !== 'ADMIN' && String(u.CanUpload || '').toLowerCase() === 'yes' && NAVS[role()] && !NAVS[role()].some(x => x[0] === 'upload')) NAVS[role()] = NAVS[role()].concat([['#Data'], ['upload', 'Upload data']]);
    S.view = (NAVS[role()] || NAVS.VIEWER)[0][0];
    $('rail').classList.remove('hidden');
    if (role() === 'ADMIN' || String(u.CanUpload || '').toLowerCase() === 'yes') await loadAdmin();   // [C] 22-Oct: + staff who may upload
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
$('btnReload').onclick = () => { LAG = { d: null, at: 0, p: null }; PLN = {}; loadAll(); };   // [E] 23-Oct: Refresh also asks for the lagging units again
if (window.UI) { $('btnReload').innerHTML = UI.svg('refresh') + `<span class="tl">${UI.t('Refresh')}</span>`; $('btnReload').setAttribute('aria-label', 'Refresh'); $('btnHelp').innerHTML = UI.svg('help') + `<span class="tl">${UI.t('Help')}</span>`; $('btnHelp').setAttribute('aria-label', 'Help'); }
$('btnHelp').onclick = () => modal((window.UI ? UI.about() + '<hr style="border:0;border-top:1px solid var(--line);margin:16px 0">' : '') + helpHtml());
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
  // [E] 23-Oct: sign-in requests made in this person's name on another phone; approvals waiting for this approver
  const SI = S.B.signins || {}; (SI.mine || []).filter(x => x.status !== 'approved').forEach(x => out.push(`<div class="ban crit">Someone asked to sign in <b>as you</b> on a new phone (${esc(x.ua || 'unknown phone')}) on ${esc(String(x.at).slice(8, 10) + '-' + String(x.at).slice(5, 7) + ' ' + String(x.at).slice(11, 16))} – ${esc(x.status === 'open' ? 'waiting for approval' : x.status + (x.by ? ' by ' + x.by : ''))}. If this was not you, tell your AEN or the division office at once.</div>`));
  if (SI.waiting && S.view !== 'access') out.push(`<div class="ban warn"><b>${SI.waiting}</b> sign-in request(s) wait for your approval. <a href="#" data-go="access">Open</a></div>`);
  const R = rems().filter(x => x.Kind !== 'K1-INSP'); if (R.length || planDue().length) { const by = {}; R.forEach(x => { by[x.Kind] = by[x.Kind] || { n: 0, od: 0 }; by[x.Kind].n++; if (x.Overdue === 'Yes') by[x.Kind].od++; });
    const PD = planDue(), k1 = PD.length ? { n: PD.length, od: PD.filter(x => x.st === 'late').length } : null, parts = [];   // [E] 24-Oct: in-charge's TMS plan
    if (k1) parts.push(`<b>${k1.n}</b> inspection(s) due by the in-charge's TMS plan${k1.od ? ` – <b>${k1.od} planned earlier, not done</b>` : ''}`);
    if (by['K2-FP']) parts.push(`foot plate km not covered (${by['K2-FP'].n} unit${by['K2-FP'].n > 1 ? 's' : ''})`);
    if (by['K3-TROLLEY']) parts.push(`trolley / on foot km pending (${by['K3-TROLLEY'].n})`);
    if (by['K16-DAYS']) parts.push(`field days short (${by['K16-DAYS'].n})`);
    if (S.view !== 'insp') out.push(`<div class="ban ${k1 && k1.od ? 'crit' : 'warn'}">Reminder – inspections pending${S.unit !== '__all' ? ' (' + esc(S.unit) + ')' : ''}: ${parts.join(' · ')}. Inspect and enter in TMS; each one clears by itself when the TMS report shows it. <a href="#" data-go="insp">See the list</a></div>`); }
  el.innerHTML = out.join('');
  el.querySelectorAll('[data-go]').forEach(a => a.onclick = e => { e.preventDefault(); S.view = a.dataset.go; S.f = {}; render(); });
}

function nav() {
  const N = NAVS[role()] || NAVS.VIEWER; const J = S.jobs.filter(inUnit); const p = S.B.pending || {};
  const cnt = { insp: (planDue().length + rems().filter(x => x.Kind !== 'K1-INSP').length) || '', work: J.filter(isOpen).length, review: p.review || ((p.sse || 0) + (p.aen || 0)) || '', urgent: J.filter(j => j.Overdue || (isOpen(j) && +j.Priority === 1)).length, jobs: J.filter(isOpen).length, chronic: J.filter(j => j.Type === 'CHRONIC' && isOpen(j)).length, plan: J.filter(j => /TRC-(TAMP|RISK|THROUGH|DS)/.test(j.Type) && isOpen(j)).length, phones: p.devices || '', access: (S.B.signins || {}).waiting || '' /* [E] 23-Oct */ };
  $('nav').innerHTML = N.map(x => x[0][0] === '#' ? `<div class="navgrp">${window.UI ? UI.t(x[0].slice(1)) : x[0].slice(1)}</div>` : `<button data-k="${x[0]}" class="${x[0] === S.view ? 'on' : ''}">${window.UI ? UI.navIcon(x[0]) : ''}${(b => `<span class="nl"><span class="p">${b.p}</span>${b.s ? `<span class="s">${b.s}</span>` : ''}</span>`)(window.UI ? UI.bi(x[1]) : { p: x[1], s: '' })}<span class="cnt${(x[0] === 'urgent' || x[0] === 'review' || x[0] === 'phones' || x[0] === 'access') && cnt[x[0]] ? ' crit' : ''}">${cnt[x[0]] ?? ''}</span></button>`).join('');
  $('nav').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.view = b.dataset.k; S.f = {}; S.sel = new Set(); render(); window.scrollTo(0, 0); };
}
function render() {
  if (!S.B) return; nav(); banner();
  const v = VIEWS[S.view] || VIEWS.jobs; $('views').innerHTML = `<div class="view on" id="v_${S.view}"></div>`;
  try { const r = v($('v_' + S.view)); if (r && r.catch) r.catch(e => fail(e)); } catch (e) { console.error(e); $('v_' + S.view).innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`; }
}
function pageHead(title, crumbs, extra = '') { return `<div class="pagehead"><div class="crumbs">${crumbs || 'Howrah Division'}</div><div class="phrow"><h1>${window.UI ? UI.title(title) : title}</h1>${extra}</div></div>`; }
window.TMSC.pageHead = pageHead;

// ---------- job list helpers ----------
const prTag = p => `<span class="tag t${+p || 4}">${+p === 1 ? 'P1 Urgent' : 'P' + (+p || 4)}</span>`;
window.TMSC.prTag = prTag;
const gone = j => j.TmsGone && isOpen(j) || (j.TmsGone && (j.Status === 'Done' || j.Status === 'With SSE'));
const goneTag = j => gone(j) ? `<span class="od" title="TMS no longer shows this job; the work recorded here waits for the SSE / AEN – their approval closes it">Closed in TMS, not here (since ${dmy(j.TmsGone)})</span>` : '';
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
  return `<div class="scroll"><table class="t"><thead><tr>${sel ? '<th><input type="checkbox" id="selAll" title="Select all shown"></th>' : ''}<th data-s="pri">Priority</th><th data-s="unit">Unit</th><th>Type</th><th>Location</th><th>Work</th><th data-s="target">Target</th><th>Status</th></tr></thead><tbody>${view.map(j => `<tr data-job="${esc(j.JobId)}" style="cursor:pointer">${sel ? `<td class="selc"><input type="checkbox" data-sel="${esc(j.JobId)}" ${S.sel.has(j.JobId) ? 'checked' : ''}></td>` : ''}<td>${prTag(j.Priority)}</td><td class="nw">${esc(j.Unit || '—')}</td><td class="small">${esc(j.TypeName)}</td><td class="nw"><span class="loc" style="font-size:13px">${esc(j.Location)}</span>${j.LineId && !String(j.Location || '').includes(String(j.LineId)) ? `<div class="small muted">${esc(j.LineId)}</div>` : ''}</td><td class="wrap">${esc(j.Title)}${j.Check ? `<div class="small"><b>${esc(j.Check)}</b></div>` : ''}</td><td class="nw">${dmy(j.Target)}${j.Overdue ? `<div class="od">overdue${j.Overdue === 'AEN' ? ' (AEN)' : ''}</div>` : ''}</td><td><span class="${stc(j.Status)}">${esc(j.Status)}</span>${gone(j) ? `<div class="od small">Closed in TMS, not here</div>` : ''}</td></tr>`).join('')}</tbody></table></div>${sorted.length > view.length ? `<div class="pager">${sorted.length} jobs – showing first ${view.length}; use the filters</div>` : `<div class="pager">${sorted.length} job(s)</div>`}`;
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
    groups.filter(g => g[1].length).map(g => `<h3 class="sec" style="margin:18px 0 8px;background:none;border:none;padding:0">${(b => b.p + (b.s ? ` <span class="small" style="font-weight:500">· ${b.s}</span>` : ''))(window.UI ? UI.bi(g[0]) : { p: g[0], s: '' })} <span class="muted">(${g[1].length})</span></h3><div class="cards">${g[1].sort((a, b) => gain(b) - gain(a) || (+a.Priority || 4) - (+b.Priority || 4) || String(a.Target).localeCompare(String(b.Target))).slice(0, 200).map(jobCard).join('')}</div>`).join('') +
    (J.filter(isOpen).length || J.some(j => j.Status === 'Done') ? '' : `<div class="empty">No open work. Well done.</div>`);
};
function kpiRow(unit) { return (S.kpi?.kpi || []).filter(k => k.Unit === unit && k.Basis === 'This month').sort((a, b) => String(b.Period).localeCompare(String(a.Period)))[0]; }
function kpiLost() { const out = {}; if (S.unit === '__all') return out; const r = kpiRow(S.unit); if (!r) return out; for (const [k, d] of Object.entries(S.B.kpiDefs || {})) if (r[k] !== '' && r[k] != null) out[k] = d.max - +r[k]; return out; }
function kpiStrip() {
  if (S.unit === '__all' || !S.kpi) return '';
  const r = kpiRow(S.unit); if (!r) return ''; const st = S.kpi.standings || []; const rank = st.findIndex(x => x.unit === S.unit) + 1;
  const low = Object.keys(S.B.kpiNames).filter(k => r[k] !== '' && r[k] != null && +r[k] < ((S.B.kpiDefs || {})[k] || {}).max);
  return `<div class="kpis single"><div class="kpi ${r.Total >= 78 ? 'ok' : r.Total >= 70 ? 'warn' : 'crit'}" data-go="position" style="cursor:pointer;display:flex;gap:16px;align-items:center">${window.UI ? UI.ring(r.Total, 82, { size: 76 }) : ''}<div style="flex:1;min-width:0"><div class="l">KPI forecast (this month)</div><div class="v">${r.Total}<small>/ 82</small></div><div class="s">${rank ? `Rank ${rank} of ${st.length} · ` : ''}${low.length ? 'losing marks in ' + low.join(', ') : 'full marks on all items with data'} – tap for what to do</div></div></div></div>`;
}
document.addEventListener('click', e => { const g = e.target.closest('.kpis [data-go]'); if (g) { S.view = g.dataset.go; render(); } });
VIEWS.done = el => { const J = S.jobs.filter(j => inUnit(j) && !isOpen(j)); const F = filters(J); el.innerHTML = pageHead('Done & closed', 'Last 45 days') + `<div class="panel body">${F.bar}${jobTable(F.out)}</div>`; wireFilters(el); };
// [E] 24-Oct: Inspections due – three tabs: what counts for the marks (reminders, as before), TMS's inspection plan of this month
// (in-charge and every sectional JE / SSE – what each still has to inspect, what was planned earlier and not done) and next month.
// The marks keep the Latest-inspection-report rule (user's decision 24-Oct); the plan is for chasing.
let PLN = {};
const PLAN_T = { PXING: 'P&C', CURVE: 'Curve', LWR: 'LWR', LXING: 'LC' };
const PLAN_ST = { done: 'done in the month', late: 'done later', open: 'still to do', notdone: 'not done', latedone: 'done late' };
function planFetch(unit) { const k = unit || '__all'; const c = PLN[k]; if (c && c.d && Date.now() - c.at < 600000) return Promise.resolve(c.d); if (c && c.p) return c.p; const p = call('inspPlan', { unit: k }, { cache: true, timeout: 240000 }).then(d => { PLN[k] = { d, at: Date.now() }; return d; }, e => { delete PLN[k]; throw e; }); PLN[k] = { p }; return p; }
const unitLabel = u => { const m = (S.B.units || []).find(x => x.unit === u); return (m && (m.label || m.Label)) || u; };
const monName = m => { const [y, mo] = String(m).split('-'); return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+mo - 1] + ' ' + y; };
function planAssets(L) { const by = {}; L.forEach(x => { (by[x.t] = by[x.t] || []).push(x.a); }); return Object.keys(PLAN_T).filter(t => by[t]).map(t => `<div class="small"><b>${PLAN_T[t]} (${by[t].length}):</b> ${by[t].map(esc).join(', ')}</div>`).join(''); }
function planCard(o, which) {
  const L = o[which]; const todo = L.filter(x => x.st === 'open' || x.st === 'notdone'); const done = L.filter(x => x.st === 'done' || x.st === 'late');
  // [E] 26-Oct (user: done-late points stay on the page, folded away, for record): TMS's plan keeps a point "not done" when it was
  // inspected after the planned month – the inspection history (TMS's register list) gives the real date and official
  const dShort = s => s ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : '';
  const lateL = which === 'now' ? (o.lateDone || []) : [];
  const othL = o.missed.filter(x => x.oo);
  const miss = which === 'now' && o.missed.length ? `<div style="margin-top:6px"><div class="small od">Planned earlier this year, not done (${o.missed.length}):</div>${planAssets(o.missed)}${othL.length ? `<div class="small muted" style="margin-top:2px">Inspected since, but not by the in-charge: ${othL.map(x => `${esc(x.a)} on ${dShort(x.oo)} by ${esc(x.ob)}`).join('; ')}</div>` : ''}</div>` : '';
  const lateBox = lateL.length ? `<details style="margin-top:6px"><summary class="small muted">Done late – for record (${lateL.length}): TMS's plan still shows them not done</summary><div class="small">${lateL.slice().sort((p, q) => String(p.m).localeCompare(String(q.m)) || String(p.a).localeCompare(String(q.a))).map(x => `${PLAN_T[x.t] || esc(x.t)} ${esc(x.a)} – planned for ${monName(x.m)}, inspected on ${dShort(x.on)} by ${esc(x.by)}`).join('<br>')}</div></details>` : '';
  const body = which === 'next' ? planAssets(L) : (todo.length ? `<div class="small" style="margin-bottom:2px">Still to inspect:</div>${planAssets(todo)}` : `<div class="small ok">Everything planned for the month is done.</div>`) + (done.length ? `<details style="margin-top:4px"><summary class="small muted">Done (${done.length})</summary>${planAssets(done)}</details>` : '') + miss + lateBox;
  return `<div class="panel body" style="margin-bottom:10px"><div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><b>${esc(unitLabel(o.unit))}</b> <span class="muted small">${esc(o.desig)} · ${which === 'next' ? L.length + ' planned' : `${todo.length} to do · ${done.length} done`}${o.missed.length && which === 'now' ? ` · <span class="od">${o.missed.length} not done earlier</span>` : ''}</span></div><div style="margin-top:6px">${body}</div></div>`;
}
// [E] 24-Oct (user: "only the inspection due for the in-charges, nothing from sectionals"): the page shows the SSE/P.Way in-charge's own
// TMS plan (Inspection Planning Report) – this month / next month – and the foot plate / trolley / field-day reminders. The marks
// (KPI-1) are calculated as before, from the Latest inspection report.
VIEWS.insp = el => {
  const R = rems().filter(x => x.Kind !== 'K1-INSP'); const t = S.B.today; const tab = S.inspTab && S.inspTab !== 'marks' ? S.inspTab : 'now';
  const head = pageHead('Inspections due', 'The SSE/P.Way in-charge\'s own inspection plan in TMS. A line clears by itself when the next TMS data shows the inspection – nothing to close here.')
    + `<div class="seg" style="margin-bottom:10px">${[['now', 'This month'], ['next', 'Next month'], ['other', 'Foot plate / trolley / field days' + (R.length ? ' (' + R.length + ')' : '')]].map(([k, x]) => `<button data-itab="${k}" class="${tab === k ? 'on' : ''}">${x}</button>`).join('')}</div>`;
  const wire = () => el.querySelectorAll('[data-itab]').forEach(b => b.onclick = () => { S.inspTab = b.dataset.itab; render(); });
  if (tab === 'other') {
    const sec = ['K2-FP', 'K3-TROLLEY', 'K16-DAYS'].map(k => { const L = R.filter(x => x.Kind === k).sort((a, b) => String(a.Due || '9').localeCompare(String(b.Due || '9')) || String(a.Unit).localeCompare(String(b.Unit))); if (!L.length) return '';
      return `<div class="panel body"><h3 style="margin:0 0 8px">${esc(REMIND[k])} <span class="muted small">${L.length}</span></h3><div class="scroll"><table class="t"><thead><tr><th>Unit</th><th>What</th><th>Where</th><th>Due</th><th>Detail</th></tr></thead><tbody>${L.map(x => `<tr><td>${esc(x.Unit)}</td><td>${esc(x.Title)}</td><td>${esc(x.Location)}</td><td>${dmy(x.Due)}${x.Due && String(x.Due).slice(0, 10) < t ? '<br><span class="od">overdue</span>' : ''}</td><td class="small">${esc(x.Detail)}</td></tr>`).join('')}</tbody></table></div></div>`; }).join('');
    el.innerHTML = head + (sec || `<div class="panel body"><div class="empty">Nothing pending${S.unit !== '__all' ? ' for ' + esc(S.unit) : ''}.</div></div>`); wire(); return;
  }
  el.innerHTML = head + `<div class="panel body"><div class="empty">Reading TMS's inspection plan…</div></div>`; wire();
  planFetch(S.unit).then(P => {
    if (S.view !== 'insp' || (S.inspTab && S.inspTab !== 'marks' ? S.inspTab : 'now') !== tab) return;
    if (!P.have) { el.innerHTML = head + `<div class="panel body"><div class="empty">TMS's inspection plan has not been received yet. It comes with the TMS Collector's daily set (report "Inspection planning").</div></div>`; wire(); return; }
    const which = tab === 'now' ? 'now' : 'next'; const M = which === 'now' ? P.month : P.next;
    const offs = P.officials.filter(o => o.level === '2' && (o[which].length || (which === 'now' && (o.missed.length || (o.lateDone || []).length))));
    const todo = offs.reduce((n, o) => n + o[which].filter(x => x.st === 'open' || x.st === 'notdone').length, 0), late = which === 'now' ? offs.reduce((n, o) => n + o.missed.length, 0) : 0;
    el.innerHTML = head + `<div class="small muted" style="margin:-4px 0 10px">SSE/P.Way in-charge's plan in TMS for <b>${monName(M)}</b>${which === 'now' ? ` – <b>${todo}</b> still to inspect${late ? `, <span class="od">${late} planned earlier and not done</span>` : ''}` : ''} · TMS data fetched ${P.fetched ? dmy(P.fetched.slice(0, 10)) + ' ' + P.fetched.slice(11, 16) : '—'}.</div>`
      + (offs.length ? offs.map(o => planCard(o, which)).join('') : `<div class="panel body"><div class="empty">Nothing planned in TMS for ${monName(M)}.</div></div>`);
    wire();
  }, e => { el.innerHTML = head + `<div class="panel body"><div class="empty">${esc(e.error || e)}</div></div>`; wire(); });
};
VIEWS.jobs = el => {
  const J = S.jobs.filter(inUnit); if (!S.f.st && S.f.st !== '') S.f.st = 'open'; const F = filters(J); const adm = role() === 'ADMIN';
  el.innerHTML = pageHead('All jobs', scopeText(), adm ? `<span class="muted right small">Admin: tick jobs to close / delete them</span>` : '') + `<div class="panel body">${F.bar}${adm ? adminBar(F.out) : ''}${jobTable(F.out, { select: adm })}</div>`; wireFilters(el);
  if (adm) wireAdmin(el, F.out);
};
VIEWS.urgent = el => { const J = S.jobs.filter(j => inUnit(j) && (j.Overdue || (isOpen(j) && +j.Priority === 1))); const F = filters(J); el.innerHTML = pageHead('Overdue & urgent', scopeText()) + `<div class="panel body">${F.bar}${jobTable(F.out)}</div>`; wireFilters(el); };
// [E] 22-Oct: open ones only (the count in the menu is the open ones); closed ones (e.g. outside the division) folded below
VIEWS.chronic = el => { const A = S.jobs.filter(j => inUnit(j) && j.Type === 'CHRONIC'); const J = A.filter(isOpen), C = A.filter(j => !isOpen(j)); el.innerHTML = pageHead('Chronic locations', 'Same 200 m block defective in the last 3 TRC runs – root-cause work, not repeated tamping. Open a job and tap "Location history" to compare earlier work.') + `<div class="panel body">${jobTable(J)}</div>` + (C.length ? `<details class="panel body"><summary class="small">Closed chronic locations (${C.length}) – attended, cleared by a newer run, or outside the division</summary>${jobTable(C)}</details>` : ''); };
function scopeText() { return S.unit === '__all' ? (S.B.user.Scope || 'Howrah Division') : 'Unit ' + S.unit; }
window.TMSC.scopeText = scopeText;

// ---------- admin: close / delete jobs (work done before the system started, or wrong jobs) ----------
function adminBar(rows) {
  return `<div class="tablebar adminbar"><span><b id="selN">${S.sel.size}</b> selected</span><button class="btn secondary sm" data-ad="close">Close as already done</button><button class="btn secondary sm" data-ad="delete">Delete (wrong job)</button><span class="muted">or</span><button class="btn ghost sm" data-ad="closeAll">Close all ${rows.length} in this filter…</button><span class="muted">or</span><button class="btn secondary sm" data-ad="byDate">Close jobs created before a date…</button></div>`;
}
// close every open job created before a chosen date (cut-off) – items still open in TMS come back as fresh jobs at the recalculation
function closeByDate(o = {}) {
  const tname = o.type ? (S.jobs.find(j => j.Type === o.type) || {}).TypeName || o.type : '';
  const def = o.before || S.B.today;
  modal(`<h3>Close jobs created before a date</h3>
    <div class="row"><div class="fld"><label>Cut-off date – jobs created BEFORE this date are closed</label><input type="date" id="cbD" value="${esc(def)}" max="${esc(S.B.today)}"></div></div>
    <p class="small">${o.type || o.unit ? `Only: ${esc([tname, o.unit ? 'unit ' + o.unit : ''].filter(Boolean).join(', '))} (the job list's filter).` : 'All job types and units.'}</p>
    <label class="small"><input type="checkbox" id="cbT"> Also TRC and chronic-location jobs (normally kept open until attended or cleared by a newer run)</label>
    <div id="cbP" class="small" style="margin:10px 0">Counting…</div>
    <p class="small muted">Nothing is deleted: the jobs are closed with the reason "Closed by admin – clean start (created before …)" and keep their history. Right after, the jobs are recalculated: whatever is still open in the latest TMS reports comes back as a <b>fresh job</b> (new number, created today).</p>`, async () => {
    const before = $('cbD').value; if (!before) { toast('Choose the date', true); return false; }
    try { $('cbP').innerHTML = '<b>Closing the jobs…</b> (about a minute)';
      const r = await call('cleanStart', { before, type: o.type || '', unit: o.unit || '', includeTrc: $('cbT').checked, confirm: 'CLOSE', noRefresh: true }, { timeout: 360000 });
      $('cbP').innerHTML = `<b>${r.closed} job(s) closed.</b> Recalculating the jobs from the latest TMS reports… (2–4 minutes – keep this page open)`;
      let f = null; try { const q = await call('refresh', {}, { timeout: 360000 }); f = q; } catch (e2) { toast('Jobs closed. The recalculation did not finish (' + (e2.error || e2.message || e2) + ') – press Recalculate in Settings.', true); }
      toast(`${r.closed} job(s) closed` + (f ? ` – recalculated in ${f.seconds} s` : '')); S.sel = new Set(); await loadAll(); if (o.done) o.done(r); } catch (e) { fail(e); return false; }
  }, 'Close them');
  const prev = async () => { const before = $('cbD').value; if (!before) return; $('cbP').textContent = 'Counting…';
    try { const p = await call('cleanStartPreview', { before, type: o.type || '', unit: o.unit || '', includeTrc: $('cbT').checked }); const by = Object.entries(p.byType).sort().map(([k, n]) => `${k} ${n}`).join(' · ');
      $('cbP').innerHTML = `<b>${p.count}</b> open job(s) created before ${dmy(before)}${by ? ': ' + esc(by) : ''}${p.trcKept ? ` · ${p.trcKept} TRC / chronic job(s) stay open` : ''}`; } catch (e) { $('cbP').textContent = e.error || e.message || e; } };
  $('cbD').onchange = prev; $('cbT').onchange = prev; prev();
}
window.TMSC.closeByDate = closeByDate;
function wireAdmin(el, rows) {
  el.querySelectorAll('[data-sel]').forEach(c => c.onchange = () => { c.checked ? S.sel.add(c.dataset.sel) : S.sel.delete(c.dataset.sel); $('selN').textContent = S.sel.size; });
  const all = $('selAll'); if (all) all.onchange = () => { el.querySelectorAll('[data-sel]').forEach(c => { c.checked = all.checked; all.checked ? S.sel.add(c.dataset.sel) : S.sel.delete(c.dataset.sel); }); $('selN').textContent = S.sel.size; };
  el.querySelectorAll('[data-ad]').forEach(b => b.onclick = () => {
    const act = b.dataset.ad;
    if (act === 'byDate') { const tf = S.f.type ? (S.jobs.find(j => j.TypeName === S.f.type) || {}).Type : ''; closeByDate({ type: tf, unit: S.f.u || (S.unit !== '__all' ? S.unit : '') }); return; }
    const many = act === 'closeAll'; const ids = many ? rows.map(j => j.JobId) : [...S.sel];
    if (!ids.length) { toast('Tick the jobs first', true); return; }
    const verb = act === 'delete' ? 'Delete' : 'Close as already done';
    modal(`<h3>${verb}: ${ids.length} job(s)</h3><p>${act === 'delete' ? 'Use this for jobs that are wrong. They are hidden from all lists but kept in the history with your reason.' : 'Use this for work already done before the system started. The jobs are closed and will not reopen from the same TMS data.'}</p><div class="fld"><label>Reason (required)</label><textarea id="adR" placeholder="${act === 'delete' ? 'e.g. duplicate of job …, location not in our jurisdiction' : 'e.g. attended in Sept 2026 before the system started (register entry …)'}"></textarea></div>`, async () => {
      const reason = $('adR').value.trim(); if (reason.length < 5) { toast('Write the reason', true); return false; }
      try { const r = await call('adminJobs', { ids, action: act === 'delete' ? 'delete' : 'close', reason }); toast(`${r.count} job(s) ${act === 'delete' ? 'deleted' : 'closed'}`); S.sel = new Set(); await loadAll(); } catch (e) { fail(e); return false; }
    }, verb);
  });
}

// [E] 22-Oct: LAGGING UNITS – which unit can still lose marks, where, why, whom to chase (server 14_Lagging.gs, sums and words in
// app/src/lagging.js). [E] 23-Oct: plain words – gist on top, unit cards / by kind of work / table, no KPI codes, marks rounded,
// unit codes as everyone writes them (BWN/E, KWAE-ML), TMS fetch time, deadlines with days left, since yesterday, quick wins.
// Also on "My position" of an SSE (TMSC.lagUnitBox).
const LAG_WORK = { K1: 'P&C / curve / LWR / LC inspections', K2: 'Foot plate / rear vehicle', K3: 'Push trolley / on foot', K10: 'Defects pending compliance', K11: 'IMR removal', K13: 'Joggled fish plates', K14: 'DFWR removal', K15: 'Oiling & greasing of FP joints', K16: 'Field visit days' };
const LAG_LOST = { K5: 'rail fractures', K6: 'weld fractures', K7: 'repeated OMS peaks', K8: 'repeated UML peaks (TRC)', K9: 'repeated CBML blocks (TRC)', K12: 'defective new welds', K10: "this month's defect counts" };
const LAG_CAUSE = { notdone: ['Not done', 'warn', 'SSE'], insp: ['Not done', 'warn', 'SSE'], notentered: ['Done – not entered in TMS', 'crit', 'SSE – enter in TMS'], returned: ['Returned by AEN – redo', 'crit', 'SSE'], sse: ['Waiting for SSE check', 'acc', 'SSE'], aen: ['Waiting for AEN approval', 'acc', 'AEN'], tmswait: ['Done recently – TMS update awaited', 'ok', '—'], lost: ['Lost this month', 'muted', 'SSE'] };
const MONS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ddm = d => d ? `${+String(d).slice(8, 10)} ${MONS[+String(d).slice(5, 7)]}` : '';
const mks = v => { v = +v || 0; if (v < 0.5) return 'under 1 mark'; const r = Math.round(v); return (Math.abs(v - r) > 0.05 ? 'about ' : '') + r + (r === 1 ? ' mark' : ' marks'); };
const nIN = x => Number(x || 0).toLocaleString('en-IN');
const tsl = t => t ? `${String(t).slice(8, 10)}-${String(t).slice(5, 7)} ${String(t).slice(11, 16)}` : '';
const wasY = () => '';   // [E] 24-Oct: plain words – no "since yesterday" (user: simplify the wording)
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copied – paste it in WhatsApp'); return; } catch (e) { } const a = document.createElement('textarea'); a.value = t; a.style.cssText = 'position:fixed;top:-1000px'; document.body.appendChild(a); a.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) { } a.remove(); toast(ok ? 'Copied – paste it in WhatsApp' : 'Select the text and copy it', !ok); }
function msgModal(title, text) {
  modal(`<h3>${esc(title)}</h3><p class="small muted">Check it, then copy and paste it in WhatsApp (or open WhatsApp with it). Nothing is sent by the app.</p><textarea id="lagTxt" readonly style="width:100%;min-height:340px;font:13px/1.45 ui-monospace,Consolas,monospace;box-sizing:border-box">${esc(text)}</textarea><p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn primary sm" id="lagCopy">Copy message</button><a class="btn secondary sm" target="_blank" rel="noopener" href="https://api.whatsapp.com/send?text=${encodeURIComponent(text)}">Open in WhatsApp</a></p>`, null, 'Close');
  $('lagCopy').onclick = () => copyText(text);
}
const dueT = (u, k) => { const d = (u.due || {})[k]; if (!d) return ''; return d.left <= 3 ? `<b class="od">last ${d.left} day${d.left === 1 ? '' : 's'} – by ${ddm(d.by)}</b>` : `by ${ddm(d.by)} · ${d.left} days left`; };
/** one plain line per work for a unit card */
function workLine(u, x) {
  const f = (u.facts || {})[x.k], p = u.prev && u.prev.f ? u.prev.f[x.k] : null;
  const n1 = (u.items || []).filter(i => i.k === 'K1' && i.c !== 'lost').length;
  const t = { K1: `P&C / curve / LWR / LC: ${n1} to inspect (in-charge's TMS plan)`, K2: `Foot plate / rear vehicle: ${f != null ? f + ' km not covered' : 'km not covered'}${wasY(f, p, ' km')}`, K3: `Push trolley / on foot: ${f != null ? f + ' km not covered' : 'km not covered'}${wasY(f, p, ' km')}`,
    K10: `${f} defect${f === 1 ? '' : 's'} will cross 10 days on ${ddm(x.date)} – comply and enter in TMS${wasY(f, p)}`, K15: `Oiling & greasing: ${nIN(f)} FP joints overdue${wasY(f, p)}`, K16: `Field visit days: ${f} so far – ${Math.max(0, 16 - f)} more needed for full marks${wasY(f, p)}`,
    K14: `${f} DFWR older than 90 days to remove${wasY(f, p)}`, K13: `${f} AT weld${f === 1 ? '' : 's'} waiting for joggled fish plates${wasY(f, p)}`, K11: `IMR to remove within 3 days` }[x.k] || esc(x.name || x.k);
  return `<li>${t} <span class="small muted">· ${dueT(u, x.k)}</span></li>`;   // [E] 24-Oct: no marks in the words
}
const lagEdge = s => s >= 10 ? 'crit' : s >= 3 ? 'warn' : 'ok';
function lagCard(u, L) {
  const ks = u.kpis.filter(x => LAG_WORK[x.k] && (x.stake > 0 || (x.k === 'K1' && u.items.some(i => i.k === 'K1'))));   // [E] 24-Oct: = lagging.js pendingWorks (in-charge's plan for inspections)
  return `<div class="panel body" data-card="${esc(u.unit)}" style="border-left:5px solid var(--${lagEdge(u.stake)});margin-bottom:10px"><div class="inner">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:baseline"><h3 style="margin:0;font-size:18px">${esc(u.code || u.unit)}</h3><span class="muted small">${esc(u.aen || '')}</span><span style="margin-left:auto;font-weight:600" class="${ks.length ? 'od' : ''}">${ks.length ? ks.length + ' ' + (ks.length === 1 ? 'thing' : 'things') + ' pending' : 'nothing pending ✓'}</span></div>
    <div style="margin:4px 0 8px"></div>
    ${ks.length ? `<ul style="margin:0 0 6px 18px;padding:0">${ks.map(x => workLine(u, x)).join('')}</ul>` : '<div class="small">Nothing pending – all done.</div>'}
    ${u.causes && u.causes.notentered ? `<div class="small od">${u.causes.notentered} done in the app but not entered in TMS</div>` : ''}
    ${lagChartHtml(u)}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn secondary sm" data-list="${esc(u.unit)}">Show the list</button><button class="btn primary sm" data-msg="${esc(u.unit)}">Chase message</button></div>
    <div data-det="${esc(u.unit)}"></div></div></div>`;
}
// [E] 27-Oct: TMS's inspection chart of the in-charge on the card – counts, night inspection, remarks, and trips the chart shows that
// TMS Control's copy of the registers does not have yet (they are fetched again with the next set)
function lagChartHtml(u) {
  const v = u.chartView; if (!v) return '';
  const miss = (u.chartMissing || []).slice(0, 12).map(x => `${x.t === 'RV' ? 'rear vehicle' : 'foot plate'} ${ddm(x.d)} ${esc(x.section)} ${esc(x.line)}`);
  return `<div class="small" style="margin-top:6px;border-top:1px solid var(--line);padding-top:6px"><div class="muted">From TMS's inspection chart${v.at ? ' (' + esc(ddm(String(v.at).slice(0, 10))) + ')' : ''}</div>
    ${v.notes.map(s => `<div>${esc(s)}</div>`).join('')}${miss.length ? `<details style="margin-top:2px"><summary class="muted">${(u.chartMissing || []).length} trip(s) in TMS's chart not yet in TMS Control's copy of the registers – not to be chased</summary>${miss.join('; ')}${(u.chartMissing || []).length > 12 ? ' …' : ''}. The daily register fetch brings them in; if one stays here for days, fetch "Inspection registers – full period" in the TMS Collector.</details>` : ''}</div>`;
}
function lagDetail(u, L) {
  const ks = u.kpis.filter(x => u.items.some(i => i.k === x.k && i.c !== 'lost'));
  const blocks = ks.map(x => { const it = u.items.filter(i => i.k === x.k && i.c !== 'lost');
    return `<div style="margin-top:12px"><div style="font-weight:600">${esc(LAG_WORK[x.k] || x.name || '')} <span class="small muted">· ${dueT(u, x.k)}${x.stale ? ` · <span class="od">TMS data of ${dmy(x.stale)} – refresh first</span>` : ''}</span></div>
      ${u.chartView && (u.chartView[x.k] || []).length ? `<div class="small" style="margin:4px 0">Where, by TMS's inspection chart:<br>${u.chartView[x.k].map(s => esc(s.replace(/^•\s*/, ''))).join('<br>')}</div>` : ''}
      <div class="scroll"><table class="t compact"><thead><tr><th>What</th><th>Where</th><th>When</th><th>Why still pending</th><th>Who acts</th></tr></thead><tbody>${it.slice(0, 300).map(i => { const c = LAG_CAUSE[i.c] || [i.c, 'muted', '']; return `<tr${i.id ? ` data-job="${esc(i.id)}" style="cursor:pointer"` : ''}><td class="wrap">${esc(i.what)}</td><td class="wrap"><span class="loc" style="font-size:13px">${esc((i.label ? i.label + ' – ' : '') + (i.where || '') + (i.post ? ' (OHE ' + i.post + ')' : ''))}</span>${i.by ? `<div class="small muted">${esc(i.by)}</div>` : ''}</td><td class="nw small">${esc(i.when || (i.target ? 'target ' + dmy(i.target) : ''))}</td><td><span class="tag ${c[1] === 'crit' ? 't1' : c[1] === 'warn' ? 't2' : 't3'}">${esc(c[0])}</span>${i.since ? `<div class="small muted">${i.c === 'notentered' ? 'done ' + dmy(i.since) + ' (' + i.days + ' days)' : dmy(i.since)}</div>` : ''}</td><td class="small nw">${esc(c[2] === 'AEN' ? (u.aen || 'AEN') : c[2].replace(/^SSE/, 'SSE/' + (u.code || u.unit)))}</td></tr>`; }).join('')}</tbody></table></div>${it.length > 300 ? `<div class="pager">${it.length} items – first 300 shown</div>` : ''}</div>`; }).join('');
  const lostIt = u.items.filter(i => i.c === 'lost');
  return (blocks || '<div class="small muted" style="margin-top:8px">No single items behind this.</div>') + (lostIt.length ? `<details style="margin-top:10px"><summary class="small">Lost this month – repeated TRC locations (${lostIt.length})</summary><ul class="small">${lostIt.map(i => `<li>${esc(i.what)} – ${esc(i.where)}</li>`).join('')}</ul></details>` : '');
}
function wireLag(el, L) {
  el.querySelectorAll('[data-msg]').forEach(b => b.onclick = () => { const u = L.units.find(x => x.unit === b.dataset.msg); if (u) msgModal('Chase message – ' + (u.code || u.unit), u.text); });
  el.querySelectorAll('[data-kmsg]').forEach(b => b.onclick = () => { const t = (L.kinds || {})[b.dataset.kmsg]; if (t) msgModal('WhatsApp message – ' + (LAG_WORK[b.dataset.kmsg] || ''), t); });
  el.querySelectorAll('[data-list]').forEach(b => b.onclick = () => { const u = L.units.find(x => x.unit === b.dataset.list); const box = el.querySelector(`[data-det="${CSS.escape(b.dataset.list)}"]`); if (!u || !box) return; if (box.innerHTML) { box.innerHTML = ''; b.textContent = 'Show the list'; return; } box.innerHTML = lagDetail(u, L); b.textContent = 'Hide the list'; });
  // rows with data-job open the job through the page-wide click handler
}
// the server needs ~35 s for this list – one call shared by every render, kept 10 min; Refresh asks again
let LAG = { d: null, at: 0, p: null };
function lagFetch() { if (LAG.d && Date.now() - LAG.at < 600000) return Promise.resolve(LAG.d); if (!LAG.p) LAG.p = call('lagging', {}, { cache: true, timeout: 240000 }).then(d => { LAG = { d, at: Date.now(), p: null }; return d; }, e => { LAG.p = null; throw e; }); return LAG.p; }
async function lagLoad(el) {
  if (LAG.d && Date.now() - LAG.at < 600000) return LAG.d;
  el.innerHTML = '<div class="empty">Working out the lagging units – the server needs about half a minute…</div>';
  try { return await lagFetch(); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.error || e)}</div>`; return null; }
}
function fetchedHtml(L) {
  const f = L.fetched || {}; const v = Object.values(f).sort(); if (!v.length) return '';
  const newest = v[v.length - 1]; const old = Object.keys(f).filter(k => LAG_WORK[k] && (f[k].slice(0, 10) !== newest.slice(0, 10) || Date.parse(newest) - Date.parse(f[k]) > 3 * 36e5));
  return `<div class="small muted" style="margin:-4px 0 10px">TMS data fetched <b>${tsl(newest)}</b>${old.length ? ' · older: ' + old.map(k => `${esc(LAG_WORK[k])} ${tsl(f[k])}`).join(' · ') : ''}</div>`;
}
VIEWS.lag = async el => {
  const L = await lagLoad(el); if (!L) return;
  const tab = S.lagTab || 'unit'; const show = S.unit === '__all' ? L.units : L.units.filter(u => u.unit === S.unit);
  const G = L.gist || { lines: [], worst: [] }; const staleK = Object.keys(L.stale || {}).filter(k => LAG_WORK[k]);
  const head = pageHead('Lagging units', `What each unit must still finish and enter in TMS before ${ddm(L.next1)} – worst first.`) + fetchedHtml(L) +
    (staleK.length ? `<div class="ban warn">TMS data not refreshed recently: ${staleK.map(k => `<b>${esc(LAG_WORK[k])}</b> (data of ${dmy(L.stale[k])})`).join(' · ')}. Fetch these reports in the TMS Collector before chasing.</div>` : '') +
    `<div class="panel body" style="margin-bottom:12px"><div class="inner"><div style="font-size:17px;font-weight:600;margin-bottom:6px">${esc(G.head || '')}</div>
      <ul style="margin:0 0 8px 18px;padding:0">${G.lines.map(x => `<li><b>${esc(x.text)}</b> – ${esc(x.count || (x.units + ' unit' + (x.units === 1 ? '' : 's')))}</li>`).join('')}</ul>
      <div class="small">${G.worst.length ? `Most urgent: <b>${esc(G.worst.join(', '))}</b> · ` : ''}Done in the app but not yet entered in TMS: <b>${G.notEntered || 'none'}</b></div>
      ${L.group ? '<div style="margin-top:10px"><button class="btn primary" id="lagGroup">WhatsApp message for the group</button></div>' : ''}</div></div>
    <div class="seg" style="margin-bottom:10px">${[['unit', 'By unit'], ['work', 'By kind of work'], ['table', 'Table']].map(([k, t]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  let body = '';
  if (tab === 'unit') body = show.map(u => lagCard(u, L)).join('') || '<div class="empty">No units.</div>';
  else if (tab === 'work') body = (L.summary || []).map(x => { const d = (x.units[0] && (L.units.find(u => u.unit === x.units[0].unit) || {}).due || {})[x.k];
    return `<div class="panel body" style="margin-bottom:10px"><div class="inner"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:baseline"><h3 style="margin:0;font-size:17px">${esc(x.title)}</h3><span class="small muted">${x.units.length} unit${x.units.length === 1 ? '' : 's'}${d ? ' · ' + (d.left <= 3 ? `<b class="od">last ${d.left} days</b>` : `by ${ddm(d.by)}, ${d.left} days left`) : ''}</span>${(L.kinds || {})[x.k] ? `<button class="btn primary sm" style="margin-left:auto" data-kmsg="${x.k}">WhatsApp message</button>` : ''}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${x.units.map(y => `<button class="btn secondary sm" data-go-unit="${esc(y.unit)}">${esc(y.code)} · ${x.k === 'K2' || x.k === 'K3' ? (y.f != null ? y.f + ' km' : '') : x.k === 'K16' ? (y.f ?? 0) + ' days' : x.k === 'K15' ? nIN(y.f) + ' joints' : y.n}</button>`).join('')}</div>
      ${x.complete.length ? `<div class="small muted" style="margin-top:8px">Complete: ${esc(x.complete.join(', '))}</div>` : ''}</div></div>`; }).join('') || '<div class="empty">Nothing pending in any unit.</div>';
  else body = `<div class="panel body"><div class="scroll"><table class="t"><thead><tr><th>#</th><th>Unit</th><th>Can still save</th><th>On course for</th><th>If nothing done</th><th>If everything done</th><th>Biggest item</th><th>Done, not in TMS</th><th>Not done</th><th>With SSE / AEN</th><th>Since last week</th></tr></thead><tbody>${show.map(u => { const top = u.kpis.find(x => x.stake > 0 && LAG_WORK[x.k]);
      return `<tr data-go-unit="${esc(u.unit)}" style="cursor:pointer"><td class="n">${u.rank}</td><td><b>${esc(u.code || u.unit)}</b><div class="small muted">${esc(u.aen || '')}</div></td><td class="n">${u.stake >= 0.5 ? `<b class="${u.stake >= 3 ? 'od' : ''}">${Math.round(u.stake)}</b>` : '0'}</td><td class="n">${Math.round(u.now ?? 0)}</td><td class="n">${Math.round(u.worst)}</td><td class="n">${Math.round(u.best)}</td><td class="small">${top ? esc(LAG_WORK[top.k]) + ' (' + mks(top.stake) + ')' : '—'}</td><td class="n">${u.causes.notentered ? `<b class="od">${u.causes.notentered}</b>` : ''}</td><td class="n">${((u.causes.notdone || 0) + (u.causes.insp || 0) + (u.causes.returned || 0)) || ''}</td><td class="n">${((u.causes.sse || 0) + (u.causes.aen || 0)) || ''}</td><td class="n small">${u.trend ? (u.trend.stake > 0.4 ? `<span class="od">+${Math.round(u.trend.stake)}</span>` : u.trend.stake < -0.4 ? Math.round(u.trend.stake) : '0') : ''}</td></tr>`; }).join('')}</tbody></table></div><div class="legend"><span>Marks rounded · tap a unit for its card</span>${L.prev ? `<span>last week = ${dmy(L.prev)}</span>` : '<span>"since last week" shows after a week</span>'}</div></div>`;
  el.innerHTML = head + `<div id="lagBody">${body}</div>`;
  if ($('lagGroup')) $('lagGroup').onclick = () => msgModal('WhatsApp message for the group', L.group);
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.lagTab = b.dataset.tab; VIEWS.lag(el); });
  el.querySelectorAll('[data-go-unit]').forEach(b => b.onclick = () => { S.lagTab = 'unit'; VIEWS.lag(el).then(() => { const c = el.querySelector(`[data-card="${CSS.escape(b.dataset.goUnit)}"]`); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'start' }); const lb = c.querySelector('[data-list]'); if (lb) lb.click(); } }); });
  wireLag(el, L);
};
// an SSE's own card and list on "My position" (field.js)
window.TMSC.lagUnitBox = async (box, unit) => {
  box.innerHTML = '<div class="small muted" style="margin:12px 0">Loading your list of what is still pending…</div>';
  let L; try { L = await lagFetch(); } catch (e) { box.innerHTML = ''; return; }
  const u = L.units.find(x => x.unit === unit); if (!u) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3 class="sec" style="margin:14px 0 6px">${esc(window.UI ? UI.t('What is still pending before') : 'What is still pending before')} ${ddm(L.next1)} – and why</h3>` + fetchedHtml(L) + lagCard(u, L);
  wireLag(box, L); const lb = box.querySelector('[data-list]'); if (lb) lb.click();
};
// [E] 23-Oct: SIGN-IN APPROVALS (AEN for the JEs / SSEs of his units, admin for everyone): approve a new phone by scanning its QR or typing
// its 6-digit code; invite a person (one-use link / QR, 24 h); see what waits and what was decided. Nobody else can approve.
const tIST = s => s ? String(s).replace(/^'/, '').slice(0, 16).replace('T', ' ') : '';
const dmyT = s => { const t = tIST(s); return t ? `${t.slice(8, 10)}-${t.slice(5, 7)} ${t.slice(11, 16)}` : ''; };
async function scanQR() {   // camera QR scan (Chrome on Android); resolves with the text or null
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) { toast('This browser cannot scan – type the 6-digit code instead', true); return null; }
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch (e) { toast('Camera not allowed – type the 6-digit code instead', true); return null; }
  return new Promise(res => {
    modal('<h3>Scan the QR on the other phone</h3><video id="qrV" playsinline muted style="width:100%;max-height:60vh;background:#000;border-radius:12px"></video><p class="small muted">Hold the QR inside the picture.</p>', null, 'Cancel');
    const v = $('qrV'); v.srcObject = stream; v.play(); const det = new BarcodeDetector({ formats: ['qr_code'] }); let done = false;
    const end = t => { if (done) return; done = true; stream.getTracks().forEach(x => x.stop()); $('modal').classList.add('hidden'); res(t); };
    $('modalCancel').onclick = () => end(null); $('modalOk').onclick = () => end(null);
    const loop = async () => { if (done) return; try { const c = await det.detect(v); if (c && c.length) { end(c[0].rawValue); return; } } catch (e) { } setTimeout(loop, 300); };
    loop();
  });
}
window.TMSC.inviteModal = r => inviteModal(r);
function inviteModal(r) {
  const qr = window.TMSC_QR ? TMSC_QR.svg(r.link, 240) : '';
  const text = `TMS Control – invite for ${r.name} (${r.role}${r.scope ? ', ' + r.scope : ''}).\nOpen this link on YOUR OWN phone to sign in (works once, until ${dmyT(r.expires)}):\n${r.link}`;
  modal(`<h3>Invite – ${esc(r.name)}</h3><p class="small">${esc(r.role)}${r.scope ? ' · ' + esc(r.scope) : ''} · works <b>once</b>, until <b>${esc(dmyT(r.expires))}</b>, on the first phone that opens it.</p>
    <div style="text-align:center">${qr}</div><p class="small muted">Let the person scan this with their phone camera – or send the link.</p>
    <textarea readonly style="width:100%;min-height:70px;font:12px ui-monospace,monospace;box-sizing:border-box">${esc(r.link)}</textarea>
    <p style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary sm" id="invCopy">Copy link</button><a class="btn secondary sm" target="_blank" rel="noopener" href="https://api.whatsapp.com/send?text=${encodeURIComponent(text)}">Send on WhatsApp</a></p>`, null, 'Close');
  $('invCopy').onclick = async () => { try { await navigator.clipboard.writeText(r.link); toast('Link copied'); } catch (e) { toast('Select the link and copy it', true); } };
}
VIEWS.access = async el => {
  el.innerHTML = '<div class="empty">Loading…</div>';
  let L; try { L = await call('accessList'); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.error || e)}</div>`; return; }
  const isAdmin = role() === 'ADMIN';
  const people = L.people || [];
  el.innerHTML = pageHead('Sign-in approvals', isAdmin ? 'Approve new phones, invite people. You approve everyone; an AEN approves the JEs / SSEs of his own units.' : 'Approve new phones of the JEs / SSEs of your units, and invite them. Everyone else is approved by the division office.') +
    `<div class="panel body" style="margin-bottom:12px"><div class="inner"><h3 style="margin:0 0 6px">Approve a phone</h3>
      <p class="small muted" style="margin:0 0 8px">The person opens TMS Control on the new phone and gets a QR + a 6-digit code (valid ${L.codeMin} min). Scan the QR when you are together, or ask them to read out the code on a call.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn primary" id="aScan">Scan QR</button><span class="muted">or</span><input id="aCode" inputmode="numeric" maxlength="7" placeholder="6-digit code" style="font:600 20px ui-monospace,monospace;width:150px;letter-spacing:2px"><button class="btn secondary" id="aFind">Find</button></div>
      <div id="aCard" style="margin-top:10px"></div></div></div>
    <div class="panel body" style="margin-bottom:12px"><div class="inner"><h3 style="margin:0 0 6px">Waiting for approval (${L.open.length})</h3>${L.open.length ? `<div class="scroll"><table class="t compact"><thead><tr><th>Person</th><th>Asked as</th><th>Phone</th><th>Asked</th><th>Code valid till</th></tr></thead><tbody>${L.open.map(o => `<tr><td><b>${esc(o.name)}</b><div class="small muted">${esc(o.mobile || '')}</div></td><td class="small">${esc(o.kind === 'new' ? (o.desig || o.role) + ' – not in the staff list' : o.role + (o.scope ? ' · ' + o.scope : ''))}</td><td class="small">${esc(o.ua || '')}</td><td class="nw small">${esc(dmyT(o.asked))}</td><td class="nw small">${esc(dmyT(o.expires))}</td></tr>`).join('')}</tbody></table></div><p class="small muted">To approve, scan the QR or type the code shown on that phone – this list alone cannot approve.</p>` : '<div class="small muted">Nothing waiting.</div>'}</div></div>
    <div class="panel body" style="margin-bottom:12px"><div class="inner"><h3 style="margin:0 0 6px">Invite someone</h3>
      <p class="small muted" style="margin:0 0 8px">One-use link / QR, valid ${L.inviteH} hours, tied to the first phone that opens it. Role and unit come from here – the person cannot change them.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><select id="iWho" style="min-width:260px"><option value="">– choose a person –</option>${people.map(p => `<option value="${esc(p.userId)}">${esc(p.scope || '—')} · ${esc(p.name)} · ${esc(p.role)}${p.phones ? ' (' + p.phones + ' phone' + (p.phones > 1 ? 's' : '') + ')' : ''}</option>`).join('')}</select><button class="btn primary" id="iMake">Make invite</button></div>
      <details style="margin-top:10px"><summary class="small">A new person (not in the list yet)</summary><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <input id="nName" placeholder="Full name" maxlength="60"><input id="nMob" inputmode="tel" placeholder="Mobile number" maxlength="14">
        <select id="nRole">${(L.canAdd || []).map(r => `<option value="${r}">${esc((S.B.roles || {})[r] || r)}</option>`).join('')}</select>
        <select id="nScope"><option value="">– unit / charge –</option>${(L.units || []).map(u => `<option>${esc(u)}</option>`).join('')}${isAdmin ? (S.B.aens || []).map(a => `<option value="${esc(a)}">AEN charge: ${esc(a)}</option>`).join('') + (S.B.srdens || []).map(a => `<option value="${esc(a)}">Sr DEN charge: ${esc(a)}</option>`).join('') : ''}</select>
        <button class="btn secondary" id="nMake">Add and invite</button></div></details></div></div>
    <div class="panel body" style="margin-bottom:12px"><div class="inner"><h3 style="margin:0 0 6px">Invites (${L.invites.length})</h3>${L.invites.length ? `<div class="scroll"><table class="t compact"><thead><tr><th>For</th><th>Made</th><th>Valid till</th><th>Status</th><th></th></tr></thead><tbody>${L.invites.map(x => `<tr><td><b>${esc(x.name)}</b><div class="small muted">${esc(x.role)}${x.scope ? ' · ' + esc(x.scope) : ''}</div></td><td class="small nw">${esc(dmyT(x.made))}${isAdmin ? '<div class="muted">' + esc(x.by) + '</div>' : ''}</td><td class="small nw">${esc(dmyT(x.expires))}</td><td class="small">${esc(x.status === 'used' ? 'used ' + dmyT(x.used) + (x.ua ? ' – ' + x.ua : '') : x.status)}</td><td>${x.status === 'open' ? `<button class="btn ghost sm" data-wd="${esc(x.req)}">Withdraw</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="small muted">No invites yet.</div>'}</div></div>
    <details class="panel body"><summary style="padding:14px 18px;cursor:pointer">Decided in the last 7 days (${L.recent.length})</summary><div class="inner" style="padding-top:0">${L.recent.length ? `<div class="scroll"><table class="t compact"><tbody>${L.recent.map(o => `<tr><td><b>${esc(o.name)}</b><div class="small muted">${esc(o.role)}${o.scope ? ' · ' + esc(o.scope) : ''}</div></td><td class="small">${esc(o.ua || '')}</td><td class="small nw">${esc(dmyT(o.asked))}</td><td class="small"><b>${esc(o.status)}</b>${o.by ? ' by ' + esc(o.by) : ''}${o.on ? ' ' + esc(dmyT(o.on)) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="small muted">Nothing.</div>'}</div></details>`;
  const show = async (code, req) => {
    const box = $('aCard'); box.innerHTML = '<div class="small muted">Looking it up…</div>';
    let f; try { f = await call('accessFind', { code, req }); } catch (e) { box.innerHTML = `<div class="ban crit">${esc(e.error || e)}</div>`; return; }
    const canEdit = f.kind === 'new';
    box.innerHTML = `<div class="panel" style="border-left:5px solid var(--warn);padding:12px 16px"><div style="font-size:17px"><b>${esc(f.name)}</b> · ${esc(f.roleName)}${f.scope ? ' · ' + esc(f.scope) : ''}</div>
      <div class="small">Mobile ${esc(f.mobile || '—')} · phone: <b>${esc(f.ua || 'unknown')}</b> · asked ${esc(dmyT(f.asked))} · code ${fmtCode(f.code)}</div>
      <div class="small muted">${f.onList ? `In the staff list · phones in use ${f.phones} of ${f.max}${f.phones >= f.max ? ' – approving signs out the phone used least recently' : ''}` : `NOT in the staff list – asked as "${esc(f.desig)}". Check who this is before approving; you can set the designation and unit.`}</div>
      ${canEdit ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><select id="fRole">${(L.canAdd || []).map(r => `<option value="${r}" ${r === f.role ? 'selected' : ''}>${esc((S.B.roles || {})[r] || r)}</option>`).join('')}</select><select id="fScope"><option value="">– unit / charge –</option>${(L.units || []).map(u => `<option ${u === f.scope ? 'selected' : ''}>${esc(u)}</option>`).join('')}${isAdmin ? (S.B.aens || []).map(a => `<option value="${esc(a)}" ${a === f.scope ? 'selected' : ''}>AEN charge: ${esc(a)}</option>`).join('') + (S.B.srdens || []).map(a => `<option value="${esc(a)}" ${a === f.scope ? 'selected' : ''}>Sr DEN charge: ${esc(a)}</option>`).join('') : ''}</select></div>` : ''}
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn primary" id="fOk">Approve</button><button class="btn secondary" id="fNo">Reject</button></div></div>`;
    const decide = async ok => { const a = { code: f.code, req: f.req, ok }; if (canEdit && ok) { a.role = $('fRole').value; a.scope = $('fScope').value; }
      $('fOk').disabled = $('fNo').disabled = true;
      try { const r = await call('accessDecide', a); toast(r.status === 'approved' ? `Approved – ${r.name}'s phone opens now` : 'Rejected'); S.B.signins = Object.assign({}, S.B.signins || {}, { waiting: Math.max(0, ((S.B.signins || {}).waiting || 1) - 1) }); VIEWS.access(el); }
      catch (e) { fail(e); $('fOk').disabled = $('fNo').disabled = false; } };
    $('fOk').onclick = () => decide(true); $('fNo').onclick = () => decide(false);
  };
  $('aFind').onclick = () => show($('aCode').value.replace(/\D/g, ''));
  $('aCode').onkeydown = e => { if (e.key === 'Enter') $('aFind').click(); };
  $('aScan').onclick = async () => { const t = await scanQR(); if (!t) return; const m = /^TMSC1\|([^|]+)\|(\d{6})$/.exec(t.trim()); if (!m) { toast('This QR is not a TMS Control sign-in code', true); return; } $('aCode').value = m[2]; show(m[2], m[1]); };
  $('iMake').onclick = async () => { const id = $('iWho').value; if (!id) { toast('Choose a person', true); return; } try { inviteModal(await call('inviteCreate', { userId: id })); } catch (e) { fail(e); } };
  $('nMake').onclick = async () => { const person = { name: $('nName').value, mobile: $('nMob').value, role: $('nRole').value, scope: $('nScope').value }; try { const r = await call('inviteCreate', { person }); inviteModal(r); } catch (e) { fail(e); } };
  el.querySelectorAll('[data-wd]').forEach(b => b.onclick = async () => { b.disabled = true; try { await call('inviteCancel', { req: b.dataset.wd }); toast('Invite withdrawn'); VIEWS.access(el); } catch (e) { fail(e); b.disabled = false; } });
};
VIEWS.overview = el => {
  const r = role(); const level = r === 'AEN' ? 'Unit' : r === 'SRDEN' ? 'AEN' : 'SrDEN';
  const J = S.jobs.filter(inUnit); const t = S.B.today; const m0 = t.slice(0, 8) + '01';
  const groups = {}; const unitMeta = Object.fromEntries(S.B.units.map(u => [u.unit, u]));
  for (const j of J) { const g = level === 'Unit' ? j.Unit : level === 'AEN' ? (j.AEN || unitMeta[j.Unit]?.aen) : (j.SrDEN || unitMeta[j.Unit]?.srden); const o = groups[g || '—'] = groups[g || '—'] || { open: 0, od: 0, p1: 0, wait: 0, odA: 0, done: 0, gone: 0, units: new Set() }; o.units.add(j.Unit); if (isOpen(j)) o.open++; if (gone(j)) o.gone++; if (j.Overdue === 'SSE') o.od++; if (isOpen(j) && +j.Priority === 1) o.p1++; if (j.Status === 'Done' || j.Status === 'With SSE') o.wait++; if (j.Overdue === 'AEN') o.odA++; if ((j.Status === 'Approved' || j.Status === 'Verified' || (j.Status === 'Closed' && j.ApprovedOn)) && String(j.ApprovedOn || j.ClosedOn) >= m0) o.done++; }
  const kp = {}; for (const k of (S.kpi?.kpi || [])) if (k.Basis === 'This month' && inUnit(k)) { const g = level === 'Unit' ? k.Unit : level === 'AEN' ? unitMeta[k.Unit]?.aen : unitMeta[k.Unit]?.srden; (kp[g] = kp[g] || []).push(+k.Total || 0); }
  const avg = a => a && a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '—';
  const tot = Object.values(groups).reduce((a, o) => { for (const k of ['open', 'od', 'p1', 'wait', 'odA', 'done', 'gone']) a[k] = (a[k] || 0) + o[k]; return a; }, {});
  // redesign 16-Oct: division average ring + number cards, then one card per Sr DEN / AEN / unit with its own ring
  const allK = Object.values(kp).flat(); const divAvg = allK.length ? allK.reduce((x, y) => x + y, 0) / allK.length : null;
  const B = s => window.UI ? UI.bi(s) : { p: s, s: '' }; const lab = s => { const b = B(s); return `${esc(b.p)}${b.s ? ` <span class="small" style="font-weight:500;opacity:.8">· ${esc(b.s)}</span>` : ''}`; };
  const ring = (v, max, o) => window.UI ? UI.ring(v, max, o) : '';
  const card = (cls, id, l, v, s) => { const b = B(l); return `<div class="kpi ${cls}"${id ? ` id="${id}" style="cursor:pointer"` : ''}><div class="l">${esc(b.p)}</div>${b.s ? `<div class="lh">${esc(b.s)}</div>` : ''}<div class="v">${v}</div><div class="s">${s}</div></div>`; };
  const grpTitle = level === 'Unit' ? 'Units in your charge' : level === 'AEN' ? 'AEN jurisdictions' : 'Sr DEN jurisdictions';
  el.innerHTML = pageHead(r === 'AEN' ? 'Units' : r === 'SRDEN' ? 'Overview' : 'Division overview', scopeText()) +
    (r === 'ADMIN' ? '<div id="vbanner"></div>' : '') +   // [E] 17-Oct Version check
    `<div class="ovtop"><div class="hero">${ring(divAvg == null ? null : +divAvg.toFixed(1), 82, { size: 132, stroke: 14, color: 'var(--accent)', sub: 'of 82' })}<div><div class="ht">${lab('KPI forecast')} · ${esc(S.basis === 'Last month' ? 'last month' : 'this month')}</div><div class="hh">${esc(B('Division average').p)}</div><div class="hs">${allK.length ? `average of ${allK.length} unit(s) at the present pace` : 'no KPI calculated yet – upload TMS data, then Recalculate'}</div></div></div>` +
    `<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">${card(tot.od ? 'crit' : 'ok', '', 'Open jobs', tot.open || 0, `${tot.od || 0} overdue at SSE`)}${card(tot.p1 ? 'crit' : 'ok', '', 'Urgent (SR)', tot.p1 || 0, 'UML defects / overdue inspections')}${card(tot.odA ? 'warn' : 'ok', '', 'Work waiting for review', tot.wait || 0, `${tot.odA || 0} beyond approval time`)}${card('acc', '', 'Approved this month', tot.done || 0, `since ${dmy(m0)}`)}${card(tot.gone ? 'crit' : 'ok', 'kGone', 'Closed in TMS, not here', tot.gone || 0, 'open here although TMS shows them closed – not updated in the app')}</div></div>` + reconPanel() +
    `<div class="h2row"><h2>${esc(B(grpTitle).p)}${B(grpTitle).s ? ` <span>· ${esc(B(grpTitle).s)}</span>` : ''}</h2>${level !== 'Unit' && VIEWS.kpi && S.B.kpiNames ? `<a href="#" data-go2="kpi">KPI by unit ›</a>` : ''}</div>` +
    `<div class="ucards">${Object.entries(groups).sort().map(([g, o]) => { const a = kp[g] && kp[g].length ? kp[g].reduce((x, y) => x + y, 0) / kp[g].length : null; const us = [...o.units].filter(Boolean).sort();
      return `<button type="button" class="ucard" data-g="${esc(g)}"><div class="uh">${ring(a == null ? null : Math.round(a), 82, { size: 54 })}<div style="min-width:0"><div class="un">${esc(g)}</div><div class="us">${esc(level === 'Unit' ? (unitMeta[g]?.label || '') : us.join(' · '))}</div></div></div>
        <div class="uf"><div><b>${o.open}</b>${esc(B('open').p)}</div><div><b class="${o.od ? 'c' : ''}">${o.od}</b>${esc(B('overdue').p)}</div><div><b>${o.p1}</b>${esc(B('urgent').p)}</div><div><b>${o.wait}</b>${esc(B('in review').p)}${o.odA ? ` <span class="od">(${o.odA} late)</span>` : ''}</div><div><b>${o.done}</b>${esc(B('approved').p)}</div>${o.gone ? `<div><b class="c">${o.gone}</b>closed in TMS</div>` : ''}</div></button>`; }).join('') || '<div class="empty">No jobs yet.</div>'}</div>`;
  el.querySelectorAll('[data-go2]').forEach(a => a.onclick = e => { e.preventDefault(); S.view = a.dataset.go2; render(); });
  versionBanner().catch(() => { });   // [E] 17-Oct
  el.querySelectorAll('.ucard[data-g]').forEach(tr => tr.onclick = () => { const g = tr.dataset.g; if (level === 'Unit') { S.unit = g; $('selUnit').value = g; } S.view = 'urgent'; render(); });
  if ($('kGone') && VIEWS.jobs) $('kGone').onclick = () => { S.f.st = 'tmsgone'; S.view = 'jobs'; render(); };
  el.querySelectorAll('[data-rc]').forEach(b => b.onclick = () => modal(`<h3>Flag the jobs no longer in TMS</h3><p>${esc(b.dataset.txt)}</p><p>Confirm only if the upload was complete (all sections of this list came in). The jobs are then flagged "Closed in TMS, not here"; nothing is closed.</p>`, async () => {
    try { const r = await call('reconConfirm', { type: b.dataset.rc }, { timeout: 360000 }); toast('Done'); (r.recon || []).forEach(l => toast(l)); await loadAll(); } catch (e) { fail(e); return false; }
  }, 'Confirm and flag'));
};
// ---------- [E] 17-Oct: Version check (admin) – is a push.bat, a Recalculate or a collector reload still due? ----------
// Website (build.json, always from the network) vs this page (CFG.VERSION) vs server (bootstrap.build) vs the KPI marks
// (LAST_RECALC) vs the collector (CFG.COLLECTOR written by push.bat; the version handed over is noted on this computer).
window.addEventListener('message', e => { const d = e.data; if (e.source !== window || !d || d.__tmsc !== 'collect' || !d.ver) return; try { localStorage.setItem('tmsc.collVer', JSON.stringify({ ver: String(d.ver), at: new Date().toISOString() })); } catch (x) { } });
async function versionCheck(fresh) {
  if (role() !== 'ADMIN') return [];
  if (fresh) { try { S.B.build = await call('buildInfo', {}); } catch (e) { } }   // "Check again": ask the server (read only)
  let site = null; try { site = await fetch('build.json?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null); } catch (e) { }
  const b = S.B.build || {}; const rows = []; const tm = x => x ? dmy(String(x).slice(0, 10)) + ' ' + String(x).slice(11, 16) : '';
  const add = (ok, what, val, fix) => rows.push({ ok, what, val, fix });
  if (!site) add(null, 'Website', 'not checked – no network, or push.bat has not yet published the check file', 'Run push.bat once (it publishes the check file).');
  else {
    add(site.web === CFG.VERSION, 'This page', site.web === CFG.VERSION ? `the latest website (${site.web})` : `older copy ${CFG.VERSION || '?'} – the website has ${site.web}`, 'Press the reload button at the top (on a PC also Ctrl+F5).');
    add(!!b.server && b.server === site.server, 'Server program', b.server === site.server ? `same delivery as the website (${b.server})` : `server ${b.server || 'older (no build id)'} – the website expects ${site.server}`, 'The server and the website come from different deliveries. With the automatic push (cloud_setup.bat) the PC sends the rest within 15 minutes; if this stays, run push.bat on the PC – it says what is missing (the file PUSH STATUS – … too).');
  }
  const rc = b.recalc;
  if (b.server) add(!!rc && rc.server === b.server, 'KPI marks', rc ? (rc.server === b.server ? `calculated ${tm(rc.when)} by this program` : `calculated ${tm(rc.when)} by an older program`) : 'no recalculation recorded since the Version check was added', 'The marks were calculated before the last push. The server recalculates by itself within 15 minutes (automatic recalculation); or press Recalculate (Settings, at the top) now.');
  const want = CFG.COLLECTOR || ''; let seen = null; try { seen = JSON.parse(localStorage.getItem('tmsc.collVer') || 'null'); } catch (e) { }
  // [E] 24-Oct: a collector NEWER than the one recorded at the last push (it reloaded itself from a newer delivery) is fine – only an older one needs a reload
  const stamp = v => (String(v || '').match(/\((\d{12})\)/) || [])[1] || ''; const newer = seen && stamp(seen.ver) && stamp(want) && stamp(seen.ver) > stamp(want);
  if (want) add(seen ? (seen.ver === want || newer) : null, 'TMS Collector', seen ? (seen.ver === want ? `running ${seen.ver} (hand-over ${tm(seen.at)})` : newer ? `running ${seen.ver} (hand-over ${tm(seen.at)}) – newer than the one recorded at the last push (${want}); push.bat records it` : `the last hand-over (${tm(seen.at)}) came from ${seen.ver} – the delivered one is ${want}. A reloaded collector shows here with its next hand-over (fetch + upload)`) : `delivered ${want} – no hand-over seen on this computer yet`, 'The collector reloads itself within 20 minutes when no fetch or upload is going on (from the 20-Oct collector on); or reload it now in chrome://extensions (the round arrow on its card), then run it.');
  else add(null, 'TMS Collector', 'not checked – push.bat has not yet recorded the delivered collector version', 'Run push.bat once.');
  // [E] 20-Oct: running by itself – automatic recalculation (server trigger) and the PC's automatic push (heartbeat)
  const A = b.auto;
  if (A) {
    const L = A.last; const ago = x => { const m = Math.round((Date.parse(String(A.now).slice(0, 19)) - Date.parse(String(x).slice(0, 19))) / 60000); return m < 90 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
    // [E] 21-Oct: a cut-off or failed try that a later recalculation of this program has covered is no longer a to-do
    const later = !!(L && L.ok !== true && rc && rc.server === b.server && String(rc.when) > String(L.at));
    const where = L && L.stage ? ` – stopped at "${L.stage}" after ${L.sec} s` : '';
    const last = L ? (L.ok === true ? ` · last ${tm(L.at)} (${L.why}, ${L.sec || 0} s)` : L.ok === false ? ` · last try ${tm(L.at)} FAILED: ${L.error || ''}` : ` · last try ${tm(L.at)} did not finish (Google's 6-minute limit?)${where}`) + (later ? ` · the marks were recalculated after it (${tm(rc.when)}), nothing to do` : '') : ' · not needed yet';
    if (!A.on) add(false, 'Automatic recalculation', 'switched off (setting AUTO_RECALC = No)', 'Set AUTO_RECALC to Yes in the sheet tab Settings – or press Recalculate after every push and upload.');
    else if (A.trigger === false) add(false, 'Automatic recalculation', 'not installed yet', 'Open this app as admin once more (it installs itself); if it stays, run the sheet menu TMS Control → 1. First-time setup.');
    else add(!L || L.ok === true || later, 'Automatic recalculation', `on, checked every ${A.every} min after a push or an upload${last}`, 'It tries again by itself within 2 hours, or at once after the next push or upload. To see the full message press Recalculate (Settings).');
    const pc = A.pc;
    if (!pc) add(null, 'PC (automatic push)', 'not reported yet – the automatic push is not set up on the PC', 'On the PC run cloud_setup.bat once (TMS Control folder) – after that the PC pushes deliveries by itself and reports here every 15 minutes.');
    else { const m = (Date.parse(String(A.now).slice(0, 19)) - Date.parse(String(pc.at).slice(0, 19))) / 60000; const bad = /^fail/i.test(pc.s || '');
      add(m <= 45 && !bad, 'PC (automatic push)', `last report ${ago(pc.at)} (${tm(pc.at)}): ${pc.s || ''}`, bad ? 'The automatic push stopped. Open the PC (Chrome Remote Desktop), read the file PUSH STATUS – … in the TMS Control folder, do what it says, then run push.bat once.' : 'The PC has not reported for a while: it is off, asleep, offline, or the task stopped. Wake it (Chrome Remote Desktop) – the collector and the pushes need it.'); }
  }
  return rows;
}
function versionHtml(rows) {
  const ic = o => o === true ? '<span class="tag ok">OK</span>' : o === false ? '<span class="tag crit">TO DO</span>' : '<span class="tag">?</span>';
  return `<div class="scroll"><table class="t"><thead><tr><th></th><th>What</th><th>Now</th><th>What to do</th></tr></thead><tbody>${rows.map(r => `<tr><td>${ic(r.ok)}</td><td class="nw"><b>${esc(r.what)}</b></td><td>${esc(r.val)}</td><td>${r.ok === true ? '<span class="muted">–</span>' : esc(r.fix)}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted">Files delivered to the PC but not pushed yet cannot be seen from here: the file <b>PUSH STATUS – …</b> in the TMS Control folder says that, and push.bat says "Nothing new to push" when nothing is waiting. With the automatic push (cloud_setup.bat, 20-Oct) the PC does that every 15 minutes by itself – the line "PC (automatic push)" shows its last report.</p>`;
}
async function versionBanner() {
  const w = $('vbanner'); if (!w || role() !== 'ADMIN') return;
  const rows = await versionCheck(); const todo = rows.filter(r => r.ok === false); if (!todo.length) { w.innerHTML = ''; return; }
  w.innerHTML = `<div class="ban warn" style="margin:0 0 12px"><b>Version check – to do:</b> ${todo.map(r => esc(r.what + ': ' + r.fix)).join(' · ')} <a href="#" data-go2="settings">Details in Settings ›</a></div>`;
  w.querySelectorAll('[data-go2]').forEach(a => a.onclick = e => { e.preventDefault(); S.view = a.dataset.go2; render(); });
}
window.versionCheck = versionCheck; window.versionHtml = versionHtml;

// last upload's reconciliation of the TMS lists (admin): "N closed in TMS – M already closed here, K flagged"; held lists wait for the admin
function reconPanel() {
  const R = S.B.recon; if (role() !== 'ADMIN' || !R || !(R.lists || []).length) return '';
  const nm = { 'K1-INSP': 'Inspections due (K1)', 'K7-OMS': 'Repeated OMS peaks (K7)', 'K10-DEFECT': 'Locations needing attention (K10)', 'K10-DPC': 'Defects pending – other inspections / loop lines (K10)', 'K11-IMR': 'IMR (K11)', 'K13-JOG': 'Joggled fish plates (K13)', 'K14-DFWR': 'DFWR (K14)', 'K15-OG': 'Oiling & greasing (K15)' };
  const rows = R.lists.map(r => { const txt = r.held ? `${r.gone} of ${r.open} open jobs (${Math.round(r.gone / Math.max(1, r.open) * 100)} %) are no longer in TMS after one upload` : ''; return `<tr><td>${esc(nm[r.type] || r.type)}</td><td class="n">${r.open}</td><td class="n">${r.gone}</td><td class="n">${r.held ? '–' : r.already}</td><td class="n">${r.held ? '–' : r.flagged ? `<span class="od">${r.flagged}</span>` : 0}</td><td>${r.held ? `<span class="od">Held – sharp drop</span> <button class="btn secondary sm" data-rc="${esc(r.type)}" data-txt="${esc(nm[r.type] + ': ' + txt)}">Check and confirm</button>` : 'OK'}</td></tr>`; }).join('');
  return `<div class="panel body"><h3 class="sec">TMS lists after the last upload <span class="muted small">– ${esc(String(R.when).replace('T', ' ').slice(0, 16))}</span></h3><div class="scroll"><table class="t"><thead><tr><th>List</th><th>Open here before</th><th>Closed in TMS</th><th>Already closed here</th><th>Flagged</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

const KMAX = k => ((S.B.kpiDefs || {})[k] || {}).max || 5;
// [E] 21-Oct: SELF-CHECK against TMS – after every recalculation our "Last month" marks are compared with TMS's own official marks
// (S.kpi.match from KPI_MATCH). A KPI whose rule matched TMS for fewer than 90 % of the units is shown as provisional.
const MONTHN = ym => { const [y, m] = String(ym || '').split('-'); return m ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1] + ' ' + y : ''; };
function matchOf(k) {
  const M = S.kpi && S.kpi.match; const b = M && M.byK && M.byK[k]; if (!b || !b.n) return null;
  const ok = b.eq / b.n >= 0.9;
  return { ok, eq: b.eq, n: b.n, text: `Checked against TMS's own marks for ${MONTHN(M.month)}: this rule gave the same marks as TMS for ${b.eq} of ${b.n} units.` + (ok ? '' : ` PROVISIONAL – the TMS rule for ${k} is not yet matched exactly; treat this forecast as a guide (differences: ${b.diff.slice(0, 8).join(', ')}${b.diff.length > 8 ? ' …' : ''}, ours/TMS).`) };
}
function matchStrip() {
  const M = S.kpi && S.kpi.match; if (!M || !M.byK) return '';
  const ks = Object.keys(M.byK).sort((a, b) => +a.slice(1) - +b.slice(1));
  return `<div class="panel body small" style="margin-bottom:10px"><b>Checked against TMS's own marks for ${esc(MONTHN(M.month))}</b> (Performance Matrix of ${esc(dmy(M.procDate))}) – units with the same marks as TMS: ${ks.map(k => { const b = M.byK[k]; const ok = b.eq / b.n >= 0.9; return `<span class="tag ${ok ? 'ok' : 'warn'}" title="${esc(b.diff.join(', '))}">${k} ${b.eq}/${b.n}</span>`; }).join(' ')}. <span class="muted">Amber = provisional rule (forecast is a guide). KPIs not listed could not be recalculated for that month (TMS mark shown). Checked again by itself after every recalculation.</span></div>`;
}
VIEWS.kpi = el => {
  const all = (S.kpi?.kpi || []).filter(k => inUnit(k)); const basis = S.basis;
  const rows = all.filter(k => k.Basis === basis); const off = {}; for (const o of (S.kpi?.official || [])) if (!off[o.Unit] || o.ProcDate > off[o.Unit].ProcDate) off[o.Unit] = o;
  const K = Object.keys(S.B.kpiNames);
  const cls = (k, v) => v === '' || v == null ? 'mkn' : +v >= KMAX(k) ? 'mk5' : +v >= KMAX(k) - 1 ? 'mk4' : +v >= 3 ? 'mk3' : +v >= 2 ? 'mk2' : 'mk0';
  el.innerHTML = pageHead('KPI by unit', basis === 'This month' ? 'FORECAST for this month – the marks expected on the coming 1st. Periods not yet started are left out; a fortnight / month still running is judged on the work so far at the present pace (click a cell: "Based on"). Open the jobs to save the marks.' : 'LAST MONTH – the score for the month that is over, as calculated – compare with the official TMS score (red outline = differs)',
    `<div class="right row"><button class="btn ${basis === 'This month' ? 'primary' : 'secondary'} sm" data-b="This month">This month (forecast)</button><button class="btn ${basis === 'Last month' ? 'primary' : 'secondary'} sm" data-b="Last month">Last month (score) vs TMS</button></div>`) +
    matchStrip() + `<div class="panel body"><div class="scroll"><table class="t km"><thead><tr><th>Unit</th>${K.map(k => { const mt = matchOf(k); return `<th title="${esc(S.B.kpiNames[k] + (mt ? ' – ' + mt.text : ''))}">${k}${mt && !mt.ok ? '<span style="color:var(--warn)">≈</span>' : ''}</th>`; }).join('')}<th>Total / 82</th>${basis === 'Last month' ? '<th>TMS total</th>' : ''}</tr></thead><tbody>${rows.sort((a, b) => String(a.Unit).localeCompare(String(b.Unit))).map(r => `<tr><td class="nw"><b>${esc(r.Unit)}</b><div class="small">${basis === 'This month' ? 'calculated ' + dmy(String(r.Computed || r.AsOn).slice(0, 10)) : (() => { const [y, m] = S.B.today.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }); })()}</div></td>${K.map(k => { const d = (r.Detail || {})[k] || {}; const o = off[r.Unit]; const mis = basis === 'Last month' && o && d.src === 'calc' && o[k] !== '' && +o[k] !== +r[k]; return `<td class="m ${cls(k, r[k])} ${mis ? 'mis' : ''}" data-u="${esc(r.Unit)}" data-k="${k}" style="cursor:pointer" title="${esc(S.B.kpiNames[k])} – ${esc(d.src || '')}">${r[k] === '' || r[k] == null ? '–' : r[k]}${d.src && /^official/.test(d.src) ? '<sup>*</sup>' : ''}</td>`; }).join('')}<td class="n"><b>${r.Total}</b></td>${basis === 'Last month' ? `<td class="n">${off[r.Unit] ? off[r.Unit].Total : '—'}</td>` : ''}</tr>`).join('') || `<tr><td colspan="19" class="empty">No KPI data yet – the admin has to upload TMS reports.</td></tr>`}</tbody></table></div>
    <div class="legend"><span>* = no data uploaded for this item: the latest official TMS marks are shown</span><span>– = no data</span><span>Click a cell for details and to add a remark / site constraint</span></div></div>`;
  el.querySelectorAll('[data-b]').forEach(b => b.onclick = () => { S.basis = b.dataset.b; render(); });
  el.querySelectorAll('td[data-k]').forEach(td => td.onclick = () => kpiCell(td.dataset.u, td.dataset.k, rows.find(r => r.Unit === td.dataset.u)));
};
// ---------- KPI cell: what the figures mean (16-Oct: "I cannot understand what these mean") ----------
const KPI_VALUE = { K1: '% of scheduled inspections overdue (weighted)', K2: 'Average % of the jurisdiction NOT covered per fortnight', K3: '% of the jurisdiction NOT covered in the two months', K10: '% of defects pending more than 10 days', K11: '% of IMRs removed after more than 3 days', K12: '% of new AT welds defective at the first test', K13: '% of AT welds awaiting joggled plates', K14: '% of DFWR (older than 90 days) removed', K15: '% of FP joints overdue for oiling & greasing', K16: 'Field visit days' };
function kpiRule(k) {
  const d = (S.B.kpiDefs || {})[k] || {}; const R = { K1: 'P&C 30 %, curves 30 %, LWR 20 %, LC 20 % – % overdue on the 1st of the month (due that day is not overdue)', K2: 'whole jurisdiction to be covered by foot plate / rear vehicle in 1st–15th and in 16th–month end; average shortfall of the two', K3: 'whole jurisdiction by push trolley (on foot allowed where speed > 110 km/h) in the previous two months', K16: 'distinct days with an inspection recorded in TMS by the SSE in-charge' }[k] || '';
  if (k === 'K16') return R + '. Marks: 16 or more days → 4, 11–15 → 3, 7–10 → 2, fewer → 0';
  const b = d.bands || []; if (!b.length || d.kind !== 'short') return R;
  const parts = b.map((x, i) => i === 0 ? `0 % → ${x[1]}` : x[0] >= 1e9 ? `more → ${x[1]}` : `up to ${x[0]} % → ${x[1]}`);
  return [R, 'Marks: ' + parts.join(', ') + (b[b.length - 1][0] >= 1e9 ? '' : ', more → 0')].filter(Boolean).join('. ');
}
function kpiExplain(k, x) {
  const tbl = (head, rows) => `<div class="scroll"><table class="t compact"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const list = (t, L, n) => L && L.length ? `<h4 style="margin:10px 0 4px">${t}${n > L.length ? ` (first ${L.length} of ${n})` : ` (${L.length})`}</h4><div class="small" style="max-height:180px;overflow:auto">${L.map(s => `<div>${esc(s)}</div>`).join('')}</div>` : '';
  const pct = v => v == null ? '—' : (Math.round(v * 10) / 10) + ' %';
  if (k === 'K1' && x.byType) {
    const nm = { PXING: 'P&C', CURVE: 'Curve', LWR: 'LWR', LXING: 'Level crossing' };
    return `<h4 style="margin:10px 0 4px">Assets in the Latest inspection report</h4>` + tbl(['Asset', 'Counted', 'Overdue', '% overdue', 'Never inspected', 'Overdue > 1 year (not counted)'], Object.entries(x.byType).map(([t, o]) => [nm[t] || t, o.n, o.over, o.n ? pct(o.over / o.n * 100) : '—', o.never || 0, o.stale || 0]))
      + list('Overdue now', x.over, x.overN) + list('Falling due before the 1st – inspect them before they become overdue', x.soon, x.soonN)
      + `<p class="small muted">An inspection counts here once the "Latest inspection report" uploaded from TMS shows the new date.</p>`;
  }
  if (k === 'K2' && x.total != null) return tbl(['Fortnight', 'km covered', 'of km', '% short'], [['1st–15th', x.covered1 ?? (x.total - x.missing1), x.total, pct(x.f1)], ['16th–end', x.covered2 ?? (x.total - x.missing2), x.total, pct(x.f2)]])
    + (x.miss1 ? `<h4 style="margin:10px 0 4px">Not covered, 1st–15th</h4><div class="small">${esc(x.miss1)}</div>` : '') + (x.miss2 ? `<h4 style="margin:10px 0 4px">Not covered yet, 16th–end</h4><div class="small">${esc(x.miss2)}</div>` : '')
    + `<p class="small muted">Counted: foot plate / rear vehicle trips of the SSE in-charge in the inspection registers uploaded from TMS, each line of the jurisdiction separately (km by km).</p>`;
  if (k === 'K3' && x.total != null) return tbl(['km covered', 'of km', '% not covered'], [[x.covered ?? (x.total - x.missing), x.total, pct(x.total ? x.missing / x.total * 100 : 0)]])
    + (x.miss ? `<h4 style="margin:10px 0 4px">Not covered in the two months</h4><div class="small">${esc(x.miss)}</div>` : '') + `<p class="small muted">Counted: push trolley (on foot where speed > 110 km/h) by the SSE in-charge, both months.</p>`;
  if (k === 'K10' && Array.isArray(x.byDate)) { const C = { PXING_ML: 'P&C ML', PXING_PRL: 'P&C PRL', PXING_JOINT_ML: 'Joint P&C ML', PXING_JOINT_PRL: 'Joint P&C PRL', LWR: 'LWR', SEJ: 'SEJ', BR: 'Bridge', LC: 'LC', CURVE: 'Curve', TRC: 'TRC', OMS: 'OMS', OTHER: 'Other inspections', LOOP: 'Loop line', LNA: 'LNA' };   // [E] 20-Oct
    return tbl(['Date (1st / 11th / 21st)', 'List used', 'Pending', 'More than 10 days', '%', 'Late by category'], x.byDate.map(b => [dmy(b.date), b.src || '', b.open, b.late, pct(b.pct), Object.entries(b.lateByCat || {}).map(([c, n]) => `${C[c] || c} ${n}`).join(', ') || '–'])); }
  if (k === 'K7' && Array.isArray(x.list)) {   // [E] 27-Oct: TMS's own list "Repeated locations having OMS Peaks" (dashboard)
    return tbl(['Repeated OMS peak locations now', 'on the 1st of the month before'], [[x.cur, x.prev == null ? 'not collected' : x.prev]]) + list('On TMS\'s list', x.list, x.cur)
      + (x.atRisk ? `<p class="small od">At risk – the count on the 1st of the month before was not collected, so the reduction cannot be worked out here. TMS's own mark decides.</p>` : '')
      + `<p class="small muted">From TMS's dashboard list "Repeated Locations Having OMS Peaks" (TMS Collector, daily; TMS shows it only as on the day). None on the list = full marks.</p>`; }
  if ((k === 'K8' || k === 'K9') && Array.isArray(x.list)) { const w = k === 'K8' ? 'Repeated UML peak locations' : 'Repeated CBML blocks';   // [E] 21-Oct: TMS's own lists (dashboard)
    return tbl([w + ' now', 'a month earlier'], [[x.cur, x.prev == null ? 'not known' : x.prev]]) + list('On TMS\'s list', x.list, x.cur)
      + `<p class="small muted">From TMS's dashboard lists "${k === 'K8' ? 'Repeated UML Peaks' : 'Repeated Blocks having CBML'}" (TMS Collector, daily). None on the list = full marks; this is how TMS gave its September marks.</p>`; }
  if (k === 'K16') { const T = { FP: 'Foot plate', RV: 'Rear vehicle', FOOT: 'On foot', TROLLEY: 'Trolley', PXING: 'P&C', PXING_JOINT: 'Joint P&C', OTHER: 'Other inspections', USFD: 'USFD', CURVE: 'Curve', LC: 'LC', LWR: 'LWR', DIAMOND: 'Diamond' };
    return tbl(['Days so far', 'Dates', 'Days by inspection type'], [[x.soFar ?? x.days, x.dates || '', Object.entries(x.byType || {}).map(([t, n]) => `${T[t] || t} ${n}`).join(', ')]]); }
  if (k === 'K12' && x.rule === 'initial') return tbl(['AT welds done', 'tested', 'defective at the first test', 'period'], [[x.done, x.tested, x.defective, `${MONTHN(x.from)} – ${MONTHN(x.to)}`]])   // [E] 24-Oct
    + (x.provisional ? `<div class="ban warn" style="margin:8px 0">${esc(x.provisional)}.</div>` : '') + list('Defective at the first test', x.list, x.defective)
    + `<p class="small muted">TMS's rule: welds made in the six months that were defective at their FIRST USFD test (testing history read from TMS). A weld that became defective later does not count.</p>`;
  const e = Object.entries(x || {}).filter(([, v]) => v != null && typeof v !== 'object');
  return e.length ? tbl(['Item', 'Value'], e.map(([a, v]) => [a.replace(/([A-Z])/g, ' $1').toLowerCase(), v])) : '';
}
function kpiCell(unit, k, r) {
  const d = (r.Detail || {})[k] || {}; const notes = (S.kpi.notes || []).filter(n => n.Unit === unit && n.KPI === k).slice(-5).reverse();
  const off = (S.kpi.official || []).filter(o => o.Unit === unit).sort((a, b) => String(b.ProcDate).localeCompare(String(a.ProcDate)))[0];
  const canNote = ['SSE', 'JE', 'AEN', 'SRDEN', 'SRDENC', 'ADMIN'].includes(role());
  const fc = r.Basis === 'This month' && d.b && /^Forecast/.test(d.b);
  const mt = matchOf(k);   // [E] 21-Oct: how far this KPI's rule agrees with TMS's own marks of the last scored month
  modal(`<h3>${esc(unit)} · ${k} – ${esc(S.B.kpiNames[k])}</h3>${mt ? `<div class="ban ${mt.ok ? 'ok' : 'warn'}" style="margin:0 0 8px">${esc(mt.text)}</div>` : ''}<dl class="dl"><dt>Marks (${esc(r.Basis === 'This month' ? 'forecast for this month' : 'last month')})</dt><dd><b>${r[k] === '' ? '—' : r[k]}</b> of ${KMAX(k)}</dd>${d.b ? `<dt>Based on</dt><dd>${esc(d.b)}</dd>` : ''}<dt>${fc ? 'Forecast: ' : ''}${esc(KPI_VALUE[k] || 'Value')}</dt><dd>${d.v == null ? '—' : d.v + (k === 'K16' ? ' days' : ' %')}</dd><dt>How TMS scores it</dt><dd class="small">${esc(kpiRule(k))}</dd><dt>Source</dt><dd>${esc(d.src === 'calc' ? 'calculated here from the TMS reports uploaded' : d.src || '—')}</dd></dl>${kpiExplain(k, d.d || {})}<dl class="dl"><dt>Official TMS</dt><dd>${off ? `${off[k]} (processing date ${dmy(off.ProcDate)})` : '—'}</dd></dl>
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
    `<div class="panel body"><div class="scroll"><table class="t"><thead><tr><th>Unit</th><th>CBML now</th><th>In tamping jobs</th><th>Approved</th><th>Forecast if approved work holds</th><th>Forecast if all planned done</th><th>At risk</th><th>UML now</th><th>UML approved</th></tr></thead><tbody>${rows.map(([u, o]) => `<tr><td><b>${esc(u)}</b></td><td class="n">${o.cbml}</td><td class="n">${o.planned}</td><td class="n">${o.approved}</td><td class="n">${f(o.cbml, o.approved)}</td><td class="n">${f(o.cbml, o.planned)}</td><td class="n">${o.risk}</td><td class="n">${o.uml}</td><td class="n">${o.umlDone}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No TRC run uploaded yet.</td></tr>'}</tbody></table></div><div class="legend"><span>K8 / K9 in TMS count the REPEATED UML peak locations / CBML blocks on TMS's own lists (TMS dashboard; TMS Collector report \"Repeated UML peaks / CBML blocks\"): none = full marks. The CBML / UML counts here are all of the latest run.</span></div></div>`;
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
