import { db } from './db.js';
import { inspectPdf, loadPdf, getOutline } from './pdf.js';
import { Reader } from './reader.js';
import { drive, DriveAuthError } from './drive.js';
import { initCourses } from './courses.js';

const $ = id => document.getElementById(id);

const STATUS = {
  reading: { label: 'Lendo', color: 'var(--st-reading)' },
  queue: { label: 'Quero ler', color: 'var(--st-queue)' },
  paused: { label: 'Pausado', color: 'var(--st-paused)' },
  done: { label: 'Concluído', color: 'var(--st-done)' },
  dropped: { label: 'Abandonado', color: 'var(--st-dropped)' },
};
const PRIORITY = { low: 'Baixa', medium: 'Média', high: 'Alta' };
const COVER_COLORS = ['#5b4fe0', '#d9622b', '#1f7a4a', '#a3304f', '#2f5fd0', '#8a5a00', '#6d3fa8', '#0f766e', '#b4235a', '#3f4c6b'];
const DEFAULT_SEC_PER_PAGE = 75;

const state = {
  books: [],
  files: new Set(),           // ids com PDF salvo neste aparelho
  tombstones: {},             // id -> data de exclusão (para não reimportar/sincronizar de volta)
  filter: 'all',
  collection: load('hb-collection', ''),
  sort: load('hb-sort', 'recent'),
  view: load('hb-view', 'grid'),
  goal: +load('hb-goal', '20') || 20,
  query: '',
  editing: null,
  reading: null,
  downloads: new Map(),       // id -> progresso 0..1
  syncing: false,
  tab: load('hb-tab', 'books'),
};
let courses = null;   // módulo de cursos (inicializado após carregar os dados)

function load(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch {} }

/* ================= Utilidades ================= */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysUntil = s => Math.round((parseDate(s) - parseDate(dateKey())) / 86400000);
const fmtDate = s => parseDate(s).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
const initials = t => (t || '?').split(/\s+/).filter(w => w.length > 2 || /^\p{Lu}/u.test(w)).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const plural = (n, one, many) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
const fmtMB = n => (n / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: n > 1e8 ? 0 : 1 }) + ' MB';
const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const coverColor = b => COVER_COLORS[Math.abs(hash(b.title)) % COVER_COLORS.length];
function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function progress(b) {
  if (b.status === 'done') return 100;
  if (!b.totalPages) return 0;
  return Math.min(100, Math.round((b.currentPage / b.totalPages) * 100));
}
const pagesLeft = b => Math.max(0, (b.totalPages || 0) - (b.currentPage || 0));

/** Segundos por página com base no seu histórico (ou um valor padrão). */
function secPerPage() {
  let secs = 0, pages = 0;
  for (const b of state.books) {
    secs += b.readSeconds || 0;
    pages += Object.values(b.log || {}).reduce((a, v) => a + v, 0);
  }
  return pages >= 10 && secs > 60 ? Math.min(600, Math.max(15, secs / pages)) : DEFAULT_SEC_PER_PAGE;
}

/** Situação do prazo: texto, classe visual e ritmo necessário. */
function deadlineInfo(b) {
  if (b.status === 'done') return { text: b.finishedAt ? `Lido em ${fmtDate(b.finishedAt)}` : 'Concluído', cls: 'ok', late: false };
  if (!b.deadline) return { text: 'Sem prazo', cls: '', late: false, none: true };
  const d = daysUntil(b.deadline);
  const remaining = pagesLeft(b);
  const perDay = d >= 0 && remaining && b.totalPages ? Math.ceil(remaining / (d + 1)) : 0;
  const pace = perDay ? `${plural(perDay, 'página', 'páginas')}/dia para terminar no prazo` : '';
  if (b.status === 'dropped') return { text: `Prazo ${fmtDate(b.deadline)}`, cls: '', late: false };
  if (d < 0) return { text: `Atrasado ${plural(-d, 'dia', 'dias')}`, cls: 'late', late: true, pace: b.totalPages ? `${plural(remaining, 'página restante', 'páginas restantes')}` : '', perDay };
  if (d === 0) return { text: 'Prazo é hoje', cls: 'soon', late: false, pace, perDay };
  if (d <= 3) return { text: `${plural(d, 'dia', 'dias')} para o prazo`, cls: 'soon', late: false, pace, perDay };
  return { text: `${plural(d, 'dia', 'dias')} para o prazo`, cls: '', late: false, pace, perDay };
}

function toast(msg, action, ms = 3800) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.run(); };
    el.appendChild(b);
    ms = Math.max(ms, 8000);
  }
  $('toasts').appendChild(el);
  const all = $('toasts').children;
  while (all.length > 2) all[0].remove();
  if (ms) setTimeout(() => el.remove(), ms);
  el.set = text => { el.querySelector('span').textContent = text; };
  return el;
}

/* ================= Dados ================= */
async function refresh() {
  const [books, ids, tomb] = await Promise.all([db.allBooks(), db.fileIds(), db.getMeta('tombstones')]);
  state.books = books.map(normalize);
  state.files = new Set(ids);
  state.tombstones = tomb || {};
  render();
}

function normalize(b) {
  return {
    author: '', status: 'queue', priority: 'medium', startDate: '', deadline: '', finishedAt: '',
    notes: '', checklist: [], bookmarks: [], log: {}, timeLog: {}, readSeconds: 0, currentPage: 1, totalPages: 0,
    cover: '', collection: '', source: 'local', createdAt: Date.now(), updatedAt: Date.now(), lastReadAt: 0, ...b,
  };
}

async function persist(book, { sync = true } = {}) {
  book.updatedAt = Date.now();
  await db.putBook(book);
  const i = state.books.findIndex(b => b.id === book.id);
  if (i >= 0) state.books[i] = book; else state.books.push(book);
  if (state.reading?.id === book.id) state.reading = book;
  if (sync) scheduleSync();
}

async function removeBook(b) {
  await db.deleteBook(b.id);
  await db.deleteFile(b.id);
  state.books = state.books.filter(x => x.id !== b.id);
  state.files.delete(b.id);
  state.tombstones[b.id] = Date.now();
  await db.setMeta('tombstones', state.tombstones);
  scheduleSync();
}

function setStatus(book, status) {
  if (book.status === status) return;
  book.status = status;
  if (status === 'reading' && !book.startDate) book.startDate = dateKey();
  if (status === 'done') {
    book.finishedAt = dateKey();
    if (book.totalPages) book.currentPage = book.totalPages;
  } else {
    book.finishedAt = '';
  }
}

