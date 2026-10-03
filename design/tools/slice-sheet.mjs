// Slice a transparent sprite sheet (8-bit RGBA PNG) into single sprites, with no dependencies except ffmpeg.
// Usage: node tools/slice-sheet.mjs <sheet.png> <axis x|y> <name1,name2,...> <outDir> [options]
//   --gap N        minimum empty gap in px that separates two elements (default 40)
//   --canvas N     square canvas size of every sprite (default 512); 0 = no canvas, tight crop only
//   --content N    largest size of the content inside the canvas (default 389 = 76% of 512, 12% margin)
//   --norm M       first | from:K | each : which element sets the common scale (default first)
//   --width N      with --canvas 0: scale every tight crop to this width (keeps aspect)
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, bd = 0, il = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (bd !== 8 || ct !== 6 || il !== 0) throw new Error(`need 8-bit RGBA non-interlaced PNG, got depth ${bd} type ${ct} interlace ${il}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * 4
  const out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[dst + x - 4] : 0
      const b = y > 0 ? out[dst - stride + x] : 0
      const c = x >= 4 && y > 0 ? out[dst - stride + x - 4] : 0
      let v = raw[src + x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      out[dst + x] = v & 255
    }
  }
  return { w, h, data: out }
}

const args = process.argv.slice(2)
const [sheet, axis, namesArg, outDir] = args
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const gapMin = Number(opt('gap', 40)), canvas = Number(opt('canvas', 512)), content = Number(opt('content', 389))
const norm = opt('norm', 'first'), widthTarget = Number(opt('width', 0))
const names = namesArg.split(',')
const { w, h, data } = decodePng(fs.readFileSync(sheet))
const T = 24 // alpha threshold
const opaque = (x, y) => data[(y * w + x) * 4 + 3] > T

// occupancy along the axis, then groups separated by gaps
const lenMain = axis === 'x' ? w : h, lenCross = axis === 'x' ? h : w
const occ = new Uint8Array(lenMain)
for (let m = 0; m < lenMain; m++) for (let c = 0; c < lenCross; c++) { if (axis === 'x' ? opaque(m, c) : opaque(c, m)) { occ[m] = 1; break } }
const groups = []
let start = -1, last = -1
for (let m = 0; m < lenMain; m++) {
  if (occ[m]) { if (start < 0) start = m; last = m }
  else if (start >= 0 && m - last >= gapMin) { groups.push([start, last]); start = -1 }
}
if (start >= 0) groups.push([start, last])
if (groups.length !== names.length) {
  console.error(`expected ${names.length} elements, found ${groups.length}: ${JSON.stringify(groups)}. Try a different --gap.`)
  process.exit(2)
}
const boxes = groups.map(([a, b]) => {
  let c0 = lenCross, c1 = -1
  for (let m = a; m <= b; m++) for (let c = 0; c < lenCross; c++) { if (axis === 'x' ? opaque(m, c) : opaque(c, m)) { if (c < c0) c0 = c; if (c > c1) c1 = c } }
  const pad = 4
  const x0 = Math.max(0, (axis === 'x' ? a : c0) - pad), x1 = Math.min(w - 1, (axis === 'x' ? b : c1) + pad)
  const y0 = Math.max(0, (axis === 'x' ? c0 : a) - pad), y1 = Math.min(h - 1, (axis === 'x' ? c1 : b) + pad)
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
})
const ref = norm.startsWith('from:') ? boxes[Number(norm.slice(5))] : boxes[0]
const common = content / Math.max(ref.w, ref.h)
fs.mkdirSync(outDir, { recursive: true })
const manifest = []
names.forEach((name, i) => {
  const b = boxes[i]
  let vf
  if (canvas > 0) {
    let s = norm === 'each' ? content / Math.max(b.w, b.h) : common
    let sw = Math.round(b.w * s), sh = Math.round(b.h * s)
    if (sw > canvas || sh > canvas) { const k = canvas / Math.max(sw, sh); sw = Math.round(sw * k); sh = Math.round(sh * k); s *= k }
    vf = `crop=${b.w}:${b.h}:${b.x}:${b.y},format=rgba,scale=${sw}:${sh}:flags=lanczos,format=rgba,pad=${canvas}:${canvas}:(ow-iw)/2:(oh-ih)/2:color=black@0`
    manifest.push({ name, box: b, scale: +s.toFixed(4), size: `${canvas}x${canvas}` })
  } else {
    const tw = widthTarget || b.w
    const th = Math.round(b.h * (tw / b.w))
    vf = `crop=${b.w}:${b.h}:${b.x}:${b.y},format=rgba,scale=${tw}:${th}:flags=lanczos,format=rgba`
    manifest.push({ name, box: b, size: `${tw}x${th}` })
  }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', sheet, '-vf', vf, '-frames:v', '1', path.join(outDir, `${name}.png`)])
})
console.log(JSON.stringify({ sheet: path.basename(sheet), axis, groups: groups.length, sprites: manifest }, null, 0))
