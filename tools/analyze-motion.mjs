#!/usr/bin/env node
// Numbers behind docs/motion-findings.md: a careful, trimmed analysis of a real recording made by tools/record-imu.mjs.
// Usage: node tools/analyze-motion.mjs [recordings/imu-<stamp>.jsonl] [--section rate|bias|tremor|sweeps|swings|accel|axes|scale|all]
// Everything is computed from the recording; nothing here is a model of the device. Device time (us timestamps) is the clock.
import { loadRecording, DEFAULT_RECORDING, speedOf, accMag, quantile, sortedCopy, median, mean, sd } from './lib/imu-recording.mjs'

const secArg = process.argv.indexOf('--section')
const SECTION = secArg >= 0 ? process.argv[secArg + 1] : 'all'
const file = process.argv.slice(2).find((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--section') ?? DEFAULT_RECORDING
const want = (n) => SECTION === 'all' || SECTION === n
const rec = loadRecording(file)
const S = rec.steps
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a')
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a')
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : 'n/a')
const AX = ['x', 'y', 'z']
const h = (t) => console.log('\n=== ' + t + ' ===')
const rel = (name) => { const l = S[name]; const t0 = l[0].t; return (s) => (s.t - t0) / 1000 }
const window_ = (name, a, b = Infinity) => { const r = rel(name); return S[name].filter((s) => r(s) >= a && r(s) < b) }
const qs = (xs, qsList = [0.5, 0.9, 0.99]) => qsList.map((q) => quantile(sortedCopy(xs), q))

// clean rest window of the table step: longest run where every gyro axis stays within 6 raw-dps of the median
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
const restWin = quietRun(S.rest_table)
const BIAS_RAW = Object.fromEntries(AX.map((a) => [a, median(restWin.map((s) => s.gRaw[a]))]))
const BIAS = Object.fromEntries(AX.map((a) => [a, BIAS_RAW[a] * (2000 / 32768)]))
const dec = (s) => ({ x: s.g.x - BIAS.x, y: s.g.y - BIAS.y, z: s.g.z - BIAS.z })
const wmag = (s) => speedOf(dec(s))
// tangent speed for a sword whose forward axis is device +y (measured pose: up = +z, pitch = x, yaw = z, roll = y): roll removed
const wtan = (s) => { const w = dec(s); return Math.hypot(w.x, w.z) }

if (want('rate')) {
  h('A. REPORT RATE AND GAPS (device timestamps, all IMU steps)')
  const all = rec.all
  const dts = all.filter((s) => s.dtMs > 0 && s.dtMs < 500).map((s) => s.dtMs)
  console.log(`samples ${all.length}, span ${f1(all.at(-1).t / 1000)} s (includes the pauses between steps only as device time)`)
  console.log(`dt ms: median ${f2(median(dts))}  p1 ${f2(quantile(sortedCopy(dts), 0.01))}  p99 ${f2(quantile(sortedCopy(dts), 0.99))}  min ${f2(Math.min(...dts))}  max ${f2(Math.max(...dts))}`)
  const bands = [[0, 25], [25, 35], [35, 50], [50, 70], [70, 500]]
  console.log('dt bands (ms): ' + bands.map(([a, b]) => `[${a},${b}) ${dts.filter((d) => d >= a && d < b).length}`).join('  '))
  console.log('dt==0 (duplicates): ' + all.filter((s, i) => i > 0 && s.dtMs === 0).length + '   dt>=200: ' + all.filter((s) => s.dtMs >= 200).length)
  const dist = {}
  for (const d of dts) { const k = d.toFixed(1); dist[k] = (dist[k] || 0) + 1 }
  console.log('most common dt values (ms:count): ' + Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join('  '))
  const hz = (n) => { const l = S[n]; return (l.length - 1) / ((l.at(-1).t - l[0].t) / 1000) }
  console.log('per step Hz: ' + rec.order.map((n) => `${n} ${f1(hz(n))}`).join(', '))
  // arrival-time jitter on the host clock (what the browser sees) versus device time
  const jit = []
  for (let i = 1; i < all.length; i += 1) if (all[i].step === all[i - 1].step && all[i].dtMs > 0 && all[i].dtMs < 200) jit.push((all[i].wall - all[i - 1].wall) - all[i].dtMs)
  console.log(`arrival jitter (host inter-arrival minus device dt, ms): p1 ${f1(quantile(sortedCopy(jit), 0.01))}  p50 ${f1(quantile(sortedCopy(jit), 0.5))}  p99 ${f1(quantile(sortedCopy(jit), 0.99))}  min ${f1(Math.min(...jit))}  max ${f1(Math.max(...jit))}  (sd ${f1(sd(jit))})`)
  const inter = []
  for (let i = 1; i < all.length; i += 1) if (all[i].step === all[i - 1].step) inter.push(all[i].wall - all[i - 1].wall)
  console.log(`host inter-arrival ms: p1 ${f1(quantile(sortedCopy(inter), 0.01))} p50 ${f1(quantile(sortedCopy(inter), 0.5))} p99 ${f1(quantile(sortedCopy(inter), 0.99))} max ${f1(Math.max(...inter))}; share < 10 ms (burst pairs): ${f2(100 * inter.filter((d) => d < 10).length / inter.length)} %`)
  const gapRuns = all.filter((s) => s.dtMs > 45 && s.dtMs < 200)
  console.log(`gaps > 45 ms: ${gapRuns.length} (${f2(100 * gapRuns.length / all.length)} % of samples), sizes ms: ${gapRuns.map((s) => f0(s.dtMs)).join(' ')}`)
}

if (want('bias')) {
  h('B. GYRO BIAS AND NOISE (trimmed)')
  console.log(`rest_table clean window: ${restWin.length} samples, ${f1((restWin.at(-1).t - restWin[0].t) / 1000)} s, starts at ${f1(rel('rest_table')(restWin[0]))} s into the step`)
  console.log('bias raw LSB (median): ' + AX.map((a) => `${a} ${BIAS_RAW[a]}`).join('  ') + '   dps: ' + AX.map((a) => `${a} ${f2(BIAS[a])}`).join('  '))
  console.log('bias raw LSB (mean): ' + AX.map((a) => `${a} ${f2(mean(restWin.map((s) => s.gRaw[a])))}`).join('  '))
  console.log('noise sd raw LSB: ' + AX.map((a) => `${a} ${f2(sd(restWin.map((s) => s.gRaw[a])))}`).join('  ') + '   dps: ' + AX.map((a) => `${a} ${f2(sd(restWin.map((s) => s.g[a])))}`).join('  '))
  console.log(`median |w - bias| at rest: ${f2(median(restWin.map(wmag)))} dps   p99 ${f2(quantile(sortedCopy(restWin.map(wmag)), 0.99))}   max ${f2(Math.max(...restWin.map(wmag)))}`)
  console.log('peak-to-peak raw LSB per axis: ' + AX.map((a) => { const v = restWin.map((s) => s.gRaw[a]); return `${a} ${Math.max(...v) - Math.min(...v)}` }).join('  '))
  // integrated drift over 8 s windows with the bias removed (median bias) and with the mean bias of the same window
  const t0 = restWin[0].t
  const w8 = restWin.filter((s) => s.t - t0 <= 8000)
  const drift = (b) => Object.fromEntries(AX.map((a) => [a, (() => { let d = 0; for (let i = 1; i < w8.length; i += 1) d += (w8[i].g[a] - b[a]) * (w8[i].dtMs / 1000); return d })()]))
  const dr = drift(BIAS)
  console.log(`integrated drift over ${f1((w8.at(-1).t - w8[0].t) / 1000)} s, rest bias removed (deg): ` + AX.map((a) => `${a} ${f2(dr[a])}`).join('  ') + `   without bias removal: ` + AX.map((a) => `${a} ${f2(drift({ x: 0, y: 0, z: 0 })[a])}`).join('  '))
  // 1 s mean stability (Allan-like): sd of consecutive 1 s means, raw LSB
  const binsMeans = AX.map((a) => { const out = []; for (let i = 0; i + 30 <= restWin.length; i += 30) out.push(mean(restWin.slice(i, i + 30).map((s) => s.gRaw[a]))); return sd(out) })
  console.log('sd of 1 s means (raw LSB): ' + AX.map((a, i) => `${a} ${f2(binsMeans[i])}`).join('  '))
  console.log('accel at rest (mean g): ' + AX.map((a) => `${a} ${f2(mean(restWin.map((s) => s.a[a])))}`).join('  ') + `   |a| ${f2(mean(restWin.map((s) => accMag(s.a))))} sd ${f2(sd(restWin.map((s) => accMag(s.a))))}`)
  const why = ['rest_table (whole step)', 'hold_still', 'return_still', 'table_spin_360']
  console.log('naive whole-step mean bias (raw LSB, contaminated by handling): ' + ['rest_table', 'hold_still', 'return_still'].map((n) => `${n}: ` + AX.map((a) => f0(mean(S[n].map((s) => s.gRaw[a])))).join('/')).join('  ') + '  (vs clean ' + AX.map((a) => BIAS_RAW[a]).join('/') + ')')
  void why
}

if (want('tremor')) {
  h('C. TREMOR AND HAND WANDER WHILE TRYING TO HOLD STILL (bias removed with the clean table bias)')
  const show = (label, l) => {
    if (l.length < 10) return
    const w = l.map(wmag)
    const tn = l.map(wtan)
    const [m, p90, p99] = qs(w)
    const [tm, tp90, tp99] = qs(tn)
    console.log(`${label.padEnd(34)} n ${String(l.length).padStart(4)}  |w| median ${f1(m)} p90 ${f1(p90)} p99 ${f1(p99)} max ${f1(Math.max(...w))}   tangent median ${f1(tm)} p90 ${f1(tp90)} p99 ${f1(tp99)}`)
  }
  for (const [n, trims] of [['hold_still', [0, 4, 6, 7]], ['return_still', [0, 2, 4]], ['rest_table', [0, 4]]]) for (const tr of trims) show(`${n} from ${tr} s`, window_(n, tr))
  show('fast_swings_v last 2 s (still)', window_('fast_swings_v', 12.5))
  show('table_spin_360 last 1 s (table)', window_('table_spin_360', 17))
  console.log('\nshare of samples below a dead-zone radius (tangent speed), hand trying to hold still:')
  const dz = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20]
  console.log('dead zone dps:'.padEnd(34) + dz.map((d) => String(d).padStart(6)).join(''))
  for (const [label, l] of [['hold_still from 7 s', window_('hold_still', 7)], ['hold_still from 4 s', window_('hold_still', 4)], ['return_still from 2 s', window_('return_still', 2)], ['fast_swings_v last 2 s', window_('fast_swings_v', 12.5)]]) {
    const tn = l.map(wtan)
    console.log(label.padEnd(34) + dz.map((d) => (100 * tn.filter((x) => x < d).length / tn.length).toFixed(1).padStart(6)).join('') + '  (% below)')
  }
  // wander: rotation accumulated over sliding 1 s windows (magnitude of the integrated rotation vector, small-angle sum)
  const wander = (l, winS) => {
    const out = []
    for (let i = 0; i < l.length; i += 1) {
      let sx = 0; let sy = 0; let sz = 0; let j = i + 1
      while (j < l.length && l[j].t - l[i].t <= winS * 1000) { const w = dec(l[j]); const dt = l[j].dtMs / 1000; sx += w.x * dt; sy += w.y * dt; sz += w.z * dt; j += 1 }
      if (j < l.length) out.push([Math.hypot(sx, sz), Math.abs(sz), Math.abs(sx)])
    }
    return out
  }
  for (const [label, l] of [['hold_still from 7 s', window_('hold_still', 7)], ['return_still from 2 s', window_('return_still', 2)]]) {
    const wd = wander(l, 1)
    console.log(`${label}: angle moved in 1 s windows (yaw/pitch plane): median ${f2(median(wd.map((x) => x[0])))} deg  p90 ${f2(quantile(sortedCopy(wd.map((x) => x[0])), 0.9))}  max ${f2(Math.max(...wd.map((x) => x[0])))}`)
    // net excursion over the window (peak-to-peak of the integrated yaw/pitch, tangent plane)
    let yaw = 0; let pit = 0; let ymin = 0; let ymax = 0; let pmin = 0; let pmax = 0
    for (let i = 1; i < l.length; i += 1) { const w = dec(l[i]); yaw += w.z * l[i].dtMs / 1000; pit += w.x * l[i].dtMs / 1000; ymin = Math.min(ymin, yaw); ymax = Math.max(ymax, yaw); pmin = Math.min(pmin, pit); pmax = Math.max(pmax, pit) }
    console.log(`   integrated excursion over ${f1((l.at(-1).t - l[0].t) / 1000)} s: yaw p-p ${f2(ymax - ymin)} deg, pitch p-p ${f2(pmax - pmin)} deg, end yaw ${f2(yaw)} pitch ${f2(pit)}`)
  }
}

