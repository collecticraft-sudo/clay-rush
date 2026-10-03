// Overlay dialogs drawn over any screen: the Joy-Con disconnect overlay and the confirm dialog ("Quit this round?", "Delete all best
// scores?"). OWNER: UI engineer.
import { C, text, textWrapped, rr } from '../theme.js';
import { drawPanel, drawRing } from '../widgets.js';
import { CONFIRM_PANEL, DISCONNECT_PANEL } from '../layout-data.js';
import { t } from '../strings.en.js';
import { button } from './common.js';

export function drawDisconnect(g) {
  const { ctx, v } = g;
  const d = v.disc;
  const P = DISCONNECT_PANEL;
  drawPanel(ctx, P.x, P.y, P.w, P.h, { band: C.terracotta, bandH: 120 });
  text(ctx, t('disc.title'), P.x, P.y - P.h / 2 + 86, { family: 'display', size: 76, fill: C.cream, align: 'center', maxW: P.w - 60 });
  let lines = [t(d.pausedGame ? 'disc.text' : 'disc.textIdle')]; // U-05: no "game is paused" when no round runs
  if (d.phase === 'recovering') lines = [t('disc.recovered')];
  else if (d.phase === 'recentering') lines = [t('disc.recentering')];
  else if (d.native && d.phase === 'reconnecting') lines = [d.progressText];
  else if (d.phase === 'failed') lines = [d.native ? d.text : t('disc.failed'), d.retryEnabled ? '' : t('disc.cooldown')];
  let y = P.y - P.h / 2 + 180;
  for (const line of lines) {
    if (!line) continue;
    y += 38 * textWrapped(ctx, line, P.x, y, P.w - 100, 38, { family: 'ui', size: 30, weight: 600, fill: C.slate, align: 'center', maxLines: 4 }) + 8;
  }
  if (d.native && d.phase === 'reconnecting') {
    const w = 560;
    const x = P.x - w / 2;
    const by = 660;
    rr(ctx, x, by, w, 18, 9);
    ctx.fillStyle = 'rgba(27,31,36,0.15)';
    ctx.fill();
    if (d.countdownS !== null && d.countdownFrac < 1) {
      rr(ctx, x, by, Math.max(18, w * (1 - d.countdownFrac)), 18, 9);
      ctx.fillStyle = C.orange;
      ctx.fill();
    }
    if (d.countdownS !== null) text(ctx, t('connect.native.countdown', { s: d.countdownS }), P.x, by + 54, { family: 'ui', size: 28, weight: 700, fill: C.slate, align: 'center' });
    button(g, 'disc.cancel', t('connect.native.cancel'), { size: 40 });
  } else if (d.phase === 'failed') {
    const label = d.native ? (d.retryEnabled ? t('disc.native.retry') : t('disc.native.wait', { s: d.retryLeftS })) : (d.retryEnabled ? t('disc.retry') : t('disc.wait', { s: d.retryLeftS }));
    button(g, 'disc.retry', label, { size: 40 });
    button(g, 'disc.mouse', t('disc.useMouse'), { size: 40 });
    button(g, 'disc.menu', t('disc.menu'), { size: 40 });
  } else if (d.phase === 'recentering' || d.phase === 'recovering') {
    drawRing(ctx, P.x, 650, 70, v.cal.progress, { width: 12, track: 'rgba(27,31,36,0.15)' });
  } else {
    const a = v.settings.reduceMotion ? 0 : (g.nowMs / 1000) * 3;
    ctx.beginPath();
    ctx.arc(P.x, 650, 60, a, a + Math.PI * 0.6);
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.strokeStyle = C.orange;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
}

export function drawConfirm(g) {
  const { ctx, v } = g;
  const P = CONFIRM_PANEL;
  const quit = v.confirm.kind === 'quit';
  drawPanel(ctx, P.x, P.y, P.w, P.h, { band: quit ? C.slate : C.terracotta, bandH: 120 });
  text(ctx, quit ? t('pause.confirm.title') : t('settings.reset.confirm'), P.x, P.y - P.h / 2 + 86, { family: 'display', size: 68, fill: C.cream, align: 'center', maxW: P.w - 60 });
  text(ctx, quit ? t('pause.confirm.text') : t('settings.reset.text'), P.x, P.y - 20, { family: 'ui', size: 32, weight: 600, fill: C.slateSoft, align: 'center', maxW: P.w - 80 });
  button(g, 'confirm.yes', quit ? t('pause.confirm.yes') : t('settings.reset.yes'), { size: 44 });
  button(g, 'confirm.no', quit ? t('pause.confirm.no') : t('settings.reset.no'), { size: 44 });
}
