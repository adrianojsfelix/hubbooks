// Service worker: guarda o app em cache para funcionar offline.
const CACHE = 'hubbooks-v2';
const CORE = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/pdf.js', 'js/reader.js', 'js/drive.js', 'js/config.js',
  'lib/pdfjs/pdf.min.mjs', 'lib/pdfjs/pdf.worker.min.mjs',
  'icons/icon.svg', 'icons/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Rede primeiro para o app (pega atualizações), cache como reserva offline.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isLib = req.url.includes('/lib/pdfjs/');
  if (isLib) {
    // Bibliotecas não mudam: cache primeiro (inclui cmaps/fontes sob demanda).
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});
