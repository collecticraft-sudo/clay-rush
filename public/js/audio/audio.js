// WebAudio engine of Clay Rush: synthesised sound effects and stage ambience, no sample files. OWNER: Render & Audio engineer.
// Architecture 6.4, design 8.
//
// Signal chain:
//   voice mix (trim) -> [pan] -> gameBus | eventBus | uiBus | ambBus (gain 1, duckable) -> sfxBus
//          -> DynamicsCompressor (-14 dB, knee 12, ratio 4, attack 3 ms, release 120 ms)
//          -> masterFilter (lowpass 20000 Hz, Q 0.7; the kill cam dips it) -> safety soft clip (x0.5, WaveShaper) -> masterGain (0.8 * v^2)
//   voices with `wet` also feed a shared reverb (one generated 0.9 s stereo room) that returns into sfxBus
//   ambience: a persistent wind voice (noise -> lowpass, gusting) and a rustle (noise -> bandpass) on ambBus, plus sparse bird or cricket
//   calls scheduled by update()
//
// Rules: silent before unlock() (the context is created inside the first user gesture, autoplay policy); never throws (every public method
// is wrapped, a broken sound is dropped); at most 24 voices with priority gun > event > clay > UI > ambience (the oldest voice of the lowest
// priority is dropped), per-sound caps (`maxVoices`) and rate limits (`minGapMs`); fully playable with volume 0 or muted (nothing is
// synthesised); createContext is injectable so the tests use a fake AudioContext. Buffers are shared (one 2 s noise buffer, one impulse),
// the buses and the ambience voice are built once, and every finished voice is disconnected on the next prune.
//
// SOUNDS (play(id, params)): shot dryClick shellInsert gunOpen clayBreak goldBreak throw clayLand pullCue double streakUp stageClear
//   stageStart timeTick timeBonus timeUp slowmo bird cricket | countdown go record rankStamp resultsFanfare countTick | uiMove uiSelect
//   uiConfirm uiBack uiWhoosh uiError connectOk disconnect calStep calHold calOk calFail recenter
// handleGameEvent(ev) maps every GameEvent type (contracts.js GAME_EVENT); update(dtS, {screen, stageId, snapshot}) drives the ambience.
// UNVERIFIED-ON-HARDWARE: latency and loudness of the real output path (speakers, Bluetooth headphones) are not known.

import { AUDIO_CONFIG } from './audio-config.js';
import { BUS_OF, PRIORITY, RECIPES, buildRecipe } from './recipes.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const SILENT = 0.0001;
const PRUNE_EVERY_S = 0.25;
const REVERB_S = 0.9;
const REVERB_RETURN = 0.32;
const COUNTDOWN_RESET_S = 1.7;
const BUS_NAMES = Object.freeze(['game', 'event', 'ui', 'amb']);

/** The audio block in use: the caller's `config.audio` keys over AUDIO_CONFIG. */
function audioConfigOf(config) {
  const a = config && config.audio && typeof config.audio === 'object' ? config.audio : null;
  return a ? { ...AUDIO_CONFIG, ...a, ambience: a.ambience ?? AUDIO_CONFIG.ambience, houseX: a.houseX ?? AUDIO_CONFIG.houseX } : AUDIO_CONFIG;
}

/** Master gain for a volume 0..1 (0.8 * v^2 by default). */
export function masterGainFor(volume, audioConfig = AUDIO_CONFIG) {
  const v = clamp(Number.isFinite(volume) ? volume : 0, 0, 1);
  if (typeof audioConfig.masterCurve === 'function') return audioConfig.masterCurve(v);
  return (audioConfig.masterGain ?? 0.8) * v ** (audioConfig.masterExponent ?? 2);
}

/** Soft clip curve over the input range [-2, 2] (the stage halves the signal first): linear to 0.7, tanh knee above, bounded by 1. */
export function softClip(x) {
  const a = Math.abs(x);
  if (a <= 0.7) return x;
  return Math.sign(x) * (0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3));
}

