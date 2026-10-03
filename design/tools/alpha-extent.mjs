// Print the horizontal extent of the solid (alpha above a threshold) part of an RGBA PNG.
// Usage: node tools/alpha-extent.mjs <file.png> [alphaThreshold=200]
// Also prints the horizontal extent of the solid blue (indigo hills) pixels in the lower half, to find paper-coloured side strips.
import fs from 'node:fs'
import zlib from 'node:zlib'
const buf = fs.readFileSync(process.argv[2]); const T = Number(process.argv[3] ?? 200)
let p = 8, w = 0, h = 0; const idat = []
while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len)
  if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4) } else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break; p += 12 + len }
const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 4, out = Buffer.alloc(h * stride)
for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)], s = y * (stride + 1) + 1, o = y * stride
  for (let x = 0; x < stride; x++) { const a = x >= 4 ? out[o + x - 4] : 0, b = y ? out[o - stride + x] : 0, c = x >= 4 && y ? out[o - stride + x - 4] : 0; let v = raw[s + x]
    if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
    out[o + x] = v & 255 } }
let x0 = w, x1 = -1, y0 = h, y1 = -1
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (out[(y * w + x) * 4 + 3] >= T) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
let b0 = w, b1 = -1
for (let y = Math.round(h * 0.60); y < Math.round(h * 0.90); y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (out[i + 3] >= 200 && out[i + 2] - out[i] > 30) { if (x < b0) b0 = x; if (x > b1) b1 = x } }
console.log(JSON.stringify({ blueHillsXMin: b0, blueHillsXMax: b1, blueLeftPct: +(100 * b0 / w).toFixed(1), blueRightPct: +(100 * (w - 1 - b1) / w).toFixed(1) }))
console.log(JSON.stringify({ file: process.argv[2], width: w, height: h, threshold: T, xMin: x0, xMax: x1, yMin: y0, yMax: y1, leftMarginPct: +(100 * x0 / w).toFixed(1), rightMarginPct: +(100 * (w - 1 - x1) / w).toFixed(1) }))
