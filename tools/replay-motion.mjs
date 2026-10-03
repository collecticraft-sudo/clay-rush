#!/usr/bin/env node
// Replay a real Joy-Con 2 recording (tools/record-imu.mjs) through candidate pointer models and the cut logic, and print the metrics that
// docs/motion-contract.md section 5 defines. This file is a REFERENCE PROTOTYPE of the contract formulas (docs/motion-contract.md 2 to 4),
// written by the motion analyst; it is not production code and the pipeline does not import it. The motion engineer ports the formulas
// into public/js/motion/** and test/motion/**; the numbers printed here are the targets that port must reproduce (+- the stated tolerance).
//
// Usage:
//   node tools/replay-motion.mjs                      every model, every metric (a few seconds)
//   node tools/replay-motion.mjs --model rel          only the chosen model ("base", "abs27", "abs12", "relGravity", "relRoll", "rel")
//   node tools/replay-motion.mjs --json               machine readable
//   node tools/replay-motion.mjs --sweep-T            false-cut and hit tables for a range of cut thresholds
//   node tools/replay-motion.mjs --file recordings/imu-<stamp>.jsonl
//
// Models
//   base      the pipeline as shipped before 2026-09-30 (absolute orientation, 27.4 px/deg, cut threshold 1000 px/s), run through the real
//             public/js/motion/pipeline.js with a nominal calibration
//   abs27     same pipeline, only the cut logic replaced by the new one (angular speed) so the POINTER can be compared on its own
//   abs12     the absolute model with a lower gain (12 px/deg), the best an absolute model can do about sensitivity
//   relGravity relative pointer in "player space": tip velocity decomposed with the gravity direction of the orientation filter every sample
//   relRoll   relative pointer, sword-plane velocity rotated by a slowly tracked, clamped roll angle taken from gravity
//   rel       CHOSEN: relative pointer in "local space": cursor velocity from the gyro components about the calibrated sword axes
//
// UNVERIFIED-ON-HARDWARE: everything below is computed on ONE recording of ONE controller (Joy-Con 2 Right), hand-timed steps, no ground truth
// orientation. The mount frame used is the one the recording implies (forward = device +y, up = +z, right = +x), the real wizard must find it.
import fs from 'node:fs'
import { createMotionPipeline } from '../public/js/motion/index.js'
import { MOTION_CONFIG } from '../public/js/motion/motion-config.js'
import { OrientationFilter, accelTrustWeight } from '../public/js/motion/fusion.js'
import { loadRecording, DEFAULT_RECORDING, findStrokes, quantile, sortedCopy, median, mean } from './lib/imu-recording.mjs'

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const FIELD = { w: 1920, h: 1080, cx: 960, cy: 540 }
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const smoothstep = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c) }
const DEG = 180 / Math.PI

// ------------------------------------------------------------------------------------------------ the contract parameters (section 2 to 4)
export const PARAMS = Object.freeze({
  // pointer curve (docs/motion-contract.md 2.2)
  deadDps: 5, // dead zone: tangent speed at or below this moves nothing
  rampDps: 300, // the gain goes from gLo to gHi over this much speed above the dead zone (smoothstep)
  gLoPxDeg: 5, // px per degree just above the dead zone at sensitivity 1.0
  gHiPxDeg: 14, // px per degree for fast motion at sensitivity 1.0
  sensitivity: 1.0,
  // cut decision (2.4), angular speed of the blade axis in deg/s
  cutDps: 300,
  releaseRatio: 0.65,
  minDurationMs: 25,
  graceMs: 100,
  // idle auto-centre (2.3)
  autoCentre: true,
  idleDps: 8,
  idleBreakDps: 14,
  idleHoldS: 1.0,
  quietMs: 500,
  centreMaxPxS: 800,
  centreMinPxS: 120,
  centreGain: 2.5,
  centreRampMs: 300,
  // roll compensation (2.1)
  rollMaxDeg: 60,
  rollTauS: 0.3,
  rollMinCos: 0.64, // update the roll estimate only while the blade is within 50 degrees of the horizon
  rollMaxDps: 120,
  // path (2.5)
  maxChordPx: 48,
  maxSubSteps: 32,
  extrapolateMaxMs: 35,
})

// ------------------------------------------------------------------------------------------------ recording adapters
const recordingFile = opt('file', DEFAULT_RECORDING)
const REC = loadRecording(recordingFile)
const AX = ['x', 'y', 'z']
function quietRun(l, maxDev = 6) {
  const med = Object.fromEntries(AX.map((a) => [a, median(l.map((s) => s.g[a]))]))
  let best = [0, 0]
  let start = null
  for (let i = 0; i <= l.length; i += 1) {
    const ok = i < l.length && AX.every((a) => Math.abs(l[i].g[a] - med[a]) < maxDev)
    if (ok && start === null) start = i
    if (!ok && start !== null) { if (i - start > best[1] - best[0]) best = [start, i]; start = null }
  }
  return l.slice(best[0], best[1])
}
const restWin = quietRun(REC.steps.rest_table)
export const BIAS = Object.fromEntries(AX.map((a) => [a, median(restWin.map((s) => s.g[a]))])) // dps, the clean table window

/** ImuSample-like objects of one step (t relative to the step start, dtMs null on the first sample). */
function stepSamples(name, fromS = 0, toS = Infinity) {
  const all = REC.steps[name]
  const tStep = all[0].t
  const l = all.filter((s) => (s.t - tStep) / 1000 >= fromS && (s.t - tStep) / 1000 < toS)
  const t0 = l[0].t
  return l.map((s, i) => ({ seq: i, t: s.t - t0, arrivedAt: s.t - t0, dtMs: i === 0 ? null : s.dtMs, dtSource: 'device', accel: { ...s.a }, gyro: { ...s.g }, side: 'R', buttons: [], batteryMv: 3435, tempC: null, imuActive: true }))
}
const FRAME = { right: { x: 1, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 } }
const NOMINAL_CAL = { version: 1, side: 'R', createdAt: 0, frame: FRAME, gyroBiasDps: { ...BIAS }, gyroSign: 1, gyroScale: 1, gyroScaleSource: 'default', accelG0: 1, quality: { poseAngleDeg: 90, stillPeakDps: 1, warnings: [] } }

