// In-round HUD of Clay Rush (architecture 6.2, design 9). OWNER: Render & Audio engineer. Drawn OVER the world pass, never shaken or zoomed.
//
// Layout (1920 x 1080): top-left the score with the streak multiplier ring; top-centre the stage name and the pull counter (Classic), the
// clock (Time Attack) or the session stats (Zen); top-right the wind sock with the speed; bottom-left the two shells (full / empty, with
// the insert and reload animations) and the target tally as small clay icons (broken = orange, lost = grey); a low-battery toast; banners
// (DOUBLE!, STREAK xN, PERFECT STAGE, TWO WITH ONE!, TIME!, NEW BEST!) in the upper middle, SMOKED! above the hit; the stage card in phase
// `stageCard`; the "PRESS ZR TO CALL PULL!" prompt in phase `ready`.
//
// ALL TEXT comes through `hv.t(key, params)` with the keys of architecture 8.5 (HUD_KEYS); numbers (score, popups) are digits. A string
// is asked for again only when its parameters change (memo), so the per-frame cost is a Map lookup. Banners are baked once per text
// (draw-util bakeTextSprite). Icons come from the manifest with the procedural painters as fallback (sprites.js).
// Reduce motion: banners fade instead of slamming, the card fades instead of sliding, nothing shakes. Reduce flashes: no white streaks.

import { ART_CONFIG } from './art-config.js';
import { NULL_ASSETS } from './assets.js';
import { COLORS, fontString } from './palette.js';
import { bakeTextSprite, digitsWidth, drawDigits, drawText, fitText, roundRectPath } from './draw-util.js';
import { easeInCubic, easeOutBackK, easeOutCubic } from './ease.js';
import { createSprites } from './sprites.js';
import { createLabelStack, hitLabelSpec } from './label-layout.js';
import { fontsGeneration } from './fonts.js';
import { FIELD } from '../shared/playfield.js';

const TAU = Math.PI * 2;

