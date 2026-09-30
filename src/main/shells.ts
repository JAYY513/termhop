import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ShellAvailability, ShellId } from '@shared/types'
import { PREFERRED_SHELL_ORDER } from '@shared/types'

const SystemRoot = process.env.SystemRoot || 'C:\\Windows'

/* ------------------------------------------------------------- exe lookup */

function whichSync(exe: string): string | null {
  try {
    const result = spawnSync('where.exe', [exe], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000
    })
    if (result.status !== 0) return null
    const first = (result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return first || null
  } catch {
    return null
  }
}

/** PowerShell 7 lives in a versioned folder under %LOCALAPPDATA%\Microsoft\PowerShell. */
function findPwsh(): string | null {
  const onPath = whichSync('pwsh.exe')
  if (onPath) return onPath

  const roots = [join(process.env.LOCALAPPDATA || '', 'Microsoft', 'PowerShell')]
  const best: { path: string; rank: number }[] = []

  for (const root of roots) {
    if (!existsSync(root)) continue
    let versions: string[]
    try {
      versions = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const version of versions) {
      const exe = join(root, version, 'pwsh.exe')
      if (!existsSync(exe)) continue
      // Prefer a release over a preview, and a higher number over a lower one.
      const preview = version.includes('preview') ? 0 : 1
      const numeric = parseInt(version, 10)
      best.push({ path: exe, rank: preview * 1000 + (Number.isNaN(numeric) ? 0 : numeric) })
    }
  }
  best.sort((a, b) => b.rank - a.rank)
  return best[0]?.path ?? null
}

function findWt(): string | null {
  const onPath = whichSync('wt.exe')
  if (onPath) return onPath
  // wt.exe is published as a Store app execution alias, so it often only
  // exists inside the per-user WindowsApps folder.
  const candidate = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe')
  return existsSync(candidate) ? candidate : null
}

/* ----------------------------------------------------------------- shells */

export interface ShellSpec {
  id: ShellId
  label: string
  /** Short badge shown in the launcher, e.g. "pwsh". */
  badge: string
  resolve(): string | null
  build(exe: string, cwd: string, initCmd: string | null): string[]
  /** True when the shell is a GUI app and can be spawned directly. */
  isGui: boolean
  /** initCmd cannot be passed through cmd's parser without breaking quoting. */
  supportsInitCmd: boolean
}

/**
 * PowerShell receives its startup script base64 encoded. That removes every
 * quoting hazard: paths with spaces, single quotes and `[]` all survive intact.
 */
function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function setLocationScript(cwd: string, initCmd: string | null): string {
  const literal = cwd.replace(/'/g, "''")
  const base = `Set-Location -LiteralPath '${literal}'`
  return initCmd ? `${base}; ${initCmd}` : base
}

function powershellArgs(cwd: string, initCmd: string | null): string[] {
  return [
    '-NoLogo',
    '-NoExit',
    '-EncodedCommand',
    encodePowerShell(setLocationScript(cwd, initCmd))
  ]
}

const WINDOWS_POWERSHELL = join(SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const CMD = join(SystemRoot, 'System32', 'cmd.exe')

export const SHELLS: ShellSpec[] = [
  {
    id: 'pwsh',
    label: 'PowerShell 7',
    badge: 'pwsh',
    resolve: findPwsh,
    build: (_exe, cwd, initCmd) => powershellArgs(cwd, initCmd),
    isGui: false,
    supportsInitCmd: true
  },
  {
    id: 'powershell',
    label: 'Windows PowerShell',
    badge: 'powershell',
    resolve: () => (existsSync(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : null),
    build: (_exe, cwd, initCmd) => powershellArgs(cwd, initCmd),
    isGui: false,
    supportsInitCmd: true
  },
  {
    id: 'cmd',
    label: 'Command Prompt',
    badge: 'cmd',
    resolve: () => (existsSync(CMD) ? CMD : null),
    // `/d` is required: without it `cd` to a path on another drive fails.
    build: (_exe, cwd) => ['/k', 'cd', '/d', cwd],
    isGui: false,
    supportsInitCmd: false
  },
  {
    id: 'wt',
    label: 'Windows Terminal',
    badge: 'wt',
    resolve: findWt,
    build: (_exe, cwd, initCmd) => (initCmd ? ['-d', cwd, 'cmd', '/k', initCmd] : ['-d', cwd]),
    isGui: true,
    supportsInitCmd: true
  }
]

const byId = new Map(SHELLS.map((shell) => [shell.id, shell]))

export function getShell(id: ShellId): ShellSpec | undefined {
  return byId.get(id)
}

const availabilityCache = new Map<ShellId, boolean>()

export function checkShells(force = false): ShellAvailability {
  const result = {} as ShellAvailability
  for (const shell of SHELLS) {
    if (force || !availabilityCache.has(shell.id)) {
      let found = false
      try {
        found = shell.resolve() !== null
      } catch {
        found = false
      }
      availabilityCache.set(shell.id, found)
    }
    result[shell.id] = availabilityCache.get(shell.id) as boolean
  }
  return result
}

/**
 * Which shell a bare path gets, and which shell a new entry defaults to.
 *
 * These used to be decided in two places: the launcher walked its own
 * preference list when opening an unsaved path, while addEntryToConfig
 * hardcoded 'powershell'. The visible result was that saving a directory the
 * user had just opened with Enter quietly changed which shell it opened in.
 * The order itself is shared with the renderer, which shows it on the row.
 */
export function preferredShell(availability?: ShellAvailability): ShellId | null {
  const available = availability ?? checkShells()
  return PREFERRED_SHELL_ORDER.find((id) => available[id]) ?? null
}

/* ----------------------------------------------------------------- launch */

/** Quotes a single argument for a hand-built cmd command line. */
function quoteForCmd(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg
  if (arg.startsWith('"') && arg.endsWith('"') && arg.length > 1) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

export interface LaunchOutcome {
  ok: boolean
  error?: string
}

/**
 * Console apps need `cmd /c start` to be given a console window at all: a
 * console process started as DETACHED_PROCESS gets no window and is invisible.
 * GUI apps (Windows Terminal) are spawned directly, which also keeps cmd's
 * parser away from the argument list.
 */
export function launchShell(spec: ShellSpec, cwd: string, initCmd: string | null): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let exe: string | null = null
    try {
      exe = spec.resolve()
    } catch {
      exe = null
    }
    if (!exe) {
      resolve({ ok: false, error: `${spec.label} was not found on this system` })
      return
    }

    const init = spec.supportsInitCmd ? initCmd : null
    const args = spec.build(exe, cwd, init)

    let settled = false
    const done = (outcome: LaunchOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    if (spec.isGui) {
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', (error) => done({ ok: false, error: error.message }))
      child.once('spawn', () => {
        child.unref()
        setTimeout(() => done({ ok: true }), 120)
      })
      return
    }

    // `start` treats its first quoted argument as a window title, so the empty
    // "" is mandatory before a path that may contain spaces.
    const line = `/d /c start "" ${quoteForCmd(exe)} ${args.map(quoteForCmd).join(' ')}`
    const child = spawn('cmd.exe', [line], {
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', (error) => done({ ok: false, error: error.message }))
    child.once('spawn', () => {
      child.unref()
      // 'spawn' only proves cmd.exe started; give it a beat to report a real failure.
      setTimeout(() => done({ ok: true }), 250)
    })
  })
}

export function revealInExplorer(target: string): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    const child = spawn('explorer.exe', [`/select,${target}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', (error) => resolve({ ok: false, error: error.message }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}
