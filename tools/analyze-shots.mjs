#!/usr/bin/env node
// Trigger-jerk analysis of a shooting recording (docs/architecture.md 4.2, docs/game-design.md 6.3 and 11).
// Usage: node tools/analyze-shots.mjs [recording.jsonl] [--json] [--trigger ZR|R] [--steps a,b] [--plan tools/shooting-steps.json]
//          [--aim-curve precise|balanced|fast] [--sensitivity 1.0] [--auto-center] [--bias x,y,z] [--sword]
// Without a file it takes the newest recordings/imu-*.jsonl. Record with: node tools/record-imu.mjs --steps tools/shooting-steps.json
//
// It replays the recording through the REAL game code: every report goes through the report stream (input/report-stream.js: the
// device-time estimate that gives ImuSample.t), the button mapping (input/actions.js: a `fire` ActionEvent whose t is the sample time
// of the first report that shows the trigger down) and the motion pipeline (relative pointer, motion.aimAt) with the gains the game
// plays with (MOTION_CONFIG.shooter, as app.js passes them; --sword replays with the old sword reference gains instead). Each step is replayed as
// its own session (the countdowns between steps are not in the file). For every trigger press it compares the aim at the press time
// minus compMs (the trigger compensation of app.js, C-05) with the "intended" aim 200 ms before the press, for compMs 0..100 step 10,
// and recommends the smallest compMs whose p90 displacement is within 2 px of the best one (numbers in MOTION_CONFIG.shot).
// The intended aim is only meaningful while the hand holds still before the press: the recommendation uses the steps marked
// "analyze": true in the plan (trigger_still) when the recording has them, otherwise every press.
//
// Assumptions (UNVERIFIED-ON-HARDWARE): the Joy-Con is held with its long axis (device +y) towards the screen and +z up, the frame the
// calibration wizard finds for a pistol grip; the gyro bias is the median of the `rest_table` step (or of the calm samples); the
// idle auto-centre is off (--auto-center turns it on), so it cannot pull the aim during a hold.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseInputReport, hexToBytes } from '../public/js/input/joycon2-parse.js'
import { createReportStream } from '../public/js/input/report-stream.js'
import { createButtonActions } from '../public/js/input/actions.js'
import { INPUT_CONFIG } from '../public/js/input/input-config.js'
import { createMotionPipeline, MOTION_CONFIG } from '../public/js/motion/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
export const DEFAULT_PLAN = path.join(HERE, 'shooting-steps.json')
const SHOULDER = ['ZR', 'R', 'ZL', 'L']
const CALM_DPS = 8 // a sample this slow counts as "calm" for the automatic bias estimate without a rest_table step
const REST_SKIP_MS = 3000 // the first seconds of rest_table contain the hand putting the controller down (docs/motion-findings.md 1)

export function quantile(xs, q) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const p = (s.length - 1) * q
  const lo = Math.floor(p)
  const hi = Math.ceil(p)
  return s[lo] + (s[hi] - s[lo]) * (p - lo)
}
const round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)))

/** JSON lines of a recording (meta, report rows {t, ht, step, hex}, step rows). Throws on a missing file or a broken line. */
export function loadRows(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l)
    } catch {
      throw new Error(`${file}: line ${i + 1} is not JSON`)
    }
  })
}

/** The newest recordings/imu-*.jsonl, or null. */
export function newestRecording(dir = path.join(ROOT, 'recordings')) {
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((f) => /^imu-.*\.jsonl$/.test(f)).sort()
  return files.length ? path.join(dir, files.at(-1)) : null
}

/** Steps in file order: [{name, rows: [{row, report}]}] (IMU-active reports only feed the motion pipeline, every report feeds the buttons). */
function groupSteps(rows) {
  const steps = []
  let cur = null
  for (const row of rows) {
    if (typeof row.hex !== 'string' || !row.step) continue
    const report = parseInputReport(hexToBytes(row.hex))
    if (!report) continue
    if (!cur || cur.name !== row.step) {
      cur = { name: row.step, rows: [] }
      steps.push(cur)
    }
    cur.rows.push({ row, report })
  }
  return steps
}

