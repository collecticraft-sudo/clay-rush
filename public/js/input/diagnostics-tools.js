// Pure helpers of the diagnostics page (docs/architecture.md 5.10). OWNER: input engineer.
//
// No DOM, no timers, no globals: every function takes its data and returns numbers or plain objects, so the maths of the
// three owner tools (gyro scale check, gravity-vs-gyro sign test, rest check) is unit-tested in Node. What the tools
// MEASURE on a real Joy-Con is UNVERIFIED-ON-HARDWARE until the owner runs them (docs/joycon2-protocol.md section 12).

import { INPUT_CONFIG } from './input-config.js';

const DEG = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vec = (v) => [v.x, v.y, v.z];
const unit = (a) => {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};
const angleBetweenDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b) || 1)))) / DEG;

// --------------------------------------------------------------------------------------------------------------------
// Statistics

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/** min / median / p95 / max / mean of a list of inter-arrival times in ms (null when empty). */
export function intervalStats(intervals) {
  if (!intervals.length) return { count: 0, min: null, median: null, p95: null, max: null, mean: null };
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    count: sorted.length,
    min: sorted[0],
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

/** Histogram of intervals: bins of `binMs` up to `maxMs`, the rest in `overflow`. */
export function histogram(intervals, { binMs = 2.5, maxMs = 60 } = {}) {
  const n = Math.ceil(maxMs / binMs);
  const bins = Array.from({ length: n }, (_, i) => ({ from: i * binMs, to: (i + 1) * binMs, count: 0 }));
  let overflow = 0;
  for (const v of intervals) {
    if (v >= maxMs) overflow++;
    else bins[Math.max(0, Math.floor(v / binMs))].count++;
  }
  return { bins, overflow };
}

/**
 * Packet arrival meter: packets per second over any window up to `keepMs`, and the recent inter-arrival times
 * (protocol Appendix B, "packet rate over 1 s and 10 s"; answers UOH-4).
 */
export function createRateMeter({ keepMs = 10_000, keepIntervals = 600 } = {}) {
  const times = [];
  const intervals = [];
  let head = 0;
  let first = null;
  return {
    push(t) {
      if (first === null) first = t;
      if (times.length > head) {
        intervals.push(t - times[times.length - 1]);
        if (intervals.length > keepIntervals) intervals.shift();
      }
      times.push(t);
      while (head < times.length && times[head] < t - keepMs) head++;
      if (head > 2048) {
        times.splice(0, head);
        head = 0;
      }
    },
    /** Packets per second over the last `windowMs`; null before two packets, count based once the window is covered. */
    rate(now, windowMs) {
      if (first === null || times.length - head < 2) return null;
      let n = 0;
      let oldest = now;
      for (let i = times.length - 1; i >= head; i--) {
        if (times[i] <= now - windowMs) break;
        n++;
        oldest = times[i];
      }
      if (now - first >= windowMs) return (n * 1000) / windowMs;
      const span = times[times.length - 1] - oldest;
      return n >= 2 && span > 0 ? ((n - 1) * 1000) / span : null;
    },
    intervals: () => intervals.slice(),
    count: () => times.length - head,
    reset() {
      times.length = 0;
      intervals.length = 0;
      head = 0;
      first = null;
    },
  };
}

// --------------------------------------------------------------------------------------------------------------------
// Still detection shared by the sign test and the rest check

/** Resting |a| that the GAME accepts (MOTION_CONFIG.calibration.accelG0Range: 0.85 to 1.15 g; it learns and divides by it). */
export const GAME_ACCEL_RANGE = Object.freeze([0.85, 1.15]);

/**
 * Rolling window over the samples of the last `holdMs` of DEVICE time. `isStill()` is true when the window spans at
 * least `holdMs`, the gyro stays quiet around its own mean (peak below `peakDps`, mean deviation below `meanDps`), that mean
 * itself is a plausible bias (below `maxBiasDps`: a steady turn is NOT stillness) and |a| stays within `accelBandG` of its own mean, which lies in the
 * range the game accepts (0.85 to 1.15 g).
 */
export function createStillWindow({ holdMs, peakDps = 15, meanDps = 6, maxBiasDps = 6, accelBandG = 0.08 } = {}) {
  let items = [];
  return {
    push(sample) {
      items.push({ t: sample.t, a: vec(sample.accel), g: vec(sample.gyro) });
      const from = sample.t - holdMs;
      let drop = 0;
      while (drop < items.length - 1 && items[drop + 1].t <= from) drop++;
      if (drop > 0) items = items.slice(drop);
    },
    spanMs: () => (items.length ? items[items.length - 1].t - items[0].t : 0),
    /** Stillness relative to the window's own mean gyro (the unknown bias must not count as motion). */
    isStill() {
      if (items.length < 4 || items[items.length - 1].t - items[0].t < holdMs * 0.98) return false;
      const meanG = [0, 0, 0];
      for (const it of items) for (let k = 0; k < 3; k++) meanG[k] += it.g[k] / items.length;
      if (len(meanG) > maxBiasDps) return false;
      // |a| is judged against the window's OWN mean, and that mean against the game's tolerance for a real sensor (0.85 to 1.15 g,
      // round 2 M2): with the old absolute 1 +- 0.08 band a sensor that rests at 1.09 g made the sign test wait for ever in silence
      // (round 3 finding R3-n1). The game divides by the learned resting magnitude, so the page must not reject what the game accepts.
      let meanMag = 0;
      for (const it of items) meanMag += len(it.a) / items.length;
      if (meanMag < GAME_ACCEL_RANGE[0] || meanMag > GAME_ACCEL_RANGE[1]) return false;
      let peak = 0;
      let sum = 0;
      for (const it of items) {
        const d = len(sub(it.g, meanG));
        peak = Math.max(peak, d);
        sum += d;
        if (Math.abs(len(it.a) - meanMag) > accelBandG) return false;
      }
      return peak <= peakDps && sum / items.length <= meanDps;
    },
    mean() {
      const a = [0, 0, 0];
      const g = [0, 0, 0];
      for (const it of items) {
        for (let k = 0; k < 3; k++) {
          a[k] += it.a[k] / items.length;
          g[k] += it.g[k] / items.length;
        }
      }
      return { accel: a, gyro: g, samples: items.length };
    },
    reset() {
      items = [];
    },
  };
}

// --------------------------------------------------------------------------------------------------------------------
// Tool 1: one-revolution gyro scale check (protocol 7.2, UOH-6)

/**
 * The player holds still for `holdStillMs` (bias), then turns the sword one full revolution flat on a desk, then stops the
 * tool. The tool integrates |omega - bias| dt. About 360 degrees confirms the default scale, about 2930 degrees means the
 * true scale is 0.0075 deg/s per LSB (8.138 times smaller); any other value is reported as measured.
 * Phases: idle -> holding -> rotating -> done.
 */
export function createScaleTool(cfg = INPUT_CONFIG.diagnostics.scale) {
  let phase = 'idle';
  let holdMs = 0;
  let biasSum = [0, 0, 0];
  let biasN = 0;
  let bias = [0, 0, 0];
  let angle = 0;
  let rotatingMs = 0;
  let result = null;

  function summarise() {
    const deg = angle;
    const ratioTo360 = deg / 360;
    const tol = cfg.defaultTolerance;
    let verdict;
    let gyroScale;
    if (deg < 90) {
      verdict = 'too_short';
      gyroScale = null;
    } else if (Math.abs(ratioTo360 - 1) <= tol) {
      verdict = 'default';
      gyroScale = 1;
    } else if (Math.abs(deg / cfg.altTurnDeg - 1) <= tol) {
      verdict = 'alt';
      gyroScale = cfg.candidateRatio;
    } else {
      verdict = 'other';
      const measured = 360 / deg;
      gyroScale = measured >= 0.05 && measured <= 2 ? measured : null;
      if (gyroScale === null) verdict = 'implausible';
    }
    return { integratedDeg: deg, biasDps: { x: bias[0], y: bias[1], z: bias[2] }, rotatingMs, verdict, gyroScale, measuredScale: deg > 0 ? 360 / deg : null };
  }

  return {
    start() {
      phase = 'holding';
      holdMs = 0;
      biasSum = [0, 0, 0];
      biasN = 0;
      bias = [0, 0, 0];
      angle = 0;
      rotatingMs = 0;
      result = null;
    },
    /** @param {{gyro:{x,y,z}, dtMs:number|null}} sample */
    push(sample) {
      if (sample.dtMs === null) return;
      const g = vec(sample.gyro);
      if (phase === 'holding') {
        holdMs += sample.dtMs;
        biasSum = [biasSum[0] + g[0], biasSum[1] + g[1], biasSum[2] + g[2]];
        biasN++;
        if (holdMs >= cfg.holdStillMs) {
          bias = scale(biasSum, 1 / Math.max(1, biasN));
          phase = 'rotating';
        }
      } else if (phase === 'rotating') {
        const w = len(sub(g, bias));
        rotatingMs += sample.dtMs;
        if (w >= cfg.deadbandDps) angle += (w * sample.dtMs) / 1000;
      }
    },
    stop() {
      if (phase === 'idle' || phase === 'done') return result;
      phase = 'done';
      result = summarise();
      return result;
    },
    state: () => ({ phase, holdProgress: Math.min(1, holdMs / cfg.holdStillMs), integratedDeg: angle, result }),
    reset() {
      phase = 'idle';
      result = null;
      angle = 0;
    },
  };
}

// --------------------------------------------------------------------------------------------------------------------
// Tool 2: gravity vs gyro sign test (protocol 7.4 point 2, UOH-7)

/**
 * Two still holds (gravity direction a0 and a1), and a slow turn between them. Gravity implies that the body turned about
 * -(a0 x a1); that direction must agree with the integral of the gyro over the same span. Antiparallel means the gyro sign
 * convention is mirrored relative to the accelerometer (negate the gyro vector). Needs no knowledge of the mount and works
 * for the Left and the Right unit. Only the part of the turn perpendicular to gravity is observable by the accelerometer,
 * so the gyro integral is projected onto that plane before the comparison.
 * Phases: holdA -> turning -> done.
 */
export function createSignTest(cfgAll = INPUT_CONFIG.diagnostics) {
  const holdMs = cfgAll.signHoldMs;
  let phase = 'holdA';
  let window = createStillWindow({ holdMs });
  let a0 = null;
  let bias = [0, 0, 0];
  let theta = [0, 0, 0];
  let movedDeg = 0;
  let result = null;

  return {
    push(sample) {
      if (phase === 'done' || (sample.dtMs === null && phase !== 'holdA')) return;
      if (phase === 'holdA') {
        window.push(sample);
        if (window.isStill()) {
          const m = window.mean();
          a0 = m.accel;
          bias = m.gyro;
          theta = [0, 0, 0];
          movedDeg = 0;
          phase = 'turning';
          window = createStillWindow({ holdMs: holdMs * 0.75 });
        }
        return;
      }
      // turning: integrate the gyro, wait until the sword is still again after a real turn
      const g = sub(vec(sample.gyro), bias);
      theta = [theta[0] + (g[0] * sample.dtMs) / 1000, theta[1] + (g[1] * sample.dtMs) / 1000, theta[2] + (g[2] * sample.dtMs) / 1000];
      movedDeg = Math.max(movedDeg, angleBetweenDeg(a0, vec(sample.accel)));
      window.push(sample);
      if (movedDeg >= cfgAll.signMinAngleDeg * 0.5 && window.isStill()) {
        const a1 = window.mean().accel;
        const angle = angleBetweenDeg(a0, a1);
        const axisExpected = unit(scale(cross(a0, a1), -1)); // body turn implied by gravity
        const gravity = unit([a0[0] + a1[0], a0[1] + a1[1], a0[2] + a1[2]]);
        const thetaG = sub(theta, scale(gravity, dot(theta, gravity))); // observable part of the gyro integral
        const cos = len(thetaG) > 1e-9 && len(axisExpected) > 1e-9 ? dot(unit(thetaG), axisExpected) : 0;
        let verdict;
        if (angle < cfgAll.signMinAngleDeg) verdict = 'too_small';
        else if (cos > 0.5) verdict = 'ok';
        else if (cos < -0.5) verdict = 'mirrored';
        else verdict = 'undetermined';
        result = {
          angleDeg: angle,
          cos,
          verdict,
          gyroIntegralDeg: { x: theta[0], y: theta[1], z: theta[2] },
          gyroProjectedDeg: len(thetaG),
          axisExpected: { x: axisExpected[0], y: axisExpected[1], z: axisExpected[2] },
          biasDps: { x: bias[0], y: bias[1], z: bias[2] },
        };
        phase = 'done';
      }
    },
    state: () => ({ phase, holdProgress: Math.min(1, window.spanMs() / (phase === 'holdA' ? holdMs : holdMs * 0.75)), movedDeg, result }),
    reset() {
      phase = 'holdA';
      window = createStillWindow({ holdMs });
      a0 = null;
      result = null;
      theta = [0, 0, 0];
      movedDeg = 0;
    },
  };
}

// --------------------------------------------------------------------------------------------------------------------
// Tool 3: rest check (protocol section 12 step 3)

/**
 * Hold the Joy-Con FLAT with its BUTTONS UP and still for `durationMs`: |a| should be 1.00 +- 0.03 g, the gyro about 0 +- 3 dps
 * with a small spread, and the accelerometer should read about +1 g on raw Z.
 *
 * The Z reading settles the accelerometer sign (round 1 finding F3 / protocol audit): the whole Motion pipeline assumes that the
 * accelerometer reports +1 g TOWARDS UP at rest (the specific force). The third-party sources show about +1 g on raw Z but do not
 * say in which pose, and JoeGeC's notes call +Z "out of the button face". With buttons up, +Z therefore has to read +1 g. A reading
 * of -1 g means the sensor reports the gravity vector instead: the game then needs accelSign = -1 (saved by the page, or
 * ?accelsign=-1). Neither the software nor the gyro sign test can see this by themselves. The pose and the axis are
 * UNVERIFIED-ON-HARDWARE (UOH-20): the verdict only means something if the Joy-Con really lay buttons up.
 *
 * `zSign`: 'plus' (Z reads +1 g), 'minus' (Z reads -1 g), 'not_flat' (Z carries less than 95 % of the reading: not lying flat).
 * @returns {{push:(sample)=>void, state:()=>object, reset:()=>void}}
 */
export function createRestCheck(durationMs = INPUT_CONFIG.diagnostics.restCheckMs) {
  let n = 0;
  let spanMs = 0;
  let sumA = 0;
  let sumAV = [0, 0, 0];
  let sumG = [0, 0, 0];
  let sumG2 = [0, 0, 0];
  let peak = 0;
  let imuActiveAll = true;
  let result = null;
  let firstT = null;

  return {
    push(sample) {
      if (result) return;
      if (firstT === null) firstT = sample.t;
      const g = vec(sample.gyro);
      n++;
      sumA += len(vec(sample.accel));
      sumAV[0] += sample.accel.x;
      sumAV[1] += sample.accel.y;
      sumAV[2] += sample.accel.z;
      for (let k = 0; k < 3; k++) {
        sumG[k] += g[k];
        sumG2[k] += g[k] * g[k];
      }
      peak = Math.max(peak, len(g));
      imuActiveAll = imuActiveAll && sample.imuActive !== false;
      spanMs = sample.t - firstT;
      if (spanMs >= durationMs && n >= 4) {
        const mean = sumG.map((s) => s / n);
        const std = sumG2.map((s, k) => Math.sqrt(Math.max(0, s / n - mean[k] * mean[k])));
        const accelMag = sumA / n;
        const gyroMean = { x: mean[0], y: mean[1], z: mean[2] };
        const passAccel = Math.abs(accelMag - 1) <= 0.03;
        const accelGameOk = accelMag >= GAME_ACCEL_RANGE[0] && accelMag <= GAME_ACCEL_RANGE[1];
        const passGyro = Math.max(Math.abs(mean[0]), Math.abs(mean[1]), Math.abs(mean[2])) <= 3;
        const accelMean = { x: sumAV[0] / n, y: sumAV[1] / n, z: sumAV[2] / n };
        const meanLen = len(vec(accelMean));
        const zShare = meanLen > 0 ? accelMean.z / meanLen : 0;
        const zSign = Math.abs(zShare) < 0.95 ? 'not_flat' : zShare > 0 ? 'plus' : 'minus';
        result = {
          samples: n,
          accelMagG: accelMag,
          accelMeanG: accelMean,
          zSign,
          gyroMeanDps: gyroMean,
          gyroStdDps: { x: std[0], y: std[1], z: std[2] },
          gyroPeakDps: peak,
          imuActive: imuActiveAll,
          passAccel,
          accelGameOk,
          passGyro,
          moved: peak > 15,
          pass: passAccel && passGyro && imuActiveAll && peak <= 15,
        };
        // 'ok' = the statement about the sensor holds (1.00 +- 0.03 g); 'game_ok' = |a| is off 1 g but inside what the game accepts (it
        // learns the resting magnitude and divides by it), everything else fine: an amber note, not a red cross on a working Joy-Con
        result.verdict = result.pass ? 'ok' : !passAccel && accelGameOk && passGyro && imuActiveAll && peak <= 15 ? 'game_ok' : 'ko';
      }
    },
    state: () => ({ progress: Math.min(1, spanMs / durationMs), samples: n, result }),
    reset() {
      n = 0;
      spanMs = 0;
      sumA = 0;
      sumAV = [0, 0, 0];
      sumG = [0, 0, 0];
      sumG2 = [0, 0, 0];
      peak = 0;
      imuActiveAll = true;
      result = null;
      firstT = null;
    },
  };
}

// --------------------------------------------------------------------------------------------------------------------
// Latency probe (UOH-18, software part only)

/** Age of the newest sample at each animation frame: min / average / max / p95 over the last `windowSize` frames. */
export function createLatencyProbe(windowSize = INPUT_CONFIG.diagnostics.latencyWindow) {
  const ring = [];
  return {
    record(nowMs, sampleT) {
      if (!Number.isFinite(sampleT)) return;
      ring.push(Math.max(0, nowMs - sampleT));
      if (ring.length > windowSize) ring.shift();
    },
    stats() {
      if (!ring.length) return { count: 0, min: null, avg: null, max: null, p95: null };
      const sorted = [...ring].sort((a, b) => a - b);
      return { count: ring.length, min: sorted[0], avg: ring.reduce((a, b) => a + b, 0) / ring.length, max: sorted[sorted.length - 1], p95: percentile(sorted, 0.95) };
    },
    reset() {
      ring.length = 0;
    },
  };
}

// --------------------------------------------------------------------------------------------------------------------
// Formatting and the owner report

/** "3595 mV" band colour name: ok / low / critical / unknown (approximate, protocol 7.6). */
export function batteryBand(mv, cfg = INPUT_CONFIG) {
  if (!Number.isFinite(mv) || mv <= 0) return 'unknown';
  return mv >= cfg.batteryLowMv ? 'ok' : mv >= cfg.batteryCriticalMv ? 'low' : 'critical';
}

/** Hex dump grouped by 8 bytes. */
export function formatHex(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i].toString(16).padStart(2, '0'));
    if (i % 8 === 7 && i < bytes.length - 1) out.push(' ');
  }
  return out.join('');
}

