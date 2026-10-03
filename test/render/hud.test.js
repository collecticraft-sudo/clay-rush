// HUD (architecture 6.2, design 9): every phase of every mode draws with and without the art, text only through hv.t with the keys of
// architecture 8.5, banners from events, the stage card, the pull prompt, the battery toast, the shells and the tally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUD_KEYS, createHud, formatClock, formatScore } from '../../public/js/render/hud.js';
import { NULL_ASSETS } from '../../public/js/render/assets.js';
import { GAME_PHASE } from '../../public/js/shared/contracts.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { FakeCanvas, createFakeCanvasFactory } from '../../test-support/render/fake-canvas.js';
import { createArtStub } from '../../test-support/render/art-stub.js';
import { LABELS, allEvents, ev, makeSnapshot, makeTranslator } from '../../test-support/render/scenes.js';

/** Each tabular digit is drawn several times (shadow, stroke, fill): keep one per run. */
const collapse = (chars) => chars.filter((c, i) => c !== chars[i - 1]).join('');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The HUD keys listed in docs/architecture.md section 8.5. */
function architectureKeys() {
  const doc = readFileSync(join(ROOT, 'docs', 'architecture.md'), 'utf8');
  const sec = doc.slice(doc.indexOf('### 8.5'), doc.indexOf('## 9.'));
  return [...new Set([...sec.matchAll(/`(hud\.[A-Za-z.]+)`/g)].map((m) => m[1]))];
}

function rig({ art = false } = {}) {
  const factory = createFakeCanvasFactory();
  const assets = art ? createArtStub({ loaded: 'all', createCanvas: factory.createCanvas }) : NULL_ASSETS;
  const hud = createHud({ assets, createCanvas: factory.createCanvas });
  const canvas = new FakeCanvas(1920, 1080);
  const t = makeTranslator();
  let now = 1000;
  const hv = (o = {}) => ({ nowMs: now, t, labels: LABELS, reduceMotion: false, reduceFlash: false, battery: 'ok', ...o });
  const frame = (snapshot, o = {}, dt = 1 / 60) => {
    now += dt * 1000;
    hud.update(dt);
    canvas.ctx.reset();
    hud.draw(canvas.ctx, snapshot, hv(o));
    return canvas.ctx.texts.map((x) => x.text);
  };
  return { hud, ctx: canvas.ctx, t, frame, factory, get now() { return now; } };
}

test('HUD_KEYS is exactly the list of architecture 8.5', () => {
  assert.deepEqual([...HUD_KEYS].sort(), architectureKeys().sort());
});

test('every phase of every mode draws without throwing, with and without the art, and asks hv.t only for 8.5 keys', () => {
  const allowed = new Set(architectureKeys());
  for (const art of [false, true]) {
    for (const mode of ['classic', 'timeattack', 'zen', 'practice']) {
      const r = rig({ art });
      r.hud.handleEvents(allEvents(), r.now);
      for (const phase of Object.values(GAME_PHASE)) {
        const over = { mode, phase };
        if (mode === 'timeattack') Object.assign(over, { timeLeft: 42.3, timeTotal: 90, pull: { index: 0, count: null, targetsLeft: 2 } });
        if (mode === 'zen') Object.assign(over, { shells: { loaded: 2, capacity: 2, reloadingS: 0, infinite: true } });
        const snap = assertValid('GameSnapshot', makeSnapshot(over));
        for (let i = 0; i < 20; i++) assert.doesNotThrow(() => r.frame(snap, { battery: i < 10 ? 'low' : 'critical', reduceMotion: i % 2 === 0, reduceFlash: i % 3 === 0 }), `${mode} ${phase}`);
      }
      assert.ok(r.t.calls.length > 0);
      const bad = r.t.calls.filter((k) => !allowed.has(k));
      assert.deepEqual([...new Set(bad)], [], `${mode}: only 8.5 keys`);
      assert.deepEqual(r.ctx.forbidden, []);
    }
  }
});

test('classic flight: score, multiplier, stage line and pull counter, wind, shells; strings are asked for only when they change', () => {
  const r = rig();
  const snap = makeSnapshot({ stageId: 'hills', score: 12450, multiplier: 3 });
  for (let i = 0; i < 90; i++) r.frame(snap);
  const texts = r.frame(snap);
  assert.ok(texts.includes('SCORE'));
  assert.ok(texts.includes('X3'), 'display text in capitals');
  assert.ok(texts.includes('STAGE 2: GOLDEN HILLS'));
  assert.ok(texts.includes('PULL 4/8'));
  assert.ok(texts.includes('1.5 M/S'));
  // the score rolls up to the target and is drawn digit by digit (tabular cells)
  const digits = collapse(texts.filter((x) => /^[0-9,]$/.test(x)));
  assert.equal(digits, '12,450');
  const before = r.t.calls.length;
  for (let i = 0; i < 30; i++) r.frame(snap);
  assert.equal(r.t.calls.length, before, 'no hv.t call while nothing changes (memoised)');
});

