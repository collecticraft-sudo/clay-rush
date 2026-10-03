// Settings: two columns of value rows (docs/architecture.md 8.4), the description of the focused row, and the buttons "Aim and trigger
// tuning", "Reset best scores" (confirm overlay) and "Back". OWNER: UI engineer.
import { C, rr, text, textWrapped } from '../theme.js';
import { SETTINGS_COLS, SETTINGS_GRID, SETTINGS_ROWS } from '../layout-data.js';
import { t } from '../strings.en.js';
import { button, sectionLabel, title, valueRow } from './common.js';

export function draw(g) {
  const { ctx, v } = g;
  const G = SETTINGS_GRID;
  title(g, t('settings.title'), G.titleY, 84);
  for (const [colKey, labelKey] of [['left', 'settings.group.aim'], ['right', 'settings.group.game']]) {
    const col = SETTINGS_COLS[colKey];
    const n = SETTINGS_ROWS.filter((r) => r.col === colKey).length;
    const top = G.firstY - G.pitch / 2 - 6;
    const h = n * G.pitch + 12;
    rr(ctx, col.x0 - 10, top + 8, col.x1 - col.x0 + 20, h, 26);
    ctx.fillStyle = 'rgba(8,10,14,0.35)';
    ctx.fill();
    rr(ctx, col.x0 - 10, top, col.x1 - col.x0 + 20, h, 26);
    ctx.fillStyle = C.cream;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = C.slate;
    ctx.stroke();
    sectionLabel(g, t(labelKey), col.x0 + 14, G.groupY, { size: 40 });
  }
  const idx = { left: 0, right: 0 };
  let focusedRow = null;
  for (const row of SETTINGS_ROWS) {
    const col = SETTINGS_COLS[row.col];
    const i = idx[row.col]++;
    const cy = G.firstY + i * G.pitch;
    const focused = v.focus.valueRow?.key === row.key;
    if (focused) {
      rr(ctx, col.x0, cy - G.pitch / 2 + 4, col.x1 - col.x0, G.pitch - 8, 18);
      ctx.fillStyle = 'rgba(242,107,29,0.14)';
      ctx.fill();
      focusedRow = row;
    }
    if (i > 0) {
      ctx.fillStyle = 'rgba(27,31,36,0.1)';
      ctx.fillRect(col.x0 + 16, cy - G.pitch / 2, col.x1 - col.x0 - 32, 2);
    }
    text(ctx, t(`settings.${row.key}`), col.x0 + G.labelPad, cy + 11, { family: 'ui', size: 32, weight: 700, fill: C.slate, maxW: col.x1 - col.x0 - G.controlW - G.labelPad - 24 });
    valueRow(g, 'set', row, { cellSize: 32 });
  }
  // the line that explains the focused row (or the focused button)
  const fid = v.focus.id;
  const desc = focusedRow ? t(`settings.${focusedRow.key}.hint`) : fid === 'set.tune' ? t('tune.intro', { fire: v.labels.fire }) : '';
  if (desc) textWrapped(ctx, desc, 960, G.descY, 1700, 34, { family: 'ui', size: 30, weight: 600, fill: C.cream, align: 'center', maxLines: 1 });
  button(g, 'set.tune', t('settings.tune'), { size: 40 });
  button(g, 'set.reset', t('settings.reset'), { size: 40 });
  button(g, 'set.back', t('settings.back'), { size: 44, primary: true });
}
