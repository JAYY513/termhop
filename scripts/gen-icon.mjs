/**
 * Generates TermHop's icons without any image library.
 *
 * Outputs:
 *   build/icon.png              256x256 app icon (electron-builder turns it into .ico)
 *   build/tray.png              32x32 tray icon, for reference
 *   src/main/assets/icons.ts    base64 payloads embedded in the main process
 *
 * Shapes are defined with signed distance fields and rasterised with 3x3
 * supersampling, which keeps the 32px tray variant legible.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------------------------------------------------------------- PNG codec */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([len, typed, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------ shapes */

function sdRoundRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius)
  const qy = Math.abs(py - cy) - (halfH - radius)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

// The mark: a right-pointing arrow ("hop"). Normalised 0..1 space.
const ARROW = {
  shaft: { x0: 0.24, x1: 0.58, cy: 0.5, halfH: 0.065, radius: 0.065 },
  head: [
    [0.52, 0.255],
    [0.52, 0.745],
    [0.79, 0.5]
  ]
}

function insideGlyph(x, y) {
  const s = ARROW.shaft
  if (sdRoundRect(x, y, (s.x0 + s.x1) / 2, s.cy, (s.x1 - s.x0) / 2, s.halfH, s.radius) < 0) return true
  const [ax, ay] = ARROW.head[0]
  const [bx, by] = ARROW.head[1]
  const [cx, cy] = ARROW.head[2]
  return inTriangle(x, y, ax, ay, bx, by, cx, cy)
}

const BG_TOP = [0x33, 0x34, 0x3d]
const BG_BOTTOM = [0x18, 0x19, 0x1f]
const ACCENT_TOP = [0x8f, 0xd8, 0xff]
const ACCENT_BOTTOM = [0x45, 0x96, 0xf5]

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

/**
 * @param {number} size    output edge length in pixels
 * @param {number} inset   fraction of the canvas kept empty around the plate
 */
function renderIcon(size, inset) {
  const rgba = Buffer.alloc(size * size * 4)
  const SS = 3
  const plate = { cx: 0.5, cy: 0.5, half: 0.5 - inset, radius: 0.22 * (0.5 + inset) }
  // Glyph is scaled up a little on small sizes so it stays readable.
  const glyphScale = size <= 48 ? 1.12 : 1

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let plateHits = 0
      let glyphHits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size
          if (sdRoundRect(u, v, plate.cx, plate.cy, plate.half, plate.half, plate.radius) < 0) plateHits++
          const gu = 0.5 + (u - 0.5) / glyphScale
          const gv = 0.5 + (v - 0.5) / glyphScale
          if (insideGlyph(gu, gv)) glyphHits++
        }
      }
      const total = SS * SS
      const plateA = plateHits / total
      const glyphA = glyphHits / total
      if (plateA === 0 && glyphA === 0) continue

      const t = y / (size - 1)
      const plateColor = mix(BG_TOP, BG_BOTTOM, t)
      const accent = mix(ACCENT_TOP, ACCENT_BOTTOM, t)

      // Glyph over plate, plate over transparent background.
      const glyphW = glyphA
      const plateW = plateA * (1 - glyphA)
      const outW = glyphW + plateW
      const r = (accent[0] * glyphW + plateColor[0] * plateW) / outW
      const g = (accent[1] * glyphW + plateColor[1] * plateW) / outW
      const b = (accent[2] * glyphW + plateColor[2] * plateW) / outW

      const i = (y * size + x) * 4
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = Math.round(outW * 255)
    }
  }
  return encodePng(size, size, rgba)
}

/* ------------------------------------------------------------------- write */

const icon256 = renderIcon(256, 0.0)
const tray32 = renderIcon(32, 0.02)

mkdirSync(resolve(ROOT, 'build'), { recursive: true })
writeFileSync(resolve(ROOT, 'build/icon.png'), icon256)
writeFileSync(resolve(ROOT, 'build/tray.png'), tray32)

const assetsDir = resolve(ROOT, 'src/main/assets')
mkdirSync(assetsDir, { recursive: true })
writeFileSync(
  resolve(assetsDir, 'icons.ts'),
  `// AUTO-GENERATED by scripts/gen-icon.mjs -- do not edit by hand.
// Run \`npm run icons\` to regenerate.

export const APP_ICON_BASE64 =
  '${icon256.toString('base64')}'

export const TRAY_ICON_BASE64 =
  '${tray32.toString('base64')}'
`
)

console.log(`icon.png  ${icon256.length} bytes (256x256)`)
console.log(`tray.png  ${tray32.length} bytes (32x32)`)
