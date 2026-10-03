// window.__clay: the deterministic debug API for automated agents, bots and e2e tests (docs/architecture.md 9.3). OWNER: integrator.
//
// Built by app.js through createClayApi(host). It goes through the same code paths as a player wherever that is practical:
//   aim(x, y)        -> the simulator's virtual gun (teleport) or an aim sample into Motion (mouse, no provider): the crosshair moves
//   fire({x, y}?)    -> a Shot (source 'debug', compMs 0) in app.js's shot queue -> game.update at the next frame (the real hit test)
//   shootTarget(id)  -> fire() at the projected target (shared/world.js projection, optional lead)
//   press(action)    -> an ActionEvent into the UI, exactly like a button (press('fire') becomes the UI's fire intent)
//   sim.fire()       -> the simulator's own trigger: the report path, motion.aimAt(t), the UI and the fire intent (the whole chain)
//
// Time model: fire() and its friends resolve with the game events of the frames that follow the shot, up to FIRE_TAIL_MS after it (Hard
// resolves the pellets 60 to 100 ms after the press). Under ?clock=manual the call itself advances the clock in slices of SLICE_MS and runs
// the frames (the effects are applied when it resolves); under the real clock the frames come from requestAnimationFrame.

import { project, WORLD } from './shared/world.js';
import { FIELD } from './shared/playfield.js';

export const SLICE_MS = 16; // manual clock: largest frame slice
export const FIRE_TAIL_MS = 150; // a fire() result includes the events of the 150 ms after the shot (Hard pellet travel is at most 100 ms)
const MANUAL_DRIVE_LIMIT_MS = 60000;
const MODES = Object.freeze(['classic', 'timeattack', 'zen']);
const ACTIONS = Object.freeze(['fire', 'confirm', 'back', 'pause', 'recenter']);
const NAV_DIRS = Object.freeze(['up', 'down', 'left', 'right']);

const isPoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** The keys of a GameSnapshot, all null: what snapshot() flattens when no round exists. */
const EMPTY_GAME = Object.freeze({
  v: null, mode: null, difficulty: null, seed: null, phase: null, t: null, tWorld: null, alpha: null, timeScale: null, stage: null, pull: null,
  wind: null, shells: null, score: null, streak: null, multiplier: null, multiplierProgress: null, timeLeft: null, timeTotal: null,
  targets: [], houses: [], killCam: null, practice: null, stats: null, assist: null, endReason: null, events: [],
});

/**
 * @param {object} host  services of app.js
 * @param {import('./shared/contracts.js').Clock} host.clock
 * @param {import('./shared/contracts.js').MotionPipeline} host.motion
 * @param {object} host.presentation
 * @param {() => object|null} host.getGame
 * @param {() => object|null} host.getProvider
 * @param {() => void} host.runStep                 one frame (app.js step())
 * @param {(mode:string, o:object) => object} host.startRound
 * @param {(shot:object) => void} host.queueShot
 * @param {() => void} host.applySettings
 * @param {(n:number|null) => void} host.setSeed
 * @param {() => object} host.getConfig
 * @param {() => number|null} host.getInputToDrawMs
 * @param {() => boolean} host.isReady
 * @param {() => Array<object>} host.getLog
 * @param {() => object} host.getProviderStatus
 * @param {() => object} host.getWakeLock
 * @param {() => object} host.getCounters
 * @param {() => object} [host.getAssets]
 * @returns {{api:object, injectDue:(now:number)=>void, afterStep:(now:number, events:object[])=>void, aimOverride:()=>boolean}}
 */
