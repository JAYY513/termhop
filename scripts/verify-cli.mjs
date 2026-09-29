/**
 * End-to-end verification of the `termhop` command line tool.
 *
 * Two layers:
 *   A. the real cli.ts logic, loaded with a stubbed `electron` module, so the
 *      generated shim is tested as the exact bytes that ship
 *   B. the packaged exe, driven for real: add, duplicate, missing path, open,
 *      and the second-instance relay when a GUI instance is already running
 *
 * Run with:  node scripts/verify-cli.mjs [path-to-exe]
 */
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  countProcs,
  killAll,
  restoreLoginItem,
  snapshotLoginItem,
  waitForNoProcs,
  waitForProcs
} from './testkit.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const require = createRequire(import.meta.url)
const EXE =
  process.argv[2] ?? join(ROOT, 'release', 'win-unpacked', 'TermHop.exe')

let failures = 0
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failures++
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}
const check = (label, condition, detail = '') =>
  condition ? ok(label, detail) : bad(label, detail)

/* ------------------------------------------- A. load the real cli module */

const userData = mkdtempSync(join(tmpdir(), 'termhop-cli-'))
globalThis.__ELECTRON_APP_STUB__ = {
  isPackaged: true,
  getPath: (name) => (name === 'userData' ? userData : userData),
  getAppPath: () => userData
}

const bundleDir = join(ROOT, 'node_modules', '.termhop-verify')
mkdirSync(bundleDir, { recursive: true })
const bundlePath = join(bundleDir, 'cli.cjs')

