/**
 * Verification of the launcher's keyboard shortcuts.
 *
 * The shortcut layer lives in the renderer, and every one of its bugs is a
 * logic bug: a key that is advertised in the footer and does something else,
 * or nothing at all. Reading the source proves what the code *says*; this
 * suite drives the real component with real key events and records what it
 * actually tried to do.
 *
 * The component is mounted as-is. Only the IPC surface is faked, so no
 * terminal is ever spawned on the developer's machine and the assertions can
 * be about intent — "it asked to open this entry with this target" — rather
 * than about what a shell did with it.
 *
 * Run with:  npm run verify:shortcuts
 */
const { app, BrowserWindow } = require('electron')
const { build } = require('esbuild')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'node_modules', '.termhop-verify')
const HARNESS_DIR = path.join(ROOT, 'scripts', 'harnesses')

// A throwaway profile, so the run does not leave Chromium files in the
// developer's real %APPDATA%. It lives under node_modules so it is covered
// by the ignore rules instead of littering the temp dir.
const PROFILE_DIR = path.join(OUT_DIR, 'profile')
app.setPath('userData', PROFILE_DIR)
app.setPath('sessionData', path.join(PROFILE_DIR, 'session'))

let failures = 0
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failures++
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}
const check = (label, condition, detail = '') =>
  condition ? ok(label, detail) : bad(label, detail)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------- the bundle */

async function bundle() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await build({
    entryPoints: [path.join(HARNESS_DIR, 'shortcut-harness.tsx')],
    outfile: path.join(OUT_DIR, 'shortcut-harness.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome130',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    alias: { '@shared': path.join(ROOT, 'src', 'shared') },
    logLevel: 'silent'
  })
  fs.copyFileSync(
    path.join(HARNESS_DIR, 'shortcut-harness.html'),
    path.join(OUT_DIR, 'shortcut-harness.html')
  )
}

/* ------------------------------------------------------------- the driver */

/** Sends a real key press, modifiers and all. */
async function press(win, key, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
  await sleep(140)
}

/** Types into the focused field, the way a paste would. */
async function type(win, text) {
  await win.webContents.executeJavaScript(
    `document.querySelector('.search').focus()`
  )
  win.webContents.insertText(text)
  await sleep(180)
}

async function state(win) {
  return win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.row')]
    const selected = rows.findIndex((row) => row.classList.contains('selected'))
    return {
      calls: window.__calls.slice(),
      footer: document.querySelector('.footer')?.textContent ?? '',
      titles: rows.map((row) => row.querySelector('.row-title')?.textContent ?? ''),
      selected,
      selectedTitle: selected >= 0 ? rows[selected].querySelector('.row-title')?.textContent ?? '' : null,
      input: document.querySelector('.search')?.value ?? ''
    }
  })()`)
}

/**
 * Puts the launcher back the way the main process leaves it before every
 * show: empty query, nothing selected, no launch in flight.
 */
async function reset(win) {
  await win.webContents.executeJavaScript(`(() => {
    window.__calls = []
    window.__emit('launcher:shown')
  })()`)
  await sleep(160)
}

/** Every recorded call to one name, in order. */
const callsTo = (state, name) => state.calls.filter((call) => call.name === name)

async function waitForRows(win) {
  for (let i = 0; i < 80; i++) {
    const ready = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.row').length > 0`
    )
    if (ready) return true
    await sleep(100)
  }
  return false
}

/* ------------------------------------------------------------------ tests */

