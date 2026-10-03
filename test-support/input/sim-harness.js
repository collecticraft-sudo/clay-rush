// Harness for the simulator tests. Test helper of the input engineer. The simulator models docs/joycon2-protocol.md and
// the assumptions of docs/architecture.md 5.8, not the physical Joy-Con (UNVERIFIED-ON-HARDWARE).

import { createManualClock } from '../../public/js/shared/clock.js';
import { createInputProvider, SIM_MOUNTS } from '../../public/js/input/index.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { FakeTarget } from './fake-dom.js';

export const MOUNT_NAMES = Object.keys(SIM_MOUNTS);
export const DEG = Math.PI / 180;

export const vec = (v) => [v.x, v.y, v.z];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const angleDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (norm(a) * norm(b))))) / DEG;

/**
 * @param {object} [o]  sim options (hz, mount, side, mirrorGyro, gyroScaleTrue, noise, jitter, bursts, seed, leverM, startTimestampUs)
 */
export function makeSim(o = {}, providerOpts = {}) {
  const clock = createManualClock(0);
  const target = new FakeTarget();
  const sim = createInputProvider('sim', { clock, target, sim: o, strictTransitions: true, ...providerOpts });
  const samples = [];
  const packets = [];
  const statuses = [];
  sim.on('sample', (s) => {
    assertValid('ImuSample', s);
    samples.push(s);
  });
  sim.on('packet', (p) => packets.push(p));
  sim.on('status', (s) => {
    assertValid('InputStatus', s);
    statuses.push(s);
  });
  const h = {
    clock, target, sim, samples, packets, statuses,
    /** advance the manual clock in steps, calling onStep(now) before each tick */
    run(ms, { stepMs = 4, onStep } = {}) {
      const end = clock.now() + ms;
      while (clock.now() < end - 1e-9) {
        clock.advance(Math.min(stepMs, end - clock.now()));
        if (onStep) onStep(clock.now());
        sim.tick(clock.now());
      }
    },
    /** samples whose device time lies in [from, to) ms of the clock */
    between: (from, to) => samples.filter((s) => s.t >= from && s.t < to),
    mean(list, pick) {
      const acc = [0, 0, 0];
      for (const s of list) {
        const v = pick(s);
        acc[0] += v[0];
        acc[1] += v[1];
        acc[2] += v[2];
      }
      return acc.map((x) => x / list.length);
    },
  };
  return h;
}

/** Sample accel / gyro as arrays. */
export const accelOf = (s) => vec(s.accel);
export const gyroOf = (s) => vec(s.gyro);