/** The seven steps of docs/joycon2-protocol.md section 12 plus two extras, with the UOH items each one settles. */
export const CHECKLIST = Object.freeze([
  { id: 1, uoh: ['UOH-1', 'UOH-2', 'UOH-3'], title: 'Connect: state reaches "streaming" within about 10 s and the LEDs stop sweeping' },
  { id: 2, uoh: ['UOH-4'], title: 'Packet length is 63; packet rate and inter-arrival histogram are shown (note the number)' },
  { id: 3, uoh: ['UOH-3', 'UOH-8', 'UOH-20'], title: 'Joy-Con flat with the BUTTONS UP and still for 3 s: |a| = 1.00 +- 0.03 g, raw accel Z about +4096 (+1 g), gyro about 0 +- 3 dps, imuActive true' },
  { id: 4, uoh: ['UOH-6'], title: 'One full revolution: about 360 degrees confirms the gyro scale, about 2930 degrees means 0.0075 dps/LSB' },
  { id: 5, uoh: ['UOH-10'], title: 'Press a few buttons: the names shown match the labels; note any phantom ZL/ZR' },
  { id: 6, uoh: ['UOH-5', 'UOH-15'], title: 'Stay connected for 60 s without touching anything (keep-alive on)' },
  { id: 7, uoh: ['UOH-17'], title: 'Battery mV and temperature are plausible (about 3.5-4.2 V, about 25 C)' },
  { id: 8, uoh: ['UOH-7'], title: 'Gravity vs gyro sign test says "ok" (or "mirrored", which the calibration handles)' },
  { id: 9, uoh: ['UOH-18'], title: 'Latency probe: software part only; measure the display part with a 240 fps phone camera' },
]);

