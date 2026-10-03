// Loader for recordings made by tools/record-imu.mjs: one JSON line per report {t, ht, step, hex}.
// Returns the IMU samples grouped by step, in physical units (nominal gyro scale 0.06103515625 dps/LSB, accel raw/4096 g),
// with device-time dt and a continuous device clock in ms. Shared by the analysis and replay scripts in tools/.
import fs from 'node:fs'
import { parseInputReport, hexToBytes, imuDeltaUs, GYRO_DPS_PER_LSB, ACCEL_G_PER_LSB } from '../../public/js/input/joycon2-parse.js'

export const DEFAULT_RECORDING = 'recordings/imu-2026-09-30T18-42-24.jsonl'

/**
 * @param {string} file
 * @returns {{meta:object, steps:Record<string,Array<{i:number,wall:number,us:number,t:number,dtMs:number,g:{x:number,y:number,z:number},gRaw:{x:number,y:number,z:number},a:{x:number,y:number,z:number}}>>, order:string[], all:Array}}
 */
export function loadRecording(file = DEFAULT_RECORDING) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const meta = rows.find((r) => r.type === 'meta') ?? {}
  const steps = {}
  const order = []
  const all = []
  let t = 0
  let prevUs = null
  let i = 0
  for (const r of rows) {
    if (!r.hex || !r.step) continue
    const p = parseInputReport(hexToBytes(r.hex))
    if (!p || !p.imuActive) continue
    const dtMs = prevUs === null ? 0 : imuDeltaUs(prevUs, p.imuTimestampUs) / 1000
    prevUs = p.imuTimestampUs
    t += dtMs
    const s = {
      i: i++, step: r.step, wall: r.t, us: p.imuTimestampUs, t, dtMs,
      gRaw: p.gyroRaw,
      g: { x: p.gyroRaw.x * GYRO_DPS_PER_LSB, y: p.gyroRaw.y * GYRO_DPS_PER_LSB, z: p.gyroRaw.z * GYRO_DPS_PER_LSB },
      a: { x: p.accelRaw.x * ACCEL_G_PER_LSB, y: p.accelRaw.y * ACCEL_G_PER_LSB, z: p.accelRaw.z * ACCEL_G_PER_LSB },
    }
    if (!steps[r.step]) { steps[r.step] = []; order.push(r.step) }
    steps[r.step].push(s)
    all.push(s)
  }
  return { meta, steps, order, all }
}

export const speedOf = (g) => Math.hypot(g.x, g.y, g.z)
export const accMag = (a) => Math.hypot(a.x, a.y, a.z)
export function quantile(sorted, q) {
  if (!sorted.length) return NaN
  const p = (sorted.length - 1) * q
  const lo = Math.floor(p)
  const hi = Math.ceil(p)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo)
}
export const sortedCopy = (xs) => Float64Array.from(xs).sort()
export const median = (xs) => quantile(sortedCopy(xs), 0.5)
export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
export const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) }

/**
 * Find strokes (swings) in a list of samples: local maxima of `speedFn` of at least `minPeak` dps, peaks closer than `mergeMs`
 * merged (the highest wins), each with its extent (walk outwards until the speed is <= `edge`); `aPeak` is the largest |a| within 3 samples of the speed peak and the statistics the design needs.
 * `thresholds` are candidate cut thresholds (dps); for each the number of consecutive samples at or above it around the peak and the
 * time above it (linear interpolation between samples, contiguous around the peak) are reported.
 */
export function findStrokes(l, speedFn, { minPeak = 150, mergeMs = 250, edge = 100, thresholds = [150, 200, 250, 300, 400, 500] } = {}) {
  const v = l.map(speedFn)
  const peaks = []
  for (let i = 1; i < l.length - 1; i += 1) if (v[i] >= minPeak && v[i] >= v[i - 1] && v[i] > v[i + 1]) peaks.push(i)
  const merged = []
  for (const i of peaks) {
    const last = merged.at(-1)
    if (last !== undefined && l[i].t - l[last].t < mergeMs) { if (v[i] > v[last]) merged[merged.length - 1] = i } else merged.push(i)
  }
  return merged.map((pk) => {
    // extent: walk outwards until the speed is <= edge, or stop at a local minimum below half the peak (back-to-back strokes)
    let a = pk
    while (a > 0 && v[a - 1] > edge && !(v[a - 1] > v[a] && v[a] < 0.5 * v[pk])) a -= 1
    let b = pk
    while (b < l.length - 1 && v[b + 1] > edge && !(v[b + 1] > v[b] && v[b] < 0.5 * v[pk])) b += 1
    let angle = 0
    for (let i = Math.max(1, a); i <= b; i += 1) angle += 0.5 * (v[i] + v[i - 1]) * (l[i].dtMs / 1000)
    let aPeak = 0
    for (let i = Math.max(0, pk - 3); i <= Math.min(l.length - 1, pk + 3); i += 1) aPeak = Math.max(aPeak, Math.hypot(l[i].a.x, l[i].a.y, l[i].a.z)) // within +-3 samples (about 100 ms) of the speed peak
    const above = {}
    for (const T of thresholds) {
      let lo = pk
      while (lo > 0 && v[lo - 1] >= T) lo -= 1
      let hi = pk
      while (hi < l.length - 1 && v[hi + 1] >= T) hi += 1
      const n = v[pk] >= T ? hi - lo + 1 : 0
      let ms = 0
      if (n > 0) {
        // interpolated crossing times around the contiguous run
        const tUp = lo > 0 ? l[lo - 1].t + (l[lo].t - l[lo - 1].t) * (T - v[lo - 1]) / (v[lo] - v[lo - 1]) : l[lo].t
        const tDown = hi < l.length - 1 ? l[hi].t + (l[hi + 1].t - l[hi].t) * (v[hi] - T) / (v[hi] - v[hi + 1]) : l[hi].t
        ms = tDown - tUp
      }
      above[T] = { n, ms }
    }
    let rise = 0
    {
      let j = pk
      while (j > 0 && v[j - 1] < v[j] && v[j - 1] > 0.1 * v[pk]) j -= 1
      rise = l[pk].t - l[j].t
    }
    return { i: pk, t: l[pk].t, peak: v[pk], aPeak, angle, rise, durMs: l[b].t - l[a].t, above, a, b }
  })
}
