// Connect screen: how to connect on the left (holding the Joy-Con like a pistol), the connect button and the status pill on the right, and
// "play without a Joy-Con" (simulator, mouse) at the bottom. Two layouts share it: the legacy Web Bluetooth one and, when the native Bluetooth
// bridge is offered (view.connect.native), the native one with its progress line, scan countdown and cancel button. OWNER: UI engineer.
// UNVERIFIED-ON-HARDWARE: the pairing steps and the cooldown warning are assumptions.
import { C, font, rr, text, textWrapped, wrap } from '../theme.js';
import { drawJoyconPistol, drawPanel } from '../widgets.js';
import { CONNECT } from '../layout-data.js';
import { t } from '../strings.en.js';
import { button, caption } from './common.js';

/** The status pill: 1 to 5 lines, centred on x, its top edge at `top`. Returns its bottom edge. */
function drawStatusPill(ctx, str, cx, top, maxW, color) {
  let f = font('ui', 30, 700);
  let lh = 38;
  let lines = wrap(ctx, str, f, maxW);
  if (lines.length > 2) {
    f = font('ui', 28, 600);
    lh = 34;
    lines = wrap(ctx, str, f, maxW);
  }
  const h = lines.length * lh + 28;
  ctx.font = f;
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  rr(ctx, cx - w / 2 - 30, top, w + 60, h, 24);
  ctx.fillStyle = C.cream;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = color === C.terracotta ? C.terracotta : C.slate;
  ctx.stroke();
  lines.forEach((l, i) => text(ctx, l, cx, top + 14 + lh * (i + 0.74), { font: f, fill: color, align: 'center' }));
  return top + h;
}

function drawCountdownBar(ctx, y, frac, label) {
  const w = 600;
  const x = 1440 - w / 2;
  rr(ctx, x, y, w, 18, 9);
  ctx.fillStyle = 'rgba(255,244,220,0.22)';
  ctx.fill();
  const left = Math.max(0, 1 - frac);
  if (left > 0) {
    rr(ctx, x, y, Math.max(18, w * left), 18, 9);
    ctx.fillStyle = C.orange;
    ctx.fill();
  }
  text(ctx, label, 1440, y + 52, { family: 'ui', size: 28, weight: 700, fill: C.cream, align: 'center' });
}

function drawSteps(g, steps) {
  const { ctx } = g;
  const P = CONNECT.panel;
  drawPanel(ctx, P.x, P.y, P.w, P.h);
  text(ctx, t('connect.steps.title'), P.x - P.w / 2 + 50, P.y - P.h / 2 + 82, { family: 'display', size: 56, fill: C.slate });
  drawJoyconPistol(ctx, P.x + P.w / 2 - 150, P.y - P.h / 2 + 64, 170, -0.15);
  let y = P.y - P.h / 2 + 160;
  for (const s of steps) y += textWrapped(ctx, s, P.x - P.w / 2 + 50, y, P.w - 100, 40, { family: 'ui', size: 30, weight: 600, fill: C.slate }) * 40 + 26;
}

export function draw(g) {
  const { ctx, v } = g;
  const m = v.connect;
  const Cn = CONNECT;
  text(ctx, t('connect.title'), 960, Cn.titleY, { family: 'display', size: 84, fill: C.cream, align: 'center' });
  caption(g, t('connect.subtitle'), Cn.subtitleY, { size: 30 });
  const steps = m.native && m.stepTexts ? m.stepTexts : ['connect.step1', 'connect.step2', 'connect.step3', 'connect.step4'].map((k) => t(k));
  drawSteps(g, steps);

  button(g, m.showContinue ? 'connect.continue' : 'connect.main', m.showContinue ? t('connect.continue') : m.buttonText, { size: 52 });
  const errorish = m.mode === 'error' || m.mode === 'cooldown' || m.mode === 'unsupported';
  const merged = m.showFallback && m.hintText ? `${m.pillText} ${m.hintText}` : m.pillText;
  let bottom = Cn.pillTop;
  if (merged) bottom = drawStatusPill(ctx, merged, 1440, Cn.pillTop, Cn.pillWidth - 60, errorish ? C.terracotta : C.slate);
  if (m.mode === 'busy' && m.countdownS !== null) {
    drawCountdownBar(ctx, bottom + 26, m.countdownFrac, t('connect.native.countdown', { s: m.countdownS }));
    bottom += 26 + 70;
  }
  if (m.mode === 'busy' && m.hintText) {
    textWrapped(ctx, m.hintText, 1440, bottom + 44, 760, 34, { family: 'ui', size: 28, weight: 600, fill: C.cream, align: 'center', maxLines: 2 });
  } else if (!merged && m.mode === 'idle' && !m.showFallback) {
    textWrapped(ctx, m.warningText, 1440, Cn.pillTop + 40, 740, 34, { family: 'ui', size: 28, weight: 600, fill: C.cream, align: 'center', maxLines: 3, alpha: 0.9 });
  }
  if (m.cancel) button(g, 'connect.cancel', m.cancelText, { size: 40 });
  else if (m.secondary.show) button(g, 'connect.secondary', m.secondary.text, { size: 38 });
  else if (m.native && !v.hasBluetooth && m.primary === 'native' && m.mode !== 'busy' && m.mode !== 'connected') {
    textWrapped(ctx, t('connect.native.anyBrowser'), 1440, Cn.secondaryY, 760, 34, { family: 'ui', size: 28, weight: 600, fill: C.cream, align: 'center', maxLines: 2 });
  }
  if (m.showFallback) {
    button(g, 'connect.fallback', m.fallbackText, { size: 36 });
    if (!m.native && m.hintText) textWrapped(ctx, m.hintText, 1440, Cn.secondaryY + 50, 800, 34, { family: 'ui', size: 28, weight: 600, fill: C.cream, align: 'center', maxLines: 2 });
  }
  button(g, 'connect.calibrate', t('connect.calibrate'), { size: 38 });

  caption(g, t('connect.alt.title'), Cn.altTitleY, { x: 1440, size: 30, weight: 700 });
  button(g, 'connect.sim', t('connect.alt.sim'), { size: 44 });
  button(g, 'connect.mouse', t('connect.alt.mouse'), { size: 44 });
  textWrapped(ctx, t('connect.alt.sim.desc'), Cn.sim.x, Cn.sim.y + 84, 360, 32, { family: 'ui', size: 28, weight: 600, fill: C.cream, align: 'center', maxLines: 2 });
  textWrapped(ctx, t('connect.alt.mouse.desc'), Cn.mouse.x, Cn.mouse.y + 84, 360, 32, { family: 'ui', size: 28, weight: 600, fill: C.cream, align: 'center', maxLines: 2 });
  button(g, 'connect.diagnostics', t('connect.diagnostics'), { link: true });
  button(g, 'connect.back', t('connect.back'), { size: 40 });
}
