// Calibration (C-06): steps 1 to 3 are the motion wizard (hold still top up, point at the screen like a pistol, centre the aim and press A),
// step 4 is a practice round: one slow clay at a time, the first hit ends calibration. The world renderer draws the gun, the crosshair and
// the clay of step 4; this file draws the texts and pictures. OWNER: UI engineer.
// UNVERIFIED-ON-HARDWARE: the stillness rules that fill the ring live in Motion; how the pistol grip feels is a guess.
import { C, TAU, text, textWrapped } from '../theme.js';
import { drawArrow, drawCrosshairIcon, drawJoyconPistol, drawPanel, drawPill, drawRing, drawStepDots } from '../widgets.js';
import { t } from '../strings.en.js';
import { button, isClickLabel } from './common.js';

function illustration(ctx, step, cx, cy) {
  if (step === 1) {
    // top up, standing on a table
    ctx.fillStyle = 'rgba(27,31,36,0.15)';
    ctx.beginPath(); ctx.ellipse(cx, cy + 120, 150, 18, 0, 0, TAU); ctx.fill();
    drawJoyconPistol(ctx, cx, cy, 230, -Math.PI / 2);
    drawArrow(ctx, cx + 140, cy + 80, cx + 140, cy - 110);
  } else if (step === 2) {
    // side view: pointing at the screen like a pistol
    ctx.fillStyle = C.slate;
    ctx.fillRect(cx + 250, cy - 120, 26, 240);
    ctx.fillStyle = C.sky;
    ctx.fillRect(cx + 238, cy - 108, 12, 216);
    drawJoyconPistol(ctx, cx - 120, cy, 260, 0);
    drawArrow(ctx, cx + 40, cy - 70, cx + 210, cy - 70);
  } else {
    // the screen with its centre marked
    ctx.fillStyle = C.slate;
    ctx.fillRect(cx - 230, cy - 130, 460, 260);
    ctx.fillStyle = C.sky;
    ctx.fillRect(cx - 214, cy - 114, 428, 228);
    drawCrosshairIcon(ctx, cx, cy, 56);
  }
}

function drawSteps123(g) {
  const { ctx, v } = g;
  const c = v.cal;
  drawPanel(ctx, 960, 515, 1296, 730);
  text(ctx, c.quick ? t('cal.quick') : t('cal.title'), 960, 210, { family: 'display', size: 44, fill: C.orangeDeep, align: 'center' });
  if (!c.quick) {
    drawStepDots(ctx, 960, 246, c.step, 4, { dark: true });
  }
  text(ctx, t(`cal.s${c.step}.title`), 960, 340, { family: 'display', size: 96, fill: C.slate, align: 'center' });
  illustration(ctx, c.step, 960, 520);
  textWrapped(ctx, t(`cal.s${c.step}.text`, { button: v.labels.confirm }), 960, 730, 1160, 42, { family: 'ui', size: 34, weight: 600, fill: C.slate, align: 'center', maxLines: 2 });
  drawRing(ctx, 1500, 520, 70, c.phase === 'holding' ? c.progress : 0, { width: 14, track: 'rgba(27,31,36,0.15)' });
  if (c.message) textWrapped(ctx, c.message, 960, 836, 1200, 38, { family: 'ui', size: 30, weight: 700, fill: C.terracotta, align: 'center', maxLines: 2 });
  else if (c.phase === 'holding') text(ctx, t('cal.still'), 960, 836, { family: 'ui', size: 30, weight: 700, fill: C.slateMuted, align: 'center' });
}

function drawStep4(g) {
  const { ctx, v } = g;
  const c = v.cal;
  drawStepDots(ctx, 960, 60, 4, 4);
  // F18: with the mouse the trigger is a click, not a key ("PRESS CLICK" reads badly)
  const prompt = isClickLabel(v.labels.fire) ? t('cal.s4.textClick') : t('cal.s4.text', { fire: v.labels.fire });
  drawPill(ctx, 960, 130, c.frozen ? t('cal.s4.paused') : prompt, { family: 'display', size: 52, weight: 400, h: 84, fill: 'rgba(16,19,24,0.82)', stroke: C.orange });
  // the notes sit under the prompt, in the empty sky: never over the trap house the clay comes out of (F14)
  if (c.tryAgain) drawPill(ctx, 960, 210, c.notice ? t(c.notice) : t('cal.tryAgain'), { size: 30, h: 60, maxW: 1500 });
  else if (c.lost > 0) drawPill(ctx, 960, 210, t('cal.s4.lost'), { size: 28, h: 52 });
  if (c.tryAgain) button(g, 'cal.retry', t('cal.retry'));
}

export function draw(g) {
  const { ctx, v } = g;
  if (v.cal.step === 4) drawStep4(g);
  else drawSteps123(g);
  const flip = g.target('cal.flip');
  if (flip) {
    text(ctx, t('cal.flipX.hint'), flip.x, flip.y - 56, { family: 'ui', size: 28, weight: 700, fill: C.cream, align: 'center' });
    button(g, 'cal.flip', `${v.settings.flipX ? '✓ ' : ''}${t('cal.flipX.button')}`, { size: 36 });
  }
  const quick = g.target('cal.quick');
  if (quick) {
    text(ctx, t('cal.quick.hint'), quick.x, quick.y - 56, { family: 'ui', size: 28, weight: 700, fill: C.cream, align: 'center' });
    button(g, 'cal.quick', t('cal.quick'), { size: 36 });
  }
}