/** Gyro bias in deg/s: the median of rest_table after REST_SKIP_MS, else the median of the calm samples of the whole file, else 0. */
function estimateBias(steps) {
  const med = (xs) => quantile(xs, 0.5)
  const pick = (list) => ({ x: med(list.map((g) => g.x)), y: med(list.map((g) => g.y)), z: med(list.map((g) => g.z)) })
  const rest = steps.find((s) => s.name === 'rest_table')
  if (rest) {
    const imu = rest.rows.filter((r) => r.report.imuActive)
    const t0 = imu.length ? imu[0].row.t : 0
    const late = imu.filter((r) => !Number.isFinite(r.row.t) || r.row.t - t0 >= REST_SKIP_MS).map((r) => r.report.gyroDps)
    if (late.length >= 30) return { bias: pick(late), source: 'rest_table' }
  }
  const calm = []
  for (const s of steps) for (const r of s.rows) {
    const g = r.report.gyroDps
    if (r.report.imuActive && Math.hypot(g.x, g.y, g.z) < CALM_DPS) calm.push(g)
  }
  if (calm.length >= 30) return { bias: pick(calm), source: 'calm samples' }
  return { bias: { x: 0, y: 0, z: 0 }, source: 'none (zero)' }
}

function calibrationFor(side, bias) {
  return {
    version: 1,
    side: side === 'L' ? 'L' : 'R',
    createdAt: 0,
    frame: { right: { x: 1, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 } },
    gyroBiasDps: { ...bias },
    gyroSign: 1,
    gyroScale: 1,
    gyroScaleSource: 'default',
    accelG0: 1,
    quality: { poseAngleDeg: 90, stillPeakDps: 0, warnings: [] },
  }
}

/** Steps of the plan marked "analyze": true, or [] when the plan cannot be read. */
function analyzedStepsOfPlan(planFile) {
  try {
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    return Array.isArray(plan) ? plan.filter((s) => s && s.analyze === true).map((s) => s.name) : []
  } catch {
    return []
  }
}

/**
 * Replay one step: report stream -> button actions (fire) and motion; every fire is evaluated once the jerk window is covered.
 * @returns {{presses: object[], shoulder: Record<string, number>, samples: number}}
 */
function replayStep(step, o) {
  const sh = o.shot
  const motion = createMotionPipeline({ pointerModel: 'relative', config: o.motionConfig, settings: { autoCenter: o.autoCenter, aimCurve: o.aimCurve, sensitivity: o.sensitivity } })
  motion.setCalibration(o.calibration)
  let now = 0
  const fires = []
  const actions = createButtonActions({ clock: { now: () => now }, getSide: () => o.side, emit: (e) => { if (e.action === 'fire') fires.push(e) }, triggerButton: o.trigger })
  const buttonEvents = []
  const shoulder = Object.fromEntries(SHOULDER.map((b) => [b, 0]))
  let samples = 0
  let newestT = -Infinity
  const stream = createReportStream({
    side: o.side,
    config: INPUT_CONFIG,
    hasListener: () => false,
    emit: (type, payload) => {
      if (type === 'buttons') buttonEvents.push(payload)
      else if (type === 'sample') {
        motion.pushImu(payload)
        samples += 1
        newestT = payload.t
      }
    },
  })
  const pending = []
  const presses = []
  const evaluate = (fire) => {
    const ref = motion.aimAt(fire.t - sh.intendedLeadMs)
    const byComp = o.compCandidatesMs.map((c) => {
      const a = motion.aimAt(fire.t - c)
      return a.valid && ref.valid ? Math.hypot(a.x - ref.x, a.y - ref.y) : null
    })
    const diag = motion.shotDiagnostics(fire.t, 0)
    presses.push({
      step: step.name,
      tMs: fire.t,
      jerkPeakDps: diag.jerkPeakDps,
      settlePx: diag.valid ? diag.displacementPx : null,
      displacementPx: byComp,
      valid: byComp.every((v) => v !== null),
    })
  }
  const first = step.rows.find((r) => Number.isFinite(r.row.ht) || Number.isFinite(r.row.t))
  const base = first ? (Number.isFinite(first.row.ht) ? first.row.ht : first.row.t) : 0
  for (const { row } of step.rows) {
    const arrival = (Number.isFinite(row.ht) ? row.ht : Number.isFinite(row.t) ? row.t : base) - base
    now = Math.max(now, arrival)
    buttonEvents.length = 0
    stream.push(hexToBytes(row.hex), now)
    // the providers emit the actions of a report after its sample (C-02): same order here
    for (const ev of buttonEvents) {
      if (!ev.initial) for (const b of ev.down) if (b in shoulder) shoulder[b] += 1
      actions.handle(ev)
    }
    motion.poll(now)
    while (fires.length) pending.push(fires.shift())
    while (pending.length && newestT >= pending[0].t + sh.jerkWindowMs) evaluate(pending.shift())
  }
  while (pending.length) evaluate(pending.shift()) // the end of the step: whatever is covered
  return { presses, shoulder, samples }
}