test('time attack: the clock (hud.time) with M:SS and the low-time warning; zen: the session stats', () => {
  const r = rig();
  const ta = makeSnapshot({ mode: 'timeattack', timeLeft: 65.2, timeTotal: 90, pull: { index: 0, count: null, targetsLeft: 1 } });
  r.frame(ta);
  assert.ok(r.t.calls.includes('hud.time'));
  const digits = collapse(r.ctx.texts.map((x) => x.text).filter((x) => /^[0-9:]$/.test(x)));
  assert.ok(digits.includes('1:06'), digits);
  const z = rig();
  z.hud.handleEvents([ev('shot', { x: 1, y: 1, shell: -1, hitIds: [3], source: 'mouse', compMs: 0 }), ev('shot', { x: 1, y: 1, shell: -1, hitIds: [], source: 'mouse', compMs: 0 })], z.now);
  const texts = z.frame(makeSnapshot({ mode: 'zen', stats: { presented: 3, broken: 1, lost: 2, shots: 2, hits: 1, centre: 0, doubles: 0, bestStreak: 1 } }));
  assert.ok(texts.includes('1 HITS, 50% OF THE LAST 20'), texts.join('|'));
});

test('banners: DOUBLE!, TWO WITH ONE!, STREAK x3, PERFECT STAGE and TIME! come from their events, one at a time; SMOKED! from a centre hit', () => {
  const r = rig();
  const snap = makeSnapshot();
  r.frame(snap);
  r.hud.handleEvents([ev('double', { points: 100, x: 960, y: 400 })], r.now);
  r.frame(snap);
  assert.equal(r.hud.getDebug().banner, 'hud.banner.double');
  r.hud.handleEvents([
    ev('twoWithOne', { points: 200, x: 960, y: 400 }), ev('streak', { level: 3, streak: 6 }), ev('stageClear', { index: 0, perfect: true, bonus: 500 }),
    ev('timeUp', { score: 9000 }),
  ], r.now);
  const seen = new Set();
  for (let i = 0; i < 60 * 8; i++) {
    r.frame(snap);
    const b = r.hud.getDebug().banner;
    if (b) seen.add(b);
  }
  assert.ok(r.hud.getDebug().queued <= 3, 'the queue is capped');
  for (const k of ['hud.banner.double', 'hud.banner.streak', 'hud.banner.perfect', 'hud.banner.timeUp']) assert.ok(seen.has(k), k);
  assert.ok(r.t.calls.includes('hud.banner.streak'));
  r.hud.handleEvents([ev('hit', { id: 1, kind: 'standard', x: 800, y: 500, z: 20, rPx: 12, vx: 0, vy: 0, points: 175, centre: true, firstBarrel: true, multiplier: 1, streak: 1, shardSeed: 1 })], r.now);
  r.frame(snap);
  assert.ok(r.t.calls.includes('hud.banner.smoked'));
  r.hud.showBanner('newBest');
  for (let i = 0; i < 5; i++) r.frame(snap);
  assert.equal(r.hud.getDebug().banner, 'hud.banner.newBest');
});

test('phase ready: "PRESS ZR TO CALL PULL!" with the active fire label; stageCard: the stage card with its title and name', () => {
  const r = rig();
  const texts = r.frame(makeSnapshot({ phase: 'ready' }));
  assert.ok(texts.includes('PRESS ZR TO CALL PULL!'));
  const left = rig();
  const t2 = left.frame(makeSnapshot({ phase: 'ready' }), { labels: { ...LABELS, fire: 'ZL' } });
  assert.ok(t2.includes('PRESS ZL TO CALL PULL!'));
  const c = rig();
  c.frame(makeSnapshot({ phase: 'flight' }));
  let cardTexts = [];
  for (let i = 0; i < 30; i++) cardTexts = c.frame(makeSnapshot({ phase: 'stageCard', stageId: 'alpine' }));
  assert.equal(c.hud.getDebug().card, true);
  assert.ok(cardTexts.includes('STAGE 3') && cardTexts.includes('ALPINE DUSK'), cardTexts.join('|'));
  for (let i = 0; i < 40; i++) c.frame(makeSnapshot({ phase: 'ready', stageId: 'alpine' }));
  assert.equal(c.hud.getDebug().card, false, 'the card leaves when the phase changes');
});

test('low battery: a toast (hud.lowBattery) for a while when the battery turns low, for good when critical', () => {
  const r = rig();
  const snap = makeSnapshot();
  assert.ok(!r.frame(snap).includes('Joy-Con battery low'));
  assert.ok(r.frame(snap, { battery: 'low' }).includes('Joy-Con battery low'));
  for (let i = 0; i < 60 * 7; i++) r.frame(snap, { battery: 'low' });
  assert.ok(!r.frame(snap, { battery: 'low' }).includes('Joy-Con battery low'), 'the low toast goes away');
  for (let i = 0; i < 60 * 7; i++) r.frame(snap, { battery: 'critical' });
  assert.ok(r.frame(snap, { battery: 'critical' }).includes('Joy-Con battery low'), 'critical stays');
});

