// Virtual sword physics of the simulator provider. OWNER: input engineer.
//
// A rigid sword with orientation Q (its right / forward / up axes in world coordinates) that follows a target
// orientation (the virtual mouse, or an explicit pose) through a critically damped follower, and reports what a
// Joy-Con strapped to it would measure (docs/architecture.md 5.8). This models the protocol document, NOT the device:
// mount frames, gyro sign, noise levels and the lever arm are assumptions (UNVERIFIED-ON-HARDWARE).
//
// Frames (architecture 3.3): device D = raw Joy-Con axes; world W: x right, y towards the screen, z up; sword S:
// right x forward = up. The mount frame F = [right forward up] (columns, in device coordinates) maps sword coordinates to
// device coordinates: v_D = F * v_S. So
//     accel_D = F * ( Q^T * (0,0,1) + linearAcceleration / g )      (at rest it equals frame.up: +1 g towards world UP)
//     gyro_D  = F * omega_S   (times -1 when the gyro sign is mirrored)
// with omega_S the angular velocity in sword coordinates. The physics runs in fixed sub-steps on its own timeline;
// commands (mouse targets, poses) carry the time at which they take effect, which makes the result a pure function of
// (commands, seed) regardless of how often the caller ticks.

import { INPUT_CONFIG } from './input-config.js';
import {
  DEG, add3, cross3, dot3, scale3, qMul, qConj, qExp, qLog, qNormalize, qSlerp, qToColumns, orientationFromAim, aimFromOrientation,
  orthonormalFrame, toVec,
} from './sim-math.js';

const G = 9.80665; // m/s^2
const MAX_PENDING = 2048; // queued commands before the oldest plain mouse targets are dropped

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const v = (x, y, z) => ({ x, y, z });

/** The normative mount presets of docs/architecture.md 5.8. Each row is (right, forward, up) in DEVICE coordinates. */
export const SIM_MOUNTS = deepFreeze({
  faceUp: { right: v(1, 0, 0), forward: v(0, 1, 0), up: v(0, 0, 1) },
  faceSide: { right: v(0, 0, -1), forward: v(0, 1, 0), up: v(1, 0, 0) },
  upsideDown: { right: v(-1, 0, 0), forward: v(0, 1, 0), up: v(0, 0, -1) },
  tipFlipped: { right: v(-1, 0, 0), forward: v(0, -1, 0), up: v(0, 0, 1) },
  tilted: { right: v(1, 0, 0), forward: v(0, 0.866025, 0.5), up: v(0, -0.5, 0.866025) },
  sideRail: { right: v(0, -1, 0), forward: v(1, 0, 0), up: v(0, 0, 1) },
});

/** Preset name or `{frame:{right,forward,up}}` (or a bare frame) -> frame with Vec3 objects. */
export function resolveMount(mount) {
  if (mount === undefined || mount === null) return SIM_MOUNTS.faceUp;
  if (typeof mount === 'string') {
    const preset = SIM_MOUNTS[mount];
    if (!preset) throw new RangeError(`unknown simulator mount "${mount}" (known: ${Object.keys(SIM_MOUNTS).join(', ')})`);
    return preset;
  }
  const frame = mount.frame ?? mount;
  for (const key of ['right', 'forward', 'up']) {
    const a = frame?.[key];
    if (!a || ![a.x, a.y, a.z].every(Number.isFinite)) throw new TypeError(`simulator mount frame needs {${key}:{x,y,z}}`);
  }
  return frame;
}

/** Named poses (architecture 5.8). `flat` and `pointScreen` are the same orientation: the sword horizontal, aimed at the screen. */
export function poseToOrientation(pose) {
  if (pose === 'tipUp') return orientationFromAim(0, 90, 0);
  if (pose === 'pointScreen' || pose === 'flat') return orientationFromAim(0, 0, 0);
  if (pose && typeof pose === 'object' && Number.isFinite(pose.yawDeg) && Number.isFinite(pose.pitchDeg)) {
    return orientationFromAim(pose.yawDeg, pose.pitchDeg, pose.rollDeg ?? 0);
  }
  throw new RangeError(`unknown simulator pose ${JSON.stringify(pose)}`);
}

