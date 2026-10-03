// Sound recipes of Clay Rush as PURE DATA (architecture 6.4, design 8): no AudioContext here, audio.js interprets these descriptions.
// OWNER: Render & Audio engineer. Nothing is a sample file: every sound is oscillators and filtered noise.
//
// Recipe = { id, category, priority, durationMs, layers: Layer[], masterFilter?, trim?, wet?, duck?, minGapMs?, maxVoices?, levelDb }
// Layer  = { type:'osc'|'noise', wave?, freq?, startMs, attackMs, endMs, gain, filter?, detuneCents?, pan?, lfo?, tag? }
//   freq   number (Hz) or { from, to, ms }   exponential glide over ms
//   filter { type:'lowpass'|'highpass'|'bandpass', freq: number | {from,to,ms}, Q? }
//   lfo    { freq, depth }  amplitude modulation
//   tag    free text for tests and the sound lab ("crack", "thump", "tail", ...), ignored by the engine
//   The gain envelope is: 0 -> gain in attackMs (linear), then exponential to 0.0001 at endMs (relative to the layer start).
//   durationMs is the latest layer end (startMs + endMs); tests check it.
// Recipe-level fields:
//   trim       linear gain of the voice mix (calibrated with the offline render so the peak lands on levelDb)
//   levelDb    target peak in dBFS after the compressor, before the master gain (LEVEL_DB per category)
//   wet        0..1 send to the shared reverb (the shot's field echo, chimes, fanfares)
//   duck       [{ groups:['game'|'event'|'ui'|'amb'], amount, ms }] applied when the voice starts
//   minGapMs   rate limit per id;  maxVoices  at most this many live voices of the id (the oldest is replaced)

const PENTATONIC = Object.freeze([0, 2, 4, 7, 9, 12, 14, 16, 19, 21]);

/** Voice priority: gun > event > clay > UI > ambience (a shot is never dropped for a bird). */
export const PRIORITY = Object.freeze({ amb: 0, ui: 1, clay: 3, event: 4, gun: 5 });

/** Which sub-bus a category plays on (all feed sfxBus). */
export const BUS_OF = Object.freeze({ gun: 'game', clay: 'game', event: 'event', ui: 'ui', amb: 'amb' });

/** Default peak target per category in dBFS (post compressor, pre master gain). */
export const LEVEL_DB = Object.freeze({ gun: -4, clay: -8, event: -10, ui: -20, amb: -28 });

/**
 * Calibration: the linear gain of each voice's mix, chosen so the offline render (test-support/audio/render-sounds.mjs, headless Chrome,
 * real compressor) lands the peak on the recipe's levelDb. Regenerate after changing a layer (`--suggest`).
 */
const TRIM = {
  shot: 1.09, dryClick: 1.848, clayBreak: 1.387, goldBreak: 1.73, shellInsert: 0.262, gunOpen: 0.819, pullCue: 0.526, throw: 1.064, double: 0.7, streakUp: 0.78,
  stageClear: 0.56, stageStart: 0.701, timeTick: 2.663, timeUp: 1.169, timeBonus: 1.151, clayLand: 1.359, slowmo: 1.983, bird: 0.62, cricket: 0.576,
  countdown: 0.73, go: 1.699, record: 0.535, rankStamp: 2.374, resultsFanfare: 0.541, countTick: 2.951,
  uiMove: 3.126, uiSelect: 0.406, uiConfirm: 0.406, uiBack: 0.46, uiWhoosh: 3.055, uiError: 0.75, connectOk: 0.499, disconnect: 0.387, calStep: 0.63,
  calHold: 1.303, calOk: 0.259, calFail: 2.265, recenter: 2.371,
};
/** streakUp by level: the trim of each run (the x4 run carries a taiko hit and a bell). */
const STREAK_TRIM = { 2: 0.748, 3: 0.81, 4: 0.383 };
/** Peak targets that differ from the category default. */
const LEVELS = {
  shot: -3, dryClick: -16, shellInsert: -15, gunOpen: -14, throw: -14, clayLand: -20, pullCue: -14, timeTick: -18, timeBonus: -14,
  stageStart: -14, slowmo: -16, cricket: -32, bird: -28, countdown: -18, go: -6, record: -10, rankStamp: -4, resultsFanfare: -10,
  countTick: -23, uiMove: -21, uiSelect: -19, uiConfirm: -19, uiBack: -20, uiWhoosh: -22, uiError: -20, connectOk: -19, disconnect: -19,
  calStep: -19, calHold: -24, calOk: -17, calFail: -21, recenter: -22, timeUp: -8, stageClear: -8, double: -10, streakUp: -10,
  goldBreak: -7, clayBreak: -8,
};

