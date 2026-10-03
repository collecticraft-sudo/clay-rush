// Aim and trigger tuning: the live crosshair (drawn by the world renderer) over the hills backdrop, a target ring in the middle, the pointer
// speed in deg/s, the numbers of the last trigger press (fact shotFeedback: trigger jerk, how far the shot moved, the compensation used) and the
// three values that matter (Trigger steadiness, Sensitivity, Aim curve). UNVERIFIED-ON-HARDWARE: the "good" threshold of the verdict.
import { C, TAU, clamp01, rr, text, textWrapped } from '../theme.js';
import { drawCrosshairIcon, drawPanel } from '../widgets.js';
import { CROSSHAIR_SWATCH, TUNING, TUNING_ROWS, tuningRowGeometry } from '../layout-data.js';
import { t } from '../strings.en.js';
import { UI_TIMING } from '../ui.js';
import { button, title, valueRow } from './common.js';

/** A shot that moved less than this (px) between the compensated aim and the aim 80 ms later reads as steady. UNVERIFIED-ON-HARDWARE. */
export const STEADY_PX = 12;

function readout(ctx, label, value, x, y, w) {
  text(ctx, label, x, y, { family: 'ui', size: 30, weight: 700, fill: C.slateSoft, maxW: w * 0.55 });
  text(ctx, value, x + w, y, { family: 'display', size: 48, fill: C.slate, align: 'right', maxW: w * 0.45 });
}

export function draw(g) {
  const { ctx, v } = g;
  const T = TUNING;
  title(g, t('tune.title'), T.titleY, 72);
  text(ctx, t('tune.intro', { fire: v.labels.fire }), 960, T.introY, { family: 'ui', size: 30, weight: 600, fill: C.cream, align: 'center', maxW: 1700 });

  // the target ring in the middle
  const R = T.ring;
  for (const [r, w, col] of [[R.r + 40, 6, 'rgba(255,244,220,0.5)'], [R.r, 8, C.orange], [R.r * 0.35, 6, C.cream]]) {
    ctx.beginPath();
    ctx.arc(R.x, R.y, r, 0, TAU);
    ctx.lineWidth = w + 6;
    ctx.strokeStyle = 'rgba(16,19,24,0.6)';
    ctx.stroke();
    ctx.lineWidth = w;
    ctx.strokeStyle = col;
    ctx.stroke();
  }
  // test-shot marks (fade out)
  for (const m of v.tune.marks) {
    const a = 1 - clamp01((g.nowMs - m.at) / UI_TIMING.tuneMarkMs);
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    ctx.lineWidth = 6;
    ctx.strokeStyle = C.orange;
    ctx.beginPath();
    ctx.moveTo(m.x - 14, m.y - 14); ctx.lineTo(m.x + 14, m.y + 14);
    ctx.moveTo(m.x + 14, m.y - 14); ctx.lineTo(m.x - 14, m.y + 14);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // left panel: the values
  const L = T.left;
  drawPanel(ctx, (L.x0 + L.x1) / 2, (L.top + L.bottom) / 2, L.x1 - L.x0, L.bottom - L.top);
  TUNING_ROWS.forEach((row, i) => {
    const geo = tuningRowGeometry(i);
    text(ctx, t(`settings.${row.key}`), geo.labelX, geo.labelY + 12, { family: 'ui', size: 32, weight: 700, fill: C.slate, maxW: T.controlW });
    valueRow(g, 'set', row, { cellSize: 34 });
  });

  // right panel: the readings
  const Rp = T.right;
  drawPanel(ctx, (Rp.x0 + Rp.x1) / 2, (Rp.top + Rp.bottom) / 2, Rp.x1 - Rp.x0, Rp.bottom - Rp.top);
  const x = Rp.x0 + 40;
  const w = Rp.x1 - Rp.x0 - 80;
  readout(ctx, t('tune.speed'), `${v.tune.approx ? '≈ ' : ''}${t('tune.speedValue', { n: Math.round(v.tune.speedDps) })}`, x, Rp.top + 80, w);
  // a small bar 0..360 deg/s
  rr(ctx, x, Rp.top + 104, w, 12, 6);
  ctx.fillStyle = 'rgba(27,31,36,0.12)';
  ctx.fill();
  rr(ctx, x, Rp.top + 104, Math.max(12, w * clamp01(v.tune.speedDps / 360)), 12, 6);
  ctx.fillStyle = C.orange;
  ctx.fill();
  ctx.fillStyle = 'rgba(27,31,36,0.15)';
  ctx.fillRect(x, Rp.top + 160, w, 3);
  text(ctx, t('tune.lastShot'), x, Rp.top + 222, { family: 'display', size: 44, fill: C.orangeDeep });
  const s = v.tune.lastShot;
  if (v.provider?.kind !== 'joycon') {
    // F16: the mouse and the simulator have no trigger jerk and no compensation: a neutral note, never a verdict on zeros
    textWrapped(ctx, t('tune.mouseNote'), x, Rp.top + 290, w, 38, { family: 'ui', size: 30, weight: 600, fill: C.slateSoft, maxLines: 4 });
  } else if (!s) {
    textWrapped(ctx, t('tune.none', { fire: v.labels.fire }), x, Rp.top + 290, w, 38, { family: 'ui', size: 30, weight: 600, fill: C.slateSoft });
  } else if (!s.valid) {
    textWrapped(ctx, t('tune.invalid'), x, Rp.top + 290, w, 38, { family: 'ui', size: 30, weight: 600, fill: C.terracotta });
  } else {
    readout(ctx, t('tune.jerk'), t('tune.jerkValue', { n: Math.round(s.jerkPeakDps ?? 0) }), x, Rp.top + 300, w);
    readout(ctx, t('tune.drift'), t('tune.driftValue', { n: Math.round(s.displacementPx ?? 0) }), x, Rp.top + 380, w);
    readout(ctx, t('tune.comp'), t('tune.compValue', { n: Math.round(s.compMs ?? v.settings.triggerCompMs) }), x, Rp.top + 460, w);
    const good = (s.displacementPx ?? Infinity) <= STEADY_PX;
    textWrapped(ctx, t(good ? 'tune.verdict.good' : 'tune.verdict.bad'), x, Rp.top + 530, w, 36, { family: 'ui', size: 28, weight: 700, fill: good ? C.olive : C.terracotta, maxLines: 3 });
  }
  button(g, 'tune.back', t('tune.back'));
  // the live crosshair (the world renderer draws none in its idle mode): the colour of the setting
  if (v.aim.visible) drawCrosshairIcon(ctx, v.aim.x, v.aim.y, 34, CROSSHAIR_SWATCH[v.settings.crosshairColor] ?? C.white);
}
