/**
 * Shared preconditions for the verification scripts that drive the real exe.
 *
 * Every one of them needs the same three things, and getting any of them wrong
 * produces failures that look like product bugs:
 *
 *   1. no TermHop instance running — each one holds the single-instance lock,
 *      so the next launch quits immediately and the run fails for no reason
 *   2. a config that will not make the app register a login item as a side
 *      effect of a test that is not about autostart
 *   3. the registry left exactly as it was found
 *
 * The registry piece exists because `reg query <value>` exits non-zero both
 * when the value is absent and when the query itself failed, so treating a
 * non-zero exit as "clean" silently passes while junk is left behind.
 */
import { execFileSync } from 'node:child_process'

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const RUN_VALUE = 'electron.app.TermHop'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { sleep }

function reg(args) {
  try {
    const out = execFileSync('reg.exe', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return { ok: true, out }
  } catch {
    return { ok: false, out: '' }
  }
}

/** Reads the whole key, because a failed query must not look like "absent". */
export function readLoginItem() {
  const result = reg(['query', RUN_KEY])
  return { ok: result.ok, present: result.out.includes(RUN_VALUE) }
}

/** The current value's data, or null when there is nothing to restore. */
export function readLoginItemData() {
  if (!readLoginItem().present) return null
  const result = reg(['query', RUN_KEY, '/v', RUN_VALUE])
  if (!result.ok) return null
  const lines = result.out.split(/\r?\n/).filter((l) => l.trim())
  const dataLine = lines[lines.length - 1] ?? ''
  const parts = dataLine.trim().split(/\s{2,}/)
  return parts.length >= 3 ? parts.slice(2).join('  ') : null
}

export function deleteLoginItem() {
  try {
    execFileSync('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { stdio: 'ignore' })
  } catch {
    /* nothing to delete */
  }
}

export function writeLoginItem(data) {
  try {
    execFileSync('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', data, '/f'], {
      stdio: 'ignore'
    })
  } catch {
    /* best effort */
  }
}

export function countProcs() {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq TermHop.exe', '/NH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split(/\r?\n/)
      .filter((l) => l.toUpperCase().includes('TERMHOP.EXE')).length
  } catch {
    return -1
  }
}

export function killAll() {
  try {
    execFileSync('taskkill', ['/IM', 'TermHop.exe', '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* none running */
  }
}

export async function waitForNoProcs(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (countProcs() === 0) return true
    killAll()
    await sleep(500)
  }
  return countProcs() === 0
}

export async function waitForProcs(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (countProcs() > 0) return true
    await sleep(500)
  }
  return countProcs() > 0
}

/**
 * Removes the login item, retrying while anything is still running: an app
 * that has not exited yet can write the entry back.
 */
export async function forceCleanRegistry(attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = readLoginItem()
    if (before.ok && !before.present) return true
    killAll()
    deleteLoginItem()
    const after = readLoginItem()
    if (after.ok && !after.present) return true
    await sleep(1000)
  }
  const last = readLoginItem()
  return last.ok && !last.present
}

/** Snapshot/restore pair so a user's own autostart setting survives a test run. */
export function snapshotLoginItem() {
  return readLoginItemData()
}

export async function restoreLoginItem(data) {
  await forceCleanRegistry()
  if (typeof data === 'string' && data.length) writeLoginItem(data)
}