test('shells: reloading shows RELOADING, a dry fire shows EMPTY; the tally counts launched, broken and lost clays', () => {
  const r = rig();
  assert.ok(r.frame(makeSnapshot({ shells: { loaded: 0, capacity: 2, reloadingS: 0.4, infinite: false } })).includes('RELOADING'));
  r.hud.handleEvents([ev('dryFire', { x: 1, y: 1 })], r.now);
  assert.ok(r.frame(makeSnapshot({ shells: { loaded: 0, capacity: 2, reloadingS: 0, infinite: false } })).includes('EMPTY'));
  r.hud.handleEvents([ev('stageStart', { index: 0, id: 'meadow', name: 'MORNING MEADOW', windX: 0 }), ev('launch', { ids: [1, 2], house: 'trap', double: true }), ev('hit', { id: 1, kind: 'standard', x: 1, y: 1, z: 20, rPx: 10, vx: 0, vy: 0, points: 100, centre: false, firstBarrel: true, multiplier: 1, streak: 1, shardSeed: 1 }), ev('lost', { id: 2, kind: 'standard', x: 1, y: 1, reason: 'far' })], r.now);
  r.frame(makeSnapshot());
  assert.equal(r.hud.getDebug().tally, 2);
  r.hud.handleEvents([ev('stageStart', { index: 1, id: 'hills', name: 'GOLDEN HILLS', windX: 1.5 })], r.now);
  r.frame(makeSnapshot());
  assert.equal(r.hud.getDebug().tally, 0, 'a new stage starts a new tally');
  r.hud.reset();
  assert.equal(r.hud.getDebug().banner, null);
});

test('formatClock and formatScore', () => {
  assert.equal(formatClock(65.2), '1:06');
  assert.equal(formatClock(9), '0:09');
  assert.equal(formatClock(-3), '0:00');
  assert.equal(formatScore(0), '0');
  assert.equal(formatScore(999), '999');
  assert.equal(formatScore(12450), '12,450');
  assert.equal(formatScore(1234567), '1,234,567');
});

test('draw is a no-op without a snapshot or a translator (never throws)', () => {
  const r = rig();
  assert.doesNotThrow(() => r.hud.draw(r.ctx, null, { t: () => '' }));
  assert.doesNotThrow(() => r.hud.draw(r.ctx, makeSnapshot(), null));
  assert.doesNotThrow(() => r.hud.draw(r.ctx, makeSnapshot(), { nowMs: 0, t: () => { throw new Error('broken'); }, labels: LABELS }));
});

test('PERFECT STAGE survives the stageStart of the same tick and shows right after the stage card; other banners are dropped (R-01)', () => {
  const r = rig();
  r.frame(makeSnapshot({ phase: 'settle' }));
  r.hud.handleEvents([ev('double', { points: 100, x: 960, y: 400 }), ev('stageClear', { index: 0, perfect: true, bonus: 500 }), ev('stageStart', { index: 1, id: 'hills', name: 'GOLDEN HILLS', windX: -1.5 })], r.now);
  const seen = [];
  for (let i = 0; i < 60 * 3; i++) {
    r.frame(makeSnapshot({ phase: 'stageCard', stageId: 'hills' }));
    if (r.hud.getDebug().banner) seen.push(r.hud.getDebug().banner);
  }
  assert.deepEqual(seen, [], 'nothing over the card');
  for (let i = 0; i < 60; i++) {
    r.frame(makeSnapshot({ phase: 'ready', stageId: 'hills' }));
    if (r.hud.getDebug().banner) seen.push(r.hud.getDebug().banner);
  }
  assert.ok(seen.includes('hud.banner.perfect'));
  assert.ok(!seen.includes('hud.banner.double'));
});

test('the stage card shows the wind of the new stage (sock, arrow, speed) (QA F10); Zen shows the stage name without a number (QA F11)', () => {
  const r = rig();
  r.frame(makeSnapshot({ phase: 'flight' }));
  r.hud.handleEvents([ev('stageStart', { index: 2, id: 'alpine', name: 'ALPINE DUSK', windX: -2.5 })], r.now);
  let texts = [];
  for (let i = 0; i < 30; i++) texts = r.frame(makeSnapshot({ phase: 'stageCard', stageId: 'alpine' }));
  assert.ok(texts.includes('2.5 M/S'), texts.join('|'));
  const z = rig();
  const zt = z.frame(makeSnapshot({ mode: 'zen', stageId: 'hills' }));
  assert.ok(zt.includes('GOLDEN HILLS') && !zt.some((t) => t.startsWith('STAGE ')), zt.join('|'));
});

test('the top bar names the new stage only once the stage card has slid in with it (video review)', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.frame(makeSnapshot({ phase: 'flight', stageId: 'hills' }));
  r.hud.handleEvents([ev('stageStart', { index: 2, id: 'alpine', name: 'ALPINE DUSK', windX: -2.5 })], r.now);
  let texts = r.frame(makeSnapshot({ phase: 'stageCard', stageId: 'alpine' }));
  assert.ok(texts.includes('STAGE 2: GOLDEN HILLS'), 'still the old stage while the card slides in');
  for (let i = 0; i < 30; i++) texts = r.frame(makeSnapshot({ phase: 'stageCard', stageId: 'alpine' }));
  assert.ok(texts.includes('STAGE 3: ALPINE DUSK'));
});
