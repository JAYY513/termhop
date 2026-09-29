/**
 * Stand-in for the `electron` module when src/main/window.ts is loaded outside
 * Electron (see scripts/verify-window.mjs). The test assigns the fake runtime to
 * `globalThis.__ELECTRON_FAKE__` before requiring the bundle.
 */
export const BrowserWindow = globalThis.__ELECTRON_FAKE__.BrowserWindow
export const screen = globalThis.__ELECTRON_FAKE__.screen
export const nativeImage = globalThis.__ELECTRON_FAKE__.nativeImage
