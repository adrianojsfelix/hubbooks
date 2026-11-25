// Leitor de PDF com rolagem contínua, renderização preguiçosa, zoom e gesto de pinça.
import { loadPdf } from './pdf.js';

const $ = id => document.getElementById(id);
const MAX_FIT_WIDTH = 920;   // largura máxima da página no "ajustar à largura" (px CSS)
const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
const KEEP_RENDERED = 6;     // páginas distantes têm o canvas liberado

export class Reader {
  constructor({ onPageChange, onClose, onBookmark, onInfo }) {
    this.cb = { onPageChange, onClose, onBookmark, onInfo };
    this.el = $('reader');
    this.scroller = $('rdScroller');
    this.pagesEl = $('rdPages');
    this.zoom = 1;
    this.page = 1;
    this.pdf = null;
    this.pageEls = [];
    this.sizes = [];
    this.tasks = new Map();
    this.night = localStorage.getItem('hb-night') === '1';
    this.bindUi();
  }

  bindUi() {
    $('rdBack').onclick = () => this.close();
    $('rdZoomIn').onclick = $('rdZoomInSm').onclick = () => this.setZoom(this.zoom * 1.2);
    $('rdZoomOut').onclick = $('rdZoomOutSm').onclick = () => this.setZoom(this.zoom / 1.2);
    $('rdZoomFit').onclick = () => this.setZoom(1);
    $('rdBookmark').onclick = () => this.cb.onBookmark(this.page);
    $('rdInfo').onclick = () => this.cb.onInfo();
    $('rdNight').onclick = () => {
      this.night = !this.night;
      try { localStorage.setItem('hb-night', this.night ? '1' : '0'); } catch {}
      this.applyNight();
    };

    const pageInput = $('rdPage');
    pageInput.addEventListener('change', () => this.goTo(+pageInput.value, 'jump'));
    pageInput.addEventListener('keydown', e => { if (e.key === 'Enter') pageInput.blur(); });
    const slider = $('rdSlider');
    slider.addEventListener('input', () => { $('rdPage').value = slider.value; this.updatePct(+slider.value); });
    slider.addEventListener('change', () => this.goTo(+slider.value, 'jump'));

    let ticking = false;
    this.scroller.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; this.trackPage(); });
    }, { passive: true });

    // Toque simples no centro alterna o modo imersivo (esconde barras) no celular.
    let tapStart = null;
    this.scroller.addEventListener('pointerdown', e => { tapStart = { x: e.clientX, y: e.clientY, t: Date.now() }; });
    this.scroller.addEventListener('pointerup', e => {
      if (!tapStart || e.pointerType === 'mouse') return;
      const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
      if (moved < 8 && Date.now() - tapStart.t < 300) this.el.classList.toggle('immersive');
      tapStart = null;
    });

    this.scroller.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    this.bindPinch();

    document.addEventListener('keydown', e => {
      if (this.el.hidden || document.querySelector('dialog[open]')) return;
      if (e.target.matches('input, textarea, select')) return;
      const k = e.key;
      if (k === 'Escape') this.close();
      else if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); this.goTo(this.page + 1, 'key'); }
      else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { e.preventDefault(); this.goTo(this.page - 1, 'key'); }
      else if (k === 'Home') { e.preventDefault(); this.goTo(1, 'jump'); }
      else if (k === 'End') { e.preventDefault(); this.goTo(this.pdf?.numPages || 1, 'jump'); }
      else if (k === '+' || k === '=') this.setZoom(this.zoom * 1.2);
      else if (k === '-') this.setZoom(this.zoom / 1.2);
      else if (k === '0') this.setZoom(1);
    });

    let resizeT;
    this.resizeObs = new ResizeObserver(() => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { if (this.pdf) this.relayout(); }, 150);
    });
    this.resizeObs.observe(this.scroller);
  }

  bindPinch() {
    let start = null;
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.scroller.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        start = { d: dist(e.touches), zoom: this.zoom, ratio: 1 };
        const r = this.scroller.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
        this.pagesEl.style.transformOrigin = `${cx + this.scroller.scrollLeft}px ${cy + this.scroller.scrollTop}px`;
      }
    }, { passive: true });
    this.scroller.addEventListener('touchmove', e => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, start.zoom * dist(e.touches) / start.d));
      start.ratio = target / start.zoom;
      this.pagesEl.style.transform = `scale(${start.ratio})`;
    }, { passive: false });
    const end = () => {
      if (!start) return;
      const z = start.zoom * start.ratio;
      start = null;
      this.pagesEl.style.transform = '';
      this.pagesEl.style.transformOrigin = '';
      this.setZoom(z);
    };
    this.scroller.addEventListener('touchend', e => { if (e.touches.length < 2) end(); });
    this.scroller.addEventListener('touchcancel', end);
  }

  applyNight() {
    this.el.classList.toggle('night', this.night);
    $('rdNight').classList.toggle('on', this.night);
  }

  async open(book, data, startPage) {
    this.book = book;
    this.el.hidden = false;
    this.el.classList.remove('immersive');
    document.body.style.overflow = 'hidden';
    $('rdTitle').textContent = book.title;
    $('rdLoading').hidden = false;
    this.applyNight();
    this.pagesEl.innerHTML = '';
    this.zoom = book.zoom || 1;
    try {
      this.pdf = await loadPdf(data);
    } catch (err) {
      $('rdLoading').textContent = 'Não foi possível abrir este PDF.';
      throw err;
    }
    if (this.book !== book) return; // fechado durante o carregamento
    const n = this.pdf.numPages;
    const first = (await this.pdf.getPage(1)).getViewport({ scale: 1 });
    this.sizes = Array.from({ length: n }, () => ({ w: first.width, h: first.height }));
    $('rdTotal').textContent = n;
    $('rdSlider').max = n;
    $('rdPage').max = n;
    this.buildPages();
    $('rdLoading').hidden = true;
    this.page = 0;
    this.goTo(Math.min(Math.max(1, startPage || 1), n), 'open', false);
    this.scroller.focus({ preventScroll: true });
  }

  close() {
    if (this.el.hidden) return;
    const book = this.book;
    this.el.hidden = true;
    document.body.style.overflow = '';
    this.observer?.disconnect();
    this.tasks.forEach(t => t.cancel());
    this.tasks.clear();
    this.pdf?.destroy();
    this.pdf = null;
    this.book = null;
    this.pagesEl.innerHTML = '';
    $('rdLoading').textContent = 'Abrindo livro…';
    this.cb.onClose(book, this.zoom);
  }

  get fitScale() {
    const avail = Math.min(this.scroller.clientWidth - (innerWidth <= 640 ? 8 : 24), MAX_FIT_WIDTH);
    return Math.max(0.1, avail / this.sizes[0].w);
  }

  get scale() { return this.fitScale * this.zoom; }

  buildPages() {
    this.observer?.disconnect();
    this.pagesEl.innerHTML = '';
    const scale = this.scale;
    this.pageEls = this.sizes.map((s, i) => {
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.page = i + 1;
      div.style.width = `${s.w * scale}px`;
      div.style.height = `${s.h * scale}px`;
      div.innerHTML = `<span class="pnum">${i + 1}</span>`;
      this.pagesEl.appendChild(div);
      return div;
    });
    this.observer = new IntersectionObserver(entries => {
      for (const en of entries) {
        const n = +en.target.dataset.page;
        if (en.isIntersecting) this.renderPage(n);
      }
      this.releaseFar();
    }, { root: this.scroller, rootMargin: '150% 0px' });
    this.pageEls.forEach(el => this.observer.observe(el));
    $('rdZoomFit').textContent = Math.round(this.zoom * 100) + '%';
  }

  relayout() {
    // Mantém a posição relativa dentro da página atual.
    const cur = this.pageEls[this.page - 1];
    const frac = cur ? (this.scroller.scrollTop - cur.offsetTop) / cur.offsetHeight : 0;
    const fracX = this.scroller.scrollWidth > this.scroller.clientWidth
      ? (this.scroller.scrollLeft + this.scroller.clientWidth / 2) / this.scroller.scrollWidth : 0.5;
    this.tasks.forEach(t => t.cancel());
    this.tasks.clear();
    this.buildPages();
    const el = this.pageEls[this.page - 1];
    if (el) {
      this.scroller.scrollTop = el.offsetTop + frac * el.offsetHeight;
      this.scroller.scrollLeft = fracX * this.scroller.scrollWidth - this.scroller.clientWidth / 2;
    }
  }

  setZoom(z) {
    z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    if (Math.abs(z - 1) < 0.04) z = 1;
    if (!this.pdf || Math.abs(z - this.zoom) < 0.001) return;
    this.zoom = z;
    this.relayout();
  }

  async renderPage(n) {
    const div = this.pageEls[n - 1];
    if (!div || !this.pdf) return;
    const scale = this.scale;
    const key = scale.toFixed(4);
    if (div.dataset.rendered === key || this.tasks.has(n)) return;
    const pdf = this.pdf;
    try {
      const page = await pdf.getPage(n);
      if (pdf !== this.pdf || this.scale.toFixed(4) !== key) return;
      const vp = page.getViewport({ scale });
      const s = this.sizes[n - 1];
      const base = page.getViewport({ scale: 1 });
      if (Math.abs(base.width - s.w) > 0.5 || Math.abs(base.height - s.h) > 0.5) {
        this.sizes[n - 1] = { w: base.width, h: base.height };
        div.style.width = `${vp.width}px`;
        div.style.height = `${vp.height}px`;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      // Limita o tamanho do canvas (memória em celulares).
      const maxPx = 16_000_000;
      let ratio = dpr;
      if (vp.width * vp.height * ratio * ratio > maxPx) ratio = Math.sqrt(maxPx / (vp.width * vp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * ratio);
      canvas.height = Math.floor(vp.height * ratio);
      const task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: vp,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
      });
      this.tasks.set(n, task);
      await task.promise;
      this.tasks.delete(n);
      if (pdf !== this.pdf || this.scale.toFixed(4) !== key) return;
      div.replaceChildren(canvas);
      div.dataset.rendered = key;
    } catch (err) {
      this.tasks.delete(n);
      if (err?.name !== 'RenderingCancelledException') console.warn('Falha ao renderizar página', n, err);
    }
  }

  releaseFar() {
    const p = this.page;
    for (const div of this.pageEls) {
      const n = +div.dataset.page;
      if (div.dataset.rendered && Math.abs(n - p) > KEEP_RENDERED) {
        div.innerHTML = `<span class="pnum">${n}</span>`;
        delete div.dataset.rendered;
      }
    }
  }

  goTo(n, source = 'jump', smooth = false) {
    if (!this.pdf) return;
    n = Math.min(Math.max(1, Math.round(n) || 1), this.pdf.numPages);
    const el = this.pageEls[n - 1];
    this.scroller.scrollTo({ top: el.offsetTop - 8, behavior: smooth ? 'smooth' : 'auto' });
    this.setPage(n, source);
  }

  trackPage() {
    if (!this.pdf || !this.pageEls.length) return;
    // Página cujo corpo cruza a linha a 40% da altura visível.
    const y = this.scroller.scrollTop + this.scroller.clientHeight * 0.4;
    let lo = 0, hi = this.pageEls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pageEls[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
    }
    // No fim do documento, considere a última página.
    if (this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 4) lo = this.pageEls.length - 1;
    this.setPage(lo + 1, 'scroll');
  }

  setPage(n, source) {
    if (n === this.page) return;
    const prev = this.page;
    this.page = n;
    $('rdPage').value = n;
    $('rdSlider').value = n;
    this.updatePct(n);
    this.releaseFar();
    this.cb.onPageChange(n, prev, source);
  }

  updatePct(n) {
    const total = this.pdf?.numPages || 1;
    $('rdPct').textContent = Math.round((n / total) * 100) + '%';
  }

  setBookmarked(on) { $('rdBookmark').classList.toggle('on', on); }
}
