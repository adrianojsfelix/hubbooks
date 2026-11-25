// Integração com Google Drive (somente no navegador, sem servidor):
//  - login via Google Identity Services (token OAuth de curta duração)
//  - leitura da pasta de livros (drive.readonly)
//  - arquivo de sincronização do progresso na pasta oculta do app (drive.appdata)
import { CONFIG } from './config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata';
const SYNC_NAME = 'hubbooks-sync.json';
const FOLDER = 'application/vnd.google-apps.folder';

const ls = {
  get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let gisPromise;
let tokenClient;
let token = null;
try { token = JSON.parse(sessionStorage.getItem('hb-drive-token') || 'null'); } catch {}

export class DriveAuthError extends Error {}

export const drive = {
  get clientId() { return CONFIG.googleClientId || ls.get('hb-drive-client'); },
  set clientId(v) { ls.set('hb-drive-client', v || null); tokenClient = null; },
  get clientIdFromConfig() { return !!CONFIG.googleClientId; },
  get folder() { try { return JSON.parse(ls.get('hb-drive-folder', 'null')); } catch { return null; } },
  set folder(f) { ls.set('hb-drive-folder', f ? JSON.stringify(f) : null); },
  get excluded() { try { return JSON.parse(ls.get('hb-drive-excluded', '[]')); } catch { return []; } },
  set excluded(list) { ls.set('hb-drive-excluded', JSON.stringify(list)); },
  get wasConnected() { return ls.get('hb-drive-connected') === '1'; },
  get lastSync() { return +ls.get('hb-drive-lastsync', '0'); },
  set lastSync(t) { ls.set('hb-drive-lastsync', String(t)); },
  get connected() { return !!token && token.exp > Date.now() + 30_000; },

  /** Abre o popup do Google. Deve ser chamado a partir de um clique. */
  async signIn() {
    if (!this.clientId) throw new Error('Client ID não configurado');
    await loadGis();
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({ client_id: this.clientId, scope: SCOPES, callback: () => {} });
    }
    const resp = await new Promise((resolve, reject) => {
      tokenClient.callback = r => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r));
      tokenClient.error_callback = e => reject(new Error(e?.message || e?.type || 'Login cancelado'));
      tokenClient.requestAccessToken({ prompt: this.wasConnected ? '' : 'consent' });
    });
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...SCOPES.split(' '))) {
      throw new Error('É preciso permitir o acesso aos arquivos e à pasta do app.');
    }
    token = { value: resp.access_token, exp: Date.now() + (resp.expires_in || 3600) * 1000 };
    try { sessionStorage.setItem('hb-drive-token', JSON.stringify(token)); } catch {}
    ls.set('hb-drive-connected', '1');
  },

  signOut() {
    if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.value, () => {});
    token = null;
    try { sessionStorage.removeItem('hb-drive-token'); } catch {}
    ls.set('hb-drive-connected', null);
    ls.set('hb-drive-folder', null);
    ls.set('hb-drive-syncfile', null);
  },

  /** Procura pastas pelo nome (ignora espaços: "L E I T U R A" ≈ "leitura"). */
  async findFolders(text) {
    const words = text.trim();
    let q = `mimeType='${FOLDER}' and trashed=false`;
    if (words) q += ` and name contains '${words.replace(/['\\]/g, '\\$&')}'`;
    const r = await api(`/files?${qs({ q, fields: 'files(id,name,parents)', pageSize: 50, orderBy: 'viewedByMeTime desc', ...ALL })}`);
    return r.files;
  },

  /** Sugere a pasta de leitura procurando nomes comuns. */
  async guessFolder() {
    const r = await api(`/files?${qs({
      q: `mimeType='${FOLDER}' and trashed=false and 'me' in owners`,
      fields: 'files(id,name)', pageSize: 1000, orderBy: 'viewedByMeTime desc',
    })}`);
    const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f\s]/g, '').toLowerCase();
    const prefs = ['leitura', 'leituras', 'livros', 'books', 'biblioteca'];
    for (const p of prefs) {
      const hit = r.files.find(f => norm(f.name) === p);
      if (hit) return hit;
    }
    return null;
  },

  async folderInfo(id) {
    return api(`/files/${id}?${qs({ fields: 'id,name', supportsAllDrives: true })}`);
  },

  /** Varre a pasta (com subpastas) e retorna os PDFs com o caminho de pastas de cada um. */
  async scan(rootId, onProgress) {
    const pdfs = [];
    const queue = [{ id: rootId, path: [] }];
    let folders = 0;
    while (queue.length) {
      const { id, path } = queue.shift();
      folders++;
      onProgress?.({ folders, pdfs: pdfs.length });
      let pageToken;
      do {
        const r = await api(`/files?${qs({
          q: `'${id}' in parents and trashed=false and (mimeType='${FOLDER}' or mimeType='application/pdf')`,
          fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink)',
          pageSize: 1000, ...ALL, ...(pageToken ? { pageToken } : {}),
        })}`);
        for (const f of r.files) {
          if (f.mimeType === FOLDER) queue.push({ id: f.id, path: [...path, f.name] });
          else pdfs.push({ ...f, size: +f.size || 0, path });
        }
        pageToken = r.nextPageToken;
      } while (pageToken);
    }
    return pdfs;
  },

  /** Baixa o PDF com progresso (0..1). */
  async download(fileId, size, onProgress) {
    const res = await authed(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`);
    const total = +res.headers.get('content-length') || size || 0;
    if (!res.body || !total) return res.arrayBuffer();
    const reader = res.body.getReader();
    const buf = new Uint8Array(total);
    let got = 0;
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length <= total) buf.set(value, got); else chunks.push(value);
      got += value.length;
      onProgress?.(Math.min(1, got / total));
    }
    if (got === total) return buf.buffer;
    // tamanho divergente: monta de novo
    const all = new Uint8Array(got);
    all.set(buf.subarray(0, Math.min(got, total)));
    let off = Math.min(got, total);
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return all.buffer;
  },

  async thumbnail(link) {
    if (!link) return '';
    try {
      const res = await authed(link.replace(/=s\d+$/, '=s400'));
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) return '';
      return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(''); fr.readAsDataURL(blob); });
    } catch { return ''; }
  },

  /* ---------- Sincronização do progresso (pasta oculta do app no Drive) ---------- */
  async readSync() {
    const id = await syncFileId(false);
    if (!id) return null;
    const res = await authed(`${API}/files/${id}?alt=media`);
    try { return await res.json(); } catch { return null; }
  },

  async writeSync(data) {
    const body = JSON.stringify(data);
    let id = await syncFileId(false);
    if (id) {
      await authed(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      return;
    }
    const boundary = 'hb' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: SYNC_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const res = await authed(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
    });
    id = (await res.json()).id;
    ls.set('hb-drive-syncfile', id);
  },
};

const ALL = { supportsAllDrives: true, includeItemsFromAllDrives: true };
const qs = o => new URLSearchParams(o).toString();

async function syncFileId() {
  const cached = ls.get('hb-drive-syncfile');
  if (cached) return cached;
  const r = await api(`/files?${qs({ spaces: 'appDataFolder', q: `name='${SYNC_NAME}' and trashed=false`, fields: 'files(id)' })}`);
  const id = r.files[0]?.id || '';
  if (id) ls.set('hb-drive-syncfile', id);
  return id;
}

async function authed(url, opts = {}) {
  if (!drive.connected) throw new DriveAuthError('Sessão do Google expirada');
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token.value}` } });
  if (res.status === 401) {
    token = null;
    try { sessionStorage.removeItem('hb-drive-token'); } catch {}
    throw new DriveAuthError('Sessão do Google expirada');
  }
  if (res.status === 404 && url.includes(ls.get('hb-drive-syncfile') || '\0')) ls.set('hb-drive-syncfile', null);
  if (!res.ok) {
    let msg = `Erro ${res.status} no Google Drive`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  return res;
}

async function api(path) {
  return (await authed(API + path)).json();
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Sem conexão com o Google')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}
