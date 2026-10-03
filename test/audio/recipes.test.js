// Sound recipes (audio/recipes.js, architecture 6.4, design 8): every sound exists, renders with the fake context, has a sane envelope,
// and carries the character the design asks for (the shot's thump and tail, the clay's crack, the two-tone whistle, ...).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUS_OF, LEVEL_DB, PRIORITY, RECIPES, SOUND_IDS, buildRecipe, distanceGain, pentatonicSemitone, rankIndex } from '../../public/js/audio/recipes.js';
import { createAudio } from '../../public/js/audio/audio.js';
import { FakeAudioContext } from '../../test-support/audio/fake-audio-context.js';

const REQUIRED = [
  // architecture 6.4
  'shot', 'dryClick', 'clayBreak', 'goldBreak', 'shellInsert', 'gunOpen', 'pullCue', 'throw', 'double', 'streakUp', 'stageClear', 'timeTick', 'timeUp',
  // ambience calls
  'bird', 'cricket',
  // the UI sounds that stay
  'uiMove', 'uiSelect', 'uiConfirm', 'uiBack', 'countdown', 'go', 'record', 'calStep', 'calHold', 'calOk', 'calFail', 'connectOk', 'recenter',
];
const FRUIT = ['slice', 'swoosh', 'bombBoom', 'bombFuse', 'bombWarn', 'bombNear', 'comboStep', 'comboChime', 'golden', 'goldenSpawn', 'freezeActivate', 'frenzyActivate', 'lifeLost', 'miss', 'gameOver'];
const tags = (r) => r.layers.map((l) => l.tag).filter(Boolean);
const freqOf = (f) => (typeof f === 'number' ? f : f.from);

test('every required sound has a recipe and no fruit sound is left', () => {
  for (const id of REQUIRED) assert.ok(RECIPES[id], id);
  for (const id of FRUIT) assert.equal(RECIPES[id], undefined, `${id} removed`);
  assert.deepEqual(SOUND_IDS, Object.keys(RECIPES));
});

test('envelopes: durationMs is the latest layer end; attack <= end; gains, frequencies and filters sane; category, bus, priority and level valid', () => {
  const variants = (id) => [{}, { shell: 1 }, { centre: true, z: 40 }, { big: true }, { level: 4 }, { perfect: true }, { urgent: true }, { species: 1 }, { species: 2 }, { n: 1 }, { rank: 'S' }, { reverse: true }].map((p) => buildRecipe(id, p));
  for (const id of SOUND_IDS) {
    for (const r of variants(id)) {
      assert.equal(r.id, id);
      assert.ok(r.category in BUS_OF, `${id} category ${r.category}`);
      assert.equal(r.priority, PRIORITY[r.category]);
      assert.ok(Number.isFinite(r.levelDb) && r.levelDb <= 0, `${id} level`);
      assert.ok(r.trim > 0 && r.trim < 6, `${id} trim ${r.trim}`);
      let end = 0;
      for (const l of r.layers) {
        end = Math.max(end, l.startMs + l.endMs);
        assert.ok(l.type === 'osc' || l.type === 'noise', id);
        assert.ok(l.attackMs >= 0 && l.attackMs <= l.endMs, `${id} attack`);
        assert.ok(l.gain > 0 && l.gain <= 1.0, `${id} gain ${l.gain}`);
        if (l.type === 'osc') assert.ok(freqOf(l.freq) > 20 && freqOf(l.freq) < 12000, `${id} freq`);
        if (l.filter) assert.ok(['lowpass', 'highpass', 'bandpass'].includes(l.filter.type) && freqOf(l.filter.freq) > 20, `${id} filter`);
      }
      assert.equal(r.durationMs, end, `${id} duration`);
      assert.ok(r.durationMs <= 2500, `${id} is short enough`);
    }
  }
});

test('levels: the shot is the loudest gameplay sound, clays below it, events below, UI at -18 dBFS or lower, ambience far below', () => {
  assert.equal(LEVEL_DB.gun, -4);
  assert.equal(buildRecipe('shot').levelDb, -3);
  assert.ok(buildRecipe('clayBreak').levelDb < buildRecipe('shot').levelDb);
  for (const id of ['uiMove', 'uiSelect', 'uiBack', 'uiError', 'countTick', 'recenter']) assert.ok(buildRecipe(id).levelDb <= -18, id);
  assert.ok(buildRecipe('bird').levelDb <= -26 && buildRecipe('cricket').levelDb <= -26);
});

test('shot: a crack, a noise blast falling from 5 kHz, a thump that drops to about 46 Hz, a 60 Hz sub and a long dark tail; it ducks the ambience', () => {
  const r = buildRecipe('shot');
  assert.deepEqual(tags(r), ['crack', 'mech', 'blast', 'thump', 'sub', 'tail']);
  const thump = r.layers.find((l) => l.tag === 'thump');
  assert.ok(thump.freq.from > 100 && thump.freq.to < 60);
  assert.equal(r.layers.find((l) => l.tag === 'sub').freq, 60);
  const tail = r.layers.find((l) => l.tag === 'tail');
  assert.ok(tail.endMs >= 1200 && tail.filter.type === 'lowpass');
  assert.ok(r.wet > 0);
  assert.deepEqual(r.duck[0].groups, ['amb']);
  const second = buildRecipe('shot', { shell: 1 });
  assert.ok(second.layers[0].filter.freq > r.layers[0].filter.freq, 'the second barrel is a touch brighter');
});