/**
 * @param {object[]} rows  the JSON lines of a recording
 * @param {object} [opts]  trigger ('ZR'|'R'), steps (names used for the recommendation), plan (file), aimCurve, sensitivity, autoCenter, bias ({x,y,z} deg/s),
 *   sword (true: the old sword gains instead of MOTION_CONFIG.shooter), file (for the report)
 */
export function analyzeShots(rows, opts = {}) {
  const sh = MOTION_CONFIG.shot
  const meta = rows.find((r) => r && r.type === 'meta') ?? {}
  const steps = groupSteps(rows)
  const side = meta.side === 'L' || meta.side === 'R' ? meta.side : '?'
  const trigger = opts.trigger === 'R' ? 'R' : 'ZR'
  const est = opts.bias ? { bias: opts.bias, source: 'given' } : estimateBias(steps)
  const o = {
    shot: sh,
    motionConfig: opts.sword ? undefined : MOTION_CONFIG.shooter,
    side,
    trigger,
    autoCenter: !!opts.autoCenter,
    aimCurve: opts.aimCurve ?? MOTION_CONFIG.aimCurveDefault,
    sensitivity: Number.isFinite(opts.sensitivity) ? opts.sensitivity : MOTION_CONFIG.input.sensitivityDefault,
    compCandidatesMs: opts.compCandidatesMs ?? sh.compCandidatesMs,
    calibration: calibrationFor(side, est.bias),
  }
  const perStep = []
  const presses = []
  const shoulder = Object.fromEntries(SHOULDER.map((b) => [b, 0]))
  let reports = 0
  for (const step of steps) {
    reports += step.rows.length
    const r = replayStep(step, o)
    for (const b of SHOULDER) shoulder[b] += r.shoulder[b]
    presses.push(...r.presses)
    const jerks = r.presses.map((p) => p.jerkPeakDps)
    perStep.push({
      step: step.name, reports: step.rows.length, samples: r.samples, presses: r.presses.length, valid: r.presses.filter((p) => p.valid).length,
      jerkMedianDps: round(quantile(jerks, 0.5), 1), jerkP90Dps: round(quantile(jerks, 0.9), 1),
    })
  }
  const notes = []
  const present = new Set(steps.map((s) => s.name))
  let selected
  let selection
  if (Array.isArray(opts.steps) && opts.steps.length) {
    selected = new Set(opts.steps)
    selection = 'given'
  } else {
    const planned = analyzedStepsOfPlan(opts.plan ?? DEFAULT_PLAN).filter((n) => present.has(n) && presses.some((p) => p.step === n))
    selected = planned.length ? new Set(planned) : null
    selection = planned.length ? 'plan' : 'all'
  }
  const used = presses.filter((p) => p.valid && (!selected || selected.has(p.step)))
  if (!presses.length) {
    const other = SHOULDER.filter((b) => shoulder[b] > 0).map((b) => `${b} x${shoulder[b]}`)
    notes.push(`No ${trigger} presses found (${trigger === 'ZR' ? 'ZR or ZL' : 'R or L'} with the trigger setting ${trigger}). Record the plan of tools/shooting-steps.json.${other.length ? ` Other shoulder presses seen: ${other.join(', ')}.` : ''}`)
  } else if (!used.length) {
    notes.push('Presses were found but none could be evaluated (too close to the start of a step, or tracking was lost around them).')
  }
  if (selection === 'all' && presses.length) notes.push('No step marked "analyze" in the plan has presses: every press is used, including moving shots, where the aim 200 ms before the press is not the intended one.')
  const candidates = o.compCandidatesMs.map((c, i) => {
    const d = used.map((p) => p.displacementPx[i])
    return { compMs: c, n: d.length, medianPx: round(quantile(d, 0.5)), p90Px: round(quantile(d, 0.9)) }
  })
  let recommendedCompMs = null
  if (used.length) {
    const best = Math.min(...candidates.map((c) => c.p90Px))
    recommendedCompMs = candidates.find((c) => c.p90Px <= best + sh.recommendTolerancePx).compMs
  }
  const jerks = used.map((p) => p.jerkPeakDps)
  return {
    file: opts.file ?? null,
    side,
    trigger,
    reports,
    steps: perStep,
    presses: presses.length,
    usedPresses: used.length,
    selection,
    selectedSteps: selected ? [...selected] : null,
    bias: { dps: { x: round(est.bias.x, 3), y: round(est.bias.y, 3), z: round(est.bias.z, 3) }, source: est.source },
    settings: { gains: opts.sword ? 'sword' : 'shooter', aimCurve: o.aimCurve, sensitivity: o.sensitivity, autoCenter: o.autoCenter },
    intendedLeadMs: sh.intendedLeadMs,
    candidates,
    recommendedCompMs,
    jerk: { medianPeakDps: round(quantile(jerks, 0.5), 1), p90PeakDps: round(quantile(jerks, 0.9), 1) },
    settle: { medianPx: round(quantile(used.map((p) => p.settlePx).filter((v) => v !== null), 0.5)) },
    notes,
    pressList: presses.map((p) => ({ ...p, tMs: round(p.tMs, 1), jerkPeakDps: round(p.jerkPeakDps, 1), settlePx: round(p.settlePx), displacementPx: p.displacementPx.map((v) => round(v)) })),
  }
}

