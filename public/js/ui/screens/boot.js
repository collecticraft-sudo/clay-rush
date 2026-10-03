// Boot screen: the logo and a loading line while app.js waits for the fonts and the core art. OWNER: UI engineer.
import { C, rr } from '../theme.js';
import { drawLogo } from '../widgets.js';
import { t } from '../strings.en.js';
import { caption } from './common.js';

export function draw(g) {
  const { ctx, v } = g;
  drawLogo(ctx, g.assets, 960, 430, 760, 390, g.density);
  caption(g, t('boot.loading'), 720, { size: 32, weight: 700 });
  // an indeterminate bar (still with Reduce motion)
  const w = 480;
  const x = 960 - w / 2;
  rr(ctx, x, 760, w, 12, 6);
  ctx.fillStyle = 'rgba(255,244,220,0.2)';
  ctx.fill();
  const seg = 140;
  const p = v.settings.reduceMotion ? 0.35 : ((g.nowMs % 1400) / 1400);
  const sx = x + (w - seg) * p;
  rr(ctx, sx, 760, seg, 12, 6);
  ctx.fillStyle = C.orange;
  ctx.fill();
}
