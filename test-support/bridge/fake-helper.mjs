#!/usr/bin/env node
// A FAKE joycon-bridge for the tests (test/bridge). It speaks exactly the JSON-lines protocol of bridge/joycon-bridge.m
// (docs/native-bridge.md) and never touches Bluetooth: it models the protocol document, not the device (UNVERIFIED-ON-HARDWARE).
//
// On `connect` it replays the two REAL Right Joy-Con 2 captures of docs/joycon2-test-vectors.json (REAL_R_1: IMU bytes still zero,
// REAL_R_2: IMU active) and then synthetic motion at a fixed rate until `disconnect`. The scenario comes from the environment, so one
// server can be tested against a healthy helper, a denied permission, a crash, and so on:
//
//   FAKE_HELPER_SCENARIO  happy (default) | permission | bluetooth_off | no_device | connect_failed | lost | crash1 | crash134 |
//                         abort | nohello | badversion | stubborn | noisy | silent | badlength
//   FAKE_HELPER_LOG       file that receives one JSON line per command received, plus {"event":"start","pid":N} and {"event":"exit"}
//   FAKE_HELPER_STEP_MS   delay between the connection stages (default 5)
//   FAKE_HELPER_REPORT_MS interval between reports (default 15)
//   FAKE_HELPER_REPORTS   reports before `lost` ends the session (default 40)
//   FAKE_HELPER_WAIT_MS   time from the accepted command to the second `scanning` status (the scan really starts), default = step
//   FAKE_HELPER_SCAN_MS   time the scan runs before the advert is "seen" (the player's SYNC press), default = step
//   FAKE_HELPER_HELLO_MS  delay of the hello line (the game shows "Starting the Bluetooth bridge" while it waits), default 0
//   FAKE_HELPER_STREAM_MS delay between the helper's `streaming` status and its first report ("Waiting for the first motion data"), default = one report interval
//   FAKE_HELPER_MOTION    sine (default: the old synthetic wave) | model (a virtual sword, see below)
//   FAKE_HELPER_POSE      with MOTION=model: the initial pose, tipUp (default) | pointScreen | flat
//   FAKE_HELPER_CONTROL   path of a JSON file the e2e tests write while the helper runs (see "control file")
//   FAKE_HELPER_REPLAY_FILE  the recording the `replay` command plays (default test-support/motion/fixtures/imu-2026-09-30T18-42-24.jsonl: the first REAL
//                         Joy-Con 2 recording, one JSON line per report {t, ht, step, hex})
//
// Control file (polled about every 15 ms, only commands with a `seq` above the last one applied are executed). It is how a test plays the
// part of the person holding the sword, and how it breaks things on purpose:
//   { "seq": 3, "scenario": "no_device" }                        the scenario of the NEXT connect command (overrides the environment)
//   { "seq": 4, "commands": [ ... ] } with commands
//     {"pose":"tipUp"|"pointScreen"|"flat", "transitionMs":1200}  a named pose, reached smoothly (MOTION=model)
//     {"moveTo":{"x":960,"y":540,"ms":600}}                       the sword aims at that screen point, gliding for `ms` (a swing is a short one)
//     {"clearPose":true}                                          back to aiming with moveTo
//     {"replay":{"windows":[{"step":"yaw_sweep","fromS":1,"toS":11}], "gapMs":600}}
//                                                                 play windows of the REAL recording, byte for byte, in real time at their recorded
//                                                                 device timestamps (33 Hz, real jitter, the lost packet): the model sword stays silent
//                                                                 until the last window has played; the log gets {"event":"replay","phase":"start"|"done"}
//     {"button":"A","ms":120}                                     press a button for a moment
//     {"stick":{"x":2900,"y":2007,"ms":200}}                      hold the RIGHT stick at that raw 12-bit position for `ms`, then let it go back to its
//                                                                 rest (1998, 2007: the centre MEASURED on the real recording, not the nominal 2047)
//     {"crash":1} or {"crash":134}                                the helper dies with that exit code (a crash mid-game)
//     {"drop":true}                                               the link drops: status error lost_signal
// The model is the simulator's virtual sword (public/js/input/sim-model.js) with a constant gyro bias and a little noise, turned into
// byte-exact reports by the real packet builder: it models the protocol document, not the device (UNVERIFIED-ON-HARDWARE).

import { appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputReport } from '../../public/js/input/joycon2-build.js';
import { bytesToHex, hexToBytes, parseInputReport, imuDeltaUs, ACCEL_G_PER_LSB } from '../../public/js/input/joycon2-parse.js';
import { createSimModel } from '../../public/js/input/sim-model.js';
import { createRng } from '../../public/js/shared/rng.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VECTORS = JSON.parse(readFileSync(join(ROOT, 'docs', 'joycon2-test-vectors.json'), 'utf8')).vectors;
const hexOf = (id) => VECTORS.find((v) => v.id === id).hex;

let scenario = process.env.FAKE_HELPER_SCENARIO ?? 'happy';
const logFile = process.env.FAKE_HELPER_LOG ?? '';
const stepMs = Number(process.env.FAKE_HELPER_STEP_MS ?? 5);
const reportMs = Number(process.env.FAKE_HELPER_REPORT_MS ?? 15);
const lostAfter = Number(process.env.FAKE_HELPER_REPORTS ?? 40);
const helloMs = Number(process.env.FAKE_HELPER_HELLO_MS ?? 0);
const streamMs = Number(process.env.FAKE_HELPER_STREAM_MS ?? reportMs);
const waitMs = Number(process.env.FAKE_HELPER_WAIT_MS ?? stepMs);
const scanMs = Number(process.env.FAKE_HELPER_SCAN_MS ?? stepMs);
const motion = process.env.FAKE_HELPER_MOTION === 'model' ? 'model' : 'sine';
const initialPose = process.env.FAKE_HELPER_POSE ?? 'tipUp';
const controlFile = process.env.FAKE_HELPER_CONTROL ?? '';
const replayFile = process.env.FAKE_HELPER_REPLAY_FILE ?? join(ROOT, 'test-support', 'motion', 'fixtures', 'imu-2026-09-30T18-42-24.jsonl');

// the right stick: at rest it reads what the real Right unit read in the recording (docs/contract-notes.md, "Stick navigation"); a control-file command moves it
const STICK_REST = Object.freeze({ x: 1998, y: 2007 });
let stickField = STICK_REST;
let stickUntil = 0;
const currentStick = () => {
  if (stickField !== STICK_REST && Date.now() > stickUntil) stickField = STICK_REST;
  return stickField;
};

