// src/lib/pdfjsLoader.js — one place to load pdf.js and render PDF pages to images.
//
// D-TKIOSK-06: the Traveler Kiosk prints a travel pack as ONE HTML job. Every
// PDF page is drawn to a canvas by pdf.js and embedded as an image, because
// Chrome will not let a page script its own PDF viewer frame (spike, Oct 7 2026,
// Chrome 154: contentWindow.print() on a PDF iframe throws SecurityError,
// cross-origin). Same pdf.js build and CDN as BOMUpload.jsx, which keeps its own
// copy of these constants this sprint — lifting it is a later tidy, not S14.
const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
const PDFJS_WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'

let loadingPromise = null

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(s)
  })
}

// Resolves to window.pdfjsLib with the worker configured. Safe to call often;
// the script is fetched once per page load.
export async function ensurePdfJs() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN
    return window.pdfjsLib
  }
  if (!loadingPromise) {
    loadingPromise = loadScript(PDFJS_CDN)
      .then(() => {
        if (!window.pdfjsLib) throw new Error('pdf.js loaded but window.pdfjsLib is missing')
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN
        return window.pdfjsLib
      })
      .catch((err) => {
        loadingPromise = null
        throw err
      })
  }
  return loadingPromise
}

// Render every page of a PDF (Uint8Array) to a PNG data URL at `dpi`.
// Returns [{ dataUrl, landscape, width, height }] in page order.
// 300 DPI on letter is a 2550 x 3300 canvas — crisp on a laser printer, and
// well inside what Chrome handles for the 2–4 documents a job carries.
export async function renderPdfPages(bytes, dpi = 300, onPage = null) {
  const pdfjsLib = await ensurePdfJs()
  // pdf.js may transfer the buffer to its worker — hand it a copy.
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise
  const scale = dpi / 72
  const pages = []
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      pages.push({
        dataUrl: canvas.toDataURL('image/png'),
        landscape: viewport.width > viewport.height,
        width: canvas.width,
        height: canvas.height,
      })
      // Release the canvas backing store promptly.
      canvas.width = 0
      canvas.height = 0
      try { page.cleanup() } catch { /* best effort */ }
      if (onPage) onPage(n, pdf.numPages)
    }
  } finally {
    try { await pdf.destroy() } catch { /* best effort */ }
  }
  return pages
}
