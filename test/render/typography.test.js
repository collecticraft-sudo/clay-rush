// The text recipes of draw-util.js and the roles of palette.js (architecture 6.3, retuned for the condensed display face): looks, hard offset
// shadow, gradient fill made once, fit-to-width, tabular digits, baked sprites, cache invalidation, and the plain drawText left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, FONTS, TEXT_STYLES, fontString, letterSpacingPx } from '../../public/js/render/palette.js';
import {
  TEXT_LOOKS, TEXT_TINTS, bakeTextSprite, digitsWidth, drawDigits, drawStyled, drawText, easeInCubic, easeInOutSine, easeOutExpo, fitText,
  invalidateTextCaches, textSpriteBytes, textSpriteCount,
} from '../../public/js/render/draw-util.js';
import { FakeCanvas, FakeContext } from '../../test-support/render/fake-canvas.js';

const mkctx = () => new FakeContext(new FakeCanvas(1920, 1080));
const names = (ctx) => ctx.calls.map((c) => c[0]);

test.beforeEach(() => invalidateTextCaches());

// ------------------------------------------------------------------------------------------------------------------------- palette roles

test('roles: every style has a family, a size and a minSize of at least 28, a weight, a tracking and a look; the direction table sizes hold', () => {
  for (const [name, s] of Object.entries(TEXT_STYLES)) {
    assert.ok(s.family === 'display' || s.family === 'ui', `${name}: family`);
    assert.ok(s.size >= 28, `${name}: size ${s.size} is at least 28`);
    assert.ok(s.minSize >= 28 && s.minSize <= s.size, `${name}: minSize ${s.minSize}`);
    assert.ok(Number.isInteger(s.weight) && s.weight >= 400 && s.weight <= 900, `${name}: weight`);
    assert.ok(s.tracking >= 0 && s.tracking <= 0.15, `${name}: tracking in em`);
    assert.ok(['plain', 'banner', 'plate', 'popup', 'headline', 'numeral', 'label'].includes(s.look), `${name}: look`);
  }
  const size = (k) => TEXT_STYLES[k].size;
  assert.deepEqual([size('banner84'), size('banner110'), size('banner132')], [110, 150, 190]);
  assert.deepEqual([size('popup44'), size('popup64'), size('popupLabel')], [56, 80, 28]);
  assert.deepEqual([size('numeral'), size('numeralTimer'), size('hudNumber'), size('hudTimer')], [96, 84, 96, 84]);
  assert.deepEqual([size('body'), size('bodyBold'), size('small'), size('display')], [34, 34, 28, 190]);
  assert.equal(TEXT_STYLES.small.size, 28, 'the smallest text is 28 px');
  for (const k of ['button', 'buttonSmall', 'buttonTiny', 'headline', 'stageCard', 'hudInfo']) assert.equal(TEXT_STYLES[k].family, 'display');
  for (const k of ['body', 'bodyBold', 'small', 'popupLabel', 'hudLabel']) assert.equal(TEXT_STYLES[k].family, 'ui');
  assert.ok(TEXT_STYLES.body.weight <= 650 && TEXT_STYLES.bodyBold.weight > 650, 'Barlow 600 for body, 700 for bold (the two ClayUI faces)');
  assert.ok(Object.isFrozen(TEXT_STYLES) && Object.values(TEXT_STYLES).every(Object.isFrozen));
});

test('fontString: weight, size and the role stack, memoised; a size override changes only the size', () => {
  assert.equal(fontString('body'), `600 34px ${FONTS.ui}`);
  assert.equal(fontString('headline'), `700 92px ${FONTS.display}`);
  assert.equal(fontString('headline', 60), `700 60px ${FONTS.display}`);
  assert.equal(fontString('body'), fontString('body'));
  assert.equal(fontString('body', 34), fontString('body'), 'the default size is the memoised string');
  assert.match(fontString('banner132'), /^700 190px "ClayDisplay", "Bebas Neue", /);
  assert.match(fontString('body'), /^600 34px "ClayUI", "Barlow", /);
});

