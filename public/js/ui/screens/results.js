// Results: score count-up, the stamped rank (S/A/B/C/D), NEW BEST in gold, the stats (broken / presented, accuracy, best streak, doubles),
// Play again and Menu. Zen shows the session stats and no rank. OWNER: UI engineer.
import { C, MODE_ACCENT, TAU, clamp01, rr, text } from '../theme.js';
import { drawPanel, drawPill } from '../widgets.js';
import { RESULTS_PANEL } from '../layout-data.js';
import { formatScore, t } from '../strings.en.js';
import { UI_TIMING } from '../ui.js';
import { button } from './common.js';

const RANK_FILL = Object.freeze({ S: C.gold, A: C.orange, B: C.sky, C: C.olive, D: C.slateMuted });

export function resultTitleKey(r) {
  if (!r) return 'results.title.complete';
  if (r.mode === 'zen') return 'results.title.zen';
  if (r.endReason === 'timer') return 'results.title.timer';
  if (r.endReason === 'quit') return 'results.title.quit';
  return 'results.title.complete';
}

export function accuracyText(r) {
  if (!r || r.accuracy === null || r.accuracy === undefined || !Number.isFinite(r.accuracy)) return t('results.accuracyNone');
  return `${Math.round(r.accuracy * 100)}%`;
}

/** The four stat tiles: [labelKey, value]. */
export function statTiles(r) {
  if (!r) return [];
  if (r.mode === 'zen') {
    return [['results.hits', String(r.hits ?? 0)], ['results.shots', String(r.shots ?? 0)], ['results.accuracy', accuracyText(r)], ['results.streak', String(r.bestStreak ?? 0)]];
  }
  return [
    ['results.broken', t('results.brokenValue', { broken: r.broken ?? 0, presented: r.presented ?? 0 })],
    ['results.accuracy', accuracyText(r)],
    ['results.streak', String(r.bestStreak ?? 0)],
    ['results.doubles', String(r.doubles ?? 0)],
  ];
}

function drawRankSeal(g, rank, cx, cy) {
  const { ctx, v } = g;
  const res = v.results;
  if (!res.stamped) return;
  const el = g.nowMs - res.stampAt;
  const p = v.settings.reduceMotion ? 1 : clamp01(el / 220);
  const scale = 2.2 - 1.2 * p;
  const alpha = v.settings.reduceMotion ? 1 : clamp01(el / 90);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(cx, cy);
  ctx.rotate(-0.12);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.arc(0, 8, 118, 0, TAU);
  ctx.fillStyle = 'rgba(8,10,14,0.35)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, 118, 0, TAU);
  ctx.fillStyle = RANK_FILL[rank] ?? C.slate;
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = C.slate;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 96, 0, TAU);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,244,220,0.8)';
  ctx.setLineDash([10, 8]);
  ctx.stroke();
  ctx.setLineDash([]);
  text(ctx, rank, 0, 64, { family: 'display', size: 180, fill: rank === 'S' ? C.slate : C.cream, align: 'center' }); // F21: slate on gold
  ctx.restore();
  // the caption fades in once the stamp has landed (while it shrinks in from 2.2x it covers the caption's place)
  const capAlpha = v.settings.reduceMotion ? 1 : clamp01((el - 220) / 160);
  if (capAlpha > 0) text(ctx, t('results.rank'), cx, cy + 160, { family: 'display', size: 36, fill: C.slateMuted, align: 'center', alpha: capAlpha });
}

