// Best scores: per mode and difficulty (Time Attack also per stage). OWNER: UI engineer.
import { C, rr, text } from '../theme.js';
import { drawPanel } from '../widgets.js';
import { BEST_PANEL, DIFFICULTIES } from '../layout-data.js';
import { formatScore, t } from '../strings.en.js';
import { button, caption, title } from './common.js';

const RANK_FILL = Object.freeze({ S: C.gold, A: C.orange, B: C.sky, C: C.olive, D: C.slateMuted });

export function draw(g) {
  const { ctx, v } = g;
  title(g, t('best.title'), 120, 96);
  const P = BEST_PANEL;
  drawPanel(ctx, P.x, P.y, P.w, P.h);
  const x0 = P.x - P.w / 2;
  const y0 = P.y - P.h / 2;
  const labelW = 560;
  const colW = (P.w - labelW - 40) / DIFFICULTIES.length;
  DIFFICULTIES.forEach((d, i) => {
    text(ctx, t(`difficulty.${d}`), x0 + labelW + colW * (i + 0.5), y0 + 82, { family: 'display', size: 44, fill: C.slate, align: 'center' });
  });
  ctx.fillStyle = 'rgba(27,31,36,0.2)';
  ctx.fillRect(x0 + 30, y0 + 110, P.w - 60, 3);
  const rowH = 128;
  v.bestTable.forEach((row, r) => {
    const cy = y0 + 180 + r * rowH;
    if (r % 2 === 1) {
      rr(ctx, x0 + 20, cy - rowH / 2 + 6, P.w - 40, rowH - 12, 18);
      ctx.fillStyle = 'rgba(27,31,36,0.05)';
      ctx.fill();
    }
    const label = row.mode === 'classic' ? t('best.classic') : t('best.timeattack', { stage: t(`stage.${row.stage}`) });
    text(ctx, label, x0 + 50, cy + 16, { family: 'display', size: 44, fill: C.slate, maxW: labelW - 60 });
    row.cells.forEach((c, i) => {
      const cx = x0 + labelW + colW * (i + 0.5);
      if (c.score === null) {
        text(ctx, t('best.empty'), cx, cy + 16, { family: 'display', size: 48, fill: C.slateMuted, align: 'center' });
        return;
      }
      text(ctx, formatScore(c.score), cx - 20, cy + 18, { family: 'display', size: 56, fill: C.slate, align: 'center', maxW: colW - 90 });
      if (c.rank) {
        const bx = cx + colW / 2 - 50;
        ctx.beginPath();
        ctx.arc(bx, cy, 24, 0, Math.PI * 2);
        ctx.fillStyle = RANK_FILL[c.rank] ?? C.slate;
        ctx.fill();
        text(ctx, c.rank + (c.assist ? '*' : ''), bx, cy + 12, { family: 'display', size: 34, fill: c.rank === 'S' ? C.slate : C.cream, align: 'center' });
      }
    });
  });
  caption(g, t('best.note'), y0 + P.h - 40, { fill: C.slateMuted, size: 28 });
  if (v.bestTable.some((row) => row.cells.some((c) => c.assist))) caption(g, t('best.assist'), y0 + P.h + 50, { size: 28 });
  button(g, 'best.back', t('best.back'));
}
