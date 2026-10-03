// Audio configuration of Clay Rush: data only, every tunable number of the synthesised sound (architecture 6.4, design 8).
// OWNER: Render & Audio engineer. The engine reads `opts.config.audio` first when the caller passes one (game/config.js may carry an
// `audio` block), then these values.

export const AUDIO_CONFIG = Object.freeze({
  volumeDefault: 0.8,
  /** Master gain for a volume v (0..1): masterGain * v ^ masterExponent. */
  masterGain: 0.8,
  masterExponent: 2,
  compressor: Object.freeze({ threshold: -14, knee: 12, ratio: 4, attack: 0.003, release: 0.12 }),
  /** Stereo position of a cue with an x (playfield px): +-panMax at the field edges. */
  panMax: 0.7,
  /** Live voices at most (the lowest priority, oldest voice is dropped first). */
  voices: 24,
  /** Major pentatonic semitones (streak arpeggios). */
  pentatonic: Object.freeze([0, 2, 4, 7, 9, 12, 14, 16, 19, 21]),
  /** Where each launch house sits in the stereo field (as an x in playfield px): crossers come from the side they fly from. */
  houseX: Object.freeze({ trap: 960, skeetL: 220, skeetR: 1700, tower: 420, rabbitL: 160 }),
  /** Ambience loops per stage: wind (filtered noise, gusting), sparse birds or crickets (seconds between calls, min..max). */
  ambience: Object.freeze({
    fadeS: 0.9,
    gustEveryS: 1.6,
    windPerMs: 0.006,
    levels: Object.freeze({ playing: 1, countdown: 1, paused: 0.35, results: 0.6, menu: 0.85, other: 0.75 }),
    stages: Object.freeze({
      meadow: Object.freeze({ wind: 0.05, windHz: 520, rustle: 0.012, birds: Object.freeze([1.4, 4.2]), crickets: null }),
      hills: Object.freeze({ wind: 0.07, windHz: 440, rustle: 0.016, birds: Object.freeze([2.6, 7.5]), crickets: null }),
      alpine: Object.freeze({ wind: 0.1, windHz: 340, rustle: 0.02, birds: null, crickets: Object.freeze([0.25, 0.9]) }),
    }),
  }),
});