/** The names of the simple per-sound functions the engine exposes for the UI: name -> [sound id, how the arguments map to params]. */
export const NAMED = Object.freeze({
  uiMove: ['uiMove', () => ({})],
  uiSelect: ['uiSelect', () => ({})],
  uiConfirm: ['uiConfirm', () => ({})],
  uiBack: ['uiBack', () => ({})],
  uiError: ['uiError', () => ({})],
  uiWhoosh: ['uiWhoosh', (reverse) => ({ reverse: !!reverse })],
  countdown: ['countdown', (n) => (Number.isFinite(n) ? { n } : {})],
  go: ['go', () => ({})],
  record: ['record', () => ({})],
  countTick: ['countTick', (progress) => ({ progress })],
  rankStamp: ['rankStamp', () => ({})],
  resultsFanfare: ['resultsFanfare', (rank) => ({ rank })],
  recenter: ['recenter', () => ({})],
  connectOk: ['connectOk', () => ({})],
});

/** Ambience level for a screen (1 while playing, ducked in pause). */
export function ambienceLevelFor(screen, audioConfig = AUDIO_CONFIG) {
  const L = audioConfig.ambience.levels;
  if (typeof screen !== 'string') return L.other;
  return L[screen] ?? L.other;
}


/**
 * @param {{clock?:any, createContext?:()=>any, mute?:boolean, config?:any, random?:()=>number}} [opts]
 *   mute: the engine never creates a context (?mute=1, tests). random: cosmetic randomness (default Math.random).
 */
