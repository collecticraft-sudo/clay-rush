// Title / main menu: the logo over the living backdrop, three mode cards (Classic, Time Attack, Zen) and three buttons (Best scores,
// Settings, Controller), plus the controller chip. OWNER: UI engineer.
import { C, MODE_ACCENT, font, rr, text, textWrapped } from '../theme.js';
import { drawClayIcon, drawClockIcon, drawCrosshairIcon, drawFocusRing, drawLogo, drawPill } from '../widgets.js';
import { MENU_BUTTONS, MENU_CARDS, MENU_LOGO, MENU_TAGLINE_Y, PROVIDER_CHIP } from '../layout-data.js';
import { batteryText, sideText } from '../connect-model.js';
import { formatScore, t } from '../strings.en.js';
import { button, caption } from './common.js';

export function providerChipText(v) {
  const p = v.provider;
  if (!p || !p.kind) return '';
  if (p.kind === 'joycon') {
    const base = t('menu.provider.joycon', { side: sideText(p.status?.side) });
    const level = p.status?.battery?.level;
    return level && level !== 'unknown' ? `${base}  ·  ${batteryText(p.status.battery)}` : base;
  }
  return t(`menu.provider.${p.kind}`);
}

function modeIcon(ctx, mode, cx, cy) {
  if (mode === 'classic') drawClayIcon(ctx, cx, cy, 34);
  else if (mode === 'timeattack') drawClockIcon(ctx, cx, cy + 4, 28);
  else drawCrosshairIcon(ctx, cx, cy, 34, C.cream);
}

/** One mode card: coloured band with the name and an icon, the description, the best score chip. */
export function drawModeCard(g, card) {
  const { ctx, v } = g;
  const tg = g.target(card.id);
  if (!tg) return;
  const focused = g.focused(card.id);
  const lift = focused && !v.settings.reduceMotion ? -8 : focused ? -4 : 0;
  const x = tg.x - tg.w / 2;
  const y = tg.y - tg.h / 2 + lift;
  const accent = MODE_ACCENT[card.mode];
  rr(ctx, x, tg.y - tg.h / 2 + 10, tg.w, tg.h, 30);
  ctx.fillStyle = C.shadow;
  ctx.fill();
  rr(ctx, x, y, tg.w, tg.h, 30);
  ctx.fillStyle = focused ? C.white : C.cream;
  ctx.fill();
  ctx.save();
  rr(ctx, x, y, tg.w, tg.h, 30);
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, tg.w, 112);
  ctx.restore();
  rr(ctx, x, y, tg.w, tg.h, 30);
  ctx.lineWidth = 4;
  ctx.strokeStyle = C.slate;
  ctx.stroke();
  text(ctx, t(`menu.${card.mode}`), x + 34, y + 84, { family: 'display', size: 72, fill: C.cream, maxW: tg.w - 150 });
  modeIcon(ctx, card.mode, x + tg.w - 66, y + 56);
  textWrapped(ctx, t(`menu.${card.mode}.desc`), x + 34, y + 160, tg.w - 68, 36, { family: 'ui', size: 30, weight: 600, fill: C.slateSoft, maxLines: 2 });
  const best = v.menuBest[card.mode];
  // F25: the chip names what the best belongs to (the remembered difficulty, and for Time Attack the stage)
  const detail = card.mode === 'timeattack'
    ? `${t(`difficulty.${v.settings.difficulty}`)}, ${t(`stage.${v.settings.stage}`)}`
    : t(`difficulty.${v.settings.difficulty}`);
  const label = card.mode === 'zen' ? t('menu.best.zen') : best ? t('menu.bestFor', { detail, n: formatScore(best) }) : t('menu.best.none');
  const chipFill = card.mode !== 'zen' && best ? C.gold : 'rgba(27,31,36,0.1)';
  const f = font('display', 34);
  const w = Math.min(tg.w - 68, ctx.measureText ? measureText(ctx, label, f) + 40 : 260);
  rr(ctx, x + 34, y + tg.h - 76, w, 50, 25);
  ctx.fillStyle = chipFill;
  ctx.fill();
  text(ctx, label, x + 34 + w / 2, y + tg.h - 39, { font: f, fill: C.slate, align: 'center', maxW: w - 20 });
  if (focused) drawFocusRing(ctx, { x0: x, y0: y, x1: x + tg.w, y1: y + tg.h }, { radius: 38 });
}

function measureText(ctx, s, f) {
  ctx.font = f;
  return ctx.measureText(s).width;
}

export function draw(g) {
  const { ctx, v } = g;
  drawLogo(ctx, g.assets, MENU_LOGO.cx, MENU_LOGO.top + MENU_LOGO.h / 2, MENU_LOGO.w, MENU_LOGO.h, g.density);
  caption(g, t('menu.tagline'), MENU_TAGLINE_Y, { size: 32, weight: 700 });
  for (const card of MENU_CARDS) drawModeCard(g, card);
  for (const b of MENU_BUTTONS) button(g, b.id, t(b.labelKey), { size: 40 });
  const chip = providerChipText(v);
  if (chip) drawPill(ctx, PROVIDER_CHIP.x, PROVIDER_CHIP.y, chip, { align: 'right', size: 28, h: PROVIDER_CHIP.h, maxW: 520 });
}
