// Test helpers for the Game module (Gameplay engineer). No DOM, no wall clock: a harness owns a manual `now` (ms).
import { createHash } from 'node:crypto';
import { createGame, CONFIG } from '../../public/js/game/index.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { WORLD, project } from '../../public/js/shared/world.js';
import { FIELD } from '../../public/js/shared/playfield.js';
import { createRng } from '../../public/js/shared/rng.js';

export const DT = CONFIG.time.dt;
export const FRAME_S = 1 / 60;

/** A Shot (contracts.js) at playfield (x, y) pressed at clock time t (ms). */
export function shotAt(x, y, t, source = 'sim') {
  return { t, x, y, source, compMs: 0 };
}

/**
 * Harness: a game plus a manual clock and an event collector.
 *   h.step(dtS, shots)   shots = array, or (nowBeforeTheFrame) => array; the press times should lie in the frame
 *   h.run(seconds, {frameS, shots})
 */
export function createHarness(mode = 'classic', seed = 1, opts = {}, { validate = false } = {}) {
  const game = createGame(mode, seed, opts);
  const h = {
    game,
    now: 0,
    events: [],
    validate,
    snap: () => game.snapshot(),
    step(dtS = FRAME_S, shots = []) {
      const list = typeof shots === 'function' ? shots(h.now) : shots;
      h.now += dtS * 1000;
      game.update(dtS, list, h.now);
      const ev = game.drainEvents();
      for (const e of ev) h.events.push(e);
      if (h.validate) {
        assertValid('GameSnapshot', game.snapshot());
        for (const e of ev) assertValid('GameEvent', e);
      }
      return ev;
    },
    run(seconds, { frameS = FRAME_S, shots = [] } = {}) {
      const frames = Math.round(seconds / frameS);
      for (let i = 0; i < frames && !game.isOver(); i++) h.step(frameS, shots);
    },
    /** Step until pred(snapshot) is true (or maxS elapsed). Returns true when it became true. */
    until(pred, maxS = 10, { frameS = FRAME_S, shots = [] } = {}) {
      const frames = Math.round(maxS / frameS);
      for (let i = 0; i < frames; i++) {
        if (pred(game.snapshot())) return true;
        if (game.isOver()) return pred(game.snapshot());
        h.step(frameS, shots);
      }
      return pred(game.snapshot());
    },
    ofType: (type) => h.events.filter((e) => e.type === type),
    clearEvents: () => { h.events.length = 0; },
    target: (id) => game.snapshot().targets.find((o) => o.id === id) ?? null,
  };
  return h;
}

/**
 * Second-order prediction of a snapshot target `dtw` world seconds ahead (gravity and drag of a world of scale `scale`,
 * snapshot.worldScale), in world metres.
 */
export function predict(t, dtw, scale = 1) {
  const sp = Math.hypot(t.vx, t.vy, t.vz);
  const k = CONFIG.physics.drag / scale;
  const ax = -k * sp * t.vx;
  const ay = t.kind === 'rabbit' ? 0 : -WORLD.g * scale - k * sp * t.vy;
  const az = -k * sp * t.vz;
  const h = 0.5 * dtw * dtw;
  return { x: t.x + t.vx * dtw + ax * h, y: t.y + t.vy * dtw + ay * h, z: t.z + t.vz * dtw + az * h };
}

/** Screen point of a snapshot target at the snapshot instant (+ leadS world seconds), as the hit test will see it. */
export function aimPoint(snap, t, leadS = 0) {
  const p = predict(t, snap.alpha * DT + leadS, snap.worldScale ?? 1);
  const pr = project(p.x, p.y, p.z);
  return { x: pr.sx, y: pr.sy, z: p.z, visible: pr.visible };
}

/**
 * A scripted bot that aims at projected targets (the game's own projection): calls each Classic pull, then fires one shell
 * at each target once it has flown `minAgeS`, leading by the pellet travel time on Hard. `missEvery` > 0 aims far off
 * on every n-th shot (to exercise misses); `accuracy` < 1 misses each shot with probability 1 - accuracy (seeded by `botSeed`).
 */
export function createAimBot(game, { minAgeS = 0.25, hard = false, missEvery = 0, retryS = 0.3, offsetPx = 0, accuracy = 1, botSeed = 1 } = {}) {
  const fired = new Map(); // id -> last press time
  const rng = createRng(botSeed);
  let count = 0;
  return (now) => {
    const s = game.snapshot();
    if (s.phase === 'ready') return [shotAt(FIELD.cx, FIELD.cy, now)];
    if (s.phase !== 'flight') return [];
    if (!s.shells.infinite && (s.shells.loaded <= 0 || s.shells.reloadingS > 0)) return [];
    const list = s.targets.slice().sort((a, b) => b.ageS - a.ageS);
    for (const t of list) {
      if (t.ageS < minAgeS) continue;
      const last = fired.get(t.id);
      if (last !== undefined && now - last < retryS * 1000) continue;
      const lead = hard ? t.z / CONFIG.shot.pelletSpeed : 0;
      const p = aimPoint(s, t, lead);
      if (!p.visible || p.x < 0 || p.x > FIELD.w || p.y < 0 || p.y > FIELD.h) continue;
      fired.set(t.id, now);
      count += 1;
      const miss = (missEvery > 0 && count % missEvery === 0) || (accuracy < 1 && rng.next() >= accuracy);
      if (miss) return [shotAt(p.x > FIELD.cx ? 40 : FIELD.w - 40, 40, now)];
      return [shotAt(p.x + offsetPx, p.y, now)];
    }
    return [];
  };
}

/** Stable digest of any JSON value. */
export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Run a whole round with a bot; returns the harness. */
export function playRound(mode, seed, opts = {}, { bot = {}, maxS = 400, validate = false, frameS = FRAME_S } = {}) {
  const h = createHarness(mode, seed, opts, { validate });
  const shots = createAimBot(h.game, bot);
  h.run(maxS, { frameS, shots });
  return h;
}