test('letterSpacingPx: tracking in em times the size, as a CSS length', () => {
  assert.equal(letterSpacingPx('button'), '3.84px'); // 0.06 em x 64
  assert.equal(letterSpacingPx('button', 50), '3px');
  assert.equal(letterSpacingPx('popupLabel'), '2.24px');
  assert.equal(letterSpacingPx('hudNumber'), '1.92px');
  assert.equal(letterSpacingPx('nope', 40), '0px', 'an unknown role has no tracking');
  assert.equal(letterSpacingPx('button', 50), letterSpacingPx('button', 50));
});

test('easings of the direction: oE, iC and sine', () => {
  assert.equal(easeOutExpo(0), 0);
  assert.equal(easeOutExpo(1), 1);
  assert.ok(easeOutExpo(0.5) > 0.96);
  assert.equal(easeInCubic(0.5), 0.125);
  assert.ok(Math.abs(easeInOutSine(0.5) - 0.5) < 1e-12 && easeInOutSine(0) === 0 && Math.abs(easeInOutSine(1) - 1) < 1e-12);
});

// ------------------------------------------------------------------------------------------------------------------------- drawText stays

test('drawText without a look draws exactly what it always drew: strokeText then fillText, no save, no translate, no shadow, no gradient', () => {
  const ctx = mkctx();
  drawText(ctx, 'Hello', 100, 200, { style: 'headline', fill: '#111', stroke: '#eee', strokeWidth: 12, align: 'center' });
  assert.deepEqual(names(ctx), ['strokeText', 'fillText']);
  assert.deepEqual(ctx.calls[0], ['strokeText', 'HELLO', 100, 200], 'a display role is drawn in capitals (QA F15)');
  assert.deepEqual(ctx.calls[1], ['fillText', 'HELLO', 100, 200]);
  assert.equal(ctx.lineWidth, 12);
  assert.equal(ctx.fillStyle, '#111');
  assert.equal(ctx.font, fontString('headline'));
  const plain = mkctx();
  drawText(plain, 'x', 1, 2, { look: 'plain', fill: '#222' });
  assert.deepEqual(names(plain), ['fillText'], "look 'plain' is the same as no look");
});

// ------------------------------------------------------------------------------------------------------------------------- looks

test('banner look: hard offset shadow (stroke and fill, no blur), slate stroke 0.12 em, vertical gold gradient fill; one save and restore', () => {
  const ctx = mkctx();
  const stops = [];
  ctx.createLinearGradient = (...a) => ({ args: a, addColorStop: (o, c) => stops.push([o, c]) });
  drawStyled(ctx, 'STREAK', 960, 290, { style: 'banner132', look: 'banner', align: 'center' });
  assert.deepEqual(names(ctx), ['save', 'translate', 'strokeText', 'fillText', 'strokeText', 'fillText', 'restore']);
  assert.deepEqual(ctx.calls[1], ['translate', 960, 290]);
  const [, , shadowStroke, shadowFill, stroke, fill] = ctx.calls;
  assert.deepEqual(shadowStroke.slice(0, 2), ['strokeText', 'STREAK']);
  assert.ok(Math.abs(shadowStroke[2] - 0.03 * 190) < 1e-9 && Math.abs(shadowStroke[3] - 0.075 * 190) < 1e-9, 'shadow offset (0.03, 0.075) em');
  assert.deepEqual(shadowFill.slice(2), shadowStroke.slice(2));
  assert.deepEqual(stroke.slice(2), [0, 0]);
  assert.deepEqual(fill.slice(2), [0, 0]);
  assert.equal(ctx.lineWidth, 0.12 * 190);
  assert.equal(ctx.lineJoin, 'round');
  assert.equal(ctx.miterLimit, 2);
  assert.deepEqual(stops, [[0, '#FFF0A8'], [0.5, '#F2C230'], [1, '#C8861A']], 'the gold stops');
  assert.equal(ctx.forbidden.length, 0, 'no shadowBlur, no filter');
  assert.equal(ctx.textAlign, 'center');
});

