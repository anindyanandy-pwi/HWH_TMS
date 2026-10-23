// Design system – redesign of 16-Oct-2026 (collector chat [C]; shared by every chat's screens).
// window.UI: light / dark / auto theme, glass on or off, Hindi / English, logo, credit, menu icons, score rings.
// Pages call UI.bi(english) for a two-language label, UI.title(english) for a page title, UI.ring(...) for a score ring.
(function () {
'use strict';
const LS = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } } };
const root = document.documentElement;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- product identity (user's decisions, 16-Oct) ----------
const APP = {
  name: 'Performance Report of SSE/P.Way', nameHi: 'वरिष्ठ खंड अभियंता/रेल पथ का कार्य-निष्पादन प्रतिवेदन',
  short: 'SSE/P.Way Performance Report', shortHi: 'एसएसई/रेल पथ कार्य-निष्पादन रिपोर्ट',
  org: 'Howrah Division, Eastern Railway', orgHi: 'हावड़ा मंडल, पूर्व रेलवे',
  by: 'Anindya Nandy', byHi: 'अनिन्द्य नन्दी', desig: 'SSE/PWAY/PLANNING, HWH Division', desigHi: 'वरिष्ठ खंड अभियंता/रेल पथ/योजना, हावड़ा मंडल',
  logo: 'icons/logo.png'
};
const credit = (o = {}) => `<div class="credit">Conceived &amp; developed by <b>${APP.by}</b>${o.br ? '<br>' : ', '}${APP.desig}<br>परिकल्पना एवं विकास: <b>${APP.byHi}</b>${o.full ? '<br>' + APP.desigHi : ''}</div>`;

// ---------- Hindi for menus, page titles, headings and common words ----------
const HI = {
  'My work': 'मेरा कार्य', 'My work records': 'मेरे कार्य अभिलेख', 'Work records': 'कार्य अभिलेख', 'My position': 'मेरी स्थिति', 'Done & closed': 'पूर्ण एवं बंद',
  'Check JE work': 'जेई कार्य की जाँच', 'KPI detail': 'केपीआई विवरण', 'Approve work': 'कार्य स्वीकृति', 'Units': 'इकाइयाँ', 'Overdue & urgent': 'अतिदेय एवं अत्यावश्यक',
  'All jobs': 'सभी कार्य', 'KPI standing': 'केपीआई स्थिति', 'Chronic locations': 'बार-बार दोष वाले स्थान', 'Overview': 'अवलोकन', 'Pending reviews': 'लंबित समीक्षा',
  'Machine plan': 'मशीन योजना', 'Division': 'मंडल', 'CBML forecast': 'सीबीएमएल पूर्वानुमान', 'KPI by unit': 'इकाई वार केपीआई', 'Upload data': 'डेटा अपलोड', 'Upload TMS data': 'टीएमएस डेटा अपलोड',
  'Inspections due': 'देय निरीक्षण', 'Users': 'उपयोगकर्ता', 'Settings': 'सेटिंग्स', 'Upload history': 'अपलोड इतिहास', 'Admin': 'प्रशासन', 'Phone approvals': 'फ़ोन स्वीकृति',
  'Division overview': 'मंडल अवलोकन', 'CBML forecast for the next TRC run': 'अगले टीआरसी रन हेतु सीबीएमएल पूर्वानुमान', 'Location history': 'स्थान इतिहास',
  'Work record': 'कार्य अभिलेख', 'Work record (quick)': 'कार्य अभिलेख (संक्षिप्त)', 'Sign in': 'प्रवेश करें',
  'Open jobs': 'खुले कार्य', 'Urgent (SR)': 'अत्यावश्यक', 'Work waiting for review': 'समीक्षा हेतु कार्य', 'Approved this month': 'इस माह स्वीकृत', 'Closed in TMS, not here': 'टीएमएस में बंद, यहाँ नहीं',
  'Overdue': 'अतिदेय', 'Returned / still defective': 'वापस / अब भी दोषपूर्ण', 'Urgent (speed restriction)': 'अत्यावश्यक (गति प्रतिबंध)', 'Due this week': 'इस सप्ताह देय',
  'Other open work – biggest KPI gain first': 'अन्य खुले कार्य – अधिक केपीआई लाभ पहले', 'Work recorded – with SSE / AEN for review': 'दर्ज कार्य – एसएसई / एईएन की समीक्षा में',
  'Refresh': 'रीफ़्रेश', 'Help': 'सहायता', 'Record work done': 'कार्य दर्ज करें', 'KPI forecast': 'केपीआई पूर्वानुमान', 'Division average': 'मंडल औसत',
  'Sr DEN jurisdictions': 'वरिष्ठ मंडल अभियंता क्षेत्र', 'AEN jurisdictions': 'सहायक मंडल अभियंता क्षेत्र', 'Units in your charge': 'आपके प्रभार की इकाइयाँ',
  'open': 'खुले', 'overdue': 'अतिदेय', 'in review': 'समीक्षा में', 'urgent': 'अत्यावश्यक', 'approved': 'स्वीकृत', 'About': 'परिचय', 'Light': 'हल्का', 'Dark': 'गहरा', 'Auto': 'स्वतः'
};
const LANG = () => root.getAttribute('data-lang') === 'hi' ? 'hi' : 'en';
function hiOf(en) {
  const s = String(en ?? ''); if (HI[s]) return HI[s];
  const m = s.match(/^(.*?)\s+[–-]\s+(.+)$/); if (m && HI[m[1]]) return HI[m[1]] + ' – ' + m[2];   // "My position – LLH"
  return '';
}
// two-language label: { p: shown first, s: shown second (may be '') }
function bi(en) { const h = hiOf(en); return LANG() === 'hi' && h ? { p: h, s: en } : { p: en, s: h }; }
function t(en) { const h = hiOf(en); return LANG() === 'hi' && h ? h : en; }
// page title html: first language big, the other below (escaped by the caller when needed – titles are plain text)
function title(en) { const b = bi(en); return `${b.p}${b.s ? `<span class="hi">${b.s}</span>` : ''}`; }

// ---------- menu icons (stroke, 24 px grid) ----------
const IC = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', check: 'M9 12l2 2 4-4M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  pin: 'M12 21s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.7-7 12-7 12zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', doc: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6', truck: 'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  up: 'M12 19V5M5 12l7-7 7 7', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  clock: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 7v5l3 2', work: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  done: 'M20 6 9 17l-5-5', user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2',
  phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2', moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4', auto: 'M12 3a9 9 0 1 0 0 18V3z M12 21a9 9 0 0 0 0-18', refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6', help: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z'
};
IC.pulse = 'M22 12h-4l-3 9L9 3l-3 9H2';   // [H] 19-Oct: track health icon
const NAVIC = { health: 'pulse', healthline: 'pulse', healthdata: 'up', /* [H] 19-Oct */ insp: 'clock', work: 'work', records: 'doc', position: 'chart', done: 'done', review: 'check', kpi: 'grid', overview: 'grid', urgent: 'alert', jobs: 'list', chronic: 'pin', plan: 'truck', forecast: 'trend', upload: 'up', users: 'users', settings: 'gear', uploads: 'history', phones: 'phone' };
const svg = (k, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${IC[k] || IC.list}"></path></svg>`;
NAVIC.lag = 'alert'; HI['Lagging units'] = 'पिछड़ी इकाइयाँ'; HI['What is still pending before'] = 'इससे पहले क्या शेष है';   // [E] 22-Oct: Lagging units
const navIcon = key => svg(NAVIC[key] || 'list', 'ic');

// ---------- score ring ----------
// ring(value, max, { size, stroke, color, label, sub })
function ring(v, max, o = {}) {
  const size = o.size || 56, sw = o.stroke || Math.max(4, Math.round(size / 9)), r = (size - sw) / 2, C = 2 * Math.PI * r;
  const f = max ? Math.max(0, Math.min(1, (+v || 0) / max)) : 0;
  const col = o.color || (f >= .9 ? 'var(--ok)' : f >= .75 ? 'var(--accent)' : f >= .6 ? 'var(--warn)' : 'var(--crit)');
  const lab = o.label != null ? o.label : (v == null || v === '' ? '—' : v);
  return `<span class="ring" style="width:${size}px;height:${size}px" role="img" aria-label="${esc(lab)} of ${max}"><svg width="${size}" height="${size}"><circle class="rt" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${sw}"></circle><circle class="rv" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${(f * C).toFixed(1)} ${C.toFixed(1)}"></circle></svg><span class="rc"><b style="font-size:${Math.round(size * .27)}px">${esc(lab)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</span></span>`;
}

// ---------- theme, glass, language ----------
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function themePref() { return LS.get('tmsc.theme') || 'auto'; }
function applyTheme() { const p = themePref(); const dark = p === 'dark' || (p === 'auto' && mq && mq.matches); root.setAttribute('data-theme', dark ? 'dark' : 'light'); const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', dark ? '#000000' : '#F2F2F7'); drawTools(); }
function setTheme(p) { LS.set('tmsc.theme', p); applyTheme(); }
if (mq && mq.addEventListener) mq.addEventListener('change', applyTheme);
// glass: off on weak phones (≤ 2 GB memory) or when switched off on this device
function applyGlass() { const pref = LS.get('tmsc.glass'); const weak = (navigator.deviceMemory && navigator.deviceMemory <= 2); root.classList.toggle('noglass', pref === 'off' || (pref !== 'on' && weak)); }
function langPref() { return LS.get('tmsc.lang'); }
// field staff (JE / SSE) see Hindi first unless they chose otherwise; officers English first
function defaultLang(role) { if (!langPref()) root.setAttribute('data-lang', role === 'JE' || role === 'SSE' ? 'hi' : 'en'); drawTools(); }
function setLang(l) { LS.set('tmsc.lang', l); root.setAttribute('data-lang', l); drawTools(); if (window.TMSC && window.TMSC.render) window.TMSC.render(); }
root.setAttribute('data-lang', langPref() || 'en');

// top-bar controls: language switch + light / dark / auto
function drawTools() {
  const box = document.getElementById('uiTools'); if (!box) return;
  const l = LANG(), p = themePref();
  box.innerHTML = `<div class="seg" role="group" aria-label="Language"><button type="button" data-lang="en" class="${l === 'en' ? 'on' : ''}">EN</button><button type="button" data-lang="hi" class="${l === 'hi' ? 'on' : ''}">हिं</button></div>
    <button type="button" class="tb icon" id="uiTheme" title="Appearance: ${p === 'auto' ? 'follows this device' : p}" aria-label="Appearance: ${p}">${svg(p === 'dark' ? 'moon' : p === 'light' ? 'sun' : 'auto')}</button>`;
  box.querySelectorAll('[data-lang]').forEach(b => b.onclick = () => setLang(b.dataset.lang));
  document.getElementById('uiTheme').onclick = () => setTheme(p === 'auto' ? 'light' : p === 'light' ? 'dark' : 'auto');
}
function about() {
  return `<div style="display:flex;gap:16px;align-items:center;margin-bottom:12px"><img src="${APP.logo}" alt="" style="width:64px;height:64px;object-fit:contain"><div><h3 style="margin:0">${APP.name}</h3><div class="muted">${APP.nameHi}</div><div class="small">${APP.org} · ${APP.orgHi}</div></div></div>${credit({ full: true })}`;
}
applyTheme(); applyGlass();
document.addEventListener('DOMContentLoaded', () => { applyTheme(); drawTools(); });
window.UI = { APP, credit, about, bi, t, title, hiOf, HI, ring, svg, navIcon, IC, setTheme, setLang, defaultLang, lang: LANG, applyGlass, esc };
})();
