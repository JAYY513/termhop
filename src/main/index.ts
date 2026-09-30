import { app, dialog, ipcMain, Menu, Tray } from 'electron'
import { existsSync } from 'node:fs'
import type { AddEntryRequest, Config, OpenResult, OpenTarget, ShellId } from '@shared/types'
import { addCliToPath, installCli, parseCli, runCli } from './cli'
import {
  addEntryToConfig,
  clearTrash,
  consumeNotices,
  isDirectory,
  loadConfig,
  normalizePath,
  purgeFromTrash,
  restoreFromTrash,
  saveConfig,
  trashEntryInConfig,
  trashGroupInConfig
} from './config'
import { registerHotkey, unregisterAll } from './hotkey'
import { checkShells, getShell, launchShell, preferredShell, revealInExplorer } from './shells'
import {
  broadcast,
  closeSettings,
  createLauncher,
  flushPendingPlacement,
  getPlacement,
  hideLauncher,
  holdLauncherOnBlur,
  initPlacement,
  releaseLauncherHold,
  resizeLauncherToContent,
  setAppIsQuitting,
  setCloseOnBlur,
  setPlacementMode,
  showLauncher,
  showSettings,
  toggleLauncher,
  trayIcon
} from './window'

let tray: Tray | null = null
let pendingBeginAdd = false

/**
 * How long the same launch counts as an accident rather than an intention.
 *
 * A held Enter key fires keydown roughly every 30ms and a double click lands two
 * mousedowns about 150ms apart. Both used to spawn a terminal per event, and
 * leaving the user with a pile of near-identical windows is precisely the mess
 * a launcher exists to prevent.
 */
const DUPLICATE_LAUNCH_WINDOW = 1000

/** How long the launcher survives the focus theft of the window it just opened. */
const LAUNCH_CONFIRM_HOLD = 1500

const launchesInFlight = new Map<string, Promise<OpenResult>>()
const launchesSettled = new Map<string, { at: number; result: OpenResult }>()

/**
 * Runs a launch at most once per key per window. Callers that arrive while it
 * is running share its result instead of starting a second terminal, and the
 * renderer uses `deduped` to tell "you already asked for this" from a fresh
 * success.
 */
function launchOnce(key: string, run: () => Promise<OpenResult>): Promise<OpenResult> {
  const running = launchesInFlight.get(key)
  if (running) return running.then((result) => ({ ...result, deduped: true }))

  const settled = launchesSettled.get(key)
  if (settled && Date.now() - settled.at < DUPLICATE_LAUNCH_WINDOW) {
    return Promise.resolve({ ...settled.result, deduped: true })
  }

  const promise = run().then(
    (result) => {
      launchesInFlight.delete(key)
      // Only a launch that worked is worth remembering. A failure has to stay
      // immediately retryable, or one bad path would lock the entry out.
      if (result.ok) {
        launchesSettled.set(key, { at: Date.now(), result })
        for (const [other, past] of launchesSettled) {
          if (Date.now() - past.at >= DUPLICATE_LAUNCH_WINDOW) launchesSettled.delete(other)
        }
      }
      return result
    },
    (error: unknown) => {
      launchesInFlight.delete(key)
      throw error
    }
  )
  launchesInFlight.set(key, promise)
  return promise
}

/**
 * Windows has no first-class "launched at login" signal, so autostart passes
 * this flag. It matters because a modal dialog shown here would pop up on
 * every single sign-in.
 */
const AUTOSTART_FLAG = '--autostart'

function isAutostartLaunch(): boolean {
  return process.argv.includes(AUTOSTART_FLAG)
}

/**
 * In development `process.execPath` is the Electron binary, not TermHop, so
 * registering it for autostart would point the user at the wrong exe.
 */
function applyAutoLaunch(enabled: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    // The flag lets the app recognise a sign-in launch and stay quiet.
    args: enabled ? [AUTOSTART_FLAG] : []
  })
}

/**
 * Whether Windows really has a login item for this exe.
 *
 * Deliberately does not trust `openAtLogin`: on Windows it reads back false
 * even immediately after a successful setLoginItemSettings(true).
 * `executableWillLaunchAtLogin` is the flag that actually tracks the state,
 * with the per-app launch item as a second opinion.
 */