test('the tint picks the gradient: orange, cream, sky and terracotta (and the legacy names); an unknown tint is gold', () => {
  for (const tint of ['orange', 'cream', 'sky', 'terracotta', 'vermilion', 'ice', 'paper', 'whatever']) {
    const ctx = mkctx();
    const stops = [];
    ctx.createLinearGradient = () => ({ addColorStop: (o, c) => stops.push(c) });
    drawStyled(ctx, 'DOUBLE!', 0, 0, { style: 'banner110', look: 'banner', tint });
    assert.deepEqual(stops, TEXT_TINTS[TEXT_TINTS[tint] ? tint : 'gold'], tint);
  }
  assert.deepEqual(TEXT_TINTS.orange, ['#FFC08A', '#F26B1D', '#B8460C']);
  assert.equal(TEXT_TINTS.vermilion, TEXT_TINTS.orange);
  assert.equal(TEXT_TINTS.ice, TEXT_TINTS.sky);
  assert.equal(TEXT_TINTS.paper, TEXT_TINTS.cream);
});

test('the gradient is created once per tint and size for a context, never per draw (no per-frame gradients)', () => {
  const ctx = mkctx();
  let made = 0;
  ctx.createLinearGradient = () => { made++; return { addColorStop() {} }; };
  for (let i = 0; i < 200; i++) drawStyled(ctx, `STREAK ${i}`, 960 + i, 290 + i, { style: 'banner132', look: 'banner', tint: 'gold', align: 'center' });
  assert.equal(made, 1);
  drawStyled(ctx, 'x', 0, 0, { style: 'banner132', look: 'banner', tint: 'ice' });
  drawStyled(ctx, 'x', 0, 0, { style: 'banner110', look: 'banner', tint: 'gold' });
  drawStyled(ctx, 'x', 0, 0, { style: 'banner110', look: 'banner', tint: 'gold', baseline: 'middle' });
  assert.equal(made, 4, 'a new tint, a new size and the middle baseline are new gradients');
});

test('plate look (button label): cream fill, slate stroke 0.09 em, a hard shadow 3 px down, tracking from the style', () => {
  const ctx = mkctx();
  ctx.letterSpacing = '0px';
  drawStyled(ctx, 'Play again', 480, 540, { style: 'button', look: 'plate', align: 'center', baseline: 'middle' });
  assert.deepEqual(ctx.calls[2], ['strokeText', 'PLAY AGAIN', 0, 3]);
  assert.deepEqual(ctx.calls[3], ['fillText', 'PLAY AGAIN', 0, 3]);
  assert.deepEqual(ctx.calls[4], ['strokeText', 'PLAY AGAIN', 0, 0]);
  assert.equal(ctx.fillStyle, COLORS.cream);
  assert.equal(ctx.letterSpacing, '0px', 'the spacing is put back after the text');
  assert.ok(Math.abs(ctx.lineWidth - 0.09 * 64) < 1e-9);
  assert.equal(ctx.strokeStyle, COLORS.slate);
});

test('the shadow colour: slate for banners (alpha 0.92) and a burnt brown for plates; the alpha goes back after the shadow', () => {
  const ctx = mkctx();
  const log = [];
  Object.defineProperty(ctx, 'fillStyle', { get: () => ctx._f, set: (v) => { ctx._f = v; log.push(['fillStyle', v, ctx.globalAlpha]); } });
  drawStyled(ctx, 'GO!', 0, 0, { style: 'banner132', look: 'banner' });
  assert.deepEqual(log[0], ['fillStyle', '#1B1F24', 0.92]);
  assert.equal(ctx.globalAlpha, 1);
  log.length = 0;
  drawStyled(ctx, 'Go', 0, 0, { style: 'button', look: 'plate' });
  assert.deepEqual(log[0], ['fillStyle', '#7A2E0A', 1]);
});

test('headline look: slate fill with a cream stroke, no shadow; numeral (HUD digits): cream fill, slate stroke and a hard drop; label: no shadow', () => {
  const h = mkctx();
  drawStyled(h, 'ZEN', 0, 0, { style: 'headline', look: 'headline' });
  assert.deepEqual(names(h), ['save', 'translate', 'strokeText', 'fillText', 'restore']);
  assert.equal(h.fillStyle, COLORS.slate);
  assert.equal(h.strokeStyle, COLORS.cream);
  assert.ok(Math.abs(h.lineWidth - 0.12 * TEXT_STYLES.headline.size) < 1e-9);
  const n = mkctx();
  drawStyled(n, '7', 0, 0, { style: 'numeral', look: 'numeral' });
  assert.deepEqual(names(n), ['save', 'translate', 'strokeText', 'fillText', 'strokeText', 'fillText', 'restore']);
  assert.equal(n.fillStyle, COLORS.cream);
  assert.equal(n.strokeStyle, COLORS.slate);
  const l = mkctx();
  drawStyled(l, 'SCORE', 0, 0, { style: 'hudLabel', look: 'label' });
  assert.deepEqual(names(l), ['save', 'translate', 'strokeText', 'fillText', 'restore']);
});

