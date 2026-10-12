// Storage on the phone (IndexedDB): cached data for offline use, unsent work records, photos and the upload queue.
(function () {
'use strict';
const DB = 'tmsc', VER = 1, STORES = ['kv', 'drafts', 'photos', 'outbox'];
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { const d = r.result; for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); let out; Promise.resolve(fn(s)).then(v => { out = v; }); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const S = {
  get: (store, k) => tx(store, 'readonly', s => req(s.get(k))),
  set: (store, k, v) => tx(store, 'readwrite', s => req(s.put(v, k))),
  del: (store, k) => tx(store, 'readwrite', s => req(s.delete(k))),
  all: (store) => tx(store, 'readonly', s => new Promise((res, rej) => { const out = []; const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out.push({ key: cur.key, value: cur.value }); cur.continue(); } else res(out); }; c.onerror = () => rej(c.error); })),
  clear: (store) => tx(store, 'readwrite', s => req(s.clear())),
};
// ask the browser to keep this data even when storage runs low
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
window.TMSC_STORE = S;
})();
