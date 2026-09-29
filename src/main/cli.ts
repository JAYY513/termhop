import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliInstallResult, Config, Entry } from '@shared/types'
import {
  addEntryToConfig,
  folderNameOf,
  loadConfig,
  normalizePath,
  saveConfig
} from './config'
import { getShell, launchShell } from './shells'

/**
 * `TermHop.exe` doubles as a command line tool. There is no second binary: the
 * same single-instance lock that keeps one GUI alive also lets a CLI invocation
 * hand its argv to the running app instead of starting a second copy.
 *
 * The exe has no console of its own, so all human-readable output is printed
 * by the generated .cmd shim, which does have one. That means the shim's only
 * job is dispatch plus an exit-code message.
 */

export type CliCommand =
  | { kind: 'add'; target?: string }
  | { kind: 'open'; name: string }
  | { kind: 'help' }

const VERBS = new Set(['add', 'open', 'help', '--help', '-h', '/?'])

/**
 * Only the first argument is treated as a verb. Scanning for a verb anywhere
 * would misfire on a directory literally named "add" or "open".
 *
 * Returns null for anything unrecognised, which means "start the GUI". That
 * matters because Chromium switches such as --user-data-dir also land in
 * argv[1]; treating one as a bad command would make the app exit silently.
 */
export function parseCli(argv: string[]): CliCommand | null {
  const start = app.isPackaged ? 1 : 2
  const verb = (argv[start] ?? '').toLowerCase()
  if (!VERBS.has(verb)) return null
  if (verb === 'add') return { kind: 'add', target: argv[start + 1] }
  if (verb === 'open') {
    const name = argv[start + 1]
    return name ? { kind: 'open', name } : null
  }
  return { kind: 'help' }
}

export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_USAGE = 2

/** Finds a saved entry by exact title, then folder name, then substring. */
export function matchEntry(config: Config, name: string): Entry | null {
  const needle = name.trim().toLowerCase()
  if (!needle) return null

  const byTitle = config.entries.find((entry) => entry.title.trim().toLowerCase() === needle)
  if (byTitle) return byTitle

  const byFolder = config.entries.find((entry) => folderNameOf(entry.path).toLowerCase() === needle)
  if (byFolder) return byFolder

  const byPath = config.entries.find((entry) => entry.path.toLowerCase().endsWith(`\\${needle}`))
  if (byPath) return byPath

  const partial = config.entries.filter((entry) =>
    `${entry.title} ${entry.path}`.toLowerCase().includes(needle)
  )
  // An ambiguous prefix match is worse than no match: opening the wrong
  // project is more annoying than being asked to be more specific.
  return partial.length === 1 ? partial[0] : null
}

/**
 * Runs a command in this process, for the case where no GUI instance holds the
 * single-instance lock. Returns a process exit code.
 */
export async function runCli(command: CliCommand, workingDirectory: string): Promise<number> {
  if (command.kind === 'help') return EXIT_OK

  const config = loadConfig()

  if (command.kind === 'add') {
    const target = command.target ? normalizePath(command.target) : normalizePath(workingDirectory)
    if (!target) return EXIT_USAGE
    if (!existsSync(target)) return EXIT_FAIL
    const result = addEntryToConfig(config, { path: target })
    if (!result.ok) return EXIT_FAIL
    saveConfig(result.config)
    return EXIT_OK
  }

  const entry = matchEntry(config, command.name)
  if (!entry) return EXIT_FAIL
  const spec = getShell(entry.lastShell ?? entry.defaultShell) ?? getShell(entry.defaultShell)
  if (!spec) return EXIT_FAIL
  const outcome = await launchShell(spec, entry.path, entry.initCmd)
  return outcome.ok ? EXIT_OK : EXIT_FAIL
}

/* -------------------------------------------------------------- shim setup */

function binDir(): string {
  return join(app.getPath('userData'), 'bin')
}

