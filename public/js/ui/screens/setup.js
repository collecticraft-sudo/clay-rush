// Setup screen before a round: difficulty (Classic, Time Attack) and stage (Time Attack, Zen). The choice is remembered in the settings, and the
// living backdrop shows the chosen stage. OWNER: UI engineer.
import { C, MODE_ACCENT, rr, text, textWrapped } from '../theme.js';
import { drawChoiceCell, drawFocusRing, drawStageThumb } from '../widgets.js';
import { DIFFICULTIES, SETUP, STAGES } from '../layout-data.js';
import { t } from '../strings.en.js';
import { button, caption, sectionLabel } from './common.js';

function ringOf(tgs) {
  let r = null;
  for (const tg of tgs) {
    if (!tg) continue;
    const b = { x0: tg.x - tg.w / 2, y0: tg.y - tg.h / 2, x1: tg.x + tg.w / 2, y1: tg.y + tg.h / 2 };
    r = r ? { x0: Math.min(r.x0, b.x0), y0: Math.min(r.y0, b.y0), x1: Math.max(r.x1, b.x1), y1: Math.max(r.y1, b.y1) } : b;
  }
  return r;
}

function drawStageCard(g, tg, stageId, selected) {
  const { ctx } = g;
  const x = tg.x - tg.w / 2;
  const y = tg.y - tg.h / 2;
  rr(ctx, x, y + 8, tg.w, tg.h, 22);
  ctx.fillStyle = C.shadow;
  ctx.fill();
  drawStageThumb(ctx, stageId, x, y, tg.w, tg.h);
  // name band along the bottom
  ctx.save();
  rr(ctx, x, y, tg.w, tg.h, 22);
  ctx.clip();
  ctx.fillStyle = selected ? C.orange : 'rgba(16,19,24,0.78)';
  ctx.fillRect(x, y + tg.h - 64, tg.w, 64);
  ctx.restore();
  text(ctx, t(`stage.${stageId}`), tg.x, y + tg.h - 18, { family: 'display', size: 44, fill: C.cream, align: 'center', maxW: tg.w - 30 });
  rr(ctx, x, y, tg.w, tg.h, 22);
  ctx.lineWidth = selected ? 6 : 4;
  ctx.strokeStyle = selected ? C.orange : C.slate;
  ctx.stroke();
  if (selected) {
    // a check badge in the corner
    ctx.beginPath();
    ctx.arc(x + tg.w - 30, y + 30, 22, 0, Math.PI * 2);
    ctx.fillStyle = C.orange;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.cream;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + tg.w - 41, y + 31);
    ctx.lineTo(x + tg.w - 33, y + 39);
    ctx.lineTo(x + tg.w - 19, y + 22);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
}

export function draw(g) {
  const { ctx, v } = g;
  const s = v.setup;
  const S = SETUP;
  const accent = MODE_ACCENT[s.mode] ?? C.orange;
  // title with an accent bar
  rr(ctx, 960 - 60, S.titleY - 104, 120, 10, 5);
  ctx.fillStyle = accent;
  ctx.fill();
  text(ctx, t(`mode.${s.mode}`), 960, S.titleY, { family: 'display', size: 96, fill: C.cream, align: 'center' });
  caption(g, t(`menu.${s.mode}.desc`), S.descY, { size: 30 });

  if (s.mode !== 'zen') {
    sectionLabel(g, t('setup.difficulty'), 960, S.difficultyLabelY, { align: 'center', size: 40 });
    const cells = DIFFICULTIES.map((d) => g.target(`setup.difficulty.opt.${d}`));
    DIFFICULTIES.forEach((d, i) => {
      if (cells[i]) drawChoiceCell(ctx, cells[i], t(`difficulty.${d}`), { selected: s.difficulty === d, size: 44 });
    });
    if (v.focus.valueRow?.key === 'difficulty') drawFocusRing(ctx, ringOf(cells), { radius: 26 });
    textWrapped(ctx, t(`difficulty.${s.difficulty}.desc`), 960, S.difficultyDescY, 1200, 36, { family: 'ui', size: 30, weight: 600, fill: C.cream, align: 'center', maxLines: 2 });
  }
  if (s.mode !== 'classic') {
    sectionLabel(g, t('setup.stage'), 960, S.stageLabelY, { align: 'center', size: 40 });
    const cards = STAGES.map((st) => g.target(`setup.stage.opt.${st}`));
    STAGES.forEach((st, i) => {
      if (cards[i]) drawStageCard(g, cards[i], st, s.stage === st);
    });
    if (v.focus.valueRow?.key === 'stage') drawFocusRing(ctx, ringOf(cards), { radius: 30 });
    caption(g, t(`stage.${s.stage}.desc`), S.stageY + S.stageCard.h / 2 + 52, { size: 30 });
  } else {
    // Classic: the three stages in order (not selectable)
    sectionLabel(g, t('setup.stage'), 960, S.stageLabelY, { align: 'center', size: 40 });
    const w = 360;
    const h = 170;
    const cy = S.stageY - 40;
    STAGES.forEach((st, i) => {
      const cx = 960 + (i - 1) * (w + 60);
      drawStageThumb(ctx, st, cx - w / 2, cy - h / 2, w, h);
      rr(ctx, cx - w / 2, cy - h / 2, w, h, 18);
      ctx.lineWidth = 4;
      ctx.strokeStyle = C.slate;
      ctx.stroke();
      text(ctx, `${i + 1}  ${t(`stage.${st}`)}`, cx, cy + h / 2 + 46, { family: 'display', size: 40, fill: C.cream, align: 'center', maxW: w });
    });
    caption(g, t('setup.classic.note'), cy + h / 2 + 92, { size: 28, alpha: 0.85 });
  }
  button(g, 'setup.back', t('setup.back'));
  button(g, 'setup.start', t('setup.start'), { size: 56 });
}
