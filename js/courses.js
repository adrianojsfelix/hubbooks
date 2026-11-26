// Aba "Cursos": cursos em pastas do Google Drive, com player de vídeo, checklist de aulas,
// progresso por módulo, anotações por aula e mapas mentais (imagens de uma pasta do Drive).
import { db } from './db.js';
import { drive, DriveAuthError } from './drive.js';

const $ = id => document.getElementById(id);
const FOLDER = 'application/vnd.google-apps.folder';
const SPEEDS = ['0.75', '1', '1.25', '1.5', '1.75', '2'];
const STOP = new Set('de da do das dos e a o as os em no na nos nas para por com sem um uma aula aulas parte mapa mapas mental mentais modulo inss resumo the of'.split(' '));

let ctx;                       // utilidades vindas do app.js
const state = {
  courses: [],
  open: null,                  // curso aberto
  lesson: null,                // aula atual
  expanded: new Set(),
  mapThumbs: new Map(),        // `${id}@${size}` -> url
  liveMaps: new Map(),         // id -> arquivo com thumbnailLink atual
  query: '',
  cpTab: 'lesson',
};

/* ================= utilidades ================= */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const natural = (a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });
const stripNum = s => String(s || '').replace(/^\s*\d{1,4}\s*[.)_-]+\s*/, '').trim();
const numOf = s => (String(s || '').match(/^\s*(\d{1,4})\s*[.)_ -]/) || [])[1] || '';
const baseName = n => String(n || '').replace(/\.[a-z0-9]{2,4}$/i, '');
const pretty = s => stripNum(baseName(s)).replace(/_/g, ' ').replace(/\s+-\s*|\s*-\s+/g, ' – ').replace(/(\d)-(?=\p{L})/gu, '$1 – ').replace(/\s{2,}/g, ' ').trim() || baseName(s);
const isGeneric = n => { const b = norm(baseName(n)).trim(); return b.length <= 4 || /^(aula|video|videoaula|video aula|parte ?\d*|\d+|aula ?\d+)$/.test(b); };
const tokens = s => new Set(norm(baseName(s)).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
const fmtTime = sec => { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };

function courseStats(c) {
  const total = c.lessons.length;
  const done = c.lessons.filter(l => c.done[l.id]).length;
  const remainingSec = c.lessons.filter(l => !c.done[l.id] && l.duration).reduce((a, l) => a + l.duration - Math.min(l.duration, c.positions[l.id] || 0), 0);
  const totalSec = c.lessons.reduce((a, l) => a + (l.duration || 0), 0);
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0, remainingSec, totalSec };
}

function modulesOf(c) {
  const map = new Map();
  for (const l of c.lessons) {
    if (!map.has(l.module)) map.set(l.module, []);
    map.get(l.module).push(l);
  }
  return [...map.entries()].map(([name, lessons]) => ({ name, lessons }));
}

function normalizeCourse(c) {
  return {
    lessons: [], done: {}, positions: {}, notes: {}, timeLog: {}, watchedSeconds: 0, mapLinks: {}, maps: [],
    mapsFolder: null, excluded: [], deadline: '', current: '', cover: '', createdAt: Date.now(), updatedAt: Date.now(), lastWatchedAt: 0,
    ...c,
  };
}

async function save(c, { sync = true } = {}) {
  c.updatedAt = Date.now();
  await db.putCourse(c);
  const i = state.courses.findIndex(x => x.id === c.id);
  if (i >= 0) state.courses[i] = c; else state.courses.push(c);
  if (state.open?.id === c.id) state.open = c;
  if (sync) ctx.scheduleSync();
}

/* ================= varredura do Drive ================= */
/** Transforma os arquivos da pasta do curso em aulas ordenadas. */
function buildLessons(files) {
  const videos = files.filter(f => f.mimeType?.startsWith('video/'));
  const pdfs = files.filter(f => f.mimeType === 'application/pdf');
  const withVideo = new Set(videos.map(v => v.parentId));
  const pdfsByFolder = new Map();
  for (const p of pdfs) { if (!pdfsByFolder.has(p.parentId)) pdfsByFolder.set(p.parentId, []); pdfsByFolder.get(p.parentId).push({ id: p.id, name: p.name, size: p.size }); }
  const lessons = [];
  const make = (f, kind) => {
    const generic = isGeneric(f.name) && f.path.length > 0;
    const title = generic ? f.path[f.path.length - 1] : baseName(f.name);
    const group = generic ? f.path.slice(0, -1) : f.path;
    return {
      id: f.id, kind, fileId: f.id, title, module: group[0] || 'Aulas', section: group.slice(1).join(' › '),
      folderId: f.parentId, size: f.size || 0, mime: f.mimeType,
      duration: f.videoMediaMetadata?.durationMillis ? Math.round(f.videoMediaMetadata.durationMillis / 1000) : 0,
      thumb: '', sortKey: [...f.path, f.name].join('/'),
      materials: kind === 'video' ? (pdfsByFolder.get(f.parentId) || []) : [{ id: f.id, name: f.name, size: f.size }],
    };
  };
  for (const v of videos) lessons.push(make(v, 'video'));
  for (const p of pdfs) if (!withVideo.has(p.parentId)) lessons.push(make(p, 'doc'));
  lessons.sort((a, b) => natural(a.sortKey, b.sortKey));
  return lessons;
}

async function scanCourse(c, onProgress) {
  const excluded = new Set(c.excluded || []);
  const files = await drive.scanTree(c.rootId, {
    skip: p => p.length === 1 && excluded.has(p[0]),
    accept: f => f.mimeType?.startsWith('video/') || f.mimeType === 'application/pdf',
    onProgress,
  });
  const lessons = buildLessons(files);
  // Mantém progresso de aulas que continuam existindo
  const ids = new Set(lessons.map(l => l.id));
  for (const k of Object.keys(c.done)) if (!ids.has(k)) delete c.done[k];
  c.lessons = lessons;
  if (!c.cover) {
    const firstVid = files.find(f => f.mimeType?.startsWith('video/') && f.thumbnailLink);
    if (firstVid) c.cover = await drive.thumbnail(firstVid.thumbnailLink).catch(() => '');
  }
  return c;
}

