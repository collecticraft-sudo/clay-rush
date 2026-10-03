// The Clay Rush game: fixed-timestep world, phases, shots, scoring, timers, events. OWNER: Gameplay engineer.
//
// Pure logic (architecture 0.5): no DOM, no clock, no Math.random. Time advances ONLY through update(frameDtS, shots, nowMs).
// Same (mode, seed, options) and the same sequence of update() calls give the same snapshots and events.
//
// Two time bases (architecture 5):
//   * REAL ticks of DT = 1/120 s: phase timers (pull delay, settle, stage card, ending), the Time Attack clock and waves,
//     reloads, the practice throws, the kill-cam and hit-stop clocks, `t`.
//   * WORLD steps: run when the world accumulator (fed with DT * timeScale) allows it: target physics, `tWorld`, `ageS`.
//
// Shots are resolved at their press time Shot.t (ms on the clock of nowMs), never against newer positions:
//   - the frame [simMs, nowMs] is simulated tick by tick; before a shot, the world is advanced to the last tick ending at or
//     before Shot.t, then the targets are evaluated AT Shot.t (second-order extrapolation inside the tick: <= 1 tick);
//   - a shot older than the simulation (a late report) is evaluated by rewinding the same way, at most maxRewindMs;
//   - Hard: each target is evaluated at world time w(Shot.t) + z / pelletSpeed (z at the press), when the world reaches that time.

import { CONFIG } from './config.js';
import { WORLD, project } from '../shared/world.js';
import { FIELD } from '../shared/playfield.js';
import { hash32 } from '../shared/rng.js';
import { modeTraits } from './modes.js';
import { buildStagePlan, drawWave, stageIndexOf } from './stages.js';
import { streamRng, fairLaunch, drawParams, makeBody, finishBody, housePos } from './launch.js';
import { stepBody, lostReason, windAt, accelOf } from './physics.js';
import { projectCandidates, assistAim, testHit, travelTimeS } from './shot.js';
import { multiplierFor, multiplierProgress, basePoints } from './scoring.js';
import { TimeScaler } from './timescale.js';
import { rankFor } from './ranks.js';

const DT = CONFIG.time.dt;
const DT_MS = DT * 1000;
const EPS = 1e-9;
const EPS_MS = 1e-6;
const MS = 1000;
const ST = CONFIG.streams;
const C = CONFIG.classic;
const TA = CONFIG.timeattack;
const ZEN = CONFIG.zen;
const PR = CONFIG.practice;
const DEG = 180 / Math.PI;
const PULL_K = ST.pullStride;
const WAVE_K = ST.waveBase;
const PRACTICE_K = ST.practiceBase;
const GOLD_K = ST.goldKey;
const SCREEN_VEL_PROBE_S = CONFIG.time.velocityProbeS;
const INT31 = 0x7fffffff; // shardSeed is a non-negative 31-bit integer

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const copyEvent = (e) => {
  const c = { ...e };
  if (Array.isArray(c.ids)) c.ids = c.ids.slice();
  if (Array.isArray(c.hitIds)) c.hitIds = c.hitIds.slice();
  return c;
};

class Engine {
  constructor(mode, seed, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    this.traits = modeTraits(mode, o); // TypeError for an unknown mode
    this.mode = mode;
    this.seed = Number.isFinite(seed) ? seed : 0;
    this.seed32 = this.seed >>> 0;
    this.difficulty = this.traits.difficulty;
    this.opts = { assist: o.assist === true, autoPull: o.autoPull === true, reduceMotion: o.reduceMotion === true };
    this.patternMul = this.traits.patternMul * (this.opts.assist ? CONFIG.assist.patternMul : 1);
    this.k = this.traits.k; // world scale: the difficulty's distance (Easy closer, Hard farther)
    this.scaler = new TimeScaler(this.opts.reduceMotion);

    // clocks
    this.tick = 0;
    this.t = 0;
    this.worldSteps = 0;
    this.tWorld = 0;
    this.realAccum = 0;
    this.worldAccum = 0;
    this.timeScale = 1;
    this.lastNowMs = null;
    this.simMs = 0; // clock ms that the simulation has reached (end of the last real tick)
    this.hist = []; // [{ms, w}] continuous world time at the end of recent real ticks (rewind of late shots)
    this.histMax = Math.ceil(CONFIG.time.maxRewindMs / DT_MS) + 3;

    // phase
    this.phase = null;
    this.phaseT = 0;
    this.endReason = null;
    this.result = null;
    this.endingLeftS = 0;

    // stage and pulls
    this.stageIndex = 0;
    this.stageId = this.traits.stageIds[0];
    this.wind = { base: 0, gustAmp: 0, gustPeriodS: 1, phase: 0 };
    this.windNow = { x: 0, gust: 0 };
    this.plan = [];
    this.pullIndex = 0;
    this.pull = null;
    this.stageStats = { presented: 0, broken: 0 };
    this.pullDelayLeftS = 0;
    this.settleLeftS = 0;
    this.cardLeftS = 0;
    this.readyT = 0;

    // entities
    this.targets = [];
    this.nextId = 0;
    this.pending = []; // scheduled launches [{atT, member, ctx}]
    this.volleys = []; // Hard shots whose pellets are still travelling
    this.houseLaunchT = {};
    this.launchCounter = 0;
    this.debugK = 0;

    // gun
    this.shells = { loaded: this.traits.capacity, capacity: this.traits.capacity, reloadLeftS: 0, loading: false };

    // score and stats
    this.score = 0;
    this.streak = 0;
    this.stats = { presented: 0, broken: 0, lost: 0, shots: 0, hits: 0, centre: 0, doubles: 0, bestStreak: 0 };
    this.killCam = null;

    // Time Attack and Zen
    this.timeLeft = this.traits.timerS;
    this.lastTickSec = Infinity;
    this.waveK = 0;
    this.nextWaveT = this.traits.waves ? (this.mode === 'zen' ? ZEN.firstWaveS : TA.firstWaveS) : Infinity;
    this.waveIdle = true; // no wave in the air: the next one may start at nextWaveT
    this.goldWaveK = this.traits.waves && this.traits.gold ? streamRng(this.seed32, ST.wave, GOLD_K).int(TA.goldWave[0], TA.goldWave[1]) : -1;
    this.recent = [];

    // practice round
    this.practice = this.traits.practice ? { shown: 0, hit: 0, nextThrowT: PR.firstS } : null;

    this.autoLaunch = null; // null: the mode's own behaviour; true/false: debugSetAutoLaunch

    // events
    this.seq = 0;
    this.outbox = [];
    this.log = [];

    this._start();
  }