/**
 * Three more steps, shown only in the native-bridge mode (`?input=native`), for the items of docs/native-bridge.md section 11 (registered as
 * UOH-21 to UOH-33 in docs/joycon2-protocol.md). They never replace the nine above: the live values, rates and tools are the same.
 */
export const NATIVE_CHECKLIST = Object.freeze([
  { id: 10, uoh: ['UOH-21', 'UOH-22', 'UOH-26', 'UOH-27'], title: 'Native bridge: started from Terminal, macOS asks once for the Bluetooth permission of Terminal, the bridge reaches "streaming" and the reports arrive steadily' },
  { id: 11, uoh: ['UOH-5', 'UOH-25'], title: 'Keep-alive experiment: 60 s with the keep-alive off (does the link drop at about 15 s?) and 60 s with it on' },
  { id: 12, uoh: ['UOH-23', 'UOH-24', 'UOH-28'], title: 'Choice and reconnect: with SYNC held the pairing-mode advert is chosen, without SYNC the bridge still connects (or says so), and after a drop note whether SYNC is needed again' },
]);

/** Which mode the page runs in from its address: `?input=sim`, `?input=joycon` (Web Bluetooth) or, by default, `?input=native` (the bridge). */
export function parseMode(search) {
  const v = new URLSearchParams(String(search ?? '')).get('input');
  return v === 'sim' ? 'sim' : v === 'joycon' ? 'joycon' : 'native';
}

