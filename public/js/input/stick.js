// Analog stick -> menu navigation edges. OWNER: input engineer. Pure functions and one small state machine: no DOM, no clock, no globals.
//
// Why: pointing a sword at menu items and dwelling or cutting made it far too easy to slide from one control onto another and activate it.
// In the menus the stick moves a focus, A confirms, B goes back (docs/contract-notes.md, "Stick navigation"); this module is the stick half.
//
// What the data says (input-config.js `stick`, MEASURED on recordings/imu-2026-09-30T18-42-24.jsonl): a 12-bit field (protocol 6.3), at rest
// 1998 / 2007 on the real Right unit (noise sd 0.6 / 0.5 LSB), so the centre is estimated per session from the first reports while the
// stick is untouched. ASSUMED, UNVERIFIED-ON-HARDWARE: the half travel, the direction convention, the Left unit.
//
// Behaviour (one flick = one move):
//   - normalised = (raw - centre) / halfRange per axis, clamped to -1..1, y positive = up;
//   - below `deadZone` the stick is centred; a flick FIRES when the magnitude first reaches `moveThreshold`, in the dominant axis direction;
//   - after a flick nothing fires again until the magnitude has fallen below `rearm` (hysteresis): a long push never skips several items, and
//     sliding the stick round from one direction to another without letting go is still one move;
//   - the 'up' phase of the fired direction is reported when the stick returns below `rearm`, or when the dominant direction changes while
//     it is still held (the UI stops its auto-repeat then).

import { INPUT_CONFIG } from './input-config.js';

const EMPTY = Object.freeze([]);
/** The unused stick field of a Joy-Con 2 reads exactly this in every report of the real recording (4754 of 4754). */
const SENTINEL = 2047;

const clamp1 = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);

/**
 * Normalise one raw 12-bit stick field.
 * @param {{x:number,y:number}} field
 * @param {{x:number,y:number}} centre
 * @param {{halfRange:number, yUp?:number}} cfg
 * @returns {{x:number, y:number, mag:number}} x and y in -1..1 (y positive = up), mag = Euclidean length (clamped to the unit square, so up to 1.414)
 */
export function normalizeStick(field, centre, cfg = INPUT_CONFIG.stick) {
  const x = clamp1((field.x - centre.x) / cfg.halfRange);
  const y = clamp1(((field.y - centre.y) / cfg.halfRange) * (cfg.yUp ?? 1));
  return { x, y, mag: Math.hypot(x, y) };
}

/** Dominant direction of a normalised position ('right' on an exact tie between the axes), or null for (0, 0). */
export function dominantDir(x, y) {
  if (x === 0 && y === 0) return null;
  if (Math.abs(x) >= Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'up' : 'down';
}

/**
 * @param {object} [opts]
 * @param {object} [opts.config]  an INPUT_CONFIG.stick block
 * @param {'L'|'R'|'?'} [opts.side]
 */
export function createStickTracker(opts = {}) {
  const cfg = opts.config ?? INPUT_CONFIG.stick;
  const cc = cfg.centre;
  let side = opts.side ?? '?';

  let centre = { x: cfg.nominalCentre, y: cfg.nominalCentre };
  let centred = false; // true once a centre was estimated from untouched reports
  const ring = new Array(cc.window);
  let ringN = 0;
  let ringHead = 0;
  let rightSeen = false; // side '?': the right field has moved off the sentinel at least once, so this is a Right unit

  let armed = true;
  let held = null; // the direction that fired and is still held
  let last = null;

  function tryEstimate() {
    if (ringN < cc.window) return;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let sx = 0; let sy = 0;
    for (let i = 0; i < cc.window; i++) {
      const s = ring[i];
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
      sx += s.x;
      sy += s.y;
    }
    if (maxX - minX > cc.maxSpread || maxY - minY > cc.maxSpread) return; // being touched
    const mx = sx / cc.window;
    const my = sy / cc.window;
    if (Math.abs(mx - cfg.nominalCentre) > cc.maxOffset || Math.abs(my - cfg.nominalCentre) > cc.maxOffset) return; // held to one side
    centre = { x: mx, y: my };
    centred = true;
  }

  function pickField(fields) {
    if (side === 'R') return fields.right;
    if (side === 'L') return fields.left;
    if (fields.right.x !== SENTINEL || fields.right.y !== SENTINEL) rightSeen = true;
    return rightSeen ? fields.right : fields.left;
  }

  return {
    /**
     * Feed the `stickFields` of one parsed report.
     * @param {{left:{x:number,y:number}, right:{x:number,y:number}}} fields
     * @returns {{state:object, events:ReadonlyArray<{phase:'down'|'up', dir:string}>}}
     */
    push(fields) {
      const raw = pickField(fields);
      if (!centred) {
        const slot = ring[ringHead] ?? (ring[ringHead] = { x: 0, y: 0 });
        slot.x = raw.x;
        slot.y = raw.y;
        ringHead = (ringHead + 1) % cc.window;
        if (ringN < cc.window) ringN++;
        tryEstimate();
      }
      const n = normalizeStick(raw, centre, cfg);
      const events = [];
      if (n.mag < cfg.rearm) {
        if (held) events.push({ phase: 'up', dir: held });
        held = null;
        armed = true;
      } else if (armed) {
        if (n.mag >= cfg.moveThreshold) {
          held = dominantDir(n.x, n.y);
          armed = false;
          events.push({ phase: 'down', dir: held });
        }
      } else if (held && n.mag >= cfg.moveThreshold && dominantDir(n.x, n.y) !== held) {
        events.push({ phase: 'up', dir: held }); // turned to another direction without letting go: the repeat stops, no new move
        held = null;
      }
      last = {
        raw: { x: raw.x, y: raw.y },
        centre: { x: centre.x, y: centre.y },
        centred,
        nx: n.x,
        ny: n.y,
        mag: n.mag,
        deadZone: n.mag < cfg.deadZone,
        armed,
        held,
        dominant: n.mag >= cfg.deadZone ? dominantDir(n.x, n.y) : null,
        side,
      };
      return { state: last, events: events.length ? events : EMPTY };
    },
    getState: () => last,
    setSide(next) {
      if (next !== side) {
        side = next;
        this.reset();
      }
    },
    /** New link: forget the centre and the flick state (a different unit may be a different stick). */
    reset() {
      centre = { x: cfg.nominalCentre, y: cfg.nominalCentre };
      centred = false;
      ringN = 0;
      ringHead = 0;
      rightSeen = false;
      armed = true;
      held = null;
      last = null;
    },
  };
}
