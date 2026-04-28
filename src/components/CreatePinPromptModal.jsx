import { KeyRound, X } from 'lucide-react'

export default function CreatePinPromptModal({ onCreatePin, onDismiss }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg border border-amber-900/50 w-full max-w-sm">
        <div className="p-5 border-b border-gray-800 flex items-center gap-3">
          <div className="p-2 bg-amber-900/30 rounded-full">
            <KeyRound className="text-amber-400" size={20} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Kiosk PIN Required</h3>
            <p className="text-gray-500 text-xs">Your shop floor access PIN needs to be set</p>
          </div>
          <button onClick={onDismiss} className="ml-auto text-gray-500 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="p-5">
          <p className="text-gray-400 text-sm mb-4">
            You don't have a kiosk PIN set. You'll need one to log into the shop floor kiosks.
          </p>
          <p className="text-gray-600 text-xs font-mono mb-6">
            &gt; This message will appear next time you log in if you skip it.
          </p>

          <div className="flex gap-2">
            <button
              onClick={onDismiss}
              className="flex-1 px-4 py-2 text-gray-400 hover:text-white border border-gray-700 rounded"
            >
              Later
            </button>
            <button
              onClick={onCreatePin}
              className="flex-1 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white rounded"
            >
              Create PIN
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
