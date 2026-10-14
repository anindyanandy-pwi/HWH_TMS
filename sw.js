// Keeps the app on the phone so it opens without signal. Data calls (POST to the server) are never cached here.
const VERSION = '202610141159';
const SHELL = ["./","index.html","styles.css","config.js","store.js","stations.js","app.js","field.js","admin.js","core.js","models.json","shotmodel.json","manifest.webmanifest","icons/icon-192.png","icons/icon-512.png"];
self.addEventListener('install', e => { e.waitUntil(caches.open('tmsc-' + VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== 'tmsc-' + VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url); if (u.origin !== location.origin) return;
  // the page itself: try the network first (to get updates), fall back to the saved copy
  if (r.mode === 'navigate') { e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open('tmsc-' + VERSION).then(x => x.put('./', c)); return res; }).catch(() => caches.match('./').then(m => m || caches.match('index.html')))); return; }
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(m => m || fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open('tmsc-' + VERSION).then(x => x.put(r, c)); } return res; })));
});
