// Audio engine with a fake AudioContext (architecture 6.4): autoplay policy, the signal chain and buses, voice limit and priority, the
// mapping of EVERY GameEvent type, the stage ambience (wind, birds, crickets, ducked in pause), named UI functions, no leaks, never throws.
// The fake models the Web Audio API surface, not a real device (UNVERIFIED-ON-HARDWARE: real playback).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NAMED, ambienceLevelFor, createAudio, masterGainFor, softClip } from '../../public/js/audio/audio.js';
import { AUDIO_CONFIG } from '../../public/js/audio/audio-config.js';
import { GAME_EVENT } from '../../public/js/shared/contracts.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { FakeAudioContext } from '../../test-support/audio/fake-audio-context.js';
import { allEvents, ev, makeSnapshot } from '../../test-support/render/scenes.js';

function rig(opts = {}) {
  const made = [];
  let seed = 7;
  const random = opts.random ?? (() => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; });
  const audio = createAudio({ createContext: () => { const c = new FakeAudioContext(opts.ctx); made.push(c); return c; }, random, ...opts.audio });
  return { audio, made, get ctx() { return made[0]; } };
}
const unlocked = (opts) => { const r = rig(opts); r.audio.unlock(); return r; };
const ids = (r) => r.audio.getDebug().voices.map((v) => v.id);

test('silent before unlock(): no context, nothing throws; mute never creates one', () => {
  const r = rig();
  assert.doesNotThrow(() => {
    r.audio.play('shot');
    r.audio.handleGameEvent(ev('shot', { x: 1, y: 1, shell: 0, hitIds: [], source: 'mouse', compMs: 0 }));
    r.audio.update(0.016, { screen: 'playing', stageId: 'meadow', snapshot: makeSnapshot() });
    r.audio.setVolume(0.3);
    r.audio.uiMove();
  });
  assert.equal(r.made.length, 0);
  const m = rig({ audio: { mute: true } });
  m.audio.unlock();
  assert.equal(m.made.length, 0);
  assert.equal(m.audio.ready, false);
});

test('unlock builds the chain once: buses game/event/ui/amb -> sfxBus -> compressor -> lowpass -> soft clip -> master (0.8 v^2) -> destination', () => {
  const r = unlocked();
  r.audio.unlock();
  assert.equal(r.made.length, 1);
  const ctx = r.ctx;
  const comp = ctx.nodes.find((n) => n.kind === 'compressor');
  assert.deepEqual([comp.threshold.value, comp.knee.value, comp.ratio.value], [-14, 12, 4]);
  const gains = ctx.nodes.filter((n) => n.kind === 'gain');
  const master = gains.at(-1);
  assert.ok(Math.abs(master.gain.value - masterGainFor(AUDIO_CONFIG.volumeDefault)) < 1e-9);
  assert.ok(master.outputs.includes(ctx.destination));
  assert.deepEqual(Object.keys(r.audio.getDebug().buses), ['game', 'event', 'ui', 'amb']);
  assert.equal(masterGainFor(1), 0.8);
  assert.equal(masterGainFor(0.5), 0.2);
  assert.equal(softClip(0.5), 0.5);
  assert.ok(softClip(5) <= 1 && softClip(-5) >= -1);
});