async function scanMaps(c) {
  if (!c.mapsFolder) return;
  const imgs = await drive.scanTree(c.mapsFolder.id, { accept: f => f.mimeType?.startsWith('image/') });
  imgs.sort((a, b) => natural(a.name, b.name));
  for (const f of imgs) state.liveMaps.set(f.id, f);
  c.maps = imgs.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, path: f.path.join(' › ') }));
}

/* ================= mapas ↔ aulas ================= */
function mapLinks(c) {
  // Para cada mapa: aula vinculada manualmente ou melhor correspondência pelo nome.
  const lessonTok = c.lessons.map(l => ({ l, t: tokens(`${l.title} ${l.section}`) }));
  const out = new Map();
  for (const m of c.maps) {
    if (m.id in c.mapLinks) { if (c.mapLinks[m.id]) out.set(m.id, c.mapLinks[m.id]); continue; }
    const mt = tokens(m.name);
    if (mt.size < 2) continue;
    let best = null, bestScore = 0;
    for (const { l, t } of lessonTok) {
      let inter = 0;
      for (const w of mt) if (t.has(w)) inter++;
      const score = inter / mt.size;
      if (inter >= 2 && score > bestScore) { best = l; bestScore = score; }
    }
    if (best && bestScore >= 0.6) out.set(m.id, best.id);
  }
  return out;
}

function mapsForLesson(c, lessonId) {
  const links = mapLinks(c);
  return c.maps.filter(m => links.get(m.id) === lessonId);
}

async function thumbUrl(map, size) {
  const key = `${map.id}@${size}`;
  if (state.mapThumbs.has(key)) return state.mapThumbs.get(key);
  const live = state.liveMaps.get(map.id) || map;
  const p = drive.imageUrl(live, size).catch(() => drive.cookieThumb(map.id, size));
  state.mapThumbs.set(key, p);
  return p;
}

/* ================= aba Cursos ================= */
function renderList() {
  const grid = $('courseGrid');
  const list = [...state.courses].sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0) || natural(a.title, b.title));
  const q = norm(ctx.query());
  const shown = q ? list.filter(c => norm(c.title).includes(q)) : list;
  $('coursesEmpty').hidden = list.length > 0;
  document.querySelector('.courses-head').hidden = list.length === 0;
  $('tabCoursesN').textContent = list.length || '';

  const last = list.find(c => c.lastWatchedAt && c.current);
  const hero = $('courseHero');
  if (last) {
    const l = last.lessons.find(x => x.id === last.current);
    const st = courseStats(last);
    hero.hidden = !l;
    if (l) {
      const pos = last.positions[l.id] || 0;
      hero.innerHTML = `
        <div class="ch-thumb" style="${last.cover ? `background-image:url(${last.cover})` : ''}"><button data-course="${last.id}" data-resume aria-label="Continuar"><svg><use href="#i-play"/></svg></button></div>
        <div class="ch-body">
          <div class="hero-kicker">Continue assistindo · ${ctx.esc(last.title)}</div>
          <h2>${ctx.esc(pretty(l.title))}</h2>
          <p class="ch-crumb">${ctx.esc(pretty(l.module))}${l.section ? ' › ' + ctx.esc(l.section.split(' › ').map(pretty).join(' › ')) : ''}</p>
          ${l.duration ? `<div class="progress"><span style="width:${Math.min(100, (pos / l.duration) * 100)}%"></span></div><p class="ch-meta">${fmtTime(pos)} de ${fmtTime(l.duration)}</p>` : ''}
          <div class="hero-actions"><button class="btn primary" data-course="${last.id}" data-resume><svg><use href="#i-play"/></svg>Continuar aula</button>
          <span class="ch-stat">${st.done}/${st.total} aulas · ${st.pct}%</span></div>
        </div>`;
    }
  } else hero.hidden = true;

  grid.innerHTML = shown.map(c => {
    const st = courseStats(c);
    const cur = c.lessons.find(x => x.id === c.current);
    const dl = c.deadline ? ctx.deadlineText(c.deadline, st.done >= st.total) : null;
    return `<article class="course-card" data-course="${c.id}">
      <div class="cc-cover" style="${c.cover ? `background-image:url(${c.cover})` : ''}">${c.cover ? '' : '<svg><use href="#i-cap"/></svg>'}<span class="badge pct">${st.pct}%</span></div>
      <div class="cc-body">
        <h3>${ctx.esc(c.title)}</h3>
        <p class="muted">${st.done} de ${ctx.plural(st.total, 'aula', 'aulas')}${st.remainingSec ? ` · ≈ ${ctx.fmtDuration(st.remainingSec)} restantes` : ''}</p>
        <div class="progress ${st.pct === 100 ? 'done' : ''}"><span style="width:${st.pct}%"></span></div>
        ${cur ? `<p class="cc-next">▶ ${ctx.esc(pretty(cur.title))}</p>` : ''}
        <div class="tags">${dl ? `<span class="due ${dl.cls}">${ctx.esc(dl.text)}</span>` : ''}${c.maps.length ? `<span class="due">🧠 ${c.maps.length} mapas</span>` : ''}</div>
        <div class="cc-actions"><button class="btn primary sm" data-resume>${cur ? 'Continuar' : 'Começar'}</button><button class="btn sm" data-settings>Configurar</button></div>
      </div>
    </article>`;
  }).join('') + (list.length ? `<button class="course-card add" data-action="add-course"><svg><use href="#i-plus"/></svg><span>Adicionar curso</span></button>` : '');
}

/* ================= página do curso ================= */
async function openCourse(c, lessonId) {
  state.open = c;
  $('coursePage').hidden = false;
  document.body.style.overflow = 'hidden';
  history.pushState({ course: c.id }, '', '#curso');
  $('cpTitle').textContent = c.title;
  const start = c.lessons.find(l => l.id === (lessonId || c.current)) || c.lessons.find(l => !c.done[l.id]) || c.lessons[0];
  if (start) state.expanded = new Set([start.module]);
  renderSide();
  if (start) playLesson(start, { autoplay: false });
  else { $('lessonTitle').textContent = 'Nenhuma aula encontrada nesta pasta.'; }
  updateHeader();
  if (c.mapsFolder && drive.connected) scanMaps(c).then(() => { save(c, { sync: false }); renderSide(); renderPanels(); }).catch(() => {});
}