const ATTACK_MS = 4;

const osc = (wave, freq, endMs, gain, extra = {}) => ({ type: 'osc', wave, freq, startMs: 0, attackMs: ATTACK_MS, endMs, gain, ...extra });
const noise = (filter, endMs, gain, extra = {}) => ({ type: 'noise', filter, startMs: 0, attackMs: 3, endMs, gain, ...extra });
const at = (startMs, layer) => ({ ...layer, startMs });
const tag = (name, layer) => ({ ...layer, tag: name });
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function make(id, category, layers, extra = {}) {
  let end = 0;
  for (const l of layers) end = Math.max(end, l.startMs + l.endMs);
  return {
    id, category, priority: PRIORITY[category], durationMs: extra.durationMs ?? end, layers, levelDb: LEVELS[id] ?? LEVEL_DB[category], trim: TRIM[id] ?? 1, ...extra,
  };
}

const DUCK_AMB = [{ groups: ['amb'], amount: 0.3, ms: 700 }];
const DUCK_BIG = [{ groups: ['game', 'ui', 'amb'], amount: 0.45, ms: 450 }];

/** Taiko hit: a short pitched-down sine body plus a low noise slap. */
const taiko = (k = 1, startMs = 0) => [
  tag('taiko', at(startMs, osc('sine', { from: 120, to: 50, ms: 250 }, 250, 0.5 * k))),
  tag('taiko', at(startMs, noise({ type: 'lowpass', freq: 800 }, 120, 0.3 * k))),
];

/** Bell: inharmonic partials of `f` (ratios 1, 2.76, 5.4) with decays scaled by `len`. */
const bell = (f, k = 1, len = 1, startMs = 0) => [[1, 0.28, 1400], [2.76, 0.11, 900], [5.4, 0.05, 500]]
  .map(([r, g, ms]) => tag('bell', at(startMs, osc('sine', f * r, Math.round(ms * len), g * k, { attackMs: 5 }))));

const noteHz = (semi, base = 523.25) => base * 2 ** (semi / 12);

/** Pentatonic semitone of step n (0-based), capped at the scale's top. */
export function pentatonicSemitone(n) {
  return PENTATONIC[clamp(Math.round(n), 0, PENTATONIC.length - 1)];
}

/** Rank D..S (or 1..5) to an index 1..5. */
export function rankIndex(rank) {
  if (typeof rank === 'string') {
    const i = 'DCBAS'.indexOf(rank.toUpperCase());
    return i >= 0 ? i + 1 : 3;
  }
  return Number.isFinite(rank) ? clamp(Math.round(rank), 1, 5) : 3;
}

/** Distance factor of a break: 1 up to 15 m, falling to 0.55 at 60 m (far clays are quieter and duller). */
export function distanceGain(z) {
  if (!Number.isFinite(z)) return 1;
  return clamp(1 - (z - 15) / 100, 0.55, 1);
}

/** Wood-block pitch ladder of the countdown: 3 at 523 Hz, 2 at 659 Hz, 1 at 784 Hz. */
export const COUNTDOWN_HZ = Object.freeze({ 3: 523.25, 2: 659.25, 1: 783.99 });