  // ------------------------------------------------------------------------------------------------------------- events

  _emit(type, fields) {
    const ev = { seq: ++this.seq, t: this.t, type, ...fields };
    this.outbox.push(ev);
    if (this.outbox.length > CONFIG.events.maxUndrained) this.outbox.shift();
    this.log.push(ev);
    if (this.log.length > CONFIG.events.ring) this.log.shift();
    return ev;
  }

  _setPhase(p) {
    if (this.phase === p) return;
    this.phase = p;
    this.phaseT = this.t;
    this._emit('phase', { phase: p });
  }

  // ------------------------------------------------------------------------------------------------------------- setup

  _start() {
    this._setupStage(0);
    if (this.traits.pulls) this._enterReady();
    else this._setPhase('flight');
  }

  _stageCfg() {
    return CONFIG.stages[stageIndexOf(this.stageId)];
  }

  _setupStage(i) {
    this.stageIndex = i;
    this.stageId = this.traits.stageIds[i];
    const cfg = this._stageCfg();
    const rng = streamRng(this.seed32, ST.wind, i);
    const side = rng.sign();
    const phase = rng.range(0, 2 * Math.PI);
    const base = cfg.wind.speed * side * this.traits.windMul;
    this.wind = { base: base === 0 ? 0 : base, gustAmp: cfg.wind.gustAmp * this.traits.windMul, gustPeriodS: cfg.wind.gustPeriodS, phase };
    windAt(this.wind, this.tWorld, this.windNow);
    this.plan = this.traits.pulls ? buildStagePlan(stageIndexOf(this.stageId), streamRng(this.seed32, ST.plan, i)) : [];
    this.pullIndex = 0;
    this.pull = null;
    this.stageStats = { presented: 0, broken: 0 };
    this._emit('stageStart', { index: i, id: cfg.id, name: cfg.name, windX: this.wind.base });
  }

  _mods() {
    return { speedMul: this.traits.speedMul, speedOverride: this._stageCfg().speedOverride, k: this.k };
  }

  // ------------------------------------------------------------------------------------------------------------- update

  update(frameDtS, shots, nowMs) {
    if (this.phase === 'over') return;
    const dt = Number.isFinite(frameDtS) ? clamp(frameDtS, 0, CONFIG.time.maxFrameS) : 0;
    let now = Number.isFinite(nowMs) ? nowMs : (this.lastNowMs ?? 0) + dt * MS;
    if (this.lastNowMs !== null && now < this.lastNowMs) now = this.lastNowMs;
    this.lastNowMs = now;
    this.realAccum += dt;
    // anchor the simulation clock to this frame: [simMs, now] is the time to simulate (gaps longer than maxFrameS are skipped)
    this.simMs = now - this.realAccum * MS;
    this._pushHist();

    const list = this._sortedShots(shots);
    let steps = 0;
    const maxSteps = CONFIG.time.maxStepsPerFrame;
    for (const shot of list) {
      while (this.realAccum >= DT - EPS && this.simMs + DT_MS <= shot.t + EPS_MS && steps < maxSteps && this.phase !== 'over') {
        this._step();
        steps += 1;
      }
      if (this.phase === 'over') break;
      this._handleShot(shot);
    }
    while (this.realAccum >= DT - EPS && steps < maxSteps && this.phase !== 'over') {
      this._step();
      steps += 1;
    }
    if (steps >= maxSteps && this.realAccum >= DT - EPS) this.realAccum = 0; // spiral-of-death guard
    if (this.phase === 'over') this.realAccum = 0;
  }

  _sortedShots(shots) {
    if (!Array.isArray(shots) || shots.length === 0) return [];
    const out = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (!s || !Number.isFinite(s.t) || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      out.push({ s, i });
    }
    out.sort((a, b) => a.s.t - b.s.t || a.i - b.i);
    return out.map((e) => e.s);
  }

  _step() {
    this.realAccum -= DT;
    if (this.realAccum < 0) this.realAccum = 0;
    this.simMs += DT_MS;
    this._realTick();
  }

  _pushHist() {
    const w = this.tWorld + this.worldAccum;
    const last = this.hist[this.hist.length - 1];
    if (last && Math.abs(last.ms - this.simMs) < EPS_MS) {
      last.w = w;
      return;
    }
    this.hist.push({ ms: this.simMs, w });
    if (this.hist.length > this.histMax) this.hist.shift();
  }