// ------------------------------------------------------------------------------------------------ vector helpers
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
const norm = (a) => Math.hypot(a.x, a.y, a.z)
const unit = (a) => { const n = norm(a); return n < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: a.x / n, y: a.y / n, z: a.z / n } }

// ------------------------------------------------------------------------------------------------ contract formulas
/** Pointer speed in px/s for a tangent angular speed s (deg/s) at sensitivity `sens` (contract 2.2). */
export function pointerSpeedPxS(s, P = PARAMS, sens = P.sensitivity) {
  const e = s - P.deadDps
  if (!(e > 0)) return 0
  const gain = P.gLoPxDeg + (P.gHiPxDeg - P.gLoPxDeg) * smoothstep(e / P.rampDps)
  return e * gain * sens
}
export const gainPxPerDeg = (s, P = PARAMS, sens = P.sensitivity) => (s > P.deadDps ? pointerSpeedPxS(s, P, sens) / s : 0)

/** The prototype pipeline: orientation filter for the gravity direction, tangent velocity, pointer curve, auto-centre, cut tracker, path. */
class Proto {
  constructor(P, { mode = 'local' } = {}) {
    this.P = P
    this.mode = mode
    this.filter = new OrientationFilter(MOTION_CONFIG.fusion.tauS, { bootS: MOTION_CONFIG.fusion.bootS, bootTauS: MOTION_CONFIG.fusion.bootTauS })
    this.reset()
  }

  reset() {
    this.filter.reset()
    this.have = false
    this.x = FIELD.cx
    this.y = FIELD.cy
    this.prev = null // {t, x, y, vx, vy, s}
    this.pw = null
    this.phi = null // tracked roll angle of the blade about its axis relative to level, deg, clamped
    this.cutting = false
    this.cand = null
    this.lastLeftT = -Infinity
    this.lastCuttingT = -Infinity
    this.swingId = 0
    this.idleFor = 0
    this.centring = false
    this.centreStartT = 0
    this.refDriven = false
  }

