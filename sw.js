const CACHE = 'adventskalender-v12';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/firebase-config.js',
  './js/crypto.js',
  './js/snow.js',
  './js/app.js',
  './Hintergrund.png',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Firebase-/Storage-Verkehr niemals cachen (dynamische, teils große Daten).
  const url = e.request.url;
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebasestorage.googleapis.com') ||
      url.includes('storage.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('gstatic.com')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