  _realTick() {
    this.tick += 1;
    this.t = this.tick * DT;
    this.timeScale = this.scaler.current();
    this.scaler.advance(DT_MS);
    if (this.killCam) {
      this.killCam.leftS -= DT;
      if (this.killCam.leftS <= EPS) this.killCam = null;
    }

    this._tickPhase();

    this.worldAccum += DT * this.timeScale;
    if (this.worldAccum >= DT - EPS) {
      this.worldAccum = Math.max(0, this.worldAccum - DT);
      this._worldStep();
    }
    this._pushHist();
    if (this.volleys.length > 0) this._resolveVolleys();
  }

  // ------------------------------------------------------------------------------------------------------------- phases

  _tickPhase() {
    switch (this.phase) {
      case 'ready': this._tickReady(); break;
      case 'pull':
        this.pullDelayLeftS -= DT;
        if (this.pullDelayLeftS <= EPS) this._launchPull();
        break;
      case 'flight': this._tickFlight(); break;
      case 'settle':
        this.settleLeftS -= DT;
        if (this.settleLeftS <= EPS) this._afterSettle();
        break;
      case 'stageCard':
        this.cardLeftS -= DT;
        if (this.cardLeftS <= EPS) this._enterReady();
        break;
      case 'ending':
        this.endingLeftS -= DT;
        if (this.endingLeftS <= EPS) this._finish();
        break;
      default: break;
    }
  }

  _enterReady() {
    this.pull = null;
    this._setPhase('ready');
    this.readyT = this.t;
    this.shells.loaded = 0;
    this.shells.loading = true;
    this.shells.reloadLeftS = C.loadS;
    this._emit('reload', { phase: 'start', ms: C.loadS * MS });
    this._emit('ready', { stageIndex: this.stageIndex, pullIndex: this.pullIndex });
  }

  _finishLoad() {
    this.shells.loading = false;
    this.shells.reloadLeftS = 0;
    this.shells.loaded = this.shells.capacity;
    this._emit('reload', { phase: 'done', ms: 0 });
  }

  _tickReady() {
    if (this.shells.loading) {
      this.shells.reloadLeftS -= DT;
      if (this.shells.reloadLeftS <= EPS) this._finishLoad();
    }
    if (this.autoLaunch === true) {
      if (!this.shells.loading && C.debugAutoPull) this._callPull();
    } else if (this.autoLaunch === null && this.opts.autoPull && this.t - this.readyT >= C.autoPullS - EPS) {
      this._callPull();
    }
  }

  _callPull() {
    if (this.phase !== 'ready') return;
    if (this.shells.loading) this._finishLoad();
    const plan = this.plan[this.pullIndex];
    const rng = streamRng(this.seed32, ST.launch, this.stageIndex * PULL_K + this.pullIndex);
    const delay = rng.range(C.pullDelayS[0], C.pullDelayS[1]);
    this.pull = this._newPull(this.pullIndex, plan.members.length, plan.double, false);
    this.pull.plan = plan;
    this.pull.rng = rng;
    this.pullDelayLeftS = delay;
    this._setPhase('pull');
    this._emit('pull', { delayMs: delay * MS });
  }

  _newPull(index, size, double, debug) {
    return { index, size, resolved: 0, broken: 0, double, debug, plan: null, rng: null };
  }

  _launchPull() {
    const p = this.pull;
    this._setPhase('flight');
    const ctx = { rng: p.rng, pullIndex: p.index, double: p.double, pull: p };
    for (const member of p.plan.members) this.pending.push({ atT: this.t + member.offsetS, member, ctx });
    this._launchDue();
  }

  _tickFlight() {
    if (this.traits.waves) this._tickWaves();
    if (this.practice) this._tickPractice();
    this._launchDue();
    if (this.timeLeft !== null) this._tickClock();
    if (this.traits.pulls && this.phase === 'flight' && this.pull && this.pull.resolved >= this.pull.size && !this._pullPending(this.pull)) {
      this.volleys.length = 0;
      this.shells.loaded = 0; // the gun opens, the remaining shell is ejected
      this.settleLeftS = C.settleS;
      this._setPhase('settle');
    }
  }

  _pullPending(pull) {
    for (const e of this.pending) if (e.ctx.pull === pull) return true;
    return false;
  }

  _afterSettle() {
    const wasDebug = this.pull && this.pull.debug;
    this.pull = null;
    if (!wasDebug) this.pullIndex += 1;
    if (this.pullIndex < this.plan.length) {
      this._enterReady();
      return;
    }
    this._stageDone();
  }

  _stageDone() {
    const s = this.stageStats;
    const perfect = s.presented > 0 && s.broken === s.presented;
    const bonus = perfect && this.traits.scored ? CONFIG.scoring.perfectStage * multiplierFor(this.streak) : 0;
    this.score += bonus;
    this._emit('stageClear', { index: this.stageIndex, perfect, bonus });
    if (this.stageIndex + 1 < this.traits.stageIds.length) {
      this._setupStage(this.stageIndex + 1);
      this.cardLeftS = C.stageCardS;
      this._setPhase('stageCard');
    } else {
      this._beginEnding('complete');
    }
  }

  /** The most the clock may show: the 120 s ceiling and the time really left before the 180 s round cap (QA F2). */
  _clockLimit() {
    return Math.min(this.traits.maxTimeS, this.traits.roundCapS - this.t);
  }