  /** Feed one ImuSample-like; returns the output for this sample and the sub-samples since the previous one. */
  push(smp) {
    const P = this.P
    const t = smp.t
    const dtMs = smp.dtMs
    const w = { x: smp.gyro.x - BIAS.x, y: smp.gyro.y - BIAS.y, z: smp.gyro.z - BIAS.z }
    const wmag = norm(w)
    // ---- orientation filter (only for the gravity direction)
    const a = smp.accel
    if (!this.filter.ready) this.filter.initFromAccel(a.x, a.y, a.z)
    else if (dtMs > 0) {
      const k = Math.PI / 180
      const cur = { x: w.x * k, y: w.y * k, z: w.z * k }
      let m = cur
      if (this.pw) {
        const c = dtMs / 12000
        m = { x: 0.5 * (this.pw.x + cur.x) + c * (this.pw.y * cur.z - this.pw.z * cur.y), y: 0.5 * (this.pw.y + cur.y) + c * (this.pw.z * cur.x - this.pw.x * cur.z), z: 0.5 * (this.pw.z + cur.z) + c * (this.pw.x * cur.y - this.pw.y * cur.x) }
      }
      this.filter.integrate(m.x, m.y, m.z, dtMs / 1000)
      const trust = accelTrustWeight(MOTION_CONFIG.fusion, { accelMagG: norm(a), angularSpeedDps: wmag, cutting: this.cutting, sinceCutMs: t - this.lastCuttingT })
      this.filter.correct(a.x, a.y, a.z, dtMs / 1000, trust)
    }
    {
      const k = Math.PI / 180
      this.pw = { x: w.x * k, y: w.y * k, z: w.z * k }
    }
    // ---- tangent velocity of the blade axis (contract 2.1)
    const d = FRAME.forward
    let vR
    let vU
    const tv = cross(w, d) // velocity of the tip direction, deg/s, perpendicular to d (roll about d does not move the tip)
    const s = norm(tv)
    const aR = dot(tv, FRAME.right) // tip velocity towards the sword's right, deg/s   (= -w . up)
    const aU = dot(tv, FRAME.up) // tip velocity towards the sword's up, deg/s       (= +w . right)
    if (this.mode === 'local') {
      // CHOSEN (contract 2.1): the pointer lives in the sword plane: no gravity, no roll compensation
      vR = aR
      vU = aU
    } else if (this.mode === 'gravity') {
      // rejected: tip velocity decomposed with the gravity direction of the orientation filter every sample (player space); flips at the pole
      const up = { ...this.filter.predictedUp() }
      const eU = unit({ x: up.x - dot(up, d) * d.x, y: up.y - dot(up, d) * d.y, z: up.z - dot(up, d) * d.z })
      const eR = unit(cross(d, up))
      vR = dot(tv, eR)
      vU = dot(tv, eU)
    } else {
      // rejected: sword-plane velocity rotated by a slowly tracked, clamped roll angle from gravity
      const up = this.filter.predictedUp()
      const uR = dot(up, FRAME.right)
      const uU = dot(up, FRAME.up)
      const cosPitch = Math.hypot(uR, uU)
      const phiG = clamp(Math.atan2(uR, uU) * DEG, -P.rollMaxDeg, P.rollMaxDeg)
      if (this.phi === null) this.phi = cosPitch >= P.rollMinCos ? phiG : 0
      else if (cosPitch >= P.rollMinCos && s < P.rollMaxDps && !this.cutting && Math.abs(norm(a) - 1) <= 0.15 && dtMs > 0) this.phi += (phiG - this.phi) * (1 - Math.exp(-dtMs / 1000 / P.rollTauS))
      const ph = this.phi * (Math.PI / 180)
      vR = aR * Math.cos(ph) - aU * Math.sin(ph)
      vU = aR * Math.sin(ph) + aU * Math.cos(ph)
    }
    // ---- pointer velocity in px/s (screen y down)
    const F = pointerSpeedPxS(s, P)
    const vx = s > 1e-9 ? (F * vR) / s : 0
    const vy = s > 1e-9 ? (-F * vU) / s : 0

    const out = { t, s, wmag, vx, vy, segs: [], sub: [], discontinuity: false }
    if (!this.have) {
      this.have = true
      this.prev = { t, x: this.x, y: this.y, vx, vy, s }
      out.x = this.x
      out.y = this.y
      out.cutting = false
      out.swingId = this.swingId
      out.refDriven = false
      out.speedPx = Math.hypot(vx, vy)
      return out
    }
    const pr = this.prev
    const dt = Math.max((t - pr.t) / 1000, 1e-4)
    const dtSeg = t - pr.t
    // ---- position increment by the trapezoid rule (equivalently: velocity linear in time over the interval)
    const dx = 0.5 * (pr.vx + vx) * dt
    const dy = 0.5 * (pr.vy + vy) * dt
    let ex = this.x + dx
    let ey = this.y + dy
    ex = clamp(ex, 0, FIELD.w)
    ey = clamp(ey, 0, FIELD.h)

    // ---- idle auto-centre (contract 2.3); it never runs while cutting, and stops the moment the sword moves
    let carried = false
    if (P.autoCentre && !this.cutting && t - this.lastCuttingT >= P.quietMs) {
      if (!this.centring) {
        if (s < P.idleDps) {
          this.idleFor += dt
          if (this.idleFor >= P.idleHoldS) { this.centring = true; this.centreStartT = t }
        } else this.idleFor = 0
      } else if (s > P.idleBreakDps) {
        this.centring = false
        this.idleFor = 0
      }
    } else {
      this.centring = false
      this.idleFor = 0
    }
    if (this.centring) {
      const cx = FIELD.cx - ex
      const cy = FIELD.cy - ey
      const dist = Math.hypot(cx, cy)
      if (dist > 0.5) {
        const ramp = Math.min(1, (t - this.centreStartT) / P.centreRampMs)
        const spd = Math.min(P.centreMaxPxS, Math.max(P.centreMinPxS, P.centreGain * dist)) * ramp
        const step = Math.min(dist, spd * dt)
        ex += (cx / dist) * step
        ey += (cy / dist) * step
        carried = true
      }
    }
    this.refDriven = carried

    // ---- path between the two samples: position quadratic in time (velocity linear), sub-sampled so no chord exceeds maxChordPx
    const x0 = pr.x
    const y0 = pr.y
    const pathLen = Math.hypot(ex - x0, ey - y0) // chord length; the path is nearly straight per interval, sagitta is small
    const lenEst = Math.max(pathLen, 0.5 * (Math.hypot(pr.vx, pr.vy) + Math.hypot(vx, vy)) * dt)
    // time-uniform sub-steps; speed varies inside the interval, so the longest chord comes out at about 1.3 x maxChordPx (bound: 2 x)
    const n = clamp(Math.ceil(lenEst / P.maxChordPx), 1, P.maxSubSteps)
    const pts = []
    let prevPt = { t: pr.t, x: x0, y: y0, v: Math.hypot(pr.vx, pr.vy) }
    for (let j = 1; j <= n; j += 1) {
      const u = j / n
      const tau = u * dt
      let px
      let py
      if (j === n) {
        px = ex // the real end point (clamped, and moved by the auto-centre when that runs, which it never does while cutting)
        py = ey
      } else {
        // free path: velocity linear in time over the interval (position quadratic), each point clamped to the playfield
        px = clamp(x0 + pr.vx * tau + 0.5 * ((vx - pr.vx) / dt) * tau * tau, 0, FIELD.w)
        py = clamp(y0 + pr.vy * tau + 0.5 * ((vy - pr.vy) / dt) * tau * tau, 0, FIELD.h)
      }
      const sp = Math.hypot(pr.vx + (vx - pr.vx) * u, pr.vy + (vy - pr.vy) * u)
      const pt = { t: pr.t + dtSeg * u, x: px, y: py, v: sp }
      pts.push({ from: prevPt, to: pt })
      prevPt = pt
    }

    // ---- cut tracker (contract 2.4)
    const T = P.cutDps
    const Trel = P.releaseRatio * T
    let enteredNow = false
    let retro = null
    let candNew = false
    if (!this.cutting) {
      if (s >= T) {
        if (this.cand === null) { this.cand = { tAbove: t, t0: pr.t, x0: pr.x, y0: pr.y }; candNew = true }
        if (t - this.cand.tAbove >= P.minDurationMs && s >= Trel) {
          this.cutting = true
          enteredNow = true
          retro = this.cand
          this.cand = null
          if (this.swingId === 0 || t - this.lastLeftT > P.graceMs) this.swingId += 1
        }
      } else if (this.cand !== null && s >= Trel && t - this.cand.tAbove < 4 * P.minDurationMs) {
        // a dip that stays above the release level keeps the candidate
      } else {
        this.cand = null
      }
    } else if (s < Trel) {
      this.cutting = false
      this.lastLeftT = t
    }
    if (this.cutting) this.lastCuttingT = t

    // segments: while cutting every sub-step is a segment; on entry the candidate's chord (from the sample before the first one above T) is included
    if (this.cutting) {
      if (enteredNow && retro && retro.t0 < pr.t) {
        // the candidate's first chord ends at the previous sample: its sub-steps were produced one call earlier and held back in this.heldSubs
        for (const hs of this.heldSubs ?? []) out.segs.push({ ...hs, swingId: this.swingId })
      }
      for (const p of pts) out.segs.push({ t0: p.from.t, x0: p.from.x, y0: p.from.y, t1: p.to.t, x1: p.to.x, y1: p.to.y, speed: p.to.v, swingId: this.swingId })
      this.heldSubs = []
    } else if (this.cand !== null) {
      // pending: hold the chords back, all of them since the anchor (they become segments only if the candidate is confirmed)
      if (candNew) this.heldSubs = []
      for (const p of pts) this.heldSubs.push({ t0: p.from.t, x0: p.from.x, y0: p.from.y, t1: p.to.t, x1: p.to.x, y1: p.to.y, speed: p.to.v, swingId: this.swingId + 1 })
      // the candidate was created at this very sample: its chord is exactly the one just produced
    } else {
      this.heldSubs = []
    }
    out.sub = pts.map((p) => ({ t: p.to.t, x: p.to.x, y: p.to.y, v: p.to.v }))

    this.x = ex
    this.y = ey
    this.prev = { t, x: ex, y: ey, vx, vy, s }
    out.x = ex
    out.y = ey
    out.cutting = this.cutting
    out.swingId = this.swingId
    out.refDriven = carried
    out.speedPx = Math.hypot(vx, vy)
    return out
  }
}

