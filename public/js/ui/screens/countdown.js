// Countdown 3-2-1-GO before a round, with the stage name and the mode. OWNER: UI engineer.
import { C, TAU, easeOutBack, text } from '../theme.js';
import { drawPill, drawRing } from '../widgets.js';
import { t } from '../strings.en.js';

export function stageLine(cd) {
  if (cd.mode === 'classic') return t('countdown.classic', { stage: t(`stage.${cd.stage}`) });
  return t(`stage.${cd.stage}`);
}

export function draw(g) {
  const { ctx, v } = g;
  const cd = v.countdown;
  const modeLine = cd.mode === 'zen' ? t('mode.zen') : `${t(`mode.${cd.mode}`)}  ·  ${t(`difficulty.${cd.difficulty}`)}`;
  drawPill(ctx, 960, 250, modeLine, { family: 'display', size: 40, weight: 400, h: 64, fill: 'rgba(16,19,24,0.8)' });
  text(ctx, stageLine(cd), 960, 360, { family: 'display', size: 80, fill: C.cream, stroke: 'rgba(16,19,24,0.75)', strokeWidth: 10, align: 'center', maxW: 1600 });
  const reduced = v.settings.reduceMotion;
  const cx = 960;
  const cy = 600;
  const r = 150;
  ctx.beginPath();
  ctx.arc(cx, cy + 10, r, 0, TAU);
  ctx.fillStyle = 'rgba(8,10,14,0.4)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = cd.n > 0 ? C.cream : C.orange;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = C.slate;
  ctx.stroke();
  if (cd.n > 0) drawRing(ctx, cx, cy, r + 22, 1 - cd.frac, { width: 12, track: 'rgba(255,244,220,0.25)' });
  const pop = reduced ? 1 : easeOutBack(Math.min(1, cd.frac * 4));
  const label = cd.n > 0 ? String(cd.n) : t('countdown.go');
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pop, pop);
  text(ctx, label, 0, cd.n > 0 ? 82 : 52, { family: 'display', size: cd.n > 0 ? 230 : 150, fill: cd.n > 0 ? C.slate : C.cream, align: 'center' });
  ctx.restore();
}