  _tickClock() {
    // honest clock: never more than the time really left before the round cap, so the round ends exactly at 0
    this.timeLeft = Math.max(0, Math.min(this.timeLeft - DT, this._clockLimit()));
    if (this.timeLeft <= EPS) {
      this.timeLeft = 0;
      this._emit('timeUp', { score: this.score });
      this._beginEnding('timer');
      return;
    }
    const sec = Math.ceil(this.timeLeft - EPS);
    if (sec > this.lastTickSec) this.lastTickSec = sec;
    if (sec >= 1 && sec <= TA.tickFromS && sec < this.lastTickSec) {
      this.lastTickSec = sec;
      this._emit('tick', { secondsLeft: sec });
    }
  }

  _beginEnding(reason) {
    this.endReason = reason;
    this.pending.length = 0;
    this.volleys.length = 0;
    this.endingLeftS = this.traits.endingS;
    this._setPhase('ending');
    if (this.endingLeftS <= EPS) this._finish();
  }

  _finish() {
    if (this.endReason === null) this.endReason = 'complete';
    this.pending.length = 0;
    this.volleys.length = 0;
    this.scaler.clear();
    this.killCam = null;
    this.timeScale = 1;
    this._setPhase('over');
    this.result = this._buildResult();
  }

  _buildResult() {
    const s = this.stats;
    const r = {
      mode: this.mode,
      difficulty: this.difficulty,
      stageId: this.mode === 'classic' ? null : this.stageId,
      score: this.score,
      presented: s.presented,
      broken: s.broken,
      lost: s.lost,
      shots: s.shots,
      hits: s.hits,
      accuracy: s.shots > 0 ? s.hits / s.shots : null,
      bestStreak: s.bestStreak,
      doubles: s.doubles,
      centre: s.centre,
      durationS: this.t,
      endReason: this.endReason,
      rank: null,
      assist: this.opts.assist,
    };
    r.rank = this.traits.ranked ? rankFor(r) : null;
    return r;
  }

  // ------------------------------------------------------------------------------------------------------------- launches

  /**
   * Time Attack and Zen waves (owner decision 2026-10-03): one wave at a time, 1 or 2 targets, never more than the shells.
   * Each wave refills the gun; the next one starts a gap after every target of the previous wave is broken or lost.
   */
  _tickWaves() {
    if (this.autoLaunch === false) return;
    if (this.targets.length > 0 || this.pending.length > 0) {
      this.waveIdle = false;
      return;
    }
    const isZen = this.mode === 'zen';
    const progress = clamp(this.t / TA.durationS, 0, 1);
    if (!this.waveIdle) {
      // the previous wave has just been resolved: wait for the gap
      this.waveIdle = true;
      this.nextWaveT = this.t + (isZen ? ZEN.gapS : TA.gapS[0] + (TA.gapS[1] - TA.gapS[0]) * progress);
    }
    if (this.t < this.nextWaveT - EPS) return;
    const k = this.waveK;
    const doubleChance = isZen ? ZEN.doubleChance : TA.doubleChance[0] + (TA.doubleChance[1] - TA.doubleChance[0]) * progress;
    const pull = drawWave(this.stageId, streamRng(this.seed32, ST.wave, k), doubleChance);
    this.waveK += 1;
    if (k === this.goldWaveK) {
      const first = pull.members.find((mm) => mm.kind === 'standard');
      if (first) first.kind = 'gold';
      else this.goldWaveK += 1; // no standard clay in this wave: try the next one
    }
    this._refillForWave();
    this.waveIdle = false;
    // each wave is a pull of its own so that doubles count in Time Attack and Zen (QA F3)
    const wavePull = this._newPull(this.launchCounter, pull.members.length, pull.double, false);
    const ctx = { rng: streamRng(this.seed32, ST.launch, WAVE_K + k), pullIndex: this.launchCounter, double: pull.double, pull: wavePull };
    for (const member of pull.members) this.pending.push({ atT: this.t + member.offsetS, member, ctx });
  }

  /** Time Attack: the gun is refilled for every wave (a quick insert, no waiting). */
  _refillForWave() {
    if (!this.traits.waves || this.traits.infiniteShells || this.shells.loaded >= this.shells.capacity) return;
    this._emit('reload', { phase: 'start', ms: 0 });
    this.shells.loaded = this.shells.capacity;
    this._emit('reload', { phase: 'done', ms: 0 });
  }

  _tickPractice() {
    const p = this.practice;
    if (this.autoLaunch === false || this.t < p.nextThrowT - EPS) return;
    p.nextThrowT = this.t + PR.everyS;
    const rng = streamRng(this.seed32, ST.launch, PRACTICE_K + p.shown);
    const mods = { speedMul: 1, k: this.k, ranges: { speed: [PR.speed, PR.speed], azimuthDeg: PR.azimuthDeg, elevationDeg: PR.elevationDeg } };
    const ids = this._launchGroup([{ kind: PR.kind, house: PR.house }], { rng, pullIndex: this.launchCounter, double: false, pull: null, mods });
    if (ids.length > 0) {
      p.shown += 1;
      this._emit('practice', { phase: 'thrown' });
    }
  }

  /** Launch every scheduled member whose time has come, grouped by house (one launch event per house). */
  _launchDue() {
    if (this.pending.length === 0) return;
    const due = [];
    const keep = [];
    for (const e of this.pending) (e.atT <= this.t + EPS ? due : keep).push(e);
    if (due.length === 0) return;
    this.pending = keep;
    // group by (ctx, house) preserving order
    const groups = [];
    for (const e of due) {
      let g = groups.find((x) => x.ctx === e.ctx && x.house === e.member.house);
      if (!g) {
        g = { ctx: e.ctx, house: e.member.house, members: [] };
        groups.push(g);
      }
      g.members.push(e.member);
    }
    for (const g of groups) this._launchGroup(g.members, g.ctx);
  }