test('explicit fill, stroke and strokeWidth win over the look; stroke null removes the stroke; shadow:false removes the shadow; alpha multiplies', () => {
  const ctx = mkctx();
  drawStyled(ctx, 'x', 0, 0, { style: 'popup44', look: 'popup', fill: '#C8553D', stroke: null, shadow: false, alpha: 0.5 });
  assert.deepEqual(names(ctx), ['save', 'translate', 'fillText', 'restore']);
  assert.equal(ctx.fillStyle, '#C8553D');
  const c2 = mkctx();
  drawStyled(c2, 'x', 0, 0, { style: 'banner110', look: 'banner', stroke: '#fff', strokeWidth: 9, fill: '#123456', shadow: false });
  assert.deepEqual(names(c2), ['save', 'translate', 'strokeText', 'fillText', 'restore']);
  assert.equal(c2.lineWidth, 9);
  assert.equal(c2.strokeStyle, '#fff');
  assert.equal(c2.fillStyle, '#123456');
  const c3 = mkctx();
  c3.globalAlpha = 0.8;
  drawStyled(c3, 'x', 0, 0, { style: 'popup44', look: 'popup', alpha: 0.5 });
  assert.equal(c3.globalAlpha, 0.8, 'restored');
});

test('drawText with a look is drawStyled (so every painter can ask for a look through the one call)', () => {
  const a = mkctx();
  const b = mkctx();
  drawText(a, 'SMOKED!', 300, 400, { style: 'banner132', look: 'banner', tint: 'orange', align: 'center' });
  drawStyled(b, 'SMOKED!', 300, 400, { style: 'banner132', look: 'banner', tint: 'orange', align: 'center' });
  assert.deepEqual(a.calls, b.calls);
});

test('letterSpacing is set for the text and put back, only where the context has the property; tracking 0 turns it off', () => {
  const ctx = mkctx();
  ctx.letterSpacing = '0px';
  const seen = [];
  const orig = Object.getOwnPropertyDescriptor(ctx, 'letterSpacing');
  let cur = '0px';
  Object.defineProperty(ctx, 'letterSpacing', { get: () => cur, set: (v) => { cur = v; seen.push(v); } });
  drawStyled(ctx, 'Hi', 0, 0, { style: 'button', look: 'plate' });
  assert.deepEqual(seen, ['3.84px', '0px']);
  seen.length = 0;
  drawStyled(ctx, 'Hi', 0, 0, { style: 'button', look: 'plate', tracking: 0 });
  assert.deepEqual(seen, []);
  void orig;
  const noSpacing = mkctx(); // no property at all: nothing is assigned
  drawStyled(noSpacing, 'Hi', 0, 0, { style: 'button', look: 'plate' });
  assert.equal('letterSpacing' in noSpacing, false);
});

test('no look ever assigns shadowBlur or filter', () => {
  for (const look of Object.keys(TEXT_LOOKS)) {
    const ctx = mkctx();
    drawStyled(ctx, 'Test 123', 10, 10, { style: 'banner110', look, align: 'center' });
    drawDigits(ctx, '12,450', 10, 10, { style: 'numeral', look });
    assert.equal(ctx.forbidden.length, 0, look);
  }
});

// ------------------------------------------------------------------------------------------------------------------------- fit

test('fitText: the base size when it fits, a proportional shrink when it does not, the floor (never below 28) when it still does not', () => {
  const ctx = mkctx(); // the fake measures 0.52 em per character
  const font = fontString('button'); // 64 px: "Reset high scores" (17 chars) is 566 px
  assert.equal(fitText(ctx, 'Reset high scores', font, 600), 64);
  assert.equal(fitText(ctx, 'Reset high scores', font, 400), Math.floor((64 * 400) / (17 * 0.52 * 64)));
  assert.equal(fitText(ctx, 'Reset high scores', font, 50), 36 > 28 ? 28 : 28, 'the floor is 28 for a style whose minSize is below it');
  assert.equal(fitText(ctx, 'Reset high scores', font, 50, 36), 36, 'the floor asked for');
  assert.equal(fitText(ctx, 'Reset high scores', font, 50, 10), 28, 'a floor below 28 is lifted to 28');
  assert.equal(fitText(ctx, '', font, 100), 64);
});

