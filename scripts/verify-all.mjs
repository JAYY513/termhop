/**
 * Runs every verification suite with a clean slate in between.
 *
 * The suites drive the real app, and a real app instance holds a
 * single-instance lock and can register a login item as a side effect. A suite
 * that leaves either behind makes the next one fail for reasons that have
 * nothing to do with the code. The aggregate runner is the right place to
 * enforce that, rather than trusting each suite to tidy up perfectly.
 *
 * Run with:  npm run verify
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forceCleanRegistry, readLoginItem, waitForNoProcs } from './testkit.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// The shortcut suite drives the real renderer, so it needs a real browser
// kernel. Under plain node, `require('electron')` is the path to the binary.
const ELECTRON = require('electron')

const SUITES = [
  ['verify-spawn.mjs', 'shell 启动', 'node'],
  ['verify-window.mjs', '窗口行为', 'node'],
  ['verify-shortcuts.cjs', '快捷键', 'electron'],
  ['verify-cli.mjs', '命令行', 'node'],
  ['verify-quickadd.mjs', '快速添加', 'node'],
  ['verify-autostart.mjs', '开机自启', 'node']
]

function runSuite(file, runner) {
  return new Promise((done) => {
    const child = spawn(runner === 'electron' ? ELECTRON : process.execPath, [join(ROOT, 'scripts', file)], {
      stdio: 'inherit',
      cwd: ROOT
    })
    child.on('close', (code) => done(code ?? 1))
  })
}

let failed = 0
for (const [file, label, runner] of SUITES) {
  if (!existsSync(join(ROOT, 'scripts', file))) {
    console.log(`\n### ${label} — 缺少 ${file}，跳过`)
    continue
  }

  // Preconditions: no instance, no login item.
  await waitForNoProcs()
  if (readLoginItem().present) {
    console.log(`\n### ${label} — 清理上一轮遗留的开机项`)
    await forceCleanRegistry()
  }

  console.log(`\n${'='.repeat(60)}\n### ${label} (${file})\n${'='.repeat(60)}`)
  const code = await runSuite(file, runner)
  if (code !== 0) failed++
}

console.log(`\n${'='.repeat(60)}`)
// Final sweep, so nothing is left on the machine even if a suite failed.
await waitForNoProcs()
const leftover = readLoginItem()
if (leftover.ok && leftover.present) await forceCleanRegistry()
const finalState = readLoginItem()
console.log(`清理后残留开机项: ${finalState.ok && !finalState.present ? '无' : '有'}`)
console.log(failed ? `\n${failed} 个套件失败` : '\n全部套件通过')
process.exit(failed || (finalState.ok && finalState.present) ? 1 : 0)
