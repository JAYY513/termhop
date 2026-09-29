/**
 * Unit verification of the launcher / settings window behaviour.
 *
 * These are the bugs this project actually had, and all of them are logic
 * bugs rather than rendering bugs, so they can be asserted against a fake
 * electron module instead of by clicking:
 *
 *   - the launcher is always-on-top 'floating', so it covered the settings
 *     window and survived its close button
 *   - closing settings destroyed the window, losing whatever was being typed
 *   - a drag was pointless because the position was recomputed from the
 *     pointer on every show
 *
 * Run with:  node scripts/verify-window.mjs
 */
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const require = createRequire(import.meta.url)

let failures = 0
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failures++
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}
const check = (label, condition, detail = '') =>
  condition ? ok(label, detail) : bad(label, detail)

/* ------------------------------------------------- fake electron runtime */

const created = []

class FakeWebContents {
  constructor() {
    this.sent = []
  }
  send(channel, payload) {
    this.sent.push([channel, payload])
  }
}

class FakeBrowserWindow {
  constructor(options = {}) {
    this.options = options
    this.events = new Map()
    this.visible = false
    this.destroyed = false
    this.minimized = false
    this.focused = false
    this.pos = { x: 100, y: 200 }
    this.size = { width: options.width ?? 800, height: options.height ?? 600 }
    this.webContents = new FakeWebContents()
    this.loaded = null
    created.push(this)
  }
  on(event, handler) {
    if (!this.events.has(event)) this.events.set(event, [])
    this.events.get(event).push(handler)
    return this
  }
  once(event, handler) {
    return this.on(event, handler)
  }
  emit(event, ...args) {
    for (const handler of this.events.get(event) ?? []) handler(...args)
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setMenuBarVisibility() {}
  setMinimumSize(w, h) {
    this.minSize = { width: w, height: h }
  }
  setMaximumSize(w, h) {
    this.maxSize = { width: w, height: h }
  }
  isResizable() {
    return this.options.resizable !== false
  }
  setSize(w, h) {
    // Electron ignores setSize on a window created with resizable:false, and
    // the fake has to model that, or the bug it caused stays invisible.
    if (this.options.resizable === false) return
    this.size = { width: w, height: h }
  }
  setPosition(x, y) {
    this.pos = { x, y }
    this.emit('moved')
  }
  getPosition() {
    return [this.pos.x, this.pos.y]
  }
  getSize() {
    return [this.size.width, this.size.height]
  }
  getBounds() {
    return { x: this.pos.x, y: this.pos.y, ...this.size }
  }
  show() {
    this.visible = true
  }
  hide() {
    this.visible = false
  }
  focus() {
    this.focused = true
  }
  isFocused() {
    return this.focused
  }
  isVisible() {
    return this.visible
  }
  isMinimized() {
    return this.minimized
  }
  restore() {
    this.minimized = false
  }
  isDestroyed() {
    return this.destroyed
  }
  close() {
    this.emit('close', { preventDefault: () => { this.defaultPrevented = true } })
    if (!this.defaultPrevented) this.destroyed = true
  }
  async loadFile(...args) {
    this.loaded = args
  }
  async loadURL(...args) {
    this.loaded = args
  }
}

const PRIMARY = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const SECOND = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }

const screen = {
  cursor: { x: 500, y: 300 },
  getCursorScreenPoint() {
    return this.cursor
  },
  getDisplayNearestPoint(point) {
    return point.x >= PRIMARY.workArea.width ? SECOND : PRIMARY
  },
  getDisplayMatching() {
    return PRIMARY
  }
}

const nativeImage = {
  createFromDataURL: () => ({ resize: () => ({}), setTemplateImage: () => {} })
}

const bundleDir = join(ROOT, 'node_modules', '.termhop-verify')
mkdirSync(bundleDir, { recursive: true })
const bundlePath = join(bundleDir, 'window.cjs')