test('every GameEvent type is handled without an error, and maps to the right sound', () => {
  const r = unlocked();
  const events = allEvents();
  assert.deepEqual(new Set(events.map((e) => e.type)), new Set(Object.values(GAME_EVENT)), 'the fixture has every type');
  const expect = {
    stageStart: 'stageStart', ready: null, pull: 'pullCue', launch: 'throw', shot: 'shot', dryFire: 'dryClick', hit: 'clayBreak',
    lost: 'clayLand', double: 'double', twoWithOne: 'double', streak: 'streakUp', stageClear: 'stageClear', killCam: 'slowmo',
    hitStop: null, timeBonus: 'timeBonus', tick: 'timeTick', timeUp: 'timeUp', phase: null, practice: null,
  };
  for (const e of events) {
    assertValid('GameEvent', e);
    const one = unlocked();
    one.audio.handleGameEvent(e);
    const d = one.audio.getDebug();
    assert.equal(d.stats.errors, 0, e.type);
    if (e.type === 'reload') assert.deepEqual(ids(one), e.phase === 'start' ? [] : ['shellInsert'], `${e.type} ${e.phase} (nothing fired: no open)`);
    else if (expect[e.type] === null) assert.deepEqual(ids(one), [], `${e.type} is silent`);
    else assert.deepEqual(ids(one), [expect[e.type]], e.type);
  }
  for (const e of events) r.audio.handleGameEvent(e);
  assert.equal(r.audio.getDebug().stats.errors, 0);
  // gold breaks with its own sound; a lost clay that did not touch the ground is silent; streak x1 is silent
  const g = unlocked();
  g.audio.handleGameEvent(ev('hit', { id: 1, kind: 'gold', x: 900, y: 400, z: 25, rPx: 9, vx: 0, vy: 0, points: 300, centre: false, firstBarrel: true, multiplier: 1, streak: 1, shardSeed: 1 }));
  g.audio.handleGameEvent(ev('lost', { id: 2, kind: 'standard', x: 1, y: 1, reason: 'offscreen' }));
  g.audio.handleGameEvent(ev('streak', { level: 1, streak: 0 }));
  assert.deepEqual(ids(g), ['goldBreak']);
  // garbage never throws
  assert.doesNotThrow(() => { r.audio.handleGameEvent(null); r.audio.handleGameEvent({}); r.audio.handleGameEvent({ type: 'nope' }); });
});

test('shots pan with the shot point; launches pan with the house (skeet left on the left)', () => {
  const r = unlocked();
  r.audio.handleGameEvent(ev('launch', { ids: [1], house: 'skeetL', double: false }));
  const pans = r.ctx.nodes.filter((n) => n.kind === 'panner');
  assert.ok(pans.length === 1 && pans[0].pan.value < -0.4, `pan ${pans[0]?.pan.value}`);
  r.audio.handleGameEvent(ev('launch', { ids: [2], house: 'skeetR', double: false }));
  assert.ok(r.ctx.nodes.filter((n) => n.kind === 'panner')[1].pan.value > 0.4);
});

test('voice cap: never more than 24 voices; a shot is never dropped for ambience or UI; counters add up', () => {
  const r = unlocked();
  for (let i = 0; i < 60; i++) {
    r.audio.play(['bird', 'uiMove', 'clayBreak', 'cricket'][i % 4], { x: 500, species: i % 3 });
    r.ctx.currentTime += 0.13;
  }
  for (let i = 0; i < 30; i++) r.audio.play('uiSelect');
  for (let i = 0; i < 20; i++) r.audio.play('countTick', { progress: 0.5 });
  r.audio.play('shot', { x: 960 });
  const d = r.audio.getDebug();
  assert.ok(d.voiceCount <= AUDIO_CONFIG.voices);
  assert.ok(ids(r).includes('shot'), 'the shot got a voice');
  for (let i = 0; i < 40; i++) r.audio.play('bird', { species: 0 });
  assert.ok(ids(r).includes('shot'), 'birds never push a shot out');
});