function closeCourse() {
  if ($('coursePage').hidden) return;
  persistPosition(true);
  const v = $('video');
  v.pause(); v.removeAttribute('src'); v.load();
  $('videoFrame').src = 'about:blank';
  $('coursePage').hidden = true;
  document.body.style.overflow = '';
  if (location.hash === '#curso') history.back();
  state.open = null; state.lesson = null;
  renderList();
  ctx.onChange();
}

function updateHeader() {
  const c = state.open;
  if (!c) return;
  const st = courseStats(c);
  $('cpProgFill').style.width = st.pct + '%';
  $('cpProgText').textContent = `${st.done}/${st.total} · ${st.pct}%`;
  $('cpSub').textContent = `${st.done} de ${ctx.plural(st.total, 'aula assistida', 'aulas assistidas')}${st.remainingSec ? ` · ≈ ${ctx.fmtDuration(st.remainingSec)} restantes` : ''}`;
}

function renderSide() {
  const c = state.open;
  if (!c) return;
  const q = norm(state.query);
  const hide = $('hideDone').checked;
  const links = mapLinks(c);
  const mapCount = new Map();
  for (const lid of links.values()) mapCount.set(lid, (mapCount.get(lid) || 0) + 1);
  const html = modulesOf(c).map(m => {
    const done = m.lessons.filter(l => c.done[l.id]).length;
    let items = m.lessons;
    if (q) items = items.filter(l => norm(`${l.title} ${l.section} ${m.name}`).includes(q));
    if (hide) items = items.filter(l => !c.done[l.id] || l.id === state.lesson?.id);
    if ((q || hide) && !items.length) return '';
    const open = q || state.expanded.has(m.name);
    let lastSection = null;
    const rows = items.map(l => {
      let head = '';
      if (l.section !== lastSection) { lastSection = l.section; if (l.section) head = `<div class="sec">${ctx.esc(l.section.split(' › ').map(pretty).join(' › '))}</div>`; }
      const pos = c.positions[l.id] || 0;
      const partial = !c.done[l.id] && l.duration && pos > 5 ? Math.round((pos / l.duration) * 100) : 0;
      return `${head}<div class="lesson ${c.done[l.id] ? 'is-done' : ''} ${state.lesson?.id === l.id ? 'current' : ''}" data-lesson="${l.id}">
        <input type="checkbox" class="check" data-toggle ${c.done[l.id] ? 'checked' : ''} aria-label="Marcar como assistida">
        <button class="l-main" data-play>
          <span class="l-title">${l.kind === 'doc' ? '📄 ' : ''}${ctx.esc(pretty(l.title))}</span>
          <span class="l-meta">${l.duration ? fmtTime(l.duration) : l.kind === 'doc' ? 'PDF' : ''}${partial ? ` · ${partial}% visto` : ''}${l.materials.length && l.kind === 'video' ? ' · 📎' : ''}${mapCount.get(l.id) ? ` · 🧠 ${mapCount.get(l.id)}` : ''}</span>
        </button>
      </div>`;
    }).join('');
    const pct = Math.round((done / m.lessons.length) * 100);
    return `<section class="module ${open ? 'open' : ''}" data-module="${ctx.esc(m.name)}">
      <button class="m-head" data-expand>
        <span class="m-num">${numOf(m.name) || '•'}</span>
        <span class="m-name">${ctx.esc(stripNum(m.name) || m.name)}<small>${done}/${m.lessons.length} aulas</small></span>
        <span class="m-ring" style="--p:${pct}" title="${pct}%">${pct === 100 ? '✓' : ''}</span>
      </button>
      <div class="m-body">${rows}
        <div class="m-actions"><button class="linkish" data-module-all>${done === m.lessons.length ? 'Desmarcar módulo' : 'Marcar módulo inteiro como assistido'}</button></div>
      </div>
    </section>`;
  }).join('');
  $('modules').innerHTML = html || '<p class="note" style="padding:16px">Nenhuma aula encontrada.</p>';
  // Rola só a lista (nunca a página inteira, para não esconder o vídeo no celular).
  const box = $('modules'), cur = box.querySelector('.lesson.current');
  if (cur && !q && box.scrollHeight > box.clientHeight + 4) {
    const top = cur.offsetTop, bottom = top + cur.offsetHeight;
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) box.scrollTop = top - box.clientHeight / 3;
  }
}

function playLesson(l, { autoplay = true } = {}) {
  const c = state.open;
  if (!c) return;
  persistPosition(true);
  state.lesson = l;
  c.current = l.id;
  c.lastWatchedAt = Date.now();
  state.expanded.add(l.module);
  save(c, { sync: false });
  $('nextOverlay').hidden = true;
  clearInterval(nextTimer);

  const v = $('video'), frame = $('videoFrame'), msg = $('playerMsg');
  msg.hidden = true;
  frame.hidden = true;
  frame.src = 'about:blank';
  if (l.kind === 'video') {
    v.hidden = false;
    if (!drive.connected) {
      v.removeAttribute('src'); v.load();
      showPlayerMsg('Conecte o Google Drive para assistir.', [['Conectar Google Drive', () => ctx.connectDrive().then(ok => ok && playLesson(l, { autoplay }))]]);
    } else if (navigator.serviceWorker?.controller) {
      drive.shareTokenWithWorker();
      v.src = drive.mediaUrl(l.fileId, l.size);
      v.playbackRate = +ctx.load('hb-speed', '1');
      v.dataset.lesson = l.id;
      const pos = c.positions[l.id] || 0;
      v.onloadedmetadata = () => {
        if (!l.duration && v.duration && isFinite(v.duration)) { l.duration = Math.round(v.duration); save(c, { sync: false }); }
        if (pos > 3 && pos < (v.duration || Infinity) - 10) v.currentTime = pos;
        if (autoplay) v.play().catch(() => {});
      };
    } else {
      useDrivePlayer(l);
    }
  } else {
    v.hidden = true;
    v.removeAttribute('src'); v.load();
    showPlayerMsg(`📄 ${pretty(l.materials[0]?.name || l.title)}`, [
      ['Ler no HubDrive', () => ctx.openDrivePdf(l.materials[0], c.title, pretty(l.title))],
      ['Abrir no Drive', () => window.open(drive.viewUrl(l.fileId), '_blank', 'noopener')],
    ], true);
  }

  $('lessonCrumbs').innerHTML = `<span>${ctx.esc(stripNum(l.module) || l.module)}</span>${l.section ? `<span>${ctx.esc(l.section.split(' › ').map(pretty).join(' › '))}</span>` : ''}`;
  $('lessonTitle').textContent = pretty(l.title);
  const idx = c.lessons.indexOf(l);
  $('lessonPrev').disabled = idx <= 0;
  $('lessonNext').disabled = idx >= c.lessons.length - 1;
  renderDoneBtn();
  $('lessonNotes').value = c.notes[l.id] || '';
  renderSide();
  renderPanels();
  updateHeader();
  ctx.scheduleSync();
}

