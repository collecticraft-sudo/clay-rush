// Runtime contract validators. OWNER: architect (frozen). Dependency-free, works in Node and the browser.
//
// Every validateX(value) returns an array of human-readable problems ([] = valid). assertValid(kind, value) throws.
// Use them (1) in unit tests of every module to pin the contracts mechanically, and (2) in main.js when ?debug=1 to
// check data at module boundaries. They check field names, types and enums, not physics.

import {
  ACTION, ACTION_SOURCE, CONN_STATE, INPUT_ERROR, GAME_PHASE, GAME_EVENT, NAV_DIR, NAV_PHASE, ROUND_MODE, SIDE, DIFFICULTY, STAGE_ID,
  TARGET_KIND, TARGET_FRAME, HOUSE_ID, LOST_REASON, END_REASON, RANK,
} from './contracts.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const enumOf = (obj) => Object.values(obj);

/** field spec: 'num'|'int'|'str'|'bool'|'vec3'|'any'|'arr'|'obj' with optional leading '?' (nullable) | array of allowed values */
function checkField(path, v, spec, errs) {
  if (typeof spec === 'string' && spec.startsWith('?')) {
    if (v === null) return;
    spec = spec.slice(1);
  }
  if (Array.isArray(spec)) {
    if (!spec.includes(v)) errs.push(`${path}: ${JSON.stringify(v)} not in [${spec.join('|')}]`);
    return;
  }
  switch (spec) {
    case 'num': if (!isNum(v)) errs.push(`${path}: expected finite number, got ${describe(v)}`); break;
    case 'int': if (!isInt(v)) errs.push(`${path}: expected integer, got ${describe(v)}`); break;
    case 'str': if (typeof v !== 'string') errs.push(`${path}: expected string, got ${describe(v)}`); break;
    case 'bool': if (typeof v !== 'boolean') errs.push(`${path}: expected boolean, got ${describe(v)}`); break;
    case 'arr': if (!Array.isArray(v)) errs.push(`${path}: expected array, got ${describe(v)}`); break;
    case 'obj': if (v === null || typeof v !== 'object' || Array.isArray(v)) errs.push(`${path}: expected object, got ${describe(v)}`); break;
    case 'vec3':
      if (v === null || typeof v !== 'object' || !isNum(v.x) || !isNum(v.y) || !isNum(v.z)) errs.push(`${path}: expected {x,y,z} finite numbers, got ${describe(v)}`);
      break;
    case 'any': break;
    default: errs.push(`${path}: unknown spec ${spec}`);
  }
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return String(v);
  return typeof v;
}

function checkShape(name, value, shape, extra) {
  const errs = [];
  if (value === null || typeof value !== 'object') return [`${name}: expected object, got ${describe(value)}`];
  for (const [key, spec] of Object.entries(shape)) {
    if (!(key in value)) {
      // nullable fields must still be present (as null) so consumers never see undefined
      errs.push(`${name}.${key}: missing`);
      continue;
    }
    checkField(`${name}.${key}`, value[key], spec, errs);
  }
  if (extra) extra(value, errs);
  return errs;
}

const SIDE_ENUM = enumOf(SIDE);

export const validateImuSample = (s) => checkShape('ImuSample', s, {
  seq: 'int', t: 'num', arrivedAt: 'num', dtMs: '?num', dtSource: ['device', 'arrival', 'synthetic'],
  accel: 'vec3', gyro: 'vec3', side: SIDE_ENUM, buttons: 'arr', batteryMv: '?num', tempC: '?num', imuActive: 'bool',
}, (s, errs) => {
  if (isNum(s.t) && isNum(s.arrivedAt) && s.t > s.arrivedAt + 1e-6) errs.push('ImuSample: t is later than arrivedAt');
  if (isNum(s.dtMs) && !(s.dtMs > 0 && s.dtMs < 200)) errs.push(`ImuSample: dtMs ${s.dtMs} must be null or in (0,200)`);
});

export const validateAimSample = (s) => checkShape('AimSample', s, { t: 'num', x: 'num', y: 'num' }, (s, errs) => {
  if ('discontinuity' in s && typeof s.discontinuity !== 'boolean') errs.push('AimSample.discontinuity: expected boolean');
});

export const validateButtonsEvent = (e) => checkShape('ButtonsEvent', e, { t: 'num', side: SIDE_ENUM, pressed: 'arr', down: 'arr', up: 'arr' });