test('ambience: the wind starts with a stage, follows the screen level (paused 0.35), birds in the meadow, crickets in the alpine dusk, silence without a stage', () => {
  const r = unlocked();
  r.audio.update(0.016, { screen: 'menu' });
  assert.equal(r.audio.getDebug().ambience.built, false, 'nothing before a stage is known');
  for (let i = 0; i < 60 * 12; i++) { r.ctx.currentTime += 1 / 60; r.audio.update(1 / 60, { screen: 'playing', stageId: 'meadow', snapshot: makeSnapshot({ stageId: 'meadow' }) }); }
  let d = r.audio.getDebug();
  assert.equal(d.ambience.built, true);
  assert.equal(d.ambience.stage, 'meadow');
  assert.equal(d.ambience.level, 1);
  assert.ok(d.ambience.wind > 0);
  assert.ok(d.stats.played >= 2, `birds sang: ${d.stats.played}`);
  const birds = d.stats.played;
  for (let i = 0; i < 60 * 10; i++) { r.ctx.currentTime += 1 / 60; r.audio.update(1 / 60, { screen: 'paused', stageId: 'meadow' }); }
  d = r.audio.getDebug();
  assert.equal(d.ambience.level, ambienceLevelFor('paused'));
  assert.equal(d.stats.played, birds, 'no calls in pause');
  const a = unlocked();
  for (let i = 0; i < 60 * 6; i++) { a.ctx.currentTime += 1 / 60; a.audio.update(1 / 60, { screen: 'playing', stageId: 'alpine' }); }
  assert.ok(a.audio.getDebug().stats.played >= 4, 'crickets');
  assert.ok(a.ctx.nodes.filter((n) => n.kind === 'osc' && n.frequency.calls.some((c) => c[1] > 4000)).length > 0);
  for (let i = 0; i < 30; i++) { a.ctx.currentTime += 1 / 60; a.audio.update(1 / 60, { screen: 'menu', stageId: null }); }
  assert.equal(a.audio.getDebug().ambience.wind, 0, 'the wind fades out without a stage');
  // volume 0 or muted: the ambience is silent and no call is synthesised
  const q = unlocked();
  q.audio.setMuted(true);
  for (let i = 0; i < 60 * 8; i++) { q.ctx.currentTime += 1 / 60; q.audio.update(1 / 60, { screen: 'playing', stageId: 'meadow' }); }
  assert.equal(q.audio.getDebug().stats.played, 0);
  assert.equal(q.audio.getDebug().ambience.wind, 0);
});

test('the per-frame update creates no node while idle (ambience built, pause: no calls) and prunes finished voices', () => {
  const r = unlocked();
  r.audio.update(0.016, { screen: 'paused', stageId: 'hills' });
  r.audio.play('shot');
  const n = r.ctx.nodes.length;
  for (let i = 0; i < 300; i++) { r.ctx.currentTime += 1 / 60; r.audio.update(1 / 60, { screen: 'paused', stageId: 'hills' }); }
  assert.equal(r.ctx.nodes.length, n);
  assert.equal(r.audio.getDebug().voiceCount, 0, 'the shot ended and was pruned');
});

test('NO LEAKS: after a long mixed session every voice node is disconnected once its sound has ended', () => {
  const r = unlocked();
  const events = allEvents();
  for (let i = 0; i < 400; i++) {
    r.audio.handleGameEvent(events[i % events.length]);
    r.ctx.currentTime += 0.05;
    r.audio.update(0.05, { screen: 'playing', stageId: 'alpine' });
  }
  r.ctx.currentTime += 5;
  r.audio.update(0.05, { screen: 'paused', stageId: 'alpine' });
  r.ctx.currentTime += 1;
  r.audio.update(0.05, { screen: 'paused', stageId: 'alpine' });
  const d = r.audio.getDebug();
  assert.equal(d.voiceCount, 0);
  assert.equal(d.retiring, 0);
  const live = r.ctx.nodes.filter((nd) => (nd.kind === 'osc' || nd.kind === 'noise') && !nd.disconnected);
  assert.ok(live.length <= 2, `only the two ambience sources stay connected (${live.length})`);
});

test('named functions for the UI: each plays its sound, safe with any arguments and before unlock', () => {
  const before = rig();
  for (const name of Object.keys(NAMED)) assert.doesNotThrow(() => before.audio[name](1, 'x'));
  for (const name of Object.keys(NAMED)) {
    const r = unlocked();
    r.audio[name](3);
    assert.equal(r.audio.getDebug().stats.played, 1, name);
    assert.equal(ids(r)[0], NAMED[name][0]);
  }
  for (const n of ['uiMove', 'uiConfirm', 'uiBack', 'countdown', 'go', 'record', 'connectOk', 'recenter']) assert.ok(n in NAMED, n);
});