test('clay break: crack, ceramic ping, thock, crumble, debris; a centre hit adds a shatter and a puff and is louder; far clays are quieter', () => {
  const r = buildRecipe('clayBreak', { z: 15, jitter: 1 });
  for (const t of ['crack', 'ping', 'thock', 'crumble', 'debris']) assert.ok(tags(r).includes(t), t);
  const c = buildRecipe('clayBreak', { z: 15, centre: true, jitter: 1 });
  assert.ok(tags(c).includes('shatter') && tags(c).includes('puff'));
  assert.ok(c.levelDb > r.levelDb && c.trim > r.trim);
  const far = buildRecipe('clayBreak', { z: 60, jitter: 1 });
  assert.ok(far.layers[0].gain < r.layers[0].gain);
  assert.equal(distanceGain(10), 1);
  assert.ok(distanceGain(60) < 0.6 && distanceGain(200) === 0.55);
  const gold = buildRecipe('goldBreak', { z: 20 });
  assert.ok(tags(gold).includes('shimmer') && tags(gold).includes('glitter') && tags(gold).includes('shatter'));
});

test('pullCue is a two-tone whistle (no voice); throw is a clunk with a twang and a whoosh; shellInsert ends with the action closing', () => {
  const p = buildRecipe('pullCue');
  const tones = p.layers.filter((l) => l.tag === 'tone' && l.wave === 'sine');
  assert.equal(tones.length, 2);
  assert.ok(tones[1].startMs > tones[0].startMs && freqOf(tones[1].freq) > freqOf(tones[0].freq) * 1.2, 'two tones, the second higher');
  assert.deepEqual([...new Set(tags(buildRecipe('throw')))], ['clunk', 'twang', 'whoosh']);
  const s = buildRecipe('shellInsert');
  assert.equal(s.layers.filter((l) => l.tag === 'slide').length, 2, 'two shells');
  assert.ok(s.layers.some((l) => l.tag === 'clack' && l.startMs >= 250));
  assert.ok(tags(buildRecipe('gunOpen')).includes('eject'));
});

test('events: double vs two-with-one, streakUp grows with the level, stageClear perfect is bigger, timeTick urgent, timeUp horn and bell', () => {
  assert.ok(buildRecipe('double', { big: true }).layers.length > buildRecipe('double').layers.length);
  const n = (lv) => buildRecipe('streakUp', { level: lv }).layers.filter((l) => l.tag === 'note').length;
  assert.ok(n(2) < n(3) && n(3) < n(4));
  assert.ok(tags(buildRecipe('streakUp', { level: 4 })).includes('taiko'));
  assert.ok(buildRecipe('stageClear', { perfect: true }).durationMs > buildRecipe('stageClear').durationMs);
  assert.equal(buildRecipe('timeTick', { urgent: true }).layers[0].freq, 1400);
  assert.equal(buildRecipe('timeTick').layers[0].freq, 1000);
  assert.ok(tags(buildRecipe('timeUp')).includes('horn') && tags(buildRecipe('timeUp')).includes('bell'));
  assert.ok(buildRecipe('slowmo').masterFilter.dipHz < 3000);
});

test('ambience calls: three bird species (chirps, trill, whistle), crickets in pulses; rate limited and capped', () => {
  assert.ok(tags(buildRecipe('bird', { species: 0 })).every((t) => t === 'chirp'));
  assert.ok(tags(buildRecipe('bird', { species: 1 })).every((t) => t === 'trill'));
  assert.ok(tags(buildRecipe('bird', { species: 2 })).every((t) => t === 'whistle'));
  const c = buildRecipe('cricket');
  assert.equal(c.layers.length, 3);
  assert.ok(c.layers.every((l) => freqOf(l.freq) > 4000));
  for (const id of ['bird', 'cricket']) {
    const r = buildRecipe(id);
    assert.equal(r.category, 'amb');
    assert.ok(r.maxVoices >= 1 && r.minGapMs > 0);
  }
});

test('helpers: pentatonic steps, rank index', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 20].map(pentatonicSemitone), [0, 2, 4, 7, 9, 21]);
  assert.equal(rankIndex('S'), 5);
  assert.equal(rankIndex('d'), 1);
  assert.equal(rankIndex(9), 5);
  assert.equal(rankIndex('?'), 3);
});

test('every recipe renders through the engine with the fake AudioContext: nodes are created, started, stopped and nothing throws', () => {
  for (const id of SOUND_IDS) {
    const ctx = new FakeAudioContext();
    const audio = createAudio({ createContext: () => ctx, random: () => 0.5 });
    audio.unlock();
    const before = ctx.nodes.length;
    audio.play(id, { x: 300, shell: 0, z: 25, level: 3, species: 1 });
    const d = audio.getDebug();
    assert.equal(d.stats.errors, 0, id);
    assert.equal(d.stats.played, 1, id);
    assert.ok(ctx.nodes.length > before, `${id} built nodes`);
    const sources = ctx.nodes.slice(before).filter((n) => n.kind === 'osc' || n.kind === 'noise');
    assert.ok(sources.length > 0 && sources.every((s) => s.startedAt !== null && s.stoppedAt !== null && s.stoppedAt > s.startedAt), id);
  }
});

test('the recipes are pure data: building twice gives equal results', () => {
  for (const id of SOUND_IDS) assert.deepEqual(buildRecipe(id, { x: 1, z: 20, jitter: 1 }), buildRecipe(id, { x: 1, z: 20, jitter: 1 }), id);
  assert.throws(() => buildRecipe('nope'));
});
