import { globalShortcut } from 'electron'

let registered: string | null = null

export interface HotkeyResult {
  ok: boolean
  error?: string
}

/**
 * Registers the launcher accelerator. Any previous binding is released first so
 * the app can own exactly one global shortcut at a time.
 */
export function registerHotkey(accelerator: string, handler: () => void): HotkeyResult {
  unregisterAll()

  if (!accelerator) return { ok: true }

  try {
    const ok = globalShortcut.register(accelerator, handler)
    if (ok) {
      registered = accelerator
      return { ok: true }
    }
    return {
      ok: false,
      error: `"${accelerator}" is already registered by another application. Pick a different shortcut.`
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

export function unregisterAll(): void {
  if (registered) {
    globalShortcut.unregister(registered)
    registered = null
  }
}
