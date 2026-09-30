import { BrowserWindow, nativeImage, screen } from 'electron'
import { join } from 'node:path'
import type { LauncherPlacement, PlacementMode } from '@shared/types'
import { APP_ICON_BASE64, TRAY_ICON_BASE64 } from './assets/icons'

const LAUNCHER_WIDTH = 680
const LAUNCHER_HEIGHT = 470
const LAUNCHER_MIN_HEIGHT = 216
// Height of the hint row that sits below the content.
const LAUNCHER_FOOTER = 40
const CURSOR_GAP = 20
// Keeps the rounded corners from hugging the screen edge.
const SCREEN_MARGIN = 14

// The settings window paints behind this. The launcher is 'floating' so it
// sits above ordinary windows, which means it would also float over the
// settings window unless we hide it first.
const SETTINGS_BG = '#14151a'

let launcher: BrowserWindow | null = null
let settings: BrowserWindow | null = null
let closeOnBlur = true
let ready = false
let appIsQuitting = false
let onPlacementChanged: ((placement: LauncherPlacement) => void) | null = null

/*
 * The terminal that just started steals the focus, which blurs the launcher and
 * used to hide it in the same tick the launch succeeded. The confirmation the
 * renderer wants to show could never survive that. So a successful launch parks
 * a short hold here and the renderer releases it once the result is readable.
 */
let holdBlurUntil = 0
let holdTimer: NodeJS.Timeout | null = null

let placement: LauncherPlacement = { mode: 'cursor', point: null }
// The last spot the code moved the window to, so the 'moved' event it causes
// can be told apart from a drag.
let autoPosition: { x: number; y: number } | null = null
let placementDirty = false

/** Persists a dragged position. Called when the launcher is hidden, not per pixel. */
function flushPlacement(): void {
  if (!placementDirty) return
  placementDirty = false
  onPlacementChanged?.(placement)
}

export function setAppIsQuitting(value: boolean): void {
  appIsQuitting = value
}

const preloadPath = join(__dirname, '../preload/index.js')
const rendererIndex = join(__dirname, '../renderer/index.html')
const devServerUrl = process.env['ELECTRON_RENDERER_URL']

function webPreferences(): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false
  }
}

export function createLauncher(
  hooks: { onPlacementChanged?: (placement: LauncherPlacement) => void } = {}
): BrowserWindow {
  if (launcher) return launcher
  onPlacementChanged = hooks.onPlacementChanged ?? null

  launcher = new BrowserWindow({
    width: LAUNCHER_WIDTH,
    height: LAUNCHER_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // Must stay resizable. On Windows Electron *silently ignores* setSize() on
    // a window created with resizable: false, which silently broke the
    // content-height resizing. The width is pinned below instead.
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    icon: nativeImageFrom(APP_ICON_BASE64),
    webPreferences: webPreferences()
  })

  launcher.setAlwaysOnTop(true, 'floating')
  launcher.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  launcher.setMenuBarVisibility(false)
  // The width is fixed, only the height follows the content. Pinning it here
  // means "resizable: true" cannot be turned into an accidental user resize.
  launcher.setMinimumSize(LAUNCHER_WIDTH, LAUNCHER_MIN_HEIGHT)
  launcher.setMaximumSize(LAUNCHER_WIDTH, LAUNCHER_HEIGHT)

  launcher.on('blur', () => {
    if (Date.now() < holdBlurUntil) return
    if (closeOnBlur && !settingsFocused()) hideLauncher()
  })

  launcher.on('close', (event) => {
    if (appIsQuitting) return
    event.preventDefault()
    hideLauncher()
  })

  // A drag means the user wants this launcher to live somewhere specific.
  // Only the in-memory state changes here; persistence waits for the next
  // hide, because 'moved' fires on every pixel of a drag.
  launcher.on('moved', () => {
    if (!launcher) return
    const [x, y] = launcher.getPosition()
    // The 'moved' event also fires for moves the code made. Telling the two
    // apart by comparing coordinates is deterministic; a time-based flag would
    // swallow a drag that starts very soon after the window appears.
    if (autoPosition && x === autoPosition.x && y === autoPosition.y) return
    placement = { mode: 'fixed', point: { x, y } }
    placementDirty = true
  })

  launcher.once('ready-to-show', () => {
    ready = true
  })

  void loadInto(launcher, '')
  return launcher
}