test('fitText is measured once per (font, width, text): repeats are cache hits and measure nothing; another width or font is another entry', () => {
  const ctx = mkctx();
  let n = 0;
  const m = ctx.measureText.bind(ctx);
  ctx.measureText = (t) => { n++; return m(t); };
  const font = fontString('headline');
  for (let i = 0; i < 500; i++) fitText(ctx, 'Game over', font, 300);
  assert.equal(n, 1);
  fitText(ctx, 'Game over', font, 301);
  fitText(ctx, 'Game over', fontString('button'), 300);
  fitText(ctx, 'Time up', font, 300);
  assert.equal(n, 4);
  invalidateTextCaches();
  fitText(ctx, 'Game over', font, 300);
  assert.equal(n, 5, 'a font change drops it');
});

test('fitText counts the tracking: spaced text is wider, so it shrinks sooner', () => {
  const ctx = mkctx();
  const font = fontString('button');
  const plain = fitText(ctx, 'No, keep playing', font, 420);
  invalidateTextCaches();
  const spaced = fitText(ctx, 'No, keep playing', font, 420, 28, 0.04);
  assert.ok(spaced < plain, `${spaced} < ${plain}`);
});

// ------------------------------------------------------------------------------------------------------------------------- digits

/** A context whose digit "1" is narrow and "8" is wide, like proportional numerals. */
function proportionalCtx() {
  const ctx = mkctx();
  const w = { 1: 20, 8: 44 };
  ctx.measureText = (t) => ({ width: [...String(t)].reduce((s, c) => s + (w[c] ?? 36), 0) });
  return ctx;
}

test('drawDigits: every digit sits in a cell as wide as the widest digit, so "1111" and "8888" are the same width and nothing jitters', () => {
  const ctx = proportionalCtx();
  const font = fontString('numeral');
  const cell = 44; // the widest of 0 to 9 (the "8")
  assert.equal(digitsWidth(ctx, '1111', font), 4 * cell);
  assert.equal(digitsWidth(ctx, '8888', font), 4 * cell);
  assert.equal(digitsWidth(ctx, '12,450', font), 5 * cell + 0.45 * cell, 'the comma is 0.45 of a cell');
  assert.equal(digitsWidth(ctx, '1:07', font), 3 * cell + 0.45 * cell, 'so is the colon');
  assert.equal(digitsWidth(ctx, '', font), 0);
});

test('drawDigits: left, centre and right alignment put the cells at the right x; each digit is drawn centred in its cell', () => {
  const xsOf = (align) => {
    const ctx = proportionalCtx();
    drawDigits(ctx, '1081', 1000, 300, { style: 'numeral', align });
    return ctx.calls.filter((c) => c[0] === 'translate').map((c) => c[1]);
  };
  const cell = 44;
  assert.deepEqual(xsOf('left'), [1000 + 22, 1000 + 66, 1000 + 110, 1000 + 154]);
  assert.deepEqual(xsOf('center'), xsOf('left').map((x) => x - 2 * cell));
  assert.deepEqual(xsOf('right'), xsOf('left').map((x) => x - 4 * cell));
  const ctx = proportionalCtx();
  drawDigits(ctx, '1081', 1000, 300, { style: 'numeral' });
  assert.ok(ctx.calls.filter((c) => c[0] === 'translate').every((c) => c[2] === 300), 'all on the one baseline');
  assert.equal(ctx.textAlign, 'center');
});

test('drawDigits: the same string at the same size draws the same calls (a digit change moves nothing else); a space draws nothing; other characters keep their own width', () => {
  const a = proportionalCtx();
  const b = proportionalCtx();
  drawDigits(a, '1250', 0, 0, { style: 'numeral' });
  drawDigits(b, '1250', 0, 0, { style: 'numeral' });
  assert.deepEqual(a.calls, b.calls);
  const c = proportionalCtx();
  drawDigits(c, '+ 5', 100, 100, { style: 'numeral' });
  assert.equal(c.calls.filter((x) => x[0] === 'fillText').length, 4, 'the space is not drawn (two glyphs, each with its hard drop)');
  assert.equal(digitsWidth(proportionalCtx(), '+', fontString('numeral')), 36, 'a plus keeps its own advance');
});