if (want('sweeps')) {
  h('D. AIMING SWEEPS AND OTHER SLOW MOTION: angular speed distributions (bias removed)')
  const TH = [100, 150, 200, 250, 300, 400, 500]
  const row = (label, l, fn = wmag) => {
    const v = l.map(fn)
    const qv = qs(v, [0.5, 0.75, 0.9, 0.95, 0.99])
    console.log(`${label.padEnd(30)} n ${String(v.length).padStart(4)}  q50 ${f1(qv[0])} q75 ${f1(qv[1])} q90 ${f1(qv[2])} q95 ${f1(qv[3])} q99 ${f1(qv[4])} max ${f1(Math.max(...v))}   share of samples above ` + TH.map((t) => `${t}: ${(100 * v.filter((x) => x >= t).length / v.length).toFixed(1)}%`).join('  '))
  }
  console.log('-- |w| (total angular speed)')
  row('yaw_sweep 1..21 s', window_('yaw_sweep', 1, 21))
  row('yaw_sweep all', S.yaw_sweep)
  row('pitch_sweep 1..21 s', window_('pitch_sweep', 1, 21))
  row('pitch_sweep all', S.pitch_sweep)
  row('roll_360 2..14 s', window_('roll_360', 2, 14))
  row('table_spin_360 2..16 s', window_('table_spin_360', 2, 16))
  console.log('-- tangent speed (what moves the tip: roll about the blade axis removed, forward = device y)')
  row('yaw_sweep 1..21 s', window_('yaw_sweep', 1, 21), wtan)
  row('pitch_sweep 1..21 s', window_('pitch_sweep', 1, 21), wtan)
  row('roll_360 2..14 s', window_('roll_360', 2, 14), wtan)
  row('table_spin_360 2..16 s', window_('table_spin_360', 2, 16), wtan)
  // time-weighted shares (dt-weighted) above thresholds with linear interpolation, for sweeps
  console.log('\n-- fraction of TIME above a speed (linear interpolation between samples), |w|')
  const timeAbove = (l, fn, T) => { let tot = 0; let above = 0; for (let i = 1; i < l.length; i += 1) { const a = fn(l[i - 1]); const b = fn(l[i]); const dt = l[i].dtMs; tot += dt; if (a >= T && b >= T) above += dt; else if (a >= T || b >= T) { const hi = Math.max(a, b); const lo = Math.min(a, b); above += dt * (hi - T) / (hi - lo) } } return 100 * above / tot }
  for (const [label, l] of [['yaw_sweep 1..21 s', window_('yaw_sweep', 1, 21)], ['pitch_sweep 1..21 s', window_('pitch_sweep', 1, 21)]]) console.log(label.padEnd(24) + TH.map((t) => `${t}: ${timeAbove(l, wmag, t).toFixed(2)}%`).join('  '))
  // sweep geometry: half-cycle amplitude and duration from the integrated angle (yaw about z, pitch about x), detrended by the mean
  const sweepGeom = (name, axis, label) => {
    const l = window_(name, 1, 21)
    let ang = 0
    const a = [0]
    for (let i = 1; i < l.length; i += 1) { ang += (l[i].g[axis] - BIAS[axis]) * l[i].dtMs / 1000; a.push(ang) }
    const meanA = mean(a)
    const c = a.map((v) => v - meanA)
    // turning points: local extrema separated by > 0.8 s
    const ext = []
    for (let i = 2; i < c.length - 2; i += 1) {
      if ((c[i] > c[i - 1] && c[i] >= c[i + 1] && c[i] > c[i - 2] && c[i] >= c[i + 2]) || (c[i] < c[i - 1] && c[i] <= c[i + 1] && c[i] < c[i - 2] && c[i] <= c[i + 2])) {
        const last = ext.at(-1)
        if (last && Math.sign(c[i]) === Math.sign(last.v)) { if (Math.abs(c[i]) > Math.abs(last.v)) ext[ext.length - 1] = { t: l[i].t, v: c[i] } } else ext.push({ t: l[i].t, v: c[i] })
      }
    }
    const half = []
    for (let i = 1; i < ext.length; i += 1) half.push([Math.abs(ext[i].v - ext[i - 1].v), (ext[i].t - ext[i - 1].t) / 1000])
    console.log(`${label}: integrated angle range p-p ${f1(Math.max(...a) - Math.min(...a))} deg over ${f1((l.at(-1).t - l[0].t) / 1000)} s; half-cycles ${half.length}: amplitude median ${f1(median(half.map((x) => x[0])))} deg (min ${f1(Math.min(...half.map((x) => x[0])))} max ${f1(Math.max(...half.map((x) => x[0])))}), duration median ${f2(median(half.map((x) => x[1])))} s, mean speed median ${f1(median(half.map((x) => x[0] / x[1])))} dps`)
    return half
  }
  sweepGeom('yaw_sweep', 'z', 'yaw_sweep (gyro z)')
  sweepGeom('pitch_sweep', 'x', 'pitch_sweep (gyro x)')
  // independent pitch estimate from gravity (a.y is sin(elevation of the long axis) when still)
  const lp = window_('pitch_sweep', 1, 21)
  const pitchG = lp.map((s) => Math.asin(Math.max(-1, Math.min(1, s.a.y / accMag(s.a)))) * 180 / Math.PI)
  console.log(`pitch_sweep elevation from gravity (asin(a.y/|a|)): min ${f1(Math.min(...pitchG))} max ${f1(Math.max(...pitchG))} p-p ${f1(Math.max(...pitchG) - Math.min(...pitchG))} deg (accel tilt is biased by linear acceleration, rough)`)
  const ly = window_('yaw_sweep', 1, 21)
  const rollG = ly.map((s) => Math.atan2(s.a.x, s.a.z) * 180 / Math.PI)
  const pitchGy = ly.map((s) => Math.asin(Math.max(-1, Math.min(1, s.a.y / accMag(s.a)))) * 180 / Math.PI)
  console.log(`yaw_sweep: gravity roll (atan2(a.x,a.z)) range ${f1(Math.min(...rollG))}..${f1(Math.max(...rollG))} deg, gravity pitch range ${f1(Math.min(...pitchGy))}..${f1(Math.max(...pitchGy))} deg (how level the owner kept the blade)`)
}
void wtan