export function createClayApi(host) {
  const { clock, motion, presentation } = host;
  const ui = presentation.ui;
  const storage = presentation.storage;
  /** @type {Array<{until:number, events:object[], done:boolean, resolve:Function, promise:Promise<any>, map:(r:object)=>object}>} */
  const jobs = [];
  let debugAim = false; // a debug aim was set: the crosshair shows even when the provider's own pointer is not tracking

  // ---------------------------------------------------------------------------------------------------------------- jobs

  function newJob(until, map = (r) => r) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const job = { until, events: [], done: false, resolve, promise, map };
    jobs.push(job);
    return job;
  }

  /** Called at the start of every frame (nothing is scheduled ahead of time any more; kept for the frame order of architecture 3). */
  function injectDue() {}

  /** Called at the end of every frame with the game events drained in it. */
  function afterStep(now, events) {
    for (let i = jobs.length - 1; i >= 0; i -= 1) {
      const job = jobs[i];
      if (events.length) for (const e of events) job.events.push(e);
      if (now >= job.until - 1e-6) {
        job.done = true;
        jobs.splice(i, 1);
        job.resolve(job.map({ events: job.events }));
      }
    }
  }

  /** Manual clock: run frames until the job has settled. */
  function drive(job) {
    let guard = 0;
    while (!job.done) {
      clock.advance(SLICE_MS);
      host.runStep();
      guard += SLICE_MS;
      if (guard > MANUAL_DRIVE_LIMIT_MS) throw new Error('the debug job did not finish within 60 s of simulated time');
    }
    return job.promise;
  }

  const run = (job) => (clock.manual ? drive(job) : job.promise);

  // -------------------------------------------------------------------------------------------------------------- aim and shots

  function currentAim() {
    const h = motion.headAt(clock.now());
    if (h) return { x: h.x, y: h.y };
    const ms = motion.getState();
    return { x: ms.x, y: ms.y };
  }

  /** Move the crosshair: the simulator's virtual gun jumps there (teleport, no angular velocity), else an aim sample goes into Motion. */
  function aim(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('aim: x and y must be numbers (playfield px)');
    const cx = clamp(x, 0, FIELD.w);
    const cy = clamp(y, 0, FIELD.h);
    const p = host.getProvider();
    debugAim = true;
    if (p && p.kind === 'sim' && typeof p.setTarget === 'function') p.setTarget(cx, cy, { teleport: true });
    else motion.pushAim({ t: clock.now(), x: cx, y: cy, discontinuity: true });
    return { x: cx, y: cy };
  }

  function fire(at) {
    try {
      const p = isPoint(at) ? aim(at.x, at.y) : currentAim();
      const now = clock.now();
      const shot = { t: now, x: clamp(p.x, 0, FIELD.w), y: clamp(p.y, 0, FIELD.h), source: 'debug', compMs: 0 };
      host.queueShot(shot);
      return run(newJob(now + FIRE_TAIL_MS, (r) => ({ ...r, shot })));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Where target `id` will be `leadMs` from now, in playfield px: the shared projection of its world position moved along its velocity
   * with gravity (wind and drag are ignored: a lead of 100 ms is off by a few px at most). Without a lead: its interpolated sx, sy.
   */
  function targetPoint(tg, leadMs, worldScale = 1) {
    const tau = Number.isFinite(leadMs) && leadMs > 0 ? leadMs / 1000 : 0;
    if (tau === 0) return { x: tg.sx, y: tg.sy };
    const g = tg.kind === 'rabbit' ? 0 : WORLD.g * worldScale; // the world's gravity is g x k (review G-08)
    const pr = project(tg.x + tg.vx * tau, tg.y + tg.vy * tau - 0.5 * g * tau * tau, tg.z + tg.vz * tau);
    return pr.visible ? { x: pr.sx, y: pr.sy } : { x: tg.sx, y: tg.sy };
  }

  function shootTarget(id, opts = {}) {
    try {
      const g = host.getGame();
      if (!g) throw new Error('shootTarget: no round is running');
      const snap = g.snapshot();
      const tg = snap.targets.find((x) => x.id === id);
      if (!tg) throw new Error(`shootTarget: target ${id} is not airborne`);
      const offsetPx = Number.isFinite(opts.offsetPx) ? opts.offsetPx : 0;
      const p = targetPoint(tg, opts.leadMs ?? 0, snap.worldScale ?? 1);
      return fire({ x: p.x + offsetPx, y: p.y }).then((r) => ({ ...r, hit: r.events.some((e) => e.type === 'hit' && e.id === id) }));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // -------------------------------------------------------------------------------------------------------------- snapshot

  function snapshot() {
    const g = host.getGame();
    const gs = g ? g.snapshot() : null;
    const st = ui.getState();
    const ms = motion.getState();
    const ps = host.getProviderStatus();
    const head = motion.headAt(clock.now());
    return {
      ...(gs ?? EMPTY_GAME),
      screen: st.screen,
      overlay: st.overlay,
      gameActive: st.gameActive,
      aim: { x: head ? head.x : ms.x, y: head ? head.y : ms.y, trackingOk: ms.trackingOk, speedDps: ms.speedDps, pointerModel: ms.pointerModel },
      provider: { kind: ps.kind, state: ps.state, side: ps.side },
      calibrated: ms.calibrated,
      manualClock: !!clock.manual,
      nowMs: clock.now(),
      game: gs,
    };
  }

  // ------------------------------------------------------------------------------------------------------------------ API

  function press(action) {
    if (!ACTIONS.includes(action)) throw new RangeError(`press: unknown action "${action}"`);
    const labels = host.getProvider()?.getActionLabels?.() ?? {};
    ui.notify({ type: 'action', event: { t: clock.now(), action, label: labels[action] ?? action, source: 'debug' } });
  }

  /** One stick flick or arrow key (`phase` 'down' then 'up'): the same NavEvent the stick of a Joy-Con and the arrow keys produce. */
  function nav(dir, phase = 'down') {
    if (!NAV_DIRS.includes(dir)) throw new RangeError(`nav: unknown direction "${dir}"`);
    ui.notify({ type: 'nav', event: { t: clock.now(), dir, phase: phase === 'up' ? 'up' : 'down', source: 'debug' } });
  }

  const api = {
    version: 1,
    ready: null, // set by app.js
    manualClock: !!clock.manual,
    now: () => clock.now(),
    advance(ms) {
      if (!clock.manual) throw new Error('advance() needs ?clock=manual');
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance: ms must be a number >= 0');
      let left = ms;
      while (left > 1e-9) {
        const d = Math.min(SLICE_MS, left);
        clock.advance(d);
        host.runStep();
        left -= d;
      }
    },
    getConfig: () => JSON.parse(JSON.stringify(host.getConfig())),
    getSettings: () => storage.getSettings(),
    setSetting(key, value) {
      if (!Object.hasOwn(storage.getSettings(), key)) throw new RangeError(`setSetting: unknown setting "${key}"`);
      const settings = storage.updateSettings({ [key]: value });
      host.applySettings();
      return settings;
    },
    setSeed(n) {
      if (!Number.isFinite(n)) throw new TypeError('setSeed: a number is required');
      host.setSeed(n >>> 0);
    },
    /**
     * Start a round without the menus. `autoLaunch` (default true): Classic calls every pull by itself as soon as the gun is loaded;
     * false: no automatic launches at all (Classic pulls still work when called, Time Attack and Zen send no waves).
     */
    start(mode, opts = {}) {
      if (!MODES.includes(mode)) throw new RangeError(`start: mode must be one of ${MODES.join(', ')}`);
      if (!host.isReady()) throw new Error('start: call it after `await __clay.ready`');
      host.startRound(mode, {
        difficulty: opts.difficulty,
        stage: opts.stage,
        seed: opts.seed,
        skipCountdown: opts.skipCountdown !== false,
        autoLaunch: opts.autoLaunch !== false,
      });
      return snapshot();
    },
    snapshot,
    pause() {
      if (ui.getState().screen === 'playing') press('pause');
    },
    resume() {
      const st = ui.getState();
      if (st.screen === 'paused' || st.resuming) ui.force('playing');
    },
    aim,
    fire,
    shootTarget,
    /** Classic: call "Pull!" (a shot in phase `ready` calls the pull and uses no shell). Resolves with {events, called}. */
    callPull() {
      const g = host.getGame();
      const phase = g ? g.snapshot().phase : null;
      if (phase !== 'ready') return Promise.resolve({ events: [], called: false });
      return fire().then((r) => ({ ...r, called: true }));
    },
    press,
    nav,
    getMotionState: () => motion.getState(),
    getUiState: () => ui.getState(),
    /** Additive: re-anchor the relative pointer at (x, y) (a test that wants the cursor somewhere with a real Joy-Con model). */
    reanchor(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('reanchor: x and y must be numbers (playfield px)');
      motion.reanchor(x, y);
    },
    getCalibration: () => motion.getCalibration(),
    /** The optional art layer as plain data: enabled (false with ?assets=0), manifest state, groups, generation, and the world's stage status. */
    getAssets() {
      try {
        return JSON.parse(JSON.stringify(host.getAssets ? host.getAssets() : { enabled: false, manifest: 'idle', groups: {}, generation: 0 }));
      } catch {
        return { enabled: false, manifest: 'idle', groups: {}, generation: 0 };
      }
    },
    getPerf() {
      const p = presentation.getPerf();
      return { fps: p.fps > 0 ? p.fps : null, avgFrameMs: p.avgFrameMs > 0 ? p.avgFrameMs : null, inputToDrawMs: host.getInputToDrawMs() };
    },
    debug: {
      /** Launch targets now (game.debugSpawn): {kind, house, speed, azimuthDeg, elevationDeg, pos, vel, still} or an array; returns the ids. */
      spawn(spec) {
        const g = host.getGame();
        if (!g) throw new Error('debug.spawn: no round is running');
        return g.debugSpawn(spec);
      },
      autoLaunch(on) {
        const g = host.getGame();
        if (!g) throw new Error('debug.autoLaunch: no round is running');
        g.debugSetAutoLaunch(!!on);
      },
      forceScreen(screen, opts) {
        ui.force(screen, opts);
      },
      getLog: () => host.getLog(),
      /** The app's counters (queued and dropped shots, frame errors) and the round's internal sizes (leak checks). */
      getCounters: () => host.getCounters(),
      getMotionDebug: () => motion.getDebug?.() ?? null,
      /** Install a Calibration without the wizard (validated by Motion; the same code path as a finished wizard, minus the screens). */
      setCalibration: (cal) => motion.setCalibration(cal),
      getProviderStatus: () => host.getProviderStatus(),
      /** The audio engine state (ready after the first user gesture; voices, counters, errors). */
      getAudio: () => ({ ready: !!presentation.audio.ready, ...(presentation.audio.getDebug ? presentation.audio.getDebug() : {}) }),
      getWakeLock: () => host.getWakeLock(),
      /** Paint the current state now (the browser only paints from requestAnimationFrame, which a hidden tab throttles). */
      draw: () => presentation.draw(),
      /** The world renderer's debug state (particles, stage, layers, shake, zoom, gun, crosshair) as plain data. */
      getWorld: () => {
        try {
          return JSON.parse(JSON.stringify(presentation.debug?.getWorldDebug?.() ?? null));
        } catch {
          return null;
        }
      },
      /** What the UI shows: the connect model, the disconnect panel, hover, focus, hint line and the live targets. A plain JSON copy. */
      getUiView() {
        const v = ui.getView();
        return JSON.parse(JSON.stringify({
          connect: v.connect ?? null,
          disc: v.disc ?? null,
          hover: v.hover?.id ?? null,
          focus: v.focus ? { id: v.focus.id, ids: v.focus.ids, valueRow: v.focus.valueRow } : null,
          hint: v.hint ?? null,
          tune: v.tune ?? null,
          targets: (v.targets ?? []).map((tg) => ({ id: tg.id, enabled: tg.enabled, x: tg.x, y: tg.y, w: tg.w, h: tg.h, r: tg.r })),
        }));
      },
    },
    get sim() {
      const p = host.getProvider();
      if (!p || p.kind !== 'sim') return null;
      return {
        fire: () => p.fire(),
        setTarget: (x, y, o) => p.setTarget(x, y, o),
        setPose: (pose, o) => p.setPose(pose, o),
        clearPose: (o) => p.clearPose(o),
        playCalibrationScript: () => p.playCalibrationScript(),
        simulateLoss: () => p.simulateLoss(),
        simulateRecovery: () => p.simulateRecovery(),
        getTruth: () => p.getTruth(),
      };
    },
  };

  return { api, injectDue, afterStep, aimOverride: () => debugAim };
}