/**
 * @param {object} [o]
 * @param {string|object} [o.mount]
 * @param {boolean} [o.mirrorGyro]
 * @param {number} [o.leverM]
 * @param {number} [o.followTauMs]
 * @param {number} [o.startMs]       initial model time
 * @param {object} [o.config]
 */
export function createSimModel(o = {}) {
  const cfg = (o.config ?? INPUT_CONFIG).sim;
  const F = orthonormalFrame(resolveMount(o.mount));
  const mirror = !!o.mirrorGyro;
  const leverM = o.leverM ?? cfg.leverM;
  const omegaN = 1000 / (o.followTauMs ?? cfg.followTauMs); // natural frequency of the follower, rad/s
  const stepMs = cfg.stepMs;

  let time = o.startMs ?? 0;
  let q = orientationFromAim(0, 0, 0);
  let w = [0, 0, 0]; // angular velocity, world frame, rad/s
  let wLp = [0, 0, 0]; // low-passed copy, source of the angular acceleration in the lever arm
  let alpha = [0, 0, 0]; // rad/s^2, world frame
  let goal = { from: q, to: q, start: time, dur: 0 };
  let mouseQ = q;
  let poseLocked = false;
  /** @type {Array<{s:number, type:'mouse'|'pose'|'clear', q?:number[], ms?:number, teleport?:boolean}>} sorted by s, stable */
  const commands = [];

  const smooth = (u) => u * u * (3 - 2 * u);
  function goalAt(t) {
    if (goal.dur <= 0) return goal.to;
    const u = Math.min(1, Math.max(0, (t - goal.start) / goal.dur));
    return u >= 1 ? goal.to : qSlerp(goal.from, goal.to, smooth(u));
  }

  function startGoal(qTo, durMs, teleport) {
    if (teleport) {
      // Re-anchor without angular velocity (architecture 5.8): the orientation jumps, the gyro sees nothing.
      q = qTo;
      w = [0, 0, 0];
      wLp = [0, 0, 0];
      alpha = [0, 0, 0];
      goal = { from: qTo, to: qTo, start: time, dur: 0 };
      return;
    }
    goal = { from: goalAt(time), to: qTo, start: time, dur: Math.max(0, durMs ?? 0) };
  }

  function apply(cmd) {
    if (cmd.type === 'mouse') {
      mouseQ = cmd.q;
      if (!poseLocked) startGoal(mouseQ, cmd.ms, cmd.teleport);
    } else if (cmd.type === 'pose') {
      poseLocked = true;
      startGoal(cmd.q, cmd.ms, cmd.teleport);
    } else {
      poseLocked = false;
      startGoal(mouseQ, cmd.ms, cmd.teleport);
    }
  }

  function enqueue(cmd) {
    if (commands.length >= MAX_PENDING) {
      // nobody is ticking (or a pointer floods us): drop the oldest plain mouse target, the newer ones supersede it
      const drop = commands.findIndex((c) => c.type === 'mouse' && !c.teleport);
      if (drop >= 0) commands.splice(drop, 1);
    }
    let i = commands.length;
    while (i > 0 && commands[i - 1].s > cmd.s) i--;
    commands.splice(i, 0, cmd);
  }

  function step(dtMs) {
    const dt = dtMs / 1000;
    const qt = goalAt(time + dtMs);
    const err = qLog(qMul(qt, qConj(q))); // world-frame rotation that takes q to the target
    const k1 = omegaN * omegaN;
    const k2 = 2 * omegaN;
    // semi-implicit Euler on the critically damped follower: stable for omega * dt << 2
    w = [w[0] + (k1 * err[0] - k2 * w[0]) * dt, w[1] + (k1 * err[1] - k2 * w[1]) * dt, w[2] + (k1 * err[2] - k2 * w[2]) * dt];
    q = qNormalize(qMul(qExp([w[0] * dt, w[1] * dt, w[2] * dt]), q));
    const k = 1 - Math.exp(-dtMs / cfg.alphaSmoothMs);
    const next = [wLp[0] + (w[0] - wLp[0]) * k, wLp[1] + (w[1] - wLp[1]) * k, wLp[2] + (w[2] - wLp[2]) * k];
    alpha = [(next[0] - wLp[0]) / dt, (next[1] - wLp[1]) / dt, (next[2] - wLp[2]) / dt];
    wLp = next;
    time += dtMs;
  }

  function advanceTo(tMs) {
    while (time < tMs - 1e-9) {
      while (commands.length && commands[0].s <= time + 1e-9) apply(commands.shift());
      step(Math.min(stepMs, tMs - time));
    }
  }

  const mouseOrientation = (x, y) => orientationFromAim((x - 960) / cfg.pxPerDeg, (540 - y) / cfg.pxPerDeg, 0);

  return {
    /** Mount frame, exactly orthonormal, as Vec3 objects. */
    frame: { right: toVec(F.right), forward: toVec(F.forward), up: toVec(F.up) },
    get time() {
      return time;
    },

    /** Virtual mouse target (playfield px) taking effect at model time `s`. */
    setMouse(s, x, y, opts = {}) {
      enqueue({ s, type: 'mouse', q: mouseOrientation(x, y), ms: opts.glideMs ?? 0, teleport: !!opts.teleport });
    },
    /** Explicit pose (named or angles) taking effect at model time `s`; overrides the mouse until clearPose. */
    setPose(s, pose, opts = {}) {
      enqueue({ s, type: 'pose', q: poseToOrientation(pose), ms: opts.transitionMs ?? 0, teleport: !!opts.teleport });
    },
    clearPose(s, opts = {}) {
      enqueue({ s, type: 'clear', ms: opts.transitionMs ?? 0, teleport: !!opts.teleport });
    },
    /** Drop commands that have not taken effect yet (used by disconnect). */
    clearPending() {
      commands.length = 0;
    },
    advanceTo,

    /**
     * Jump to model time `tMs` without simulating the gap: commands that are due take effect, the sword is assumed to
     * have converged on its goal and stands still. Used at connect, after a simulated loss and after a long stall.
     */
    skipTo(tMs) {
      if (tMs <= time) return;
      time = tMs;
      while (commands.length && commands[0].s <= time + 1e-9) apply(commands.shift());
      q = goalAt(time);
      w = [0, 0, 0];
      wLp = [0, 0, 0];
      alpha = [0, 0, 0];
    },

    /**
     * What the sensor measures at model time `tMs` (advances the physics first). No noise, no bias, no quantisation.
     * @returns {{accelG:{x,y,z}, gyroDps:{x,y,z}}} in device coordinates
     */
    sampleAt(tMs) {
      advanceTo(tMs);
      const cols = qToColumns(q); // sword axes in world coordinates
      const toSword = (a) => [dot3(cols[0], a), dot3(cols[1], a), dot3(cols[2], a)];
      const wS = toSword(w);
      const gS = toSword([0, 0, 1]);
      const alphaS = toSword(alpha);
      const r = [0, leverM, 0]; // the sensor sits along the blade axis
      const lin = add3(cross3(alphaS, r), cross3(wS, cross3(wS, r))); // m/s^2, rigid body about the pivot
      const specific = add3(gS, scale3(lin, 1 / G));
      const toDevice = (a) => add3(add3(scale3(F.right, a[0]), scale3(F.forward, a[1])), scale3(F.up, a[2]));
      const gyro = scale3(toDevice(wS), (mirror ? -1 : 1) / DEG);
      return { accelG: toVec(toDevice(specific)), gyroDps: toVec(gyro) };
    },

    /** Current aim of the virtual sword (forward axis) in degrees, and its angular speed in deg/s. */
    getAim() {
      return { ...aimFromOrientation(q), speedDps: Math.hypot(w[0], w[1], w[2]) / DEG };
    },
    getOrientation: () => q.slice(),
    getAngularVelocityWorld: () => toVec(w),
    isPoseLocked: () => poseLocked,
    pendingCommands: () => commands.length,
  };
}
