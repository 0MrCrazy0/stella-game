// --- STELLA'S GAME SERVICE WORKER (v46.0 PUBLIC) ---
const CACHE_NAME = 'stellas-game-v46';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './sounds/cat.mp3',
  './sounds/chicken.mp3',
  './sounds/cow.mp3',
  './sounds/dog.mp3',
  './sounds/duck.mp3',
  './sounds/goat.mp3',
  './sounds/pig.mp3',
  './sounds/rooster.mp3',
  './sounds/sheep.mp3'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => k !== CACHE_NAME && caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isPage =
    req.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html');

  if (isPage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).catch(() => caches.match('./index.html')))
  );
});
