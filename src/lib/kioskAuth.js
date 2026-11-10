// src/lib/kioskAuth.js — kiosk-authenticate answers (D-ASM-44).
//
// After five wrong PINs in ten minutes from one caller, kiosk-authenticate
// answers HTTP 429 { error: 'Too many attempts', retry_after_seconds }.
// supabase.functions.invoke turns any non-2xx into an error whose `context`
// is the Response, so the wait is read from there.

// D-ASM-48: kiosk-only accounts (assemblers) get the assembly tablet and nothing else. kiosk-authenticate admits
// the assembly role for that tablet; every other kiosk page refuses such an operator before adopting the token.
export const KIOSK_ONLY_MESSAGE = 'This account works on the assembly tablet only'
export const isKioskOnly = (operator) => operator?.kiosk_only === true

export function lockedMinutesMessage(retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil((Number(retryAfterSeconds) || 600) / 60))
  return `Too many wrong PINs — wait ${minutes} minute(s)`
}

// The message to show for a failed kiosk-authenticate call, or null when the
// failure was not the attempt lock (the caller then shows its usual "Invalid PIN").
export async function kioskAuthLockedMessage(error) {
  const res = error?.context
  if (!res || res.status !== 429) return null
  let seconds = null
  try {
    seconds = (await res.clone().json())?.retry_after_seconds ?? null
  } catch {
    // body unreadable — fall back to the full ten-minute wait
  }
  return lockedMinutesMessage(seconds)
}