/** The layers of a clay break (shared by clayBreak and goldBreak). */
function breakLayers(p) {
  const d = distanceGain(p.z);
  const j = p.jitter ?? 1;
  const centre = !!p.centre;
  const dark = 1 - (1 - d) * 0.8; // far: the crack loses its top
  const layers = [
    tag('crack', noise({ type: 'highpass', freq: 2600 * dark }, 28, 0.75 * d, { pan: true, attackMs: 1 })),
    tag('ping', osc('sine', { from: 2650 * j, to: 2450 * j, ms: 140 }, 150, 0.12 * d, { pan: true, attackMs: 1 })),
    tag('ping', osc('sine', 3930 * j, 110, 0.07 * d, { pan: true, attackMs: 1 })),
    tag('thock', osc('sine', { from: 430 * j, to: 150, ms: 60 }, 70, 0.32 * d, { pan: true, attackMs: 1 })),
    tag('crumble', at(6, noise({ type: 'bandpass', freq: { from: 2600 * dark, to: 900, ms: 230 }, Q: 1.1 }, 260, (centre ? 0.5 : 0.36) * d, { pan: true, attackMs: 4 }))),
  ];
  const debris = centre ? [[38, 0.2], [64, 0.17], [96, 0.14], [130, 0.11], [172, 0.08], [220, 0.05]] : [[40, 0.16], [78, 0.12], [124, 0.08], [176, 0.05]];
  for (const [ms, g] of debris) layers.push(tag('debris', at(ms, noise({ type: 'bandpass', freq: 1700 * dark, Q: 1.4 }, 22, g * d, { pan: true, attackMs: 1 }))));
  if (centre) {
    layers.push(tag('shatter', noise({ type: 'highpass', freq: 6000 * dark }, 90, 0.22 * d, { pan: true, attackMs: 1 })));
    layers.push(tag('puff', at(10, noise({ type: 'lowpass', freq: 900 }, 300, 0.28 * d, { pan: true, attackMs: 12 }))));
  }
  return layers;
}

