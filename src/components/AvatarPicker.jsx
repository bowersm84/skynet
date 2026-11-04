import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { AVATAR_ICONS, AVATAR_COLORS, DEFAULT_AVATAR_COLOR, initials } from '../lib/avatars'

// Avatar — a disc in the person's colour with their icon (or initials) in white (S17 B2, D-ASM-32).
export function Avatar({ icon, color, name, size = 24 }) {
  const Icon = AVATAR_ICONS[icon]
  return (
    <span
      title={name || undefined}
      aria-label={name || undefined}
      className="inline-flex items-center justify-center rounded-full ring-1 ring-white/30 text-white font-semibold shrink-0 select-none"
      style={{ width: size, height: size, backgroundColor: color || DEFAULT_AVATAR_COLOR, fontSize: Math.max(9, Math.round(size * 0.4)) }}
    >
      {Icon ? <Icon size={Math.round(size * 0.58)} strokeWidth={2.25} /> : initials(name)}
    </span>
  )
}

// AvatarPicker — choose an icon and a colour. The assembler picks their own on the kiosk (Batch C, D-ASM-32); the
// board only shows avatars. A panel, not a dialog, so the kiosk can show it full screen at first sign-in; the buttons
// are sized for a touch screen. onSave(iconName | null, '#RRGGBB'); "Use initials" saves no icon.
export default function AvatarPicker({ name, icon = null, color = null, busy = false, onSave, onCancel }) {
  const [pickIcon, setPickIcon] = useState(icon && AVATAR_ICONS[icon] ? icon : null)
  const [pickColor, setPickColor] = useState(color || DEFAULT_AVATAR_COLOR)
  const unchanged = pickIcon === (icon || null) && pickColor === (color || DEFAULT_AVATAR_COLOR)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Avatar icon={pickIcon} color={pickColor} name={name} size={56} />
        <div>
          <div className="text-white font-medium">{name}</div>
          <div className="text-xs text-gray-500">
            {pickIcon || 'initials'} · {AVATAR_COLORS.find((c) => c.hex === pickColor)?.name || pickColor}
          </div>
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-2">Icon</div>
        <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
          {Object.keys(AVATAR_ICONS).map((key) => {
            const Icon = AVATAR_ICONS[key]
            const on = pickIcon === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPickIcon(key)}
                title={key}
                aria-label={key}
                aria-pressed={on}
                className={`h-11 w-11 rounded-lg flex items-center justify-center border transition-colors ${
                  on ? 'border-white text-white' : 'border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white'
                }`}
                style={on ? { backgroundColor: pickColor } : undefined}
              >
                <Icon size={22} />
              </button>
            )
          })}
        </div>
        <button type="button" onClick={() => setPickIcon(null)}
          className={`mt-2 text-xs ${pickIcon === null ? 'text-white' : 'text-gray-400 hover:text-white'}`}>
          Use initials ({initials(name)})
        </button>
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-2">Colour</div>
        <div className="flex flex-wrap gap-2">
          {AVATAR_COLORS.map((c) => {
            const on = pickColor === c.hex
            return (
              <button
                key={c.hex}
                type="button"
                onClick={() => setPickColor(c.hex)}
                title={c.name}
                aria-label={c.name}
                aria-pressed={on}
                className={`h-11 w-11 rounded-full flex items-center justify-center text-white ring-offset-2 ring-offset-gray-900 ${on ? 'ring-2 ring-white' : 'ring-1 ring-white/30'}`}
                style={{ backgroundColor: c.hex }}
              >
                {on && <Check size={18} />}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && <button type="button" onClick={onCancel} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>}
        <button type="button" disabled={busy || unchanged} onClick={() => onSave(pickIcon, pickColor)}
          className="px-4 py-2 rounded text-sm bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 inline-flex items-center gap-2">
          {busy && <Loader2 size={14} className="animate-spin" />} Save
        </button>
      </div>
    </div>
  )
}