if (want('swings')) {
  h('E. FAST SWINGS: per-stroke peaks, durations above candidate thresholds, angle swept, accelerometer')
  const TH = [150, 200, 250, 300, 400, 500, 600]
  const { findStrokes } = await import('./lib/imu-recording.mjs')
  for (const name of ['fast_swings_h', 'fast_swings_v']) {
    const l = S[name]
    const strokes = findStrokes(l, wmag, { minPeak: 150, thresholds: TH })
    const r = rel(name)
    console.log(`\n${name}: ${strokes.length} local speed maxima >= 150 dps (|w|)`)
    console.log('  #  t(s)  peak(dps)  angle(deg)  rise(ms)  dur>100(ms)  peak|a|(g)  samples above ' + TH.join('/') + '   ms above ' + TH.join('/'))
    strokes.forEach((s, k) => console.log(`  ${String(k + 1).padStart(2)} ${f1(r(l[s.i])).padStart(5)} ${f0(s.peak).padStart(8)} ${f0(s.angle).padStart(10)} ${f0(s.rise).padStart(9)} ${f0(s.durMs).padStart(11)} ${f2(s.aPeak).padStart(10)}   ${TH.map((T) => s.above[T].n).join('/').padEnd(18)} ${TH.map((T) => f0(s.above[T].ms)).join('/')}`))
    const strong = strokes.filter((s) => s.aPeak >= 2.0)
    const weak = strokes.filter((s) => s.aPeak < 2.0)
    console.log(`  strokes with peak |a| >= 2.0 g ("hard" strokes, independent of the gyro threshold): ${strong.length}; the others (returns, repositioning): ${weak.length}, their peaks dps: ${weak.map((s) => f0(s.peak)).join(' ')}`)
    const pk = strong.map((s) => s.peak)
    console.log(`  hard strokes: peak dps min ${f0(Math.min(...pk))} q25 ${f0(quantile(sortedCopy(pk), 0.25))} median ${f0(median(pk))} q75 ${f0(quantile(sortedCopy(pk), 0.75))} max ${f0(Math.max(...pk))};  angle swept median ${f0(median(strong.map((s) => s.angle)))} deg (min ${f0(Math.min(...strong.map((s) => s.angle)))}, max ${f0(Math.max(...strong.map((s) => s.angle)))});  rise to peak median ${f0(median(strong.map((s) => s.rise)))} ms`)
    console.log('  hard strokes, per threshold T: share reaching T / median samples above / median ms above / min samples above:')
    for (const T of TH) {
      const reach = strong.filter((s) => s.above[T].n > 0)
      console.log(`     T ${String(T).padStart(3)}: reach ${String(reach.length).padStart(2)}/${strong.length} (${f0(100 * reach.length / strong.length)}%)  samples above median ${reach.length ? median(reach.map((s) => s.above[T].n)) : 'n/a'} min ${reach.length ? Math.min(...reach.map((s) => s.above[T].n)) : 'n/a'}   ms above median ${reach.length ? f0(median(reach.map((s) => s.above[T].ms))) : 'n/a'} min ${reach.length ? f0(Math.min(...reach.map((s) => s.above[T].ms))) : 'n/a'}`)
    }
    const allPk = strokes.map((s) => s.peak)
    console.log(`  ALL maxima >= 150: peak median ${f0(median(allPk))} min ${f0(Math.min(...allPk))} max ${f0(Math.max(...allPk))}; p90 of ALL samples |w| ${f0(quantile(sortedCopy(l.map(wmag)), 0.9))}`)
  }
  // fast_swings step totals
  for (const name of ['fast_swings_h', 'fast_swings_v']) {
    const v = S[name].map(wmag)
    console.log(`${name}: all samples |w| median ${f0(median(v))} p90 ${f0(quantile(sortedCopy(v), 0.9))} p99 ${f0(quantile(sortedCopy(v), 0.99))} max ${f0(Math.max(...v))}`)
  }
  // tangent versus total speed in strokes (roll about the blade axis does not move the tip)
  for (const name of ['fast_swings_h', 'fast_swings_v']) {
    const st = findStrokes(S[name], wmag).filter((s) => s.aPeak >= 2.0)
    console.log(`${name}: hard strokes, tangent peak / |w| peak ratio: ` + st.map((s) => (wtan(S[name][s.i]) / s.peak).toFixed(2)).join(' '))
  }
}

