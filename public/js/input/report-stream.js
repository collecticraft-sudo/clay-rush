// Transport-independent report stream: "bytes + arrival time -> events". OWNER: input engineer.
//
// This is the single place where a raw 63-byte notification becomes a PacketEvent, a ButtonsEvent and an ImuSample
// (docs/architecture.md 5.5). It knows nothing about Bluetooth: the BLE provider feeds it notifications, the simulator
// feeds it the bytes of buildInputReport, and the native Bluetooth bridge (native-provider.js) feeds it the hex of the
// helper's report lines that arrive over Server-Sent Events. All of it follows docs/joycon2-protocol.md 7.3 and is UNVERIFIED-ON-HARDWARE: the real timestamp semantics
// (microseconds? monotonic?) and the real report rate in Chrome on macOS are unknown (UOH-4, UOH-8).
//
// Timing rules (NORMATIVE, protocol 7.3):
//   dt   from the u32 wrap-safe IMU timestamp delta, accepted when 0 < delta < 200 ms, otherwise null (a gap) and the
//        estimate restarts. Every second the summed device deltas are compared with the arrival span: a ratio in
//        0.8..1.25 keeps the device timestamps (dtSource 'device'), anything else falls back to arrival times
//        ('arrival') with a warning. Timestamps that are unusable three times in a row (stuck at one value, for
//        example) also fall back at once. In the arrival fallback dt is the MEAN arrival interval of the last 32
//        packets, so a burst pair (two packets, one arrival time) never yields a null or a near-zero dt. The 0x00 counter
//        is never used for dt or loss detection.
//   t    the moment the sample was taken: device time mapped onto the Clock with a running minimum of
//        (arrival - device time), which removes burst jitter. The minimum creeps up slowly so that a controller clock that
//        runs slow relative to the host cannot make `t` fall behind without bound. t is non-decreasing and never later
//        than arrivedAt.

import { INPUT_CONFIG } from './input-config.js';
import { parseInputReport, counterDelta } from './joycon2-parse.js';
import { createStickTracker } from './stick.js';

const EMPTY = Object.freeze([]);

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const freezeList = (list) => (list.length ? Object.freeze(list) : EMPTY);

/**
 * @param {object} [opts]
 * @param {'L'|'R'|'?'} [opts.side]
 * @param {(type:string, payload:any) => void} [opts.emit]        receives 'packet', 'buttons', 'nav' (stick flicks, only on an edge), 'sample' in that order
 * @param {(type:string) => boolean} [opts.hasListener]           lets the stream skip building PacketEvents nobody reads
 * @param {(level:string, message:string) => void} [opts.log]
 * @param {object} [opts.config]
 */
