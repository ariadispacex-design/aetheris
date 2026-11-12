/* Aetheris Arena - service worker: lets the game install and run offline.
   Bump CACHE when you want every player to drop the old copy. */
const CACHE = 'aetheris-v2';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'database/cards.js', 'database/decks.js', 'user.js', 'database/user.js', 'database/sounds.js',
    'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()))
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k != CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
});
self.addEventListener('fetch', e => {
    const r = e.request, u = new URL(r.url);
    if (r.method != 'GET' || u.origin != location.origin)
        return;
    const code = r.mode == 'navigate' || /\.(html|js|webmanifest|json)$/.test(u.pathname);
    const save = res => {
        if (res && res.ok)
            caches.open(CACHE).then(c => c.put(r, res.clone()));
        return res
    };
    /* code: network first (updates arrive at once), cache when offline. art/images: cache first. */
    e.respondWith(code
        ? fetch(r).then(save).catch(() => caches.match(r).then(m => m || caches.match('index.html')))
        : caches.match(r).then(m => m || fetch(r).then(save)))
});
