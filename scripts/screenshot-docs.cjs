/**
 * Generates the launcher screenshot used in README.md.
 *
 * Runs the real built app against a throwaway profile seeded with demo data,
 * so the picture can never leak the developer's own directories. Rendered by
 * Electron itself, which is the only thing that can see through the frameless
 * transparent window the way a user does.
 *
 *   npm run build && npm run docs:shot
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'images')
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'out', 'main', 'index.js')

/** Demo profile. Paths are invented; none of them exist on this machine. */
function demoConfig() {
  const groups = [
    { id: 'g-work', name: '工作', order: 0 },
    { id: 'g-oss', name: '开源', order: 1 },
  ]
  // Kept to four so the panel fits inside its own 470px cap without a
  // scrollbar, and spread across all three shell labels the UI can show.
  const raw = [
    ['e-agency', 'Agency API', 'C:\\dev\\agency-api', 'g-work', 'pwsh', 'pwsh', 'npm run dev'],
    ['e-console', 'Console Web', 'C:\\dev\\console-web', 'g-work', 'powershell', null, null],
    ['e-shellx', 'shellx', 'C:\\dev\\shellx', 'g-oss', 'cmd', null, null],
    ['e-termhop', 'TermHop', 'C:\\dev\\termhop', 'g-oss', 'pwsh', 'pwsh', null],
  ]
  const entries = raw.map(([id, title, dir, groupId, def, last, initCmd], order) => ({
    id,
    title,
    path: dir,
    groupId,
    defaultShell: def,
    lastShell: last,
    initCmd,
    order,
  }))
  const now = Date.now()
  return {
    version: 1,
    // Deliberately obscure so the shot never fights the real install for a key.
    hotkey: 'CommandOrControl+Alt+F12',
    groups,
    entries,
    history: [
      { entryId: 'e-agency', shell: 'pwsh', at: now - 60_000 },
      { entryId: 'e-shellx', shell: 'cmd', at: now - 3_600_000 },
    ],
    trash: [],
    placement: { mode: 'center', point: null },
    settings: {
      restoreLastShell: true,
      closeOnBlur: true,
      launchOnStartup: false,
      maxHistory: 50,
      recentCount: 2,
    },
  }
}

// Kept inside node_modules rather than the system temp dir: the run leaves
// locked Chromium files behind, so the directory survives the process, and
// this way the leftover is covered by node_modules/ instead of littering
// the user's %TEMP%.
const PROFILE_DIR = path.join(PROJECT_ROOT, 'node_modules', '.termhop-shot')

function seedProfile() {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  fs.writeFileSync(path.join(PROFILE_DIR, 'config.json'), JSON.stringify(demoConfig(), null, 2))
  // Both paths must move off the developer's real profile before app ready.
  app.setPath('userData', PROFILE_DIR)
  app.setPath('sessionData', path.join(PROFILE_DIR, 'session'))
  return PROFILE_DIR
}

// Best effort. Electron still holds profile files while it is exiting, so this
// usually fails on the first run and succeeds the next time.
function cleanupProfile() {
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  } catch {
    // Ignored on purpose - the directory is disposable and git-ignored.
  }
}

app.on('will-quit', cleanupProfile)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function findLauncher() {
  for (let i = 0; i < 60; i += 1) {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) {
      if (win.webContents.isLoading()) {
        await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
      }
      return win
    }
    await delay(250)
  }
  throw new Error('launcher window never appeared')
}

async function main() {
  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error('out/main/index.js missing - run `npm run build` first')
  }

  seedProfile()
  require(MAIN_ENTRY)

  const win = await findLauncher()

  // The app starts hidden in the tray; force it up the way the hotkey would.
  win.setAlwaysOnTop(true, 'floating')
  win.show()
  win.focus()
  // The window is transparent:true, but the renderer paints its own opaque
  // backdrop, so capturePage comes back with a solid panel already - nothing
  // to fake. Give the height fitting a beat to settle before grabbing.
  await delay(600)

  const size = win.getContentSize()
  const image = await win.webContents.capturePage()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = path.join(OUT_DIR, 'launcher.png')
  fs.writeFileSync(out, image.toPNG())

  console.log(`saved ${out} (${size[0]}x${size[1]})`)
  // app.exit() skips will-quit, so clean up here too.
  cleanupProfile()
  app.exit(0)
}

app.whenReady().then(main).catch((err) => {
  console.error(err)
  cleanupProfile()
  app.exit(1)
})
