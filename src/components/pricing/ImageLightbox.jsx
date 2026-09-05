//
// Pricing Portal — image lightbox (C1.1). `images` = [{ src, caption }], `index` = which
// one is open. Esc / backdrop closes; arrows or ← → move; click the picture to close.
//
import { useEffect } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'

export default function ImageLightbox({ images, index, onClose, onIndex }) {
  const n = images?.length || 0
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
      if (e.key === 'ArrowRight' && n > 1) onIndex?.((index + 1) % n)
      if (e.key === 'ArrowLeft' && n > 1) onIndex?.((index - 1 + n) % n)
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [index, n, onClose, onIndex])
  if (!n || index === null || index === undefined) return null
  const img = images[index]
  return (
    <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6" onClick={onClose}>
      <button onClick={onClose} className="absolute top-4 right-4 text-gray-300 hover:text-white"><X size={26} /></button>
      {n > 1 && <button onClick={e => { e.stopPropagation(); onIndex?.((index - 1 + n) % n) }} className="absolute left-4 text-gray-300 hover:text-white"><ChevronLeft size={34} /></button>}
      {n > 1 && <button onClick={e => { e.stopPropagation(); onIndex?.((index + 1) % n) }} className="absolute right-4 text-gray-300 hover:text-white"><ChevronRight size={34} /></button>}
      <figure className="max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3" onClick={e => e.stopPropagation()}>
        <img src={img.src} alt={img.caption || ''} onClick={onClose} className="max-w-[90vw] max-h-[80vh] object-contain rounded-lg bg-white cursor-zoom-out" />
        {img.caption && <figcaption className="font-mono text-sm text-gray-200">{img.caption}{n > 1 ? <span className="text-gray-500"> · {index + 1} / {n}</span> : ''}</figcaption>}
      </figure>
    </div>
  )
}