// ------------------------------------------------------------------------------------------------ running models over steps
/** One output row per IMU sample: {t, x, y, s, cutting, refDriven, segs, sub, vx, vy}. Times relative to the step start. */
function runProtoStep(name, P = PARAMS, opts = {}, fromS = 0, toS = Infinity) {
  const pr = new Proto(P, opts)
  return stepSamples(name, fromS, toS).map((smp) => pr.push(smp))
}

/** The shipped pipeline with a nominal calibration; `cutMode: 'old'` keeps its own tracker, `'angular'` replaces its decision by ours afterwards. */
function runPipelineStep(name, { pxPerDeg = 27.4, sensitivity = 1, cutThreshold = 300, autoCenter = true, cutDps = null, P = PARAMS, fromS = 0, toS = Infinity } = {}) {
  // the shipped absolute model (round 'sword tuning', 2026-09-30: the pipeline's default is now the relative one; cutThreshold is in deg/s, 300 = the old 1000 px/s)
  const pipe = createMotionPipeline({ pointerModel: 'absolute', settings: { sensitivity, cutThreshold, autoCenter }, config: { input: { pxPerDegBase: pxPerDeg } } })
  pipe.setCalibration(NOMINAL_CAL)
  const rows = []
  const segs = []
  pipe.on('blade', (b) => rows.push({ t: b.t, x: b.x, y: b.y, s: b.angularSpeedDps ?? 0, cutting: b.cutting, discontinuity: b.discontinuity, speedPx: b.speed, refDriven: false, segs: [], sub: [] }))
  const samples = stepSamples(name, fromS, toS)
  samples.forEach((smp, i) => {
    pipe.pushImu(smp)
    if (i === 0) pipe.recenter('manual')
    for (const sg of pipe.drainSegments()) segs.push(sg)
  })
  const out = rows
  // angular-speed cut decision on top of the absolute pointer (abs27, abs12): same tracker rules as Proto
  if (cutDps !== null) {
    let cutting = false
    let cand = null
    let lastLeft = -Infinity
    for (let i = 0; i < out.length; i += 1) {
      const r = out[i]
      const s = samples[i]
      const w = Math.hypot(s.gyro.x - BIAS.x, s.gyro.z - BIAS.z) // tangent speed with forward = device y
      r.s = w
      const T = cutDps
      if (!cutting) {
        if (w >= T) { if (cand === null) cand = r.t; if (r.t - cand >= P.minDurationMs && w >= P.releaseRatio * T) { cutting = true; cand = null } } else if (!(cand !== null && w >= P.releaseRatio * T)) cand = null
      } else if (w < P.releaseRatio * T) { cutting = false; lastLeft = r.t }
      r.cutting = cutting
    }
    void lastLeft
  }
  return out
}

export { runProtoStep, stepSamples }
const PROTO_MODE = { rel: 'local', relGravity: 'gravity', relRoll: 'roll' }
const MODELS = {
  base: { label: 'base (shipped: absolute 27.4 px/deg, 1000 px/s)', run: (n, a, b) => runPipelineStep(n, { fromS: a, toS: b }) },
  abs27: { label: 'abs27 (absolute 27.4 px/deg, new cut logic)', run: (n, a, b) => runPipelineStep(n, { cutDps: PARAMS.cutDps, fromS: a, toS: b }) },
  abs12: { label: 'abs12 (absolute 12 px/deg, new cut logic)', run: (n, a, b) => runPipelineStep(n, { pxPerDeg: 12, cutDps: PARAMS.cutDps, fromS: a, toS: b }) },
  relGravity: { label: 'relGravity (relative, player space: tip velocity decomposed with the gravity direction every sample)', run: (n, a, b) => runProtoStep(n, PARAMS, { mode: 'gravity' }, a, b) },
  relRoll: { label: 'relRoll (relative, sword plane rotated by a tracked clamped roll angle)', run: (n, a, b) => runProtoStep(n, PARAMS, { mode: 'roll' }, a, b) },
  rel: { label: 'rel (CHOSEN: relative, local space = sword plane, no gravity)', run: (n, a, b) => runProtoStep(n, PARAMS, {}, a, b) },
}

// ------------------------------------------------------------------------------------------------ metrics
// hold windows are replayed as their own runs (cursor starts at the centre at the window start), the others are windows of a full-step replay
const WIN = {
  holdStill: ['hold_still@7', 0, Infinity],
  returnStill: ['return_still@2', 0, Infinity],
  yaw: ['yaw_sweep', 1, 21],
  pitch: ['pitch_sweep', 1, 21],
  roll: ['roll_360', 2, 14],
  spin: ['table_spin_360', 2, 16],
  fastH: ['fast_swings_h', 0, Infinity],
  fastV: ['fast_swings_v', 0, Infinity],
}
const inWin = (rows, [, a, b]) => rows.filter((r) => r.t / 1000 >= a && r.t / 1000 < b)
const range = (xs) => Math.max(...xs) - Math.min(...xs)
const pct = (x) => Math.round(x * 10) / 10
const timeShare = (rows, pred) => { let tot = 0; let on = 0; for (let i = 1; i < rows.length; i += 1) { const dt = rows[i].t - rows[i - 1].t; tot += dt; if (pred(rows[i])) on += dt } return tot > 0 ? (100 * on) / tot : 0 }
const onEdge = (r) => r.x <= 0.5 || r.x >= FIELD.w - 0.5 || r.y <= 0.5 || r.y >= FIELD.h - 0.5