export function createAudio(opts = {}) {
  const A = audioConfigOf(opts.config);
  const AMB = A.ambience;
  const random = opts.random ?? Math.random;
  const makeContext = opts.createContext ?? (() => {
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) throw new Error('no AudioContext');
    return new Ctor({ latencyHint: 'interactive' });
  });

  let ctx = null;
  let bus = null; // sfxBus
  const buses = { game: null, event: null, ui: null, amb: null };
  let reverbIn = null;
  let compressor = null;
  let masterFilter = null;
  let masterGain = null;
  let noiseBuffer = null;
  let volume = A.volumeDefault;
  let muted = false;
  const voices = []; // {id, prio, endAt, nodes, sources, out}
  const retiring = [];
  const stats = { played: 0, dropped: 0, evicted: 0, errors: 0, ducked: 0, rateLimited: 0, events: 0 };
  const duckState = { game: { until: 0, amount: 1 }, event: { until: 0, amount: 1 }, ui: { until: 0, amount: 1 }, amb: { until: 0, amount: 1 } };
  const lastPlayAt = new Map();
  const seq = { flip: false, countdownAt: -1, countdownIdx: 0, lastPrune: 0 };
  let shotsSinceOpen = 0; // the gun opens (sound) only when something was fired since it last opened
  // ambience
  let amb = null; // {src, filter, gain, rSrc, rFilter, rGain}
  const ambState = { stage: null, level: 0, wind: -1, gustT: 0, gust: 1, birdT: 2, cricketT: 0.5, windHz: 0 };

  const running = () => !!ctx && ctx.state !== 'closed' && ctx.state !== 'suspended';
  const now = () => ctx.currentTime;

  function safe(fn) {
    try {
      return fn();
    } catch {
      stats.errors++;
      return undefined;
    }
  }

  // ---------------------------------------------------------------- graph construction
  function buildImpulse() {
    const len = Math.max(64, Math.floor(ctx.sampleRate * REVERB_S));
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const a = 0.55 + 0.4 * t;
        lp = a * lp + (1 - a) * (random() * 2 - 1);
        d[i] = lp * (1 - t) ** 3.2 * (i < 48 ? i / 48 : 1);
      }
    }
    return ir;
  }

  function buildChain() {
    bus = ctx.createGain();
    bus.gain.value = 1;
    compressor = ctx.createDynamicsCompressor();
    const c = A.compressor;
    compressor.threshold.value = c.threshold;
    compressor.knee.value = c.knee;
    compressor.ratio.value = c.ratio;
    compressor.attack.value = c.attack;
    compressor.release.value = c.release;
    masterFilter = ctx.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.value = 20000;
    masterFilter.Q.value = 0.7;
    bus.connect(compressor);
    compressor.connect(masterFilter);
    const preClip = ctx.createGain();
    preClip.gain.value = 0.5;
    let clipOut = null;
    if (typeof ctx.createWaveShaper === 'function') {
      clipOut = ctx.createWaveShaper();
      const n = 4097;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = softClip(((i / (n - 1)) * 2 - 1) * 2);
      clipOut.curve = curve;
      clipOut.oversample = 'none';
    }
    for (const k of BUS_NAMES) {
      buses[k] = ctx.createGain();
      buses[k].gain.value = 1;
      buses[k].connect(bus);
    }
    if (typeof ctx.createConvolver === 'function') {
      reverbIn = ctx.createGain();
      reverbIn.gain.value = 1;
      const conv = ctx.createConvolver();
      conv.buffer = buildImpulse();
      const reverbOut = ctx.createGain();
      reverbOut.gain.value = REVERB_RETURN;
      reverbIn.connect(conv);
      conv.connect(reverbOut);
      reverbOut.connect(bus);
    }
    masterGain = ctx.createGain(); // created last on purpose: tests find it as the last gain of an idle engine
    masterGain.gain.value = muted ? 0 : masterGainFor(volume, A);
    if (clipOut) {
      masterFilter.connect(preClip);
      preClip.connect(clipOut);
      clipOut.connect(masterGain);
    } else {
      preClip.gain.value = 1;
      masterFilter.connect(preClip);
      preClip.connect(masterGain);
    }
    masterGain.connect(ctx.destination);
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = random() * 2 - 1;
  }

  function unlock() {
    if (opts.mute) return;
    safe(() => {
      if (!ctx) {
        ctx = makeContext();
        buildChain();
      }
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    });
  }

  const panFor = (x) => clamp(((x - 960) / 960) * A.panMax, -A.panMax, A.panMax);

  function makePanner(x) {
    if (typeof ctx.createStereoPanner !== 'function') return null;
    const p = ctx.createStereoPanner();
    p.pan.value = panFor(x);
    return p;
  }

  function setParam(param, spec, t0, exponential = true) {
    if (typeof spec === 'number') {
      param.setValueAtTime(spec, t0);
    } else {
      param.setValueAtTime(spec.from, t0);
      if (exponential) param.exponentialRampToValueAtTime(Math.max(1, spec.to), t0 + spec.ms / 1000);
      else param.linearRampToValueAtTime(spec.to, t0 + spec.ms / 1000);
    }
  }

  // ---------------------------------------------------------------- voices
  function retire(v) {
    const t = now();
    if (v.out && v.out.gain && typeof v.out.gain.setTargetAtTime === 'function') {
      v.out.gain.cancelScheduledValues(t);
      v.out.gain.setTargetAtTime(SILENT, t, 0.006);
    }
    for (const s of v.sources) safe(() => s.stop(t + 0.04));
    v.releaseAt = t + 0.06;
    retiring.push(v);
  }

  function releaseNodes(v) {
    for (const n of v.nodes) safe(() => n.disconnect());
    v.nodes.length = 0;
  }

  function prune() {
    const t = now();
    seq.lastPrune = t;
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].endAt <= t) {
        releaseNodes(voices[i]);
        voices.splice(i, 1);
      }
    }
    for (let i = retiring.length - 1; i >= 0; i--) {
      if (retiring[i].releaseAt <= t) {
        releaseNodes(retiring[i]);
        retiring.splice(i, 1);
      }
    }
  }

  function admit(recipe) {
    prune();
    if (recipe.maxVoices) {
      let count = 0;
      let oldest = -1;
      for (let i = 0; i < voices.length; i++) {
        if (voices[i].id !== recipe.id) continue;
        count++;
        if (oldest < 0 || voices[i].endAt < voices[oldest].endAt) oldest = i;
      }
      if (count >= recipe.maxVoices) {
        retire(voices[oldest]);
        voices.splice(oldest, 1);
        stats.evicted++;
      }
    }
    if (voices.length < A.voices) return true;
    let victim = -1;
    for (let i = 0; i < voices.length; i++) {
      if (victim < 0 || voices[i].prio < voices[victim].prio || (voices[i].prio === voices[victim].prio && voices[i].endAt < voices[victim].endAt)) victim = i;
    }
    if (voices[victim].prio > recipe.priority) {
      stats.dropped++;
      return false;
    }
    retire(voices[victim]);
    voices.splice(victim, 1);
    stats.evicted++;
    return true;
  }

  function playRecipe(recipe, params) {
    if (!admit(recipe)) return;
    const t0 = now() + 0.005;
    const nodes = [];
    const voice = { id: recipe.id, prio: recipe.priority, endAt: t0 + recipe.durationMs / 1000 + 0.05, nodes, sources: [], out: null };
    const out = ctx.createGain();
    out.gain.value = recipe.trim ?? 1;
    nodes.push(out);
    voice.out = out;
    let head = out;
    if (params && typeof params.x === 'number' && recipe.layers.some((l) => l.pan)) {
      const p = makePanner(params.x);
      if (p) {
        out.connect(p);
        nodes.push(p);
        head = p;
      }
    }
    head.connect(buses[BUS_OF[recipe.category]] ?? bus);
    if (recipe.wet > 0 && reverbIn) {
      const send = ctx.createGain();
      send.gain.value = recipe.wet;
      head.connect(send);
      send.connect(reverbIn);
      nodes.push(send);
    }
    for (const layer of recipe.layers) {
      const start = t0 + layer.startMs / 1000;
      const end = start + layer.endMs / 1000;
      let src;
      if (layer.type === 'osc') {
        src = ctx.createOscillator();
        src.type = layer.wave;
        setParam(src.frequency, layer.freq, start);
        if (layer.detuneCents) src.detune.value = layer.detuneCents;
      } else {
        src = ctx.createBufferSource();
        src.buffer = noiseBuffer;
        src.loop = true;
      }
      let node = src;
      if (layer.filter) {
        const f = ctx.createBiquadFilter();
        f.type = layer.filter.type;
        setParam(f.frequency, layer.filter.freq, start);
        f.Q.value = layer.filter.Q ?? 0.7;
        node.connect(f);
        node = f;
        nodes.push(f);
      }
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(SILENT, start);
      gain.gain.linearRampToValueAtTime(layer.gain, start + Math.min(layer.attackMs, layer.endMs) / 1000);
      gain.gain.exponentialRampToValueAtTime(SILENT, Math.max(end, start + 0.006));
      node.connect(gain);
      nodes.push(gain);
      if (layer.lfo) {
        const lfoOsc = ctx.createOscillator();
        lfoOsc.frequency.value = layer.lfo.freq;
        const depth = ctx.createGain();
        depth.gain.value = layer.gain * layer.lfo.depth;
        lfoOsc.connect(depth);
        depth.connect(gain.gain);
        lfoOsc.start(start);
        lfoOsc.stop(end + 0.03);
        voice.sources.push(lfoOsc);
        nodes.push(lfoOsc, depth);
      }
      gain.connect(out);
      if (layer.type === 'noise') src.start(start, random() * 1.5);
      else src.start(start);
      src.stop(end + 0.03);
      voice.sources.push(src);
      nodes.push(src);
    }
    voices.push(voice);
    stats.played++;
    if (recipe.masterFilter) applyMasterFilter(recipe.masterFilter);
    if (recipe.duck) for (const d of recipe.duck) for (const g of d.groups) duckGroup(g, d.amount, d.ms);
  }

  // ---------------------------------------------------------------- ducking and the master filter
  function duckGroup(group, amount, ms) {
    const g = buses[group];
    const st = duckState[group];
    if (!g || !st) return;
    const t = now();
    const a = clamp(Number.isFinite(amount) ? amount : 1, 0, 1);
    const until = t + Math.max(0, ms) / 1000;
    if (st.until > t) {
      st.amount = Math.min(st.amount, a);
      st.until = Math.max(st.until, until);
    } else {
      st.amount = a;
      st.until = until;
    }
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(st.amount, t, 0.04);
    g.gain.setTargetAtTime(1, st.until, 0.12);
    stats.ducked++;
  }

  function applyMasterFilter(mf) {
    const f = masterFilter.frequency;
    const t = now();
    if (mf.dipHz !== undefined) {
      f.cancelScheduledValues(t);
      f.setValueAtTime(20000, t);
      f.linearRampToValueAtTime(mf.dipHz, t + mf.downMs / 1000);
      f.linearRampToValueAtTime(20000, t + (mf.downMs + mf.upMs) / 1000);
    }
  }

  // ---------------------------------------------------------------- public API
  function resolveParams(id, params) {
    if (id === 'uiMove') {
      seq.flip = !seq.flip;
      return { ...params, flip: seq.flip };
    }
    if (id === 'countdown') {
      if (params && Number.isFinite(params.n)) return params;
      const t = now();
      if (seq.countdownAt < 0 || t - seq.countdownAt > COUNTDOWN_RESET_S) seq.countdownIdx = 0;
      seq.countdownAt = t;
      const n = Math.max(1, 3 - seq.countdownIdx);
      seq.countdownIdx++;
      return { ...params, n };
    }
    if (id === 'go') {
      seq.countdownAt = -1;
      seq.countdownIdx = 0;
    }
    if (id === 'clayBreak' || id === 'goldBreak') return { jitter: 0.95 + random() * 0.1, ...params };
    return params ?? {};
  }

  function play(id, params) {
    safe(() => {
      if (!running()) return;
      if (volume <= 0 || muted) return;
      if (!RECIPES[id]) return;
      const p = resolveParams(id, params);
      const recipe = buildRecipe(id, p);
      if (recipe.minGapMs) {
        const t = now();
        const last = lastPlayAt.get(id);
        if (last !== undefined && (t - last) * 1000 < recipe.minGapMs) {
          stats.rateLimited++;
          return;
        }
        lastPlayAt.set(id, t);
      }
      playRecipe(recipe, p);
    });
  }

  function duck(group, amount, ms) {
    safe(() => {
      if (!running()) return;
      duckGroup(group, amount, ms);
    });
  }

  function stop(id) {
    safe(() => {
      if (!ctx) return;
      for (let i = voices.length - 1; i >= 0; i--) {
        if (voices[i].id === id) {
          retire(voices[i]);
          voices.splice(i, 1);
        }
      }
    });
  }

  const houseX = (h) => (A.houseX && Number.isFinite(A.houseX[h]) ? A.houseX[h] : 960);

  /** Map one GameEvent (contracts.js GAME_EVENT) to its sound. Every type is handled; some are deliberately silent. */
  function handleGameEvent(ev) {
    safe(() => {
      if (!running() || !ev || typeof ev.type !== 'string') return;
      stats.events++;
      switch (ev.type) {
        case 'shot':
          shotsSinceOpen++;
          play('shot', { shell: ev.shell, x: ev.x });
          break;
        case 'dryFire': play('dryClick', { x: ev.x }); break;
        case 'hit':
          if (ev.kind === 'gold') play('goldBreak', { x: ev.x, z: ev.z });
          else play('clayBreak', { x: ev.x, z: ev.z, centre: !!ev.centre });
          break;
        case 'lost': if (ev.reason === 'ground') play('clayLand', { x: ev.x }); break;
        case 'launch': play('throw', { x: houseX(ev.house) }); break;
        case 'pull': play('pullCue'); break;
        case 'ready': break; // the shells go in on 'reload done' (code review R-02: one insert per pull)
        case 'double': play('double', { big: false }); break;
        case 'twoWithOne': play('double', { big: true }); break;
        case 'streak': if ((ev.level ?? 1) >= 2) play('streakUp', { level: ev.level }); break;
        case 'stageClear': play('stageClear', { perfect: !!ev.perfect }); break;
        case 'stageStart': play('stageStart'); break;
        case 'reload':
          // Classic's reload start follows the settle that already opened the gun: open again only if something was fired since (R-02)
          if (ev.phase === 'start') {
            if (shotsSinceOpen > 0) play('gunOpen');
            shotsSinceOpen = 0;
          } else {
            play('shellInsert');
          }
          break;
        case 'killCam': if ((ev.durationMs ?? 0) > 0) play('slowmo'); break;
        case 'timeBonus': play('timeBonus'); break;
        case 'tick': play('timeTick', { urgent: (ev.secondsLeft ?? 99) <= 5 }); break;
        case 'timeUp': play('timeUp'); break;
        case 'phase':
          if (ev.phase === 'settle' && shotsSinceOpen > 0) {
            play('gunOpen');
            shotsSinceOpen = 0;
          }
          break;
        case 'hitStop': break; // the silence of the hit stop is the sound
        case 'practice': break; // practice rounds also emit launch / hit / lost, which play their own sounds
        default: break;
      }
    });
  }

  // ---------------------------------------------------------------- ambience
  function ensureAmbience() {
    if (amb || !ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 480;
    filter.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(buses.amb);
    src.start(now(), random() * 1.5);
    const rSrc = ctx.createBufferSource();
    rSrc.buffer = noiseBuffer;
    rSrc.loop = true;
    const rFilter = ctx.createBiquadFilter();
    rFilter.type = 'bandpass';
    rFilter.frequency.value = 2400;
    rFilter.Q.value = 0.7;
    const rGain = ctx.createGain();
    rGain.gain.value = 0;
    rSrc.connect(rFilter);
    rFilter.connect(rGain);
    rGain.connect(buses.amb);
    rSrc.start(now(), random() * 1.5);
    amb = { src, filter, gain, rSrc, rFilter, rGain };
  }

  /**
   * Per frame: prunes finished voices (every 250 ms) and drives the ambience of `stageId` (wind level and gusts, filter, sparse calls)
   * at the level of `screen` (1 playing, 0.35 paused, ...). No stage: the ambience fades out. Creates nodes only for the calls it plays.
   * @param {number} dtS
   * @param {{screen?:string, stageId?:string|null, snapshot?:object|null}} [c]
   */
  function update(dtS, c = {}) {
    safe(() => {
      if (!running()) return;
      const dt = clamp(Number.isFinite(dtS) ? dtS : 0, 0, 0.25);
      const t = now();
      if (t - seq.lastPrune > PRUNE_EVERY_S || t < seq.lastPrune) prune();
      const ctxIn = c ?? {};
      const stage = ctxIn.stageId && AMB.stages[ctxIn.stageId] ? ctxIn.stageId : null;
      const audible = volume > 0 && !muted;
      const level = stage && audible ? ambienceLevelFor(ctxIn.screen, A) : 0;
      if (!stage && !amb) return; // the ambience voice is built only once a stage is known
      ensureAmbience();
      const S = stage ? AMB.stages[stage] : null;
      ambState.gustT -= dt;
      if (ambState.gustT <= 0) {
        ambState.gustT = AMB.gustEveryS * (0.6 + random() * 0.8);
        ambState.gust = 0.65 + random() * 0.7;
      }
      const w = ctxIn.snapshot && ctxIn.snapshot.wind ? ctxIn.snapshot.wind : null;
      const snapWind = w ? Math.abs((Number(w.x) || 0) + (Number(w.gust) || 0)) : 0;
      const wind = S ? (S.wind + snapWind * AMB.windPerMs) * ambState.gust * level : 0;
      const rustle = S ? S.rustle * ambState.gust * level : 0;
      if (Math.abs(wind - ambState.wind) > 0.0015 || (wind === 0 && ambState.wind !== 0)) {
        amb.gain.gain.setTargetAtTime(wind, t, wind > ambState.wind ? AMB.fadeS * 0.6 : AMB.fadeS * 0.4);
        amb.rGain.gain.setTargetAtTime(rustle, t, AMB.fadeS * 0.5);
        ambState.wind = wind;
      }
      if (S && S.windHz !== ambState.windHz) {
        amb.filter.frequency.setTargetAtTime(S.windHz, t, AMB.fadeS);
        ambState.windHz = S.windHz;
      }
      ambState.stage = stage;
      ambState.level = level;
      if (!S || level < 0.5) return; // no calls in pause
      if (S.birds) {
        ambState.birdT -= dt;
        if (ambState.birdT <= 0) {
          ambState.birdT = S.birds[0] + random() * (S.birds[1] - S.birds[0]);
          play('bird', { species: Math.floor(random() * 3), pitch: 0.9 + random() * 0.2, x: 200 + random() * 1520 });
        }
      }
      if (S.crickets) {
        ambState.cricketT -= dt;
        if (ambState.cricketT <= 0) {
          ambState.cricketT = S.crickets[0] + random() * (S.crickets[1] - S.crickets[0]);
          play('cricket', { pitch: 0.97 + random() * 0.06, x: 100 + random() * 1720 });
        }
      }
    });
  }

  const engine = {
    unlock,
    get ready() { return !!ctx && ctx.state !== 'closed'; },
    setVolume(v01) {
      safe(() => {
        volume = clamp(Number.isFinite(v01) ? v01 : A.volumeDefault, 0, 1);
        if (ctx && masterGain) masterGain.gain.setTargetAtTime(muted ? 0 : masterGainFor(volume, A), now(), 0.02);
      });
    },
    setMuted(on) {
      safe(() => {
        muted = !!on;
        if (ctx && masterGain) masterGain.gain.setTargetAtTime(muted ? 0 : masterGainFor(volume, A), now(), 0.02);
      });
    },
    get muted() { return muted; },
    play,
    stop,
    duck,
    handleGameEvent,
    update,
    suspend() { safe(() => { if (ctx && typeof ctx.suspend === 'function') ctx.suspend(); }); },
    resume() { safe(() => { if (ctx && typeof ctx.resume === 'function') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } }); },
    dispose() {
      safe(() => {
        for (const v of voices) { for (const src of v.sources) safe(() => src.stop()); releaseNodes(v); }
        for (const v of retiring) releaseNodes(v);
        voices.length = 0;
        retiring.length = 0;
        if (amb) {
          safe(() => amb.src.stop());
          safe(() => amb.rSrc.stop());
          for (const n of Object.values(amb)) safe(() => n.disconnect());
          amb = null;
        }
        if (ctx && typeof ctx.close === 'function') ctx.close();
      });
    },
    /** Test / debug hook: voice list, counters and the ambience state. */
    getDebug() {
      return {
        voices: voices.map((v) => ({ id: v.id, prio: v.prio })),
        voiceCount: voices.length,
        retiring: retiring.length,
        stats: { ...stats },
        volume,
        muted,
        masterGain: masterGain ? masterGain.gain.value : null,
        buses: { game: buses.game ? buses.game.gain.value : null, event: buses.event ? buses.event.gain.value : null, ui: buses.ui ? buses.ui.gain.value : null, amb: buses.amb ? buses.amb.gain.value : null },
        reverb: !!reverbIn,
        ambience: { stage: ambState.stage, level: ambState.level, wind: ambState.wind, built: !!amb },
      };
    },
    PRIORITY,
  };
  for (const [name, [id, toParams]] of Object.entries(NAMED)) {
    engine[name] = (...args) => play(id, toParams(...args));
  }
  return engine;
}
