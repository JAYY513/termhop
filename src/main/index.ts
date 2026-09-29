import { app, dialog, ipcMain, Menu, Tray } from 'electron'
import { existsSync, statSync } from 'node:fs'
import type { AddEntryRequest, Config, OpenTarget, ShellId } from '@shared/types'
import { addCliToPath, installCli, parseCli, runCli } from './cli'
import {
  addEntryToConfig,
  clearTrash,
  consumeNotices,
  loadConfig,
  normalizePath,
  purgeFromTrash,
  restoreFromTrash,
  saveConfig,
  trashEntryInConfig,
  trashGroupInConfig
} from './config'
import { registerHotkey, unregisterAll } from './hotkey'
import { checkShells, getShell, launchShell, revealInExplorer } from './shells'
import {
  broadcast,
  closeSettings,
  createLauncher,
  flushPendingPlacement,
  getPlacement,
  hideLauncher,
  initPlacement,
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

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
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
   * Opens a terminal somewhere that is not in the list. Nothing is written to
   * the config: a one-off directory should not become a saved entry.
   */
  ipcMain.handle('entry:openPath', async (_event, raw: string) => {
    const cwd = normalizePath(raw)
    if (!cwd) return { ok: false, error: '请输入一个目录' }
    if (!existsSync(cwd)) return { ok: false, error: `目录不存在：${cwd}` }
    if (!isDirectory(cwd)) return { ok: false, error: `不是一个目录：${cwd}` }

    const available = checkShells()
    const preferred = (['pwsh', 'powershell', 'wt', 'cmd'] as const).find(
      (id) => available[id]
    )
    if (!preferred) return { ok: false, error: '没有找到可用的 shell' }

    const spec = getShell(preferred)
    if (!spec) return { ok: false, error: `Unknown shell: ${preferred}` }
    const outcome = await launchShell(spec, cwd, null)
    if (outcome.ok) hideLauncher()
    return { ...outcome, shell: preferred }
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

    if (shellId === 'reveal') {
      const outcome = await revealInExplorer(entry.path)
      if (outcome.ok) hideLauncher()
      return outcome
    }

    const spec = getShell(shellId)
    if (!spec) return { ok: false, error: `Unknown shell: ${shellId}` }

    const outcome = await launchShell(spec, entry.path, entry.initCmd)
    if (!outcome.ok) return outcome

    recordUse(entryId, shellId, config)
    hideLauncher()
    return { ok: true, shell: shellId }
  })

  ipcMain.on('window:closeOnBlur', (_event, enabled: boolean) => setCloseOnBlur(!!enabled))
  ipcMain.on('launcher:hide', () => hideLauncher())
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