/** Reference (hard) strokes of a fast-swing step: local maxima of |w| of at least 150 dps with |a| >= 2 g within 3 samples of the peak. */
function hardStrokes(name) {
  const l = REC.steps[name]
  const t0 = l[0].t
  const w = (s) => Math.hypot(s.g.x - BIAS.x, s.g.y - BIAS.y, s.g.z - BIAS.z)
  return findStrokes(l, w, { minPeak: 150 }).filter((s) => s.aPeak >= 2.0).map((s) => ({ ...s, tRel: s.t - t0, t0Rel: l[s.a].t - t0, t1Rel: l[s.b].t - t0 }))
}

function strokeCuts(rows, strokes) {
  // a stroke "produces a cut" when the blade is CUTTING at some sample within +-60 ms of the speed peak AND the cut segments cover at least
  // half of the cursor path length inside the stroke extent
  let hit = 0
  const cover = []
  const latencies = []
  for (const st of strokes) {
    const inStroke = rows.filter((r) => r.t >= st.t0Rel - 1 && r.t <= st.t1Rel + 1)
    const atPeak = rows.some((r) => Math.abs(r.t - st.tRel) <= 60 && r.cutting)
    let path = 0
    let cutPath = 0
    for (let i = 1; i < inStroke.length; i += 1) path += Math.hypot(inStroke[i].x - inStroke[i - 1].x, inStroke[i].y - inStroke[i - 1].y)
    // cut path: prefer emitted segments, fall back to cutting samples
    const segs = inStroke.flatMap((r) => r.segs ?? [])
    if (segs.length) for (const sg of segs) cutPath += Math.hypot(sg.x1 - sg.x0, sg.y1 - sg.y0)
    else for (let i = 1; i < inStroke.length; i += 1) if (inStroke[i].cutting) cutPath += Math.hypot(inStroke[i].x - inStroke[i - 1].x, inStroke[i].y - inStroke[i - 1].y)
    const frac = path > 0 ? cutPath / path : 0
    cover.push(frac)
    if (atPeak && frac >= 0.5) hit += 1
    const first = rows.find((r) => r.t >= st.t0Rel - 60 && r.cutting)
    if (first) latencies.push(first.t - st.t0Rel)
  }
  return { n: strokes.length, hit, share: strokes.length ? (100 * hit) / strokes.length : NaN, coverMedian: cover.length ? median(cover) : NaN, coverMin: cover.length ? Math.min(...cover) : NaN }
}

function cutEntries(rows) {
  let n = 0
  for (let i = 1; i < rows.length; i += 1) if (rows[i].cutting && !rows[i - 1].cutting) n += 1
  return n
}

function metricsFor(modelKey, runs) {
  const m = {}
  const get = (k) => inWin(runs[WIN[k][0]], WIN[k])
  // P1 cursor excursion while holding still
  for (const k of ['holdStill', 'returnStill']) {
    const r = get(k)
    const x0 = r[0].x
    const y0 = r[0].y
    m[k] = { xRangePx: range(r.map((q) => q.x)), yRangePx: range(r.map((q) => q.y)), maxFromStartPx: Math.max(...r.map((q) => Math.hypot(q.x - x0, q.y - y0))), cutSharePct: timeShare(r, (q) => q.cutting), refDrivenPct: timeShare(r, (q) => q.refDriven) }
  }
  // P2/P3 sweeps: coverage and time pinned at an edge
  for (const k of ['yaw', 'pitch', 'roll', 'spin']) {
    const r = get(k)
    m[k] = { xRangePct: (100 * range(r.map((q) => q.x))) / FIELD.w, yRangePct: (100 * range(r.map((q) => q.y))) / FIELD.h, edgePct: timeShare(r, onEdge), cutSharePct: timeShare(r, (q) => q.cutting), cutEntries: cutEntries(r), maxSamplesCutRun: 0 }
  }
  // P4 fast swings
  for (const k of ['fastH', 'fastV']) {
    const r = get(k)
    const st = hardStrokes(WIN[k][0])
    m[k] = { ...strokeCuts(r, st), edgePct: timeShare(r, onEdge), cutSharePct: timeShare(r, (q) => q.cutting), maxStepPx: Math.max(...r.slice(1).map((q, i) => Math.hypot(q.x - r[i].x, q.y - r[i].y))) }
  }
  return m
}

// idle auto-centre: replay a displaced state followed by the real hand-held still data (return_still from 2 s), measure the time to centre
function idleCentreTimes(modelKey) {
  const results = {}
  if (!modelKey.startsWith('rel')) return results
  const still = stepSamples('return_still').filter((s) => s.t >= 2000)
  const starts = { corner: [60, 60], edgeRight: [1860, 540], farBottom: [960, 1040], nearCentre: [1100, 600] }
  for (const [label, [sx, sy]] of Object.entries(starts)) {
    const pr = new Proto(PARAMS, { mode: PROTO_MODE[modelKey] })
    pr.push({ ...still[0], t: 0, dtMs: null })
    pr.x = sx
    pr.y = sy
    pr.prev = { ...pr.prev, x: sx, y: sy }
    pr.lastCuttingT = -Infinity
    let t = 0
    let t100 = null
    let t20 = null
    for (let i = 1; i < still.length; i += 1) {
      t += still[i].dtMs
      const o = pr.push({ ...still[i], t })
      const d = Math.hypot(o.x - FIELD.cx, o.y - FIELD.cy)
      if (t100 === null && d <= 100) t100 = t
      if (t20 === null && d <= 20) { t20 = t; break }
    }
    results[label] = { startDistPx: Math.round(Math.hypot(sx - FIELD.cx, sy - FIELD.cy)), within100Ms: t100, within20Ms: t20 }
  }
  return results
}

// auto-centre must not fight a swing: replay yaw_sweep (continuous motion) and confirm that the centring never ran while s > idleBreak
function autoCentreDoesNotFight(rows) {
  let bad = 0
  for (const r of rows) if (r.refDriven && (r.cutting || r.s > PARAMS.idleBreakDps * 1.5)) bad += 1
  return bad
}

