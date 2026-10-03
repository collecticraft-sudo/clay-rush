// Simulator provider (docs/architecture.md 5.8). OWNER: input engineer.
//
// The mouse moves a virtual sword; the sword's motion becomes gyro and accelerometer readings; the readings are
// quantised into byte-exact 63-byte Joy-Con 2 packets (buildInputReport); the packets go through the SAME report stream
// as the Bluetooth provider (parseInputReport, dt from device timestamps, side, buttons) and come out as ImuSamples.
// So the real parser and the real Motion pipeline run on plausible data on any machine, with no controller.
//
// Everything is seeded and a pure function of (seed, commands): report k has its own timing and noise stream, so the
// output does not depend on how often tick() is called. This models docs/joycon2-protocol.md, NOT the device: the
// 66 Hz rate, the burst behaviour, the noise levels and the mount frames are assumptions (UNVERIFIED-ON-HARDWARE).

import { ACTION, ACTION_SOURCE, INPUT_ERROR } from '../shared/contracts.js';
import { createRng, hash32 } from '../shared/rng.js';
import { INPUT_CONFIG } from './input-config.js';
import { resolveTimers } from './timers.js';
import { createProviderBase, ACTION_LABELS } from './provider-base.js';
import { createReportStream } from './report-stream.js';
import { buildInputReport } from './joycon2-build.js';
import { ACCEL_G_PER_LSB } from './joycon2-parse.js';
import { createSimModel } from './sim-model.js';
import { makeErrorInfo, errorFromInfo } from './status.js';
import { eventTimeMs, eventsOf, makePlayfieldMapper, attachClickActions } from './pointer-util.js';
import { toVec } from './sim-math.js';

const CAPABILITIES = Object.freeze({
  imu: true, aim: false, buttons: false, needsUserGesture: false, needsCalibration: false, hasBattery: false, canVibrate: false,
});

const clampRaw = (x) => (x > 32767 ? 32767 : x < -32768 ? -32768 : Math.round(x));

