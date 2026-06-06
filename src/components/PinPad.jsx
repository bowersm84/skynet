import { Loader2, Lock, Delete } from 'lucide-react'

// Shared PIN entry pad for every kiosk surface (machine kiosk, finishing, material).
// Renders the title block + numpad card; the caller supplies the page wrapper and
// the PIN handlers/state. Display is fixed at `maxLength` dots (default 4).
export default function PinPad({
  icon,
  title,
  subtitle = 'Enter your PIN',
  pin = '',
  error = null,
  busy = false,
  maxLength = 4,
  buttonLabel = 'Enter',
  onDigit,
  onClear,
  onBackspace,
  onSubmit,
}) {
  return (
    <div className="w-full max-w-sm">
      <div className="text-center mb-6">
        {icon}
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        <p className="text-gray-400 text-sm mt-1">{subtitle}</p>
      </div>
      <div className="bg-gray-800 rounded-2xl p-6 border border-gray-700">
        <div className="h-12 mb-4 flex items-center justify-center gap-2">
          {Array.from({ length: maxLength }).map((_, i) => (
            <span key={i} className={`w-3 h-3 rounded-full ${i < pin.length ? 'bg-skynet-accent' : 'bg-gray-600'}`} />
          ))}
        </div>
        {error && <p className="text-red-400 text-sm text-center mb-3">{error}</p>}
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
            <button key={n} onClick={() => onDigit(String(n))}
              className="h-14 bg-gray-700 hover:bg-gray-600 text-white text-xl font-semibold rounded-lg transition-colors">{n}</button>
          ))}
          <button onClick={onClear} className="h-14 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-lg transition-colors">Clear</button>
          <button onClick={() => onDigit('0')} className="h-14 bg-gray-700 hover:bg-gray-600 text-white text-xl font-semibold rounded-lg transition-colors">0</button>
          <button onClick={onBackspace} className="h-14 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg transition-colors flex items-center justify-center"><Delete size={20} /></button>
        </div>
        <button onClick={onSubmit} disabled={pin.length < 4 || busy}
          className="w-full h-12 mt-4 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
          {busy ? <Loader2 size={18} className="animate-spin" /> : <Lock size={18} />} {buttonLabel}
        </button>
      </div>
    </div>
  )
}