// slow posture change: 30 deg of yaw and 20 deg of pitch over 2 s (15 and 10 deg/s), injected on real still data
function postureTest(modelKey) {
  const base = stepSamples('return_still').filter((s) => s.t >= 2000)
  const t0 = base[0].t
  const samples = base.map((s, i) => ({ ...s, t: s.t - t0, dtMs: i === 0 ? null : s.dtMs, accel: { ...s.accel }, gyro: { ...s.gyro } }))
  // rotate about device x (pitch) and z (yaw) kinematically: gyro += rate, accel = R_x(-theta) u0
  let thPitch = 0
  const out = []
  const dur = 2000
  const yawRate = 15
  const pitchRate = 10
  const ax0 = mean(samples.slice(0, 20).map((s) => s.accel.x))
  const ay0 = mean(samples.slice(0, 20).map((s) => s.accel.y))
  const az0 = mean(samples.slice(0, 20).map((s) => s.accel.z))
  const inj = samples.map((s, i) => {
    const active = s.t >= 500 && s.t < 500 + dur
    if (i > 0 && active) thPitch += pitchRate * (s.dtMs / 1000)
    const c = Math.cos((thPitch * Math.PI) / 180)
    const sn = Math.sin((thPitch * Math.PI) / 180)
    // gravity seen after pitching the tip up by thPitch: rotate the rest vector about device x by -thPitch
    const ay = ay0 * c + az0 * sn
    const az = -ay0 * sn + az0 * c
    return { ...s, gyro: { x: s.gyro.x + (active ? pitchRate : 0), y: s.gyro.y, z: s.gyro.z + (active ? yawRate : 0) }, accel: { x: ax0 + (s.accel.x - ax0), y: ay + (s.accel.y - ay0), z: az + (s.accel.z - az0) } }
  })
  let rows
  if (modelKey.startsWith('rel')) {
    const pr = new Proto(PARAMS, { mode: PROTO_MODE[modelKey] })
    rows = inj.map((s) => pr.push(s))
  } else {
    const pxPerDeg = modelKey === 'abs12' ? 12 : 27.4
    const pipe = createMotionPipeline({ pointerModel: 'absolute', settings: { sensitivity: 1, cutThreshold: 700, autoCenter: false }, config: { input: { pxPerDegBase: pxPerDeg } } })
    pipe.setCalibration(NOMINAL_CAL)
    rows = []
    pipe.on('blade', (b) => rows.push({ t: b.t, x: b.x, y: b.y }))
    inj.forEach((s, i) => { pipe.pushImu(s); if (i === 0) pipe.recenter('manual') })
  }
  // the cursor offset just after the posture change finished (before any auto-centre can act: measure at the end of the change + 0.3 s)
  const tEnd = 500 + dur + 300
  const r = rows.find((q) => q.t >= tEnd) ?? rows.at(-1)
  return { xOffsetPx: Math.round(r.x - FIELD.cx), yOffsetPx: Math.round(r.y - FIELD.cy), travelPx: Math.round(Math.hypot(r.x - FIELD.cx, r.y - FIELD.cy)) }
}