test('drawDigits: scale pops the number about its anchor with one save, translate, scale and restore; a scale of 1 does not', () => {
  const ctx = proportionalCtx();
  drawDigits(ctx, '12', 64, 130, { style: 'numeral', scale: 1.22 });
  assert.deepEqual(ctx.calls.slice(0, 3), [['save'], ['translate', 64, 130], ['scale', 1.22, 1.22]]);
  assert.equal(ctx.calls.at(-1)[0], 'restore');
  const plain = proportionalCtx();
  drawDigits(plain, '12', 64, 130, { style: 'numeral' });
  assert.equal(plain.calls.filter((c) => c[0] === 'scale').length, 0);
});

test('drawDigits takes a style size and the look overrides (gold gradient for Double), and an unknown style falls back to the numeral', () => {
  const ctx = proportionalCtx();
  let tint = null;
  ctx.createLinearGradient = () => ({ addColorStop: (o, c) => { if (o === 0) tint = c; } });
  drawDigits(ctx, '99', 0, 0, { style: 'numeral', look: 'banner', tint: 'gold' });
  assert.equal(tint, '#FFF0A8');
  const big = proportionalCtx();
  drawDigits(big, '1', 0, 0, { style: 'numeral', size: 60 });
  assert.match(big.texts[0].font, /^700 60px /);
  const other = proportionalCtx();
  drawDigits(other, '1', 0, 0, { style: 'nope' });
  assert.match(other.texts[0].font, /^700 96px /);
});

// ------------------------------------------------------------------------------------------------------------------------- baked sprites

function factory() {
  const made = [];
  const create = (w, h) => { const c = new FakeCanvas(w, h); made.push(c); return c; };
  return { create, made };
}

test('bakeTextSprite: one canvas per text, anchored at the middle of the baseline; the same key is a cache hit that creates nothing', () => {
  const { create, made } = factory();
  const s = bakeTextSprite(create, 'streak|3', 'STREAK x3', { style: 'banner132', look: 'banner', tint: 'gold' });
  assert.ok(s && s.canvas && s.w > 0 && s.h > 0);
  assert.equal(s.ax, s.w / 2);
  assert.ok(s.ay > 0 && s.ay < s.h);
  assert.equal(s.size, 190);
  const n = made.length;
  assert.equal(bakeTextSprite(create, 'streak|3', 'STREAK x3', { style: 'banner132', look: 'banner', tint: 'gold' }), s);
  assert.equal(made.length, n, 'no canvas for a hit');
  assert.equal(textSpriteCount(), 1);
  // the text was drawn into the sprite canvas with the look
  const calls = s.canvas.ctx.calls.map((c) => c[0]);
  assert.ok(calls.includes('fillText') && calls.includes('strokeText'));
  assert.equal(s.canvas.ctx.forbidden.length, 0);
});

test('bakeTextSprite: a falsy key is derived from the arguments, so different text, size, tint or density are different sprites', () => {
  const { create } = factory();
  const a = bakeTextSprite(create, null, 'GO!', { style: 'banner132', look: 'banner' });
  assert.equal(bakeTextSprite(create, null, 'GO!', { style: 'banner132', look: 'banner' }), a);
  for (const o of [{ style: 'banner110', look: 'banner' }, { style: 'banner132', look: 'banner', tint: 'ice' }, { style: 'banner132', look: 'banner', density: 2 }, { style: 'banner132', look: 'banner', size: 100 }]) {
    assert.notEqual(bakeTextSprite(create, null, 'GO!', o), a, JSON.stringify(o));
  }
  assert.notEqual(bakeTextSprite(create, null, 'GO', { style: 'banner132', look: 'banner' }), a);
});

