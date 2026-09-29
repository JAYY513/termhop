/**
 * End-to-end verification of the "start with Windows" toggle.
 *
 * The claim under test is a real system claim: a value appears in
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run pointing at the exe, and
 * it disappears again when the toggle is turned off. That cannot be checked by
 * reading the code.
 *
 * The Run key and the config file are both snapshotted and restored, and only
 * the TermHop value is ever touched, never anyone else's startup entries.
 *
 * Run with:  node scripts/verify-autostart.mjs [path-to-exe]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RUN_KEY,
  RUN_VALUE,
  deleteLoginItem,
  forceCleanRegistry,
  killAll,
  readLoginItem,
  readLoginItemData,
  waitForNoProcs,
  writeLoginItem
} from './testkit.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const EXE = process.argv[2] ?? join(ROOT, 'release', 'win-unpacked', 'TermHop.exe')
const CONFIG = join(process.env.APPDATA ?? '', 'TermHop', 'config.json')

let failures = 0
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failures++
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}
const check = (label, condition, detail = '') =>
  condition ? ok(label, detail) : bad(label, detail)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))


function writeConfig(launchOnStartup) {
  writeFileSync(
    CONFIG,
    `${JSON.stringify(
      {
        version: 1,
        // A hotkey that will not collide with anything the test machine runs.
        hotkey: 'Ctrl+Alt+F12',
        groups: [],
        entries: [],
        history: [],
        trash: [],
        settings: {
          restoreLastShell: true,
          closeOnBlur: true,
          launchOnStartup,
          maxHistory: 200,
          recentCount: 5
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

if (!existsSync(EXE)) {
  console.log(`SKIPPED — exe not found at ${EXE}\nrun \`npm run dist\` first`)
  process.exit(0)
}

// --- snapshot -------------------------------------------------------------
const runValueBefore = readLoginItemData()
const hadConfig = existsSync(CONFIG)
const configBefore = hadConfig ? readFileSync(CONFIG, 'utf8') : null

// A previous suite may have left instances behind; start clean.
check('no TermHop was running before the test', await waitForNoProcs())
check('the registry starts without a leftover login item', !readLoginItem().present)

const restore = async () => {
  const clean = await forceCleanRegistry()
  if (!clean) {
    console.error(
      `\nWARNING: could not remove ${RUN_VALUE} from ${RUN_KEY}. ` +
        'Delete it manually:  reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v electron.app.TermHop /f'
    )
  }
  // Put the original value back, so a user who already had autostart on does
  // not lose it because of a test.
  if (runValueBefore) writeLoginItem(runValueBefore)
  if (hadConfig && configBefore !== null) writeFileSync(CONFIG, configBefore, 'utf8')
  else if (existsSync(CONFIG)) rmSync(CONFIG, { force: true })
}

try {
  console.log('\n1. autostart off by default')
  deleteLoginItem()
  writeConfig(false)
  let app = spawn(EXE, [], { stdio: 'ignore' })
  await sleep(7000)
  check('a fresh install registers nothing', !readLoginItem().present)
  killAll()
  await sleep(1500)

  console.log('\n2. autostart on')
  writeConfig(true)
  app = spawn(EXE, [], { stdio: 'ignore' })
  await sleep(7000)
  const value = readLoginItemData()
  check('a Run entry is written', value !== null, value ? RUN_VALUE : 'no value')
  if (value) {
    const line = value.split(/\r?\n/).find((l) => l.includes('TermHop')) ?? ''
    check('it points at this exe', line.toLowerCase().includes(EXE.toLowerCase()), line.trim())
    check('it carries the autostart flag', line.includes('--autostart'), line.trim())
  }
  killAll()
  await sleep(1500)

  console.log('\n3. autostart turned back off')
  writeConfig(false)
  app = spawn(EXE, [], { stdio: 'ignore' })
  await sleep(7000)
  check('the Run entry is removed again', !readLoginItem().present)
  killAll()
  await sleep(1500)

  console.log('\n4. the sign-in launch flag does not show a window')
  // A login launch must be silent. With no entries configured the launcher
  // stays hidden either way, so the check is that the process survives the
  // wait instead of exiting, and that no launcher window appeared.
  writeConfig(true)
  app = spawn(EXE, ['--autostart'], { stdio: 'ignore' })
  await sleep(7000)
  check('the process is still running after a sign-in style launch', app.exitCode === null,
    `exit ${app.exitCode}`)
  const windows = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', '(Get-Process TermHop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count'],
    { encoding: 'utf8' }
  ).stdout.trim()
  check('no window popped up on its own', windows === '0', `visible windows: ${windows}`)
  killAll()
  await sleep(1500)
} finally {
  killAll()
  await restore()
}

console.log('\n' + (failures ? `${failures} check(s) failed` : 'all checks passed'))
// Leaving a login item behind is itself a failure, not a footnote.
const finalRead = readLoginItem()
check('the registry is clean after the run', finalRead.ok && !finalRead.present,
  finalRead.ok ? RUN_VALUE : 'the registry could not be read')
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)