// the interpolation and extrapolation study (contract 2.5): errors in px at 60 fps frame times
function extrapolationStudy() {
  const name = 'fast_swings_h'
  const rows = runProtoStep(name)
  const strokes = hardStrokes(name)
  const preds = {
    holdLast: (p, v0, a, dtS) => ({ x: p.x, y: p.y }),
    linear: (p, v0, a, dtS) => ({ x: p.x + v0.x * dtS, y: p.y + v0.y * dtS }),
    linearDamped: (p, v0, a, dtS) => { const f = Math.max(0, 1 - dtS / 0.06); return { x: p.x + v0.x * dtS * (0.5 + 0.5 * f), y: p.y + v0.y * dtS * (0.5 + 0.5 * f) } },
    accelClamped: (p, v0, a, dtS) => {
      // velocity changes linearly with the last measured acceleration but never reverses
      const sp0 = Math.hypot(v0.x, v0.y)
      if (sp0 < 1e-6) return { x: p.x, y: p.y }
      const along = (a.x * v0.x + a.y * v0.y) / sp0
      let tt = dtS
      if (along < 0) tt = Math.min(dtS, sp0 / -along)
      return { x: p.x + v0.x * tt + 0.5 * a.x * tt * tt, y: p.y + v0.y * tt + 0.5 * a.y * tt * tt }
    },
  }
  const errs = Object.fromEntries(Object.keys(preds).map((k) => [k, []]))
  for (const st of strokes) {
    for (let i = 1; i < rows.length - 1; i += 1) {
      if (rows[i].t < st.t0Rel || rows[i].t > st.t1Rel) continue
      const r0 = rows[i]
      const r1 = rows[i + 1]
      const prev = rows[i - 1]
      const dt = (r1.t - r0.t) / 1000
      const accel = { x: (r0.vx - prev.vx) / ((r0.t - prev.t) / 1000), y: (r0.vy - prev.vy) / ((r0.t - prev.t) / 1000) }
      for (const frac of [0.2, 0.4, 0.6, 0.8, 1.0]) {
        const tau = frac * dt
        // the truth at t0 + tau: the quadratic (velocity linear) path between the two samples
        const tx = r0.x + r0.vx * tau + 0.5 * ((r1.vx - r0.vx) / dt) * tau * tau
        const ty = r0.y + r0.vy * tau + 0.5 * ((r1.vy - r0.vy) / dt) * tau * tau
        for (const [k, fn] of Object.entries(preds)) {
          const p = fn({ x: r0.x, y: r0.y }, { x: r0.vx, y: r0.vy }, accel, tau)
          errs[k].push(Math.hypot(p.x - tx, p.y - ty))
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, { meanPx: mean(v), p95Px: quantile(sortedCopy(v), 0.95), maxPx: Math.max(...v) }]))
}

// coverage of the path by the emitted sub-segments and the largest chord (no-tunnelling metric, contract 5.6)
function tunnelStudy() {
  const res = {}
  for (const name of ['fast_swings_h', 'fast_swings_v']) {
    const rows = runProtoStep(name)
    const segs = rows.flatMap((r) => r.segs)
    const lens = segs.map((s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0))
    // continuity: every segment starts where the previous one ended inside a swing
    let gaps = 0
    for (let i = 1; i < segs.length; i += 1) if (Math.abs(segs[i].t0 - segs[i - 1].t1) < 0.01 && Math.hypot(segs[i].x0 - segs[i - 1].x1, segs[i].y0 - segs[i - 1].y1) > 0.5) gaps += 1
    // a dense 1 ms reference path (quadratic per interval) and the distance of every dense point to the nearest segment
    let worst = 0
    let dense = 0
    for (let i = 1; i < rows.length; i += 1) {
      const r0 = rows[i - 1]
      const r1 = rows[i]
      if (!r1.cutting && !r0.cutting) continue
      const dt = (r1.t - r0.t) / 1000
      for (let ms = 0; ms <= (r1.t - r0.t); ms += 1) {
        const tau = ms / 1000
        const px = clamp(r0.x + r0.vx * tau + 0.5 * ((r1.vx - r0.vx) / dt) * tau * tau, 0, FIELD.w)
        const py = clamp(r0.y + r0.vy * tau + 0.5 * ((r1.vy - r0.vy) / dt) * tau * tau, 0, FIELD.h)
        let best = Infinity
        for (const sg of r1.segs) {
          const vx = sg.x1 - sg.x0
          const vy = sg.y1 - sg.y0
          const L2 = vx * vx + vy * vy
          const u = L2 > 0 ? clamp(((px - sg.x0) * vx + (py - sg.y0) * vy) / L2, 0, 1) : 0
          best = Math.min(best, Math.hypot(px - (sg.x0 + u * vx), py - (sg.y0 + u * vy)))
        }
        if (r1.segs.length && Number.isFinite(best)) { worst = Math.max(worst, best); dense += 1 }
      }
    }
    const perSample = rows.slice(1).map((r, i) => Math.hypot(r.x - rows[i].x, r.y - rows[i].y))
    res[name] = { segments: segs.length, maxChordPx: Math.max(...lens), p99ChordPx: quantile(sortedCopy(lens), 0.99), maxPerSampleStepPx: Math.max(...perSample), continuityGaps: gaps, worstDenseToSegmentPx: worst, peakPointerSpeedPxS: Math.max(...rows.map((r) => Math.hypot(r.vx, r.vy))) }
  }
  return res
}

/** Net unclamped cursor displacement (px) of every hard stroke under a relative model, from the pointer velocities (vx, vy). */
function strokeVectors(runs) {
  const out = []
  for (const name of ['fast_swings_h', 'fast_swings_v']) {
    const rows = runs[name]
    for (const st of hardStrokes(name)) {
      let x = 0
      let y = 0
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].t < st.t0Rel || rows[i].t > st.t1Rel) continue
        const dt = (rows[i].t - rows[i - 1].t) / 1000
        x += 0.5 * (rows[i].vx + rows[i - 1].vx) * dt
        y += 0.5 * (rows[i].vy + rows[i - 1].vy) * dt
      }
      out.push({ step: name, x, y })
    }
  }
  return out
}
const angleBetweenDeg = (a, b) => Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)) * DEG
/** Largest change of direction of the pointer velocity between two consecutive samples while the tip is fast (>= 150 deg/s) inside each hard stroke. */
function strokeDirectionJumps(runs) {
  const out = []
  for (const name of ['fast_swings_h', 'fast_swings_v']) {
    const rows = runs[name]
    for (const st of hardStrokes(name)) {
      let worst = 0
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].t < st.t0Rel || rows[i].t > st.t1Rel || rows[i].s < 150 || rows[i - 1].s < 150) continue
        const a = { x: rows[i - 1].vx, y: rows[i - 1].vy }
        const b = { x: rows[i].vx, y: rows[i].vy }
        if (Math.hypot(a.x, a.y) < 50 || Math.hypot(b.x, b.y) < 50) continue
        worst = Math.max(worst, angleBetweenDeg(a, b))
      }
      out.push(worst)
    }
  }
  return out
}

// ------------------------------------------------------------------------------------------------ driver
function runAll(modelKey) {
  const runs = {}
  for (const name of REC.order) runs[name] = MODELS[modelKey].run(name, 0, Infinity)
  runs['hold_still@7'] = MODELS[modelKey].run('hold_still', 7, Infinity)
  runs['return_still@2'] = MODELS[modelKey].run('return_still', 2, Infinity)
  return runs
}

function fmt(v, d = 1) { return Number.isFinite(v) ? v.toFixed(d) : 'n/a' }

function printModel(modelKey, m) {
  console.log(`\n### ${MODELS[modelKey].label}`)
  for (const k of ['holdStill', 'returnStill']) console.log(`  hold ${k.padEnd(12)} cursor range x ${fmt(m[k].xRangePx)} px, y ${fmt(m[k].yRangePx)} px, max distance from start ${fmt(m[k].maxFromStartPx)} px; cutting ${fmt(m[k].cutSharePct, 2)} % of time`)
  for (const k of ['yaw', 'pitch', 'roll', 'spin']) console.log(`  ${k.padEnd(5)} sweep: x range ${fmt(m[k].xRangePct)} % of width, y range ${fmt(m[k].yRangePct)} % of height; pinned at an edge ${fmt(m[k].edgePct)} % of time; CUTTING ${fmt(m[k].cutSharePct, 2)} % of time (${m[k].cutEntries} entries)`)
  for (const k of ['fastH', 'fastV']) console.log(`  ${k}: ${m[k].hit}/${m[k].n} hard strokes cut (${fmt(m[k].share, 0)} %), cut path share median ${fmt(100 * m[k].coverMedian, 0)} % (min ${fmt(100 * m[k].coverMin, 0)} %); pinned at an edge ${fmt(m[k].edgePct)} %; biggest per-sample step ${fmt(m[k].maxStepPx, 0)} px`)
}