export function createSettings(): BrowserWindow {
  if (settings && !settings.isDestroyed()) return settings

  settings = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 840,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: SETTINGS_BG,
    title: 'TermHop 设置',
    icon: nativeImageFrom(APP_ICON_BASE64),
    webPreferences: webPreferences()
  })

  // Hide rather than destroy. Closing used to throw the window away, which
  // lost whatever the user was halfway through typing and rebuilt a 980x700
  // window on every open.
  settings.on('close', (event) => {
    if (appIsQuitting) return
    event.preventDefault()
    settings?.hide()
  })

  void loadInto(settings, '#/settings')
  return settings
}

async function loadInto(win: BrowserWindow, hash: string): Promise<void> {
  if (devServerUrl) {
    await win.loadURL(`${devServerUrl}${hash}`)
  } else {
    await win.loadFile(rendererIndex, hash ? { hash: hash.slice(1) } : undefined)
  }
}

function settingsFocused(): boolean {
  return Boolean(settings && !settings.isDestroyed() && settings.isFocused())
}

/* ------------------------------------------------------------ positioning */

function clampToWorkArea(win: BrowserWindow, x: number, y: number): { x: number; y: number } {
  // Anchor on the display the window currently overlaps, so a fixed position
  // is still recoverable after a monitor is unplugged.
  const area = screen.getDisplayMatching(win.getBounds()).workArea
  const [width, height] = win.getSize()
  const maxX = area.x + area.width - width - SCREEN_MARGIN
  const maxY = area.y + area.height - height - SCREEN_MARGIN
  return {
    x: Math.round(Math.max(area.x + SCREEN_MARGIN, Math.min(x, maxX))),
    y: Math.round(Math.max(area.y + SCREEN_MARGIN, Math.min(y, maxY)))
  }
}

/** Pops up next to the pointer, on whichever display the pointer is on. */
function placeAtCursor(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(cursor).workArea
  const [width, height] = win.getSize()

  let y = cursor.y + CURSOR_GAP
  // Flip above the cursor when there is not enough room below.
  if (y + height > area.y + area.height) y = cursor.y - height - CURSOR_GAP

  const wanted = {
    x: Math.round(cursor.x - width / 2),
    y: Math.round(y)
  }
  moveTo(win, clampToWorkArea(win, wanted.x, wanted.y))
}

/** Dead centre of whichever display the pointer is on. */
function placeAtCenter(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(cursor).workArea
  const [width, height] = win.getSize()
  const wanted = {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2)
  }
  moveTo(win, clampToWorkArea(win, wanted.x, wanted.y))
}

function placeAtFixed(win: BrowserWindow, point: { x: number; y: number }): void {
  moveTo(win, clampToWorkArea(win, point.x, point.y))
}

function moveTo(win: BrowserWindow, point: { x: number; y: number }): void {
  autoPosition = point
  win.setPosition(point.x, point.y, false)
}

/**
 * Shrink the window to its content. A single entry used to leave 300px of
 * empty panel below it, which read as a broken layout rather than as
 * breathing room.
 */
let lastContentHeight = 0

export function resizeLauncherToContent(contentHeight: number): void {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return
  lastContentHeight = Math.round(
    Math.min(LAUNCHER_HEIGHT, Math.max(LAUNCHER_MIN_HEIGHT, contentHeight + LAUNCHER_FOOTER))
  )
  if (!launcher || launcher.isDestroyed() || !ready) return
  const [, current] = launcher.getSize()
  // Small deltas are not worth a resize, and avoiding them keeps typing from
  // making the window twitch on every keystroke.
  if (Math.abs(current - lastContentHeight) < 8) return
  launcher.setSize(LAUNCHER_WIDTH, lastContentHeight, false)
  // Growing downwards could push the bottom past the taskbar.
  clampLauncherIntoView()
}

function clampLauncherIntoView(): void {
  if (!launcher || launcher.isDestroyed()) return
  const [x, y] = launcher.getPosition()
  moveTo(launcher, clampToWorkArea(launcher, x, y))
}