/** One reused option object for the text calls of the HUD (no allocation per frame; draw-util never keeps it). Code review R-06. */
const OPT = { style: undefined, size: undefined, align: undefined, look: undefined, fill: undefined, alpha: undefined, tint: undefined, scale: undefined };
function O(style, size, align, look, fill, alpha, tint, scale) {
  OPT.style = style;
  OPT.size = size;
  OPT.align = align;
  OPT.look = look;
  OPT.fill = fill;
  OPT.alpha = alpha;
  OPT.tint = tint;
  OPT.scale = scale;
  return OPT;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The string keys of architecture 8.5 that the HUD asks `hv.t` for (and no other). */
export const HUD_KEYS = Object.freeze([
  'hud.score', 'hud.best', 'hud.pull', 'hud.pullPrompt', 'hud.reloading', 'hud.wind', 'hud.time', 'hud.stage', 'hud.stageCard.title',
  'hud.stageCard.name', 'hud.banner.double', 'hud.banner.twoWithOne', 'hud.banner.smoked', 'hud.banner.streak', 'hud.banner.perfect',
  'hud.banner.timeUp', 'hud.banner.newBest', 'hud.lowBattery', 'hud.zen.stats', 'hud.dry', 'hud.multiplier',
]);

/** Banner tints by key. */
const BANNER_TINT = Object.freeze({
  'hud.banner.double': 'gold', 'hud.banner.twoWithOne': 'gold', 'hud.banner.streak': 'orange', 'hud.banner.perfect': 'gold',
  'hud.banner.timeUp': 'terracotta', 'hud.banner.newBest': 'gold', 'hud.banner.smoked': 'cream',
});

/** "1:05" for 65 s (rounded up, never negative). */
export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(num(seconds, 0) - 1e-6));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** "12,450" for 12450. */
export function formatScore(n) {
  const v = Math.max(0, Math.round(num(n, 0)));
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

/**
 * @param {{assets?:object, createCanvas?:(w:number,h:number)=>any, config?:object}} [opts]
 */
export function createHud(opts = {}) {
  const assets = opts.assets ?? NULL_ASSETS;
  const createCanvas = typeof opts.createCanvas === 'function' ? opts.createCanvas : null;
  const C = opts.config ?? ART_CONFIG;
  const L = C.hud;
  const sprites = createSprites({ assets, createCanvas, density: 2, config: C });

  // ---- state
  let nowMs = 0;
  let scoreShown = 0;
  let scoreTarget = 0;
  let scoreStr = '0';
  let scoreStrFor = -1;
  let ringPulse = Infinity; // ms since a streak level-up
  let insertAge = Infinity;
  let dryAge = Infinity;
  let tickAge = Infinity;
  let bonusAge = Infinity;
  let bonusText = '';
  let phase = '';
  let readyAge = 0;
  let cardAge = Infinity; // ms since the card started (Infinity: none)
  let cardOut = Infinity; // ms since the card started leaving
  const cardStage = { n: 1, name: '', windX: 0 };
  const topStage = { index: 0, name: '' }; // the stage named by the top bar
  let battery = 'unknown';
  let batteryAge = Infinity;
  let mode = '';
  // banners: a small queue; one on screen at a time
  const queue = [];
  const banner = { key: '', n: 0, sprite: null, age: Infinity, dur: 1 };
  // SMOKED! popups above the hit point
  const smoked = [];
  for (let i = 0; i < 4; i++) smoked.push({ alive: false, x: 0, y: 0, age: 0 });
  const labels = createLabelStack(C);
  let smokedSprite = null;
  let smokedFor = '';
  let smokedGen = -1;
  let clockFor = -1;
  let clockStr = '0:00';
  let windFor = -1;
  let windStr = '0.0';
  /** "1.5" for 1.53 m/s, memoised on the tenth (no string per frame). */
  function windString(speed) {
    const t = Math.round(speed * 10);
    if (t !== windFor) {
      windFor = t;
      windStr = (t / 10).toFixed(1);
    }
    return windStr;
  }
  // tally of the stage: 0 = launched, 1 = broken, 2 = lost
  const tallyIds = new Int32Array(L.tally.max);
  const tallyState = new Uint8Array(L.tally.max);
  let tallyCount = 0;
  // Zen: last 20 shots
  const zenRing = new Uint8Array(20);
  let zenCount = 0;
  let zenPos = 0;
  // memoised strings
  const memo = new Map();

  function tx(hv, key, pa, a, pb, b) {
    let m = memo.get(key);
    if (m && m.fn === hv.t && m.a === a && m.b === b) return m.s;
    const params = {};
    if (pa) params[pa] = a;
    if (pb) params[pb] = b;
    let s = key;
    try {
      const v = hv.t(key, params);
      if (typeof v === 'string') s = v;
    } catch {
      /* a broken translator must not break the frame */
    }
    if (!m) {
      m = { fn: null, a: undefined, b: undefined, s: '' };
      memo.set(key, m);
    }
    m.fn = hv.t;
    m.a = a;
    m.b = b;
    m.s = s;
    return s;
  }

  // ---- tally and banners
  function tallyAdd(id) {
    if (tallyCount >= tallyIds.length) {
      tallyIds.copyWithin(0, 1);
      tallyState.copyWithin(0, 1);
      tallyCount--;
    }
    tallyIds[tallyCount] = id;
    tallyState[tallyCount] = 0;
    tallyCount++;
  }
  function tallySet(id, state) {
    for (let i = tallyCount - 1; i >= 0; i--) {
      if (tallyIds[i] === id) {
        tallyState[i] = state;
        return;
      }
    }
  }

  function pushBanner(key, n = 0) {
    if (queue.length >= L.banner.maxQueue) queue.shift();
    queue.push({ key, n });
  }

  /** Additive: show a banner from outside (the UI calls it with 'newBest'). `name` is the last part of the key, e.g. 'newBest'. */
  function showBanner(name, n = 0) {
    const key = `hud.banner.${name}`;
    if (HUD_KEYS.includes(key)) pushBanner(key, n);
  }

  function handleEvents(events, evNowMs) {
    if (Number.isFinite(evNowMs)) nowMs = evNowMs;
    if (!events) return;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev) continue;
      switch (ev.type) {
        case 'stageStart':
          tallyCount = 0;
          // the stage card owns the screen now: a banner of the last pull ("DOUBLE!") must not show under it, but PERFECT STAGE (queued by
          // the stageClear of the same tick) is kept and shown right after the card (code review R-01)
          for (let q = queue.length - 1; q >= 0; q--) if (queue[q].key !== 'hud.banner.perfect') queue.splice(q, 1);
          if (banner.key !== 'hud.banner.perfect') banner.age = Infinity;
          cardStage.n = num(ev.index, 0) + 1;
          cardStage.name = String(ev.name ?? '');
          cardStage.windX = num(ev.windX, 0);
          break;
        case 'launch':
          if (Array.isArray(ev.ids)) for (const id of ev.ids) tallyAdd(id);
          break;
        case 'hit':
          tallySet(ev.id, 1);
          {
            // the same label stack as the world renderer's points popups (render/label-layout.js): SMOKED! sits right above its popup
            // and never on another label (QA F5)
            const spec = hitLabelSpec(ev);
            if (spec) {
              const pos = labels.place(spec, nowMs);
              if (ev.centre) {
                const s = smoked.find((x) => !x.alive) ?? smoked[0];
                s.alive = true;
                s.x = pos.x;
                s.y = pos.y - labels.lineH(spec.big) - (C.fx.labels.smokedGap ?? 6);
                s.age = 0;
              }
            }
          }
          break;
        case 'lost':
          tallySet(ev.id, 2);
          break;
        case 'shot':
          zenRing[zenPos] = Array.isArray(ev.hitIds) && ev.hitIds.length > 0 ? 1 : 0;
          zenPos = (zenPos + 1) % zenRing.length;
          zenCount = Math.min(zenRing.length, zenCount + 1);
          break;
        case 'dryFire':
          dryAge = 0;
          break;
        case 'reload':
          if (ev.phase === 'done') insertAge = 0;
          break;
        case 'double': pushBanner('hud.banner.double'); break;
        case 'twoWithOne': pushBanner('hud.banner.twoWithOne'); break;
        case 'streak':
          ringPulse = 0;
          if (num(ev.level, 1) >= 2) pushBanner('hud.banner.streak', num(ev.level, 2));
          break;
        case 'stageClear':
          if (ev.perfect) pushBanner('hud.banner.perfect');
          break;
        case 'timeUp': pushBanner('hud.banner.timeUp'); break;
        case 'tick': tickAge = 0; break;
        case 'timeBonus':
          bonusAge = 0;
          bonusText = `+${Math.round(num(ev.deltaS, 0) * 100) / 100}`; // +0.25 stays +0.25 (QA F23)
          break;
        default:
          break;
      }
    }
  }

  function update(dtS) {
    const ms = Math.max(0, Math.min(0.1, num(dtS, 0))) * 1000;
    nowMs += 0; // the clock of the frame comes with draw(hv.nowMs)
    ringPulse += ms;
    insertAge += ms;
    dryAge += ms;
    tickAge += ms;
    bonusAge += ms;
    batteryAge += ms;
    readyAge += ms;
    if (cardAge !== Infinity) cardAge += ms;
    if (cardOut !== Infinity) cardOut += ms;
    // score roll-up
    const k = 1 - Math.exp(-ms / 110);
    scoreShown += (scoreTarget - scoreShown) * k;
    if (Math.abs(scoreTarget - scoreShown) < 0.5) scoreShown = scoreTarget;
    // banners
    if (banner.age !== Infinity) {
      banner.age += ms;
      if (banner.age >= banner.dur) banner.age = Infinity;
    }
    for (const s of smoked) {
      if (!s.alive) continue;
      s.age += ms;
      if (s.age > L.smoked.holdMs + 300) s.alive = false;
    }
  }

  // ---- drawing helpers
  function plate(ctx, x, y, w, h, r, alpha = 0.6) {
    roundRectPath(ctx, x, y, w, h, r);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS.slate;
    ctx.fill();
    ctx.globalAlpha = Math.min(1, alpha * 0.55);
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.cream;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawScore(ctx, snap, hv) {
    const S = L.score;
    plate(ctx, S.x, S.y, S.w, S.h, 24, 0.58);
    drawText(ctx, tx(hv, 'hud.score'), S.x + 28, S.y + 40, O('hudLabel', 28, undefined, 'label', COLORS.goldLight));
    const v = Math.round(scoreShown);
    if (v !== scoreStrFor) {
      scoreStr = formatScore(v);
      scoreStrFor = v;
    }
    const room = S.w - 2 * S.ringR - 22 - 28 - 26;
    const dw = digitsWidth(ctx, scoreStr, fontString('hudNumber', S.digits));
    const fit = dw > room ? room / dw : 1;
    drawDigits(ctx, scoreStr, S.x + 28, S.y + S.h - 18, O('hudNumber', S.digits, 'left', undefined, undefined, undefined, undefined, fit));
    // multiplier ring
    const cx = S.x + S.w - S.ringR - 22;
    const cy = S.y + S.h / 2;
    const mult = Math.max(1, Math.round(num(snap.multiplier, 1)));
    const prog = clamp01(num(snap.multiplierProgress, 0));
    const pulse = !hv.reduceMotion && ringPulse < 400 ? 1 + 0.18 * Math.sin((ringPulse / 400) * Math.PI) : 1;
    const R = S.ringR * pulse;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fillStyle = COLORS.slateSoft;
    ctx.fill();
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(255,244,220,0.18)';
    ctx.stroke();
    if (prog > 0.001) {
      ctx.beginPath();
      ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + TAU * prog);
      ctx.strokeStyle = mult >= 4 ? COLORS.gold : COLORS.orange;
      ctx.stroke();
    }
    const label = tx(hv, 'hud.multiplier', 'n', mult);
    drawText(ctx, label, cx, cy + 15, O('hudInfo', Math.round(44 * pulse), 'center', 'label', mult > 1 ? COLORS.gold : COLORS.cream));
  }

  function drawTopCentre(ctx, snap, hv) {
    const cx = FIELD.cx;
    const y = L.top.y;
    // the top bar switches to the new stage when the stage card has slid in with its name (not at stageStart, while the old backdrop and
    // the card are still moving: video review)
    const st = snap.stage;
    if (st && (cardAge === Infinity || cardAge >= L.card.inMs || topStage.name === '')) {
      topStage.index = num(st.index, 0);
      topStage.name = String(st.name ?? '');
    }
    const stage = topStage;
    if (mode === 'timeattack') {
      const w = 360;
      plate(ctx, cx - w / 2, y, w, 112, 26, 0.58);
      const left = num(snap.timeLeft, 0);
      const warn = left <= L.timeWarnS;
      const pulse = warn && !hv.reduceMotion && tickAge < 300 ? 1 + 0.12 * Math.sin((tickAge / 300) * Math.PI) : 1;
      sprites.drawIcon(ctx, 'icon_clock', cx - 118, y + 56, 64);
      const sec = Math.max(0, Math.ceil(left - 1e-6));
      if (sec !== clockFor) {
        clockFor = sec;
        clockStr = formatClock(sec);
      }
      const s = tx(hv, 'hud.time', 's', clockStr);
      drawDigits(ctx, s, cx + 30, y + 88, O('hudTimer', 80, 'center', undefined, warn ? COLORS.terracotta : COLORS.cream, undefined, undefined, pulse));
      if (bonusAge < 900) {
        const u = bonusAge / 900;
        drawText(ctx, bonusText, cx + w / 2 + 16, y + 80 - 30 * u, O('popup44', 52, undefined, 'popup', COLORS.oliveLight, 1 - u * u));
      }
      return;
    }
    // Classic numbers its stages; Zen (and Time Attack, which only shows its clock) play one stage: the name alone (QA F11)
    const name = mode === 'classic'
      ? tx(hv, 'hud.stage', 'n', num(stage.index, 0) + 1, 'name', String(stage.name ?? ''))
      : tx(hv, 'hud.stageCard.name', 'name', String(stage.name ?? ''));
    const font = fontString('hudInfo', 40);
    const size = fitText(ctx, name, font, 560, 30, 0.06);
    if (mode === 'zen') {
      const acc = zenCount > 0 ? Math.round((countZen() / zenCount) * 100) : 0;
      const stats = tx(hv, 'hud.zen.stats', 'hits', num(snap.stats?.hits, 0), 'acc', acc);
      plate(ctx, cx - 320, y, 640, 104, 26, 0.55);
      drawText(ctx, name, cx, y + 44, O('hudInfo', size, 'center', 'label', COLORS.goldLight));
      drawText(ctx, stats, cx, y + 88, O('hudLabel', 30, 'center', 'label'));
      return;
    }
    if (mode === 'practice') return;
    plate(ctx, cx - 300, y, 600, 112, 26, 0.55);
    drawText(ctx, name, cx, y + 42, O('hudInfo', size, 'center', 'label', COLORS.goldLight));
    const pull = snap.pull ?? { index: 0, count: null };
    if (pull.count !== null && pull.count !== undefined) {
      const n = Math.min(num(pull.count, 1), num(pull.index, 0) + 1);
      drawText(ctx, tx(hv, 'hud.pull', 'n', n, 'total', num(pull.count, 0)), cx, y + 96, O('hudInfo', 50, 'center', 'label'));
    }
  }

  function countZen() {
    let n = 0;
    for (let i = 0; i < zenCount; i++) n += zenRing[i];
    return n;
  }

  function drawWind(ctx, snap, hv) {
    const W = L.wind;
    const wx = num(snap.wind?.x, 0) + num(snap.wind?.gust, 0);
    const speed = Math.abs(wx);
    const w = 300;
    const x0 = W.x - w;
    plate(ctx, x0, W.y, w, 112, 26, 0.55);
    // the sock points downwind and flutters; it droops when the air is still
    const flutter = hv.reduceMotion ? 0 : Math.sin(nowMs * 0.012 + 1) * 0.06 * Math.min(1, speed);
    const droop = (1 - Math.min(1, speed / 2.5)) * 0.3;
    const flip = wx < 0;
    ctx.save();
    ctx.translate(x0 + 70, W.y + 56);
    ctx.rotate((flip ? -1 : 1) * (droop + flutter));
    sprites.drawIcon(ctx, 'icon_wind', 0, 0, W.icon, 1, 0, flip);
    ctx.restore();
    const label = tx(hv, 'hud.wind', 'speed', windString(speed));
    drawText(ctx, label, W.x - 26, W.y + 76, O('hudInfo', 52, 'right', 'label'));
  }

  function drawShells(ctx, snap, hv) {
    const SH = L.shells;
    const shells = snap.shells ?? { loaded: 2, capacity: 2, reloadingS: 0, infinite: false };
    const cap = Math.max(1, Math.min(4, num(shells.capacity, 2)));
    const loaded = shells.infinite && !(shells.reloadingS > 0) ? cap : Math.max(0, num(shells.loaded, 0));
    const shake = !hv.reduceMotion && dryAge < 300 ? Math.sin(dryAge * 0.12) * 6 * (1 - dryAge / 300) : 0;
    plate(ctx, SH.x - 20, SH.y - SH.h - 22, cap * (SH.w + SH.gap) + 26, SH.h + 34, 22, 0.45);
    for (let i = 0; i < cap; i++) {
      const full = i < loaded;
      const cx = SH.x + i * (SH.w + SH.gap) + SH.w / 2 + shake;
      let cy = SH.y - SH.h / 2;
      let a = 1;
      if (full && insertAge < L.insertMs) {
        // the shells slide in one after the other
        const u = clamp01((insertAge - i * (L.insertMs * 0.35)) / (L.insertMs * 0.65));
        cy += (1 - easeOutCubic(u)) * (hv.reduceMotion ? 0 : 60);
        a = u;
      }
      if (!full) sprites.drawIcon(ctx, 'icon_shell_empty', cx, cy, SH.h, 0.75);
      if (full) sprites.drawIcon(ctx, 'icon_shell_full', cx, cy, SH.h, a);
    }
    const tx0 = SH.x + cap * (SH.w + SH.gap) + 24;
    if (num(shells.reloadingS, 0) > 0) {
      drawText(ctx, tx(hv, 'hud.reloading'), tx0, SH.y - 66, O('hudInfo', 44, undefined, 'label', COLORS.goldLight));
    } else if (dryAge < 700) {
      const a = dryAge < 500 ? 1 : 1 - (dryAge - 500) / 200;
      drawText(ctx, tx(hv, 'hud.dry'), tx0, SH.y - 66, O('hudInfo', 50, undefined, 'label', COLORS.terracotta, a));
    }
  }

  function drawTally(ctx) {
    if (tallyCount === 0) return;
    const T = L.tally;
    const x0 = L.shells.x + 2 * (L.shells.w + L.shells.gap) + 24;
    const y = T.y + 4;
    for (let i = 0; i < tallyCount; i++) {
      const cx = x0 + i * (T.size + T.gap) + T.size / 2;
      const st = tallyState[i];
      // clay icons (design 9, QA F24): broken = the orange clay, in the air = the clay faded, lost = a grey clay with a slash
      if (st === 1) sprites.drawIcon(ctx, 'icon_clay', cx, y, T.size, 1);
      else if (st === 2) {
        sprites.drawIcon(ctx, 'icon_clay', cx, y, T.size, 0.32);
        ctx.beginPath();
        ctx.moveTo(cx - T.size * 0.36, y + T.size * 0.24);
        ctx.lineTo(cx + T.size * 0.36, y - T.size * 0.24);
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.strokeStyle = COLORS.slate;
        ctx.stroke();
      } else {
        sprites.drawIcon(ctx, 'icon_clay', cx, y, T.size * 0.86, 0.55);
      }
    }
  }

  function drawBattery(ctx, hv) {
    const b = hv.battery ?? 'unknown';
    if (b !== battery) {
      battery = b;
      batteryAge = 0;
    }
    if (b !== 'low' && b !== 'critical') return;
    if (b === 'low' && batteryAge > L.toastMs) return;
    const text = tx(hv, 'hud.lowBattery');
    const a = b === 'low' && batteryAge > L.toastMs - 400 ? (L.toastMs - batteryAge) / 400 : 1;
    const font = fontString('hudLabel', 28);
    if (ctx.font !== font) ctx.font = font;
    const w = ctx.measureText(text).width + 56;
    const x = L.wind.x - w;
    const y = L.wind.y + 128;
    roundRectPath(ctx, x, y, w, 52, 26);
    ctx.globalAlpha = 0.9 * a;
    ctx.fillStyle = b === 'critical' ? COLORS.terracotta : COLORS.slate;
    ctx.fill();
    ctx.globalAlpha = 1;
    drawText(ctx, text, x + w / 2, y + 36, O('hudLabel', 28, 'center', undefined, COLORS.cream, a));
  }

  function bannerText(hv, key, n) {
    if (key === 'hud.banner.streak') return tx(hv, key, 'n', n);
    return tx(hv, key);
  }

  function drawBanner(ctx, hv) {
    const B = L.banner;
    if (banner.age === Infinity && queue.length > 0 && cardAge === Infinity) { // a queued banner waits for the stage card to leave
      const next = queue.shift();
      banner.key = next.key;
      banner.n = next.n;
      banner.age = 0;
      banner.dur = B.inMs + B.holdMs + B.outMs;
      const text = bannerText(hv, next.key, next.n);
      banner.sprite = createCanvas
        ? bakeTextSprite(createCanvas, `hud-banner|${next.key}|${text}`, text, { style: 'banner110', size: B.size, look: 'banner', tint: BANNER_TINT[next.key] ?? 'gold', density: 2, maxWidth: 1500 })
        : null;
      banner.text = text;
    }
    if (banner.age === Infinity) return;
    const u = banner.age;
    let scale = 1;
    let a = 1;
    let rise = 0;
    if (u < B.inMs) {
      const p = u / B.inMs;
      if (hv.reduceMotion) a = p;
      else {
        scale = B.from + (1 - B.from) * easeOutBackK(p, 2.2);
        a = Math.min(1, p * 2.5);
      }
    } else if (u > B.inMs + B.holdMs) {
      const p = clamp01((u - B.inMs - B.holdMs) / B.outMs);
      a = 1 - p;
      if (!hv.reduceMotion) rise = -40 * easeInCubic(p);
    }
    const cx = FIELD.cx;
    const cy = B.y + rise;
    // a slanted slate band behind the words, and a white streak across it on the way in
    const bw = (banner.sprite ? banner.sprite.w : 900) + 140;
    const grow = hv.reduceMotion ? 1 : easeOutCubic(clamp01(u / (B.inMs * 1.2)));
    ctx.save();
    ctx.translate(cx, cy - B.size * 0.36);
    ctx.transform(1, 0, -0.22, 1, 0, 0);
    ctx.globalAlpha = 0.55 * a;
    ctx.fillStyle = COLORS.slate;
    ctx.fillRect((-bw / 2) * grow, -B.size * 0.5, bw * grow, B.size * 1.0);
    ctx.globalAlpha = 0.9 * a;
    ctx.fillStyle = BANNER_TINT[banner.key] === 'terracotta' ? COLORS.terracotta : COLORS.orange;
    ctx.fillRect((-bw / 2) * grow, B.size * 0.5 - 8, bw * grow, 8);
    ctx.fillRect((-bw / 2) * grow, -B.size * 0.5, bw * grow, 4);
    if (!hv.reduceFlash && u < B.inMs * 1.6 && grow > 0.3) {
      // the white streak runs across the band as it is NOW (it grows in): never outside it (QA F22)
      const p = u / (B.inMs * 1.6);
      const bwG = bw * grow;
      const sw = 60 * grow;
      ctx.globalAlpha = 0.7 * (1 - p);
      ctx.fillStyle = COLORS.white;
      ctx.fillRect(-bwG / 2 + (bwG - sw) * p, -B.size * 0.5, sw, B.size);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    if (banner.sprite) {
      const s = banner.sprite;
      ctx.globalAlpha = a;
      ctx.drawImage(s.canvas, cx - s.ax * scale, cy - s.ay * scale, s.w * scale, s.h * scale);
      ctx.globalAlpha = 1;
    } else {
      drawText(ctx, banner.text ?? '', cx, cy, O('banner110', B.size, 'center', 'banner', undefined, a, BANNER_TINT[banner.key] ?? 'gold'));
    }
  }

  function drawSmoked(ctx, hv) {
    const S = L.smoked;
    let text = null;
    for (const s of smoked) {
      if (!s.alive) continue;
      if (text === null) text = tx(hv, 'hud.banner.smoked');
      const u = s.age;
      const p = clamp01(u / 160);
      const scale = hv.reduceMotion ? 1 : 1.25 - 0.25 * easeOutBackK(p, 2.4);
      const a = u < S.holdMs ? Math.min(1, u / 80) : 1 - (u - S.holdMs) / 300;
      // it rises with its popup (the same curve as the world's popup), so the two stay one block
      const yy = s.y - (hv.reduceMotion ? 0 : C.fx.popupRisePx * easeOutCubic(clamp01(u / C.fx.popupMs)));
      const x = s.x;
      const fg = fontsGeneration();
      if (createCanvas && (smokedFor !== text || smokedGen !== fg)) {
        // keyed on the fonts generation too: a SMOKED! baked before the web font arrived is baked again (code review R-07)
        smokedSprite = bakeTextSprite(createCanvas, `hud-smoked|${text}|${fg}`, text, { style: 'banner84', size: S.size, look: 'banner', tint: 'orange', density: 2 });
        smokedFor = text;
        smokedGen = fg;
      }
      const sprite = smokedSprite;
      if (sprite) {
        ctx.globalAlpha = Math.max(0, a);
        ctx.drawImage(sprite.canvas, x - sprite.ax * scale, yy - sprite.ay * scale, sprite.w * scale, sprite.h * scale);
        ctx.globalAlpha = 1;
      } else {
        drawText(ctx, text, x, yy, O('banner84', S.size, 'center', 'banner', undefined, Math.max(0, a), 'orange'));
      }
    }
  }

  function drawCard(ctx, hv) {
    const K = L.card;
    if (cardAge === Infinity) return;
    let a = 1;
    let dx = 0;
    if (cardAge < K.inMs) {
      const p = easeOutCubic(cardAge / K.inMs);
      if (hv.reduceMotion) a = p;
      else dx = (1 - p) * -FIELD.w * 0.7;
    }
    if (cardOut !== Infinity) {
      const p = clamp01(cardOut / K.outMs);
      if (p >= 1) {
        cardAge = Infinity;
        cardOut = Infinity;
        return;
      }
      if (hv.reduceMotion) a *= 1 - p;
      else dx += easeInCubic(p) * FIELD.w * 0.7;
    }
    const cx = FIELD.cx + dx;
    const top = K.y - K.h / 2;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, top);
    ctx.transform(1, 0, -0.12, 1, 0, 0);
    ctx.fillStyle = COLORS.slate;
    ctx.globalAlpha = 0.82 * a;
    ctx.fillRect(-K.w / 2, 0, K.w, K.h);
    ctx.globalAlpha = a;
    ctx.fillStyle = COLORS.orange;
    ctx.fillRect(-K.w / 2, 0, K.w, 10);
    ctx.fillRect(-K.w / 2, K.h - 10, K.w, 10);
    ctx.fillStyle = COLORS.gold;
    ctx.fillRect(-K.w / 2 - 28, 0, 16, K.h);
    ctx.restore();
    const title = tx(hv, 'hud.stageCard.title', 'n', cardStage.n);
    const name = tx(hv, 'hud.stageCard.name', 'name', cardStage.name);
    drawText(ctx, title, cx, top + 120, O('banner110', 104, 'center', 'banner', undefined, a, 'gold'));
    const font = fontString('stageCard', 120);
    const size = fitText(ctx, name, font, K.w - 80, 60, 0.05);
    drawText(ctx, name, cx, top + 250, O('stageCard', size, 'center', 'banner', undefined, a, 'cream'));
    // the wind of the new stage (design 7.1, QA F10): sock, an arrow downwind, the speed. ("Best so far" is not in hv: not drawn.)
    const wx = cardStage.windX;
    const speed = Math.abs(wx);
    const wy = top + K.h - 44;
    const label = tx(hv, 'hud.wind', 'speed', windString(speed));
    const wfont = fontString('hudInfo', 44);
    if (ctx.font !== wfont) ctx.font = wfont;
    const tw = ctx.measureText(label).width;
    const arrowW = speed > 0.05 ? 70 : 0;
    const total = 64 + 18 + arrowW + (arrowW ? 18 : 0) + tw;
    let x = cx - total / 2;
    sprites.drawIcon(ctx, 'icon_wind', x + 32, wy - 14, 58, a, 0, wx < 0);
    x += 64 + 18;
    if (arrowW) {
      const dir = wx < 0 ? -1 : 1;
      const x0 = dir > 0 ? x : x + arrowW;
      const x1 = dir > 0 ? x + arrowW : x;
      ctx.globalAlpha = a;
      ctx.strokeStyle = COLORS.goldLight;
      ctx.fillStyle = COLORS.goldLight;
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, wy - 14);
      ctx.lineTo(x1 - dir * 14, wy - 14);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, wy - 14);
      ctx.lineTo(x1 - dir * 22, wy - 28);
      ctx.lineTo(x1 - dir * 22, wy);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      x += arrowW + 18;
    }
    drawText(ctx, label, x, wy, O('hudInfo', 44, 'left', 'label', COLORS.cream, a));
  }

  function drawPrompt(ctx, hv, labels) {
    const P = L.prompt;
    const fire = labels && typeof labels.fire === 'string' ? labels.fire : 'ZR';
    const text = tx(hv, 'hud.pullPrompt', 'fire', fire);
    const urgent = readyAge > 6000;
    const beat = hv.reduceMotion ? 0 : 0.5 + 0.5 * Math.sin(readyAge * (urgent ? 0.012 : 0.006));
    const font = fontString('hudInfo', P.size);
    if (ctx.font !== font) ctx.font = font;
    const w = ctx.measureText(text).width + 120;
    const a = clamp01(readyAge / 250);
    const scale = 1 + 0.035 * beat;
    ctx.save();
    ctx.translate(FIELD.cx, P.y);
    ctx.scale(scale, scale);
    roundRectPath(ctx, -w / 2, -P.size * 0.95, w, P.size * 1.5, P.size * 0.75);
    ctx.globalAlpha = (urgent ? 0.85 : 0.62) * a;
    ctx.fillStyle = urgent ? COLORS.orangeDeep : COLORS.slate;
    ctx.fill();
    ctx.globalAlpha = (0.5 + 0.5 * beat) * a;
    ctx.lineWidth = 4;
    ctx.strokeStyle = COLORS.gold;
    ctx.stroke();
    ctx.restore();
    drawText(ctx, text, FIELD.cx, P.y + P.size * 0.12, O('hudInfo', Math.round(P.size * scale), 'center', 'label', COLORS.cream, a));
  }

  // ---- public draw
  function draw(ctx, snapshot, hv) {
    if (!ctx || !snapshot || !hv || typeof hv.t !== 'function') return;
    nowMs = num(hv.nowMs, nowMs);
    mode = snapshot.mode ?? '';
    scoreTarget = Math.max(0, num(snapshot.score, 0));
    if (snapshot.phase !== phase) {
      if (snapshot.phase === 'ready') readyAge = 0;
      if (snapshot.phase === 'stageCard') {
        cardAge = 0;
        cardOut = Infinity;
        const st = snapshot.stage;
        if (st) {
          cardStage.n = num(st.index, 0) + 1;
          cardStage.name = String(st.name ?? '');
        }
        if (snapshot.wind) cardStage.windX = num(snapshot.wind.x, cardStage.windX);
      } else if (phase === 'stageCard' && cardAge !== Infinity) {
        cardOut = 0;
      }
      phase = snapshot.phase;
    }
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (mode !== 'practice' && mode !== 'zen') drawScore(ctx, snapshot, hv); // Zen keeps no score (design 7.3)
    drawTopCentre(ctx, snapshot, hv);
    drawWind(ctx, snapshot, hv);
    drawShells(ctx, snapshot, hv);
    if (mode !== 'zen' && mode !== 'practice') drawTally(ctx);
    drawBattery(ctx, hv);
    drawSmoked(ctx, hv);
    drawBanner(ctx, hv);
    drawCard(ctx, hv);
    if (phase === 'ready') drawPrompt(ctx, hv, hv.labels);
    ctx.restore();
  }

  function reset() {
    scoreShown = 0;
    scoreTarget = 0;
    scoreStrFor = -1;
    ringPulse = Infinity;
    insertAge = Infinity;
    dryAge = Infinity;
    tickAge = Infinity;
    bonusAge = Infinity;
    phase = '';
    readyAge = 0;
    cardAge = Infinity;
    cardOut = Infinity;
    queue.length = 0;
    banner.age = Infinity;
    labels.clear();
    topStage.index = 0;
    topStage.name = '';
    for (const s of smoked) s.alive = false;
    tallyCount = 0;
    zenCount = 0;
    zenPos = 0;
  }

  return {
    reset,
    handleEvents,
    update,
    draw,
    showBanner,
    getDebug: () => ({ banner: banner.age === Infinity ? null : banner.key, queued: queue.length, tally: tallyCount, card: cardAge !== Infinity, phase }),
  };
}
