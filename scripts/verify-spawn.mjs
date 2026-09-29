/**
 * Independent verification of the shell spawn layer.
 *
 * The interactive part of TermHop (window, hotkey, UI) cannot be asserted from
 * a script, but the risky part can: whether the command line we hand to
 * cmd.exe really starts the right shell in the right directory, with paths that
 * contain spaces and square brackets.
 *
 * Run with:  node scripts/verify-spawn.mjs
 */
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
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

/* ------------------------------------------------- load the real module */

const bundleDir = join(ROOT, 'node_modules', '.termhop-verify')
mkdirSync(bundleDir, { recursive: true })
const bundlePath = join(bundleDir, 'shells.cjs')

buildSync({
  entryPoints: [join(ROOT, 'src', 'main', 'shells.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias: { '@shared': join(ROOT, 'src', 'shared') },
  logLevel: 'silent'
})

const shells = require(bundlePath)
const { SHELLS, checkShells, launchShell, getShell } = shells

/* ------------------------------------------------------ argv assertions */

console.log('\n1. argv construction')

const uglyPath = 'C:\\work dir\\my [proj] (v2)'

for (const id of ['pwsh', 'powershell']) {
  const spec = getShell(id)
  const args = spec.build('unused', uglyPath, null)
  const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le')
  check(
    `${id}: encodes a Set-Location script`,
    args[0] === '-NoLogo' && args[1] === '-NoExit' && args[2] === '-EncodedCommand' &&
      script.includes("Set-Location -LiteralPath 'C:\\work dir\\my [proj] (v2)'"),
    script
  )
  check(`${id}: the payload has no quotes to misparse`, !script.includes('"'))
}

const cmdSpec = getShell('cmd')
const cmdArgs = cmdSpec.build('unused', uglyPath, null)
check(
  'cmd: uses cd /d with the path as its own argument',
  cmdArgs[0] === '/k' && cmdArgs[1] === 'cd' && cmdArgs[2] === '/d' && cmdArgs[3] === uglyPath,
  JSON.stringify(cmdArgs)
)

const wtSpec = getShell('wt')
check(
  'wt: passes the working directory with -d',
  JSON.stringify(wtSpec.build('unused', uglyPath, null)) === JSON.stringify(['-d', uglyPath])
)
check(
  'wt: forwards an init command through the built-in Command Prompt profile',
  JSON.stringify(wtSpec.build('unused', uglyPath, 'npm run dev')) ===
    JSON.stringify(['-d', uglyPath, 'cmd', '/k', 'npm run dev'])
)
check('wt: declares itself a GUI app so it is not wrapped in cmd', wtSpec.isGui === true)
check('cmd: declares it cannot take an init command', cmdSpec.supportsInitCmd === false)

/* ------------------------------------------------- quoting round trip */

console.log('\n2. cmd quoting of arguments with spaces')

function quoteForCmd(arg) {
  if (!/[\s"]/.test(arg)) return arg
  if (arg.startsWith('"') && arg.endsWith('"') && arg.length > 1) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

// This mirrors launchShell() exactly.
function buildLaunchLine(exe, args) {
  return `/d /c start "" ${quoteForCmd(exe)} ${args.map(quoteForCmd).join(' ')}`
}

const spacedExe = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const noSpaceExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

const spacedLine = buildLaunchLine(spacedExe, ['-NoLogo', '-NoExit', '-EncodedCommand', 'QUJD'])
check(
  'an empty title precedes a spaced exe path so start does not eat it',
  spacedLine === '/d /c start "" "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoExit -EncodedCommand QUJD',
  spacedLine
)
check(
  'an exe path without spaces is left bare',
  buildLaunchLine(noSpaceExe, ['/k', 'cd', '/d', uglyPath]).startsWith(
    '/d /c start "" C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe /k cd /d "'
  )
)
check(
  'the ugly path survives as a single quoted argument',
  buildLaunchLine(noSpaceExe, ['/k', 'cd', '/d', uglyPath]).endsWith(`cd /d "${uglyPath}"`)
)

/* ---------------------------------------------- what is actually installed */

console.log('\n3. installed shells on this machine')
const availability = checkShells(true)
for (const spec of SHELLS) {
  console.log(`        ${spec.label.padEnd(22)} ${availability[spec.id] ? 'installed' : 'not found'}`)
}

/* -------------------------------------------------- real end-to-end run */

console.log('\n4. real launch, in a directory with spaces and brackets')

const workDir = join(tmpdir(), 'termhop verify (1) [x]')
mkdirSync(workDir, { recursive: true })

async function verifyPowerShell(id) {
  const spec = getShell(id)
  const marker = join(workDir, `marker-${id}.txt`)
  if (existsSync(marker)) rmSync(marker)

  // [Environment]::Exit terminates the process itself, which -NoExit cannot
  // suppress, so the test leaves no console window behind.
  const initCmd = `Set-Content -LiteralPath '${marker}' -Value (Get-Location).Path; [Environment]::Exit(0)`
  const outcome = await launchShell(spec, workDir, initCmd)
  if (!outcome.ok) return bad(`${id}: launch reported failure`, outcome.error)

  for (let i = 0; i < 40; i++) {
    if (existsSync(marker)) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!existsSync(marker)) return bad(`${id}: shell started but never wrote the marker`)

  const where = readFileSync(marker, 'utf8').trim()
  check(`${id}: started and cd'd to the right directory`, where === workDir, where)
  rmSync(marker, { force: true })
}

function cmdPids() {
  try {
    return execSync('tasklist /NH /FI "IMAGENAME eq cmd.exe"', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[0]?.toLowerCase() === 'cmd.exe')
      .map((parts) => Number(parts[1]))
      .filter((pid) => Number.isFinite(pid))
  } catch {
    return []
  }
}

await verifyPowerShell('pwsh')
await verifyPowerShell('powershell')

// cmd has no init command, so what is asserted is that `start` really opens a
// new console (the cwd itself is proven by the PowerShell probe above, which
// reports Get-Location from inside the shell).
if (availability.cmd) {
  const before = new Set(cmdPids())
  const outcome = await launchShell(getShell('cmd'), workDir, null)
  if (!outcome.ok) {
    bad('cmd: launch reported failure', outcome.error)
  } else {
    await new Promise((r) => setTimeout(r, 1500))
    const fresh = cmdPids().filter((pid) => !before.has(pid))
    check('cmd: a new console process was started', fresh.length > 0, `pids: ${fresh.join(', ') || 'none'}`)
    // Only the consoles this test created are terminated.
    for (const pid of fresh) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
      } catch {
        /* it may already be gone */
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

// The freshly closed console may still hold the directory as its cwd.
try {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {
  console.log(`        note: left ${workDir} behind (still held by a console)`)
}

/* --------------------------------------------------------- seed the log */

console.log('\n' + (failures ? `${failures} check(s) failed` : 'all checks passed'))
process.exit(failures ? 1 : 0)