function isAutoLaunchRegistered(): boolean {
  if (!app.isPackaged) return false
  try {
    const settings = app.getLoginItemSettings()
    if (settings.executableWillLaunchAtLogin) return true
    const exe = process.execPath.toLowerCase()
    return (settings.launchItems ?? []).some(
      (item) => item.enabled !== false && item.path.toLowerCase() === exe
    )
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ boot */

function boot(): void {
  const cli = parseCli(process.argv)

  if (!app.requestSingleInstanceLock()) {
    // A GUI instance already owns the state. Requesting the lock is what
    // delivers our argv to it via 'second-instance', so all that is left to
    // do here is leave.
    app.quit()
    return
  }

  if (cli) {
    // No GUI is running, so this process is the CLI. Never open a window: the
    // whole point is that `termhop add .` should not leave a tray icon behind.
    void runCli(cli, process.cwd()).then((code) => app.exit(code))
    return
  }

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const command = parseCli(argv)
    if (!command) {
      showLauncher()
      return
    }
    void runCli(command, workingDirectory || process.cwd()).then(() => {
      broadcast('config:changed', loadConfig())
    })
  })

  app.whenReady().then(() => {
    const config = loadConfig()
    initPlacement(config.placement)

    createLauncher({
      onPlacementChanged: (placement) => {
        const current = loadConfig()
        saveConfig({ ...current, placement })
      }
    })
    setCloseOnBlur(config.settings.closeOnBlur)
    applyAutoLaunch(config.settings.launchOnStartup)

    const hotkey = registerHotkey(config.hotkey, toggleLauncher)
    if (!hotkey.ok) {
      if (isAutostartLaunch()) {
        // A modal dialog here would appear on every sign-in, which is far
        // worse than a shortcut that does not fire. The user can see the
        // problem in settings.
        console.warn(`[autostart] global shortcut unavailable: ${hotkey.error}`)
      } else {
        dialog
          .showMessageBox({
            type: 'warning',
            title: 'TermHop',
            message: 'The global shortcut could not be registered',
            detail: hotkey.error,
            buttons: ['Open settings', 'Continue without shortcut']
          })
          .then(({ response }) => {
            if (response === 0) showSettings()
          })
      }
    }

    createTray()
    registerIpc()
  })

  app.on('before-quit', () => setAppIsQuitting(true))
  app.on('will-quit', () => {
    // A drag that was never followed by a hide would otherwise be lost.
    flushPendingPlacement()
    unregisterAll()
  })
  // Tray app: closing every window must not end the process.
  app.on('window-all-closed', () => {
    /* intentionally empty */
  })
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('TermHop')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show launcher', click: () => showLauncher() },
      { label: 'Settings…', click: () => showSettings() },
      { type: 'separator' },
      {
        label: 'Quit TermHop',
        click: () => {
          setAppIsQuitting(true)
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => toggleLauncher())
}

/* ------------------------------------------------------------------- ipc */

function recordUse(entryId: string, shell: ShellId, config: Config): Config {
  const next: Config = {
    ...config,
    entries: config.entries.map((entry) =>
      entry.id === entryId ? { ...entry, lastShell: shell } : entry
    ),
    // One record per entry, ordered by recency.
    history: [
      { entryId, shell, at: Date.now() },
      ...config.history.filter((item) => item.entryId !== entryId)
    ].slice(0, config.settings.maxHistory)
  }
  const saved = saveConfig(next)
  broadcast('config:changed', saved)
  return saved
}

function resolveShell(config: Config, entryId: string, target: OpenTarget): ShellId | 'reveal' | null {
  const entry = config.entries.find((item) => item.id === entryId)
  if (!entry) return null
  if (target === 'reveal') return 'reveal'
  if (target === 'default') return entry.defaultShell
  if (target === 'last') {
    const remembered = config.settings.restoreLastShell ? entry.lastShell : null
    return remembered ?? entry.defaultShell
  }
  return target
}

function registerIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('config:get', () => loadConfig())

  ipcMain.handle('config:save', (_event, next: Config) => {
    const saved = saveConfig(next)
    setCloseOnBlur(saved.settings.closeOnBlur)
    applyAutoLaunch(saved.settings.launchOnStartup)
    broadcast('config:changed', saved)
    return saved
  })

  ipcMain.handle('config:openDir', () => app.getPath('userData'))

  ipcMain.handle('app:notices', () => consumeNotices())

  ipcMain.handle('launcher:placement', () => getPlacement())

  ipcMain.handle('launcher:setPlacement', (_event, mode: 'cursor' | 'fixed') =>
    setPlacementMode(mode)
  )

  ipcMain.handle('cli:install', () => installCli())
  ipcMain.handle('cli:addToPath', () => addCliToPath())

  /**
   * One implementation for adding an entry, shared by the settings form and
   * the CLI, so the two can never drift apart.
   */
  ipcMain.handle('entry:add', (_event, request: AddEntryRequest) => {
    const result = addEntryToConfig(loadConfig(), request)
    if (!result.ok) return { ok: false, error: result.error, config: loadConfig() }
    const saved = saveConfig(result.config)
    broadcast('config:changed', saved)
    return { ok: true, entryId: result.entryId, config: saved }
  })

  ipcMain.handle('trash:restore', (_event, id: string) => {
    const result = restoreFromTrash(loadConfig(), id)
    const saved = saveConfig(result.config)
    broadcast('config:changed', saved)
    return saved
  })

  ipcMain.handle('trash:purge', (_event, id: string) => {
    const result = purgeFromTrash(loadConfig(), id)
    const saved = saveConfig(result.config)
    broadcast('config:changed', saved)
    return saved
  })

  ipcMain.handle('trash:clear', () => {
    const result = clearTrash(loadConfig())
    const saved = saveConfig(result.config)
    broadcast('config:changed', saved)
    return saved
  })

  ipcMain.handle('entry:trash', (_event, id: string) => {
    const result = trashEntryInConfig(loadConfig(), id)
    const saved = saveConfig(result.config)
    broadcast('config:changed', saved)
    return saved
  })

  ipcMain.handle('group:trash', (_event, id: string) => {
    const result = trashGroupInConfig(loadConfig(), id)
    const saved = saveConfig(result.config)
    broadcast('config:changed', saved)
    return saved
  })

  ipcMain.handle('shell:check', () => checkShells(true))

  ipcMain.handle('hotkey:set', (_event, accelerator: string) => {
    const result = registerHotkey(accelerator, toggleLauncher)
    if (result.ok) {
      const config = loadConfig()
      if (config.hotkey !== accelerator) {
        saveConfig({ ...config, hotkey: accelerator })
      }
    }
    return result
  })

  ipcMain.handle('app:autoLaunch', (_event, enabled: boolean) => {
    applyAutoLaunch(enabled)
    // Development builds deliberately never register, so the settings toggle
    // reports the requested value rather than a state we just faked.
    return app.isPackaged ? isAutoLaunchRegistered() : enabled
  })

  // The user can also flip this in Task Manager or Startup Apps, so the OS is
  // the source of truth for what is actually registered.
  ipcMain.handle('app:autoLaunchState', () => ({
    enabled: isAutoLaunchRegistered(),
    supported: app.isPackaged
  }))

  ipcMain.handle('dialog:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  /**
   * Turns whatever the user typed into a directory that exists right now, or
   * the sentence explaining why it cannot be used. Shared by the two handlers
   * that act on an unsaved path, so "does this path work" is answered once.
   */
  function resolveDirectory(raw: string): { ok: true; cwd: string } | { ok: false; error: string } {
    const cwd = normalizePath(raw)
    if (!cwd) return { ok: false, error: '请输入一个目录' }
    if (!existsSync(cwd)) return { ok: false, error: `目录不存在：${cwd}` }
    if (!isDirectory(cwd)) return { ok: false, error: `不是一个目录：${cwd}` }
    return { ok: true, cwd }
  }

  /**
   * Opens a terminal somewhere that is not in the list. Nothing is written to
   * the config: a one-off directory should not become a saved entry.
   *
   * The window is deliberately not hidden here. Hiding it in the same tick the
   * launch succeeded is what made a click look like it had done nothing at all;
   * the renderer holds the window open, shows the result, and closes it itself.
   */
  ipcMain.handle('entry:openPath', async (_event, raw: string) => {
    const resolved = resolveDirectory(raw)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const cwd = resolved.cwd

    const available = checkShells()
    const preferred = preferredShell(available)
    if (!preferred) return { ok: false, error: '没有找到可用的 shell' }

    const spec = getShell(preferred)
    if (!spec) return { ok: false, error: `Unknown shell: ${preferred}` }

    const result = await launchOnce(`path|${cwd.toLowerCase()}`, async () => {
      const outcome = await launchShell(spec, cwd, null)
      return { ...outcome, shell: preferred }
    })
    if (result.ok) holdLauncherOnBlur(LAUNCH_CONFIRM_HOLD)
    return result
  })

  /**
   * Shows an unsaved directory in Explorer. The 'reveal' target could not
   * reach these two rows: it hangs off an entry id, and a path that is not
   * saved has none. The footer advertised the shortcut on them anyway.
   */
  ipcMain.handle('entry:revealPath', async (_event, raw: string) => {
    const resolved = resolveDirectory(raw)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    // Explorer steals focus the same way a terminal does, so the launcher has
    // to be held open for the confirmation to be readable.
    const result = await launchOnce(`reveal|${resolved.cwd.toLowerCase()}`, () =>
      revealInExplorer(resolved.cwd)
    )
    if (result.ok) holdLauncherOnBlur(LAUNCH_CONFIRM_HOLD)
    return result
  })

  ipcMain.handle('entry:open', async (_event, entryId: string, target: OpenTarget) => {
    const config = loadConfig()
    const entry = config.entries.find((item) => item.id === entryId)
    if (!entry) return { ok: false, error: 'This entry no longer exists.' }

    if (!existsSync(entry.path)) {
      return { ok: false, error: `Folder not found: ${entry.path}` }
    }

    const shellId = resolveShell(config, entryId, target)
    if (!shellId) return { ok: false, error: 'This entry no longer exists.' }

    // The key carries the resolved shell rather than the requested target, so
    // 'last' and 'default' still collapse into one launch when both arrive at
    // once on the same entry.
    const result = await launchOnce(`entry|${entryId}|${shellId}`, async () => {
      if (shellId === 'reveal') return revealInExplorer(entry.path)

      const spec = getShell(shellId)
      if (!spec) return { ok: false, error: `Unknown shell: ${shellId}` }

      const outcome = await launchShell(spec, entry.path, entry.initCmd)
      if (!outcome.ok) return outcome

      recordUse(entryId, shellId, config)
      return { ok: true, shell: shellId }
    })
    if (result.ok) holdLauncherOnBlur(LAUNCH_CONFIRM_HOLD)
    return result
  })

  ipcMain.on('window:closeOnBlur', (_event, enabled: boolean) => setCloseOnBlur(!!enabled))
  ipcMain.on('launcher:hide', () => hideLauncher())
  ipcMain.on('launcher:settled', () => releaseLauncherHold())
  ipcMain.on('launcher:show', () => showLauncher())
  ipcMain.on('launcher:resize', (_event, contentHeight: number) =>
    resizeLauncherToContent(Number(contentHeight))
  )
  ipcMain.on('nav:settings', () => showSettings())
  ipcMain.on('nav:beginAdd', () => {
    // The settings window may be created by this very call, so the request is
    // parked and collected by the renderer once it has mounted.
    pendingBeginAdd = true
    showSettings()
  })
  ipcMain.handle('ui:consumeBeginAdd', () => {
    const value = pendingBeginAdd
    pendingBeginAdd = false
    return value
  })
  ipcMain.on('nav:closeSettings', () => closeSettings())
  ipcMain.on('app:quit', () => {
    setAppIsQuitting(true)
    app.quit()
  })
}

boot()