function main() {
  const only = opt('model', null)
  const modelKeys = only ? [only] : Object.keys(MODELS)
  const report = {}
  if (!flag('sweep-T')) {
    const localVectors = strokeVectors(runAll('rel'))
    for (const key of modelKeys) {
      const runs = runAll(key)
      const m = metricsFor(key, runs)
      m.posture = postureTest(key)
      if (key.startsWith('rel')) {
        m.idleCentre = idleCentreTimes(key)
        m.autoCentreFightsSwings = autoCentreDoesNotFight([...runs.yaw_sweep, ...runs.fast_swings_h, ...runs.fast_swings_v, ...runs.pitch_sweep])
      }
      if (key.startsWith('rel')) {
        const ang = strokeVectors(runs).map((v, i) => angleBetweenDeg(v, localVectors[i]))
        const jumps = strokeDirectionJumps(runs)
        m.strokeDirectionVsLocalDeg = { median: median(ang), max: Math.max(...ang), over60: ang.filter((x) => x > 60).length, of: ang.length, jumpMax: Math.max(...jumps), jumpOver60: jumps.filter((x) => x > 60).length }
      }
      report[key] = m
      if (!flag('json')) {
        printModel(key, m)
        if (m.strokeDirectionVsLocalDeg) console.log(`  direction of the hard strokes relative to the local-space cursor direction: median ${fmt(m.strokeDirectionVsLocalDeg.median, 0)} deg, max ${fmt(m.strokeDirectionVsLocalDeg.max, 0)} deg, ${m.strokeDirectionVsLocalDeg.over60} of ${m.strokeDirectionVsLocalDeg.of} strokes turned by more than 60 deg; largest direction change of the cursor between two consecutive fast samples inside a stroke: ${fmt(m.strokeDirectionVsLocalDeg.jumpMax, 0)} deg (${m.strokeDirectionVsLocalDeg.jumpOver60} strokes above 60 deg)`)
        console.log(`  slow posture change (30 deg yaw + 20 deg pitch over 2 s at 15/10 deg/s, real tremor underneath): cursor ends ${m.posture.xOffsetPx} px / ${m.posture.yOffsetPx} px from the centre (${m.posture.travelPx} px)`)
        if (m.idleCentre) {
          console.log('  idle auto-centre from a displaced cursor, real hand-held tremor as input (ms until within 100 px / 20 px of the centre, hold time included):')
          for (const [label, r] of Object.entries(m.idleCentre)) console.log(`     ${label.padEnd(10)} start ${String(r.startDistPx).padStart(4)} px away: ${r.within100Ms}  /  ${r.within20Ms}`)
          console.log(`  auto-centre active while cutting or while the sword moves (> ${PARAMS.idleBreakDps * 1.5} dps): ${m.autoCentreFightsSwings} samples`)
        }
      }
    }
    if (!flag('json') && (!only || only === 'rel')) {
      console.log('\n### interpolation and extrapolation at 60 fps (model-based, horizontal hard strokes; error in px, truth = the quadratic path between the next two samples)')
      const ex = extrapolationStudy()
      report.extrapolation = ex
      for (const [k, v] of Object.entries(ex)) console.log(`  ${k.padEnd(13)} mean ${fmt(v.meanPx, 1)} px  p95 ${fmt(v.p95Px, 1)} px  max ${fmt(v.maxPx, 1)} px`)
      console.log('\n### no tunnelling (rel): sub-segments of the chosen model')
      const tn = tunnelStudy()
      report.tunnel = tn
      for (const [k, v] of Object.entries(tn)) console.log(`  ${k}: ${v.segments} segments, max chord ${fmt(v.maxChordPx, 0)} px (p99 ${fmt(v.p99ChordPx, 0)}), biggest step between two IMU samples ${fmt(v.maxPerSampleStepPx, 0)} px, continuity gaps ${v.continuityGaps}, worst distance of the dense path to the segments ${fmt(v.worstDenseToSegmentPx, 2)} px, peak pointer speed ${fmt(v.peakPointerSpeedPxS, 0)} px/s`)
    }
    if (flag('json')) console.log(JSON.stringify(report, null, 2))
  } else {
    // threshold sweep on the chosen model: false cutting in slow steps and hit share in hard strokes, with and without the minimum duration
    console.log('T(dps)  minDur  | yaw cut% (entries)  pitch cut% (entries)  roll cut%  spin cut%  hold cut% | hardH cut  hardV cut  (cut path share median H/V)')
    for (const minDurationMs of [0, 25]) {
      for (const T of opt('T', '') ? opt('T', '').split(',').map(Number) : [150, 200, 250, 300, 350, 400, 450, 500, 600, 700]) {
        const P = { ...PARAMS, cutDps: T, minDurationMs }
        const runs = {}
        for (const name of REC.order) runs[name] = runProtoStep(name, P)
        runs['hold_still@7'] = runProtoStep('hold_still', P, {}, 7)
        runs['return_still@2'] = runProtoStep('return_still', P, {}, 2)
        const m = metricsFor('rel', runs)
        console.log(`${String(T).padStart(5)}   ${String(minDurationMs).padStart(4)}    | ${fmt(m.yaw.cutSharePct, 2).padStart(6)} (${m.yaw.cutEntries})        ${fmt(m.pitch.cutSharePct, 2).padStart(6)} (${m.pitch.cutEntries})          ${fmt(m.roll.cutSharePct, 2).padStart(6)}    ${fmt(m.spin.cutSharePct, 2).padStart(6)}    ${fmt(Math.max(m.holdStill.cutSharePct, m.returnStill.cutSharePct), 2).padStart(6)}    | ${m.fastH.hit}/${m.fastH.n}        ${m.fastV.hit}/${m.fastV.n}       (${fmt(100 * m.fastH.coverMedian, 0)}/${fmt(100 * m.fastV.coverMedian, 0)})`)
      }
    }
  }

}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].split(' ').join('%20')}`).href) main()
void fs