if (want('accel')) {
  h('F. ACCELEROMETER BEHAVIOUR')
  const dev = (s) => Math.abs(accMag(s.a) - 1)
  const row = (label, l) => { const v = l.map((s) => accMag(s.a)); const d = l.map(dev); console.log(`${label.padEnd(28)} |a| q50 ${f2(median(v))} q99 ${f2(quantile(sortedCopy(v), 0.99))} max ${f2(Math.max(...v))}   | |a|-1 | q90 ${f2(quantile(sortedCopy(d), 0.9))} q99 ${f2(quantile(sortedCopy(d), 0.99))} max ${f2(Math.max(...d))}   share > 0.5 g ${f1(100 * d.filter((x) => x > 0.5).length / d.length)}%  > 1 g ${f1(100 * d.filter((x) => x > 1).length / d.length)}%  > 2 g ${f1(100 * d.filter((x) => x > 2).length / d.length)}%`) }
  row('yaw_sweep 1..21 s', window_('yaw_sweep', 1, 21))
  row('pitch_sweep 1..21 s', window_('pitch_sweep', 1, 21))
  row('roll_360 2..14 s', window_('roll_360', 2, 14))
  row('table_spin_360 2..16 s', window_('table_spin_360', 2, 16))
  row('fast_swings_h', S.fast_swings_h)
  row('fast_swings_v', S.fast_swings_v)
  row('hold_still from 7 s', window_('hold_still', 7))
  console.log('\nsaturation: samples with any |raw accel| >= 32700: ' + rec.all.filter((s) => Math.max(Math.abs(s.a.x), Math.abs(s.a.y), Math.abs(s.a.z)) * 4096 >= 32700).length + ' (full scale is 8 g); any |raw gyro| >= 32700: ' + rec.all.filter((s) => Math.max(Math.abs(s.gRaw.x), Math.abs(s.gRaw.y), Math.abs(s.gRaw.z)) >= 32700).length + '; max |raw gyro| overall ' + Math.max(...rec.all.map((s) => Math.max(Math.abs(s.gRaw.x), Math.abs(s.gRaw.y), Math.abs(s.gRaw.z)))) + ' (= ' + f0(Math.max(...rec.all.map((s) => Math.max(Math.abs(s.gRaw.x), Math.abs(s.gRaw.y), Math.abs(s.gRaw.z)))) * 2000 / 32768) + ' dps)')
  // lever arm: centripetal acceleration a = w^2 r at the peak sample of the hard strokes
  const { findStrokes } = await import('./lib/imu-recording.mjs')
  for (const name of ['fast_swings_h', 'fast_swings_v']) {
    const st = findStrokes(S[name], wmag).filter((s) => s.aPeak >= 2.0)
    const r = st.map((s) => { let best = 0; for (let i = s.a; i <= s.b; i += 1) best = Math.max(best, accMag(S[name][i].a)); const w = s.peak * Math.PI / 180; return (best - 1) * 9.81 / (w * w) })
    console.log(`${name}: implied lever arm (peak |a| - 1 g) / w_peak^2 over hard strokes: median ${f2(median(r))} m  (min ${f2(Math.min(...r))}, max ${f2(Math.max(...r))})`)
    // timing: is the accel peak at the gyro peak or later (the stop)?
    const lag = st.map((s) => { let bi = s.a; for (let i = s.a; i <= s.b; i += 1) if (accMag(S[name][i].a) > accMag(S[name][bi].a)) bi = i; return S[name][bi].t - S[name][s.i].t })
    console.log(`   time of the |a| peak relative to the |w| peak (ms): median ${f0(median(lag))} min ${f0(Math.min(...lag))} max ${f0(Math.max(...lag))}`)
  }
  // separation: stroke peak |a|-1 versus the largest |a|-1 in any non-stroke sample of the slow steps
  console.log('\nseparation of hard strokes from slow motion by |a|-1: slow steps max ' + f2(Math.max(...['yaw_sweep', 'pitch_sweep', 'roll_360', 'table_spin_360'].flatMap((n) => S[n].map(dev)))) + ' g;  hard strokes min peak |a|-1 ' + f2(Math.min(...['fast_swings_h', 'fast_swings_v'].flatMap((n) => findStrokes(S[n], wmag).filter((s) => s.aPeak >= 2.0).map((s) => s.aPeak - 1)))) + ' g')
}