buildSync({
  entryPoints: [join(ROOT, 'src', 'main', 'cli.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias: {
    '@shared': join(ROOT, 'src', 'shared'),
    // esbuild's sync API refuses plugins, so the stub is swapped in by alias.
    electron: join(ROOT, 'scripts', 'stubs', 'electron.mjs')
  },
  logLevel: 'silent'
})

const cli = require(bundlePath)

console.log('\n1. argv parsing')

check('no arguments is not a CLI invocation', cli.parseCli(['TermHop.exe']) === null)
check(
  'first argument decides, so a folder named "add" cannot fake a command',
  cli.parseCli(['TermHop.exe', 'add']).kind === 'add' &&
    cli.parseCli(['TermHop.exe', 'D:\\add', 'add']) === null
)
check('add with no target falls back to the working directory',
  cli.parseCli(['TermHop.exe', 'add']).target === undefined)
check('add with a target keeps it', cli.parseCli(['TermHop.exe', 'add', 'D:\\x']).target === 'D:\\x')
check('open without a name is not a command', cli.parseCli(['TermHop.exe', 'open']) === null)
check('help is recognised', cli.parseCli(['TermHop.exe', 'help']).kind === 'help')
check(
  'a Chromium switch in first position starts the GUI, not an error',
  cli.parseCli(['TermHop.exe', '--user-data-dir', 'C:\\x']) === null
)
check(
  'a Chromium switch alongside a verb does not confuse parsing',
  cli.parseCli(['TermHop.exe', 'add', 'D:\\x', '--user-data-dir', 'C:\\y']).target === 'D:\\x'
)

console.log('\n2. entry matching')

const fakeConfig = {
  entries: [
    { id: '1', title: 'Agency API', path: 'C:\\work\\agency', defaultShell: 'pwsh' },
    { id: '2', title: '', path: 'C:\\work\\agency-web', defaultShell: 'pwsh' },
    { id: '3', title: 'TermHop', path: 'C:\\src\\ter', defaultShell: 'pwsh' }
  ]
}
check('matches an exact title', cli.matchEntry(fakeConfig, 'agency api')?.id === '1')
check('falls back to the folder name', cli.matchEntry(fakeConfig, 'agency-web')?.id === '2')
check('matches a path tail', cli.matchEntry(fakeConfig, 'src\\ter')?.id === '3')
check('refuses an ambiguous prefix instead of guessing', cli.matchEntry(fakeConfig, 'age') === null)
check('empty query matches nothing', cli.matchEntry(fakeConfig, '   ') === null)

console.log('\n3. generated shim')

// Under the stub the real process is node, but the shim must point at TermHop.
const realExecPath = process.execPath
process.execPath = EXE
const installed = await cli.installCli()
process.execPath = realExecPath
check('shim is written', existsSync(installed.shimPath), installed.shimPath)

const shimBytes = readFileSync(installed.shimPath)
const shimText = shimBytes.toString('latin1')
check(
  'shim is pure ASCII (cmd.exe parses it with the OEM code page)',
  shimBytes.every((b) => b < 0x80),
  shimText.split('\n').find((l) => /[^\x00-\x7f]/.test(l)) ?? 'all bytes < 0x80'
)
check('shim dispatches the add verb', /if \/i "%~1"=="add" goto add/.test(shimText))
check('shim uses CRLF line endings', shimText.includes('\r\n'))
check(
  'shim calls the exe without "start", so the cwd survives',
  !/^\s*start\b/m.test(shimText)
)
check('shim prints its own output because the exe has no console',
  /echo Added\./.test(shimText) && /:failed/.test(shimText))

/* ------------------------------------------- B. drive the packaged exe */

// This suite starts real app instances, and an instance whose config happens
// to have launchOnStartup enabled will register a login item as a side effect.
// That is not what this suite is testing, so the registry is snapshotted and
// put back.
const loginItemBefore = snapshotLoginItem()

// Nothing may be running before the first invocation, or it quits immediately
// because another instance holds the single-instance lock and every assertion
// below then "passes" with an exit code that means nothing.
check('no TermHop was running before the test', await waitForNoProcs())

if (!existsSync(EXE)) {
  console.log(`\n4. packaged exe — SKIPPED, not found at ${EXE}`)
  console.log('    run `npm run dist` first to test this part')
} else {
  console.log(`\n4. packaged exe (${EXE})`)

  const run = (args, options = {}) =>
    spawnSync(EXE, args, { encoding: 'utf8', timeout: 40_000, ...options })

  // The real exe always writes to the real profile: --user-data-dir is not
  // applied on the early-exit CLI path. So the whole run is done against the
  // real config, with a snapshot taken first and restored at the end. A test
  // must never leave state behind in the user's config.
  const configPath = join(process.env.APPDATA ?? '', 'TermHop', 'config.json')
  const hadConfig = existsSync(configPath)
  const configBefore = hadConfig ? readFileSync(configPath, 'utf8') : null
  const restoreConfig = () => {
    if (hadConfig && configBefore !== null) writeFileSync(configPath, configBefore, 'utf8')
    else if (existsSync(configPath)) rmSync(configPath, { force: true })
  }
  const readConfig = () => {
    try {
      return JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      return null
    }
  }

  const target = mkdtempSync(join(tmpdir(), 'termhop-add target '))
  const second = mkdtempSync(join(tmpdir(), 'termhop-relay target '))

  // Count deltas, never absolute counts: the user may already have entries.
  const entriesBefore = readConfig()?.entries?.length ?? 0
  const findEntry = (config, path) =>
    (config?.entries ?? []).find((e) => resolve(e.path) === resolve(path))

  const added = run(['add', target])
  check('add succeeds with no GUI running', added.status === 0, `exit ${added.status}`)
  let config = readConfig()
  check('exactly one entry was added',
    config?.entries?.length === entriesBefore + 1,
    `${entriesBefore} -> ${config?.entries?.length}`)
  const addedEntry = findEntry(config, target)
  check('the new entry is the one that was asked for', Boolean(addedEntry))
  check('the path is stored absolute and normalised',
    addedEntry?.path === resolve(target), addedEntry?.path)
  check('a new entry starts with no remembered shell', addedEntry?.lastShell === null)

  const duplicate = run(['add', target])
  check('adding the same directory twice is refused', duplicate.status === 1, `exit ${duplicate.status}`)

  const missing = run(['add', join(target, 'does-not-exist')])
  check('adding a missing folder fails', missing.status === 1, `exit ${missing.status}`)

  const helpRun = run(['help'])
  check('help exits cleanly', helpRun.status === 0, `exit ${helpRun.status}`)

  // `open` with no match must not launch anything, so it is safe to assert.
  const openMiss = run(['open', 'definitely-not-a-saved-entry'])
  check('open with no match fails cleanly', openMiss.status === 1, `exit ${openMiss.status}`)

  // The shim is what users actually type, and it is the only thing with a
  // console, so its output and exit code are what they see.
  const shimRun = spawnSync('cmd.exe', ['/c', installed.shimPath, 'add', second], {
    encoding: 'utf8',
    timeout: 40_000
  })
  check('shim reports success', /Added\./.test(shimRun.stdout ?? ''),
    JSON.stringify(shimRun.stdout ?? shimRun.stderr))
  check('shim exits 0 on success', shimRun.status === 0, `exit ${shimRun.status}`)
  config = readConfig()
  check('shim added the directory it was given', Boolean(findEntry(config, second)))

  const shimUnknown = spawnSync('cmd.exe', ['/c', installed.shimPath, 'frobnicate'], {
    encoding: 'utf8',
    timeout: 20_000
  })
  check('shim rejects an unknown verb with the usage code', shimUnknown.status === 2, `exit ${shimUnknown.status}`)
  check('shim explains the unknown verb itself',
    /unknown command/.test(shimUnknown.stdout ?? ''), JSON.stringify(shimUnknown.stdout))

  const shimHelp = spawnSync('cmd.exe', ['/c', installed.shimPath, 'help'], {
    encoding: 'utf8',
    timeout: 20_000
  })
  check('shim prints its own help and exits 0',
    /termhop add/.test(shimHelp.stdout ?? '') && shimHelp.status === 0, `exit ${shimHelp.status}`)

  // Regression: an unrecognised first argument must start the GUI, because
  // Chromium switches land in argv[1] too.
  await waitForNoProcs()
  // stderr is kept so that "it exited immediately" can be explained rather
  // than just observed.
  const bareLog = []
  const bare = spawn(EXE, ['--user-data-dir', userData], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  bare.stderr.on('data', (chunk) => bareLog.push(String(chunk).trim()))
  await new Promise((r) => setTimeout(r, 6000))
  check(
    'a switch in first position starts the GUI instead of exiting',
    bare.exitCode === null,
    `exit ${bare.exitCode}${bareLog.length ? ` — ${bareLog.join(' / ').slice(0, 300)}` : ''}`
  )
  killAll()
  await waitForNoProcs()

  // Second-instance relay: with a GUI alive, the CLI must not start a second
  // app, it must hand its argv over and let the running instance write.
  check('no TermHop is running before the relay test', await waitForNoProcs())
  spawnSync('cmd.exe', ['/c', 'start', '', EXE], { encoding: 'utf8', timeout: 30_000 })
  check('the GUI instance came up', await waitForProcs())

  const before = countProcs()
  check('a GUI instance is running for the relay test', before >= 1, `${before} process(es)`)

  const relayed = run(['add', second])
  check('relayed add still exits 0', relayed.status === 0, `exit ${relayed.status}`)
  await new Promise((r) => setTimeout(r, 2500))

  const after = countProcs()
  check('the CLI did not start a second app', after === before, `${before} -> ${after}`)
  config = readConfig()
  check('the running instance wrote the relayed entry', Boolean(findEntry(config, second)),
    `entries: ${config?.entries?.length}`)

  // Clean up the GUI instance we started, then put both the config and the
  // registry back.
  killAll()
  await waitForNoProcs()
  restoreConfig()
  await restoreLoginItem(loginItemBefore)

  rmSync(target, { recursive: true, force: true })
  rmSync(second, { recursive: true, force: true })
}

rmSync(userData, { recursive: true, force: true })

console.log('\n' + (failures ? `${failures} check(s) failed` : 'all checks passed'))
process.exit(failures ? 1 : 0)


