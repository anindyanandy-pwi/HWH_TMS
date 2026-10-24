// Keeps the app on the phone so it opens without signal. Data calls (POST to the server) are never cached here.
const VERSION = '202610241914';
const SHELL = ["./","index.html","styles.css","config.js","store.js","ui.js","stations.js","qr.js","app.js","field.js","health.js","admin.js","core.js","models.json","shotmodel.json","manifest.webmanifest","icons/icon-192.png","icons/icon-512.png","icons/logo.png"];
self.addEventListener('install', e => { e.waitUntil(caches.open('tmsc-' + VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== 'tmsc-' + VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url); if (u.origin !== location.origin) return;
  if (/\/(build\.json|version\.txt)$/.test(u.pathname)) return;   // [E] 17-Oct: the Version check always asks the network
  // the page itself: try the network first (to get updates; re-checked with the server – GitHub lets browsers keep it 10 min), fall back to the saved copy
  if (r.mode === 'navigate') { e.respondWith(fetch(r.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => { const c = res.clone(); caches.open('tmsc-' + VERSION).then(x => x.put('./', c)); return res; }).catch(() => caches.match('./').then(m => m || caches.match('index.html')))); return; }
  // [E] 22-Oct: files are asked as name?v=<build>; the saved copy is used only for the SAME build (with ignoreSearch a phone that had
  // opened the app before kept its old app.js / styles.css under the new page – "the old design"). Offline: any saved copy.
  e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open('tmsc-' + VERSION).then(x => x.put(r, c)); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then(o => o || Response.error()))));
});
