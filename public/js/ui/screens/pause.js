// Pause panel: Resume, Recentre aim, Settings, Quit to menu (Zen: End session), and the 3-2-1 of a resume. OWNER: UI engineer.
import { C, text } from '../theme.js';
import { drawPanel, drawRing } from '../widgets.js';
import { PAUSE_BUTTONS, PAUSE_PANEL } from '../layout-data.js';
import { t } from '../strings.en.js';
import { button } from './common.js';

/** "3", "2", "1" while the resume countdown runs (screen 'playing' with resuming = true). */
export function drawResumeCountdown(g) {
  const { ctx, v } = g;
  const n = v.pause.resumeN;
  ctx.beginPath();
  ctx.arc(960, 540, 130, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(16,19,24,0.7)';
  ctx.fill();
  drawRing(ctx, 960, 540, 130, (4 - n) / 3, { width: 10 });
  text(ctx, t('pause.resuming', { n }), 960, 612, { family: 'display', size: 200, fill: C.cream, align: 'center' });
}

export function draw(g) {
  const { ctx, v } = g;
  const P = PAUSE_PANEL;
  drawPanel(ctx, P.x, P.y, P.w, P.h, { band: C.slate, bandH: 120 });
  text(ctx, t('pause.title'), P.x, P.y - P.h / 2 + 88, { family: 'display', size: 84, fill: C.cream, align: 'center' });
  for (const b of PAUSE_BUTTONS) {
    const label = b.id === 'pause.quit' && v.roundMode === 'zen' ? t('pause.endSession') : t(b.labelKey);
    button(g, b.id, label, { size: 46 });
  }
  const tip = v.pausedBlur ? t('pause.autoBlur') : t('pause.tip');
  text(ctx, tip, P.x, P.y + P.h / 2 - 50, { family: 'ui', size: 28, weight: 600, fill: C.slateMuted, align: 'center', maxW: P.w - 60 });
}