function useDrivePlayer(l) {
  const v = $('video'), frame = $('videoFrame');
  v.pause(); v.removeAttribute('src'); v.load(); v.hidden = true;
  frame.hidden = false;
  frame.src = drive.previewUrl(l.fileId);
  $('playerMsg').hidden = true;
}

function showPlayerMsg(text, actions, keepVideoHidden) {
  const msg = $('playerMsg');
  msg.hidden = false;
  if (keepVideoHidden) $('video').hidden = true;
  msg.innerHTML = `<p>${ctx.esc(text)}</p><div class="drive-row">${actions.map((a, i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-i="${i}">${ctx.esc(a[0])}</button>`).join('')}</div>`;
  msg.querySelectorAll('button').forEach(b => { b.onclick = () => actions[+b.dataset.i][1](); });
}

function renderDoneBtn() {
  const c = state.open, l = state.lesson;
  const done = !!(c && l && c.done[l.id]);
  const b = $('lessonDone');
  b.classList.toggle('is-done', done);
  b.querySelector('span').textContent = done ? 'Assistida' : 'Marcar como assistida';
}

async function setDone(lessonIds, value) {
  const c = state.open;
  for (const id of lessonIds) { if (value) c.done[id] = Date.now(); else delete c.done[id]; }
  if (value && c.done) {
    const today = ctx.dateKey();
    c.lessonLog ||= {};
    c.lessonLog[today] = (c.lessonLog[today] || 0) + lessonIds.length;
  }
  await save(c);
  renderSide(); renderDoneBtn(); updateHeader();
}

/* ---------- painéis: materiais, mapas, anotações ---------- */
function renderPanels() {
  const c = state.open, l = state.lesson;
  if (!c || !l) return;
  // Materiais
  const mats = l.materials || [];
  $('panelLesson').innerHTML = `
    ${mats.length ? `<div class="mat-list">${mats.map(m => `<div class="mat"><svg><use href="#i-file"/></svg><span>${ctx.esc(pretty(m.name) === 'Aula' ? 'Material da aula (PDF)' : pretty(m.name))}</span>
      <button class="btn sm primary" data-read="${m.id}">Ler no HubDrive</button><a class="btn sm" href="${drive.viewUrl(m.id)}" target="_blank" rel="noopener">Drive</a></div>`).join('')}</div>`
      : '<p class="note">Esta aula não tem PDF de apoio.</p>'}
    <div class="drive-row">
      <a class="linkish" href="${drive.folderUrl(l.folderId)}" target="_blank" rel="noopener">Abrir pasta da aula no Drive</a>
      ${l.kind === 'video' ? `<button class="linkish" data-gplayer>Problemas com o vídeo? Usar o player do Google Drive</button>` : ''}
      <button class="linkish" data-upto>Marcar todas as aulas até esta como assistidas</button>
    </div>`;
  // Mapas
  const mine = mapsForLesson(c, l.id);
  $('mapsN').textContent = mine.length || '';
  if (!c.mapsFolder) {
    $('panelMaps').innerHTML = `<div class="maps-cta"><p>Escolha a pasta do Drive onde você guarda seus <b>mapas mentais</b> (imagens). O HubDrive mostra o mapa de cada aula automaticamente pelo nome — e você pode vincular manualmente.</p>
      <button class="btn primary" data-pick-maps>Escolher pasta de mapas</button></div>`;
  } else {
    const links = mapLinks(c);
    const lessonName = id => { const x = c.lessons.find(y => y.id === id); return x ? pretty(x.title) : ''; };
    const others = c.maps.filter(m => links.get(m.id) !== l.id);
    const card = (m, isMine) => `<figure class="map ${isMine ? 'mine' : ''}" data-map="${m.id}">
        <button class="map-img" data-view><img alt="" data-thumb="${m.id}"></button>
        <figcaption><span title="${ctx.esc(m.name)}">${ctx.esc(baseName(m.name))}</span>
          <small>${links.get(m.id) ? (isMine ? 'nesta aula' : '↳ ' + ctx.esc(lessonName(links.get(m.id)))) : 'sem aula'}</small>
          <button class="linkish" data-link="${isMine ? 'off' : 'on'}">${isMine ? 'Desvincular' : 'Vincular a esta aula'}</button>
        </figcaption></figure>`;
    $('panelMaps').innerHTML = `
      <div class="maps-head"><span>📁 ${ctx.esc(c.mapsFolder.name)} · ${ctx.plural(c.maps.length, 'mapa', 'mapas')}</span>
        <span class="spacer"></span><button class="linkish" data-refresh-maps>Atualizar</button><button class="linkish" data-pick-maps>Trocar pasta</button></div>
      <h4>Desta aula</h4>
      ${mine.length ? `<div class="maps-grid">${mine.map(m => card(m, true)).join('')}</div>` : '<p class="note">Nenhum mapa vinculado a esta aula ainda. Vincule um abaixo ou crie e salve na pasta.</p>'}
      ${others.length ? `<h4>Todos os mapas</h4><label class="search sm"><svg><use href="#i-search"/></svg><input type="search" id="mapSearch" placeholder="Buscar mapa"></label>
      <div class="maps-grid" id="allMaps">${others.map(m => card(m, false)).join('')}</div>` : ''}`;
    loadThumbs($('panelMaps'));
    $('mapSearch')?.addEventListener('input', e => {
      const q = norm(e.target.value);
      $('allMaps').querySelectorAll('.map').forEach(f => { f.hidden = q && !norm(f.querySelector('span').title).includes(q); });
    });
  }
  $('notesHint').textContent = c.notes[l.id] ? 'Salvo automaticamente.' : '';
}

const thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const img = en.target;
    thumbObserver.unobserve(img);
    const m = state.open?.maps.find(x => x.id === img.dataset.thumb);
    if (!m) continue;
    thumbUrl(m, 480).then(u => { img.src = u; }).catch(() => {});
  }
}, { rootMargin: '200px' }) : null;

function loadThumbs(root) {
  root.querySelectorAll('img[data-thumb]').forEach(img => thumbObserver ? thumbObserver.observe(img) : null);
}

/* ---------- lightbox ---------- */
let lbList = [], lbIndex = 0;
function openLightbox(list, index) {
  lbList = list; lbIndex = index;
  $('lightbox').hidden = false;
  showLb();
}
async function showLb() {
  const m = lbList[lbIndex];
  if (!m) return;
  const img = $('lbImg');
  $('lbTitle').textContent = baseName(m.name);
  $('lbOpen').href = drive.viewUrl(m.id);
  $('lbStage').classList.remove('zoom');
  img.removeAttribute('src');
  $('lbSpin').hidden = false;
  img.onload = () => { $('lbSpin').hidden = true; };
  img.onerror = () => { $('lbSpin').hidden = true; };
  try { img.src = await thumbUrl(m, 2400); } catch { $('lbSpin').hidden = true; }
  $('lbPrev').hidden = lbIndex <= 0;
  $('lbNext').hidden = lbIndex >= lbList.length - 1;
}

/* ---------- posição/tempo assistido ---------- */
let lastTick = 0, lastSave = 0;
function persistPosition(force) {
  const c = state.open, l = state.lesson, v = $('video');
  if (!c || !l || l.kind !== 'video' || v.dataset.lesson !== l.id || !v.currentTime) return;
  c.positions[l.id] = Math.floor(v.currentTime);
  if (force || Date.now() - lastSave > 10_000) { lastSave = Date.now(); save(c); }
}

let nextTimer;
function offerNext() {
  const c = state.open, l = state.lesson;
  const next = c.lessons[c.lessons.indexOf(l) + 1];
  if (!next) { ctx.toast('Você chegou ao fim do curso! 🎉'); return; }
  let n = 6;
  const ov = $('nextOverlay');
  ov.hidden = false;
  const draw = () => { ov.innerHTML = `<p>Próxima aula em ${n}s</p><strong>${ctx.esc(pretty(next.title))}</strong><div class="drive-row"><button class="btn primary" data-go>Assistir agora</button><button class="btn ghost" data-cancel>Cancelar</button></div>`; };
  draw();
  ov.querySelector('[data-go]').onclick = () => playLesson(next);
  ov.querySelector('[data-cancel]').onclick = () => { clearInterval(nextTimer); ov.hidden = true; };
  clearInterval(nextTimer);
  nextTimer = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(nextTimer); playLesson(next); return; }
    ov.querySelector('p').textContent = `Próxima aula em ${n}s`;
  }, 1000);
}

/* ================= diálogo adicionar/configurar ================= */
const dlg = () => $('courseDlg');

async function openAddDialog() {
  $('courseDlgTitle').textContent = 'Adicionar curso';
  const body = $('courseDlgBody');
  if (!dlg().open) dlg().showModal();
  if (!drive.connected) {
    body.innerHTML = `<p>Os cursos vêm das pastas do seu Google Drive. Conecte sua conta para continuar.</p>
      <div class="drive-row"><button class="btn primary" id="crsConnect"><svg><use href="#i-drive"/></svg> Conectar Google Drive</button></div>`;
    $('crsConnect').onclick = async () => {
      if (!drive.clientId) { dlg().close(); ctx.openDriveDialog(); return; }
      if (await ctx.connectDrive()) openAddDialog();
    };
    return;
  }
  body.innerHTML = `
    <label>Link da pasta do curso no Drive<input id="crsLink" placeholder="https://drive.google.com/drive/folders/…" autocomplete="off"></label>
    <div class="drive-row"><button class="btn primary" id="crsGo">Continuar</button></div>
    <p class="note">Dica: no Drive, clique com o botão direito na pasta do curso → <b>Compartilhar → Copiar link</b>. Ou busque pelo nome:</p>
    <label class="search sm"><svg><use href="#i-search"/></svg><input id="crsSearch" type="search" placeholder="Nome da pasta (ex.: INSS)"></label>
    <div class="folder-results" id="crsResults" hidden></div>`;
  $('crsGo').onclick = () => {
    const id = drive.parseId($('crsLink').value);
    if (!id) { ctx.toast('Cole o link de uma pasta do Google Drive.'); return; }
    pickModules({ id });
  };
  $('crsLink').addEventListener('keydown', e => { if (e.key === 'Enter') $('crsGo').click(); });
  let t;
  $('crsSearch').addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const res = await drive.findFolders(e.target.value);
        const box = $('crsResults');
        box.hidden = false;
        box.innerHTML = res.length ? res.map(f => `<button data-fid="${f.id}"><svg><use href="#i-folder"/></svg>${ctx.esc(f.name)}</button>`).join('') : '<p class="note" style="padding:12px">Nenhuma pasta encontrada.</p>';
        box.onclick = ev => { const b = ev.target.closest('[data-fid]'); if (b) pickModules({ id: b.dataset.fid }); };
      } catch (err) { ctx.driveError(err); }
    }, 300);
  });
}

async function pickModules({ id }, existing) {
  const body = $('courseDlgBody');
  body.innerHTML = '<p class="note">Lendo a pasta…</p>';
  try {
    const [info, kids] = await Promise.all([drive.folderInfo(id), drive.children(id, 'id,name,mimeType')]);
    const mods = kids.filter(k => k.mimeType === FOLDER).sort((a, b) => natural(a.name, b.name));
    const looseVideos = kids.filter(k => k.mimeType?.startsWith('video/')).length;
    const excluded = new Set(existing?.excluded || []);
    body.innerHTML = `
      <label>Nome do curso<input id="crsTitle" value="${ctx.esc(existing?.title || stripNum(info.name) || info.name)}"></label>
      ${mods.length ? `<div class="sub-head"><b>Módulos</b> <span class="muted">(${mods.length})</span><span class="spacer"></span><button class="linkish" id="crsAll">Marcar/desmarcar todos</button></div>
      <div class="sub-list">${mods.map(m => `<label><input type="checkbox" class="check" data-mod="${ctx.esc(m.name)}" ${excluded.has(m.name) ? '' : 'checked'}><span>${ctx.esc(m.name)}</span></label>`).join('')}</div>
      <p class="note">Desmarque módulos que não são aulas (ex.: suporte, agenda) para deixar a lista mais limpa. Pastas grandes podem levar alguns segundos.</p>` : `<p class="note">${looseVideos ? `${looseVideos} vídeos encontrados.` : 'Vamos procurar vídeos e PDFs nesta pasta.'}</p>`}
      <label>Prazo para terminar (opcional)<input type="date" id="crsDeadline" value="${existing?.deadline || ''}"></label>
      <div class="drive-row"><button class="btn primary" id="crsCreate">${existing ? 'Salvar e atualizar aulas' : 'Criar curso'}</button><span class="note" id="crsStatus"></span></div>`;
    $('crsAll')?.addEventListener('click', () => {
      const boxes = [...body.querySelectorAll('[data-mod]')];
      const all = boxes.every(b => b.checked);
      boxes.forEach(b => { b.checked = !all; });
    });
    $('crsCreate').onclick = async () => {
      const btn = $('crsCreate');
      btn.disabled = true;
      const c = existing || normalizeCourse({ id: 'course:' + id, rootId: id });
      c.title = $('crsTitle').value.trim() || info.name;
      c.deadline = $('crsDeadline').value;
      c.excluded = [...body.querySelectorAll('[data-mod]')].filter(b => !b.checked).map(b => b.dataset.mod);
      try {
        await scanCourse(c, p => { $('crsStatus').textContent = `Procurando aulas… ${p.folders} pastas lidas, ${p.files} arquivos`; });
        if (!c.lessons.length) { $('crsStatus').textContent = 'Nenhum vídeo ou PDF encontrado nos módulos escolhidos.'; btn.disabled = false; return; }
        await save(c);
        dlg().close();
        renderList();
        ctx.onChange();
        ctx.toast(`${c.title}: ${ctx.plural(c.lessons.length, 'aula', 'aulas')} prontas.`);
        if (!existing) openCourse(c);
        else if (state.open?.id === c.id) { renderSide(); updateHeader(); }
      } catch (err) {
        btn.disabled = false;
        $('crsStatus').textContent = '';
        ctx.driveError(err);
      }
    };
  } catch (err) {
    ctx.driveError(err);
    body.innerHTML = '<p class="err">Não foi possível abrir essa pasta. Verifique o link e se sua conta tem acesso a ela.</p>';
  }
}

function openSettings(c) {
  $('courseDlgTitle').textContent = 'Configurar curso';
  if (!dlg().open) dlg().showModal();
  const st = courseStats(c);
  $('courseDlgBody').innerHTML = `
    <div class="folder-current"><svg><use href="#i-cap"/></svg><div><strong>${ctx.esc(c.title)}</strong><small>${st.done}/${st.total} aulas · ${ctx.fmtDuration(st.totalSec)} de vídeo</small></div>
      <a class="btn sm" href="${drive.folderUrl(c.rootId)}" target="_blank" rel="noopener">Abrir no Drive</a></div>
    <div class="drive-row">
      <button class="btn" id="crsRescan"><svg><use href="#i-sync"/></svg> Módulos e atualizar aulas</button>
      <button class="btn" id="crsMaps"><svg><use href="#i-brain"/></svg> ${c.mapsFolder ? 'Trocar pasta de mapas' : 'Pasta de mapas mentais'}</button>
    </div>
    ${c.mapsFolder ? `<p class="note">Mapas mentais: <b>${ctx.esc(c.mapsFolder.name)}</b> (${c.maps.length})</p>` : ''}
    <label>Prazo para terminar<input type="date" id="crsDl" value="${c.deadline || ''}"></label>
    <div class="drive-row" style="justify-content:space-between">
      <button class="btn danger-ghost" id="crsRemove">Remover curso</button>
      <button class="btn primary" id="crsSave">Salvar</button>
    </div>`;
  $('crsRescan').onclick = () => drive.connected ? pickModules({ id: c.rootId }, c) : ctx.connectDrive().then(ok => ok && pickModules({ id: c.rootId }, c));
  $('crsMaps').onclick = () => pickMapsFolder(c);
  $('crsSave').onclick = async () => { c.deadline = $('crsDl').value; await save(c); dlg().close(); renderList(); };
  $('crsRemove').onclick = async () => {
    if (!confirm(`Remover o curso "${c.title}"? O progresso salvo será perdido (os arquivos continuam no Drive).`)) return;
    await db.deleteCourse(c.id);
    state.courses = state.courses.filter(x => x.id !== c.id);
    ctx.tombstone(c.id);
    dlg().close();
    if (state.open?.id === c.id) closeCourse();
    renderList();
    ctx.onChange();
  };
}

function pickMapsFolder(c) {
  $('courseDlgTitle').textContent = 'Pasta de mapas mentais';
  if (!dlg().open) dlg().showModal();
  const body = $('courseDlgBody');
  body.innerHTML = `
    <p class="note">Escolha a pasta (no seu Drive) onde ficam as imagens dos mapas mentais deste curso. Subpastas também são lidas.</p>
    <label>Link da pasta<input id="mpLink" placeholder="https://drive.google.com/drive/folders/…"></label>
    <label class="search sm"><svg><use href="#i-search"/></svg><input id="mpSearch" type="search" placeholder="ou busque pelo nome (ex.: SEGURIDADE SOCIAL)"></label>
    <div class="folder-results" id="mpResults" hidden></div>
    <div class="drive-row"><button class="btn primary" id="mpUse">Usar link</button><span class="note" id="mpStatus"></span></div>`;
  const choose = async (id, name) => {
    $('mpStatus').textContent = 'Lendo imagens…';
    try {
      if (!name) name = (await drive.folderInfo(id)).name;
      c.mapsFolder = { id, name };
      c.mapLinks = {};
      await scanMaps(c);
      await save(c);
      dlg().close();
      ctx.toast(`${ctx.plural(c.maps.length, 'mapa mental encontrado', 'mapas mentais encontrados')}.`);
      if (state.open?.id === c.id) { state.cpTab = 'maps'; showCpTab('maps'); renderSide(); renderPanels(); }
      renderList();
    } catch (err) { ctx.driveError(err); $('mpStatus').textContent = ''; }
  };
  $('mpUse').onclick = () => { const id = drive.parseId($('mpLink').value); if (id) choose(id); else ctx.toast('Cole o link de uma pasta.'); };
  let t;
  $('mpSearch').addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const res = await drive.findFolders(e.target.value);
        const box = $('mpResults');
        box.hidden = false;
        box.innerHTML = res.length ? res.map(f => `<button data-fid="${f.id}" data-fname="${ctx.esc(f.name)}"><svg><use href="#i-folder"/></svg>${ctx.esc(f.name)}</button>`).join('') : '<p class="note" style="padding:12px">Nenhuma pasta encontrada.</p>';
        box.onclick = ev => { const b = ev.target.closest('[data-fid]'); if (b) choose(b.dataset.fid, b.dataset.fname); };
      } catch (err) { ctx.driveError(err); }
    }, 300);
  });
}

function showCpTab(name) {
  state.cpTab = name;
  document.querySelectorAll('.cp-tab').forEach(t => t.classList.toggle('active', t.dataset.cptab === name));
  $('panelLesson').hidden = name !== 'lesson';
  $('panelMaps').hidden = name !== 'maps';
  $('panelNotes').hidden = name !== 'notes';
}

/* ================= eventos ================= */
function bind() {
  $('addCourseBtn').onclick = openAddDialog;
  document.addEventListener('click', e => {
    if (e.target.closest('[data-action="add-course"]')) openAddDialog();
  });
  $('coursesView').addEventListener('click', e => {
    const card = e.target.closest('[data-course]');
    if (!card) return;
    const c = state.courses.find(x => x.id === card.dataset.course);
    if (!c) return;
    if (e.target.closest('[data-settings]')) openSettings(c);
    else openCourse(c);
  });

  $('cpBack').onclick = closeCourse;
  $('cpSettings').onclick = () => state.open && openSettings(state.open);
  $('cpToggleList').onclick = () => $('coursePage').classList.toggle('side-hidden');
  $('lessonSearch').addEventListener('input', e => { state.query = e.target.value; renderSide(); });
  $('hideDone').addEventListener('change', renderSide);

  $('modules').addEventListener('click', e => {
    const c = state.open;
    const mod = e.target.closest('.module');
    if (e.target.closest('[data-expand]')) {
      const name = mod.dataset.module;
      if (state.expanded.has(name)) state.expanded.delete(name); else state.expanded.add(name);
      mod.classList.toggle('open');
      return;
    }
    if (e.target.closest('[data-module-all]')) {
      const m = modulesOf(c).find(x => x.name === mod.dataset.module);
      const all = m.lessons.every(l => c.done[l.id]);
      setDone(m.lessons.map(l => l.id), !all);
      return;
    }
    const row = e.target.closest('[data-lesson]');
    if (!row) return;
    const l = c.lessons.find(x => x.id === row.dataset.lesson);
    if (e.target.matches('[data-toggle]')) setDone([l.id], e.target.checked);
    else if (e.target.closest('[data-play]')) { playLesson(l); if (innerWidth <= 900) $('cpMain').scrollTo({ top: 0, behavior: 'smooth' }); }
  });

  $('lessonDone').onclick = () => { const l = state.lesson; if (l) setDone([l.id], !state.open.done[l.id]); };
  $('lessonNext').onclick = () => { const c = state.open; const n = c.lessons[c.lessons.indexOf(state.lesson) + 1]; if (n) playLesson(n); };
  $('lessonPrev').onclick = () => { const c = state.open; const p = c.lessons[c.lessons.indexOf(state.lesson) - 1]; if (p) playLesson(p); };
  const speed = $('speed');
  speed.value = SPEEDS.includes(ctx.load('hb-speed', '1')) ? ctx.load('hb-speed', '1') : '1';
  speed.onchange = () => { $('video').playbackRate = +speed.value; ctx.save('hb-speed', speed.value); };

  document.querySelector('.cp-tabs').addEventListener('click', e => { const t = e.target.closest('.cp-tab'); if (t) showCpTab(t.dataset.cptab); });

  $('panelLesson').addEventListener('click', e => {
    const c = state.open, l = state.lesson;
    const r = e.target.closest('[data-read]');
    if (r) { const m = l.materials.find(x => x.id === r.dataset.read); ctx.openDrivePdf(m, c.title, pretty(l.title)); }
    if (e.target.closest('[data-gplayer]')) useDrivePlayer(l);
    if (e.target.closest('[data-upto]')) {
      const idx = c.lessons.indexOf(l);
      const ids = c.lessons.slice(0, idx + 1).filter(x => !c.done[x.id]).map(x => x.id);
      setDone(ids, true).then(() => ctx.toast(`${ctx.plural(ids.length, 'aula marcada', 'aulas marcadas')} como assistidas.`));
    }
  });

  $('panelMaps').addEventListener('click', async e => {
    const c = state.open, l = state.lesson;
    if (e.target.closest('[data-pick-maps]')) { pickMapsFolder(c); return; }
    if (e.target.closest('[data-refresh-maps]')) {
      try { await scanMaps(c); state.mapThumbs.clear(); await save(c); renderPanels(); renderSide(); ctx.toast('Mapas atualizados.'); } catch (err) { ctx.driveError(err); }
      return;
    }
    const fig = e.target.closest('[data-map]');
    if (!fig) return;
    const id = fig.dataset.map;
    const link = e.target.closest('[data-link]');
    if (link) {
      c.mapLinks[id] = link.dataset.link === 'on' ? l.id : '';
      await save(c);
      renderPanels(); renderSide();
      return;
    }
    if (e.target.closest('[data-view]')) {
      const figs = [...$('panelMaps').querySelectorAll('[data-map]')].filter(f => !f.hidden);
      const list = figs.map(f => c.maps.find(m => m.id === f.dataset.map));
      openLightbox(list, figs.indexOf(fig));
    }
  });

  let notesT;
  $('lessonNotes').addEventListener('input', e => {
    const c = state.open, l = state.lesson;
    if (!c || !l) return;
    c.notes[l.id] = e.target.value;
    clearTimeout(notesT);
    notesT = setTimeout(() => { save(c); $('notesHint').textContent = 'Salvo automaticamente.'; }, 700);
  });

  const v = $('video');
  v.addEventListener('timeupdate', () => {
    const c = state.open, l = state.lesson;
    if (!c || !l || v.dataset.lesson !== l.id) return;
    const now = performance.now();
    if (!v.paused && lastTick) {
      const dt = Math.min(2, (now - lastTick) / 1000);
      const k = ctx.dateKey();
      c.timeLog[k] = (c.timeLog[k] || 0) + dt;
      c.watchedSeconds = (c.watchedSeconds || 0) + dt;
    }
    lastTick = now;
    if (v.duration && isFinite(v.duration) && v.currentTime / v.duration >= 0.9 && !c.done[l.id]) {
      setDone([l.id], true);
      ctx.toast('Aula concluída ✓');
    }
    persistPosition(false);
  });
  v.addEventListener('pause', () => { lastTick = 0; persistPosition(true); });
  v.addEventListener('ended', () => { lastTick = 0; const c = state.open; if (c && state.lesson) { c.positions[state.lesson.id] = 0; save(c); } offerNext(); });
  v.addEventListener('error', () => {
    const l = state.lesson;
    if (!l || !v.getAttribute('src')) return;
    const code = v.error?.code;
    showPlayerMsg(code === 4 ? 'Não foi possível tocar este vídeo aqui (formato não suportado ou sessão expirada).' : 'Falha ao carregar o vídeo.', [
      ['Usar player do Google Drive', () => useDrivePlayer(l)],
      ['Reconectar e tentar de novo', () => ctx.connectDrive().then(ok => ok && playLesson(l))],
      ['Abrir no Drive', () => window.open(drive.viewUrl(l.fileId), '_blank', 'noopener')],
    ]);
  });

  document.addEventListener('keydown', e => {
    if ($('coursePage').hidden || document.querySelector('dialog[open]') || !$('lightbox').hidden) return;
    if (e.target.matches('input, textarea, select')) return;
    const k = e.key;
    if (k === 'Escape' && !document.fullscreenElement) closeCourse();
    else if (k === ' ' && !$('video').hidden && e.target !== v) { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    else if (k === 'ArrowRight' && !$('video').hidden && e.target !== v) v.currentTime += 10;
    else if (k === 'ArrowLeft' && !$('video').hidden && e.target !== v) v.currentTime -= 10;
    else if (k === 'n' || k === 'N') $('lessonNext').click();
    else if (k === 'p' || k === 'P') $('lessonPrev').click();
    else if (k === 'm' || k === 'M') $('lessonDone').click();
  });

  // lightbox
  $('lbClose').onclick = () => { $('lightbox').hidden = true; };
  $('lbPrev').onclick = () => { if (lbIndex > 0) { lbIndex--; showLb(); } };
  $('lbNext').onclick = () => { if (lbIndex < lbList.length - 1) { lbIndex++; showLb(); } };
  $('lbZoom').onclick = () => $('lbStage').classList.toggle('zoom');
  $('lbImg').onclick = () => $('lbStage').classList.toggle('zoom');
  document.addEventListener('keydown', e => {
    if ($('lightbox').hidden) return;
    if (e.key === 'Escape') $('lightbox').hidden = true;
    else if (e.key === 'ArrowRight') $('lbNext').click();
    else if (e.key === 'ArrowLeft') $('lbPrev').click();
  });

  addEventListener('popstate', () => { if (!$('coursePage').hidden) closeCourse(); });
  addEventListener('visibilitychange', () => { if (document.hidden) persistPosition(true); });
}

/* ================= API para o app.js ================= */
export async function initCourses(context) {
  ctx = context;
  state.courses = (await db.allCourses()).map(normalizeCourse);
  bind();
  renderList();
  return {
    render: renderList,
    count: () => state.courses.length,
    isOpen: () => !$('coursePage').hidden,
    /** segundos de vídeo assistidos hoje (todos os cursos) */
    timeOn: day => state.courses.reduce((a, c) => a + (c.timeLog?.[day] || 0), 0),
    lessonsOn: day => state.courses.reduce((a, c) => a + (c.lessonLog?.[day] || 0), 0),
    export: () => state.courses.map(({ cover, ...c }) => c),
    async merge(list, tomb) {
      let changed = 0;
      for (const raw of list || []) {
        if (!raw?.id) continue;
        if (tomb[raw.id] && tomb[raw.id] >= (raw.updatedAt || 0)) continue;
        const local = state.courses.find(c => c.id === raw.id);
        if (local && (local.updatedAt || 0) >= (raw.updatedAt || 0)) {
          let ch = false;
          for (const key of ['timeLog', 'lessonLog']) for (const [d, v] of Object.entries(raw[key] || {})) {
            local[key] ||= {};
            if ((local[key][d] || 0) < v) { local[key][d] = v; ch = true; }
          }
          if (ch) { await db.putCourse(local); changed++; }
          continue;
        }
        if (state.open?.id === raw.id) continue; // não troca o curso aberto no meio da aula
        const merged = normalizeCourse({ ...raw, cover: local?.cover || '' });
        await db.putCourse(merged);
        const i = state.courses.findIndex(c => c.id === merged.id);
        if (i >= 0) state.courses[i] = merged; else state.courses.push(merged);
        changed++;
      }
      for (const [id, at] of Object.entries(tomb)) {
        const c = state.courses.find(x => x.id === id);
        if (c && at >= (c.updatedAt || 0) && state.open?.id !== id) {
          await db.deleteCourse(id);
          state.courses = state.courses.filter(x => x.id !== id);
          changed++;
        }
      }
      if (changed) renderList();
      return changed;
    },
    persist: () => persistPosition(true),
    // usado nos testes e pelo atalho de URL
    openById: id => { const c = state.courses.find(x => x.id === id); if (c) openCourse(c); },
  };
}

// Exportado para testes unitários
export const _test = { buildLessons, tokens, pretty, isGeneric };