/** One line per advert the bridge saw: side, signal and whether the controller was in pairing mode (host address all zero). */
export function formatAdverts(adverts) {
  if (!Array.isArray(adverts) || adverts.length === 0) return 'none';
  return adverts
    .map((a) => `${a.side === 'L' ? 'left' : 'right'} ${Number.isFinite(a.rssi) ? `${a.rssi} dBm` : 'unknown signal'} ${a.pairing ? 'in SYNC mode' : 'not in SYNC mode (looking for its saved address)'}`)
    .join('  |  ');
}

/**
 * The 60-second keep-alive experiment (UOH-5, NB-5): the page connects with the keep-alive OFF and watches whether the link drops (the
 * community notes say macOS drops it about 10 to 17 s after the last write from the computer). Pure state machine, time comes in.
 * Phases: idle -> armed (waiting for `streaming`) -> running -> done {verdict: 'survived' | 'dropped' | 'never_connected', dropS}.
 * It proves nothing about other Macs or other Joy-Cons and is UNVERIFIED-ON-HARDWARE until the owner has run it.
 */
export function createKeepAliveExperiment({ durationMs = 60_000 } = {}) {
  let phase = 'idle';
  let startedAt = null;
  let result = null;
  const finish = (verdict, dropS = null) => {
    phase = 'done';
    result = { verdict, dropS, durationS: durationMs / 1000 };
  };
  return {
    start() {
      phase = 'armed';
      startedAt = null;
      result = null;
    },
    /** Feed every provider state (the page calls it from the status event). */
    onState(state, nowMs) {
      if (phase === 'armed' && state === 'streaming') {
        phase = 'running';
        startedAt = nowMs;
      } else if (phase === 'running' && state !== 'streaming') {
        finish('dropped', (nowMs - startedAt) / 1000);
      } else if (phase === 'armed' && state === 'error') {
        finish('never_connected');
      }
    },
    /** Feed the clock (the page's 200 ms render). */
    tick(nowMs) {
      if (phase === 'running' && nowMs - startedAt >= durationMs) finish('survived', null);
    },
    stop() {
      if (phase === 'armed' || phase === 'running') {
        phase = 'idle';
        startedAt = null;
      }
    },
    state(nowMs) {
      return { phase, elapsedS: phase === 'running' && nowMs !== undefined ? Math.max(0, (nowMs - startedAt) / 1000) : null, result };
    },
  };
}

