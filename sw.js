// ABEL FX PWA - Service Worker
const CACHE = 'abel-fx-v1';
const CORE = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(()=> self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(()=> self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API Render JANGAN di-cache, biar harga selalu fresh
  if (url.hostname.includes('onrender.com')) return;
  // File lain: cache-first, fallback ke network
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      if (e.request.method === 'GET' && res.status === 200) {
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(()=> caches.match('/index.html')))
  );
});
