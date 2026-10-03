// Safety page ("Before you play"): clear space, wrist strap, never point at people or pets, breaks, flashes. The "Got it" button unlocks after
// 2 s (the button fills while the player reads). OWNER: UI engineer.
import { C, TAU, rr, text, textWrapped } from '../theme.js';
import { drawPanel } from '../widgets.js';
import { SAFETY } from '../layout-data.js';
import { t } from '../strings.en.js';
import { button } from './common.js';

const LINES = Object.freeze(['safety.l1', 'safety.l2', 'safety.l3', 'safety.l4', 'safety.l5']);

export function draw(g) {
  const { ctx, v } = g;
  const P = SAFETY.panel;
  drawPanel(ctx, P.x, P.y, P.w, P.h, { band: C.orange, bandH: 116 });
  text(ctx, t('safety.title'), P.x, P.y - P.h / 2 + 84, { family: 'display', size: 76, fill: C.cream, align: 'center' });
  let y = P.y - P.h / 2 + 190;
  const x0 = P.x - P.w / 2 + 70;
  LINES.forEach((key, i) => {
    // numbered disc
    ctx.beginPath();
    ctx.arc(x0 + 26, y - 12, 26, 0, TAU);
    ctx.fillStyle = i === 2 ? C.terracotta : C.slate;
    ctx.fill();
    text(ctx, String(i + 1), x0 + 26, y + 1, { family: 'display', size: 36, fill: C.cream, align: 'center' });
    const n = textWrapped(ctx, t(key), x0 + 76, y, P.w - 190, 40, { family: 'ui', size: i === 2 ? 34 : 32, weight: i === 2 ? 700 : 600, fill: C.slate });
    y += n * 40 + 34;
  });
  // the reduce-flash switch
  const tog = g.target('safety.toggle');
  if (tog) {
    const on = v.settings.reduceFlash;
    button(g, 'safety.toggle', t('safety.reduceFlash'), {
      size: 38,
      icon: (c, cx, cy) => {
        rr(c, cx - 20, cy - 20, 40, 40, 8);
        c.fillStyle = on ? C.orange : C.cream;
        c.fill();
        c.lineWidth = 4;
        c.strokeStyle = C.slate;
        c.stroke();
        if (on) {
          c.beginPath();
          c.moveTo(cx - 11, cy);
          c.lineTo(cx - 3, cy + 9);
          c.lineTo(cx + 12, cy - 9);
          c.lineWidth = 5;
          c.strokeStyle = C.cream;
          c.lineCap = 'round';
          c.stroke();
          c.lineCap = 'butt';
        }
      },
    });
  }
  const ok = g.target('safety.ok');
  if (ok) {
    const ready = v.safety.ready;
    if (!ready) {
      // the button fills from the left while the page is read
      const x = ok.x - ok.w / 2;
      const y0 = ok.y - ok.h / 2;
      rr(ctx, x, y0, ok.w, ok.h, 24);
      ctx.fillStyle = 'rgba(255,244,220,0.18)';
      ctx.fill();
      ctx.save();
      rr(ctx, x, y0, ok.w, ok.h, 24);
      ctx.clip();
      ctx.fillStyle = 'rgba(242,107,29,0.55)';
      ctx.fillRect(x, y0, ok.w * v.safety.progress, ok.h);
      ctx.restore();
      rr(ctx, x, y0, ok.w, ok.h, 24);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,244,220,0.6)';
      ctx.stroke();
      text(ctx, t('safety.wait'), ok.x, ok.y + 17, { family: 'display', size: 48, fill: C.cream, align: 'center' });
    } else {
      button(g, 'safety.ok', t('safety.ok'), { size: 52 });
    }
  }
}
