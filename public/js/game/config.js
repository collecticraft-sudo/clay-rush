// Clay Rush game configuration (data only, deep-frozen). OWNER: Gameplay engineer.
//
// Every number of docs/game-design.md sections 3 to 8 that the game logic uses lives here and nowhere else.
// The projection (F, horizon, camera height, zNear, zFar, g) is NOT repeated here: it lives in shared/world.js.
//
// HARDWARE HONESTY: none of these numbers was tried with a real Joy-Con 2 as a gun. The ones that decide how the game
// FEELS (pattern radius, centre-hit fraction, pull delay, launch speeds, the Hard pellet speed) are starting values,
// UNVERIFIED-ON-HARDWARE. Tune them here after the recording session (design section 11); no logic needs to change.

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** A launch member: one target of a pull. offsetS = delay after the pull's launch instant (trap pairs 0.4 s apart). */
const m = (kind, house, offsetS = 0) => ({ kind, house, offsetS });

export const CONFIG = deepFreeze({
  version: 1,

  // Local storage (the UI owns the access; the game owns the shape of the best table and its keys).
  storage: {
    key: 'clayRush.v1',
    version: 1,
    bestKeySep: '.',
    // best table keys: 'classic.<difficulty>' and 'timeattack.<difficulty>.<stage>' (zen and practice are not scored)
    scoredModes: ['classic', 'timeattack'],
  },

  // Clocks (architecture 5): fixed world tick, real-time accumulator, timeScale.
  time: {
    dt: 1 / 120,
    maxFrameS: 0.1, // update() clamps the real frame time to this
    maxStepsPerFrame: 13, // 0.1 s / (1/120) = 12 ticks, plus the leftover of the previous frame
    maxRewindMs: 120, // a shot older than the simulation is resolved at most this far back (late input reports)
    neverS: 1e6, // House.flashS of a house that never launched
    velocityProbeS: 0.01, // world seconds used to measure a target's on-screen velocity (px/s) for the hit event
  },

  events: { ring: 32, maxUndrained: 512 },
  caps: { airborne: 12 },

  // Seeded streams: rng = createRng(hash32(hash32(seed, stream), k)). Values are arbitrary distinct ids.
  streams: {
    plan: 11, launch: 23, wind: 37, debug: 41, wave: 53, shard: 67,
    // k offsets inside the launch stream: Classic pull = stageIndex * pullStride + pullIndex, waves and practice above
    pullStride: 1000, waveBase: 100000, practiceBase: 200000, goldKey: 300000,
  },

  // Physics in world metres (design 3). Gravity comes from shared/world.js (WORLD.g).
  // World scale k (difficulty.distanceMul): positions and speeds x k, gravity and wind acceleration x k, drag coefficients / k, so the
  // screen trajectories stay about the same while the clays (sizeM) and the pattern (metres) look bigger (k < 1) or smaller (k > 1).
  physics: {
    drag: 0.012, // k in a = g + wind - k |v| v, per metre
    windAccelPerMps: 1.0, // the design formula adds the wind (m/s) as an acceleration: factor 1 (tunable)
    maxLifeS: 6,
    offscreenMarginPx: 200, // lost when more than this outside the screen (after having been on screen once)
    battue: { dipAtFrac: 0.6, dragMul: 2 }, // drag x2 after 60 percent of the nominal flight time
    rabbit: {
      groundDrag: 0.004, // rolling resistance, per metre (same law as the air drag)
      hopM: [0.2, 0.6],
      rollGapS: [0.15, 0.45], // time rolling on the ground between two hops
    },
    spinRadS: [4, 9], // cosmetic sprite spin, random sign
    jitterM: 0.12, // launch point jitter (x and z)
  },

  // Fairness rule (design 3): each target stays >= minVisibleS in the shootable view, else redraw, then clamp.
  fairness: { minVisibleS: 1.2, retries: 8 },

  // Target kinds (design 3). sizeM = drawn diameter; speedMul applies to the house speed.
  targets: {
    standard: { sizeM: 0.6, points: 100, speedMul: 1 },
    mini: { sizeM: 0.38, points: 150, speedMul: 1.25 },
    battue: { sizeM: 0.6, points: 150, speedMul: 1.2, elevationDeg: [9, 15] },
    rabbit: { sizeM: 0.6, points: 150, speedMul: 1 },
    gold: { sizeM: 0.6, points: 300, speedMul: 1 },
  },

  // Sprite frame of a standard clay by the elevation of the line of sight (degrees).
  frames: { belowDeg: 18, edgeDeg: 2.5 },

  // Launch houses (design 3). Angles: azimuth from +z towards +x; elevation above the horizontal.
  // `safe` is the clamp of the fairness rule: parameters that pass for every kind, difficulty and wind (tested).
  houses: {
    trap: {
      sprite: 'house_trap', x: 0, y: 0.4, z: 14, mirrored: false,
      azimuthDeg: [-35, 35], elevationDeg: [18, 30], speed: [20, 26],
      safe: { azimuthDeg: 0, elevationDeg: 30, speed: 20 },
    },
    skeetL: {
      sprite: 'house_skeet', x: -22, y: 3.0, z: 32, mirrored: false,
      azimuthDeg: [95, 112], elevationDeg: [14, 24], speed: [19, 24],
      safe: { azimuthDeg: 100, elevationDeg: 24, speed: 20 },
    },
    skeetR: {
      sprite: 'house_skeet', x: 22, y: 1.2, z: 34, mirrored: true,
      azimuthDeg: [-112, -95], elevationDeg: [16, 26], speed: [19, 24],
      safe: { azimuthDeg: -100, elevationDeg: 26, speed: 20 },
    },
    tower: {
      sprite: 'house_tower', x: -14, y: 6.0, z: 46, mirrored: false,
      azimuthDeg: [150, 168], elevationDeg: [6, 16], speed: [16, 20],
      safe: { azimuthDeg: 160, elevationDeg: 14, speed: 17 },
    },
    rabbitL: {
      sprite: null, x: -26, y: 0.15, z: 24, mirrored: false,
      azimuthDeg: [82, 95], elevationDeg: [0, 0], speed: [12, 16],
      safe: { azimuthDeg: 90, elevationDeg: 0, speed: 13 },
    },
  },

  // Pull templates: the members of one launch (a single or a double).
  pullTypes: {
    trapSingle: [m('standard', 'trap')],
    miniSingle: [m('mini', 'trap')],
    skeetLSingle: [m('standard', 'skeetL')],
    skeetRSingle: [m('standard', 'skeetR')],
    towerSingle: [m('standard', 'tower')],
    rabbitSingle: [m('rabbit', 'rabbitL')],
    battueSingle: [m('battue', 'skeetL')],
    skeetPair: [m('standard', 'skeetL'), m('standard', 'skeetR')],
    trapPair: [m('standard', 'trap'), m('standard', 'trap', 0.4)],
    towerSkeet: [m('standard', 'tower'), m('standard', 'skeetR')],
    rabbitClay: [m('rabbit', 'rabbitL'), m('standard', 'trap')],
    battuePair: [m('battue', 'skeetL'), m('battue', 'skeetL', 0.4)],
  },

  // Classic stages (design 7.1). plan.groups: `count` pulls drawn from `types` (balanced; `distinct` = no repeat).
  stages: [
    {
      id: 'meadow', name: 'Morning Meadow', backdrop: 'meadow', pulls: 10, targets: 10,
      wind: { speed: 0, gustAmp: 0, gustPeriodS: 3 },
      houses: ['trap'],
      speedOverride: { trap: [18, 22] },
      plan: { groups: [{ types: ['trapSingle'], count: 10 }], miniInLast: 3, gold: 0, first: null, last: null },
    },
    {
      id: 'hills', name: 'Golden Hills', backdrop: 'hills', pulls: 8, targets: 12,
      wind: { speed: 1.5, gustAmp: 0, gustPeriodS: 3 },
      houses: ['skeetL', 'skeetR', 'trap'],
      speedOverride: null,
      plan: {
        groups: [{ types: ['skeetLSingle', 'skeetRSingle'], count: 4 }, { types: ['skeetPair', 'trapPair'], count: 4 }],
        miniInLast: 0, gold: 1, first: 'single', last: null,
      },
    },
    {
      id: 'alpine', name: 'Alpine Dusk', backdrop: 'alpine', pulls: 8, targets: 14,
      wind: { speed: 2.5, gustAmp: 1, gustPeriodS: 3 },
      houses: ['tower', 'skeetL', 'skeetR', 'trap', 'rabbitL'],
      speedOverride: null,
      plan: {
        groups: [
          { types: ['towerSingle'], count: 2 },
          { types: ['skeetPair', 'trapPair', 'towerSkeet'], count: 3, distinct: true },
          { types: ['rabbitClay'], count: 2 },
          { types: ['battuePair'], count: 1 },
        ],
        miniInLast: 0, gold: 0, first: 'towerSingle', last: 'battuePair',
      },
    },
  ],

  // The shot (design 4). Pattern radius r(z) = r0 + spread * z metres.
  shot: { r0: 0.1, spread: 0.018, centreFrac: 0.35, pelletSpeed: 750 },

  // Aim assist Light (design 6.5).
  assist: { patternMul: 1.15, pull: 0.25, rangePatterns: 1.6 },

  // Scoring (design 5). Every bonus is multiplied by the streak multiplier.
  scoring: {
    centre: 50,
    firstBarrel: 25,
    distanceFromM: 25,
    distancePerM: 4,
    double: 100,
    twoWithOne: 200,
    perfectStage: 500,
  },
  // Streak multiplier: x1 from 0, x2 from 3, x3 from 6, x4 from 10 consecutive broken targets.
  streak: { steps: [0, 3, 6, 10] },

  // Difficulty (design 7.4). distanceMul = the world scale k: Easy closer, Hard farther (owner decision 2026-10-03).
  difficulty: {
    easy: { distanceMul: 0.55, speedMul: 0.9, patternMul: 1.15, travel: false, windMul: 0.5 },
    normal: { distanceMul: 1, speedMul: 1, patternMul: 1, travel: false, windMul: 1 },
    hard: { distanceMul: 1.45, speedMul: 1, patternMul: 1.1, travel: true, windMul: 1.2 },
  },

  // Classic pull cycle (design 7.1).
  classic: {
    shellsPerPull: 2,
    pullDelayS: [0.15, 0.55],
    settleS: 0.7,
    stageCardS: 2.5,
    loadS: 0.4, // two-shell insert animation in 'ready'
    autoPullS: 1.2, // setting "Auto pull"
    idlePulseS: 6, // the HUD pulses the prompt after this (HUD-side timing, kept here as data)
    debugAutoPull: true, // debugSetAutoLaunch(true): call the pull as soon as the gun is loaded
  },

  // Time Attack (design 7.2).
  timeattack: {
    durationS: 90,
    maxS: 120, // the clock never shows more than this
    // time bonus per broken target by its rank in the round: breaks 1-20 +1.5 s, 21-40 +0.75 s, then +0.25 s (upTo null = no limit)
    bonusSteps: [{ upTo: 20, s: 1.5 }, { upTo: 40, s: 0.75 }, { upTo: null, s: 0.25 }],
    roundCapS: 180, // hard cap of real round time: the round ends ('timer', timeUp) when the clock hits 0 or this is reached
    // Waves (owner decision 2026-10-03): one wave at a time, never more clays than shells. Each wave refills the gun to `capacity`;
    // the next wave starts `gapS` after every target of the previous one is broken or lost (1.4 s at the start, 0.5 s after durationS).
    gapS: [1.4, 0.5],
    doubleChance: [0.15, 0.6], // probability that a wave is a double, from the start to durationS
    firstWaveS: 1.0,
    capacity: 2,
    tickFromS: 10,
    defaultStage: 'hills',
    goldWave: [6, 18], // the gold clay replaces the first standard of one wave in this index range (at most one per round)
  },

  // Zen (design 7.3).
  zen: {
    distanceMul: 0.55, // the Easy distance: Zen is practice
    speedMul: 0.8,
    patternMul: 1.3,
    gapS: 1.2, // same one-wave-at-a-time model as Time Attack
    doubleChance: 0.3,
    firstWaveS: 1.0,
    recentShots: 20,
    defaultStage: 'hills',
  },

  // Automatic waves of Time Attack and Zen: weighted single and double pull types per stage.
  waves: {
    meadow: {
      singles: [{ type: 'trapSingle', w: 3 }, { type: 'miniSingle', w: 1 }],
      doubles: [{ type: 'trapPair', w: 1 }],
    },
    hills: {
      singles: [{ type: 'skeetLSingle', w: 3 }, { type: 'skeetRSingle', w: 3 }, { type: 'trapSingle', w: 2 }],
      doubles: [{ type: 'skeetPair', w: 2 }, { type: 'trapPair', w: 1 }],
    },
    alpine: {
      singles: [
        { type: 'towerSingle', w: 2 }, { type: 'skeetLSingle', w: 1 }, { type: 'skeetRSingle', w: 1 }, { type: 'rabbitSingle', w: 1 },
        { type: 'battueSingle', w: 1 },
      ],
      doubles: [{ type: 'rabbitClay', w: 1 }, { type: 'towerSkeet', w: 1 }, { type: 'battuePair', w: 1 }, { type: 'skeetPair', w: 1 }],
    },
  },

  // Calibration test shot (architecture C-06): one slow standard clay every 3 s from the trap house, no score.
  practice: {
    firstS: 1.0,
    everyS: 3.0,
    kind: 'standard',
    house: 'trap',
    speed: 15,
    elevationDeg: [32, 36],
    azimuthDeg: [-10, 10],
    patternMul: 1.25,
    distanceMul: 1,
    defaultStage: 'hills',
  },

  // Juice that changes the game clock (design 8). reduceMotion disables both (events still fire with 0).
  juice: {
    hitStopMs: 40,
    killCam: { timeScale: 0.25, durationS: 0.45, zoom: 1.12 },
  },

  // 'ending' phase length before 'over' (real seconds).
  ending: { classic: 1.2, timeattack: 1.5, zen: 0, practice: 0 },

  // Ranks (design 5 and 7.2): Classic by percent of targets broken, Time Attack by score. Lower bounds, best first.
  ranks: {
    classic: [{ rank: 'S', min: 95 }, { rank: 'A', min: 85 }, { rank: 'B', min: 70 }, { rank: 'C', min: 50 }],
    // re-derived 2026-10-03 from simulated players (QA F1, review G-01; table in design 7.2): about 100 percent hits -> S,
    // 90 -> A, 75 -> B, 60 -> C, 40 -> D. The difficulties score within 5 percent of each other, so one table serves all three.
    timeattack: [{ rank: 'S', min: 175000 }, { rank: 'A', min: 85000 }, { rank: 'B', min: 33000 }, { rank: 'C', min: 17000 }],
    lowest: 'D',
  },

  defaults: { difficulty: 'normal', stage: 'hills' },
});