export function createReportStream(opts = {}) {
  const fullCfg = opts.config ?? INPUT_CONFIG;
  const cfg = fullCfg.report;
  const emit = opts.emit ?? (() => {});
  const hasListener = opts.hasListener ?? (() => true);
  const log = opts.log ?? (() => {});
  let side = opts.side ?? '?';

  let seq = 0;
  let lastT = -Infinity;

  // --- timing state (restarted by reset() and after every gap)
  let prevTs = null;
  let prevCounter = 0;
  let prevArrival = null;
  let devMs = 0;
  let offset = Infinity;
  let mode = 'device'; // 'device' | 'arrival'
  let badStreak = 0;
  let win = { start: 0, dev: 0, counter: 0, n: 0 };
  let typicalUs = null;
  let farCount = 0;

  // --- buttons
  let prevPressed = null;

  // --- the analog stick as a menu pointer: one 'nav' event per flick and per release (input/stick.js; nothing is emitted at rest)
  const stick = createStickTracker({ config: fullCfg.stick ?? INPUT_CONFIG.stick, side });

  // --- arrival history of the last packets: the arrival-fallback dt is their mean interval
  const recent = new Float64Array(cfg.arrivalMeanPackets);
  let recentHead = 0;
  let recentCount = 0;

  // --- arrival ring for the packet rate
  const ring = new Float64Array(cfg.rateRingSize);
  let ringHead = 0;
  let ringCount = 0;
  let firstArrival = null;

  const stats = {
    packets: 0, rejected: 0, inactive: 0, samples: 0, gaps: 0, duplicates: 0, dropped: 0, bursts: 0,
    dtRatio: null, counterRatio: null, dtSource: 'device', windows: 0, lastDtMs: null,
  };

  function newWindow(at) {
    win = { start: at, dev: 0, counter: 0, n: 0 };
  }

  function markArrival(at) {
    ring[ringHead] = at;
    ringHead = (ringHead + 1) % ring.length;
    if (ringCount < ring.length) ringCount++;
    if (firstArrival === null) firstArrival = at;
  }

  /**
   * Packets per second over the last `windowMs` (default 1 s); null until two packets have arrived. Once the window is
   * covered the value is the packet count per window (0 for a stalled stream); before that it is interval based.
   */
  function getRateHz(now, windowMs = cfg.rateWindowMs) {
    if (ringCount < 2) return null;
    const from = now - windowMs;
    let n = 0;
    let oldest = now;
    for (let i = 0; i < ringCount; i++) {
      const at = ring[(ringHead - 1 - i + ring.length) % ring.length];
      if (at <= from) break;
      n++;
      oldest = at;
    }
    if (now - firstArrival >= windowMs) return (n * 1000) / windowMs;
    if (n < 2) return null;
    const span = ring[(ringHead - 1 + ring.length) % ring.length] - oldest;
    return span > 0 ? ((n - 1) * 1000) / span : null;
  }

  function noteRecent(at, restart) {
    if (restart) {
      recentHead = 0;
      recentCount = 0;
    }
    recent[recentHead] = at;
    recentHead = (recentHead + 1) % recent.length;
    if (recentCount < recent.length) recentCount++;
  }

  /** Mean interval over the recent arrivals, or null while there are too few of them. */
  function meanArrivalInterval() {
    if (recentCount < 4) return null;
    const newest = recent[(recentHead - 1 + recent.length) % recent.length];
    const oldest = recent[(recentHead - recentCount + recent.length) % recent.length];
    return (newest - oldest) / (recentCount - 1);
  }

  function judgeWindow(arrivedAt) {
    const span = arrivedAt - win.start;
    const ratio = span > 0 ? win.dev / span : 0;
    stats.dtRatio = ratio;
    stats.windows++;
    if (win.dev > 0) stats.counterRatio = win.counter / win.dev;
    const ok = ratio >= cfg.trustRatioMin && ratio <= cfg.trustRatioMax;
    if (ok && mode !== 'device') {
      mode = 'device';
      log('info', `IMU timestamps agree with arrival times again (ratio ${ratio.toFixed(2)}): using device timestamps`);
    } else if (!ok && mode !== 'arrival') {
      mode = 'arrival';
      log('warn', `IMU timestamps disagree with arrival times (ratio ${ratio.toFixed(2)}): using arrival times for dt (UNVERIFIED-ON-HARDWARE UOH-8)`);
    }
    newWindow(arrivedAt);
  }

  /** Loss and burst bookkeeping for the diagnostics page (informational only, D13: never relied upon). */
  function noteInterval(dUs, arrDtMs) {
    if (typicalUs === null) {
      typicalUs = dUs;
      return;
    }
    if (dUs > typicalUs * cfg.lossRatio) {
      stats.dropped += Math.max(0, Math.round(dUs / typicalUs) - 1);
      if (++farCount >= 8) {
        typicalUs = dUs; // the rate really changed
        farCount = 0;
      }
      return;
    }
    farCount = 0;
    if (dUs >= typicalUs * 0.5) typicalUs += (dUs - typicalUs) * 0.1;
    if (arrDtMs < (typicalUs / 1000) * cfg.burstRatio) stats.bursts++;
  }

  /** Returns {dtMs, dtSource, t}. */
  function timing(ts, counter, arrivedAt) {
    let dtMs = null;
    const arrGap = prevArrival !== null && arrivedAt - prevArrival >= cfg.arrivalDtMaxMs;
    noteRecent(arrivedAt, prevArrival === null || arrGap);
    if (prevTs === null) {
      devMs = ts / 1000;
      offset = Infinity;
      newWindow(arrivedAt);
    } else {
      const dUs = (ts - prevTs) >>> 0;
      const devOk = dUs > 0 && dUs < cfg.dtMaxUs;
      const arrDt = arrivedAt - prevArrival;
      if (devOk) {
        badStreak = 0;
        devMs += dUs / 1000;
        win.dev += dUs / 1000;
        win.counter += counterDelta(prevCounter, counter);
        win.n++;
        noteInterval(dUs, arrDt);
      } else {
        // a gap, a duplicate (delta 0), or a timestamp that went backwards: restart the estimate
        badStreak++;
        stats.gaps++;
        if (dUs === 0) stats.duplicates++;
        devMs = ts / 1000;
        offset = Infinity;
        newWindow(arrivedAt);
        if (mode === 'device' && badStreak >= cfg.badStreakToFallback) {
          mode = 'arrival';
          log('warn', 'IMU timestamps are unusable (stuck or out of range): using arrival times for dt (UNVERIFIED-ON-HARDWARE UOH-8)');
        }
      }
      if (devOk && arrivedAt - win.start >= cfg.trustWindowMs && win.n >= cfg.trustMinIntervals) judgeWindow(arrivedAt);
      if (mode === 'device') dtMs = devOk ? dUs / 1000 : null;
      else if (arrGap) dtMs = null;
      else dtMs = Math.max(meanArrivalInterval() ?? arrDt, cfg.arrivalDtFloorMs);
    }
    if (prevArrival !== null && offset !== Infinity) offset += cfg.offsetLeakPerMs * Math.max(0, arrivedAt - prevArrival);
    const cand = arrivedAt - devMs;
    if (cand < offset) offset = cand;
    let t = mode === 'device' ? Math.min(arrivedAt, offset + devMs) : arrivedAt;
    if (t < lastT) t = lastT;
    lastT = t;
    prevTs = ts;
    prevCounter = counter;
    prevArrival = arrivedAt;
    stats.dtSource = mode;
    stats.lastDtMs = dtMs;
    return { dtMs, dtSource: mode, t };
  }

  /**
   * Feed one notification.
   * @param {Uint8Array} bytes  a private copy of the notification (it is handed to listeners inside PacketEvent)
   * @param {number} arrivedAt  Clock ms, taken first thing in the notification handler
   * @returns {{report:object|null, sample:object|null}}
   */
  function push(bytes, arrivedAt) {
    stats.packets++;
    markArrival(arrivedAt);
    const report = parseInputReport(bytes, side);
    if (!report) {
      stats.rejected++;
      if (hasListener('packet')) emit('packet', { arrivedAt, length: bytes ? bytes.length : 0, bytes, report: null, t: null });
      return { report: null, sample: null };
    }

    // --- timing (only reports that carry IMU data feed the estimators)
    let timed = null;
    if (report.imuActive) timed = timing(report.imuTimestampUs, report.counter, arrivedAt);
    else stats.inactive++;
    const t = timed ? timed.t : arrivedAt;

    // --- buttons
    const pressed = freezeList(report.pressed);
    let buttonsEvent = null;
    const initial = prevPressed === null;
    if (initial || !sameList(prevPressed, pressed)) {
      const before = prevPressed ?? EMPTY;
      buttonsEvent = {
        t, side, pressed,
        down: freezeList(pressed.filter((n) => !before.includes(n))),
        up: freezeList(before.filter((n) => !pressed.includes(n))),
      };
      if (initial) buttonsEvent.initial = true;
    }
    prevPressed = pressed;

    // --- emit: packet, buttons, sample (synchronous, in this order)
    if (hasListener('packet')) emit('packet', { arrivedAt, length: report.length, bytes, report, t: timed ? timed.t : null });
    if (buttonsEvent) emit('buttons', buttonsEvent);
    const flicks = stick.push(report.stickFields);
    for (const f of flicks.events) emit('nav', { t, dir: f.dir, phase: f.phase, side, source: 'joycon', nx: flicks.state.nx, ny: flicks.state.ny });
    if (!timed) return { report, sample: null };

    const sample = {
      seq: seq++,
      t: timed.t,
      arrivedAt,
      dtMs: timed.dtMs,
      dtSource: timed.dtSource,
      accel: report.accelG,
      gyro: report.gyroDps,
      side,
      buttons: pressed,
      batteryMv: report.batteryMv > 0 ? report.batteryMv : null,
      tempC: report.temperatureC,
      imuActive: true,
    };
    stats.samples++;
    emit('sample', sample);
    return { report, sample };
  }

  return {
    push,
    getRateHz,
    setSide(next) {
      side = next;
      stick.setSide(next);
    },
    getSide: () => side,
    /** The last stick reading ({raw, centre, centred, nx, ny, mag, held, ...}, input/stick.js) or null before the first report. */
    getStick: () => stick.getState(),
    /** New link / new epoch: forget every estimator (sequence numbers and the non-decreasing `t` carry on). */
    reset() {
      prevTs = null;
      prevArrival = null;
      offset = Infinity;
      mode = 'device';
      badStreak = 0;
      typicalUs = null;
      farCount = 0;
      prevPressed = null;
      stick.reset();
      ringCount = 0;
      ringHead = 0;
      recentCount = 0;
      recentHead = 0;
      firstArrival = null;
      stats.dtSource = 'device';
      newWindow(0);
    },
    /** Snapshot of the counters for the diagnostics page. */
    getStats(now) {
      return {
        ...stats,
        dtSource: mode,
        rate1sHz: now === undefined ? null : getRateHz(now, 1000),
        typicalDtMs: typicalUs === null ? null : typicalUs / 1000,
      };
    },
  };
}