function shimContents(): string {
  const exe = app.isPackaged
    ? process.execPath
    : `${process.execPath} "${app.getAppPath()}"`
  // ASCII only: cmd.exe parses this file with the OEM code page, and any
  // non-ASCII byte in it can turn into a bogus command name.
  return [
    '@echo off',
    'setlocal',
    `set "TERMHOP_EXE=${exe}"`,
    '',
    'if /i "%~1"=="add" goto add',
    'if /i "%~1"=="open" goto open',
    'if "%~1"=="" goto help',
    'if /i "%~1"=="help" goto help',
    'if /i "%~1"=="--help" goto help',
    'if /i "%~1"=="-h" goto help',
    `echo TermHop: unknown command "%~1"`,
    'echo Run "termhop help" for usage.',
    'exit /b 2',
    '',
    ':add',
    // No "start" here: it would break the inherited working directory that
    // "termhop add ." depends on.
    'if "%~2"=="" (',
    '  "%TERMHOP_EXE%" add .',
    ') else (',
    '  "%TERMHOP_EXE%" add "%~2"',
    ')',
    'if errorlevel 1 goto failed',
    'echo Added.',
    'exit /b 0',
    '',
    ':open',
    'if "%~2"=="" goto usage',
    '"%TERMHOP_EXE%" open "%~2"',
    'if errorlevel 1 goto failed',
    'exit /b 0',
    '',
    ':help',
    'echo termhop - hop into a saved directory',
    'echo.',
    'echo   termhop add [dir]     save a directory (default: current dir)',
    'echo   termhop open <name>   open a terminal for a saved entry',
    'echo   termhop help          show this message',
    'exit /b 0',
    '',
    ':usage',
    'echo Usage: termhop open ^<name^>',
    'exit /b 2',
    '',
    ':failed',
    'echo TermHop: the command failed. Open the app to see details.',
    'exit /b 1',
    ''
  ].join('\r\n')
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 20_000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

async function isOnPath(dir: string): Promise<boolean> {
  const current = process.env.PATH ?? ''
  return current
    .split(';')
    .some((entry) => entry.replace(/^"|"$/g, '').toLowerCase() === dir.toLowerCase())
}

/**
 * Writes the shim. The caller must have shown the user where it lands before
 * anything touches PATH.
 */
export async function installCli(): Promise<CliInstallResult> {
  const dir = binDir()
  const shimPath = join(dir, 'termhop.cmd')
  mkdirSync(dir, { recursive: true })
  writeFileSync(shimPath, shimContents(), 'ascii')
  return { shimPath, onPath: await isOnPath(dir) }
}

/**
 * Appends the bin folder to the user PATH (never the system PATH) and tells
 * Explorer about it so newly launched programs pick it up. Already-open
 * terminals keep their old PATH until they are restarted.
 */
export async function addCliToPath(): Promise<{ ok: boolean; onPath: boolean; error?: string }> {
  const dir = binDir()
  if (await isOnPath(dir)) return { ok: true, onPath: true }

  const psDir = dir.replace(/'/g, "''")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$key = 'HKCU:\\Environment'",
    "$current = (Get-ItemProperty -Path $key -Name Path -ErrorAction SilentlyContinue).Path",
    "if ($null -eq $current) { $current = '' }",
    `$dir = '${psDir}'`,
    "if (($current -split ';') -notcontains $dir) {",
    "  $updated = ($current.TrimEnd(';') + ';' + $dir)",
    "  Set-ItemProperty -Path $key -Name Path -Value $updated",
    "  Add-Type -Namespace TermHopPath -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'",
    "  $result = [System.UIntPtr]::Zero",
    "  [void][TermHopPath.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
    "  Write-Output 'CHANGED'",
    '} else {',
    "  Write-Output 'ALREADY'",
    '}'
  ].join('; ')

  try {
    await runPowerShell(script)
    return { ok: true, onPath: true }
  } catch (error) {
    return {
      ok: false,
      onPath: false,
      error: (error as Error).message
    }
  }
}