/**
 * JSON report the owner copies to the clipboard and sends back. Plain data only. Nothing in it is a claim by the
 * software about the hardware: `checklist[].status` is what the OWNER ticked.
 */
export function buildReport(input) {
  const steps = input.kind === 'native' ? [...CHECKLIST, ...NATIVE_CHECKLIST] : CHECKLIST;
  const checklist = steps.map((item) => {
    const entry = input.checklist?.[item.id] ?? {};
    return { id: item.id, title: item.title, uoh: item.uoh, status: entry.status ?? 'untested', note: entry.note ?? '' };
  });
  const confirmed = new Set();
  const failed = new Set();
  for (const c of checklist) {
    for (const u of c.uoh) {
      if (c.status === 'pass') confirmed.add(u);
      if (c.status === 'fail') failed.add(u);
    }
  }
  return {
    tool: 'clay-rush diagnostics',
    version: 1,
    createdAt: input.createdAt ?? null,
    userAgent: input.userAgent ?? null,
    input: input.kind ?? null,
    device: { side: input.side ?? null, name: input.deviceName ?? null, featureMask: input.featureMask ?? null },
    connection: { state: input.state ?? null, errorCode: input.errorCode ?? null, failures: input.failures ?? null, timings: input.timings ?? null, watchdogStage: input.watchdogStage ?? null, keepAlive: input.keepAlive ?? null },
    packets: { length: input.packetLength ?? null, imuActive: input.imuActive ?? null, rate1sHz: input.rate1s ?? null, rate10sHz: input.rate10s ?? null, interArrivalMs: input.interArrival ?? null },
    timing: { dtSource: input.dtSource ?? null, dtRatio: input.dtRatio ?? null, counterRatio: input.counterRatio ?? null, dropped: input.dropped ?? null, bursts: input.bursts ?? null, gaps: input.gaps ?? null },
    battery: { mv: input.batteryMv ?? null, level: input.batteryLevel ?? null, tempC: input.tempC ?? null },
    tools: { scale: input.scale ?? null, signTest: input.signTest ?? null, restCheck: input.restCheck ?? null, accelSign: input.accelSign ?? null, latencyMs: input.latency ?? null, keepAlive: input.keepAliveExperiment ?? null },
    native: input.native ?? null,
    checklist,
    uohConfirmedByOwner: [...confirmed].sort(),
    uohFailedByOwner: [...failed].sort(),
    note: 'Every hardware-dependent item stays UNVERIFIED-ON-HARDWARE unless the owner ticked "pass" above.',
  };
}