/** id -> builder(params) -> recipe. Params are optional and documented per builder. */
export const RECIPES = Object.freeze({
  // ------------------------------------------------------------------------------------------------------------------- gun
  /**
   * The BOOM (design 8): a sharp crack, a noise blast falling from 5 kHz, a 60 Hz thump with a pitch drop, a sub and the field echo (a long
   * dark noise tail + the reverb). The second barrel (shell 1) is a little brighter. Ducks the ambience. params: shell, x
   */
  shot: (p = {}) => {
    const second = p.shell === 1;
    return make('shot', 'gun', [
      tag('crack', noise({ type: 'highpass', freq: second ? 3000 : 2500 }, 26, 0.9, { attackMs: 0.5 })),
      tag('mech', noise({ type: 'bandpass', freq: 3800, Q: 3 }, 10, 0.3, { attackMs: 0.5 })),
      tag('blast', noise({ type: 'lowpass', freq: { from: 5200, to: 280, ms: 260 } }, 330, 1.0, { attackMs: 1 })),
      tag('thump', osc('sine', { from: second ? 130 : 118, to: 46, ms: 180 }, 260, 1.0, { attackMs: 2 })),
      tag('sub', osc('sine', 60, 220, 0.55, { attackMs: 3 })),
      tag('tail', at(28, noise({ type: 'lowpass', freq: { from: 1250, to: 160, ms: 1280 } }, 1500, 0.3, { attackMs: 60 }))),
    ], { wet: 0.25, duck: DUCK_AMB });
  },

  /** Empty gun: the hammer falls on nothing (two small clicks). */
  dryClick: () => make('dryClick', 'gun', [
    tag('click', noise({ type: 'bandpass', freq: 3200, Q: 4 }, 8, 0.5, { attackMs: 0.5 })),
    tag('tick', osc('triangle', { from: 2200, to: 900, ms: 12 }, 14, 0.2, { attackMs: 1 })),
    tag('click', at(42, noise({ type: 'bandpass', freq: 2400, Q: 4 }, 8, 0.28, { attackMs: 0.5 }))),
  ]),

  /** Two shells pushed into the chambers, then the action closes with a clack. */
  shellInsert: () => make('shellInsert', 'gun', [
    ...[0, 140].flatMap((s) => [
      tag('slide', at(s, noise({ type: 'bandpass', freq: 2500, Q: 2 }, 16, 0.4, { attackMs: 1 }))),
      tag('thunk', at(s + 4, osc('sine', { from: 310, to: 210, ms: 40 }, 46, 0.25, { attackMs: 1 }))),
    ]),
    tag('clack', at(300, noise({ type: 'bandpass', freq: 1800, Q: 1.5 }, 32, 0.55, { attackMs: 0.5 }))),
    tag('clack', at(300, osc('sine', { from: 190, to: 120, ms: 70 }, 80, 0.35, { attackMs: 1 }))),
  ]),

  /** The gun opens after a pull: top lever, hinge, and the ejectors tossing the empty hulls (two tinks, two soft landings). */
  gunOpen: () => make('gunOpen', 'gun', [
    tag('lever', noise({ type: 'bandpass', freq: 2800, Q: 3 }, 12, 0.4, { attackMs: 0.5 })),
    tag('hinge', at(20, osc('sine', { from: 170, to: 110, ms: 120 }, 130, 0.3))),
    tag('hinge', at(20, noise({ type: 'lowpass', freq: 1200 }, 80, 0.25))),
    tag('eject', at(110, osc('sine', 3600, 70, 0.08, { attackMs: 1 }))),
    tag('eject', at(150, osc('sine', 4150, 60, 0.07, { attackMs: 1 }))),
    tag('land', at(520, osc('sine', 1800, 30, 0.05, { attackMs: 1 }))),
    tag('land', at(590, osc('sine', 1650, 30, 0.04, { attackMs: 1 }))),
  ]),

  // ------------------------------------------------------------------------------------------------------------------- clays
  /** A clay breaks: crack, ceramic ping, thock, crumble and a debris rattle; `centre` adds a shatter and a puff. params: x, z, centre, jitter */
  clayBreak: (p = {}) => make('clayBreak', 'clay', breakLayers(p), { maxVoices: 6, ...(p.centre ? { levelDb: -6, trim: TRIM.clayBreak * 1.34 } : {}) }),

  /** The gold clay: a centre break plus a shimmer of bright partials and a glitter (reverb). params: x, z */
  goldBreak: (p = {}) => {
    const layers = breakLayers({ ...p, centre: true });
    [1319, 1568, 1760, 2093, 2637].forEach((f, i) => layers.push(tag('shimmer', at(30 + 40 * i, osc('sine', f, 450, 0.1, { pan: true })))));
    [3136, 3951, 4699].forEach((f, i) => layers.push(tag('glitter', at(120 + 55 * i, osc('sine', f, 120, 0.035, { pan: true })))));
    return make('goldBreak', 'clay', layers, { wet: 0.3 });
  },

  /** The trap throws: a low clunk, the arm's spring twang and the clay's whoosh. params: x (the house) */
  throw: () => make('throw', 'clay', [
    tag('clunk', osc('sine', { from: 150, to: 55, ms: 120 }, 140, 0.45, { pan: true, attackMs: 2 })),
    tag('clunk', noise({ type: 'lowpass', freq: 700 }, 90, 0.3, { pan: true })),
    tag('twang', osc('triangle', { from: 320, to: 210, ms: 90 }, 120, 0.12, { pan: true })),
    tag('whoosh', at(30, noise({ type: 'bandpass', freq: { from: 700, to: 2600, ms: 260 }, Q: 1.5 }, 300, 0.1, { pan: true, attackMs: 60 }))),
  ], { maxVoices: 3 }),

  /** A clay that hits the ground: a soft thud. params: x */
  clayLand: () => make('clayLand', 'clay', [
    noise({ type: 'lowpass', freq: 420 }, 80, 0.25, { pan: true }),
    osc('sine', 90, 80, 0.2, { pan: true }),
  ], { maxVoices: 3 }),

  // ------------------------------------------------------------------------------------------------------------------- events
  /** "Pull!": a two-tone whistle (no voice), with a little breath. */
  pullCue: () => make('pullCue', 'event', [
    tag('tone', osc('sine', { from: 1750, to: 1860, ms: 150 }, 170, 0.22, { attackMs: 14 })),
    tag('tone', osc('triangle', { from: 1750, to: 1860, ms: 150 }, 170, 0.05, { attackMs: 14 })),
    tag('tone', at(190, osc('sine', { from: 2360, to: 2240, ms: 200 }, 260, 0.22, { attackMs: 14 }))),
    tag('tone', at(190, osc('triangle', { from: 2360, to: 2240, ms: 200 }, 260, 0.05, { attackMs: 14 }))),
    tag('breath', noise({ type: 'bandpass', freq: 2200, Q: 3 }, 450, 0.035, { attackMs: 30 })),
  ], { wet: 0.12 }),

  /** DOUBLE! (and TWO WITH ONE!, `big`): bright rising chimes. params: big */
  double: (p = {}) => {
    const notes = p.big ? [784, 1047, 1319, 1568] : [784, 1175];
    const layers = [];
    notes.forEach((f, i) => {
      layers.push(tag('chime', at(85 * i, osc('sine', f, 320, 0.18))));
      layers.push(tag('chime', at(85 * i, osc('triangle', f, 320, 0.12, { detuneCents: 5 }))));
    });
    layers.push(tag('sparkle', at(85 * notes.length, osc('sine', 3136, 140, 0.05))));
    return make('double', 'event', layers, { wet: 0.2, ...(p.big ? { trim: TRIM.double * 0.98 } : {}) });
  },

  /** The streak multiplier goes up: a pentatonic run with one more note per level, a taiko hit at x4. params: level (2..4) */
  streakUp: (p = {}) => {
    const level = clamp(Math.round(p.level ?? 2), 2, 4);
    const layers = [];
    for (let i = 0; i <= level; i++) {
      const f = noteHz(pentatonicSemitone(i + level - 1));
      layers.push(tag('note', at(60 * i, osc('sine', f, 200, 0.17))));
      layers.push(tag('note', at(60 * i, osc('triangle', f, 200, 0.1, { detuneCents: 6 }))));
    }
    if (level >= 4) layers.push(...taiko(0.6, 60 * level), ...bell(392, 0.6, 0.8, 60 * level));
    return make('streakUp', 'event', layers, { wet: 0.15, trim: STREAK_TRIM[level] });
  },

  /** Stage clear: a short fanfare; PERFECT STAGE adds the full run, a pad and a bell. Ducks the game. params: perfect */
  stageClear: (p = {}) => {
    const perfect = !!p.perfect;
    const notes = perfect ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : [523.25, 659.25, 783.99];
    const layers = [];
    notes.forEach((f, i) => {
      layers.push(tag('arp', at(90 * i, osc('sine', f, 320, 0.18))));
      layers.push(tag('arp', at(90 * i, osc('triangle', f, 320, 0.14))));
    });
    const tail = 90 * (notes.length - 1);
    layers.push(tag('pad', at(tail, osc('sine', 523.25, perfect ? 1200 : 600, 0.08, { attackMs: 50 }))));
    layers.push(tag('pad', at(tail, osc('sine', 783.99, perfect ? 1200 : 600, 0.07, { attackMs: 50 }))));
    if (perfect) layers.push(...bell(1046.5, 0.5, 1, tail), ...taiko(0.7, tail));
    return make('stageClear', 'event', layers, { wet: 0.28, duck: DUCK_BIG, ...(perfect ? { trim: 0.374 } : { levelDb: -10 }) });
  },

  /** A new stage: two soft horn notes. */
  stageStart: () => make('stageStart', 'event', [
    osc('triangle', 392, 260, 0.2, { filter: { type: 'lowpass', freq: 1400 }, attackMs: 30 }),
    at(220, osc('triangle', 523.25, 420, 0.2, { filter: { type: 'lowpass', freq: 1400 }, attackMs: 30 })),
  ], { wet: 0.25 }),

  /** Time Attack clock tick; params: urgent (last seconds: higher and with a thump). */
  timeTick: (p = {}) => make('timeTick', 'event', [
    osc('triangle', p.urgent ? 1400 : 1000, 30, 0.12),
    tag('click', noise({ type: 'bandpass', freq: 3000, Q: 1.2 }, 8, 0.05, { attackMs: 1 })),
    ...(p.urgent ? [tag('thump', osc('sine', 120, 70, 0.1))] : []),
  ], p.urgent ? { trim: TRIM.timeTick * 0.79, levelDb: -15 } : {}),

  /** Time Attack: +1.5 s for a broken clay. */
  timeBonus: () => make('timeBonus', 'event', [osc('sine', 1568, 200, 0.12), at(60, osc('sine', 2093, 240, 0.12))], { maxVoices: 3 }),

  /** TIME!: a two-voice horn and a bell. Ducks the game. */
  timeUp: () => make('timeUp', 'event', [
    tag('horn', osc('sawtooth', 440, 700, 0.12, { filter: { type: 'lowpass', freq: 1250 }, attackMs: 20 })),
    tag('horn', osc('sawtooth', 554.37, 700, 0.12, { filter: { type: 'lowpass', freq: 1250 }, attackMs: 20 })),
    ...bell(880, 0.6, 1.1, 0),
  ], { wet: 0.3, duck: DUCK_BIG }),

  /** Kill cam: a falling tone and the master low-pass dip (applied by the engine). */
  slowmo: () => make('slowmo', 'event', [osc('sine', { from: 300, to: 90, ms: 350 }, 350, 0.15)], { masterFilter: { dipHz: 1800, downMs: 60, upMs: 380 } }),

  // ------------------------------------------------------------------------------------------------------------------- ambience
  /** A sparse bird call (meadow, hills). params: species (0 down-chirps, 1 trill, 2 two-note whistle), x */
  bird: (p = {}) => {
    const sp = clamp(Math.round(p.species ?? 0), 0, 2);
    const k = p.pitch ?? 1;
    const layers = [];
    if (sp === 0) {
      for (let i = 0; i < 4; i++) layers.push(tag('chirp', at(75 * i, osc('sine', { from: 4300 * k, to: 2800 * k, ms: 45 }, 50, 0.06 - i * 0.008, { pan: true, attackMs: 3 }))));
    } else if (sp === 1) {
      for (let i = 0; i < 7; i++) layers.push(tag('trill', at(38 * i, osc('sine', (i % 2 ? 3500 : 4300) * k, 32, 0.045, { pan: true, attackMs: 3 }))));
    } else {
      layers.push(tag('whistle', osc('sine', { from: 2600 * k, to: 3400 * k, ms: 120 }, 130, 0.06, { pan: true, attackMs: 20 })));
      layers.push(tag('whistle', at(170, osc('sine', { from: 3400 * k, to: 2900 * k, ms: 150 }, 160, 0.06, { pan: true, attackMs: 20 }))));
    }
    return make('bird', 'amb', layers, { maxVoices: 2, minGapMs: 400, wet: 0.2 });
  },

  /** Crickets of the alpine dusk: three short pulses at 4.6 kHz. params: x, pitch */
  cricket: (p = {}) => {
    const f = 4600 * (p.pitch ?? 1);
    return make('cricket', 'amb', [0, 45, 90].map((s) => tag('pulse', at(s, osc('sine', f, 26, 0.03, { pan: true, attackMs: 3 })))), { maxVoices: 3, minGapMs: 120 });
  },

  // ------------------------------------------------------------------------------------------------------------------- round, UI
  /** Wood block that rises with the number (3 at 523 Hz, 2 at 659 Hz, 1 at 784 Hz). params: n */
  countdown: (p = {}) => {
    const base = COUNTDOWN_HZ[p.n] ?? COUNTDOWN_HZ[3];
    return make('countdown', 'ui', [
      tag('wood', osc('sine', { from: base * 1.68, to: base * 1.145, ms: 70 }, 100, 0.22)),
      tag('tick', noise({ type: 'bandpass', freq: 2500, Q: 1.5 }, 15, 0.15, { attackMs: 1 })),
      tag('thump', osc('sine', 110, 90, 0.2)),
    ]);
  },
  /** GO: a bell over a taiko hit and a burst. */
  go: () => make('go', 'event', [...bell(392, 1, 1.1), tag('burst', noise({ type: 'highpass', freq: 2000 }, 120, 0.15)), ...taiko(0.6)], { wet: 0.3 }),
  /** NEW BEST: the C major run. */
  record: () => make('record', 'event', [523.25, 587.33, 659.25, 783.99, 1046.5].flatMap((f, i) => [at(80 * i, osc('sine', f, 300, 0.18)), at(80 * i, osc('triangle', f, 300, 0.18))]), { wet: 0.2 }),
  /** The rank stamp lands: taiko hit with a crack and a deep body. Ducks. */
  rankStamp: () => make('rankStamp', 'gun', [
    ...taiko(1),
    tag('crack', noise({ type: 'highpass', freq: 3000 }, 12, 0.25)),
    tag('body', at(10, osc('sine', { from: 70, to: 38, ms: 400 }, 450, 0.35))),
  ], { wet: 0.2, duck: DUCK_BIG }),
  /** Results fanfare by rank (D..S or 1..5). params: rank */
  resultsFanfare: (p = {}) => {
    const rank = rankIndex(p.rank);
    const layers = [];
    if (rank === 1) {
      layers.push(tag('fall', osc('sine', 392, 260, 0.16)), tag('fall', osc('triangle', 392, 260, 0.14)));
      layers.push(tag('fall', at(170, osc('sine', 293.66, 520, 0.16))), tag('fall', at(170, osc('triangle', 293.66, 520, 0.14))));
      return make('resultsFanfare', 'event', layers, { wet: 0.2, levelDb: -12 });
    }
    const notes = [523.25, 587.33, 659.25, 783.99, 1046.5].slice(0, rank === 2 ? 3 : rank === 3 ? 4 : 5);
    notes.forEach((f, i) => layers.push(tag('arp', at(80 * i, osc('sine', f, 300, 0.18))), tag('arp', at(80 * i, osc('triangle', f, 300, 0.18)))));
    if (rank >= 4) {
      layers.push(tag('pad', at(80 * (notes.length - 1), osc('sine', 523.25, 900, 0.08, { attackMs: 60 }))));
      layers.push(tag('pad', at(80 * (notes.length - 1), osc('sine', 783.99, 900, 0.08, { attackMs: 60 }))));
    }
    if (rank === 5) layers.push(...bell(523.25, 0.5, 1, 0));
    return make('resultsFanfare', 'event', layers, { wet: 0.25 });
  },
  /** Count-up tick on the results screen: 1800 -> 2600 Hz with the progress. params: progress (0..1) */
  countTick: (p = {}) => make('countTick', 'ui', [osc('triangle', 1800 + 800 * clamp(p.progress ?? 0, 0, 1), 12, 0.07, { attackMs: 2 })], { maxVoices: 4 }),
  /** Stick tick: wood tick, pitch alternates +-3 percent (params.flip), at most one per 40 ms. */
  uiMove: (p = {}) => {
    const k = p.flip ? 1.03 : 0.97;
    return make('uiMove', 'ui', [
      tag('wood', osc('sine', { from: 1500 * k, to: 1100 * k, ms: 18 }, 18, 0.07, { attackMs: 2 })),
      tag('tick', noise({ type: 'bandpass', freq: 3000, Q: 1.2 }, 8, 0.04, { attackMs: 1 })),
    ], { minGapMs: 40, maxVoices: 3 });
  },
  /** Confirm: sine 660 then 880 Hz plus a soft bell. `uiConfirm` is the same sound under the architecture's name. */
  uiSelect: () => make('uiSelect', 'ui', [osc('sine', 660, 80, 0.15), at(80, osc('sine', 880, 80, 0.15)), tag('bell', at(80, osc('sine', 1760, 250, 0.05)))], { wet: 0.08 }),
  uiConfirm: () => make('uiConfirm', 'ui', [osc('sine', 660, 80, 0.15), at(80, osc('sine', 880, 80, 0.15)), tag('bell', at(80, osc('sine', 1760, 250, 0.05)))], { wet: 0.08 }),
  uiBack: () => make('uiBack', 'ui', [osc('sine', 660, 80, 0.15), at(80, osc('sine', 440, 80, 0.15))]),
  /** Transition whoosh (reverse for the reveal). params: reverse */
  uiWhoosh: (p = {}) => make('uiWhoosh', 'ui', [
    tag('sweep', noise({ type: 'bandpass', freq: p.reverse ? { from: 2400, to: 600, ms: 220 } : { from: 400, to: 2400, ms: 220 }, Q: 1.5 }, 240, 0.1, { attackMs: 40 })),
  ], p.reverse ? { trim: TRIM.uiWhoosh * 0.56 } : {}),
  uiError: () => make('uiError', 'ui', [
    tag('pulse', osc('square', 180, 60, 0.08, { filter: { type: 'lowpass', freq: 900 } })),
    tag('pulse', at(110, osc('square', 180, 60, 0.08, { filter: { type: 'lowpass', freq: 900 } }))),
  ]),
  connectOk: () => make('connectOk', 'ui', [osc('sine', 660, 100, 0.15), at(100, osc('sine', 990, 200, 0.15))], { wet: 0.05 }),
  disconnect: () => make('disconnect', 'ui', [osc('triangle', 440, 150, 0.2), at(150, osc('triangle', 330, 150, 0.2)), noise({ type: 'lowpass', freq: 800 }, 100, 0.1)]),
  calStep: () => make('calStep', 'ui', [osc('sine', 784, 120, 0.12), at(90, osc('sine', 1047, 120, 0.12))]),
  /** params: ms (hold duration): a sine glides 400 -> 800 Hz over the hold; the engine stops it as soon as the controller moves. */
  calHold: (p = {}) => {
    const ms = Math.max(200, p.ms ?? 2000);
    return make('calHold', 'ui', [osc('sine', { from: 400, to: 800, ms }, ms, 0.05)]);
  },
  calOk: () => make('calOk', 'ui', [
    osc('sine', 660, 80, 0.15), at(80, osc('sine', 880, 80, 0.15)),
    ...[523.25, 587.33, 659.25].flatMap((f, i) => [at(180 + 80 * i, osc('sine', f, 300, 0.18)), at(180 + 80 * i, osc('triangle', f, 300, 0.18))]),
  ], { wet: 0.1 }),
  calFail: () => make('calFail', 'ui', [osc('square', 140, 150, 0.08, { filter: { type: 'lowpass', freq: 800 } })]),
  recenter: () => make('recenter', 'ui', [osc('sine', 880, 60, 0.08)]),
});

export const SOUND_IDS = Object.freeze(Object.keys(RECIPES));

/** Build the recipe for a sound id. Throws for an unknown id (audio.js catches it: audio never throws). */
export function buildRecipe(id, params = {}) {
  const b = RECIPES[id];
  if (!b) throw new Error(`recipes.js: unknown sound "${id}"`);
  return b(params);
}