if (want('axes')) {
  h('G. AXIS MAPPING')
  for (const n of ['yaw_sweep', 'pitch_sweep', 'roll_360', 'table_spin_360', 'fast_swings_h', 'fast_swings_v']) {
    const l = n === 'roll_360' ? window_(n, 2, 14) : n === 'table_spin_360' ? window_(n, 2, 16) : n.startsWith('fast') ? S[n] : window_(n, 1, 21)
    const e = { x: 0, y: 0, z: 0 }
    for (const s of l) { const w = dec(s); e.x += w.x * w.x; e.y += w.y * w.y; e.z += w.z * w.z }
    const tot = e.x + e.y + e.z
    console.log(`${n.padEnd(16)} share of rotational energy: x ${f0(100 * e.x / tot)}%  y ${f0(100 * e.y / tot)}%  z ${f0(100 * e.z / tot)}%`)
  }
  // gyro sign and scale against gravity: pitch (a.y = sin of the elevation of the long axis when quasi-static) and roll (atan2(a.x, a.z), unwrapped)
  const regress = (xs, ys) => { const mx = mean(xs); const my = mean(ys); let sxy = 0; let sxx = 0; let syy = 0; for (let i = 0; i < xs.length; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2 } return { slope: sxy / sxx, r: sxy / Math.sqrt(sxx * syy) } }
  {
    // roll: unwrapped gravity roll angle versus integral of gyro y
    const l = window_('roll_360', 0, 18)
    let ang = 0
    const gy = [0]
    for (let i = 1; i < l.length; i += 1) { ang += (l[i].g.y - BIAS.y) * l[i].dtMs / 1000; gy.push(ang) }
    let prev = Math.atan2(l[0].a.x, l[0].a.z) * 180 / Math.PI
    let un = prev
    const ga = [un]
    for (let i = 1; i < l.length; i += 1) { let cur = Math.atan2(l[i].a.x, l[i].a.z) * 180 / Math.PI; while (cur - prev > 180) cur -= 360; while (cur - prev < -180) cur += 360; un += cur - prev; prev = cur; ga.push(un) }
    const rr = regress(ga, gy)
    // physics: a body rotation +theta (right-hand) about device +y turns the measured gravity direction to (-sin theta, 0, cos theta), so
    // atan2(a.x, a.z) = -theta. A slope of -1.00 therefore means: right-hand sign and nominal scale.
    console.log(`roll_360: unwrapped gravity roll total ${f0(ga.at(-1) - ga[0])} deg (= -theta); integral of gyro y total ${f0(gy.at(-1))} deg; regression of the gyro integral on the gravity angle: slope ${f2(rr.slope)}, r ${f2(rr.r)}`)
    console.log(`   => slope -1.00 means right-hand sign and the nominal scale (ratio gyro/gravity ${f2(Math.abs(gy.at(-1) / (ga.at(-1) - ga[0])))}); gravity roll is perturbed by centripetal acceleration (|a| 0.8..1.4 g) but r is ${f2(Math.abs(rr.r))}`)
  }
  {
    const l = window_('pitch_sweep', 2, 21)
    const g = l.map((s) => Math.asin(Math.max(-1, Math.min(1, s.a.y / accMag(s.a)))) * 180 / Math.PI)
    let ang = 0
    const gx = [0]
    for (let i = 1; i < l.length; i += 1) { ang += (l[i].g.x - BIAS.x) * l[i].dtMs / 1000; gx.push(ang) }
    // remove the slow offset with a first-order fit: compare increments over 10-sample spans
    const dg = []; const dx = []
    for (let i = 10; i < l.length; i += 1) { dg.push(g[i] - g[i - 10]); dx.push(gx[i] - gx[i - 10]) }
    const rr = regress(dg, dx)
    const rb = regress(dx, dg)
    console.log(`pitch_sweep: increments over 0.3 s, gyro-x integral versus gravity elevation: slope ${f2(rr.slope)} (regressing gyro on gravity), ${f2(1 / rb.slope)} (regressing gravity on gyro); the truth lies between; r ${f2(rr.r)}  (positive: +gyro x raises the +y axis, i.e. right-hand rotation about +x)`)
  }
}