  _launchGroup(members, ctx) {
    const ids = [];
    const mods = ctx.mods ?? this._mods();
    for (const member of members) {
      if (this.targets.length >= CONFIG.caps.airborne) break;
      const res = fairLaunch(ctx.rng, member, mods, { tWorld: this.tWorld, wind: this.wind });
      ids.push(this._addBody(res.body, ctx).id);
    }
    if (ids.length > 0) {
      this.houseLaunchT[members[0].house] = this.t;
      this._emit('launch', { ids, house: members[0].house, double: ctx.double === true });
      if (!this.traits.pulls) this.launchCounter += 1;
    }
    return ids;
  }

  _addBody(body, ctx) {
    body.id = ++this.nextId;
    body.pullIndex = ctx.pullIndex;
    body.pull = ctx.pull ?? null;
    body.launchT = this.t;
    this.targets.push(body);
    this.stats.presented += 1;
    this.stageStats.presented += 1;
    return body;
  }

  // ------------------------------------------------------------------------------------------------------------- world

  _worldStep() {
    this.worldSteps += 1;
    this.tWorld = this.worldSteps * DT;
    windAt(this.wind, this.tWorld, this.windNow);
    let w = 0;
    for (let i = 0; i < this.targets.length; i++) {
      const b = this.targets[i];
      stepBody(b, DT, this.windNow.x);
      const reason = lostReason(b);
      if (reason) this._onLost(b, reason);
      else this.targets[w++] = b;
    }
    this.targets.length = w;
  }

  _onLost(b, reason) {
    if (this.phase === 'ending' || this.phase === 'over') return; // the round is decided: leave silently
    this.stats.lost += 1;
    this.streak = 0;
    if (b.pull) b.pull.resolved += 1;
    const p = project(b.x, b.y, Math.max(b.z, WORLD.zNear));
    this._emit('lost', { id: b.id, kind: b.kind, x: p.sx, y: p.sy, reason });
    if (this.practice) this._emit('practice', { phase: 'lost' });
  }

  // ------------------------------------------------------------------------------------------------------------- time at the shot instant