/** @returns {import('../shared/contracts.js').InputProvider & object} */
export function createSimProvider(opts) {
  const { clock } = opts;
  const all = opts.config ?? INPUT_CONFIG;
  const cfg = all.sim;
  const so = opts.sim ?? {};
  const timers = resolveTimers(opts.timers);

  const hz = so.hz ?? cfg.hz;
  if (!Number.isFinite(hz) || hz <= 0) throw new RangeError(`simulator rate must be a positive number, got ${hz}`);
  const period = 1000 / hz;
  const side = so.side === 'L' ? 'L' : 'R';
  const mirror = !!so.mirrorGyro;
  // -1: the virtual sensor reports the gravity vector (pointing DOWN at rest) instead of the specific force (pointing UP): a model
  // of the unknown accelerometer convention of the real Joy-Con 2 (protocol audit F3). The game must then run with ?accelsign=-1.
  const accelSgn = so.accelSign === -1 ? -1 : 1;
  const gyroScaleTrue = so.gyroScaleTrue === 'alt' ? 'alt' : 'default';
  const trueLsb = cfg.gyroLsbDps[gyroScaleTrue];
  const noiseOn = so.noise !== false;
  const jitterOn = so.jitter !== false;
  const burstsOn = so.bursts !== false;
  const burstProb = so.burstProb ?? cfg.burstProb;
  const seed = (so.seed ?? 1) >>> 0;
  const startTimestampUs = so.startTimestampUs ?? cfg.startTimestampUs;
  const startCounter = so.startCounter ?? cfg.startCounter;

  const base = createProviderBase({ kind: 'sim', capabilities: CAPABILITIES, clock, side, log: opts.log, strict: opts.strictTransitions });
  const { emitter, store, log } = base;
  store.patch({ deviceName: 'Simulator' }, { emit: false });

  const model = createSimModel({
    mount: so.mount, mirrorGyro: mirror, leverM: so.leverM, followTauMs: so.followTauMs, startMs: clock.now(), config: all,
  });
  let lastSampleT = null; // measurement time of the newest emitted report (the simulated device's "now" for fire())
  const stream = createReportStream({
    side,
    config: all,
    log,
    hasListener: (type) => emitter.listenerCount(type) > 0,
    emit: (type, payload) => {
      if (type === 'sample') lastSampleT = payload.t;
      emitter.emit(type, payload);
    },
  });

  // --- truth (what a perfect calibration would find). Bias is a physical quantity: it is added before quantisation.
  const biasRng = createRng(hash32(seed, 0xb1a5));
  const biasTrueDps = noiseOn
    ? [biasRng.range(-cfg.gyroBiasDps, cfg.gyroBiasDps), biasRng.range(-cfg.gyroBiasDps, cfg.gyroBiasDps), biasRng.range(-cfg.gyroBiasDps, cfg.gyroBiasDps)]
    : [0, 0, 0];
  const lsbRatio = cfg.defaultGyroLsbDps / trueLsb; // how much too large the parser's default scale makes the signal (1 or 8.138)
  const gyroScaleRatio = Number((trueLsb / cfg.defaultGyroLsbDps).toFixed(6)); // Calibration.gyroScale: 1 or 0.12288
  const biasParserDps = biasTrueDps.map((b) => b * lsbRatio); // bias in ImuSample.gyro units

  const nominalCalibration = Object.freeze({
    version: 1,
    side,
    createdAt: 0, // synthetic; only Motion may read the wall clock (architecture rule 4)
    frame: model.frame,
    gyroBiasDps: toVec(biasParserDps),
    gyroSign: mirror ? -1 : 1,
    gyroScale: gyroScaleRatio,
    gyroScaleSource: 'stored',
    quality: { poseAngleDeg: null, stillPeakDps: 0, warnings: [] },
  });

  // --- timeline
  let t0 = 0; // device time origin on the Clock
  let k = 1; // index of the next report
  let plan = null;
  let prevHeld = false;
  let prevA = -Infinity;
  let tickTimer = null;
  let simLost = false;
  let recoverable = false;
  let pointerOutside = false;
  let pointerSeen = false; // any pointer event since connect: a click before that reveals where the pointer already is
  let lastPointerT = -Infinity;
  let needTeleport = true;
  let nextRateAt = 0;
  let lastArrival = null;
  let detach = [];
  const scripts = [];
  // Mouse teleports (pointer enter, blur, silence, setTarget({teleport})) waiting for the first report measured after them:
  // that report is preceded by a 'teleport' event so the host can re-anchor Motion (additive, contract-notes, integrator).
  const teleports = [];

  const mapper = makePlayfieldMapper(opts.target ?? null, opts.toPlayfield);
  const windowTarget = opts.windowTarget ?? (typeof globalThis.window !== 'undefined' ? globalThis.window : null);

  /** Timing of report k: a pure function of (seed, k). G = instant of the measurement, B = base arrival. */
  function timesOf(index) {
    const r = createRng(hash32(seed, index));
    const amp = jitterOn ? Math.min(cfg.jitterMs, period * cfg.jitterMaxPeriodFraction) : 0;
    const jitter = (r.next() * 2 - 1) * amp;
    const latency = jitterOn ? r.next() * cfg.latencyJitterMs : (r.next(), 0);
    const heldDraw = r.next();
    const G = t0 + index * period + jitter;
    return { G, B: G + cfg.baseLatencyMs + latency, heldDraw };
  }

  function makePlan(index) {
    const cur = timesOf(index);
    const held = burstsOn && !prevHeld && cur.heldDraw < burstProb;
    let A = held ? Math.max(cur.B, timesOf(index + 1).B) : cur.B; // a held report is delivered together with the next one
    if (A < prevA) A = prevA;
    return { k: index, G: cur.G, A, held };
  }

  function gauss(rng) {
    return Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
  }

  function emitReport(p) {
    const s = model.sampleAt(p.G);
    if (teleports.length) {
      // The gyro cannot see a teleport, so Motion's cursor would stay behind by the size of the jump: tell the host where the
      // virtual mouse now is, right before the first report that reflects the new pose.
      let jump = null;
      while (teleports.length && teleports[0].s <= p.G + 1e-9) jump = teleports.shift();
      if (jump && !model.isPoseLocked()) emitter.emit('teleport', { t: p.G, x: jump.x, y: jump.y });
    }
    const nr = createRng(hash32(seed ^ 0x5eed5eed, p.k));
    const noise = (sigma) => (noiseOn ? gauss(nr) * sigma : (nr.next(), nr.next(), 0));
    const gyroRaw = {
      x: clampRaw((s.gyroDps.x + biasTrueDps[0] + noise(cfg.gyroNoiseDps)) / trueLsb),
      y: clampRaw((s.gyroDps.y + biasTrueDps[1] + noise(cfg.gyroNoiseDps)) / trueLsb),
      z: clampRaw((s.gyroDps.z + biasTrueDps[2] + noise(cfg.gyroNoiseDps)) / trueLsb),
    };
    const accelRaw = {
      x: clampRaw((accelSgn * (s.accelG.x + noise(cfg.accelNoiseG))) / ACCEL_G_PER_LSB),
      y: clampRaw((accelSgn * (s.accelG.y + noise(cfg.accelNoiseG))) / ACCEL_G_PER_LSB),
      z: clampRaw((accelSgn * (s.accelG.z + noise(cfg.accelNoiseG))) / ACCEL_G_PER_LSB),
    };
    const elapsed = p.G - t0;
    const bytes = buildInputReport({
      counter: (startCounter + Math.round(elapsed)) >>> 0,
      imuTimestampUs: (startTimestampUs + Math.round(elapsed * 1000)) >>> 0,
      accelRaw, gyroRaw, temperatureRaw: cfg.temperatureRaw, batteryMv: cfg.batteryMv,
    });
    lastArrival = p.A;
    store.setLive(p.A, null);
    stream.push(bytes, p.A);
  }

  function tick(now) {
    if (store.state() !== 'streaming' || simLost) return;
    let guard = 0;
    for (;;) {
      if (!plan) plan = makePlan(k);
      if (plan.A > now) break;
      if (now - plan.A > cfg.maxCatchUpMs) {
        // far behind (hidden tab, debugger pause): the missed reports never happened, which is a gap for the consumers
        const jump = Math.ceil((now - cfg.maxCatchUpMs - t0) / period) - 2;
        k = Math.max(k + 1, jump);
        prevHeld = false;
        prevA = -Infinity;
        plan = null;
        model.skipTo(t0 + k * period - 100);
        continue;
      }
      emitReport(plan);
      k = plan.k + 1;
      prevHeld = plan.held;
      prevA = plan.A;
      plan = null;
      if (++guard > 20000) break;
    }
    if (now >= nextRateAt) {
      nextRateAt = now + 1000;
      store.patch({ packetRateHz: stream.getRateHz(now) });
    }
    for (let i = scripts.length - 1; i >= 0; i--) {
      if (now >= scripts[i].end) scripts.splice(i, 1)[0].resolve();
    }
  }

  function startSelfTick() {
    stopSelfTick();
    if (!clock.manual) tickTimer = timers.setInterval(() => tick(clock.now()), cfg.selfTickMs);
  }
  function stopSelfTick() {
    if (tickTimer !== null) timers.clearInterval(tickTimer);
    tickTimer = null;
  }

  function setTracking(ok) {
    if (store.get().trackingOk !== ok) store.patch({ trackingOk: ok });
  }

  // --- pointer input
  function onPointerMove(ev) {
    const rect = mapper.rect();
    pointerSeen = true;
    if (pointerOutside) {
      pointerOutside = false;
      needTeleport = true;
    }
    setTracking(true);
    for (const e of eventsOf(ev)) {
      const p = mapper.convert(e.clientX, e.clientY, rect);
      if (!p) continue;
      const t = eventTimeMs(clock, e, lastPointerT);
      if (lastPointerT !== -Infinity && t - lastPointerT > all.mouse.silenceMs) needTeleport = true;
      model.setMouse(t, p.x, p.y, { teleport: needTeleport });
      if (needTeleport) teleports.push({ s: t, x: p.x, y: p.y });
      needTeleport = false;
      lastPointerT = t;
    }
  }
  const onPointerDown = (ev) => {
    if (!pointerSeen) onPointerMove(ev);
    if (ev.button === 0) fireNow(); // Clay Rush C-03: the left press of the virtual mouse is the trigger
  };
  const onPointerEnter = () => {
    pointerSeen = true;
    pointerOutside = false;
    needTeleport = true;
    setTracking(true);
  };
  const onPointerLeave = () => {
    pointerOutside = true;
    needTeleport = true;
    setTracking(false);
  };
  const onBlur = () => {
    needTeleport = true;
  };
  const emitAction = (action) => emitter.emit('action', { t: clock.now(), action, label: ACTION_LABELS.mouse[action], source: ACTION_SOURCE.SIM });

  /**
   * A `fire` action (source 'sim', label 'Click') at the current SIMULATED time: every report due by clock.now() is emitted first, and the
   * shot carries the measurement time of the newest report, i.e. the instant the simulated device last reported, like a real trigger
   * whose t is the time of the report that showed it. Motion then holds a sample exactly at t, so motion.aimAt(t) is valid and is where
   * the virtual sword pointed. Before the first report (or when not streaming) t is clock.now().
   * @returns {import('../shared/contracts.js').ActionEvent}
   */
  function fireNow() {
    const now = clock.now();
    const live = store.state() === 'streaming' && !simLost;
    if (live) tick(now);
    const t = live && lastSampleT !== null && lastSampleT <= now ? lastSampleT : now;
    const event = { t, action: ACTION.FIRE, label: ACTION_LABELS.mouse.fire, source: ACTION_SOURCE.SIM };
    emitter.emit('action', event);
    return event;
  }

  function attach() {
    const target = opts.target;
    if (target && typeof target.addEventListener === 'function') {
      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerdown', onPointerDown);
      target.addEventListener('pointerenter', onPointerEnter);
      target.addEventListener('pointerleave', onPointerLeave);
      detach.push(() => {
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerdown', onPointerDown);
        target.removeEventListener('pointerenter', onPointerEnter);
        target.removeEventListener('pointerleave', onPointerLeave);
      });
      detach.push(attachClickActions(target, emitAction, { doubleClick: false })); // I-01: a double shot is not a recentre
    }
    if (windowTarget && typeof windowTarget.addEventListener === 'function') {
      windowTarget.addEventListener('blur', onBlur);
      detach.push(() => windowTarget.removeEventListener('blur', onBlur));
    }
  }
  function detachAll() {
    for (const fn of detach) fn();
    detach = [];
  }

  function startStreaming(now) {
    t0 = now;
    k = 1;
    plan = null;
    prevHeld = false;
    prevA = -Infinity;
    nextRateAt = now + 1000;
    lastArrival = null;
    simLost = false;
    pointerSeen = false;
    stream.reset();
    lastSampleT = null;
    teleports.length = 0;
    model.skipTo(now);
    attach();
    startSelfTick();
    store.transition('streaming', { error: null, trackingOk: !pointerOutside, failures: 0, cooldownUntil: null, packetRateHz: null });
  }

  function resumeAfterLoss(now) {
    simLost = false;
    plan = null;
    prevHeld = false;
    prevA = -Infinity;
    // the device clock kept running while the link was down: continue the timeline at the first report after `now`
    k = Math.max(k, Math.ceil((now - t0) / period));
    model.skipTo(now);
    nextRateAt = now + 1000;
    startSelfTick();
    store.transition('streaming', { error: null, trackingOk: !pointerOutside });
  }

  function fail(code, message) {
    const info = makeErrorInfo(code, message, clock.now());
    store.patch({ error: info });
    base.emitError(info);
    return errorFromInfo(info);
  }

  const provider = {
    kind: 'sim',
    capabilities: base.capabilities,
    nominalCalibration,
    get status() {
      return store.get();
    },
    connect() {
      const state = store.get().state;
      if (state === 'streaming') return Promise.resolve();
      if (state === 'lost' && !recoverable) return Promise.reject(fail(INPUT_ERROR.GATT_FAILURE, 'simulated link is down; call simulateRecovery()'));
      if (state === 'lost') resumeAfterLoss(clock.now());
      else startStreaming(clock.now());
      return Promise.resolve();
    },
    reconnect() {
      return provider.connect();
    },
    disconnect() {
      stopSelfTick();
      detachAll();
      model.clearPending();
      teleports.length = 0;
      simLost = false;
      recoverable = false;
      for (const s of scripts.splice(0)) s.resolve();
      if (store.get().state !== 'idle') store.transition('idle', { trackingOk: false, error: null });
      return Promise.resolve();
    },
    /** Emit every report due up to `now` (idempotent for a given `now`). */
    tick,
    // the simulator recentres with the keyboard only (C or Space): a double click is two trigger pulls
    getActionLabels: () => ({ ...ACTION_LABELS.mouse, recenter: ACTION_LABELS.keyboard.recenter }),
    /** C-02: the simulator has no shoulder buttons (its trigger is the left mouse button and fire()). */
    setTriggerButton() {},
    on: base.on,
    off: base.off,
    dispose() {
      stopSelfTick();
      detachAll();
      for (const s of scripts.splice(0)) s.resolve();
      emitter.removeAll();
    },

    // --- extras used by the Integrator's debug API (architecture 5.8, Clay Rush 9.3 `sim`)
    /** Bot hook (Clay Rush 4.1): pull the trigger now. Emits and returns the `fire` ActionEvent (see fireNow). */
    fire: () => fireNow(),
    /** Virtual mouse position in playfield px. `teleport` re-anchors without angular velocity; `glideMs` moves smoothly instead. */
    setTarget(x, y, o = {}) {
      const now = clock.now();
      model.setMouse(now, x, y, { teleport: !!o.teleport, glideMs: o.glideMs ?? 0 });
      if (o.teleport) teleports.push({ s: now, x, y });
    },
    /** 'tipUp' | 'pointScreen' | 'flat' | {yawDeg, pitchDeg, rollDeg?}; overrides the mouse until clearPose(). */
    setPose(pose, o = {}) {
      model.setPose(clock.now(), pose, { transitionMs: o.transitionMs ?? 0, teleport: !!o.teleport });
    },
    clearPose(o = {}) {
      model.clearPose(clock.now(), { transitionMs: o.transitionMs ?? 0, teleport: !!o.teleport });
    },
    /**
     * still tip-up, rotate to the screen, still, hold at the centre: drives the real calibration wizard without a
     * human (?simcal=1). Resolves once the script is over (driven by tick(), so a manual clock must be advanced).
     */
    playCalibrationScript() {
      const s = cfg.calibrationScript;
      const t = clock.now();
      const rotateAt = t + s.tipUpStillMs;
      const end = rotateAt + s.rotateMs + s.pointStillMs + s.holdCentreMs;
      model.setPose(t, 'tipUp', { teleport: true });
      model.setPose(rotateAt, 'pointScreen', { transitionMs: s.rotateMs });
      model.clearPose(end, { transitionMs: 400 });
      return new Promise((resolve) => scripts.push({ end, resolve }));
    },
    /** Debug hook: the link goes down (state lost, lost_signal). reconnect() fails until simulateRecovery(). */
    simulateLoss() {
      if (store.get().state !== 'streaming') return;
      simLost = true;
      recoverable = false;
      stopSelfTick();
      const info = makeErrorInfo(INPUT_ERROR.LOST_SIGNAL, 'simulated link loss', clock.now());
      store.transition('lost', { error: info, trackingOk: false });
      base.emitError(info);
    },
    /** Debug hook: the link is back; if the provider is lost it resumes streaming at once, otherwise reconnect() will succeed. */
    simulateRecovery() {
      recoverable = true;
      if (store.get().state === 'lost') resumeAfterLoss(clock.now());
    },
    getTruth() {
      return {
        frame: model.frame,
        gyroBiasDps: toVec(biasParserDps), // in ImuSample.gyro units: what a perfect calibration would subtract
        gyroBiasTrueDps: toVec(biasTrueDps), // physical bias before the disputed scale
        gyroSign: mirror ? -1 : 1,
        accelSign: accelSgn, // what the pipeline needs as `accelSign` to undo the sensor convention
        gyroScaleTrue,
        gyroScaleTrueDpsPerLsb: trueLsb,
        gyroScaleRatio, // Calibration.gyroScale a perfect calibration would find
        side,
        hz,
        seed,
        aim: model.getAim(),
      };
    },
    getDiagnostics() {
      const now = clock.now();
      return {
        kind: 'sim', side, hz, seed, timings: null, featureMask: null, watchdogStage: 0, keepAlive: null, lastWriteAt: null,
        lastArrivalAt: lastArrival, stream: stream.getStats(now),
      };
    },
    /** Test access to the physics (never used by the game). */
    _model: model,
  };
  return provider;
}
