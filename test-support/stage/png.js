// A tiny dependency-free PNG decoder for the stage readability checks. OWNER: Stage engineer.
//
// It reads 8-bit, non-interlaced, greyscale / RGB / RGBA / grey+alpha PNG files (what design/backgrounds/ contains) with node:zlib and
// returns tightly packed RGBA bytes. It exists only for tests and measurement scripts: the game never decodes an image itself.
// Reads are bounded: only the rows up to `maxRow` are unfiltered when the caller does not need the rest.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Read the header of a PNG file without decoding it. @returns {{width:number,height:number,bitDepth:number,colorType:number,interlace:number}} */
export function readPngHeader(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a PNG file.
 * @param {string|Buffer} source  file path or the file bytes
 * @param {{maxRow?:number}} [opts]  decode rows 0 .. maxRow - 1 only (default: all rows)
 * @returns {{width:number, height:number, rows:number, hasAlpha:boolean, rgba:Uint8Array}}
 */
export function decodePng(source, opts = {}) {
  const buf = typeof source === 'string' ? readFileSync(source) : source;
  const head = readPngHeader(buf);
  if (head.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${head.bitDepth}`);
  if (head.interlace !== 0) throw new Error('interlaced PNG is not supported');
  const channels = CHANNELS[head.colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${head.colorType}`);
  const { width, height } = head;

  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG data is shorter than its header says');

  const rows = Math.min(height, Math.max(1, opts.maxRow ?? height));
  const rgba = new Uint8Array(width * rows * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < rows; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      cur[i] = v & 255;
    }
    let o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      if (channels === 4) {
        rgba[o] = cur[s]; rgba[o + 1] = cur[s + 1]; rgba[o + 2] = cur[s + 2]; rgba[o + 3] = cur[s + 3];
      } else if (channels === 3) {
        rgba[o] = cur[s]; rgba[o + 1] = cur[s + 1]; rgba[o + 2] = cur[s + 2]; rgba[o + 3] = 255;
      } else if (channels === 2) {
        rgba[o] = cur[s]; rgba[o + 1] = cur[s]; rgba[o + 2] = cur[s]; rgba[o + 3] = cur[s + 1];
      } else {
        rgba[o] = cur[s]; rgba[o + 1] = cur[s]; rgba[o + 2] = cur[s]; rgba[o + 3] = 255;
      }
      o += 4;
    }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, rows, hasAlpha: channels === 4 || channels === 2, rgba };
}