/**
 * Storage helpers for the record of this page: `{gyroScale?, accelSign?, measuredAt}` under localStorage key joyconNinja.imu.v1
 * (read by app.js, architecture A-13). Saving one field keeps the other. Every access is guarded; without storage the value is
 * kept in memory and `persistent` is false.
 */
function readRecord(storage, key, memory) {
  for (const raw of [storage ? safeGet(storage, key) : null, memory[key]]) {
    if (!raw) continue;
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* garbage: start a new record */
    }
  }
  return {};
}
function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
function writeRecord(storage, key, memory, value) {
  memory[key] = JSON.stringify(value);
  try {
    if (!storage) throw new Error('no storage');
    storage.setItem(key, memory[key]);
    return { ok: true, persistent: true, value };
  } catch {
    return { ok: true, persistent: false, value, reason: 'localStorage is not available: the value is only kept until this page closes' };
  }
}

export function saveScale(storage, result, nowIso, key = INPUT_CONFIG.diagnostics.storageKey, memory = {}) {
  if (!result || !Number.isFinite(result.gyroScale) || result.gyroScale <= 0) return { ok: false, persistent: false, reason: 'no usable scale' };
  const value = { ...readRecord(storage, key, memory), gyroScale: result.gyroScale, measuredAt: nowIso };
  return writeRecord(storage, key, memory, value);
}

