import type { ShellId, TermHopApi } from '@shared/types'

declare global {
  interface Window {
    termhop: TermHopApi
  }
}

export const api: TermHopApi = window.termhop

export const SHELL_META: Record<ShellId, { label: string; badge: string }> = {
  pwsh: { label: 'PowerShell 7', badge: 'pwsh' },
  powershell: { label: 'Windows PowerShell', badge: 'powershell' },
  cmd: { label: 'Command Prompt', badge: 'cmd' },
  wt: { label: 'Windows Terminal', badge: 'wt' }
}

export const SHELL_IDS = Object.keys(SHELL_META) as ShellId[]

export const SHELL_OPTIONS: { id: ShellId; label: string; badge: string }[] = SHELL_IDS.map(
  (id) => ({ id, ...SHELL_META[id] })
)

export function entryTitle(entry: { title: string; path: string }): string {
  if (entry.title.trim()) return entry.title.trim()
  const parts = entry.path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || entry.path
}

/** Shortens a path for display: keeps the drive, drops the middle, keeps the tail. */
export function shortPath(fullPath: string, segments = 2): string {
  const match = /^([a-zA-Z]:)([\\/])(.*)$/.exec(fullPath)
  if (!match) return fullPath
  const prefix = match[1] + match[2]
  const rest = match[3].split(/[\\/]/)
  if (rest.length <= segments) return fullPath
  return `${prefix}…${rest.slice(-segments).join('\\')}`
}

const UNITS: [number, string][] = [
  [60_000, '分钟'],
  [3_600_000, '小时'],
  [86_400_000, '天']
]

export function formatAgo(timestamp: number): string {
  if (!timestamp) return '从未使用'
  const delta = Date.now() - timestamp
  if (delta < 45_000) return '刚刚'
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const [size, label] = UNITS[i]
    if (delta >= size) {
      const amount = Math.round(delta / size)
      return `${amount} ${label}前`
    }
  }
  return '刚刚'
}