test('bakeTextSprite: density scales the pixels, not the logical size; maxWidth shrinks the text down to 70 percent at most', () => {
  const { create } = factory();
  const one = bakeTextSprite(create, 'd1', 'PERFECT STAGE +500', { style: 'popup64', look: 'popup', tint: 'gold' });
  const two = bakeTextSprite(create, 'd2', 'PERFECT STAGE +500', { style: 'popup64', look: 'popup', tint: 'gold', density: 2 });
  assert.equal(two.w, one.w);
  assert.equal(two.canvas.width, one.canvas.width * 2);
  assert.deepEqual(two.canvas.ctx.calls.find((c) => c[0] === 'setTransform'), ['setTransform', 2, 0, 0, 2, 0, 0]);
  const fit = bakeTextSprite(create, 'f', 'PERFECT STAGE +500', { style: 'popup64', look: 'popup', maxWidth: 300 });
  assert.ok(fit.size < 80 && fit.size >= 56, `shrunk to ${fit.size}`);
  assert.ok(fit.size >= Math.round(80 * 0.7));
});

test('bakeTextSprite: 48 entries, least recently used out; invalidateTextCaches (a font arriving) empties it; a hit refreshes the recency', () => {
  const { create } = factory();
  for (let i = 0; i < 48; i++) bakeTextSprite(create, `k${i}`, `T${i}`, { style: 'popup44', look: 'popup' });
  assert.equal(textSpriteCount(), 48);
  bakeTextSprite(create, 'k0', 'T0', { style: 'popup44', look: 'popup' }); // k0 is now the freshest
  bakeTextSprite(create, 'k48', 'T48', { style: 'popup44', look: 'popup' });
  assert.equal(textSpriteCount(), 48);
  const { create: create2, made } = factory();
  bakeTextSprite(create2, 'k0', 'T0', { style: 'popup44', look: 'popup' });
  assert.equal(made.length, 0, 'k0 survived (hit, no canvas)');
  bakeTextSprite(create2, 'k1', 'T1', { style: 'popup44', look: 'popup' });
  assert.equal(made.length, 2, 'k1 was the least recently used and was baked again (a measuring canvas and the sprite)');
  invalidateTextCaches();
  assert.equal(textSpriteCount(), 0);
});

test('bakeTextSprite returns null (never throws) when the canvas factory gives nothing usable', () => {
  assert.equal(bakeTextSprite(() => null, 'x', 'T', { style: 'popup44' }), null);
  assert.equal(bakeTextSprite(() => ({}), 'y', 'T', { style: 'popup44' }), null);
});

test('bakeTextSprite also holds a byte budget (24 MB of pixels): big sprites push the oldest out, the newest always stays, and invalidate resets the count', () => {
  const { create } = factory();
  const first = bakeTextSprite(create, 'big0', 'PERFECT STAGE +500', { style: 'banner132', look: 'banner', density: 2 });
  assert.ok(first.bytes > 1024 * 1024, `a 190 px banner at density 2 is ${first.bytes} bytes`);
  for (let i = 1; i < 12; i++) bakeTextSprite(create, `big${i}`, 'PERFECT STAGE +500', { style: 'banner132', look: 'banner', density: 2 });
  assert.ok(textSpriteBytes() <= 24 * 1024 * 1024, `${textSpriteBytes()} bytes held`);
  assert.ok(textSpriteCount() < 12, 'some were pushed out by the byte budget');
  const { create: c2, made } = factory();
  bakeTextSprite(c2, 'big11', 'PERFECT STAGE +500', { style: 'banner132', look: 'banner', density: 2 });
  assert.equal(made.length, 0, 'the newest is still there');
  invalidateTextCaches();
  assert.equal(textSpriteBytes(), 0);
});

test('display roles are drawn in capitals whatever the face (the fallbacks have lower case: QA F15); UI roles keep their case', () => {
  const ctx = mkctx();
  drawText(ctx, 'Stage 1: Morning Meadow', 0, 0, { style: 'hudInfo', look: 'label' });
  drawText(ctx, 'Joy-Con battery low', 0, 0, { style: 'hudLabel' });
  drawDigits(ctx, 'x3', 0, 0, { style: 'numeral' });
  const texts = ctx.texts.map((t) => t.text);
  assert.ok(texts.includes('STAGE 1: MORNING MEADOW'));
  assert.ok(texts.includes('Joy-Con battery low'));
  assert.ok(texts.includes('X') && !texts.includes('x'));
});