/** Read a stored scale back (tolerant of garbage). */
export function loadScale(storage, key = INPUT_CONFIG.diagnostics.storageKey) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Number.isFinite(v.gyroScale) && v.gyroScale > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Forget everything the diagnostics page saved for the game (gyro scale and accelerometer sign). Until now the only way was
 * localStorage.removeItem in the developer tools, and a scale measured once applied to every later session (round 2 m1, n10).
 */
export function clearSavedRecord(storage, key = INPUT_CONFIG.diagnostics.storageKey, memory = {}) {
  delete memory[key];
  try {
    if (!storage) throw new Error('no storage');
    storage.removeItem(key);
    return { ok: true, persistent: true };
  } catch {
    return { ok: true, persistent: false, reason: 'localStorage is not available: nothing was saved, only this page forgot its values' };
  }
}

/** Save the accelerometer sign (+1 or -1) the rest check found (round 1 finding F3). */
export function saveAccelSign(storage, sign, nowIso, key = INPUT_CONFIG.diagnostics.storageKey, memory = {}) {
  if (sign !== 1 && sign !== -1) return { ok: false, persistent: false, reason: 'the accelerometer sign must be 1 or -1' };
  const value = { ...readRecord(storage, key, memory), accelSign: sign, measuredAt: nowIso };
  return writeRecord(storage, key, memory, value);
}