/** Plain-text report. */
export function formatReport(r) {
  const out = []
  out.push(`Trigger analysis of ${r.file ?? '(rows)'}`)
  out.push(`  ${r.reports} reports, side ${r.side}, trigger ${r.trigger}, gains ${r.settings.gains}, aim curve ${r.settings.aimCurve}, sensitivity ${r.settings.sensitivity}, auto-centre ${r.settings.autoCenter ? 'on' : 'off'}`)
  out.push(`  gyro bias (${r.bias.source}): ${r.bias.dps.x}, ${r.bias.dps.y}, ${r.bias.dps.z} deg/s`)
  out.push('')
  out.push('  step                 reports  presses  valid  jerk median / p90 (deg/s)')
  for (const s of r.steps) out.push(`  ${s.step.padEnd(20)} ${String(s.reports).padStart(7)}  ${String(s.presses).padStart(7)}  ${String(s.valid).padStart(5)}  ${s.jerkMedianDps ?? '-'} / ${s.jerkP90Dps ?? '-'}`)
  out.push('')
  if (r.usedPresses) {
    out.push(`  ${r.usedPresses} presses used (${r.selection === 'plan' ? `steps ${r.selectedSteps.join(', ')}` : r.selection === 'given' ? `steps ${r.selectedSteps.join(', ')}` : 'all steps'}); displacement from the aim ${r.intendedLeadMs} ms before the press:`)
    out.push('  compMs   median px   p90 px')
    for (const c of r.candidates) out.push(`  ${String(c.compMs).padStart(6)}   ${String(c.medianPx).padStart(9)}   ${String(c.p90Px).padStart(6)}${c.compMs === r.recommendedCompMs ? '   <- recommended' : ''}`)
    out.push('')
    out.push(`  jerk peak median ${r.jerk.medianPeakDps} deg/s, p90 ${r.jerk.p90PeakDps} deg/s; aim moved ${r.settle.medianPx} px (median) from the press to 80 ms after it`)
    out.push(`  RECOMMENDED triggerCompMs: ${r.recommendedCompMs}`)
  } else {
    out.push('  RECOMMENDED triggerCompMs: none (no usable presses)')
  }
  for (const n of r.notes) out.push(`  NOTE: ${n}`)
  return out.join('\n')
}

function parseArgs(argv) {
  const o = { json: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const val = () => argv[++i]
    if (a === '--json') o.json = true
    else if (a === '--trigger') o.trigger = val()
    else if (a === '--steps') o.steps = String(val()).split(',').filter(Boolean)
    else if (a === '--plan') o.plan = val()
    else if (a === '--aim-curve') o.aimCurve = val()
    else if (a === '--sensitivity') o.sensitivity = Number(val())
    else if (a === '--auto-center') o.autoCenter = true
    else if (a === '--sword') o.sword = true
    else if (a === '--bias') {
      const [x, y, z] = String(val()).split(',').map(Number)
      o.bias = { x, y, z }
    } else if (a === '--help' || a === '-h') o.help = true
    else rest.push(a)
  }
  o.file = rest[0] ?? null
  return o
}

function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help) {
    console.log('usage: node tools/analyze-shots.mjs [recording.jsonl] [--json] [--trigger ZR|R] [--steps a,b] [--plan file] [--aim-curve precise|balanced|fast] [--sensitivity n] [--auto-center] [--bias x,y,z] [--sword]')
    return 0
  }
  if (o.aimCurve && !(o.aimCurve in MOTION_CONFIG.aimCurves)) {
    console.error(`unknown --aim-curve ${o.aimCurve} (precise, balanced, fast)`)
    return 2
  }
  if (o.bias && ![o.bias.x, o.bias.y, o.bias.z].every(Number.isFinite)) {
    console.error('--bias needs three numbers: x,y,z (deg/s)')
    return 2
  }
  const file = o.file ?? newestRecording()
  if (!file) {
    console.error('no recording given and none in recordings/')
    return 2
  }
  let rows
  try {
    rows = loadRows(file)
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`)
    return 2
  }
  const result = analyzeShots(rows, { ...o, file })
  console.log(o.json ? JSON.stringify(result, null, 2) : formatReport(result))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main()
