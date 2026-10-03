#!/usr/bin/env node
// Analyse a recording made by tools/record-imu.mjs: real gyro bias, noise, scale, axes, drift and return-to-start error.
// Usage: node tools/analyze-imu.mjs recordings/imu-<stamp>.jsonl [--json]
import fs from 'node:fs'
import { parseInputReport, hexToBytes, imuDeltaUs } from '../public/js/input/joycon2-parse.js'

const file = process.argv[2]
if (!file) { console.error('usage: node tools/analyze-imu.mjs <recording.jsonl> [--json]'); process.exit(2) }
const K0 = 2000 / 32768 // nominal dps per LSB used by the game today
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const meta = rows.find((r) => r.type === 'meta')
const steps = {}
for (const r of rows) {
  if (!r.hex || !r.step) continue
  const p = parseInputReport(hexToBytes(r.hex))
  if (!p || !p.imuActive) continue
  ;(steps[r.step] ||= []).push({ wall: r.t, us: p.imuTimestampUs, g: p.gyroRaw, a: p.accelRaw })
}
const AX = ['x', 'y', 'z']
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) }
function dts(list) { const d = [0]; for (let i = 1; i < list.length; i++) d.push(imuDeltaUs(list[i - 1].us, list[i].us) / 1e6); return d }
function stats(name) {
  const l = steps[name]; if (!l || l.length < 3) return null
  const d = dts(l); const dur = d.reduce((a, b) => a + b, 0)
  const res = { n: l.length, seconds: +dur.toFixed(2), hzImu: +((l.length - 1) / dur).toFixed(1), dtMaxMs: +(Math.max(...d) * 1000).toFixed(0) }
  for (const a of AX) { const v = l.map((s) => s.g[a]); res['gyroMean_' + a] = +mean(v).toFixed(1); res['gyroSd_' + a] = +sd(v).toFixed(1) }
  res.accelNormG = +mean(l.map((s) => Math.hypot(s.a.x, s.a.y, s.a.z) / 4096)).toFixed(3)
  res.accelMeanG = Object.fromEntries(AX.map((a) => [a, +(mean(l.map((s) => s.a[a])) / 4096).toFixed(3)]))
  return res
}
const rest = stats('rest_table')
const bias = rest ? Object.fromEntries(AX.map((a) => [a, rest['gyroMean_' + a]])) : { x: 0, y: 0, z: 0 }
function integrate(name, b = bias, k = K0) { // signed and absolute travel per axis, in degrees
  const l = steps[name]; if (!l) return null
  const d = dts(l); const out = {}
  for (const a of AX) { let s = 0, ab = 0; for (let i = 1; i < l.length; i++) { const w = (l[i].g[a] - b[a]) * k; s += w * d[i]; ab += Math.abs(w) * d[i] } out[a] = { signedDeg: +s.toFixed(1), travelDeg: +ab.toFixed(1) } }
  return out
}
function dominant(int) { return AX.map((a) => [a, int[a].travelDeg]).sort((p, q) => q[1] - p[1])[0] }
const report = { file, meta, nominalDpsPerLsb: K0, restBiasRaw: bias, steps: {}, scale: {}, drift: {} }
for (const n of Object.keys(steps)) report.steps[n] = stats(n)