export const validateActionEvent = (e) => checkShape('ActionEvent', e, {
  t: 'num', action: enumOf(ACTION), label: 'str', source: enumOf(ACTION_SOURCE),
});

export const validateNavEvent = (e) => checkShape('NavEvent', e, {
  t: 'num', dir: enumOf(NAV_DIR), phase: enumOf(NAV_PHASE), source: enumOf(ACTION_SOURCE),
});

export const validateBladeSample = (b) => checkShape('BladeSample', b, {
  t: 'num', x: 'num', y: 'num', speed: 'num', cutting: 'bool', swingId: 'int', segmentValid: 'bool',
  x0: 'num', y0: 'num', t0: 'num', discontinuity: 'bool', trackingOk: 'bool', angularSpeedDps: '?num', source: ['imu', 'aim'],
}, (b, errs) => {
  if (isNum(b.x) && (b.x < 0 || b.x > 1920)) errs.push(`BladeSample.x ${b.x} outside 0..1920`);
  if (isNum(b.y) && (b.y < 0 || b.y > 1080)) errs.push(`BladeSample.y ${b.y} outside 0..1080`);
  if (b.segmentValid && !b.cutting) errs.push('BladeSample: segmentValid requires cutting');
  if (b.segmentValid && b.discontinuity) errs.push('BladeSample: segmentValid conflicts with discontinuity');
  if (isNum(b.speed) && b.speed < 0) errs.push('BladeSample.speed < 0');
  // additive fields of the sword tuning round (docs/motion-contract.md 4.2): optional here, so older producers and fixtures still pass
  for (const k of ['speedDps', 'vx', 'vy']) if (k in b && !isNum(b[k])) errs.push(`BladeSample.${k}: expected number`);
  if ('interpolated' in b && typeof b.interpolated !== 'boolean') errs.push('BladeSample.interpolated: expected boolean');
  if (isNum(b.speedDps) && b.speedDps < 0) errs.push('BladeSample.speedDps < 0');
});

export const validateBladeSegment = (s) => checkShape('BladeSegment', s, {
  t0: 'num', x0: 'num', y0: 'num', t1: 'num', x1: 'num', y1: 'num', speed: 'num', swingId: 'int',
}, (s, errs) => {
  if (isNum(s.t0) && isNum(s.t1) && s.t1 < s.t0) errs.push('BladeSegment: t1 < t0');
});

export const validateCalibration = (c) => checkShape('Calibration', c, {
  version: [1], side: SIDE_ENUM, createdAt: 'num', frame: 'obj', gyroBiasDps: 'vec3', gyroSign: [1, -1],
  gyroScale: 'num', gyroScaleSource: ['default', 'stored', 'estimated'], quality: 'obj',
}, (c, errs) => {
  const f = c.frame;
  if (!f || !['right', 'forward', 'up'].every((k) => f[k] && isNum(f[k].x) && isNum(f[k].y) && isNum(f[k].z))) {
    errs.push('Calibration.frame: needs right, forward, up as {x,y,z}');
    return;
  }
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  for (const k of ['right', 'forward', 'up']) if (Math.abs(dot(f[k], f[k]) - 1) > 1e-3) errs.push(`Calibration.frame.${k} is not a unit vector`);
  if (Math.abs(dot(f.right, f.forward)) > 1e-3 || Math.abs(dot(f.forward, f.up)) > 1e-3 || Math.abs(dot(f.right, f.up)) > 1e-3) errs.push('Calibration.frame is not orthogonal');
  const rf = cross(f.right, f.forward);
  if (dot(rf, f.up) < 0.999) errs.push('Calibration.frame is not right-handed (right x forward must equal up)');
  if (isNum(c.gyroScale) && c.gyroScale <= 0) errs.push('Calibration.gyroScale must be > 0');
  if ('accelG0' in c && !(isNum(c.accelG0) && c.accelG0 >= 0.5 && c.accelG0 <= 2)) errs.push('Calibration.accelG0 must be a number in 0.5..2 (the resting accelerometer magnitude in g)');
});

