// Generates pixel-perfect PNG app icons from the 16×16 headphone glyph.
// No dependencies: writes PNGs directly with node:zlib. Run: npm run icons
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const GLYPH = [
  '................',
  '................',
  '.....######.....',
  '...##......##...',
  '..#..........#..',
  '..#..........#..',
  '..#..........#..',
  '..#..........#..',
  '..###......###..',
  '.####......####.',
  '.####......####.',
  '.####......####.',
  '.####......####.',
  '..###......###..',
  '................',
  '................',
]

const BG = [0x18, 0x1d, 0x27]
const FG = [0xff, 0xff, 0xff]

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/**
 * @param size   output px
 * @param glyphPx size of the glyph area in px (must be a multiple of 16 for crisp pixels)
 * @param radius corner radius in px (0 = square; maskable/apple icons are masked by the OS)
 */
function png(size, glyphPx, radius) {
  const scale = glyphPx / 16
  const off = (size - glyphPx) / 2
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - off) / scale)
      const gy = Math.floor((y - off) / scale)
      const on = GLYPH[gy]?.[gx] === '#'
      // rounded-corner alpha
      let a = 255
      if (radius) {
        const cx = Math.min(Math.max(x + 0.5, radius), size - radius)
        const cy = Math.min(Math.max(y + 0.5, radius), size - radius)
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        a = Math.round(255 * Math.min(1, Math.max(0, radius - d + 0.5)))
      }
      const [r, g, b] = on ? FG : BG
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync('public/icons', { recursive: true })
const out = {
  'public/icons/icon-192.png': png(192, 160, 38),
  'public/icons/icon-512.png': png(512, 416, 100),
  // maskable: full-bleed bg, glyph inside the 80% safe zone
  'public/icons/maskable-512.png': png(512, 320, 0),
  // iOS applies its own squircle mask
  'public/apple-touch-icon.png': png(180, 128, 0),
}
for (const [path, buf] of Object.entries(out)) {
  writeFileSync(path, buf)
  console.log(`${path}  ${buf.length} B`)
}