  /** Continuous world time at clock time T (ms): forward inside the current tick, or rewound through the history. */
  _worldTimeAt(T) {
    const cur = this.tWorld + this.worldAccum;
    if (T >= this.simMs) return cur + this.scaler.current() * ((T - this.simMs) / MS);
    const h = this.hist;
    if (h.length === 0) return cur;
    if (T <= h[0].ms) return h[0].w;
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1];
      const b = h[i];
      if (T >= a.ms) {
        const span = b.ms - a.ms;
        return span > EPS_MS ? a.w + ((b.w - a.w) * (T - a.ms)) / span : b.w;
      }
    }
    return h[0].w;
  }

  /** World state of a body `dtw` world seconds away from its current state (second order, dtw is at most a few ticks). */
  _bodyAt(b, dtw) {
    if (b.still || dtw === 0) return { x: b.x, y: b.y, z: b.z };
    const a = accelOf(b, this.windNow.x);
    const h = 0.5 * dtw * dtw;
    let y = b.y + b.vy * dtw + a.y * h;
    if (b.rabbit && y < b.rabbit.groundY) y = b.rabbit.groundY;
    return { x: b.x + b.vx * dtw + a.x * h, y, z: b.z + b.vz * dtw + a.z * h };
  }

  /** Projected candidates of every airborne target at clock time T (ms). `onlyId` restricts to one target. */
  _candidatesAt(T, onlyId = null) {
    return this._candidatesAtWorld(this._worldTimeAt(T), onlyId);
  }

  /** Projected candidates at continuous world time w (s). */
  _candidatesAtWorld(w, onlyId = null) {
    const dtw = w - this.tWorld;
    const list = [];
    for (const b of this.targets) {
      if (onlyId !== null && b.id !== onlyId) continue;
      if (b.ageS + dtw < -EPS) continue; // launched after T
      const s = this._bodyAt(b, dtw);
      list.push({ id: b.id, x: s.x, y: s.y, z: s.z, sizeM: b.sizeM, body: b });
    }
    return projectCandidates(list, this.patternMul, this.k);
  }

  // ------------------------------------------------------------------------------------------------------------- shots

  _handleShot(shot) {
    if (this.phase === 'over' || this.phase === 'ending') return;
    if (this.traits.pulls && this.phase === 'ready') {
      this._callPull();
      return;
    }
    if (this.phase !== 'flight') return; // pull delay, settle, stage card: the gun is not ready
    const aim0 = { x: clamp(shot.x, 0, FIELD.w), y: clamp(shot.y, 0, FIELD.h) };
    let shell = -1;
    if (!this.traits.infiniteShells) {
      if (this.shells.loaded <= 0) {
        this._emit('dryFire', { x: aim0.x, y: aim0.y });
        return;
      }
      shell = this.shells.capacity - this.shells.loaded;
      this.shells.loaded -= 1;
    }
    this.stats.shots += 1;
    const T = clamp(shot.t, this.simMs - CONFIG.time.maxRewindMs, Math.min(this.simMs + DT_MS, this.lastNowMs ?? this.simMs));
    const cands = this._candidatesAt(T);
    const aim = this.opts.assist ? assistAim(aim0, cands) : aim0;
    const volley = { x: aim.x, y: aim.y, shell, hits: [], hadHit: false, entries: null };
    const source = typeof shot.source === 'string' ? shot.source : 'debug';
    const compMs = Number.isFinite(shot.compMs) ? shot.compMs : 0;
    if (this.traits.travel) {
      // pellet flight scheduled in WORLD time (review G-05): a kill cam slows the pellets like the clays
      const wT = this._worldTimeAt(T);
      volley.entries = cands.map((c) => ({ id: c.id, atW: wT + travelTimeS(c.z), done: false }));
      this._emit('shot', { x: aim.x, y: aim.y, shell, hitIds: [], source, compMs });
      this.volleys.push(volley);
      this._resolveVolleys();
    } else {
      const hits = [];
      for (const c of cands) {
        const r = testHit(volley, c);
        if (r.hit) hits.push({ c, centre: r.centre, dist: r.dist });
      }
      hits.sort((a, b) => a.dist - b.dist || a.c.id - b.c.id);
      this._emit('shot', { x: aim.x, y: aim.y, shell, hitIds: hits.map((h) => h.c.id), source, compMs });
      this._applyHits(volley, hits);
      this._finishVolley(volley);
    }
  }

  _resolveVolleys() {
    let w = 0;
    const cur = this.tWorld + this.worldAccum;
    for (let i = 0; i < this.volleys.length; i++) {
      const v = this.volleys[i];
      const hits = [];
      let open = false;
      for (const e of v.entries) {
        if (e.done) continue;
        if (e.atW > cur + EPS) {
          open = true;
          continue;
        }
        e.done = true;
        const [c] = this._candidatesAtWorld(e.atW, e.id);
        if (!c) continue;
        const r = testHit(v, c);
        if (r.hit) hits.push({ c, centre: r.centre, dist: r.dist });
      }
      if (hits.length > 0) {
        hits.sort((a, b) => a.dist - b.dist || a.c.id - b.c.id);
        this._applyHits(v, hits);
      }
      if (open && this.phase !== 'over') this.volleys[w++] = v;
      else this._finishVolley(v);
    }
    this.volleys.length = w;
  }

  _applyHits(volley, hits) {
    if (hits.length === 0) return;
    const scored = this.traits.scored;
    let killCamAt = null;
    for (const h of hits) {
      const b = h.c.body;
      const idx = this.targets.indexOf(b);
      if (idx < 0) continue;
      this.targets.splice(idx, 1);
      const prevMult = multiplierFor(this.streak);
      this.streak += 1;
      if (this.streak > this.stats.bestStreak) this.stats.bestStreak = this.streak;
      const mult = multiplierFor(this.streak);
      const firstBarrel = volley.shell === 0;
      const points = scored ? basePoints({ kind: b.kind, centre: h.centre, firstBarrel, z: h.c.z, k: this.k }) * mult : 0;
      this.score += points;
      this.stats.broken += 1;
      this.stageStats.broken += 1;
      if (h.centre) this.stats.centre += 1;
      if (!volley.hadHit) {
        volley.hadHit = true;
        this.stats.hits += 1;
      }
      volley.hits.push(b.id);
      const p2 = project(h.c.x + b.vx * SCREEN_VEL_PROBE_S, h.c.y + b.vy * SCREEN_VEL_PROBE_S, h.c.z + b.vz * SCREEN_VEL_PROBE_S);
      this._emit('hit', {
        id: b.id, kind: b.kind, x: h.c.sx, y: h.c.sy, z: h.c.z, rPx: h.c.targetPx,
        vx: (p2.sx - h.c.sx) / SCREEN_VEL_PROBE_S, vy: (p2.sy - h.c.sy) / SCREEN_VEL_PROBE_S,
        points, centre: h.centre, firstBarrel, multiplier: mult, streak: this.streak,
        shardSeed: hash32(hash32(this.seed32, ST.shard), b.id) & INT31,
      });
      if (scored && mult > prevMult) this._emit('streak', { level: mult, streak: this.streak });
      let endsDouble = false;
      const pull = b.pull;
      if (pull) {
        pull.resolved += 1;
        pull.broken += 1;
        if (pull.double && pull.broken >= pull.size && !this._pullPending(pull)) {
          endsDouble = true;
          this.stats.doubles += 1;
          const dp = scored ? CONFIG.scoring.double * mult : 0;
          this.score += dp;
          this._emit('double', { points: dp, x: h.c.sx, y: h.c.sy });
        }
      }
      if (this.timeLeft !== null) {
        const bonus = timeBonusFor(this.stats.broken);
        const limit = this._clockLimit();
        const next = Math.max(this.timeLeft, Math.min(this.timeLeft + bonus, limit));
        const applied = next < limit ? bonus : next - this.timeLeft;
        this.timeLeft = next;
        this._emit('timeBonus', { deltaS: applied, timeLeft: this.timeLeft });
      }
      if (this.practice) {
        this.practice.hit += 1;
        this._emit('practice', { phase: 'hit' });
      }
      const endsStage = this.traits.pulls && pull && !pull.debug && this.pullIndex === this.plan.length - 1
        && pull.resolved >= pull.size && !this._pullPending(pull);
      if (b.kind === 'gold' || (h.centre && (endsDouble || endsStage))) killCamAt = { x: h.c.sx, y: h.c.sy };
    }
    if (volley.hits.length > 0 && !volley.stopped) {
      volley.stopped = true;
      // no freeze while another clay still flies: frozen for 40 ms it reads as a stutter (owner feedback 2026-10-03, render engineer)
      const ms = this.scaler.hold(this.targets.length > 0 ? 0 : CONFIG.juice.hitStopMs);
      this._emit('hitStop', { ms });
    }
    if (killCamAt) {
      const K = CONFIG.juice.killCam;
      const ms = this.scaler.slow(K.timeScale, K.durationS * MS);
      this.killCam = ms > 0 ? { x: killCamAt.x, y: killCamAt.y, leftS: K.durationS } : null;
      this._emit('killCam', { x: killCamAt.x, y: killCamAt.y, durationMs: ms, scale: K.zoom });
    }
  }

  _finishVolley(v) {
    if (v.hits.length >= 2) {
      const pts = this.traits.scored ? CONFIG.scoring.twoWithOne * multiplierFor(this.streak) : 0;
      this.score += pts;
      this._emit('twoWithOne', { points: pts, x: v.x, y: v.y });
    }
    if (this.mode === 'zen') {
      this.recent.push(v.hits.length > 0);
      if (this.recent.length > ZEN.recentShots) this.recent.shift();
    }
  }

  // ------------------------------------------------------------------------------------------------------------- public

  snapshot() {
    const alpha = clamp((this.worldAccum + this.scaler.current() * this.realAccum) / DT, 0, 1);
    const targets = new Array(this.targets.length);
    for (let i = 0; i < this.targets.length; i++) {
      const b = this.targets[i];
      const ix = b.px + (b.x - b.px) * alpha;
      const iy = b.py + (b.y - b.py) * alpha;
      const iz = Math.max(WORLD.zNear, b.pz + (b.z - b.pz) * alpha);
      const p = project(ix, iy, iz);
      targets[i] = {
        id: b.id, kind: b.kind, frame: frameFor(b), x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz,
        sx: p.sx, sy: p.sy, rPx: ((b.sizeM / 2) * WORLD.F) / iz, rot: b.rot - b.spin * DT * (1 - alpha), ageS: b.ageS, pullIndex: b.pullIndex, // rot interpolated like the position (render smoothness, 2026-10-03)
      };
    }
    const cfg = this._stageCfg();
    const houses = cfg.houses
      .map((id) => {
        const h = CONFIG.houses[id];
        const pos = housePos(id, this.k);
        const p = project(pos.x, pos.groundY, pos.z); // ground point: the same screen point at every world scale
        const last = this.houseLaunchT[id];
        return {
          id, sprite: h.sprite, x: pos.x, y: pos.y, z: pos.z, sx: p.sx, sy: p.sy, scale: WORLD.F / pos.z, mirrored: h.mirrored,
          flashS: last === undefined ? CONFIG.time.neverS : this.t - last,
        };
      })
      .sort((a, b) => b.z - a.z);
    const classic = this.traits.pulls;
    let targetsLeft;
    if (classic) {
      if (this.pull) targetsLeft = Math.max(0, this.pull.size - this.pull.resolved);
      else if (this.phase === 'ready' && this.plan[this.pullIndex]) targetsLeft = this.plan[this.pullIndex].members.length;
      else targetsLeft = 0;
    } else {
      targetsLeft = this.targets.length + this.pending.length;
    }
    const infinite = this.traits.infiniteShells;
    const mult = multiplierFor(this.streak);
    return {
      v: 1,
      mode: this.mode,
      difficulty: this.difficulty,
      seed: this.seed,
      phase: this.phase,
      t: this.t,
      tWorld: this.tWorld,
      alpha,
      timeScale: this.timeScale,
      stage: { index: this.stageIndex, id: this.stageId, count: this.traits.stageIds.length, name: cfg.name },
      pull: { index: classic ? this.pullIndex : this.launchCounter, count: classic ? this.plan.length : null, targetsLeft },
      wind: { x: this.wind.base, gust: this.windNow.gust },
      shells: {
        loaded: infinite ? this.shells.capacity : this.shells.loaded,
        capacity: this.shells.capacity,
        reloadingS: infinite ? 0 : Math.max(0, this.shells.reloadLeftS),
        infinite,
      },
      score: this.score,
      streak: this.streak,
      multiplier: mult,
      multiplierProgress: multiplierProgress(this.streak),
      timeLeft: this.timeLeft,
      timeTotal: this.traits.timerS,
      targets,
      houses,
      killCam: this.killCam ? { x: this.killCam.x, y: this.killCam.y, leftS: this.killCam.leftS, zoom: CONFIG.juice.killCam.zoom } : null,
      practice: this.practice ? { shown: this.practice.shown, hit: this.practice.hit } : null,
      stats: { ...this.stats },
      assist: this.opts.assist,
      endReason: this.endReason,
      events: this.log.map(copyEvent),
      // additive (docs/contract-notes.md 2026-10-01): Zen statistics of the last CONFIG.zen.recentShots shots
      zen: this.mode === 'zen' ? { recentShots: this.recent.length, recentHits: this.recent.filter(Boolean).length } : null,
      // additive (docs/contract-notes.md 2026-10-03): world scale k of this round (difficulty distance; Zen 0.55)
      worldScale: this.k,
    };
  }

  drainEvents() {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  isOver() {
    return this.phase === 'over';
  }

  getResult() {
    return this.phase === 'over' && this.result ? { ...this.result } : null;
  }

  /**
   * End the round now. 'finished' / 'complete' (Zen "End session") gives endReason 'complete', anything else 'quit' (review G-03).
   * A round already decided (phase 'ending') keeps its own reason (review G-04: quitting right after "TIME!" keeps the result).
   */
  end(reason) {
    if (this.phase === 'over') return;
    if (this.phase !== 'ending') this.endReason = reason === 'finished' || reason === 'complete' ? 'complete' : 'quit';
    this._finish();
  }

  /** Switch Reduce motion during a round (review G-02): no more hit stop or kill-cam slow motion from now on. */
  setReduceMotion(on) {
    this.opts.reduceMotion = Boolean(on);
    this.scaler.reduceMotion = this.opts.reduceMotion;
    if (this.opts.reduceMotion) {
      this.scaler.clear();
      this.killCam = null;
    }
  }

  debugSetAutoLaunch(on) {
    this.autoLaunch = Boolean(on);
  }

  debugSpawn(spec) {
    const specs = Array.isArray(spec) ? spec : [spec];
    for (const s of specs) if (s === null || typeof s !== 'object') throw new TypeError('debugSpawn: spec must be an object or an array of objects');
    if (this.phase === 'over' || this.phase === 'ending') return [];
    const members = specs.map((s) => ({ kind: s.kind ?? 'standard', house: s.house ?? 'trap' }));
    for (const mm of members) {
      if (!CONFIG.targets[mm.kind]) throw new RangeError(`debugSpawn: unknown kind "${mm.kind}"`);
      if (!CONFIG.houses[mm.house]) throw new RangeError(`debugSpawn: unknown house "${mm.house}"`);
    }
    const double = specs.length > 1;
    this._refillForWave(); // Time Attack: a debug spawn is a wave, it refills the gun
    let pull = null;
    if (this.traits.pulls) {
      if (this.phase === 'ready') {
        if (this.shells.loading) this._finishLoad();
        pull = this._newPull(this.pullIndex, 0, double, true);
        this.pull = pull;
        this._setPhase('flight');
      } else if ((this.phase === 'flight' || this.phase === 'pull') && this.pull) {
        pull = this.pull;
      }
    }
    const ids = [];
    const mods = this._mods();
    for (let i = 0; i < specs.length; i++) {
      if (this.targets.length >= CONFIG.caps.airborne) break;
      const s = specs[i];
      const rng = streamRng(this.seed32, ST.debug, this.debugK++);
      const explicit = ['speed', 'azimuthDeg', 'elevationDeg', 'pos', 'vel', 'still'].some((k) => s[k] !== undefined);
      let body;
      if (explicit) {
        const params = drawParams(rng, members[i], mods);
        if (Number.isFinite(s.speed)) params.speed = s.speed;
        if (Number.isFinite(s.azimuthDeg)) params.azimuthDeg = s.azimuthDeg;
        if (Number.isFinite(s.elevationDeg)) params.elevationDeg = s.elevationDeg;
        params.jx = 0;
        params.jz = 0;
        body = finishBody(makeBody(params, { pos: s.pos ?? null, vel: s.vel ?? null, still: s.still === true }), this.tWorld, this.wind);
      } else {
        body = fairLaunch(rng, members[i], mods, { tWorld: this.tWorld, wind: this.wind }).body;
      }
      if (pull) pull.size += 1;
      const id = this._addBody(body, { pullIndex: this.traits.pulls ? this.pullIndex : this.launchCounter, pull }).id;
      ids.push(id);
      this.houseLaunchT[members[i].house] = this.t;
      this._emit('launch', { ids: [id], house: members[i].house, double });
    }
    if (!this.traits.pulls && ids.length > 0) this.launchCounter += 1;
    return ids;
  }

  /** Non-contract helper for tests and the debug overlay: sizes of the internal collections and clocks. */
  debugInfo() {
    return {
      targets: this.targets.length, pending: this.pending.length, volleys: this.volleys.length, outbox: this.outbox.length,
      hist: this.hist.length, tick: this.tick, worldSteps: this.worldSteps, simMs: this.simMs, waveK: this.waveK,
      plan: this.plan.map((p) => ({ type: p.type, kinds: p.members.map((mm) => mm.kind) })),
    };
  }
}