if (want('scale')) {
  h('H. GYRO SCALE CHECK (nominal 0.06103515625 dps/LSB)')
  // table spin: flat, yaw about z. Integrate signed z over the moving core of the step, bias removed.
  const check = (name, axis, turnsExpected) => {
    const l = S[name]
    const r = rel(name)
    // moving core: from the first sample with |w| > 15 dps that is followed by motion to the last such before the trailing still
    const v = l.map((s) => Math.abs(s.g[axis] - BIAS[axis]))
    let a = 0
    while (a < l.length - 1 && !(v[a] > 15 && v[a + 1] > 15 && v[a + 2] > 15)) a += 1
    let b = l.length - 1
    while (b > 0 && !(v[b] > 15 && v[b - 1] > 15 && v[b - 2] > 15)) b -= 1
    let signed = 0; let path = 0
    for (let i = a + 1; i <= b; i += 1) { const w = l[i].g[axis] - BIAS[axis]; signed += w * l[i].dtMs / 1000; path += Math.abs(w) * l[i].dtMs / 1000 }
    console.log(`${name}: moving core ${f1(r(l[a]))}..${f1(r(l[b]))} s (${f1(r(l[b]) - r(l[a]))} s); signed integral of gyro ${axis} = ${f1(signed)} deg = ${f2(signed / 360)} turns; unsigned path ${f1(path)} deg = ${f2(path / 360)} turns; expected ${turnsExpected} turns (hand counted)`)
    console.log(`   the integral sits ${f1(Math.abs(Math.abs(signed) / 360 - Math.round(Math.abs(signed) / 360)) * 360)} deg from a whole number of turns (hand timing/counting cannot produce this by chance unless the scale is right to within a few %)`)
    return signed
  }
  check('table_spin_360', 'z', 4)
  check('roll_360', 'y', 4)
  console.log('alternative candidate scale 0.0075 dps/LSB would read ' + (1435 * 0.12288 / 360).toFixed(2) + ' turns for the table spin (the owner did 4): rejected by a factor of 8.')
  // drift in pure-gyro yaw after the table spin: the aim (forward axis, horizontal) must have come back to its start
}
