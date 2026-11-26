// Service worker: guarda o app em cache para funcionar offline.
const CACHE = 'hubdrive-v4';
const CORE = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/pdf.js', 'js/reader.js', 'js/drive.js', 'js/config.js', 'js/courses.js',
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

// ---- Streaming de vídeos do Google Drive com autorização ----
let TOKEN = null;
self.addEventListener('message', e => { if (e.data?.type === 'drive-token') TOKEN = e.data.token; });

async function getToken() {
  if (TOKEN && TOKEN.exp > Date.now()) return TOKEN;
  try {
    const res = await (await caches.open('hb-auth')).match('/__hb-token');
    if (res) TOKEN = await res.json();
  } catch {}
  return TOKEN && TOKEN.exp > Date.now() ? TOKEN : null;
}

async function driveMedia(req, url) {
  const id = decodeURIComponent(url.pathname.split('/__drive-media/')[1] || '');
  const size = +url.searchParams.get('size') || 0;
  const tok = await getToken();
  if (!tok) return new Response('Sessão do Google expirada', { status: 401 });
  const headers = { Authorization: `Bearer ${tok.value}` };
  const range = req.headers.get('range');
  if (range) headers.Range = range;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers });
  if (!res.ok && res.status !== 206) return new Response(null, { status: res.status });
  // Remonta os cabeçalhos (alguns podem não ser expostos por CORS).
  const out = new Headers();
  out.set('Content-Type', res.headers.get('content-type') || 'video/mp4');
  out.set('Accept-Ranges', 'bytes');
  const len = res.headers.get('content-length');
  if (len) out.set('Content-Length', len);
  let status = res.status;
  if (range) {
    const cr = res.headers.get('content-range');
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (cr) out.set('Content-Range', cr);
    else if (m && len && size) out.set('Content-Range', `bytes ${m[1]}-${+m[1] + +len - 1}/${size}`);
    status = 206;
  }
  return new Response(res.body, { status, headers: out });
}

// Rede primeiro para o app (pega atualizações), cache como reserva offline.
self.addEventListener('fetch', e => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method === 'GET' && u.origin === location.origin && u.pathname.includes('/__drive-media/')) {
    e.respondWith(driveMedia(req, u));
    return;
  }
  if (req.method !== 'GET' || u.origin !== location.origin) return;
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
