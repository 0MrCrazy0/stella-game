// --- STELLA'S GAME SERVICE WORKER (v28.0 MASTERPIECE) ---
const CACHE_NAME = 'stellas-game-v28';
const ASSETS = [
  './', './index.html', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png',
  './sounds/cat.mp3', './sounds/chicken.mp3', './sounds/cow.mp3',
  './sounds/dog.mp3', './sounds/duck.mp3', './sounds/goat.mp3',
  './sounds/pig.mp3', './sounds/rooster.mp3', './sounds/sheep.mp3'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME && caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  e.respondWith(caches.match(e.request).then(res => res || fetch(e.request).catch(() => caches.match('./index.html'))));
});