test('the countdown climbs 3-2-1 by itself and resets after go; uiMove is rate limited', () => {
  const r = unlocked();
  const base = () => r.ctx.nodes.filter((n) => n.kind === 'osc').at(-2).frequency.calls[0][1]; // the wood layer (then the thump)
  r.audio.countdown();
  const a = base();
  r.ctx.currentTime += 1;
  r.audio.countdown();
  const b = base();
  assert.ok(b > a, 'higher');
  r.audio.go();
  r.ctx.currentTime += 0.5;
  r.audio.countdown();
  assert.equal(base(), a, 'restarted at 3');
  r.audio.uiMove();
  r.audio.uiMove();
  assert.equal(r.audio.getDebug().stats.rateLimited, 1);
});

test('determinism: the same random stream gives the same graph and automation, call for call', () => {
  const run = () => {
    const r = rig({ random: (() => { let s = 1; return () => { s = (s * 48271) % 2147483647; return s / 2147483647; }; })() });
    r.audio.unlock();
    for (const e of allEvents()) r.audio.handleGameEvent(e);
    for (let i = 0; i < 120; i++) { r.ctx.currentTime += 1 / 60; r.audio.update(1 / 60, { screen: 'playing', stageId: 'meadow' }); }
    return r.ctx.nodes.map((n) => [n.kind, n.gain?.calls.length ?? 0, n.frequency?.calls.length ?? 0, n.startOffset ?? null]);
  };
  assert.deepEqual(run(), run());
});

test('a context that throws while building a sound is counted, never thrown', () => {
  const r = unlocked();
  r.ctx.createOscillator = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => r.audio.play('shot'));
  assert.ok(r.audio.getDebug().stats.errors >= 1);
  assert.doesNotThrow(() => r.audio.dispose());
});

test('one open and one insert per Classic pull, none before the first shot (code review R-02)', () => {
  const r = unlocked();
  const played = () => r.audio.getDebug().voices.map((v) => v.id).filter((id) => id === 'gunOpen' || id === 'shellInsert');
  // the round starts: ready + reload start + reload done -> the shells go in, the gun never opens
  for (const e of [ev('ready', { stageIndex: 0, pullIndex: 0 }), ev('reload', { phase: 'start', ms: 400 }), ev('reload', { phase: 'done', ms: 0 })]) r.audio.handleGameEvent(e);
  assert.deepEqual(played(), ['shellInsert']);
  // a pull: two shots, settle (opens), then the next ready's reload start (no second open) and done (one insert)
  const s = unlocked();
  const ids2 = () => s.audio.getDebug().voices.map((v) => v.id).filter((id) => id === 'gunOpen' || id === 'shellInsert');
  for (const e of [
    ev('shot', { x: 900, y: 400, shell: 0, hitIds: [], source: 'mouse', compMs: 0 }), ev('shot', { x: 900, y: 400, shell: 1, hitIds: [], source: 'mouse', compMs: 0 }),
    ev('phase', { phase: 'settle' }), ev('ready', { stageIndex: 0, pullIndex: 1 }), ev('reload', { phase: 'start', ms: 400 }), ev('reload', { phase: 'done', ms: 0 }),
  ]) s.audio.handleGameEvent(e);
  assert.deepEqual(ids2(), ['gunOpen', 'shellInsert']);
  // Time Attack: shots, then a refill (reload start/done with ms 0): one open, one insert
  const t = unlocked();
  for (const e of [ev('shot', { x: 900, y: 400, shell: 0, hitIds: [], source: 'mouse', compMs: 0 }), ev('reload', { phase: 'start', ms: 0 }), ev('reload', { phase: 'done', ms: 0 })]) t.audio.handleGameEvent(e);
  assert.deepEqual(t.audio.getDebug().voices.map((v) => v.id).filter((id) => id !== 'shot'), ['gunOpen', 'shellInsert']);
});
