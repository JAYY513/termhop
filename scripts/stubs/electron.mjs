/**
 * Stand-in for the `electron` module when the main-process sources are loaded
 * outside Electron (see scripts/verify-cli.mjs). Tests populate
 * `globalThis.__ELECTRON_APP_STUB__` before loading the bundle.
 */
export const app = globalThis.__ELECTRON_APP_STUB__