const record = (obj) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(obj)}\n`);
};
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const raw = (line) => process.stdout.write(`${line}\n`);
const uptimeMs = () => process.uptime() * 1000;

const HELLO = { type: 'hello', version: 1 };

// --version and --selftest never touch Bluetooth in the real helper either
if (process.argv[2] === '--version') {
  out(HELLO);
  process.exit(0);
}
if (process.argv[2] === '--selftest') {
  out(HELLO);
  out({ type: 'selftest', ok: true, checks: 0, failures: 0 });
  process.exit(0);
}

record({ event: 'start', pid: process.pid, scenario });
process.on('exit', (code) => record({ event: 'exit', code }));

if (scenario === 'badversion') {
  out({ type: 'hello', version: 99 });
} else if (scenario !== 'nohello') {
  const greet = () => {
    out(HELLO);
    out({ type: 'status', state: 'idle' });
  };
  if (helloMs > 0) setTimeout(greet, helloMs);
  else greet();
}

let active = false;
let timers = [];
let reportTimer = null;
let counter = 0;
let imuUs = 764777;
let reportsSent = 0;

const later = (ms, fn) => {
  const t = setTimeout(fn, ms);
  timers.push(t);
};
const clearAll = () => {
  for (const t of timers) clearTimeout(t);
  timers = [];
  for (const t of replayTimers) clearTimeout(t);
  replayTimers = [];
  replaying = false;
  if (reportTimer) clearInterval(reportTimer);
  reportTimer = null;
};
const status = (state, extra = {}) => out({ type: 'status', state, ...extra });
const fail = (code, message) => {
  clearAll();
  active = false;
  status('error', { code, message });
};

/** Synthetic swing: gravity tilts slowly, the gyro follows; all through the real report builder. */
function syntheticReport(n) {
  const phase = (n / 66) * 2 * Math.PI;
  imuUs = (imuUs + 15000) >>> 0;
  counter += 15;
  return buildInputReport({
    counter,
    imuTimestampUs: imuUs,
    batteryMv: 3435,
    temperatureRaw: 5,
    accelRaw: { x: Math.round(700 * Math.sin(phase)), y: Math.round(-650 * Math.cos(phase)), z: Math.round(3960 - 120 * Math.abs(Math.sin(phase))) },
    gyroRaw: { x: Math.round(40 * Math.cos(phase)), y: Math.round(300 * Math.sin(phase)), z: -12 },
    rightField: currentStick(),
    pressed: n === 50 ? ['A'] : [],
  });
}

// --- the virtual sword (MOTION=model)
const DEG_LSB = 2000 / 32768; // gyro dps per LSB with the parser's default scale
let sword = null;
let swordRng = null;
let swordTarget = { x: 960, y: 540 };
let swordPressUntil = 0;
let swordButton = null;
const BIAS_DPS = [0.8, -0.5, 0.3];
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r.next())) * Math.cos(2 * Math.PI * r.next());

function newSword() {
  sword = createSimModel({ mount: 'faceUp', startMs: 0 });
  swordRng = createRng(7);
  swordTarget = { x: 960, y: 540 };
  swordButton = null;
  swordPressUntil = 0;
  sword.setPose(0, initialPose === 'pointScreen' || initialPose === 'flat' ? initialPose : 'tipUp', { transitionMs: 0, teleport: true });
  sword.skipTo(1);
}

let streamStartMs = 0;
function modelReport() {
  // The model runs on REAL elapsed time, and so do the IMU timestamp and the counter: a setInterval of 15 ms in Node ticks every 16 ms or so under load,
  // and timestamps that advanced by exactly 15 ms per report would run 6 % slow against the clock (a rate no real IMU clock has), which the game
  // would see as a growing delay. The sine mode keeps its fixed 15 ms steps (the provider tests count on them).
  const elapsedMs = Math.max(1, uptimeMs() - streamStartMs);
  const m = sword.sampleAt(elapsedMs);
  const noise = (sigma) => gauss(swordRng) * sigma;
  const clamp = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
  imuUs = (764777 + Math.round(elapsedMs * 1000)) >>> 0;
  counter = Math.round(elapsedMs);
  if (swordButton && Date.now() > swordPressUntil) swordButton = null;
  return buildInputReport({
    counter,
    imuTimestampUs: imuUs,
    batteryMv: 3435,
    temperatureRaw: 5,
    accelRaw: { x: clamp((m.accelG.x + noise(0.004)) / ACCEL_G_PER_LSB), y: clamp((m.accelG.y + noise(0.004)) / ACCEL_G_PER_LSB), z: clamp((m.accelG.z + noise(0.004)) / ACCEL_G_PER_LSB) },
    gyroRaw: { x: clamp((m.gyroDps.x + BIAS_DPS[0] + noise(0.15)) / DEG_LSB), y: clamp((m.gyroDps.y + BIAS_DPS[1] + noise(0.15)) / DEG_LSB), z: clamp((m.gyroDps.z + BIAS_DPS[2] + noise(0.15)) / DEG_LSB) },
    rightField: currentStick(),
    pressed: swordButton ? [swordButton] : [],
  });
}

/** A glide of the virtual sword to a screen point: 4 ms steps of model time, from wherever it aims now. */
function glideTo(x, y, ms) {
  const t0 = sword.time;
  const steps = Math.max(1, Math.round(ms / 4));
  const from = { ...swordTarget };
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    sword.setMouse(t0 + (ms * i) / steps, from.x + (x - from.x) * f, from.y + (y - from.y) * f);
  }
  swordTarget = { x, y };
}

// --- replay of the REAL recording (command `replay`)
let replaying = false;
let replayTimers = [];
let recording = null;
/** {step -> [{tMs (device time from the first IMU-active report of the step), hex}]} */
function loadRecording() {
  if (recording) return recording;
  recording = {};
  let prevStep = null;
  let prevUs = null;
  let t = 0;
  for (const line of readFileSync(replayFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (!r.hex || !r.step) continue;
    const p = parseInputReport(hexToBytes(r.hex));
    if (!p || !p.imuActive) continue;
    if (r.step !== prevStep) {
      recording[r.step] = [];
      prevStep = r.step;
      prevUs = null;
      t = 0;
    }
    if (prevUs !== null) t += imuDeltaUs(prevUs, p.imuTimestampUs) / 1000;
    prevUs = p.imuTimestampUs;
    recording[r.step].push({ tMs: t, hex: r.hex });
  }
  return recording;
}
function startReplay(spec) {
  const rec = loadRecording();
  const windows = Array.isArray(spec.windows) ? spec.windows : [];
  const gapMs = Number(spec.gapMs ?? 600);
  const schedule = [];
  let at = 0;
  for (const w of windows) {
    const all = rec[w.step];
    if (!all) continue;
    const l = all.filter((r) => r.tMs / 1000 >= (w.fromS ?? 0) && r.tMs / 1000 < (w.toS ?? Infinity));
    if (!l.length) continue;
    for (const r of l) schedule.push({ at: at + (r.tMs - l[0].tMs), hex: r.hex });
    at += l[l.length - 1].tMs - l[0].tMs + gapMs;
  }
  for (const tm of replayTimers) clearTimeout(tm);
  replayTimers = [];
  if (!schedule.length) return;
  replaying = true;
  record({ event: 'replay', phase: 'start', reports: schedule.length, windows: windows.length });
  const t0 = uptimeMs();
  schedule.forEach((r, i) => {
    const tm = setTimeout(() => {
      if (!active) return;
      reportsSent += 1;
      out({ type: 'report', t: Math.round(uptimeMs() * 1000) / 1000, hex: r.hex });
      if (i === schedule.length - 1) {
        replaying = false;
        record({ event: 'replay', phase: 'done', reports: schedule.length, elapsedMs: Math.round(uptimeMs() - t0) });
      }
    }, Math.max(0, r.at - (uptimeMs() - t0)));
    replayTimers.push(tm);
  });
}

// --- the control file
let controlSeq = 0;
let controlMtime = 0;
function applyCommand(c) {
  if (c.crash !== undefined) process.exit(Number(c.crash) || 1);
  if (c.drop) {
    fail('lost_signal', 'the link dropped while streaming (fake, control file)');
    return;
  }
  if (c.stick) {
    stickField = { x: Number(c.stick.x), y: Number(c.stick.y) };
    stickUntil = Date.now() + Number(c.stick.ms ?? 200);
  }
  if (!sword) return;
  if (c.pose) sword.setPose(sword.time, c.pose, { transitionMs: c.transitionMs ?? 0 });
  if (c.clearPose) sword.clearPose(sword.time, { transitionMs: c.transitionMs ?? 0 });
  if (c.moveTo) glideTo(Number(c.moveTo.x), Number(c.moveTo.y), Number(c.moveTo.ms ?? 0));
  if (c.replay) startReplay(c.replay);
  if (c.button) {
    swordButton = String(c.button);
    swordPressUntil = Date.now() + Number(c.ms ?? 120);
  }
}
function pollControl() {
  if (!controlFile || !existsSync(controlFile)) return;
  let mtime;
  try {
    mtime = statSync(controlFile).mtimeMs;
  } catch {
    return;
  }
  if (mtime === controlMtime) return;
  controlMtime = mtime;
  let doc;
  try {
    doc = JSON.parse(readFileSync(controlFile, 'utf8'));
  } catch {
    controlMtime = 0; // a half-written file: read it again next time
    return;
  }
  if (!Number.isInteger(doc.seq) || doc.seq <= controlSeq) return;
  controlSeq = doc.seq;
  record({ event: 'control', seq: doc.seq });
  if (typeof doc.scenario === 'string') scenario = doc.scenario;
  for (const c of Array.isArray(doc.commands) ? doc.commands : []) applyCommand(c);
}
// A helper that starts later (after a crash, or for the first connect) must not replay what the file still holds: commands (crash, drop, moveTo) were for
// the helper that was running then. The scenario, on the other hand, is "what the NEXT connect does" and stays valid across a restart.
if (controlFile && existsSync(controlFile)) {
  try {
    const doc = JSON.parse(readFileSync(controlFile, 'utf8'));
    if (Number.isInteger(doc.seq)) controlSeq = doc.seq;
    if (typeof doc.scenario === 'string') scenario = doc.scenario;
    controlMtime = statSync(controlFile).mtimeMs;
  } catch {
    /* an unreadable file: start clean */
  }
}
if (controlFile) setInterval(pollControl, 15).unref();

function startStreaming() {
  status('streaming', { side: 'R' });
  const first = [hexOf('REAL_R_1'), hexOf('REAL_R_2')];
  let n = 0;
  if (motion === 'model') {
    newSword();
    streamStartMs = uptimeMs();
  }
  const begin = () => {
    if (!active) return;
    reportTimer = setInterval(emitOne, reportMs);
  };
  const emitOne = () => {
    if (!active) return;
    if (replaying && n >= first.length) return; // the recording speaks, the model sword is silent
    let hex;
    if (n < first.length) hex = first[n];
    else hex = bytesToHex(motion === 'model' ? modelReport() : syntheticReport(n));
    n += 1;
    reportsSent += 1;
    if (scenario === 'badlength' && n === 3) {
      out({ type: 'status', state: 'streaming', warning: 'bad_length', message: 'dropped an input notification of 20 bytes (expected 63)', dropped: 1 });
      return;
    }
    out({ type: 'report', t: Math.round(uptimeMs() * 1000) / 1000, hex });
    if (n % 10 === 0) out({ type: 'response', hex: '09010107107800000000000000000000' });
    if (scenario === 'lost' && n >= lostAfter) {
      fail('lost_signal', 'the link dropped while streaming: fake');
    }
  };
  if (streamMs > reportMs) later(streamMs - reportMs, begin);
  else begin();
}

function connect(cmd) {
  if (active) {
    out({ type: 'status', state: 'streaming', warning: 'busy', message: 'connect ignored: a connection attempt is already running' });
    return;
  }
  pollControl(); // a scenario written just before the click applies to this connect
  active = true;
  reportsSent = 0;
  status('scanning', { message: 'waiting for Bluetooth' });
  if (scenario === 'crash1') return later(stepMs, () => process.exit(1));
  if (scenario === 'crash134') return later(stepMs, () => process.exit(134));
  if (scenario === 'abort') return later(stepMs, () => process.kill(process.pid, 'SIGABRT'));
  if (scenario === 'silent') return undefined;
  if (scenario === 'permission') return later(stepMs, () => fail('bluetooth_permission', 'macOS denied Bluetooth access (fake)'));
  if (scenario === 'bluetooth_off') return later(stepMs, () => fail('bluetooth_off', 'Bluetooth is turned off (fake)'));
  // the second `scanning` status: the scan really starts (the real helper sends two, the first while it waits for Bluetooth)
  later(waitMs, () => status('scanning', { message: 'scanning for a Joy-Con 2' }));
  if (scenario === 'no_device') return later(waitMs + stepMs * 3 + scanMs, () => fail('no_device', 'no Joy-Con 2 advert found within 45 s (fake)'));
  if (scenario === 'noisy') {
    raw('this line is not JSON');
    raw(JSON.stringify({ type: 'something-else', x: 1 }));
    raw(JSON.stringify({ type: 'report', t: 1, hex: 'zz' }));
    raw(`{"type":"status",${'x'.repeat(70000)}`);
  }
  const t1 = waitMs + scanMs; // the advert is seen
  later(t1, () => out({ type: 'advert', side: 'R', pid: 8294, rssi: -40, host: '00 00 00 00 00 00', pairing: true }));
  later(t1 + stepMs, () => status('connecting', { side: 'R' }));
  if (scenario === 'connect_failed') return later(t1 + stepMs * 2, () => fail('connect_failed', 'the connection did not complete within 20 s (fake)'));
  later(t1 + stepMs * 2, () => status('discovering', { side: 'R' }));
  later(t1 + stepMs * 3, () => status('initialising', { side: 'R' }));
  later(t1 + stepMs * 4, () => active && startStreaming());
  void cmd;
  return undefined;
}

function disconnect() {
  if (!active) return;
  clearAll();
  active = false;
  status('disconnected', { message: 'disconnected on request' });
}

function quit() {
  if (scenario === 'stubborn') return; // ignores quit, EOF and SIGTERM: the manager must fall back to SIGKILL
  clearAll();
  process.exit(0);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    record({ event: 'command', cmd });
    if (cmd.cmd === 'connect') connect(cmd);
    else if (cmd.cmd === 'disconnect') disconnect();
    else if (cmd.cmd === 'rumble') record({ event: 'rumble', id: cmd.id });
    else if (cmd.cmd === 'quit') quit();
  }
});
process.stdin.on('end', quit);
process.stdin.on('error', () => {});
process.stdout.on('error', () => process.exit(0));
process.on('SIGTERM', () => {
  if (scenario === 'stubborn') return;
  process.exit(0);
});
process.on('SIGINT', () => process.exit(0));
if (scenario === 'stubborn') setInterval(() => {}, 1000); // keep running even after stdin closes
