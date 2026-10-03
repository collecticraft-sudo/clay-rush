// Shared drawing helpers of the screens: titles, buttons with their focus / pressed state, value rows. OWNER: UI engineer.
//
// `g` is the draw context built by presentation.js for one frame:
//   { ctx, v (the UI view model), assets, density, nowMs, target(id), focused(id), pressed(id), reduceMotion }

import { C, font, text } from '../theme.js';
import { drawButton, drawChoiceCell, drawFocusRing, drawStepper } from '../widgets.js';
import { CROSSHAIR_SWATCH, optionId, rowOptions } from '../layout-data.js';
import { SETTINGS_SPEC } from '../storage.js';
import { formatDecimal, t } from '../strings.en.js';

/** True for the mouse's trigger label ("Click"): prompts then say "click" instead of "press Click" (F18). */
export const isClickLabel = (label) => typeof label === 'string' && /click/i.test(label);

/** A screen title: cream display capitals on the dark veil. */
export function title(g, str, y, size = 84, o = {}) {
  text(g.ctx, str, o.x ?? 960, y, { family: 'display', size, fill: o.fill ?? C.cream, align: o.align ?? 'center', maxW: o.maxW ?? 1700 });
}

/** A body line on the dark veil. */
export function caption(g, str, y, o = {}) {
  text(g.ctx, str, o.x ?? 960, y, { family: 'ui', size: o.size ?? 30, weight: o.weight ?? 600, fill: o.fill ?? C.cream, align: o.align ?? 'center', maxW: o.maxW ?? 1600, alpha: o.alpha });
}

/** Draw the button of target `id` (if it exists on this screen) with its focus and pressed state. */
export function button(g, id, label, o = {}) {
  const tg = g.target(id);
  if (!tg) return null;
  drawButton(g.ctx, tg, label, { focused: g.focused(id), pressed: g.pressed(id), ...o });
  return tg;
}

/** The label of option `value` of value row `row`. */
export function optionLabel(row, value, i) {
  if (row.labels) return t(row.labels[i]);
  if (row.type === 'toggle') return t(value ? 'settings.on' : 'settings.off');
  if (row.key === 'crosshairColor') return t(`settings.crosshairColor.${value}`);
  if (row.key === 'triggerButton') return t(`settings.triggerButton.${value}`);
  if (row.key === 'aimCurve') return t(`settings.aimCurve.${value}`);
  if (row.key === 'difficulty') return t(`difficulty.${value}`);
  if (row.key === 'stage') return t(`stage.${value}`);
  return String(value);
}

/** The text of a stepper's value. */
export function stepperText(key, v) {
  if (key === 'triggerCompMs') return t('settings.triggerCompMs.value', { n: Math.round(v) });
  if (key === 'volume') return t('settings.percent', { n: Math.round(v * 100) });
  return `${formatDecimal(v, 1)}×`;
}

/**
 * Draw the cells of a value row (settings, tuning). `prefix` is the target id prefix ('set'). The focus ring surrounds the whole control when
 * the row has the focus. Returns true when the row is focused.
 */
export function valueRow(g, prefix, row, o = {}) {
  const { ctx, v } = g;
  const value = v.settings[row.key];
  const focused = v.focus.valueRow?.key === row.key;
  if (row.type === 'stepper') {
    const minus = g.target(`${prefix}.${row.key}.minus`);
    const plus = g.target(`${prefix}.${row.key}.plus`);
    if (!minus || !plus) return false;
    const spec = SETTINGS_SPEC[row.key];
    drawStepper(ctx, minus, plus, stepperText(row.key, value), {
      atMin: spec && value <= spec.min + 1e-9, atMax: spec && value >= spec.max - 1e-9, pressedId: v.pressedId, dark: o.dark,
      frac: spec ? (value - spec.min) / (spec.max - spec.min) : undefined,
    });
    if (focused) drawFocusRing(ctx, { x0: minus.x - minus.w / 2, y0: minus.y - minus.h / 2, x1: plus.x + plus.w / 2, y1: plus.y + plus.h / 2 }, { pad: 6, radius: 22 });
    return focused;
  }
  const opts = rowOptions(row);
  let ring = null;
  opts.forEach((val, i) => {
    const tg = g.target(`${prefix}.${row.key}.opt.${optionId(val)}`);
    if (!tg) return;
    const prev = ctx.globalAlpha;
    if (tg.enabled === false) ctx.globalAlpha = prev * 0.5; // locked by a URL flag (U-07)
    drawChoiceCell(ctx, tg, optionLabel(row, val, i), {
      selected: value === val, dark: o.dark, swatch: row.swatch ? CROSSHAIR_SWATCH[val] : undefined, size: o.cellSize,
    });
    ctx.globalAlpha = prev;
    const b = { x0: tg.x - tg.w / 2, y0: tg.y - tg.h / 2, x1: tg.x + tg.w / 2, y1: tg.y + tg.h / 2 };
    ring = ring ? { x0: Math.min(ring.x0, b.x0), y0: Math.min(ring.y0, b.y0), x1: Math.max(ring.x1, b.x1), y1: Math.max(ring.y1, b.y1) } : b;
  });
  if (focused && ring) drawFocusRing(ctx, ring, { pad: 6, radius: 22 });
  return focused;
}

/** A small label in display capitals with letter spacing feel (a section header). */
export function sectionLabel(g, str, x, y, o = {}) {
  text(g.ctx, str, x, y, { font: font('display', o.size ?? 36), fill: o.fill ?? C.orangeLight, align: o.align ?? 'left', maxW: o.maxW });
}