/** Limpa nomes de arquivo como "Quem-Pensa-Enriquece-Napoleon-Hill-1_cópia.pdf". */
function cleanTitle(name) {
  let t = name.replace(/\.pdf$/i, '')
    .replace(/^(pdfcoffee\.com|dokumen\.pub|z-lib\.org|libgen\.\w+)[_ -]*/i, '')
    .replace(/[-_ ]?pdf[-_ ]?free$/i, '')
    .replace(/^\d{6,}[-_ ]+/, '')
    .replace(/[-_ ]?\d{9,13}(?:[-_ ]\d{9,13})*$/, '')
    .replace(/[-_ ]?(c[oó]pia|copy)$/i, '')
    .replace(/[-_ ]1nbsped/i, '')
    .replace(/\+/g, ' ').replace(/_/g, ' ');
  if (!/\s/.test(t) || (t.match(/-/g) || []).length >= 3) t = t.replace(/-/g, ' ');
  t = t.replace(/\s+\d$/, '').replace(/\s{2,}/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : name;
}

/* ================= Adicionar PDFs do aparelho ================= */
async function addFiles(files) {
  const pdfs = [...files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast('Selecione arquivos PDF.'); return; }
  let ok = 0;
  const t = toast('Importando…', null, 0);
  for (const [i, file] of pdfs.entries()) {
    t.set(`Importando ${i + 1} de ${pdfs.length}: ${file.name}`);
    try {
      const data = await file.arrayBuffer();
      const info = await inspectPdf(data);
      const looksBad = !info.title || info.title.length < 3 || /^(untitled|microsoft word|documento?\d*|sem t[ií]tulo)/i.test(info.title) || /\.(docx?|indd|tex|pdf)$/i.test(info.title);
      const book = normalize({
        id: uid(),
        title: looksBad ? cleanTitle(file.name) : info.title,
        author: info.author,
        fileName: file.name,
        fileSize: file.size,
        totalPages: info.pages,
        cover: info.cover,
        collection: state.collection || '',
      });
      await db.putFile(book.id, data);
      state.files.add(book.id);
      await persist(book);
      ok++;
    } catch (err) {
      console.error(err);
      toast(`Não foi possível ler "${file.name}". O arquivo pode estar corrompido ou protegido.`);
    }
  }
  t.remove();
  if (ok) {
    navigator.storage?.persist?.();
    toast(ok === 1 ? 'Livro adicionado à estante.' : `${ok} livros adicionados à estante.`);
  }
  render();
}

/* ================= Renderização ================= */
function collections() {
  const map = new Map();
  for (const b of state.books) if (b.collection) map.set(b.collection, (map.get(b.collection) || 0) + 1);
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
}

function matchesFilter(b, f = state.filter) {
  if (f === 'all') return true;
  if (f === 'late') return deadlineInfo(b).late;
  return b.status === f;
}

function visibleBooks() {
  const q = state.query.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const statusOrder = { reading: 0, paused: 1, queue: 2, done: 3, dropped: 4 };
  const list = state.books.filter(b => {
    if (q && !`${b.title} ${b.author} ${b.collection}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q)) return false;
    if (state.collection && b.collection !== state.collection) return false;
    return matchesFilter(b);
  });
  const cmp = {
    recent: (a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || statusOrder[a.status] - statusOrder[b.status] || a.title.localeCompare(b.title, 'pt-BR', { numeric: true }),
    deadline: (a, b) => {
      const da = a.deadline && a.status !== 'done' ? daysUntil(a.deadline) : Infinity;
      const dbb = b.deadline && b.status !== 'done' ? daysUntil(b.deadline) : Infinity;
      return da - dbb || statusOrder[a.status] - statusOrder[b.status];
    },
    progress: (a, b) => progress(b) - progress(a),
    title: (a, b) => a.title.localeCompare(b.title, 'pt-BR', { numeric: true }),
    added: (a, b) => b.createdAt - a.createdAt,
  }[state.sort];
  return list.sort(cmp);
}

function renderTabs() {
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
  $('booksView').hidden = state.tab !== 'books';
  $('coursesView').hidden = state.tab !== 'courses';
  $('tabBooksN').textContent = state.books.length || '';
  $('addBtn').querySelector('span').textContent = state.tab === 'courses' ? 'Adicionar curso' : 'Adicionar PDF';
  $('search').placeholder = state.tab === 'courses' ? 'Buscar curso' : 'Buscar livro ou autor';
}

function render() {
  renderHeader();
  renderTabs();
  if (state.tab === 'courses') { courses?.render(); renderStats(); return; }
  renderHero();
  renderStats();
  const lib = $('library');
  const empty = state.books.length === 0;
  $('empty').hidden = !empty;
  for (const id of ['controls', 'stats', 'topGrid']) $(id).hidden = empty;
  if (empty) { lib.innerHTML = ''; return; }

  document.querySelectorAll('#filters .chip').forEach(ch => {
    const f = ch.dataset.filter;
    const n = state.books.filter(b => (!state.collection || b.collection === state.collection) && matchesFilter(b, f)).length;
    ch.innerHTML = `${ch.dataset.label || (ch.dataset.label = ch.textContent)}<span class="n">${n}</span>`;
    ch.classList.toggle('active', f === state.filter);
    ch.classList.toggle('zero', n === 0);
  });
  document.querySelectorAll('#stats .stat[data-filter]').forEach(s => s.classList.toggle('active', s.dataset.filter === state.filter && state.filter !== 'all'));
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('sort').value = state.sort;

  const cols = collections();
  const sel = $('collection');
  sel.hidden = cols.length === 0;
  if (state.collection && !cols.some(([c]) => c === state.collection)) state.collection = '';
  sel.innerHTML = `<option value="">Todas as coleções</option>` + cols.map(([c, n]) => `<option value="${esc(c)}">${esc(c)} (${n})</option>`).join('');
  sel.value = state.collection;
  $('collectionList').innerHTML = cols.map(([c]) => `<option value="${esc(c)}">`).join('');

  const list = visibleBooks();
  if (!list.length) {
    lib.innerHTML = `<div class="no-results"><p>Nenhum livro encontrado com esses filtros.</p><button class="btn sm" data-action="clear-filters">Limpar filtros</button></div>`;
    return;
  }
  // Agrupa por coleção quando há mais de uma e nenhuma está selecionada.
  const groups = [];
  if (!state.collection && cols.length && !state.query) {
    const by = new Map();
    for (const b of list) { const k = b.collection || ''; if (!by.has(k)) by.set(k, []); by.get(k).push(b); }
    const keys = [...by.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'pt-BR'));
    // Livros soltos primeiro
    keys.sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'pt-BR')));
    for (const k of keys) groups.push({ name: k || 'Livros', items: by.get(k) });
  } else {
    groups.push({ name: '', items: list });
  }
  lib.innerHTML = state.view === 'grid' ? gridHtml(groups) : listHtml(groups);
}

function renderHeader() {
  const h = new Date().getHours();
  const verb = state.tab === 'courses' ? 'estudar' : 'ler';
  $('greeting').textContent = h < 5 ? `Boa madrugada, bora ${verb}?` : h < 12 ? `Bom dia, bora ${verb}?` : h < 18 ? `Boa tarde, bora ${verb}?` : `Boa noite, hora de ${verb}`;
  const d = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('today').textContent = d[0].toUpperCase() + d.slice(1);
}

function coverHtml(b) {
  if (b.cover) return `<img src="${b.cover}" alt="" loading="lazy" decoding="async">`;
  return `<div class="ph" style="--ph:${coverColor(b)}"><b>${esc(b.title)}</b>${b.author ? `<small>${esc(b.author)}</small>` : ''}</div>`;
}

function renderHero() {
  const hero = $('hero');
  const candidates = state.books
    .filter(b => b.status === 'reading' || ((b.status === 'paused' || b.status === 'queue') && b.lastReadAt))
    .sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  const b = candidates[0];
  if (!b) { hero.hidden = true; return; }
  hero.hidden = false;
  const p = progress(b), dl = deadlineInfo(b);
  const left = pagesLeft(b);
  const meta = [`Pág. ${b.currentPage}${b.totalPages ? ` de ${b.totalPages}` : ''}`, `${p}%`];
  if (b.totalPages && left) meta.push(`≈ ${fmtDuration(left * secPerPage())} para terminar`);
  if (!dl.none) meta.push(dl.text + (dl.perDay ? ` · ${dl.perDay} pág./dia` : ''));
  const others = candidates.slice(1, 6);
  hero.innerHTML = `
    <button class="hero-cover" data-read="${b.id}" aria-label="Continuar ${esc(b.title)}" style="background:${b.cover ? '#fff' : coverColor(b)}">
      ${b.cover ? `<img src="${b.cover}" alt="">` : esc(initials(b.title))}
    </button>
    <div class="hero-body">
      <div class="hero-kicker">${b.lastReadAt ? 'Continue de onde parou' : 'Lendo agora'}</div>
      <h2>${esc(b.title)}</h2>
      ${b.author ? `<p class="hero-author">${esc(b.author)}</p>` : ''}
      <div class="progress"><span style="width:${p}%"></span></div>
      <div class="hero-meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>
      <div class="hero-actions">
        <button class="btn primary" data-read="${b.id}">${b.currentPage > 1 ? 'Continuar lendo' : 'Começar a ler'}</button>
        <button class="btn ghost" data-details="${b.id}">Detalhes</button>
      </div>
      ${others.length ? `<div class="hero-more">${others.map(o => `<button data-read="${o.id}" title="${esc(o.title)} — ${progress(o)}%">${o.cover ? `<img src="${o.cover}" alt="">` : esc(initials(o.title))}</button>`).join('')}</div>` : ''}
    </div>`;
}

function gridHtml(groups) {
  return groups.map(g => `
    ${g.name ? `<h3 class="group-title">${esc(g.name)} <small>${plural(g.items.length, 'livro', 'livros')}</small></h3>` : ''}
    <div class="grid">${g.items.map(cardHtml).join('')}</div>`).join('');
}

function cardHtml(b) {
  const p = progress(b), st = STATUS[b.status], dl = deadlineInfo(b);
  const hasFile = state.files.has(b.id);
  const dlp = state.downloads.get(b.id);
  let corner = '';
  if (b.status === 'done') corner = '<span class="badge done">✓ Lido</span>';
  else if (p > 0 && b.currentPage > 1) corner = `<span class="badge pct">${p}%</span>`;
  let bottom = '';
  if (b.source === 'drive' && !hasFile) bottom = '<span class="badge cloud" title="Está no Google Drive; será baixado ao abrir"><svg><use href="#i-cloud"/></svg>Drive</span>';
  else if (b.source !== 'drive' && !hasFile) bottom = '<span class="badge nofile">PDF não está neste aparelho</span>';
  return `<article class="card" data-id="${b.id}">
    <div class="cover-wrap">
    <button class="cover" data-action="read" aria-label="Ler ${esc(b.title)}">
      ${coverHtml(b)}
      ${corner}
      ${b.priority === 'high' && b.status !== 'done' ? '<span class="badge prio">★ Prioridade</span>' : ''}
      ${bottom}
      ${p > 0 && b.status !== 'done' ? `<span class="bottom-bar"><span style="width:${p}%"></span></span>` : ''}
      <span class="play"><span>${b.currentPage > 1 && b.status !== 'done' ? 'Continuar' : 'Ler'}</span></span>
      ${dlp != null ? `<span class="dl-overlay">Baixando ${Math.round(dlp * 100)}%</span>` : ''}
    </button>
    <button class="more" data-action="details" aria-label="Detalhes de ${esc(b.title)}"><svg><use href="#i-more"/></svg></button>
    </div>
    <div class="card-body">
      <h3 data-action="details" title="${esc(b.title)}">${esc(b.title)}</h3>
      ${b.author ? `<p class="author">${esc(b.author)}</p>` : ''}
      <div class="tags">
        <span class="pill" style="--c:${st.color}">${st.label}</span>
        ${dl.none || b.status === 'done' ? '' : `<span class="due ${dl.cls}" title="${esc(dl.pace || '')}">${esc(dl.text)}</span>`}
      </div>
      <div class="meta">
        <span>${b.totalPages ? `${b.status === 'done' ? b.totalPages : b.currentPage}/${b.totalPages} pág.` : 'Ainda não aberto'}</span>
        ${checkSummary(b)}
      </div>
    </div>
  </article>`;
}

function checkSummary(b) {
  if (!b.checklist.length) return '';
  const done = b.checklist.filter(c => c.done).length;
  return `<span title="Checklist do livro">☑ ${done}/${b.checklist.length}</span>`;
}

function listHtml(groups) {
  const row = b => {
    const p = progress(b), st = STATUS[b.status], dl = deadlineInfo(b);
    return `<div class="row ${b.status === 'done' ? 'is-done' : ''}" data-id="${b.id}">
      <div class="r-chk"><input type="checkbox" class="check" data-action="toggle-done" ${b.status === 'done' ? 'checked' : ''} aria-label="Marcar como concluído" title="Marcar como concluído"></div>
      <div class="r-title" data-action="details">
        ${b.cover ? `<img class="mini" src="${b.cover}" alt="" loading="lazy">` : `<span class="mini" style="--ph:${coverColor(b)}">${esc(initials(b.title))}</span>`}
        <div><strong>${esc(b.title)}</strong><small>${esc([b.author, b.priority === 'high' ? '★ Prioridade alta' : ''].filter(Boolean).join(' · ') || (b.source === 'drive' ? 'Google Drive' : 'Neste aparelho'))}</small></div>
      </div>
      <div class="r-status"><select data-action="status" style="--c:${st.color}" aria-label="Status">
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select></div>
      <div class="r-prog">
        <div class="progress ${b.status === 'done' ? 'done' : ''}"><span style="width:${p}%"></span></div>
        <span>${p}%${b.totalPages ? ` · pág. ${b.status === 'done' ? b.totalPages : b.currentPage}/${b.totalPages}` : ''}${b.checklist.length ? ` · ☑ ${b.checklist.filter(c => c.done).length}/${b.checklist.length}` : ''}</span>
      </div>
      <div class="r-due"><input type="date" data-action="deadline" value="${b.deadline}" aria-label="Prazo" title="Prazo"></div>
      <div class="r-sit"><span class="due ${dl.cls}">${esc(dl.text)}</span>${dl.pace ? `<small>${esc(dl.pace)}</small>` : ''}</div>
      <div class="r-act"><button class="btn sm primary" data-action="read">${b.currentPage > 1 && b.status !== 'done' ? 'Continuar' : 'Ler'}</button></div>
    </div>`;
  };
  return `<div class="list">
    <div class="list-head"><span></span><span>Livro</span><span>Status</span><span>Progresso</span><span>Prazo</span><span>Situação</span><span></span></div>
    ${groups.map(g => `${g.name ? `<div class="list-group">${esc(g.name)}</div>` : ''}${g.items.map(row).join('')}`).join('')}
  </div>`;
}

function renderStats() {
  const b = state.books;
  $('stTotal').textContent = b.length;
  $('stReading').textContent = b.filter(x => x.status === 'reading').length;
  $('stDone').textContent = b.filter(x => x.status === 'done').length;
  const late = b.filter(x => deadlineInfo(x).late).length;
  $('stLate').textContent = late;
  $('stLate').parentElement.classList.toggle('has', late > 0);

  const perDay = {}, timeDay = {};
  for (const book of b) {
    for (const [k, v] of Object.entries(book.log || {})) perDay[k] = (perDay[k] || 0) + v;
    for (const [k, v] of Object.entries(book.timeLog || {})) timeDay[k] = (timeDay[k] || 0) + v;
  }
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const max = Math.max(1, ...days.map(d => perDay[dateKey(d)] || 0));
  const wd = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
  const today = dateKey();
  $('weekBars').innerHTML = days.map(d => {
    const k = dateKey(d), v = perDay[k] || 0;
    return `<div class="bar ${k === today ? 'today' : ''}" title="${d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' })}: ${plural(v, 'página', 'páginas')}"><i class="${v ? '' : 'zero'}" style="height:${Math.round((v / max) * 36) + 3}px"></i><span>${wd[d.getDay()]}</span></div>`;
  }).join('');
  const week = days.reduce((a, d) => a + (perDay[dateKey(d)] || 0), 0);
  $('weekTotal').textContent = week ? plural(week, 'página', 'páginas') : '';

  let streak = 0;
  const d = new Date();
  if (!perDay[dateKey(d)]) d.setDate(d.getDate() - 1);
  while (perDay[dateKey(d)]) { streak++; d.setDate(d.getDate() - 1); }
  $('stStreak').parentElement.innerHTML = `<b id="stStreak">${streak}</b> ${streak === 1 ? 'dia seguido' : 'dias seguidos'}`;
  const studySec = (timeDay[today] || 0) + (courses?.timeOn(today) || 0);
  $('stTime').textContent = fmtDuration(studySec).replace('menos de 1 min', '0 min');

  // Meta do dia
  const todayPages = perDay[today] || 0;
  const ratio = Math.min(1, todayPages / state.goal);
  $('goalNum').textContent = todayPages;
  $('goalOf').textContent = `de ${state.goal} pág.`;
  $('goalArc').style.strokeDashoffset = String(326.7 * (1 - ratio));
  $('goalRing').classList.toggle('done', ratio >= 1);
  $('goalRing').setAttribute('aria-label', `Meta de hoje: ${todayPages} de ${state.goal} páginas`);
  $('goalMsg').textContent = ratio >= 1 ? 'Meta cumprida! 🎉 Cada página extra é bônus.'
    : todayPages ? `Faltam ${plural(state.goal - todayPages, 'página', 'páginas')} (≈ ${fmtDuration((state.goal - todayPages) * secPerPage())}).`
    : streak ? `Leia hoje para manter sua sequência de ${plural(streak, 'dia', 'dias')}.` : 'Leia um pouco hoje e comece uma sequência.';
}

/* ================= Eventos da biblioteca ================= */
function bookById(id) { return state.books.find(b => b.id === id); }
function bookFromEvent(e) { const el = e.target.closest('[data-id]'); return el && bookById(el.dataset.id); }

$('library').addEventListener('click', e => {
  const actEl = e.target.closest('[data-action]');
  const act = actEl?.dataset.action;
  if (act === 'clear-filters') { state.filter = 'all'; state.collection = ''; state.query = ''; $('search').value = ''; save('hb-collection', ''); render(); return; }
  const book = bookFromEvent(e);
  if (!book || !act) return;
  if (act === 'read') openReader(book);
  else if (act === 'details') openDetails(book);
});

$('hero').addEventListener('click', e => {
  const r = e.target.closest('[data-read]'), d = e.target.closest('[data-details]');
  if (r) openReader(bookById(r.dataset.read));
  else if (d) openDetails(bookById(d.dataset.details));
});

$('library').addEventListener('change', async e => {
  const act = e.target.dataset.action;
  const book = bookFromEvent(e);
  if (!book) return;
  if (act === 'toggle-done') {
    const prev = { status: book.status, currentPage: book.currentPage, finishedAt: book.finishedAt };
    setStatus(book, e.target.checked ? 'done' : (book.currentPage > 1 ? 'reading' : 'queue'));
    await persist(book);
    render();
    if (book.status === 'done') toast(`"${book.title}" concluído! 🎉`, { label: 'Desfazer', run: async () => { Object.assign(book, prev); await persist(book); render(); } });
  } else if (act === 'status') {
    setStatus(book, e.target.value);
    await persist(book);
    render();
  } else if (act === 'deadline') {
    book.deadline = e.target.value;
    await persist(book);
    render();
  }
});

function setFilter(f) {
  state.filter = f;
  render();
}
$('filters').addEventListener('click', e => { const f = e.target.closest('.chip')?.dataset.filter; if (f) setFilter(f); });
$('stats').addEventListener('click', e => {
  const f = e.target.closest('.stat[data-filter]')?.dataset.filter;
  if (!f) return;
  setFilter(state.filter === f ? 'all' : f);
  $('controls').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelector('.seg').addEventListener('click', e => {
  const v = e.target.closest('.seg-btn')?.dataset.view;
  if (v) { state.view = v; save('hb-view', v); render(); }
});
$('sort').addEventListener('change', e => { state.sort = e.target.value; save('hb-sort', state.sort); render(); });
$('collection').addEventListener('change', e => { state.collection = e.target.value; save('hb-collection', state.collection); render(); });
$('search').addEventListener('input', e => { state.query = e.target.value; render(); });

$('addBtn').onclick = () => (state.tab === 'courses' ? $('addCourseBtn').click() : $('fileInput').click());
$('tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab')?.dataset.tab;
  if (!t || t === state.tab) return;
  state.tab = t;
  save('hb-tab', t);
  render();
});
document.querySelector('.start-opt[data-action="add"]').onclick = () => $('fileInput').click();
document.querySelector('.start-opt[data-action="drive"]').onclick = () => openDriveDialog();
$('fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });

// Arrastar e soltar
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e) || !$('reader').hidden) return; dragDepth++; $('dropzone').hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  if ($('reader').hidden) addFiles(e.dataTransfer.files);
});

// Atalho "/" para buscar
addEventListener('keydown', e => {
  if (e.key === '/' && $('reader').hidden && !document.querySelector('dialog[open]') && !e.target.matches('input, textarea, select')) {
    e.preventDefault();
    $('search').focus();
  }
});

// Menu
$('menuBtn').onclick = e => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; };
addEventListener('click', () => { $('menu').hidden = true; });
document.addEventListener('click', e => {
  const m = e.target.closest('[data-menu]')?.dataset.menu;
  if (!m) return;
  if (m === 'export') exportBackup();
  else if (m === 'import') $('importInput').click();
  else if (m === 'theme') toggleTheme();
  else if (m === 'storage') showStorage();
  else if (m === 'goal') setGoal();
  else if (m === 'help') $('helpDlg').showModal();
});
$('importInput').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

function setGoal() {
  const v = prompt('Quantas páginas você quer ler por dia?', state.goal);
  const n = Math.round(+v);
  if (!v || !n || n < 1) return;
  state.goal = Math.min(2000, n);
  save('hb-goal', state.goal);
  save('hb-goal-at', Date.now());
  renderStats();
  scheduleSync();
  toast(`Meta diária: ${plural(state.goal, 'página', 'páginas')}.`);
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  save('hb-theme', next);
}

async function showStorage() {
  const est = await navigator.storage?.estimate?.();
  const local = state.books.filter(b => state.files.has(b.id)).reduce((a, b) => a + (b.fileSize || 0), 0);
  if (!est) { toast(`PDFs neste aparelho: ${fmtMB(local)}.`); return; }
  const persisted = await navigator.storage.persisted?.();
  toast(`PDFs salvos: ${fmtMB(local)} · espaço usado ${fmtMB(est.usage)} de ${fmtMB(est.quota)}.${persisted ? ' Armazenamento protegido ✓' : ''}`, null, 7000);
}

function exportBackup() {
  const data = { app: 'hubdrive', version: 1, exportedAt: new Date().toISOString(), books: state.books, courses: courses?.export() || [], tombstones: state.tombstones, settings: { goal: state.goal, goalAt: +load('hb-goal-at', '0') } };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hubdrive-backup-${dateKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Backup exportado (progresso, status, prazos, checklists e notas). Os PDFs não vão no backup.', null, 6000);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!['hubdrive', 'hubbooks'].includes(data.app) || !Array.isArray(data.books)) throw new Error('formato');
    const n = await mergeRemote(data);
    await refresh();
    const missing = state.books.filter(b => b.source !== 'drive' && !state.files.has(b.id)).length;
    toast(`${plural(n, 'livro atualizado', 'livros atualizados')}.${missing ? ` ${missing} sem PDF neste aparelho: abra "Detalhes" para anexar.` : ''}`, null, 7000);
  } catch {
    toast('Arquivo de backup inválido.');
  }
}

/** Junta dados vindos de outro aparelho (sincronização ou backup). Retorna quantos livros mudaram. */
async function mergeRemote(data) {
  let changed = 0;
  const tomb = { ...state.tombstones };
  for (const [id, at] of Object.entries(data.tombstones || {})) tomb[id] = Math.max(tomb[id] || 0, at);
  for (const raw of data.books || []) {
    if (!raw.id || !raw.title) continue;
    if (tomb[raw.id] && tomb[raw.id] >= (raw.updatedAt || 0)) continue;
    const local = state.books.find(b => b.id === raw.id);
    if (local && (local.updatedAt || 0) >= (raw.updatedAt || 0)) {
      // mesmo assim, junta o histórico diário de páginas/tempo
      if (mergeLogs(local, raw)) { await db.putBook(local); changed++; }
      continue;
    }
    const merged = normalize({ ...raw, cover: local?.cover || raw.cover || '', zoom: local?.zoom ?? raw.zoom });
    if (local) mergeLogs(merged, local);
    await db.putBook(merged);
    const i = state.books.findIndex(b => b.id === merged.id);
    if (i >= 0) state.books[i] = merged; else state.books.push(merged);
    if (state.reading?.id === merged.id) state.reading = merged;
    changed++;
  }
  // exclusões feitas em outro aparelho
  for (const [id, at] of Object.entries(tomb)) {
    const b = state.books.find(x => x.id === id);
    if (b && at >= (b.updatedAt || 0) && state.reading?.id !== id) {
      await db.deleteBook(id); await db.deleteFile(id);
      state.books = state.books.filter(x => x.id !== id);
      state.files.delete(id);
      changed++;
    }
  }
  state.tombstones = tomb;
  await db.setMeta('tombstones', tomb);
  if (courses) changed += await courses.merge(data.courses, tomb);
  if (data.settings?.goal && (data.settings.goalAt || 0) > +load('hb-goal-at', '0')) {
    state.goal = data.settings.goal;
    save('hb-goal', state.goal);
    save('hb-goal-at', data.settings.goalAt);
  }
  return changed;
}

function mergeLogs(target, other) {
  let changed = false;
  for (const key of ['log', 'timeLog']) {
    target[key] ||= {};
    for (const [d, v] of Object.entries(other[key] || {})) {
      if ((target[key][d] || 0) < v) { target[key][d] = v; changed = true; }
    }
  }
  if ((other.readSeconds || 0) > (target.readSeconds || 0)) { target.readSeconds = other.readSeconds; changed = true; }
  return changed;
}

/* ================= Detalhes ================= */
const dlg = $('details');
const form = $('detailsForm');

function openDetails(book) {
  if (!book) return;
  state.editing = structuredClone(book);
  const b = state.editing;
  form.title.value = b.title;
  form.author.value = b.author;
  form.status.value = b.status;
  form.priority.value = b.priority;
  form.startDate.value = b.startDate;
  form.deadline.value = b.deadline;
  form.currentPage.value = b.currentPage;
  form.currentPage.max = b.totalPages || '';
  form.notes.value = b.notes;
  form.collection.value = b.collection || '';
  renderDetailCover();
  renderChecklist();
  renderBookmarks();
  renderPlan();
  renderFileBox();
  dlg.showModal();
  dlg.querySelector('.dlg-body').scrollTop = 0;
}

function renderDetailCover() {
  const b = state.editing;
  const c = $('dCover');
  c.style.setProperty('--ph', coverColor(b));
  c.innerHTML = b.cover ? `<img src="${b.cover}" alt="">` : esc(initials(b.title));
}

function renderPlan() {
  const b = { ...state.editing, status: form.status.value, deadline: form.deadline.value, currentPage: +form.currentPage.value || 1 };
  const dl = deadlineInfo(b);
  const p = progress(b);
  const left = pagesLeft(b);
  const cells = [`<div><b>${p}%</b><span>lido${b.totalPages ? ` · ${b.totalPages} pág.` : ''}</span></div>`];
  if (b.totalPages && b.status !== 'done') cells.push(`<div><b>${left ? '≈ ' + fmtDuration(left * secPerPage()) : '—'}</b><span>para terminar</span></div>`);
  if (b.deadline && b.status !== 'done') cells.push(`<div class="${dl.late ? 'late' : ''}"><b>${dl.perDay ? `${dl.perDay}/dia` : dl.late ? 'Atrasado' : '—'}</b><span>${esc(dl.late ? dl.text : 'páginas para cumprir o prazo')}</span></div>`);
  if (b.readSeconds) cells.push(`<div><b>${fmtDuration(b.readSeconds)}</b><span>de leitura no total</span></div>`);
  $('dPlan').innerHTML = cells.join('');
}
['status', 'deadline', 'currentPage'].forEach(n => form[n].addEventListener('input', renderPlan));
document.querySelector('.quick-dates').addEventListener('click', e => {
  const days = e.target.dataset.days;
  if (days == null) return;
  if (+days === 0) form.deadline.value = '';
  else { const d = new Date(); d.setDate(d.getDate() + +days); form.deadline.value = dateKey(d); }
  renderPlan();
});

const trashSvg = '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>';

function renderChecklist() {
  const list = state.editing.checklist;
  const done = list.filter(c => c.done).length;
  $('dCheckCount').textContent = list.length ? `(${done}/${list.length})` : '';
  $('dChecklist').innerHTML = (list.length ? `<div class="progress check-progress ${done === list.length ? 'done' : ''}"><span style="width:${(done / list.length) * 100}%"></span></div>` : '') + (list.map(c => `
    <li class="${c.done ? 'done' : ''}" data-cid="${c.id}">
      <input type="checkbox" class="check" ${c.done ? 'checked' : ''} aria-label="Concluir item">
      <span>${esc(c.text)}</span>
      ${c.page ? `<button type="button" class="go" data-go="${c.page}">pág. ${c.page}</button>` : ''}
      <button type="button" class="icon-btn" data-del aria-label="Remover item">${trashSvg}</button>
    </li>`).join('') || '<li class="muted" style="border:0">Nenhum item ainda. Crie metas como capítulos, resumos ou exercícios.</li>');
}

$('dChecklist').addEventListener('click', e => {
  const li = e.target.closest('li[data-cid]');
  if (!li) return;
  const list = state.editing.checklist;
  const item = list.find(c => c.id === li.dataset.cid);
  if (e.target.closest('[data-del]')) {
    state.editing.checklist = list.filter(c => c !== item);
    renderChecklist();
  } else if (e.target.matches('input[type=checkbox]')) {
    item.done = e.target.checked;
    renderChecklist();
  } else if (e.target.dataset.go) {
    goFromDetails(+e.target.dataset.go);
  }
});

function addCheckItem() {
  const input = $('dCheckInput');
  const text = input.value.trim();
  if (!text) return;
  state.editing.checklist.push({ id: uid(), text, done: false });
  input.value = '';
  renderChecklist();
  input.focus();
}
$('dCheckAdd').onclick = addCheckItem;
$('dCheckInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCheckItem(); } });

$('dCheckChapters').onclick = async () => {
  const b = state.editing;
  const data = await db.getFile(b.id);
  if (!data) { toast(b.source === 'drive' ? 'Abra o livro uma vez para baixá-lo e depois tente de novo.' : 'Anexe o PDF primeiro.'); return; }
  try {
    const pdf = await loadPdf(data);
    const items = await getOutline(pdf, 1);
    pdf.destroy();
    if (!items.length) { toast('Este PDF não possui sumário interno.'); return; }
    const existing = new Set(b.checklist.map(c => c.text));
    let added = 0;
    for (const it of items) {
      if (existing.has(it.title)) continue;
      b.checklist.push({ id: uid(), text: it.title, page: it.page, done: !!(it.page && it.page < b.currentPage) });
      added++;
    }
    renderChecklist();
    toast(added ? `${plural(added, 'item adicionado', 'itens adicionados')} do sumário.` : 'Os itens do sumário já estão na lista.');
  } catch (err) {
    console.error(err);
    toast('Não foi possível ler o sumário.');
  }
};

function renderBookmarks() {
  const bms = [...state.editing.bookmarks].sort((a, b) => a - b);
  $('dBookmarks').innerHTML = bms.length
    ? bms.map(p => `<span class="bm-chip"><button type="button" class="go" data-go="${p}">Pág. ${p}</button><button type="button" data-rm="${p}" aria-label="Remover marcador">✕</button></span>`).join('')
    : '<span class="empty-bm">Toque no ícone de marcador no leitor (ou tecla B) para salvar páginas.</span>';
}
$('dBookmarks').addEventListener('click', e => {
  if (e.target.dataset.rm) {
    state.editing.bookmarks = state.editing.bookmarks.filter(p => p !== +e.target.dataset.rm);
    renderBookmarks();
  } else if (e.target.dataset.go) {
    goFromDetails(+e.target.dataset.go);
  }
});

function renderFileBox() {
  const b = state.editing;
  const has = state.files.has(b.id);
  const box = $('dFile');
  box.classList.toggle('warn', !has && b.source !== 'drive');
  $('dRead').hidden = !has && b.source !== 'drive';
  const name = `<b>${esc(b.fileName || 'arquivo PDF')}</b>`;
  if (b.source === 'drive') {
    box.innerHTML = has
      ? `<p>☁️ ${name} · do Google Drive, salvo neste aparelho (${fmtMB(b.fileSize || 0)}).</p><button type="button" class="btn sm" data-file="evict">Liberar espaço</button>`
      : `<p>☁️ ${name} · no Google Drive${b.fileSize ? ` (${fmtMB(b.fileSize)})` : ''}. Será baixado quando você abrir.</p><button type="button" class="btn sm" data-file="download">Baixar agora</button>`;
    box.innerHTML += `<a class="btn sm" href="https://drive.google.com/file/d/${encodeURIComponent(b.driveId)}/view" target="_blank" rel="noopener">Abrir no Drive</a>`;
  } else {
    box.innerHTML = has
      ? `<p>📄 ${name} · neste aparelho${b.fileSize ? ` (${fmtMB(b.fileSize)})` : ''}.</p><button type="button" class="btn sm" data-file="relink">Substituir PDF</button>`
      : `<p>⚠️ O PDF deste livro não está neste aparelho.</p><button type="button" class="btn sm" data-file="relink">Anexar PDF</button>`;
  }
}

$('dFile').addEventListener('click', async e => {
  const act = e.target.dataset.file;
  const b = state.editing;
  if (!act || !b) return;
  if (act === 'relink') $('dRelinkInput').click();
  else if (act === 'evict') {
    await db.deleteFile(b.id);
    state.files.delete(b.id);
    renderFileBox();
    render();
    toast('Arquivo removido deste aparelho. Ele continua no Drive e na sua estante.');
  } else if (act === 'download') {
    const live = bookById(b.id);
    if (await ensureFile(live)) { renderFileBox(); toast('Livro disponível offline.'); }
  }
});

async function saveDetails() {
  const b = state.editing;
  if (!b) return;
  b.title = form.title.value.trim() || b.title;
  b.author = form.author.value.trim();
  b.priority = form.priority.value;
  b.startDate = form.startDate.value;
  b.deadline = form.deadline.value;
  b.notes = form.notes.value;
  b.collection = form.collection.value.trim();
  const cp = Math.round(+form.currentPage.value) || 1;
  b.currentPage = Math.max(1, b.totalPages ? Math.min(cp, b.totalPages) : cp);
  setStatus(b, form.status.value);
  // Preserva o que pode ter mudado enquanto o diálogo estava aberto (leitura, download).
  const live = bookById(b.id);
  if (live) {
    for (const k of ['log', 'timeLog', 'readSeconds', 'lastReadAt', 'totalPages', 'fileSize', 'fileName', 'zoom']) b[k] = live[k];
    if (!b.cover) b.cover = live.cover;
  }
  await persist(b);
  render();
  return b;
}

async function goFromDetails(page) {
  const b = await saveDetails();
  dlg.close();
  if (state.reading && state.reading.id === b.id) reader.goTo(page, 'jump');
  else openReader(b, page);
}

form.addEventListener('submit', async e => {
  if (e.submitter?.value === 'save') {
    e.preventDefault();
    await saveDetails();
    dlg.close();
    if (state.reading) { $('rdTitle').textContent = state.reading.title; reader.setTicks(state.reading.bookmarks); }
    toast('Alterações salvas.');
  }
});
dlg.addEventListener('close', () => { state.editing = null; });

$('dRead').onclick = async () => {
  const b = await saveDetails();
  dlg.close();
  if (!state.reading) openReader(b);
};

$('dDelete').onclick = async () => {
  const b = state.editing;
  const extra = b.source === 'drive' ? ' O arquivo continua no seu Google Drive.' : ' O PDF salvo neste aparelho será apagado.';
  if (!confirm(`Remover "${b.title}" da estante? O progresso, checklist e anotações serão perdidos.${extra}`)) return;
  if (state.reading?.id === b.id) { state.reading = null; reader.close(); }
  await removeBook(b);
  dlg.close();
  render();
  toast('Livro removido da estante.');
};

$('dRelinkInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = await file.arrayBuffer();
    const info = await inspectPdf(data);
    const b = state.editing;
    if (b.totalPages && info.pages !== b.totalPages &&
        !confirm(`Este PDF tem ${info.pages} páginas, mas o livro salvo tinha ${b.totalPages}. Usar mesmo assim?`)) return;
    await db.putFile(b.id, data);
    state.files.add(b.id);
    const live = bookById(b.id);
    Object.assign(live, { totalPages: info.pages, fileName: file.name, fileSize: file.size });
    if (!live.cover) live.cover = info.cover;
    b.cover = live.cover;
    renderDetailCover();
    await saveDetails();
    renderFileBox();
    toast('PDF anexado.');
  } catch {
    toast('Não foi possível ler este PDF.');
  }
});

/* ================= Leitor ================= */
let saveTimer;
let lastActivity = 0;
const reader = new Reader({
  onPageChange(page, prev, source) {
    const b = state.reading;
    if (!b) return;
    lastActivity = Date.now();
    b.currentPage = page;
    b.lastReadAt = Date.now();
    // Conta como lidas as páginas avançadas rolando/teclado (saltos grandes não contam).
    if ((source === 'scroll' || source === 'key') && page > prev && page - prev <= 3) {
      const k = dateKey();
      b.log[k] = (b.log[k] || 0) + (page - prev);
      if (b.log[k] === state.goal) toast('Meta de hoje cumprida! 🎉');
    }
    if ((b.status === 'queue' || b.status === 'paused') && page > 1 && source !== 'open') {
      setStatus(b, 'reading');
      toast('Status alterado para "Lendo".');
    }
    if (page === b.totalPages && b.status !== 'done' && source !== 'open') {
      toast('Você chegou à última página! 🎉', {
        label: 'Marcar como concluído',
        run: async () => { setStatus(b, 'done'); await persist(b); toast(`"${b.title}" concluído!`); },
      });
    }
    reader.setBookmarked(b.bookmarks.includes(page));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persist(b), 800);
  },
  async onClose(_book, zoom) {
    clearTimeout(saveTimer);
    const b = state.reading;
    state.reading = null;
    if (location.hash === '#ler') history.back();
    if (b) { b.zoom = zoom; await persist(b); }
    render();
    syncNow();
  },
  async onBookmark(page) {
    const b = state.reading;
    if (!b) return;
    const on = !b.bookmarks.includes(page);
    b.bookmarks = on ? [...b.bookmarks, page] : b.bookmarks.filter(p => p !== page);
    reader.setBookmarked(on);
    reader.setTicks(b.bookmarks);
    await persist(b);
    toast(on ? `Página ${page} marcada.` : `Marcador da página ${page} removido.`);
  },
  onInfo() {
    const b = state.reading;
    if (b) { clearTimeout(saveTimer); persist(b).then(() => openDetails(b)); }
  },
});

// Tempo de leitura: conta enquanto o leitor está aberto, visível e com atividade recente.
const TICK = 15;
setInterval(() => {
  const b = state.reading;
  if (!b || document.hidden || Date.now() - lastActivity > 120_000) return;
  const k = dateKey();
  b.timeLog[k] = (b.timeLog[k] || 0) + TICK;
  b.readSeconds = (b.readSeconds || 0) + TICK;
}, TICK * 1000);
for (const ev of ['scroll', 'pointerdown', 'keydown', 'wheel']) {
  $('rdScroller').addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true });
}

/** Garante que o PDF está no aparelho (baixa do Drive se preciso). */
async function ensureFile(book, onProgress) {
  if (state.files.has(book.id)) return true;
  if (book.source !== 'drive') return false;
  if (!drive.connected) {
    toast('Conecte o Google Drive para baixar este livro.', { label: 'Conectar', run: () => connectDrive().then(ok => ok && ensureFile(book, onProgress)) });
    return false;
  }
  state.downloads.set(book.id, 0);
  const overlay = () => document.querySelector(`.card[data-id="${book.id}"] .cover`);
  try {
    const data = await drive.download(book.driveId, book.fileSize, p => {
      state.downloads.set(book.id, p);
      onProgress?.(p);
      const c = overlay();
      if (c) {
        let o = c.querySelector('.dl-overlay');
        if (!o) { o = document.createElement('span'); o.className = 'dl-overlay'; c.appendChild(o); }
        o.textContent = `Baixando ${Math.round(p * 100)}%`;
      }
    });
    await db.putFile(book.id, data);
    state.files.add(book.id);
    navigator.storage?.persist?.();
    // Primeira vez: descobre nº de páginas e gera capa se não houver.
    if (!book.totalPages || !book.cover) {
      try {
        const info = await inspectPdf(data);
        book.totalPages = info.pages;
        if (!book.cover) book.cover = info.cover;
        if (!book.author && info.author) book.author = info.author;
      } catch {}
    }
    book.fileSize = data.byteLength;
    await persist(book);
    return true;
  } catch (err) {
    console.error(err);
    if (err instanceof DriveAuthError) {
      updateDriveButton();
      toast('Sua sessão do Google expirou.', { label: 'Reconectar', run: () => connectDrive().then(ok => ok && ensureFile(book, onProgress)) });
    } else {
      toast(`Falha ao baixar do Drive: ${err.message}`);
    }
    return false;
  } finally {
    state.downloads.delete(book.id);
    overlay()?.querySelector('.dl-overlay')?.remove();
  }
}

async function openReader(book, page) {
  if (!book) return;
  if (!state.files.has(book.id)) {
    if (book.source !== 'drive') {
      toast('O PDF deste livro não está neste aparelho. Anexe o arquivo nos detalhes.');
      openDetails(book);
      return;
    }
    if (state.downloads.has(book.id)) return;
    if (!drive.connected) { await ensureFile(book); return; }
    reader.show(book);
    state.reading = book;
    history.pushState({ reader: book.id }, '', '#ler');
    reader.setLoading(`Baixando do Google Drive…`, 0);
    const ok = await ensureFile(book, p => {
      if (state.reading?.id === book.id) reader.setLoading(`Baixando do Google Drive… ${Math.round(p * 100)}%`, p);
    });
    if (state.reading?.id !== book.id) return; // usuário voltou durante o download
    if (!ok) { reader.close(); return; }
    book = bookById(book.id);
  }
  const data = await db.getFile(book.id);
  if (!state.reading) history.pushState({ reader: book.id }, '', '#ler');
  state.reading = book;
  book.lastReadAt = Date.now();
  lastActivity = Date.now();
  reader.setBookmarked(book.bookmarks.includes(page || book.currentPage));
  try {
    await reader.open(book, data, page || book.currentPage);
    reader.setTicks(book.bookmarks);
    if (!book.totalPages && reader.pdf) { book.totalPages = reader.pdf.numPages; persist(book); }
  } catch (err) {
    console.error(err);
    toast('Erro ao abrir o PDF.');
    reader.close();
  }
}

addEventListener('popstate', () => { if (!$('reader').hidden) reader.close(); });
addEventListener('visibilitychange', () => {
  if (document.hidden) { if (state.reading) persist(state.reading); courses?.persist(); syncNow(); }
  else if (drive.connected && Date.now() - drive.lastSync > 60_000) syncNow();
});

/* ================= Google Drive ================= */
const driveDlg = $('driveDlg');
const driveBody = $('driveBody');
let scanResult = null;

function updateDriveButton() {
  const btn = $('driveBtn');
  btn.classList.toggle('on', drive.connected);
  btn.classList.toggle('warn', !drive.connected && drive.wasConnected);
  btn.classList.toggle('busy', state.syncing);
  const label = state.syncing ? 'Sincronizando…'
    : drive.connected ? 'Drive conectado'
    : drive.wasConnected ? 'Reconectar Drive' : 'Google Drive';
  $('driveLabel').textContent = label;
  btn.title = drive.connected && drive.lastSync ? `Sincronizado às ${new Date(drive.lastSync).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : label;
}

$('driveBtn').onclick = () => openDriveDialog();

function openDriveDialog() {
  scanResult = null;
  renderDriveDialog();
  if (!driveDlg.open) driveDlg.showModal();
  if (drive.connected && !drive.folder) suggestFolder();
}

async function connectDrive() {
  try {
    await drive.signIn();
    updateDriveButton();
    return true;
  } catch (err) {
    toast(`Não foi possível conectar: ${err.message}`);
    return false;
  }
}

function renderDriveDialog(extra = '') {
  const intro = `<div class="drive-intro"><span class="so-icon drive"><svg><use href="#i-drive"/></svg></span>
    <p>Conecte sua conta para <b>importar os PDFs da sua pasta de leitura</b> e <b>sincronizar progresso, status e prazos</b> entre PC e celular. O HubDrive só lê seus arquivos; nada é alterado no seu Drive.</p></div>`;

  if (!drive.clientId) {
    driveBody.innerHTML = `${intro}
      <h3 style="margin:4px 0 0;font-size:16px">Configuração única (5 minutos)</h3>
      <ol class="steps">
        <li>Acesse <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">console.cloud.google.com</a>, crie um projeto e clique em <b>Ativar</b> na “Google Drive API”.</li>
        <li>Em <b>APIs e serviços → Tela de consentimento OAuth</b>, escolha “Externo”, preencha o nome do app e adicione seu e-mail como <b>usuário de teste</b>.</li>
        <li>Em <b>Credenciais → Criar credenciais → ID do cliente OAuth</b>, tipo <b>Aplicativo da Web</b>. Em “Origens JavaScript autorizadas”, adicione <span class="code">${esc(location.origin)}</span>.</li>
        <li>Copie o <b>ID do cliente</b> (termina em <span class="code">.apps.googleusercontent.com</span>) e cole abaixo.</li>
      </ol>
      <label>ID do cliente OAuth<input id="drvClient" placeholder="123456789-abc.apps.googleusercontent.com" autocomplete="off"></label>
      <div class="drive-row"><button class="btn primary" id="drvSaveClient">Salvar e conectar</button></div>
      <p class="note">Esse ID não é secreto: ele só identifica o seu app para o Google. Para não precisar colar em cada aparelho, coloque-o em <span class="code">js/config.js</span>.</p>`;
    $('drvSaveClient').onclick = async () => {
      const v = $('drvClient').value.trim();
      if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('ID inválido: ele termina com .apps.googleusercontent.com'); return; }
      drive.clientId = v;
      if (await connectDrive()) { renderDriveDialog(); suggestFolder(); }
    };
    return;
  }

  if (!drive.connected) {
    driveBody.innerHTML = `${intro}
      <div class="drive-row"><button class="btn primary lg" id="drvSignIn"><svg><use href="#i-drive"/></svg> ${drive.wasConnected ? 'Reconectar com Google' : 'Entrar com Google'}</button></div>
      ${drive.wasConnected ? '<p class="note">Por segurança, o Google pede para reconectar de tempos em tempos.</p>' : ''}
      ${drive.clientIdFromConfig ? '' : '<button class="linkish" id="drvResetClient">Alterar ID do cliente</button>'}`;
    $('drvSignIn').onclick = async () => { if (await connectDrive()) { renderDriveDialog(); if (!drive.folder) suggestFolder(); else syncAll({ interactive: false }); } };
    $('drvResetClient')?.addEventListener('click', () => { drive.clientId = ''; renderDriveDialog(); });
    return;
  }

  const f = drive.folder;
  const driveCount = state.books.filter(b => b.source === 'drive').length;
  driveBody.innerHTML = `
    ${f ? `<div class="folder-current"><svg><use href="#i-folder"/></svg><div><strong>${esc(f.name)}</strong>
      <small>${plural(driveCount, 'livro importado', 'livros importados')}${drive.lastSync ? ` · sincronizado às ${new Date(drive.lastSync).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}</small></div>
      <button class="btn sm" id="drvChange">Trocar pasta</button></div>
      <div class="drive-row"><button class="btn primary" id="drvScan"><svg><use href="#i-sync"/></svg> Procurar livros novos</button></div>`
    : `<p style="margin:0">Qual pasta do Drive tem seus livros?</p>`}
    <div id="drvPicker" ${f ? 'hidden' : ''}>
      <div id="drvSuggest"></div>
      <label>Buscar pasta pelo nome<input id="drvSearch" placeholder="Ex.: Leitura, Livros…" autocomplete="off"></label>
      <div class="folder-results" id="drvResults" hidden></div>
    </div>
    <div id="drvScanArea">${extra}</div>
    <p class="note">✓ O progresso de leitura é sincronizado automaticamente em uma área privada do app no seu Drive (invisível nas suas pastas).</p>
    <div class="drive-row" style="justify-content:space-between"><button class="linkish" id="drvSyncNow">Sincronizar progresso agora</button><button class="btn sm danger-ghost" id="drvOut">Desconectar</button></div>`;

  $('drvChange')?.addEventListener('click', () => { $('drvPicker').hidden = false; $('drvSearch').focus(); });
  $('drvScan')?.addEventListener('click', () => syncAll({ interactive: true }));
  $('drvSyncNow').onclick = () => syncNow(true);
  $('drvOut').onclick = () => {
    if (!confirm('Desconectar o Google Drive? Os livros e o progresso continuam neste aparelho.')) return;
    drive.signOut();
    updateDriveButton();
    renderDriveDialog();
  };
  let t;
  $('drvSearch').addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const box = $('drvResults');
      try {
        const folders = await drive.findFolders(e.target.value);
        box.hidden = false;
        box.innerHTML = folders.length ? folders.map(x => `<button data-fid="${x.id}" data-fname="${esc(x.name)}"><svg><use href="#i-folder"/></svg>${esc(x.name)}</button>`).join('') : '<p class="note" style="padding:12px">Nenhuma pasta encontrada.</p>';
      } catch (err) { handleDriveError(err); }
    }, 300);
  });
  driveBody.querySelector('#drvPicker').addEventListener('click', e => {
    const b = e.target.closest('[data-fid]');
    if (b) chooseFolder({ id: b.dataset.fid, name: b.dataset.fname });
  });
}

async function suggestFolder() {
  try {
    const guess = await drive.guessFolder();
    const box = $('drvSuggest');
    if (!box) return;
    box.innerHTML = guess
      ? `<p class="note" style="margin-bottom:6px">Encontramos esta pasta:</p><div class="folder-results"><button data-fid="${guess.id}" data-fname="${esc(guess.name)}"><svg><use href="#i-folder"/></svg><b>${esc(guess.name)}</b> <span class="muted">— usar esta</span></button></div>`
      : '';
  } catch (err) { handleDriveError(err); }
}

function chooseFolder(f) {
  drive.folder = f;
  drive.excluded = [];
  renderDriveDialog();
  syncAll({ interactive: true });
}

function handleDriveError(err) {
  console.error(err);
  if (err instanceof DriveAuthError) { updateDriveButton(); if (driveDlg.open) renderDriveDialog(); toast('Sessão do Google expirada.', { label: 'Reconectar', run: () => connectDrive().then(ok => ok && driveDlg.open && renderDriveDialog()) }); }
  else toast(`Google Drive: ${err.message}`);
}

const isReadFolder = name => /^#?\s*(lidos?|conclu[ií]dos?|finalizados?|read)$/i.test(name.trim());

/** Varre a pasta do Drive e importa livros novos (perguntando quais subpastas, se interativo). */
async function syncAll({ interactive }) {
  const folder = drive.folder;
  if (!folder || !drive.connected || state.syncing) return;
  state.syncing = true;
  updateDriveButton();
  const area = () => $('drvScanArea');
  try {
    if (interactive && area()) area().innerHTML = '<p class="note">Procurando PDFs na pasta e subpastas…</p>';
    const pdfs = await drive.scan(folder.id, p => { if (interactive && area()) area().innerHTML = `<p class="note">Procurando PDFs… ${p.folders} pastas, ${p.pdfs} PDFs encontrados</p>`; });
    // Agrupa por subpasta de 1º nível
    const groups = new Map();
    for (const f of pdfs) {
      const key = f.path[0] || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    if (interactive && driveDlg.open) {
      scanResult = { pdfs, groups };
      renderScanChoices();
    } else {
      await importDrivePdfs(pdfs.filter(f => !drive.excluded.includes(f.path[0] || '')), false);
    }
    await syncNow();
  } catch (err) {
    handleDriveError(err);
  } finally {
    state.syncing = false;
    updateDriveButton();
  }
}

function renderScanChoices() {
  const { groups, pdfs } = scanResult;
  const known = new Set(state.books.map(b => b.id));
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'pt-BR')));
  const excluded = drive.excluded;
  const newCount = pdfs.filter(f => !known.has('drive:' + f.id)).length;
  $('drvScanArea').innerHTML = pdfs.length ? `
    <p style="margin:0"><b>${plural(pdfs.length, 'PDF encontrado', 'PDFs encontrados')}</b>${newCount < pdfs.length ? ` (${newCount} novos)` : ''}. Escolha o que entra na estante:</p>
    <div class="sub-list">${keys.map(k => {
      const items = groups.get(k);
      const nNew = items.filter(f => !known.has('drive:' + f.id)).length;
      const label = k || 'Livros soltos na pasta';
      return `<label><input type="checkbox" class="check" data-group="${esc(k)}" ${excluded.includes(k) ? '' : 'checked'}>
        <span>${esc(label)}${isReadFolder(k) ? ' <small>(entram como Concluídos)</small>' : ''}</span><small>${items.length}${nNew && nNew < items.length ? ` · ${nNew} novos` : ''}</small></label>`;
    }).join('')}</div>
    <p class="note">Subpastas viram <b>coleções</b> na estante. Os PDFs só são baixados quando você abre cada livro.</p>
    <div class="drive-row"><button class="btn primary" id="drvImport">Importar selecionados</button></div>`
    : '<p class="note">Nenhum PDF encontrado nesta pasta.</p>';
  $('drvImport')?.addEventListener('click', async () => {
    const boxes = [...document.querySelectorAll('#drvScanArea [data-group]')];
    drive.excluded = boxes.filter(b => !b.checked).map(b => b.dataset.group);
    const chosen = scanResult.pdfs.filter(f => !drive.excluded.includes(f.path[0] || ''));
    $('drvImport').disabled = true;
    const n = await importDrivePdfs(chosen, true);
    driveDlg.close();
    toast(n ? `${plural(n, 'livro importado', 'livros importados')} do Google Drive.` : 'Sua estante já está em dia com o Drive.');
  });
}

async function importDrivePdfs(pdfs, interactive) {
  let added = 0;
  const fresh = [];
  for (const f of pdfs) {
    const id = 'drive:' + f.id;
    if (state.tombstones[id]) continue;
    const existing = bookById(id);
    if (existing) {
      if (existing.fileSize !== f.size && f.size) { existing.fileSize = f.size; await persist(existing, { sync: false }); }
      if (!existing.cover && f.thumbnailLink) fresh.push([existing, f]);
      continue;
    }
    const segs = f.path.filter(s => !isReadFolder(s));
    const book = normalize({
      id, source: 'drive', driveId: f.id,
      title: cleanTitle(f.name), fileName: f.name, fileSize: f.size,
      collection: segs[0] || '',
      status: f.path.some(isReadFolder) ? 'done' : 'queue',
      createdAt: Date.now() - added,
    });
    if (book.status === 'done') book.finishedAt = '';
    await persist(book, { sync: false });
    fresh.push([book, f]);
    added++;
  }
  render();
  // Capas (miniaturas do Drive) em paralelo, sem travar a tela.
  const t = interactive && fresh.length > 8 ? toast('Carregando capas…', null, 0) : null;
  let i = 0;
  const worker = async () => {
    while (i < fresh.length) {
      const [book, f] = fresh[i++];
      const cover = await drive.thumbnail(f.thumbnailLink);
      if (cover) { const live = bookById(book.id); if (live) { live.cover = cover; await db.putBook(live); } }
      if (i % 8 === 0) render();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  t?.remove();
  render();
  if (!interactive && added) toast(`${plural(added, 'livro novo', 'livros novos')} da sua pasta do Drive.`);
  if (added) scheduleSync();
  return added;
}

/* ---------- Sincronização do progresso ---------- */
let syncTimer;
function scheduleSync() {
  if (!drive.connected) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), 8000);
}

let syncRunning = null;
async function syncNow(verbose = false) {
  clearTimeout(syncTimer);
  if (!drive.connected) { if (verbose) toast('Conecte o Google Drive primeiro.'); return; }
  if (syncRunning) return syncRunning;
  syncRunning = (async () => {
    try {
      if (state.reading) await persist(state.reading, { sync: false });
      let remote = null;
      try { remote = await drive.readSync(); } catch (err) { if (err instanceof DriveAuthError) throw err; }
      const changed = remote ? await mergeRemote(remote) : 0;
      await drive.writeSync({
        app: 'hubdrive', version: 1, updatedAt: Date.now(),
        books: state.books.map(({ cover, zoom, ...b }) => b), // capas ficam só no aparelho
        courses: courses?.export() || [],
        tombstones: state.tombstones, settings: { goal: state.goal, goalAt: +load('hb-goal-at', '0') },
      });
      drive.lastSync = Date.now();
      if (changed && !state.reading && !courses?.isOpen()) render();
      if (verbose) toast(changed ? `Sincronizado: ${plural(changed, 'livro atualizado', 'livros atualizados')} de outro aparelho.` : 'Tudo sincronizado ✓');
    } catch (err) {
      if (err instanceof DriveAuthError) updateDriveButton();
      else if (verbose) toast(`Falha ao sincronizar: ${err.message}`);
      console.warn('sync', err);
    } finally {
      syncRunning = null;
      updateDriveButton();
      if (driveDlg.open && !scanResult) renderDriveDialog();
    }
  })();
  return syncRunning;
}

/* ================= Início ================= */
const theme = load('hb-theme', '');
if (theme) document.documentElement.dataset.theme = theme;

/** Abre um PDF do Drive (material de aula) no leitor, criando o livro na estante se preciso. */
async function openDrivePdf(file, collection, lessonTitle) {
  if (!file) return;
  const id = 'drive:' + file.id;
  let book = bookById(id);
  if (!book) {
    book = normalize({ id, source: 'drive', driveId: file.id, title: /^(aula|material|slides?|resumo)$/i.test(cleanTitle(file.name)) && lessonTitle ? `${lessonTitle} (${cleanTitle(file.name).toLowerCase()})` : cleanTitle(file.name), fileName: file.name, fileSize: file.size || 0, collection: collection || '' });
    if (state.tombstones[id]) { delete state.tombstones[id]; await db.setMeta('tombstones', state.tombstones); }
    await persist(book);
  }
  openReader(book);
}

refresh().then(async () => {
  if (drive.connected) drive.shareTokenWithWorker();
  courses = await initCourses({
    toast, esc, plural, fmtDuration, dateKey, load, save, scheduleSync, connectDrive, openDriveDialog, openDrivePdf,
    query: () => state.query,
    driveError: err => handleDriveError(err),
    onChange: () => { renderStats(); renderTabs(); },
    deadlineText: (deadline, done) => deadlineInfo({ status: done ? 'done' : 'reading', deadline, totalPages: 0, currentPage: 0 }),
    tombstone: async id => { state.tombstones[id] = Date.now(); await db.setMeta('tombstones', state.tombstones); scheduleSync(); },
  });
  render();
  updateDriveButton();
  if (drive.connected) {
    if (drive.folder) syncAll({ interactive: false }); else syncNow();
  }
}).catch(err => {
  console.error(err);
  toast('Não foi possível acessar o armazenamento local do navegador.');
});

setInterval(() => { if ($('reader').hidden && !document.querySelector('dialog[open]')) { renderStats(); renderHeader(); updateDriveButton(); } }, 60_000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