buildSync({
  entryPoints: [join(ROOT, 'src', 'main', 'window.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias: {
    '@shared': join(ROOT, 'src', 'shared'),
    // esbuild's sync API refuses plugins, so the fake is swapped in by alias.
    electron: join(ROOT, 'scripts', 'stubs', 'window-electron.mjs')
  },
  define: { __ELECTRON_FAKE__: 'globalThis.__ELECTRON_FAKE__' },
  logLevel: 'silent'
})

globalThis.__ELECTRON_FAKE__ = { BrowserWindow: FakeBrowserWindow, screen, nativeImage }
const win = require(bundlePath)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ tests */

console.log('\n1. opening settings must hide the launcher')
win.initPlacement({ mode: 'cursor', point: null })
win.createLauncher().emit('ready-to-show')
win.showLauncher()
check('the launcher is visible before settings opens', win.getLauncherWindow().isVisible())

win.showSettings()
check('the launcher is hidden after settings opens', !win.getLauncherWindow().isVisible(),
  'it used to float above the settings window')

console.log('\n2. closing settings must not destroy it')
const settingsWin = created[created.length - 1]
check('the settings window exists', Boolean(settingsWin))
settingsWin.focus()
settingsWin.close()
check('closing hides instead of destroying', settingsWin.isVisible() === false && !settingsWin.isDestroyed(),
  'destroying threw away the half-typed form')
const reopened = win.createSettings()
check('reopening reuses the same window', reopened === settingsWin)

console.log('\n3. a drag sticks')
win.hideLauncher()
win.showLauncher()
win.setPlacementMode('cursor')
const launcher = win.getLauncherWindow()
const before = launcher.getPosition()

// Simulate the user dragging by emitting 'moved' with new coordinates.
launcher.pos = { x: before[0] + 220, y: before[1] + 140 }
launcher.emit('moved')
check('a drag switches the launcher to a fixed position',
  win.getPlacement().mode === 'fixed', JSON.stringify(win.getPlacement()))
check('the dragged spot is remembered',
  win.getPlacement().point?.x === before[0] + 220 &&
    win.getPlacement().point?.y === before[1] + 140)

console.log('\n4. the code moving the window is not mistaken for a drag')
win.setPlacementMode('cursor')
win.showLauncher()
const cursor = launcher.getPosition()
check('the launcher moved to the cursor', cursor[0] === 500 - 680 / 2 && cursor[1] === 300 + 20,
  JSON.stringify(cursor))
check('but that is not recorded as a user drag', win.getPlacement().mode === 'cursor',
  JSON.stringify(win.getPlacement()))

console.log('\n5. a fixed position is clamped inside the work area')
win.setPlacementMode('fixed')
win.initPlacement({ mode: 'fixed', point: { x: 99999, y: 99999 } })
win.hideLauncher()
win.showLauncher()
const clamped = launcher.getPosition()
const area = PRIMARY.workArea
const MARGIN = 14
check('it never lands outside the work area',
  clamped[0] + 680 + MARGIN <= area.x + area.width &&
    clamped[1] + 470 + MARGIN <= area.y + area.height,
  JSON.stringify(clamped))
check('and it keeps a margin off the screen edge',
  clamped[0] === area.x + area.width - 680 - MARGIN &&
    clamped[1] === area.y + area.height - 470 - MARGIN,
  JSON.stringify(clamped))

console.log('\n5b. screen-centred mode')
win.initPlacement({ mode: 'center', point: null })
win.hideLauncher()
win.showLauncher()
const centred = launcher.getPosition()
check('it is centred on the pointer display',
  centred[0] === (area.width - 680) / 2 && centred[1] === (area.height - 470) / 2,
  JSON.stringify(centred))
check('centring does not switch to a fixed position', win.getPlacement().mode === 'center',
  JSON.stringify(win.getPlacement()))

console.log('\n6. switching away from fixed clears the point')
const cleared = win.setPlacementMode('cursor')
check('mode is cursor', cleared.mode === 'cursor')
check('the stored point is gone', cleared.point === null, JSON.stringify(cleared))
const centreOnly = win.setPlacementMode('center')
check('center also carries no point', centreOnly.point === null, JSON.stringify(centreOnly))

console.log('\n7. blur while settings is focused must not dismiss the launcher')
win.createSettings()
win.showLauncher()
const settings2 = created[created.length - 1]
settings2.focused = true
launcher.emit('blur')
check('the launcher stays open', launcher.isVisible(),
  'otherwise the launcher vanishes the moment settings takes focus')
settings2.focused = false
launcher.emit('blur')
check('and it dismisses once settings is not focused', !launcher.isVisible())

console.log('\n8. the window must be resizable for setSize to work at all')
check(
  'the launcher window is created resizable',
  launcher.options.resizable === true,
  'Electron silently ignores setSize() when this is false, which breaks height fitting'
)
check('its width is pinned', launcher.minSize?.width === 680 && launcher.maxSize?.width === 680,
  `${launcher.minSize?.width}..${launcher.maxSize?.width}`)
launcher.size = { width: 680, height: 470 }
win.resizeLauncherToContent(204)
check('the height follows the content', launcher.getSize()[1] === 244,
  `${launcher.getSize()[1]} for a 204px content`)
win.resizeLauncherToContent(2000)
check('a huge content height is capped', launcher.getSize()[1] === 470,
  `${launcher.getSize()[1]}`)
win.resizeLauncherToContent(10)
check('a tiny content height has a floor', launcher.getSize()[1] === 216,
  `${launcher.getSize()[1]}`)

console.log('\n' + (failures ? `${failures} check(s) failed` : 'all checks passed'))
process.exit(failures ? 1 : 0)
