import { db } from './db.js';
import { inspectPdf, loadPdf, getOutline } from './pdf.js';
import { Reader } from './reader.js';

const $ = id => document.getElementById(id);

const STATUS = {
  reading: { label: 'Lendo', color: 'var(--st-reading)' },
  queue: { label: 'Quero ler', color: 'var(--st-queue)' },
  paused: { label: 'Pausado', color: 'var(--st-paused)' },
  done: { label: 'Concluído', color: 'var(--st-done)' },
  dropped: { label: 'Abandonado', color: 'var(--st-dropped)' },
};
const PRIORITY = { low: 'Baixa', medium: 'Média', high: 'Alta' };

const state = {
  books: [],
  files: new Set(),     // ids que têm PDF salvo neste aparelho
  filter: 'all',
  sort: load('hb-sort', 'recent'),
  view: load('hb-view', 'grid'),
  query: '',
  editing: null,        // livro aberto no diálogo de detalhes
  reading: null,        // livro aberto no leitor
};

function load(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch {} }

/* ================= Utilidades ================= */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysUntil = s => Math.round((parseDate(s) - parseDate(dateKey())) / 86400000);
const fmtDate = s => parseDate(s).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
const initials = t => (t || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function progress(b) {
  if (b.status === 'done') return 100;
  if (!b.totalPages) return 0;
  return Math.min(100, Math.round((b.currentPage / b.totalPages) * 100));
}

/** Situação do prazo: texto, classe visual e ritmo necessário. */
function deadlineInfo(b) {
  if (b.status === 'done') {
    return { text: b.finishedAt ? `Concluído em ${fmtDate(b.finishedAt)}` : 'Concluído', cls: 'ok', late: false };
  }
  if (!b.deadline) return { text: 'Sem prazo', cls: '', late: false };
  const d = daysUntil(b.deadline);
  const remaining = Math.max(0, (b.totalPages || 0) - (b.currentPage || 0));
  const perDay = d >= 0 && remaining ? Math.ceil(remaining / (d + 1)) : 0;
  const pace = perDay ? `${plural(perDay, 'página', 'páginas')}/dia para terminar` : '';
  if (b.status === 'dropped') return { text: `Prazo ${fmtDate(b.deadline)}`, cls: '', late: false };
  if (d < 0) return { text: `Atrasado ${plural(-d, 'dia', 'dias')}`, cls: 'late', late: true, pace: `${plural(remaining, 'página', 'páginas')} restantes` };
  if (d === 0) return { text: 'Vence hoje', cls: 'soon', late: false, pace };
  if (d <= 3) return { text: `${plural(d, 'dia', 'dias')} restantes`, cls: 'soon', late: false, pace };
  return { text: `${plural(d, 'dia', 'dias')} restantes`, cls: '', late: false, pace };
}

function toast(msg, action, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
    ms = Math.max(ms, 7000);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

/* ================= Dados ================= */
async function refresh() {
  const [books, ids] = await Promise.all([db.allBooks(), db.fileIds()]);
  state.books = books.map(normalize);
  state.files = new Set(ids);
  render();
}

function normalize(b) {
  return {
    author: '', status: 'queue', priority: 'medium', startDate: '', deadline: '', finishedAt: '',
    notes: '', checklist: [], bookmarks: [], log: {}, currentPage: 1, totalPages: 0, cover: '',
    createdAt: Date.now(), updatedAt: Date.now(), lastReadAt: 0, ...b,
  };
}

async function persist(book) {
  book.updatedAt = Date.now();
  await db.putBook(book);
  const i = state.books.findIndex(b => b.id === book.id);
  if (i >= 0) state.books[i] = book; else state.books.push(book);
  if (state.reading?.id === book.id) state.reading = book;
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

/* ================= Adicionar PDFs ================= */
async function addFiles(files) {
  const pdfs = [...files].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) { toast('Selecione arquivos PDF.'); return; }
  let ok = 0;
  for (const [i, file] of pdfs.entries()) {
    const t = toast(`Importando ${i + 1}/${pdfs.length}: ${file.name}`, null, 60000);
    try {
      const data = await file.arrayBuffer();
      const info = await inspectPdf(data);
      const fallbackTitle = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
      const looksBad = !info.title || /^(untitled|microsoft word|documento?\d*)/i.test(info.title) || /\.(docx?|indd|tex)$/i.test(info.title);
      const book = normalize({
        id: uid(),
        title: looksBad ? fallbackTitle : info.title,
        author: info.author,
        fileName: file.name,
        fileSize: file.size,
        totalPages: info.pages,
        cover: info.cover,
      });
      await db.putFile(book.id, data);
      state.files.add(book.id);
      await persist(book);
      ok++;
    } catch (err) {
      console.error(err);
      toast(`Não foi possível ler "${file.name}". O arquivo pode estar corrompido ou protegido.`);
    } finally {
      t.remove();
    }
  }
  if (ok) {
    navigator.storage?.persist?.();
    toast(ok === 1 ? 'Livro adicionado à estante.' : `${ok} livros adicionados à estante.`);
  }
  render();
}

/* ================= Renderização da biblioteca ================= */
function visibleBooks() {
  const q = state.query.trim().toLowerCase();
  let list = state.books.filter(b => {
    if (q && !`${b.title} ${b.author}`.toLowerCase().includes(q)) return false;
    if (state.filter === 'all') return true;
    if (state.filter === 'late') return deadlineInfo(b).late;
    return b.status === state.filter;
  });
  const statusOrder = { reading: 0, paused: 1, queue: 2, done: 3, dropped: 4 };
  const cmp = {
    recent: (a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || statusOrder[a.status] - statusOrder[b.status] || b.createdAt - a.createdAt,
    deadline: (a, b) => {
      const da = a.deadline && a.status !== 'done' ? daysUntil(a.deadline) : Infinity;
      const dbb = b.deadline && b.status !== 'done' ? daysUntil(b.deadline) : Infinity;
      return da - dbb || statusOrder[a.status] - statusOrder[b.status];
    },
    progress: (a, b) => progress(b) - progress(a),
    title: (a, b) => a.title.localeCompare(b.title, 'pt-BR'),
    added: (a, b) => b.createdAt - a.createdAt,
  }[state.sort];
  return list.sort(cmp);
}

function render() {
  renderStats();
  const lib = $('library');
  const empty = state.books.length === 0;
  $('empty').hidden = !empty;
  document.querySelector('.controls').hidden = empty;
  if (empty) { lib.innerHTML = ''; return; }

  // contadores nos filtros
  document.querySelectorAll('#filters .chip').forEach(ch => {
    const f = ch.dataset.filter;
    const n = f === 'all' ? state.books.length
      : f === 'late' ? state.books.filter(b => deadlineInfo(b).late).length
      : state.books.filter(b => b.status === f).length;
    ch.innerHTML = `${ch.dataset.label || (ch.dataset.label = ch.textContent)}<span class="n">${n}</span>`;
    ch.classList.toggle('active', f === state.filter);
  });
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('sort').value = state.sort;

  const list = visibleBooks();
  if (!list.length) { lib.innerHTML = '<p class="no-results">Nenhum livro encontrado com esses filtros.</p>'; return; }
  lib.innerHTML = state.view === 'grid' ? gridHtml(list) : listHtml(list);
}

function coverHtml(b, cls = '') {
  return b.cover ? `<img src="${b.cover}" alt="" loading="lazy" class="${cls}">` : `<div class="ph ${cls}">${esc(initials(b.title))}</div>`;
}

function gridHtml(list) {
  return `<div class="grid">${list.map(b => {
    const p = progress(b), st = STATUS[b.status], dl = deadlineInfo(b), hasFile = state.files.has(b.id);
    return `<article class="card" data-id="${b.id}">
      <button class="cover" data-action="read" aria-label="Ler ${esc(b.title)}">
        ${coverHtml(b)}
        <span class="pct">${p}%</span>
        ${b.priority === 'high' && b.status !== 'done' ? '<span class="prio">Prioridade</span>' : ''}
        ${hasFile ? '' : '<span class="nofile">PDF não está neste aparelho</span>'}
      </button>
      <div class="card-body">
        <h3 title="${esc(b.title)}">${esc(b.title)}</h3>
        ${b.author ? `<p class="author">${esc(b.author)}</p>` : ''}
        <div class="tags">
          <span class="pill" style="--c:${st.color}">${st.label}</span>
          ${dl.text !== 'Sem prazo' ? `<span class="due ${dl.cls}" title="${esc(dl.pace || '')}">${esc(dl.text)}</span>` : ''}
        </div>
        <div class="progress ${b.status === 'done' ? 'done' : ''}"><span style="width:${p}%"></span></div>
        <div class="meta"><span>Pág. ${b.status === 'done' ? b.totalPages : b.currentPage} de ${b.totalPages || '?'}</span>${checkSummary(b)}</div>
        <div class="card-actions">
          <button class="btn primary" data-action="read">${b.currentPage > 1 && b.status !== 'done' ? 'Continuar' : 'Ler'}</button>
          <button class="btn ghosty" data-action="details">Detalhes</button>
        </div>
      </div>
    </article>`;
  }).join('')}</div>`;
}

function checkSummary(b) {
  if (!b.checklist.length) return '';
  const done = b.checklist.filter(c => c.done).length;
  return `<span title="Checklist">☑ ${done}/${b.checklist.length}</span>`;
}

function listHtml(list) {
  const rows = list.map(b => {
    const p = progress(b), st = STATUS[b.status], dl = deadlineInfo(b);
    return `<div class="row ${b.status === 'done' ? 'is-done' : ''}" data-id="${b.id}">
      <div class="r-chk"><input type="checkbox" class="check" data-action="toggle-done" ${b.status === 'done' ? 'checked' : ''} aria-label="Marcar como concluído"></div>
      <div class="r-title" data-action="details">
        ${b.cover ? `<img src="${b.cover}" alt="" loading="lazy">` : '<span class="mini-ph"></span>'}
        <div><strong>${esc(b.title)}</strong><small>${esc(b.author || PRIORITY[b.priority] + ' prioridade')}</small></div>
      </div>
      <div class="r-status"><select data-action="status" style="--c:${st.color}" aria-label="Status">
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select></div>
      <div class="r-prog">
        <div class="progress ${b.status === 'done' ? 'done' : ''}"><span style="width:${p}%"></span></div>
        <span>${p}% · pág. ${b.status === 'done' ? b.totalPages : b.currentPage}/${b.totalPages || '?'} ${b.checklist.length ? `· ☑ ${b.checklist.filter(c => c.done).length}/${b.checklist.length}` : ''}</span>
      </div>
      <div class="r-due"><input type="date" data-action="deadline" value="${b.deadline}" aria-label="Prazo"></div>
      <div class="r-sit"><span class="due ${dl.cls}">${esc(dl.text)}</span>${dl.pace ? `<small>${esc(dl.pace)}</small>` : ''}</div>
      <div class="r-act"><button class="btn sm primary" data-action="read">Ler</button></div>
    </div>`;
  }).join('');
  return `<div class="list">
    <div class="list-head"><span></span><span>Livro</span><span>Status</span><span>Progresso</span><span>Prazo</span><span>Situação</span><span></span></div>
    ${rows}
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

  // páginas por dia (soma dos registros de todos os livros)
  const perDay = {};
  for (const book of b) for (const [k, v] of Object.entries(book.log || {})) perDay[k] = (perDay[k] || 0) + v;
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const max = Math.max(1, ...days.map(d => perDay[dateKey(d)] || 0));
  const wd = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
  $('weekBars').innerHTML = days.map(d => {
    const v = perDay[dateKey(d)] || 0;
    return `<div class="bar" title="${d.toLocaleDateString('pt-BR')}: ${plural(v, 'página', 'páginas')}"><i class="${v ? '' : 'zero'}" style="height:${Math.round((v / max) * 38) + 3}px"></i><span>${wd[d.getDay()]}</span></div>`;
  }).join('');

  // sequência de dias lendo (conta hoje se já leu; senão, a partir de ontem)
  let streak = 0;
  const d = new Date();
  if (!perDay[dateKey(d)]) d.setDate(d.getDate() - 1);
  while (perDay[dateKey(d)]) { streak++; d.setDate(d.getDate() - 1); }
  $('stStreak').textContent = `🔥 ${plural(streak, 'dia', 'dias')}`;
}

/* ================= Eventos da biblioteca ================= */
function bookFromEvent(e) {
  const el = e.target.closest('[data-id]');
  return el && state.books.find(b => b.id === el.dataset.id);
}

$('library').addEventListener('click', e => {
  const act = e.target.closest('[data-action]')?.dataset.action;
  const book = bookFromEvent(e);
  if (!book || !act) return;
  if (act === 'read') openReader(book);
  else if (act === 'details') openDetails(book);
});

$('library').addEventListener('change', async e => {
  const act = e.target.dataset.action;
  const book = bookFromEvent(e);
  if (!book) return;
  if (act === 'toggle-done') {
    const prev = book.status;
    setStatus(book, e.target.checked ? 'done' : (book.currentPage > 1 ? 'reading' : 'queue'));
    await persist(book);
    render();
    if (book.status === 'done') toast(`"${book.title}" concluído! 🎉`, { label: 'Desfazer', run: async () => { setStatus(book, prev); await persist(book); render(); } });
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

$('filters').addEventListener('click', e => {
  const f = e.target.closest('.chip')?.dataset.filter;
  if (f) { state.filter = f; render(); }
});
document.querySelector('.seg').addEventListener('click', e => {
  const v = e.target.closest('.seg-btn')?.dataset.view;
  if (v) { state.view = v; save('hb-view', v); render(); }
});
$('sort').addEventListener('change', e => { state.sort = e.target.value; save('hb-sort', state.sort); render(); });
$('search').addEventListener('input', e => { state.query = e.target.value; render(); });

$('addBtn').onclick = () => $('fileInput').click();
document.querySelector('[data-action="add"]').onclick = () => $('fileInput').click();
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

// Menu
$('menuBtn').onclick = e => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; };
addEventListener('click', () => { $('menu').hidden = true; });
$('menu').addEventListener('click', async e => {
  const m = e.target.dataset.menu;
  if (m === 'export') exportBackup();
  else if (m === 'import') $('importInput').click();
  else if (m === 'theme') toggleTheme();
  else if (m === 'storage') showStorage();
});
$('importInput').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });

function toggleTheme() {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  save('hb-theme', next);
}

async function showStorage() {
  const est = await navigator.storage?.estimate?.();
  if (!est) { toast('Seu navegador não informa o uso de armazenamento.'); return; }
  const mb = n => (n / 1048576).toFixed(n > 1073741824 ? 0 : 1).replace('.', ',') + ' MB';
  const persisted = await navigator.storage.persisted?.();
  toast(`Usando ${mb(est.usage)} de ${mb(est.quota)} disponíveis.${persisted ? ' Armazenamento protegido ✓' : ''}`, null, 6000);
}

function exportBackup() {
  const data = { app: 'hubbooks', version: 1, exportedAt: new Date().toISOString(), books: state.books };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hubbooks-backup-${dateKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Backup exportado (progresso, status, prazos, checklists e notas). Os PDFs não são incluídos.', null, 6000);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'hubbooks' || !Array.isArray(data.books)) throw new Error('formato');
    let n = 0;
    for (const raw of data.books) {
      if (!raw.id || !raw.title) continue;
      const existing = state.books.find(b => b.id === raw.id);
      // Mantém a versão mais recente de cada livro.
      if (existing && existing.updatedAt > (raw.updatedAt || 0)) continue;
      await db.putBook(normalize(raw));
      n++;
    }
    await refresh();
    const missing = state.books.filter(b => !state.files.has(b.id)).length;
    toast(`${plural(n, 'livro importado', 'livros importados')}.${missing ? ` ${missing} sem PDF neste aparelho: abra "Detalhes" para anexar.` : ''}`, null, 7000);
  } catch {
    toast('Arquivo de backup inválido.');
  }
}

/* ================= Detalhes ================= */
const dlg = $('details');
const form = $('detailsForm');

function openDetails(book) {
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
  $('dCover').innerHTML = b.cover ? `<img src="${b.cover}" alt="">` : esc(initials(b.title));
  $('dRelink').hidden = state.files.has(b.id);
  $('dRead').hidden = !state.files.has(b.id);
  renderChecklist();
  renderBookmarks();
  renderPlan();
  dlg.showModal();
  dlg.querySelector('.dlg-body').scrollTop = 0;
}

function renderPlan() {
  const b = { ...state.editing, status: form.status.value, deadline: form.deadline.value, currentPage: +form.currentPage.value || 1 };
  const dl = deadlineInfo(b);
  const p = progress(b);
  const parts = [`<strong>${p}%</strong> lido · ${plural(b.totalPages || 0, 'página', 'páginas')} no total`];
  if (b.deadline && b.status !== 'done') parts.push(`${dl.text}${dl.pace ? ` — <strong>${esc(dl.pace)}</strong>` : ''}`);
  if (b.lastReadAt) parts.push(`última leitura em ${new Date(b.lastReadAt).toLocaleDateString('pt-BR')}`);
  $('dPlan').innerHTML = parts.join(' · ');
}
['status', 'deadline', 'currentPage'].forEach(n => form[n].addEventListener('input', renderPlan));

const trashSvg = '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>';

function renderChecklist() {
  const list = state.editing.checklist;
  const done = list.filter(c => c.done).length;
  $('dCheckCount').textContent = list.length ? `(${done}/${list.length})` : '';
  $('dChecklist').innerHTML = list.map(c => `
    <li class="${c.done ? 'done' : ''}" data-cid="${c.id}">
      <input type="checkbox" ${c.done ? 'checked' : ''} aria-label="Concluir item">
      <span>${esc(c.text)}</span>
      ${c.page ? `<button type="button" class="go" data-go="${c.page}">pág. ${c.page}</button>` : ''}
      <button type="button" class="icon-btn" data-del aria-label="Remover item">${trashSvg}</button>
    </li>`).join('') || '<li class="muted" style="border:0">Nenhum item ainda. Crie metas como capítulos, resumos ou exercícios.</li>';
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
  if (!data) { toast('Anexe o PDF primeiro.'); return; }
  try {
    const pdf = await loadPdf(data);
    const items = await getOutline(pdf, 1);
    pdf.destroy();
    if (!items.length) { toast('Este PDF não possui sumário (marcadores internos).'); return; }
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
    : '<span class="empty-bm">Use o ícone de marcador no leitor para salvar páginas.</span>';
}
$('dBookmarks').addEventListener('click', e => {
  if (e.target.dataset.rm) {
    state.editing.bookmarks = state.editing.bookmarks.filter(p => p !== +e.target.dataset.rm);
    renderBookmarks();
  } else if (e.target.dataset.go) {
    goFromDetails(+e.target.dataset.go);
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
  const cp = Math.round(+form.currentPage.value) || 1;
  b.currentPage = Math.max(1, b.totalPages ? Math.min(cp, b.totalPages) : cp);
  setStatus(b, form.status.value);
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
    if (state.reading) $('rdTitle').textContent = state.reading.title; // aberto de dentro do leitor
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
  if (!confirm(`Excluir "${b.title}" da estante? O PDF e todo o progresso salvo neste aparelho serão apagados.`)) return;
  await db.deleteBook(b.id);
  await db.deleteFile(b.id);
  state.books = state.books.filter(x => x.id !== b.id);
  state.files.delete(b.id);
  dlg.close();
  if (state.reading?.id === b.id) { state.reading = null; reader.close(); }
  render();
  toast('Livro excluído.');
};

$('dRelinkBtn').onclick = () => $('dRelinkInput').click();
$('dRelinkInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = await file.arrayBuffer();
    const info = await inspectPdf(data);
    const b = state.editing;
    if (b.totalPages && info.pages !== b.totalPages &&
        !confirm(`Este PDF tem ${info.pages} páginas, mas o livro salvo tinha ${b.totalPages}. Anexar mesmo assim?`)) return;
    await db.putFile(b.id, data);
    state.files.add(b.id);
    b.totalPages = info.pages;
    b.fileName = file.name;
    b.fileSize = file.size;
    if (!b.cover) b.cover = info.cover;
    $('dRelink').hidden = true;
    $('dRead').hidden = false;
    $('dCover').innerHTML = b.cover ? `<img src="${b.cover}" alt="">` : esc(initials(b.title));
    await saveDetails();
    toast('PDF anexado.');
  } catch {
    toast('Não foi possível ler este PDF.');
  }
});

/* ================= Leitor ================= */
let saveTimer;
const reader = new Reader({
  onPageChange(page, prev, source) {
    const b = state.reading;
    if (!b) return;
    b.currentPage = page;
    b.lastReadAt = Date.now();
    // Conta como lidas as páginas avançadas rolando/teclado (saltos grandes não contam).
    if ((source === 'scroll' || source === 'key') && page > prev && page - prev <= 3) {
      const k = dateKey();
      b.log[k] = (b.log[k] || 0) + (page - prev);
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
    saveTimer = setTimeout(() => persist(b), 600);
  },
  async onClose(_book, zoom) {
    clearTimeout(saveTimer);
    const b = state.reading;
    state.reading = null;
    if (location.hash === '#ler') history.back();
    if (b) { b.zoom = zoom; await persist(b); }
    render();
  },
  async onBookmark(page) {
    const b = state.reading;
    if (!b) return;
    const on = !b.bookmarks.includes(page);
    b.bookmarks = on ? [...b.bookmarks, page] : b.bookmarks.filter(p => p !== page);
    reader.setBookmarked(on);
    await persist(b);
    toast(on ? `Página ${page} marcada.` : `Marcador da página ${page} removido.`);
  },
  onInfo() {
    const b = state.reading;
    if (b) { clearTimeout(saveTimer); persist(b).then(() => openDetails(b)); }
  },
});

async function openReader(book, page) {
  const data = await db.getFile(book.id);
  if (!data) {
    toast('O PDF deste livro não está neste aparelho. Anexe o arquivo nos detalhes.');
    openDetails(book);
    return;
  }
  state.reading = book;
  book.lastReadAt = Date.now();
  history.pushState({ reader: book.id }, '', '#ler');
  reader.setBookmarked(book.bookmarks.includes(page || book.currentPage));
  try {
    await reader.open(book, data, page || book.currentPage);
  } catch (err) {
    console.error(err);
    toast('Erro ao abrir o PDF.');
    reader.close();
  }
}

// Botão "voltar" do celular fecha o leitor em vez de sair do app.
addEventListener('popstate', () => { if (!$('reader').hidden) reader.close(); });
// Salva ao sair/ocultar a aba.
addEventListener('visibilitychange', () => { if (document.hidden && state.reading) persist(state.reading); });

/* ================= Início ================= */
const theme = load('hb-theme', '');
if (theme) document.documentElement.dataset.theme = theme;

refresh().catch(err => {
  console.error(err);
  toast('Não foi possível acessar o armazenamento local do navegador.');
});

// Atualiza "dias restantes" quando o dia muda com o app aberto.
setInterval(() => { if ($('reader').hidden && !dlg.open) renderStats(); }, 60_000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