async function run(win) {
  console.log('\n1. Enter opens the selected entry with the shell it last used')
  await reset(win)
  await press(win, 'Enter')
  let now = await state(win)
  check(
    'Enter asks to open the first entry',
    callsTo(now, 'openEntry').some(
      (call) => call.args[0] === 'e-agency' && call.args[1] === 'last'
    ),
    JSON.stringify(callsTo(now, 'openEntry'))
  )
  check('and it does not open the settings window', callsTo(now, 'openSettings').length === 0)

  console.log('\n2. Shift+Enter opens the shell picker instead of opening anything')
  await reset(win)
  await press(win, 'Enter', ['shift'])
  now = await state(win)
  check('nothing is opened yet', callsTo(now, 'openEntry').length === 0)
  check(
    'the list is now the shell picker',
    now.titles.length > 0 && now.titles.every((title) => /PowerShell|Command|Terminal/i.test(title)),
    JSON.stringify(now.titles)
  )
  check('and the footer describes the picker', /选择|直选/.test(now.footer), now.footer)

  console.log('\n3. Enter in the picker opens the entry with the chosen shell')
  await press(win, 'Enter')
  now = await state(win)
  check(
    'the picked shell is passed through as the target',
    callsTo(now, 'openEntry').some(
      (call) => call.args[0] === 'e-agency' && call.args[1] === 'pwsh'
    ),
    JSON.stringify(callsTo(now, 'openEntry'))
  )

  console.log('\n4. Alt+Enter reveals the folder instead of opening a terminal')
  await reset(win)
  await press(win, 'Enter', ['alt'])
  now = await state(win)
  check(
    'Alt+Enter asks to reveal the entry',
    callsTo(now, 'openEntry').some(
      (call) => call.args[0] === 'e-agency' && call.args[1] === 'reveal'
    ),
    JSON.stringify(callsTo(now, 'openEntry'))
  )
  check('and it does not fall back to a terminal', callsTo(now, 'openPath').length === 0)

  console.log('\n5. Ctrl+N adds, with an empty box')
  await reset(win)
  const before = await state(win)
  await press(win, 'n', ['control'])
  now = await state(win)
  check(
    'Ctrl+N opens the settings add form',
    callsTo(now, 'openSettings').length === 1,
    JSON.stringify(callsTo(now, 'openSettings'))
  )
  check('and it does not open an entry', callsTo(now, 'openEntry').length === 0)
  check(
    'and it does not move the selection',
    now.selected === before.selected,
    `${before.selected} -> ${now.selected}`
  )

  console.log('\n6. Ctrl+N saves the path that is typed')
  await reset(win)
  await type(win, './new')
  now = await state(win)
  check('the typed path reaches the input', now.input === './new', now.input)
  check(
    'a save row is offered',
    now.titles.length === 2 && now.titles.every((title) => title === './new'),
    JSON.stringify(now.titles)
  )
  await press(win, 'n', ['control'])
  now = await state(win)
  check(
    'Ctrl+N saves that path',
    callsTo(now, 'addEntry').some(
      (call) => call.args[0].path === './new' && call.args[0].defaultShell === 'pwsh'
    ),
    JSON.stringify(callsTo(now, 'addEntry'))
  )
  check('and it does not open the settings window', callsTo(now, 'openSettings').length === 0)

  console.log('\n7. the footer advertises exactly these four shortcuts')
  await reset(win)
  now = await state(win)
  const footer = now.footer.replace(/\s+/g, '')
  check('Enter 打开', footer.includes('Enter打开'), now.footer)
  check('Shift+Enter 选shell', footer.includes('Shift+Enter选shell'), now.footer)
  check('Alt+Enter 打开文件夹', footer.includes('Alt+Enter打开文件夹'), now.footer)
  check('Ctrl+N 添加', footer.includes('Ctrl+N添加'), now.footer)

  console.log('\n8. the README table agrees with the footer')
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const table = readme.split('\n').filter((line) => line.trim().startsWith('|'))
  // The table is hand-written, and it spells the same shortcut two ways:
  // "`Ctrl`+`N`" in one row and "`Ctrl` + `N`" in another. Whitespace is
  // normalised before matching, or the duplicate slips past.
  const norm = (line) => line.replace(/\s+/g, '')
  for (const key of ['`Enter`', '`Shift`+`Enter`', '`Alt`+`Enter`', '`Ctrl`+`N`']) {
    check(
      `the README documents ${key.replace(/`/g, '')}`,
      table.some((line) => norm(line).includes(key)),
      key
    )
  }
  // One key, one meaning. The README used to list Ctrl+N twice: once as
  // "move one row down" and once as "add an entry". That contradiction is
  // the bug this whole suite exists for.
  const ctrlN = table.filter((line) => norm(line).includes('`Ctrl`+`N`'))
  check('Ctrl+N is documented exactly once', ctrlN.length === 1, `${ctrlN.length} rows`)
  const ctrlP = table.filter((line) => norm(line).includes('`Ctrl`+`P`'))
  check('Ctrl+P is documented exactly once', ctrlP.length === 1, `${ctrlP.length} rows`)
}

/* ------------------------------------------------------------------- main */

app.whenReady().then(async () => {
  try {
    await bundle()

    const win = new BrowserWindow({
      width: 680,
      height: 470,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })

    await win.loadFile(path.join(OUT_DIR, 'shortcut-harness.html'))
    if (!(await waitForRows(win))) throw new Error('the launcher never rendered any row')

    await run(win)
  } catch (err) {
    failures++
    console.error(err)
  }

  console.log('\n' + (failures ? `${failures} check(s) failed` : 'all checks passed'))
  app.exit(failures ? 1 : 0)
})
