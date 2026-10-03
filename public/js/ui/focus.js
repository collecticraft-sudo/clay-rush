// Focus navigation for the menus: pure maths on the target list of a screen (no DOM, no canvas, no clock). OWNER: UI engineer.
//
// One unit at a time has the FOCUS. The stick of a Joy-Con (or the arrow keys) moves it to the nearest enabled unit in the pushed direction,
// A / Enter activates it, B / Esc goes back (ui.js owns those rules; this file only answers "which unit is next").
//
// A FOCUS UNIT is what the focus can rest on:
//   - a plain target (button, mode card): kind 'button';
//   - a VALUE ROW: every target that carries the same `row` key (layout-data.js): the "-" and "+" of a stepper, or the option cells of a choice.
//     The row is focused as a whole; stick left / right then CHANGES ITS VALUE (ui.js), so left and right never move the focus out of a row.
//     Its navigation bounds span the whole column (`span`), its ring bounds are the union of its cells.
//
// Spatial rule (deterministic, no wrap): among the ENABLED units that lie beyond the focused one's facing edge in the pushed direction, the best
// score wins: gap between the facing edges + 2 x gap on the other axis + a small pull towards alignment and nearness; the first unit in layout
// order wins an exact tie. No candidate = the focus stays where it is (never lost, never wrapped).

const EDGE_EPS = 1;

function boundsOf(tg) {
  if (tg.shape === 'circle') return { x0: tg.x - tg.r, y0: tg.y - tg.r, x1: tg.x + tg.r, y1: tg.y + tg.r };
  return { x0: tg.x - tg.w / 2, y0: tg.y - tg.h / 2, x1: tg.x + tg.w / 2, y1: tg.y + tg.h / 2 };
}

/**
 * The focus units of a target list, in layout order (the order of the first target of each unit).
 * @param {Array<object>} targets
 * @returns {Array<{id:string, kind:'button'|'row', rowKey?:string, rowType?:'stepper'|'choice', cells:string[], enabled:boolean,
 *   ring:{x0:number,y0:number,x1:number,y1:number}, nav:{x0:number,y0:number,x1:number,y1:number}, cx:number, cy:number}>}
 */
export function buildFocusUnits(targets) {
  const units = [];
  const rows = new Map();
  for (const tg of targets) {
    if (tg.focusable === false) continue;
    if (tg.row) {
      let u = rows.get(tg.row);
      if (!u) {
        u = { id: `row:${tg.row}`, kind: 'row', rowKey: tg.row, rowType: tg.rowType ?? 'choice', cells: [], enabled: false, ring: null, nav: null, cx: 0, cy: 0, span: null };
        rows.set(tg.row, u);
        units.push(u);
      }
      u.cells.push(tg.id);
      u.enabled = u.enabled || tg.enabled !== false;
      const b = boundsOf(tg);
      u.ring = u.ring ? { x0: Math.min(u.ring.x0, b.x0), y0: Math.min(u.ring.y0, b.y0), x1: Math.max(u.ring.x1, b.x1), y1: Math.max(u.ring.y1, b.y1) } : b;
      if (Array.isArray(tg.span)) u.span = tg.span;
    } else {
      const b = boundsOf(tg);
      units.push({ id: tg.id, kind: 'button', cells: [tg.id], enabled: tg.enabled !== false, ring: b, nav: b, cx: tg.x, cy: tg.y });
    }
  }
  for (const u of rows.values()) {
    u.nav = { x0: u.span ? u.span[0] : u.ring.x0, y0: u.ring.y0, x1: u.span ? u.span[1] : u.ring.x1, y1: u.ring.y1 };
    u.cx = (u.nav.x0 + u.nav.x1) / 2;
    u.cy = (u.nav.y0 + u.nav.y1) / 2;
    delete u.span;
  }
  return units;
}

/** The unit that holds the target `id` (a cell of a row, or the button itself), or null. */
export function unitOfTarget(units, id) {
  for (const u of units) if (u.cells.includes(id)) return u;
  return null;
}

/**
 * The next focus unit from `fromId` in direction `dir` ('up' | 'down' | 'left' | 'right'), or null when there is none (the focus stays).
 * @param {ReturnType<typeof buildFocusUnits>} units
 */
export function moveFocus(units, fromId, dir) {
  const from = units.find((u) => u.id === fromId);
  if (!from) return null;
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  const a0 = horizontal ? from.nav.x0 : from.nav.y0;
  const a1 = horizontal ? from.nav.x1 : from.nav.y1;
  const p0 = horizontal ? from.nav.y0 : from.nav.x0;
  const p1 = horizontal ? from.nav.y1 : from.nav.x1;
  let best = null;
  let bestScore = Infinity;
  for (const u of units) {
    if (u === from || !u.enabled) continue;
    const b0 = horizontal ? u.nav.x0 : u.nav.y0;
    const b1 = horizontal ? u.nav.x1 : u.nav.y1;
    if (sign > 0 ? b0 < a1 - EDGE_EPS : b1 > a0 + EDGE_EPS) continue;
    const gapAlong = sign > 0 ? Math.max(0, b0 - a1) : Math.max(0, a0 - b1);
    const q0 = horizontal ? u.nav.y0 : u.nav.x0;
    const q1 = horizontal ? u.nav.y1 : u.nav.x1;
    const gapPerp = Math.max(0, q0 - p1, p0 - q1);
    const centreAlong = horizontal ? u.cx - from.cx : u.cy - from.cy;
    const centrePerp = Math.abs(horizontal ? u.cy - from.cy : u.cx - from.cx);
    const score = gapAlong + 2 * gapPerp + 0.25 * centrePerp + 0.1 * Math.abs(centreAlong);
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = u;
    }
  }
  return best;
}

/**
 * What one stick push does to the focus: on a focused ROW left and right change its value (never the focus), every other push is the spatial
 * move above. Returns the unit the focus moves to, or null (it stays).
 */
export function nextFocus(units, fromId, dir) {
  const from = units.find((u) => u.id === fromId);
  if (!from) return null;
  if (from.kind === 'row' && (dir === 'left' || dir === 'right')) return null;
  return moveFocus(units, fromId, dir);
}
