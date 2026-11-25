// Integração com PDF.js (empacotado localmente em lib/pdfjs para funcionar offline).
import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';

const base = new URL('../lib/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';

export function loadPdf(arrayBuffer) {
  // PDF.js pode "transferir" o buffer para o worker; passamos uma cópia.
  return pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer.slice(0)),
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
  }).promise;
}

/** Lê dados básicos de um PDF recém-adicionado: páginas, título, autor e capa. */
export async function inspectPdf(arrayBuffer) {
  const pdf = await loadPdf(arrayBuffer);
  try {
    let title = '', author = '';
    try {
      const { info } = await pdf.getMetadata();
      title = (info?.Title || '').trim();
      author = (info?.Author || '').trim();
    } catch { /* sem metadados */ }
    const cover = await renderThumb(pdf, 1, 360);
    return { pages: pdf.numPages, title, author, cover };
  } finally {
    pdf.destroy();
  }
}

export async function renderThumb(pdf, pageNum, width) {
  try {
    const page = await pdf.getPage(pageNum);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return '';
  }
}

/** Sumário (outline) do PDF achatado em uma lista {title, page}. */
export async function getOutline(pdf, maxDepth = 1) {
  const outline = await pdf.getOutline();
  if (!outline) return [];
  const out = [];
  const walk = async (items, depth) => {
    for (const it of items) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) page = (await pdf.getPageIndex(dest[0])) + 1;
      } catch { /* destino inválido */ }
      out.push({ title: (it.title || '').trim(), page });
      if (depth < maxDepth && it.items?.length) await walk(it.items, depth + 1);
    }
  };
  await walk(outline, 1);
  return out.filter(o => o.title);
}
