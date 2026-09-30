/**
 * Checks the two main-process changes behind the launcher's save row:
 * a directory that is not there can no longer become a saved entry, and a new
 * entry defaults to the same shell the launcher would have opened it with.
 *
 * Run: npm run verify:quickadd
 */
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const require = createRequire(import.meta.url)

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const userData = mkdtempSync(join(tmpdir(), 'termhop-quickadd-'))
globalThis.__ELECTRON_APP_STUB__ = {
  isPackaged: true,
  getPath: () => userData,
  getAppPath: () => userData
}

const sandbox = mkdtempSync(join(tmpdir(), 'termhop-quickadd-dirs-'))
const realDir = join(sandbox, 'real-project')
mkdirSync(realDir)
const aFile = join(sandbox, 'not-a-dir.txt')
writeFileSync(aFile, 'x')

const bundleDir = join(ROOT, 'node_modules', '.termhop-verify')
mkdirSync(bundleDir, { recursive: true })
const bundlePath = join(bundleDir, 'quickadd.cjs')

buildSync({
  entryPoints: [join(ROOT, 'src', 'main', 'config.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias: {
    '@shared': join(ROOT, 'src', 'shared'),
    electron: join(ROOT, 'scripts', 'stubs', 'electron.mjs')
  },
  logLevel: 'silent'
})

const { addEntryToConfig, defaultConfig, isDirectory, loadConfig } = require(bundlePath)

// Built separately because config.ts imports it; requiring it through the same
// bundle would prove nothing about the shared order.
const shellsPath = join(bundleDir, 'shells.cjs')
buildSync({
  entryPoints: [join(ROOT, 'src', 'main', 'shells.ts')],
  outfile: shellsPath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias: { '@shared': join(ROOT, 'src', 'shared') },
  logLevel: 'silent'
})
const { preferredShell } = require(shellsPath)

try {
  console.log('\n1. a directory that is not there cannot be saved')

  const base = defaultConfig()
  const missing = addEntryToConfig(base, { path: join(sandbox, 'nope', 'gone') })
  check('a missing path is refused', !missing.ok, missing.error)
  check(
    'nothing was written to the config',
    missing.config.entries.length === 0,
    `${missing.config.entries.length} entries`
  )

  const notDir = addEntryToConfig(base, { path: aFile })
  check('a file is refused', !notDir.ok, notDir.error)
  check('a file is named as such', /不是一个目录/.test(notDir.error ?? ''), notDir.error)

  console.log('\n2. a real directory is saved, with the shell the launcher would pick')

  const shell = preferredShell()
  check('a preferred shell exists on this machine', shell !== null, String(shell))

  const good = addEntryToConfig(base, { path: realDir })
  check('a real directory is accepted', good.ok, good.error)
  check(
    'it defaults to the launcher\'s shell choice, not a hardcoded powershell',
    good.ok && good.config.entries[0].defaultShell === shell,
    `entry=${good.config.entries[0]?.defaultShell} launcher=${shell}`
  )
  check(
    'it has no title, so the folder name is shown',
    good.ok && good.config.entries[0].title === '',
    good.config.entries[0]?.title
  )

  const explicit = addEntryToConfig(base, { path: realDir, defaultShell: 'cmd' })
  check('an explicit shell is still honoured', explicit.ok && explicit.config.entries[0].defaultShell === 'cmd')

  console.log('\n3. saving twice is still a duplicate')

  const again = addEntryToConfig(good.config, { path: realDir })
  check('the same directory twice is refused', !again.ok, again.error)

  const trailing = addEntryToConfig(good.config, { path: `${realDir}\\` })
  check('a trailing backslash is the same directory', !trailing.ok, trailing.error)

  console.log('\n4. isDirectory is a plain check, not a resolver')

  check('a real directory is a directory', isDirectory(realDir))
  check('a file is not a directory', !isDirectory(aFile))
  check('a missing path is not a directory', !isDirectory(join(sandbox, 'nope')))

  console.log('\n5. the real loader still works with the shared config')

  const loaded = loadConfig()
  check('a fresh config loads', Array.isArray(loaded.entries), `${loaded.entries.length} entries`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