export function showLauncher(): void {
  if (!launcher || launcher.isDestroyed()) return
  // A hold left over from a previous launch must not apply to this one.
  holdBlurUntil = 0
  if (holdTimer) {
    clearTimeout(holdTimer)
    holdTimer = null
  }
  if (launcher.isMinimized()) launcher.restore()
  if (!ready) {
    launcher.once('ready-to-show', () => showLauncher())
    return
  }
  // Apply the height the content asked for *before* placing, so the first
  // frame is already the right size and the flip-above logic sees it.
  if (lastContentHeight > 0) launcher.setSize(LAUNCHER_WIDTH, lastContentHeight, false)

  if (placement.mode === 'fixed' && placement.point) {
    placeAtFixed(launcher, placement.point)
  } else if (placement.mode === 'center') {
    placeAtCenter(launcher)
  } else {
    placeAtCursor(launcher)
  }
  launcher.show()
  launcher.focus()
  launcher.webContents.send('launcher:shown')
}

export function hideLauncher(): void {
  flushPlacement()
  if (launcher && !launcher.isDestroyed()) launcher.hide()
}

export function toggleLauncher(): void {
  if (launcher && !launcher.isDestroyed() && launcher.isVisible() && launcher.isFocused()) {
    hideLauncher()
  } else {
    showLauncher()
  }
}

export function showSettings(): void {
  // The launcher floats above ordinary windows, so it would cover the settings
  // window and survive its close button.
  hideLauncher()
  const win = createSettings()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function closeSettings(): void {
  if (settings && !settings.isDestroyed()) settings.hide()
}

export function flushPendingPlacement(): void {
  flushPlacement()
}

export function getLauncherWindow(): BrowserWindow | null {
  return launcher && !launcher.isDestroyed() ? launcher : null
}

export function setCloseOnBlur(value: boolean): void {
  closeOnBlur = value
}

/**
 * Keeps the launcher on screen for `ms`, ignoring the blur that the newly
 * opened terminal causes.
 *
 * The hold is a promise that the renderer will call releaseLauncherHold() once
 * its confirmation is readable. It also expires on its own, because a renderer
 * that never reports back (a reload mid-launch, say) would otherwise leave the
 * window stuck on top with nothing to dismiss it.
 */
export function holdLauncherOnBlur(ms: number): void {
  holdBlurUntil = Date.now() + ms
  if (holdTimer) clearTimeout(holdTimer)
  holdTimer = setTimeout(() => {
    holdTimer = null
    holdBlurUntil = 0
    enforceCloseOnBlur()
  }, ms + 60)
}

export function releaseLauncherHold(): void {
  holdBlurUntil = 0
  if (holdTimer) {
    clearTimeout(holdTimer)
    holdTimer = null
  }
  // The blur that was ignored has already happened and will not fire again, so
  // the rule has to be applied by hand or the launcher would never close.
  enforceCloseOnBlur()
}

function enforceCloseOnBlur(): void {
  if (!closeOnBlur || !launcher || launcher.isDestroyed() || launcher.isFocused()) return
  if (settingsFocused()) return
  hideLauncher()
}

export function getPlacement(): LauncherPlacement {
  return placement
}

/** 'cursor' and 'center' both forget a stored point; 'fixed' keeps the current spot. */
export function setPlacementMode(mode: PlacementMode): LauncherPlacement {
  if (mode === 'fixed') {
    if (!placement.point && launcher && !launcher.isDestroyed()) {
      const [x, y] = launcher.getPosition()
      placement = { mode, point: { x, y } }
    } else {
      placement = { ...placement, mode }
    }
  } else {
    placement = { mode, point: null }
  }
  onPlacementChanged?.(placement)
  return placement
}

export function initPlacement(saved: LauncherPlacement): void {
  placement = saved
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const win of [launcher, settings]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function trayIcon(): Electron.NativeImage {
  return nativeImageFrom(TRAY_ICON_BASE64)
}

function nativeImageFrom(base64: string): Electron.NativeImage {
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${base64}`)
  // Tray icons are small; keep them at tray size instead of letting Windows
  // pick a larger variant from the embedded 256px source.
  return image.resize({ width: 32, height: 32 })
}


