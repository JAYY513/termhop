/**
 * Mounts the real launcher against the fake IPC surface.
 *
 * The component under test is `src/renderer/src/components/Launcher.tsx`, not
 * a copy of it. Everything that decides what a key press does lives in that
 * file, so a test that reimplemented the key handling would only prove that
 * the copy agrees with itself.
 *
 * The HTML that loads this bundle installs `window.termhop` first — the api
 * module reads it at import time, so a later install would be too late.
 */
import { createRoot } from 'react-dom/client'
import Launcher from '../../src/renderer/src/components/Launcher'
import type { Config } from '@shared/types'

declare global {
  interface Window {
    __config: Config
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('shortcut harness: #root is missing')

// Stable on purpose: the launcher re-subscribes to its events whenever this
// identity changes, and a new one every render would churn the subscription
// in the middle of a test.
const onConfig = (): void => {}

createRoot(container).render(<Launcher config={window.__config} onConfig={onConfig} />)