// scale estimate from the two known 4-turn steps (1440 degrees each)
for (const n of ['roll_360', 'table_spin_360']) {
  const int = integrate(n); if (!int) continue
  const [ax, travel] = dominant(int)
  report.scale[n] = { dominantAxis: ax, measuredTravelDegAtNominal: travel, expectedDeg: 1440, suggestedMultiplier: +(1440 / travel).toFixed(3), perAxis: int }
}
// sweeps: peak-to-peak of the integrated angle on the dominant axis (expected about 120 degrees for yaw, 80 for pitch)
for (const [n, expected] of [['yaw_sweep', 120], ['pitch_sweep', 80]]) {
  const l = steps[n]; if (!l) continue
  const d = dts(l); const int = integrate(n); const [ax] = dominant(int)
  let ang = 0, lo = 0, hi = 0
  for (let i = 1; i < l.length; i++) { ang += (l[i].g[ax] - bias[ax]) * K0 * d[i]; lo = Math.min(lo, ang); hi = Math.max(hi, ang) }
  report.scale[n] = { dominantAxis: ax, peakToPeakDegAtNominal: +(hi - lo).toFixed(1), expectedDeg: expected, suggestedMultiplier: +(expected / (hi - lo || 1)).toFixed(3) }
}
// drift while holding still, using the rest bias and with the bias estimated on the same step
for (const n of ['hold_still', 'return_still']) {
  const l = steps[n]; if (!l) continue
  const st = stats(n); const own = Object.fromEntries(AX.map((a) => [a, st['gyroMean_' + a]]))
  report.drift[n] = { withRestBias: integrate(n), ownBiasRawMinusRest: Object.fromEntries(AX.map((a) => [a, +(own[a] - bias[a]).toFixed(1)])), ownBiasDps: Object.fromEntries(AX.map((a) => [a, +(own[a] * K0).toFixed(2)])) }
}
// return-to-start: integrate a quaternion through every step from the start of hold_still to the end of return_still
function quatReturn(k, b) {
  const order = ['hold_still', 'yaw_sweep', 'pitch_sweep', 'roll_360', 'fast_swings_h', 'fast_swings_v', 'return_still'].filter((n) => steps[n])
  let q = [1, 0, 0, 0]
  const mul = (p, r) => [p[0] * r[0] - p[1] * r[1] - p[2] * r[2] - p[3] * r[3], p[0] * r[1] + p[1] * r[0] + p[2] * r[3] - p[3] * r[2], p[0] * r[2] - p[1] * r[3] + p[2] * r[0] + p[3] * r[1], p[0] * r[3] + p[1] * r[2] - p[2] * r[1] + p[3] * r[0]]
  for (const n of order) { const l = steps[n]; const d = dts(l); for (let i = 1; i < l.length; i++) {
    const wx = (l[i].g.x - b.x) * k * Math.PI / 180, wy = (l[i].g.y - b.y) * k * Math.PI / 180, wz = (l[i].g.z - b.z) * k * Math.PI / 180
    const th = Math.hypot(wx, wy, wz) * d[i]; if (th < 1e-9) continue
    const s = Math.sin(th / 2) / (Math.hypot(wx, wy, wz))
    q = mul(q, [Math.cos(th / 2), wx * s, wy * s, wz * s]); const nq = Math.hypot(...q); q = q.map((v) => v / nq) } }
  return +(2 * Math.acos(Math.min(1, Math.abs(q[0]))) * 180 / Math.PI).toFixed(1)
}
if (steps.hold_still && steps.return_still) {
  const scales = {}
  for (const n of ['roll_360', 'table_spin_360']) if (report.scale[n]) scales[n] = report.scale[n].suggestedMultiplier
  const kBest = K0 * (mean(Object.values(scales)) || 1)
  report.returnToStartErrorDeg = { nominalScale: quatReturn(K0, bias), estimatedScale: quatReturn(kBest, bias), estimatedDpsPerLsb: +kBest.toFixed(6), note: 'pure gyro integration, no fusion, from the start of hold_still to the end of return_still; 0 means perfect' }
  const gHold = stats('hold_still').accelMeanG, gRet = stats('return_still').accelMeanG
  const dot = gHold.x * gRet.x + gHold.y * gRet.y + gHold.z * gRet.z
  report.gravityAngleBetweenStartAndEndDeg = +(Math.acos(Math.min(1, Math.max(-1, dot / (Math.hypot(gHold.x, gHold.y, gHold.z) * Math.hypot(gRet.x, gRet.y, gRet.z))))) * 180 / Math.PI).toFixed(1)
}
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`\nRecording: ${file}\nIMU packets per step and rate:`)
  for (const [n, s] of Object.entries(report.steps)) console.log(`  ${n.padEnd(16)} ${String(s.n).padStart(5)} pkts  ${s.seconds}s  ${s.hzImu} Hz  worst gap ${s.dtMaxMs} ms  |a| ${s.accelNormG} g`)
  console.log(`\nRest gyro bias (raw LSB): ${JSON.stringify(bias)}  ->  dps: ${JSON.stringify(Object.fromEntries(AX.map((a) => [a, +(bias[a] * K0).toFixed(2)])))}`)
  if (rest) console.log(`Rest noise sd (raw LSB): x ${rest.gyroSd_x} y ${rest.gyroSd_y} z ${rest.gyroSd_z}`)
  console.log('\nScale checks (1.000 = the nominal 0.0610 dps/LSB is right):')
  for (const [n, s] of Object.entries(report.scale)) console.log(`  ${n.padEnd(16)} axis ${s.dominantAxis}  measured ${s.measuredTravelDegAtNominal ?? s.peakToPeakDegAtNominal} deg vs expected ${s.expectedDeg}  => multiplier ${s.suggestedMultiplier}`)
  console.log('\nDrift while still (degrees over the step, rest bias removed):')
  for (const [n, d] of Object.entries(report.drift)) console.log(`  ${n.padEnd(14)} x ${d.withRestBias.x.signedDeg}  y ${d.withRestBias.y.signedDeg}  z ${d.withRestBias.z.signedDeg}   own bias vs rest (raw): ${JSON.stringify(d.ownBiasRawMinusRest)}`)
  if (report.returnToStartErrorDeg) console.log(`\nReturn-to-start error after all moves (pure gyro): nominal ${report.returnToStartErrorDeg.nominalScale} deg, with the estimated scale ${report.returnToStartErrorDeg.estimatedScale} deg (scale ${report.returnToStartErrorDeg.estimatedDpsPerLsb} dps/LSB); gravity angle start vs end ${report.gravityAngleBetweenStartAndEndDeg} deg`)
}