export function draw(g) {
  const { ctx, v } = g;
  const res = v.results;
  const r = res.result;
  if (!r) return;
  const P = RESULTS_PANEL;
  // the panel slides up as it arrives
  const el = g.nowMs - res.startedAt;
  const slide = v.settings.reduceMotion ? 0 : (1 - clamp01(el / UI_TIMING.resultsSlideMs)) ** 3 * 120;
  ctx.save();
  ctx.translate(0, slide);
  const accent = MODE_ACCENT[r.mode] ?? C.orange;
  drawPanel(ctx, P.x, P.y, P.w, P.h, { band: accent, bandH: 128 });
  const x0 = P.x - P.w / 2;
  const y0 = P.y - P.h / 2;
  text(ctx, t(resultTitleKey(r)), x0 + 60, y0 + 92, { family: 'display', size: 84, fill: C.cream, maxW: 800 });
  const sub = r.mode === 'zen' ? t('mode.zen') : r.mode === 'classic'
    ? `${t('mode.classic')}  ·  ${t(`difficulty.${r.difficulty}`)}`
    : `${t('mode.timeattack')}  ·  ${t(`difficulty.${r.difficulty}`)}  ·  ${t(`stage.${r.stageId ?? 'hills'}`)}`;
  text(ctx, sub, x0 + P.w - 60, y0 + 84, { family: 'display', size: 40, fill: C.cream, align: 'right', maxW: 520 });

  const scoreX = x0 + 420;
  if (r.mode !== 'zen') {
    text(ctx, t('results.score'), scoreX, y0 + 210, { family: 'display', size: 44, fill: C.slateMuted, align: 'center' });
    text(ctx, formatScore(res.shownScore), scoreX, y0 + 370, { family: 'display', size: 190, fill: C.slate, align: 'center', maxW: 700 });
    if (res.isNewBest && res.stamped) {
      const pulse = v.settings.reduceMotion ? 1 : 1 + 0.04 * Math.sin(g.nowMs / 140);
      ctx.save();
      ctx.translate(scoreX, y0 + 440);
      ctx.scale(pulse, pulse);
      drawPill(ctx, 0, 0, t('results.newBest'), { family: 'display', size: 48, weight: 400, h: 70, fill: C.gold, color: C.slate, stroke: C.slate });
      ctx.restore();
    } else if (res.shownBest !== null && res.shownBest !== undefined) {
      // during the count-up a new best shows the PREVIOUS one; the new value arrives with the NEW BEST! stamp
      text(ctx, t('results.best', { n: formatScore(res.shownBest) }), scoreX, y0 + 452, { family: 'display', size: 40, fill: C.slateMuted, align: 'center' });
    }
    if (r.rank) drawRankSeal(g, r.rank, x0 + P.w - 330, y0 + 300);
  } else {
    // F17: the header already says SESSION OVER; the body names the stage that was practised
    text(ctx, t(`stage.${r.stageId ?? 'hills'}`), P.x, y0 + 330, { family: 'display', size: 120, fill: C.slate, align: 'center', maxW: P.w - 120 });
    text(ctx, t('menu.best.zen'), P.x, y0 + 410, { family: 'display', size: 44, fill: C.slateMuted, align: 'center' });
  }

  // stat tiles
  const tiles = statTiles(r);
  const tw = 270;
  const gap = 24;
  const tx0 = P.x - (tiles.length * tw + (tiles.length - 1) * gap) / 2;
  const ty = y0 + 500;
  tiles.forEach(([key, value], i) => {
    const x = tx0 + i * (tw + gap);
    rr(ctx, x, ty, tw, 150, 22);
    ctx.fillStyle = C.creamDeep;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(27,31,36,0.3)';
    ctx.stroke();
    text(ctx, value, x + tw / 2, ty + 88, { family: 'display', size: 72, fill: C.slate, align: 'center', maxW: tw - 20 });
    text(ctx, t(key), x + tw / 2, ty + 132, { family: 'display', size: 32, fill: C.slateMuted, align: 'center', maxW: tw - 20 });
  });
  if (r.assist) text(ctx, t('results.assist'), P.x, ty + 186, { family: 'ui', size: 28, weight: 600, fill: C.slateMuted, align: 'center' });
  ctx.restore();

  const prevAlpha = ctx.globalAlpha;
  if (res.locked) ctx.globalAlpha = prevAlpha * 0.6;
  button(g, 'results.again', t('results.again'), { size: 52 });
  button(g, 'results.menu', t('results.menu'), { size: 52 });
  ctx.globalAlpha = prevAlpha;
}