/** The saved accelerometer sign, or null when none was saved (tolerant of garbage). */
export function loadAccelSign(storage, key = INPUT_CONFIG.diagnostics.storageKey) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw)?.accelSign;
    return v === 1 || v === -1 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The game URL that uses what this page proved (round 1 findings M5 / F2): the game reads ?filter, ?mask, ?side and ?accelsign.
 * Values equal to the game's own defaults are left out, so with the defaults the URL is just "/". The default filter is
 * INPUT_CONFIG.defaultFilter ('lenient'), not 'strict'. A filter that is left out lets the game use the filter it remembered from its
 * last successful connection, if any; a filter that is written always wins.
 * @param {string} origin  for example "http://localhost:8137" ('' gives a relative URL)
 * @param {{input?:'native'|'joycon', filter?:string, mask?:number, side?:string, accelSign?:number|null}} o  (`input: 'native'` adds ?input=native and leaves the BLE-only filter out)
 */
export function buildGameUrl(origin, o = {}, cfg = INPUT_CONFIG) {
  const q = [];
  if (o.input === 'native') q.push('input=native'); // the game then creates the native provider at boot (the bridge is what this page tested)
  if (o.filter && o.filter !== (cfg.defaultFilter ?? 'lenient') && o.input !== 'native') q.push(`filter=${o.filter}`); // the chooser filter is Web Bluetooth's
  if (Number.isFinite(o.mask) && o.mask !== cfg.featureMask) q.push(`mask=0x${(o.mask & 0xff).toString(16).toUpperCase().padStart(2, '0')}`);
  if (o.side === 'L' || o.side === 'R') q.push(`side=${o.side}`);
  if (o.accelSign === -1) q.push('accelsign=-1');
  return `${origin}/${q.length ? `?${q.join('&')}` : ''}`;
}