export const validateInputStatus = (s) => checkShape('InputStatus', s, {
  kind: ['joycon', 'sim', 'mouse'], state: enumOf(CONN_STATE), side: SIDE_ENUM, battery: 'obj', trackingOk: 'bool', error: '?obj',
  cooldownUntil: '?num', failures: 'int', deviceName: '?str', packetRateHz: '?num', lastPacketAt: '?num', featureMask: '?num',
}, (s, errs) => {
  if (s.battery && !['ok', 'low', 'critical', 'unknown'].includes(s.battery.level)) errs.push('InputStatus.battery.level invalid');
  if (s.error && !enumOf(INPUT_ERROR).includes(s.error.code)) errs.push(`InputStatus.error.code ${s.error.code} invalid`);
  if (s.state === CONN_STATE.ERROR && !s.error) errs.push('InputStatus: state error requires error');
});

const SHOT_SOURCE = enumOf(ACTION_SOURCE);

export const validateShot = (s) => checkShape('Shot', s, { t: 'num', x: 'num', y: 'num', source: SHOT_SOURCE, compMs: 'num' });

export const validateTarget = (o) => checkShape('Target', o, {
  id: 'int', kind: enumOf(TARGET_KIND), frame: enumOf(TARGET_FRAME), x: 'num', y: 'num', z: 'num', vx: 'num', vy: 'num', vz: 'num',
  sx: 'num', sy: 'num', rPx: 'num', rot: 'num', ageS: 'num', pullIndex: 'int',
});

export const validateHouse = (h) => checkShape('House', h, {
  id: enumOf(HOUSE_ID), sprite: '?str', x: 'num', y: 'num', z: 'num', sx: 'num', sy: 'num', scale: 'num', mirrored: 'bool', flashS: 'num',
});

const EVENT_SHAPES = {
  stageStart: { index: 'int', id: enumOf(STAGE_ID), name: 'str', windX: 'num' },
  ready: { stageIndex: 'int', pullIndex: 'int' },
  pull: { delayMs: 'num' },
  launch: { ids: 'arr', house: enumOf(HOUSE_ID), double: 'bool' },
  shot: { x: 'num', y: 'num', shell: [0, 1, -1], hitIds: 'arr', source: SHOT_SOURCE, compMs: 'num' },
  dryFire: { x: 'num', y: 'num' },
  hit: {
    id: 'int', kind: enumOf(TARGET_KIND), x: 'num', y: 'num', z: 'num', rPx: 'num', vx: 'num', vy: 'num', points: 'int', centre: 'bool',
    firstBarrel: 'bool', multiplier: 'int', streak: 'int', shardSeed: 'int',
  },
  lost: { id: 'int', kind: enumOf(TARGET_KIND), x: 'num', y: 'num', reason: enumOf(LOST_REASON) },
  double: { points: 'int', x: 'num', y: 'num' },
  twoWithOne: { points: 'int', x: 'num', y: 'num' },
  streak: { level: 'int', streak: 'int' },
  stageClear: { index: 'int', perfect: 'bool', bonus: 'int' },
  reload: { phase: ['start', 'done'], ms: 'num' },
  killCam: { x: 'num', y: 'num', durationMs: 'num', scale: 'num' },
  hitStop: { ms: 'num' },
  timeBonus: { deltaS: 'num', timeLeft: 'num' },
  tick: { secondsLeft: 'int' },
  timeUp: { score: 'int' },
  phase: { phase: enumOf(GAME_PHASE) },
  practice: { phase: ['thrown', 'hit', 'lost'] },
};

export const validateGameEvent = (e) => {
  const base = checkShape('GameEvent', e, { seq: 'int', t: 'num', type: enumOf(GAME_EVENT) });
  if (base.length) return base;
  return checkShape(`GameEvent(${e.type})`, e, EVENT_SHAPES[e.type] ?? {});
};

export const validateRoundResult = (r) => checkShape('RoundResult', r, {
  mode: enumOf(ROUND_MODE), difficulty: enumOf(DIFFICULTY), stageId: ['meadow', 'hills', 'alpine', null], score: 'int', presented: 'int',
  broken: 'int', lost: 'int', shots: 'int', hits: 'int', accuracy: '?num', bestStreak: 'int', doubles: 'int', centre: 'int', durationS: 'num',
  endReason: enumOf(END_REASON), rank: [...enumOf(RANK), null], assist: 'bool',
});

const STAT_KEYS = ['presented', 'broken', 'lost', 'shots', 'hits', 'centre', 'doubles', 'bestStreak'];

