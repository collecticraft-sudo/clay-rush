// Synthetic shooting recordings in the format of tools/record-imu.mjs, for tools/analyze-shots.mjs. OWNER: motion engineer.
//
// Every report is a byte-exact 63-byte Joy-Con 2 packet from the real builder (input/joycon2-build.js), one JSON line {t, ht, step, hex}
// per report like the recorder writes, plus the meta and step lines. The hand is a MODEL, not a measurement: a pistol grip (device +y
// towards the screen, +z up) held still with gyro noise and a slow wander below the 5 deg/s dead zone, the bias of the real unit
// (raw 0, -5, +12), 33 Hz reports (30 ms, every eighth 31.25 ms, as measured), and after each trigger press an optional "trigger jerk":
// a half-sine pulse of tip-down rotation that starts `leadMs` before the first report showing the button down. Real trigger jerks are
// UNVERIFIED-ON-HARDWARE: this only gives the analysis a known answer.
import { buildInputReport } from '../../public/js/input/joycon2-build.js';
import { bytesToHex, GYRO_DPS_PER_LSB, ACCEL_G_PER_LSB } from '../../public/js/input/joycon2-parse.js';
import { createRng } from '../../public/js/shared/rng.js';

const BIAS_RAW = Object.freeze({ x: 0, y: -5, z: 12 });

function gauss(rng) {
  return Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
}

/**
 * @param {object} [o]
 * @param {Array<{name:string, seconds:number, presses?:number[], still?:boolean}>} [o.steps]  presses: press times in seconds from the step start
 * @param {{dps:number, durMs:number, leadMs:number, yawShare?:number}|null} [o.jerk]  the trigger jerk after every press (null: none)
 * @param {string} [o.button]   the trigger button written into the reports ('ZR')
 * @param {number} [o.holdMs]   how long the button stays down
 * @param {number} [o.seed]
 * @param {number} [o.noiseDps] white gyro noise per axis (sigma)
 * @param {number} [o.wanderDps] amplitude of the slow wander (stays below the dead zone)
 * @param {'R'|'L'|'any'} [o.side]
 * @returns {object[]} the JSON lines
 */
export function makeShotRecording(o = {}) {
  const steps = o.steps ?? [
    { name: 'rest_table', seconds: 6, still: true },
    { name: 'trigger_still', seconds: 20, presses: [2, 4, 6, 8, 10, 12, 14, 16, 18] },
  ];
  const jerk = o.jerk === undefined ? { dps: 80, durMs: 120, leadMs: 40, yawShare: 0.25 } : o.jerk;
  const button = o.button ?? 'ZR';
  const holdMs = o.holdMs ?? 100;
  const rng = createRng(o.seed ?? 7);
  const noise = o.noiseDps ?? 0.25;
  const wander = o.wanderDps ?? 1.5;
  const rows = [{ type: 'meta', stamp: 'synthetic', port: 0, side: o.side ?? 'R', steps: steps.map((s) => ({ name: s.name, seconds: s.seconds })) }];
  let wall = 1_790_000_000_000;
  let ht = 2_000_000;
  let us = 3_000_000;
  let counter = 3500;
  let k = 0;
  for (const step of steps) {
    const start = wall;
    let pitchDeg = 0; // integrated tip elevation, for a consistent accelerometer
    const presses = (step.presses ?? []).map((s) => s * 1000);
    let tMs = 0;
    let n = 0;
    while (tMs < step.seconds * 1000) {
      // the rate at this report: rest on the table, or the hand (noise + slow wander) plus the jerk pulses
      let gx = 0;
      let gz = 0;
      if (!step.still) {
        gx = wander * Math.sin((2 * Math.PI * tMs) / 3100) + noise * gauss(rng);
        gz = wander * Math.cos((2 * Math.PI * tMs) / 4300) + noise * gauss(rng);
        if (jerk) {
          for (const p of presses) {
            const u = (tMs - (p - jerk.leadMs)) / jerk.durMs;
            if (u > 0 && u < 1) {
              const w = jerk.dps * Math.sin(Math.PI * u);
              gx -= w; // the tip dips (rotation about +x is tip up)
              gz += (jerk.yawShare ?? 0) * w;
            }
          }
        }
      }
      const gy = step.still ? 0 : noise * gauss(rng);
      const dtMs = n === 0 ? 0 : (k % 8 === 7 ? 31.25 : 30);
      pitchDeg += (gx * dtMs) / 1000;
      const p = (pitchDeg * Math.PI) / 180;
      const accel = { x: 0, y: Math.sin(p), z: Math.cos(p) };
      const down = presses.some((t0) => tMs >= t0 && tMs < t0 + holdMs);
      const bytes = buildInputReport({
        counter: counter >>> 0,
        imuTimestampUs: us >>> 0,
        pressed: down ? [button] : [],
        accelRaw: { x: Math.round(accel.x / ACCEL_G_PER_LSB), y: Math.round(accel.y / ACCEL_G_PER_LSB), z: Math.round(accel.z / ACCEL_G_PER_LSB) },
        gyroRaw: { x: Math.round(gx / GYRO_DPS_PER_LSB) + BIAS_RAW.x, y: Math.round(gy / GYRO_DPS_PER_LSB) + BIAS_RAW.y, z: Math.round(gz / GYRO_DPS_PER_LSB) + BIAS_RAW.z },
        batteryMv: 3700,
      });
      rows.push({ t: Math.round(wall), ht: Number(ht.toFixed(3)), step: step.name, hex: bytesToHex(bytes) });
      // next report
      const next = k % 8 === 6 ? 31.25 : 30;
      tMs += next;
      us += Math.round(next * 1000);
      counter += Math.round(next);
      wall += next;
      ht += next + (rng.next() - 0.5) * 2; // +-1 ms of delivery jitter
      k += 1;
      n += 1;
    }
    rows.push({ type: 'step', name: step.name, startMs: Math.round(start), endMs: Math.round(wall), packets: n });
    // the countdown between steps is not recorded (like the real recorder)
    wall += 4000;
    ht += 4000;
    us += 4_000_000;
    counter += 4000;
  }
  return rows;
}