/**
 * Time Attack bonus (s) for the n-th broken target of the round (1-based): CONFIG.timeattack.bonusSteps.
 * @param {number} n
 */
export function timeBonusFor(n) {
  for (const step of TA.bonusSteps) if (step.upTo === null || n <= step.upTo) return step.s;
  return 0;
}

/** Sprite frame of a target (design 3): rabbit, gold, battue edge-on, or by the elevation of the line of sight. */
export function frameFor(b) {
  if (b.kind === 'rabbit') return 'rabbit';
  if (b.kind === 'gold') return 'gold';
  if (b.kind === 'battue') return 'edge';
  const elev = Math.atan2(b.y - WORLD.camY, Math.hypot(b.x, b.z)) * DEG;
  if (elev > CONFIG.frames.belowDeg) return 'below';
  if (Math.abs(elev) < CONFIG.frames.edgeDeg) return 'edge';
  return 'tilt';
}

/**
 * Create a round.
 * @param {'classic'|'timeattack'|'zen'|'practice'} mode
 * @param {number} seed                               any finite number (coerced to uint32 for the streams)
 * @param {import('../shared/contracts.js').GameOptions} [opts]
 * @returns {import('../shared/contracts.js').Game & {debugInfo: () => object}}
 */
export function createGame(mode, seed, opts) {
  const e = new Engine(mode, seed, opts);
  return {
    update: (frameDtS, shots, nowMs) => e.update(frameDtS, shots, nowMs),
    snapshot: () => e.snapshot(),
    drainEvents: () => e.drainEvents(),
    isOver: () => e.isOver(),
    getResult: () => e.getResult(),
    end: (reason) => e.end(reason),
    debugSpawn: (spec) => e.debugSpawn(spec),
    debugSetAutoLaunch: (on) => e.debugSetAutoLaunch(on),
    setReduceMotion: (on) => e.setReduceMotion(on),
    debugInfo: () => e.debugInfo(),
  };
}