export const validateGameSnapshot = (s) => checkShape('GameSnapshot', s, {
  v: [1], mode: enumOf(ROUND_MODE), difficulty: enumOf(DIFFICULTY), seed: 'num', phase: enumOf(GAME_PHASE), t: 'num', tWorld: 'num',
  alpha: 'num', timeScale: 'num', stage: 'obj', pull: 'obj', wind: 'obj', shells: 'obj', score: 'int', streak: 'int', multiplier: 'int',
  multiplierProgress: 'num', timeLeft: '?num', timeTotal: '?num', targets: 'arr', houses: 'arr', killCam: '?obj', practice: '?obj',
  stats: 'obj', assist: 'bool', endReason: [...enumOf(END_REASON), null], events: 'arr',
}, (s, errs) => {
  if (isNum(s.alpha) && (s.alpha < 0 || s.alpha > 1)) errs.push(`GameSnapshot.alpha ${s.alpha} outside 0..1`);
  if (isNum(s.timeScale) && (s.timeScale < 0 || s.timeScale > 1)) errs.push(`GameSnapshot.timeScale ${s.timeScale} outside 0..1`);
  if (isInt(s.multiplier) && (s.multiplier < 1 || s.multiplier > 4)) errs.push(`GameSnapshot.multiplier ${s.multiplier} outside 1..4`);
  if (s.stage && typeof s.stage === 'object') {
    checkField('GameSnapshot.stage.index', s.stage.index, 'int', errs);
    checkField('GameSnapshot.stage.id', s.stage.id, enumOf(STAGE_ID), errs);
    checkField('GameSnapshot.stage.count', s.stage.count, 'int', errs);
    checkField('GameSnapshot.stage.name', s.stage.name, 'str', errs);
  }
  if (s.pull && typeof s.pull === 'object') {
    checkField('GameSnapshot.pull.index', s.pull.index, 'int', errs);
    checkField('GameSnapshot.pull.count', s.pull.count, '?int', errs);
    checkField('GameSnapshot.pull.targetsLeft', s.pull.targetsLeft, 'int', errs);
  }
  if (s.wind && typeof s.wind === 'object') for (const k of ['x', 'gust']) checkField(`GameSnapshot.wind.${k}`, s.wind[k], 'num', errs);
  if (s.shells && typeof s.shells === 'object') {
    for (const k of ['loaded', 'capacity']) checkField(`GameSnapshot.shells.${k}`, s.shells[k], 'int', errs);
    checkField('GameSnapshot.shells.reloadingS', s.shells.reloadingS, 'num', errs);
    checkField('GameSnapshot.shells.infinite', s.shells.infinite, 'bool', errs);
  }
  if (s.stats && typeof s.stats === 'object') for (const k of STAT_KEYS) if (!isInt(s.stats[k])) errs.push(`GameSnapshot.stats.${k}: expected integer`);
  if (Array.isArray(s.targets)) s.targets.forEach((o, i) => errs.push(...validateTarget(o).map((m) => `targets[${i}] ${m}`)));
  if (Array.isArray(s.houses)) s.houses.forEach((h, i) => errs.push(...validateHouse(h).map((m) => `houses[${i}] ${m}`)));
  if (Array.isArray(s.events)) {
    if (s.events.length > 32) errs.push('GameSnapshot.events longer than 32');
    s.events.forEach((e, i) => errs.push(...validateGameEvent(e).map((m) => `events[${i}] ${m}`)));
  }
  try {
    JSON.stringify(s);
  } catch {
    errs.push('GameSnapshot is not JSON-serialisable');
  }
});

export const VALIDATORS = Object.freeze({
  ImuSample: validateImuSample,
  AimSample: validateAimSample,
  ButtonsEvent: validateButtonsEvent,
  ActionEvent: validateActionEvent,
  NavEvent: validateNavEvent,
  BladeSample: validateBladeSample,
  BladeSegment: validateBladeSegment,
  Calibration: validateCalibration,
  InputStatus: validateInputStatus,
  Shot: validateShot,
  Target: validateTarget,
  House: validateHouse,
  GameEvent: validateGameEvent,
  RoundResult: validateRoundResult,
  GameSnapshot: validateGameSnapshot,
});

/** Throws Error listing every problem, or returns the value unchanged. */
export function assertValid(kind, value) {
  const fn = VALIDATORS[kind];
  if (!fn) throw new Error(`assertValid: unknown contract "${kind}"`);
  const errs = fn(value);
  if (errs.length) throw new Error(`Contract violation (${kind}):\n  - ${errs.join('\n  - ')}`);
  return value;
}
