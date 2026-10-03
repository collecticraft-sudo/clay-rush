// World renderer of Clay Rush (architecture 6.1): the whole world pass in playfield coordinates. OWNER: Render & Audio engineer.
//
// Draw order (design 2): far layer (parallax with the aim and the recoil), houses (far first), targets and shards (far first), break dust,
// powder rings and chips, near layer, pellet clouds, muzzle smoke and flash, points popups, the gun (bottom right, follows the aim a little,
// recoil kick, opens after a pull), ejected shell casings, the crosshair. Camera shake and the kill-cam zoom apply to the whole pass; the
// kill-cam letterbox and vignette are drawn over it in field space.
//
// Effects are driven by GameEvents (handleEvents) and advanced by update(dtS, view): world-time effects (shards, chips, dust, smoke) run on
// dt x snapshot.timeScale (so they hang in the kill cam's slow motion and freeze in a hit stop); the gun, the shake, the crosshair bloom,
// the flashes and the popups run on real time. Every effect has a Reduce motion twin (no shake, no zoom, no parallax, no drift; the kill
// cam becomes an 80 ms still flash) and a Reduce flashes twin (no bright full-field flash; the muzzle and hit flashes and the additive glow
// are drawn at a low alpha).
//
// Performance: every pool is allocated at construction with a hard cap (ART_CONFIG.fx.caps) and recycles its oldest member; sprites are
// cached per size bucket (sprites.js); no object, array, closure or string is created per frame on the hot path (the points popup text is
// baked once per hit event). Randomness is a seeded stream (reset() reseeds it), so the same events give the same picture.

import { ART_CONFIG } from './art-config.js';
import { NULL_ASSETS } from './assets.js';
import { COLORS, CROSSHAIR_COLORS } from './palette.js';
import { bakeTextSprite } from './draw-util.js';
import { easeInOutSine, easeOutCubic } from './ease.js';
import { ObjectPool, ParticlePool } from './fx.js';
import { createLabelStack, hitLabelSpec } from './label-layout.js';
import { createSprites } from './sprites.js';
import { createStage, STAGE_IDS } from './stage.js';
import { FIELD } from '../shared/playfield.js';
import { WORLD, project } from '../shared/world.js';
import { mulberry32 } from '../shared/rng.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Sprite of each Target.frame. */
export const FRAME_SPRITE = Object.freeze({ tilt: 'clay_std_tilt', below: 'clay_std_below', edge: 'clay_std_edge', rabbit: 'clay_rabbit', gold: 'clay_gold_tilt' });
const STD_SHARDS = Object.freeze(['shard_std_1', 'shard_std_2', 'shard_std_3', 'shard_std_4', 'shard_std_5', 'shard_std_6']);
const DEFAULT_MUZZLE = Object.freeze({ x: 0.05, y: 0.045 });
const DEFAULT_BODY = Object.freeze({ cx: 128, cy: 128, r: 104 });
/** Hermite smoothstep of x between e0 and e1 (0 below, 1 above). */
const smoothstep = (e0, e1, x) => {
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
};
const GOLD_SHARDS = Object.freeze(['shard_gold_1', 'shard_gold_2']);

/** Particle kinds of the pool. */
export const PK = Object.freeze({ PELLET: 0, CHIP: 1, SPARKLE: 2, EMBER: 3 });
/** Sprite effect kinds. */
const SK = Object.freeze({ SMOKE: 0, DUST: 1, HITFLASH: 2, GROUNDPUFF: 3 });
/** Chip colours (index stored in the particle's colour byte). */
const CHIP_COLORS = Object.freeze(['#F26B1D', '#FF9A52', '#C2480C', '#2B3036', '#F2C230', '#FFE58A', '#C88D16']);

/**
 * @param {{assets?:object, createCanvas?:(w:number,h:number)=>any, config?:object}} [opts]
 */
export function createWorldRenderer(opts = {}) {
  const assets = opts.assets ?? NULL_ASSETS;
  const createCanvas = typeof opts.createCanvas === 'function' ? opts.createCanvas : null;
  const C = opts.config ?? ART_CONFIG;
  const FX = C.fx;
  const GUN = C.gun;
  const XH = C.crosshair;
  const TG = C.targets;
  const HS = C.houses;
  const ST = C.stage;

  const sprites = createSprites({ assets, createCanvas, density: C.density, config: C });
  const stage = createStage({ assets, createCanvas, config: C });

  // ---------------------------------------------------------------------------------------------------------------------- pools
  const parts = new ParticlePool(FX.caps.particles, 8);
  const shards = new ObjectPool(FX.caps.shards, () => ({ x: 0, y: 0, vx: 0, vy: 0, rot: 0, spin: 0, age: 0, dur: 1, scale: 1, bucket: 1, g: 0, id: '' }));
  const fxs = new ObjectPool(FX.caps.sprites, () => ({ kind: 0, x: 0, y: 0, vx: 0, vy: 0, age: 0, dur: 1, size: 1, rot: 0, alpha: 1, grow: 1 }));
  const rings = new ObjectPool(FX.caps.rings, () => ({ x: 0, y: 0, age: 0, dur: 1, delay: 0, r0: 1, r1: 2, w0: 4, alpha: 1, color: '' }));
  const popups = new ObjectPool(FX.caps.popups, () => ({ x: 0, y: 0, age: 0, dur: 1, sprite: null, big: false }));
  const casings = new ObjectPool(FX.caps.casings, () => ({ x: 0, y: 0, vx: 0, vy: 0, rot: 0, spin: 0, age: 0, dur: 1 }));
  const pools = [shards, fxs, rings, popups, casings];
  const labels = createLabelStack(C);

  // ---------------------------------------------------------------------------------------------------------------------- state
  let rnd = mulberry32(0x0c1a7);
  const settings = { reduceMotion: false, reduceFlash: false, crosshairColor: 'white' };
  const aim = { x: FIELD.cx, y: FIELD.cy, visible: false };
  let nowMs = 0;
  let stageId = null;
  // gun
  const gun = { x: 0, y: 0, rot: 0, scale: 1, muzzleX: 0, muzzleY: 0, barrelAng: 0, show: 0, followX: 0, followY: 0, followRot: 0, kick: 0, slide: 0, slideX: 0, slideY: 0, alpha: 1 };
  let recoilAge = Infinity; // ms since the last shot
  let dryAge = Infinity;
  let openAge = Infinity; // ms since the gun started to open
  let openPending = 0; // casings still to eject when the open completes
  let holdOpen = false; // stays open until reload done (Classic)
  let holdAge = 0;
  let shotsSinceOpen = 0;
  let flashAge = Infinity;
  let bloomAge = Infinity;
  // camera
  let shakeAge = Infinity;
  let shakeAmp = 0;
  let shakeDur = 1;
  let shakeX = 0;
  let shakeY = 0;
  let shakeSide = 1;
  let airborne = 0; // clays in the air at the last update (the shake is softer while one flies)
  let zoom = 1;
  let zoomX = FIELD.cx;
  let zoomY = FIELD.cy;
  const kill = { active: false, age: 0, dur: 450, x: 0, y: 0, scale: 1.12 };
  let stillAge = Infinity;
  let hitStopLeft = 0;
  // idle
  const ambient = { active: false, age: 0, dur: 3, x0: 0, y0: 0, vx: 0, vy: 0, g: 0, r: 18, rot: 0, spin: 0, frame: 'clay_std_tilt' };
  let ambientWait = 2;
  let sparkleClock = 0;
  let windPx = 0;
  let crossAlpha = 0;
  // difficulty view: the backdrop zoom of snapshot.worldScale, eased
  let viewZoom = 1;
  // prewarm of the clay size buckets (re-queued when the art changes)
  let warmGen = -1;
  let prefetched = null;
  const WARM_IDS = Object.freeze(['clay_std_tilt', 'clay_std_below', 'clay_gold_tilt', 'clay_rabbit']);
  // scratch objects (no allocation per frame)
  const P1 = { sx: 0, sy: 0, s: 0, visible: false };
  const P2 = { sx: 0, sy: 0, s: 0, visible: false };
  const SV = { nowMs: 0, farX: 0, farY: 0, nearX: 0, nearY: 0, reduceMotion: false, zoom: 1 };
  const order = new Int16Array(64);
  const drawn = [];
  for (let i = 0; i < 16; i++) drawn.push({ id: 0, x: 0, y: 0, w: 0, h: 0, rot: 0, a: '', b: '', wB: 0 });
  let drawnCount = 0;
  const zs = new Float32Array(64);

  // ------------------------------------------------------------------------------------------------------------------- helpers
  const rr = (a, b) => a + (b - a) * rnd();
  /** The backdrop zoom of the difficulty: worldScale k ^ -zoomExp, clamped (1 on menus or without a scale). */
  function viewZoomFor(snap, idle) {
    if (idle || !snap) return 1;
    const k = num(snap.worldScale, 1);
    if (!(k > 0)) return 1;
    return clamp(Math.pow(k, -ST.zoomExp), ST.zoomMin, ST.zoomMax);
  }
  const reduceMotion = () => settings.reduceMotion === true;
  const reduceFlash = () => settings.reduceFlash === true;

  function readSettings(view) {
    const s = view && view.settings;
    if (!s) return;
    settings.reduceMotion = !!s.reduceMotion;
    settings.reduceFlash = !!s.reduceFlash;
    settings.crosshairColor = s.crosshairColor ?? 'white';
  }

  function shake(px, ms) {
    if (reduceMotion()) return;
    // the clay being shot is still in the last snapshot: softer only when ANOTHER one flies
    const amp = airborne > 1 ? px * FX.shakeAirborneK : px;
    if (shakeAge < shakeDur) return; // a bump already running keeps going (restarting it mid-way would be a jump)
    shakeAmp = amp;
    shakeDur = ms;
    shakeAge = 0;
    shakeSide = -shakeSide;
  }

  /** Depth factor of an effect: 1 for a clay of radius 34 px (about 20 m), smaller far away, capped. */
  const depthK = (rPx) => clamp(rPx / FX.depthRefPx, 0.6, 1.9);

  // ---------------------------------------------------------------------------------------------------------------- spawners
  function spawnPellets(x, y) {
    const n = FX.pellets;
    const spread = FX.pelletSpreadPx;
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU;
      const d = Math.sqrt(rnd()) * spread;
      parts.spawn(PK.PELLET, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.85, 0, 0, FX.pelletMs / 1000, FX.pelletR * rr(0.75, 1.3), 0, 0, 0);
    }
  }

  function spawnSmoke(x, y, ang, k = 1) {
    const s = fxs.take();
    s.kind = SK.SMOKE;
    s.x = x;
    s.y = y;
    s.vx = Math.cos(ang) * 70 * k;
    s.vy = Math.sin(ang) * 70 * k - FX.smokeRisePxS;
    s.age = 0;
    s.dur = FX.smokeMs * rr(0.85, 1.15);
    s.size = FX.smokePx * k * rr(0.85, 1.15);
    s.rot = rnd() * TAU;
    s.alpha = 0.6;
    s.grow = 1.9;
  }

  function spawnDust(kind, x, y, size, ms, alpha) {
    const s = fxs.take();
    s.kind = kind;
    s.x = x;
    s.y = y;
    s.vx = 0;
    s.vy = kind === SK.GROUNDPUFF ? -20 : -12;
    s.age = 0;
    s.dur = ms;
    s.size = size;
    s.rot = rnd() * TAU;
    s.alpha = alpha;
    s.grow = kind === SK.HITFLASH ? 1.3 : 1.6;
  }

  function spawnRing(x, y, r0, r1, w0, ms, color, alpha, delay = 0) {
    const r = rings.take();
    r.x = x;
    r.y = y;
    r.r0 = r0;
    r.r1 = r1;
    r.w0 = w0;
    r.age = 0;
    r.dur = ms;
    r.delay = delay;
    r.color = color;
    r.alpha = alpha;
  }

  /** The points popup of a break, placed by the label stack (never on top of another label, inside the field, below the banner strip). */
  function spawnPopup(ev) {
    const spec = hitLabelSpec(ev);
    if (!spec) return;
    const pos = labels.place(spec, nowMs); // placed even without a canvas, so the HUD's twin stack stays in step
    if (!createCanvas) return;
    const big = spec.big;
    const text = `+${spec.points}`;
    const sprite = bakeTextSprite(createCanvas, `world-popup|${text}|${big ? 1 : 0}`, text, {
      style: 'popup64', size: big ? FX.popupSizeBig : FX.popupSize, look: big ? 'banner' : 'popup', tint: 'gold', density: 2,
    });
    if (!sprite) return;
    const p = popups.take();
    p.x = pos.x;
    p.y = pos.y;
    p.age = 0;
    p.dur = FX.popupMs;
    p.sprite = sprite;
    p.big = big;
  }

  function spawnCasing() {
    const c = casings.take();
    const m = sprites.meta('gun_ou');
    const w = m ? m.width : 689;
    const h = m ? m.height : 800;
    // breech of the gun in field px (the gun's pose of the last frame)
    const bx = (GUN.breechX * w - w) * gun.scale;
    const by = (GUN.breechY * h - h) * gun.scale;
    const cs = Math.cos(gun.rot);
    const sn = Math.sin(gun.rot);
    c.x = gun.x + bx * cs - by * sn;
    c.y = gun.y + bx * sn + by * cs;
    c.vx = rr(FX.casingVx[0], FX.casingVx[1]);
    c.vy = rr(FX.casingVy[0], FX.casingVy[1]);
    c.rot = rnd() * TAU;
    c.spin = rr(-1, 1) * FX.casingSpin;
    c.age = 0;
    c.dur = FX.casingS * 1000;
  }

  function breakClay(ev) {
    const r = Math.max(6, num(ev.rPx, 30));
    const k = depthK(r);
    const gold = ev.kind === 'gold';
    const big = !!ev.centre || gold;
    const seeded = mulberry32((ev.shardSeed | 0) ^ 0x51ed);
    const n = big ? FX.shardsMax : FX.shardsMin + Math.floor(seeded() * (FX.shardsMax - FX.shardsMin + 1));
    const vx0 = num(ev.vx, 0) * FX.shardInherit;
    const vy0 = num(ev.vy, 0) * FX.shardInherit;
    const burst = big ? FX.centreBurstK : 1;
    for (let i = 0; i < n; i++) {
      const s = shards.take();
      const a = (i / n) * TAU + seeded() * 0.9;
      const sp = (FX.shardSpeed[0] + (FX.shardSpeed[1] - FX.shardSpeed[0]) * seeded()) * k * burst;
      s.x = ev.x + Math.cos(a) * r * 0.3;
      s.y = ev.y + Math.sin(a) * r * 0.3;
      s.vx = vx0 + Math.cos(a) * sp;
      s.vy = vy0 + Math.sin(a) * sp - 120 * k;
      s.rot = seeded() * TAU;
      s.spin = (seeded() * 2 - 1) * FX.shardSpin;
      s.age = 0;
      s.dur = FX.shardS * (0.85 + 0.3 * seeded());
      s.id = gold ? GOLD_SHARDS[i % GOLD_SHARDS.length] : STD_SHARDS[Math.floor(seeded() * STD_SHARDS.length)];
      // a shard picture is ~100 px of a 128 px canvas for a clay of radius ~105 px: scale it with the clay
      s.bucket = (r * 2 * FX.shardSizeK) / 100;
      s.scale = s.bucket * (0.6 + 0.6 * seeded());
      s.bucket *= 1.2; // every shard of this hit shares the cached picture of the largest one
      s.g = FX.gravityPxS2 * clamp(k, 0.6, 1.4);
    }
    const chips = big ? FX.chipsCentre : FX.chips;
    for (let i = 0; i < chips; i++) {
      const a = rnd() * TAU;
      const sp = rr(120, 640) * k * burst;
      const col = gold ? 4 + (i % 3) : i % 4;
      parts.spawn(PK.CHIP, ev.x, ev.y, vx0 + Math.cos(a) * sp, vy0 + Math.sin(a) * sp - 80 * k, FX.chipS * rr(0.6, 1.2), rr(2, 5.5) * k, col, 1, 0.6, rnd() * TAU, rr(-18, 18));
    }
    // dust burst, powder ring, hit flash
    spawnDust(SK.DUST, ev.x, ev.y, FX.dustK * r * 2 * (big ? 1.5 : 1), FX.dustMs * (big ? 1.25 : 1), 0.85);
    spawnRing(ev.x, ev.y, r * 0.9, r * FX.ringK * (big ? 1.4 : 1), 11 * k, FX.ringMs, gold ? COLORS.gold : COLORS.orange, 0.9);
    if (big) spawnRing(ev.x, ev.y, r * 0.6, r * FX.ringK * 1.9, 6 * k, FX.ringMs * 1.3, COLORS.creamLight, 0.75, 50);
    spawnDust(SK.HITFLASH, ev.x, ev.y, FX.hitFlashK * r * 2 * (big ? 1.3 : 1), FX.hitFlashMs, reduceFlash() ? FX.flashReducedAlpha : 1);
    if (big) {
      for (let i = 0; i < FX.sparkles; i++) {
        const a = rnd() * TAU;
        const sp = rr(140, 520) * k;
        parts.spawn(PK.SPARKLE, ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, FX.sparkleS * rr(0.6, 1.1), rr(14, 30) * k, gold ? 1 : 0, 0.15, 2.2, 0, rr(-4, 4));
      }
      shake(FX.centreShakePx, FX.centreShakeMs);
    }
    spawnPopup(ev);
  }

  /** The gun opens and ejects `eject` spent hulls; `hold` keeps it open until the shells are in (reload done), at most holdOpenMaxMs. */
  function openGun(eject, hold = false) {
    openAge = 0;
    openPending = eject;
    holdOpen = hold;
    holdAge = 0;
  }

  // ---------------------------------------------------------------------------------------------------------------- events
  function handleEvents(events, evNowMs) {
    if (Number.isFinite(evNowMs)) nowMs = evNowMs;
    if (!events || !events.length) return;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || typeof ev.type !== 'string') continue;
      switch (ev.type) {
        case 'shot':
          recoilAge = 0;
          flashAge = 0;
          bloomAge = 0;
          shotsSinceOpen++;
          shake(FX.shakePx, FX.shakeMs);
          spawnPellets(num(ev.x, aim.x), num(ev.y, aim.y));
          spawnSmoke(gun.muzzleX, gun.muzzleY, gun.barrelAng, 1);
          spawnSmoke(gun.muzzleX, gun.muzzleY, gun.barrelAng, 0.7);
          break;
        case 'dryFire':
          dryAge = 0;
          break;
        case 'hit':
          breakClay(ev);
          break;
        case 'lost':
          if (ev.reason === 'ground') {
            const k = clamp((num(ev.y, 800) - WORLD.horizonY) / 300, 0.3, 1.5);
            spawnDust(SK.GROUNDPUFF, num(ev.x, FIELD.cx), num(ev.y, 800), FX.groundPuffPx * k * 2, FX.groundPuffMs, 0.8);
          }
          break;
        case 'phase':
          // Classic: the gun opens after the pull, ejects what was fired and stays open until the new shells are in (reload done)
          if (ev.phase === 'settle' && shotsSinceOpen > 0) {
            openGun(Math.min(2, shotsSinceOpen), true);
            shotsSinceOpen = 0;
          }
          break;
        case 'reload':
          // Time Attack refills between waves; Classic's reload start follows its settle, which already opened the gun (code review R-02):
          // open only when something was fired since, so no phantom hull ever flies (QA F26)
          if (ev.phase === 'start' && shotsSinceOpen > 0) {
            openGun(Math.min(2, shotsSinceOpen), false);
            shotsSinceOpen = 0;
          } else if (ev.phase === 'done') {
            holdOpen = false;
          }
          break;
        case 'ready':
          shotsSinceOpen = 0;
          break;
        case 'killCam':
          if (reduceMotion()) stillAge = 0;
          else {
            kill.active = true;
            kill.age = 0;
            kill.dur = Math.max(200, num(ev.durationMs, 450));
            kill.x = num(ev.x, FIELD.cx);
            kill.y = num(ev.y, FIELD.cy);
            kill.scale = clamp(num(ev.scale, 1.12), 1, 1.4);
          }
          break;
        case 'hitStop':
          if (!reduceMotion()) hitStopLeft = Math.min(FX.hitStopMaxMs, Math.max(0, num(ev.ms, 0)));
          break;
        case 'stageStart':
          if (typeof ev.id === 'string') setStage(ev.id);
          break;
        default:
          break;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------- update
  function updateGunPose(dt, view) {
    const m = sprites.meta('gun_ou');
    const w = m ? m.width : 689;
    const h = m ? m.height : 800;
    const mz = m && m.muzzle ? m.muzzle : DEFAULT_MUZZLE;
    gun.scale = GUN.heightPx / h;
    const ax = aim.x - FIELD.cx;
    const ay = aim.y - FIELD.cy;
    const baseX = FIELD.w + GUN.anchorDx;
    const baseY = FIELD.h + GUN.anchorDy;
    // muzzle offset from the pivot (bottom-right) at rest
    const mx = (mz.x * w - w) * gun.scale;
    const my = (mz.y * h - h) * gun.scale;
    const a0 = Math.atan2(my, mx);
    const tx = GUN.followX * ax;
    const ty = GUN.followY * ay;
    let turn = Math.atan2(aim.y - (baseY + ty), aim.x - (baseX + tx)) - a0;
    if (turn > Math.PI) turn -= TAU;
    if (turn < -Math.PI) turn += TAU;
    const tr = clamp(turn * GUN.turnK, -GUN.turnMaxDeg * DEG, GUN.turnMaxDeg * DEG);
    const k = GUN.followTauS > 0 ? 1 - Math.exp(-dt / GUN.followTauS) : 1;
    gun.followX += (tx - gun.followX) * k;
    gun.followY += (ty - gun.followY) * k;
    gun.followRot += (tr - gun.followRot) * k;
    // never over the crosshair: the slide back along the line from the crosshair that clears it (continuous in the aim, applied at once;
    // when less is needed it eases back)
    const px0 = baseX + gun.followX;
    const py0 = baseY + gun.followY;
    let dx = px0 - aim.x;
    let dy = py0 - aim.y;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const need = clearSlide(px0, py0, gun.followRot, dx, dy);
    const ks = GUN.slideTauS > 0 ? 1 - Math.exp(-dt / GUN.slideTauS) : 1;
    gun.slide = need >= gun.slide ? need : gun.slide + (need - gun.slide) * ks;
    gun.slideX = dx * gun.slide;
    gun.slideY = dy * gun.slide;
    // recoil: out in 15 % of the time, back with an ease-out
    let kick = 0;
    if (recoilAge < GUN.recoilMs) {
      const u = recoilAge / GUN.recoilMs;
      kick = u < 0.15 ? u / 0.15 : 1 - easeOutCubic((u - 0.15) / 0.85);
    }
    let twitch = 0;
    if (dryAge < GUN.dryMs) twitch = Math.sin((dryAge / GUN.dryMs) * Math.PI);
    // opening after a pull: dip and tilt, hold, close
    let open = 0;
    const openTotal = GUN.openMs + GUN.openHoldMs + GUN.closeMs;
    if (openAge < openTotal) {
      if (openAge < GUN.openMs) open = easeOutCubic(openAge / GUN.openMs);
      else if (openAge < GUN.openMs + GUN.openHoldMs) open = 1;
      else open = 1 - easeInOutSine((openAge - GUN.openMs - GUN.openHoldMs) / GUN.closeMs);
    }
    const back = GUN.recoilPx * kick + GUN.dryPx * twitch;
    const ux = -Math.cos(a0 + gun.followRot);
    const uy = -Math.sin(a0 + gun.followRot);
    const hide = (1 - easeOutCubic(gun.show)) * GUN.hideDy;
    const rm = reduceMotion() ? 0.5 : 1;
    gun.x = baseX + gun.followX + gun.slideX + ux * back * rm;
    gun.y = baseY + gun.followY + gun.slideY + uy * back * rm + GUN.openDipPx * open + hide;
    gun.rot = gun.followRot + GUN.recoilDeg * DEG * kick * rm + GUN.openDeg * DEG * open;
    const cs = Math.cos(gun.rot);
    const sn = Math.sin(gun.rot);
    gun.muzzleX = gun.x + mx * cs - my * sn;
    gun.muzzleY = gun.y + mx * sn + my * cs;
    gun.barrelAng = a0 + gun.rot;
    gun.kick = kick;
    // a target under the gun: the gun fades so the clay stays visible
    let covered = false;
    const snap = view && view.snapshot;
    if (snap && Array.isArray(snap.targets)) {
      for (let i = 0; i < snap.targets.length && !covered; i++) {
        const t = snap.targets[i];
        if (gunCovers(gun.x, gun.y, gun.rot, num(t.sx, -1e4), num(t.sy, -1e4), num(t.rPx, 0) + 6)) covered = true;
      }
    }
    const kf = GUN.fadeTauS > 0 ? 1 - Math.exp(-dt / GUN.fadeTauS) : 1;
    gun.alpha += ((covered ? GUN.coverAlpha : 1) - gun.alpha) * kf;
  }

  /**
   * True when the point (px, py) lies inside the gun's silhouette, or within `margin` px of it, for a gun with its pivot (bottom-right
   * anchor) at (gx, gy) turned by `rot`. Allocation free.
   */
  function gunCovers(gx, gy, rot, px, py, margin) {
    const m = sprites.meta('gun_ou');
    const ax = m ? m.anchor.x : 689;
    const ay = m ? m.anchor.y : 800;
    const sc = gun.scale;
    const c = Math.cos(-rot);
    const sn = Math.sin(-rot);
    const lx = px - gx;
    const ly = py - gy;
    const qx = (lx * c - ly * sn) / sc + ax; // the point in the picture's pixels
    const qy = (lx * sn + ly * c) / sc + ay;
    const P = GUN.silhouette;
    const mm = margin / sc;
    let inside = false;
    let near = false;
    const n = P.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = P[2 * i];
      const yi = P[2 * i + 1];
      const xj = P[2 * j];
      const yj = P[2 * j + 1];
      if ((yi > qy) !== (yj > qy) && qx < ((xj - xi) * (qy - yi)) / (yj - yi) + xi) inside = !inside;
      if (!near && mm > 0) {
        const ex = xj - xi;
        const ey = yj - yi;
        const L2 = ex * ex + ey * ey || 1;
        const u = clamp01(((qx - xi) * ex + (qy - yi) * ey) / L2);
        const ddx = xi + ex * u - qx;
        const ddy = yi + ey * u - qy;
        if (ddx * ddx + ddy * ddy < mm * mm) near = true;
      }
    }
    return inside || near;
  }

  /** The smallest slide (px, along (dx, dy)) that keeps the crosshair clearPx away from the gun's silhouette. */
  function clearSlide(px0, py0, rot, dx, dy) {
    const cover = (sl) => gunCovers(px0 + dx * sl, py0 + dy * sl, rot, aim.x, aim.y, GUN.clearPx);
    if (!cover(0)) return 0;
    let lo = 0;
    let hi = 40;
    while (cover(hi) && hi < 2400) {
      lo = hi;
      hi *= 1.6;
    }
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (cover(mid)) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  function update(dtS, view) {
    const dt = clamp(num(dtS, 0), 0, 0.1);
    readSettings(view);
    if (view) {
      nowMs = num(view.nowMs, nowMs + dt * 1000);
      if (view.aim) {
        // clamped to the field: an extrapolated aim head past the edge must not push the parallax past the layers' margins (R-05)
        aim.x = clamp(num(view.aim.x, aim.x), 0, FIELD.w);
        aim.y = clamp(num(view.aim.y, aim.y), 0, FIELD.h);
        aim.visible = !!view.aim.visible;
      }
      if (typeof view.stageId === 'string' && view.stageId !== stageId) setStage(view.stageId);
    }
    const snap = view && view.snapshot;
    const ms = dt * 1000;
    airborne = snap && Array.isArray(snap.targets) ? snap.targets.length : 0;
    // bake the clay size buckets ahead of time: a clay that shrinks through a bucket boundary must never pay a bake mid-flight
    const gen = assets && Number.isFinite(assets.generation) ? assets.generation : 0;
    if (gen !== warmGen) {
      warmGen = gen;
      for (const id of WARM_IDS) {
        const m = sprites.meta(id);
        const br = m && m.body ? m.body.r : DEFAULT_BODY.r;
        sprites.prewarm(id, TG.prewarmRPx[0] / br, TG.prewarmRPx[1] / br);
      }
    }
    sprites.pump(TG.prewarmPerFrame);
    // QA F4: in Classic the next stage's art is loaded during the current stage, so the stage change crossfades painting to painting
    if (snap && snap.stage && typeof snap.stage.id === 'string') {
      const i = STAGE_IDS.indexOf(snap.stage.id);
      const next = snap.mode === 'classic' && i >= 0 && num(snap.stage.index, 0) < num(snap.stage.count, 1) - 1 ? STAGE_IDS[i + 1] ?? null : null;
      if (next !== prefetched) {
        prefetched = next;
        stage.prefetch(next);
      } else if (next) stage.prefetch(next); // retried every frame while both resident slots are busy (cheap: a phase check)
    }
    // difficulty view: closer on Easy, wider on Hard (menus 1)
    const wantZoom = viewZoomFor(snap, view && view.idle);
    if (reduceMotion() || ST.zoomTauS <= 0) viewZoom = wantZoom;
    else viewZoom += (wantZoom - viewZoom) * (1 - Math.exp(-dt / ST.zoomTauS));
    if (Math.abs(viewZoom - wantZoom) < 1e-4) viewZoom = wantZoom;
    let ts = snap ? clamp(num(snap.timeScale, 1), 0, 1) : 1;
    if (hitStopLeft > 0) {
      hitStopLeft -= ms;
      ts = 0;
    }
    const dtw = dt * ts;
    windPx = snap && snap.wind ? (num(snap.wind.x, 0) + num(snap.wind.gust, 0)) * FX.windPxPerMs : 0;
    // real-time clocks
    recoilAge += ms;
    dryAge += ms;
    flashAge += ms;
    bloomAge += ms;
    shakeAge += ms;
    stillAge += ms;
    const wasOpen = openAge;
    openAge += ms;
    if (holdOpen) {
      holdAge += ms;
      const held = GUN.openMs + GUN.openHoldMs;
      if (holdAge > GUN.holdOpenMaxMs) holdOpen = false;
      else if (openAge > held) openAge = held;
    }
    if (openPending > 0 && wasOpen < GUN.openMs && openAge >= GUN.openMs) {
      for (let i = 0; i < openPending; i++) spawnCasing();
      openPending = 0;
    }
    const showGun = !!(view && view.showGun) && !(view && view.idle);
    gun.show = clamp01(gun.show + (showGun ? 1 : -1) * (ms / GUN.showMs));
    updateGunPose(dt, view);
    const showX = !!(view && view.showCrosshair) && aim.visible && !(view && view.idle);
    crossAlpha = clamp01(crossAlpha + (showX ? 1 : -1) * (ms / XH.hiddenFadeMs));
    // camera
    if (shakeAge < shakeDur && !reduceMotion()) {
      const b = 0.5 * (1 - Math.cos((shakeAge / shakeDur) * TAU)); // 0 -> 1 -> 0 with zero speed at both ends
      shakeX = shakeAmp * FX.shakeSideK * shakeSide * b;
      shakeY = shakeAmp * b;
    } else {
      shakeX = 0;
      shakeY = 0;
    }
    if (kill.active) {
      kill.age += ms;
      if (kill.age >= kill.dur || reduceMotion()) {
        kill.active = false;
        zoom = 1;
      } else {
        const zin = clamp01(kill.age / FX.killCamInMs);
        const zout = clamp01((kill.dur - kill.age) / FX.killCamOutMs);
        const k = easeOutCubic(Math.min(zin, zout));
        zoom = 1 + (kill.scale - 1) * k;
        zoomX = kill.x;
        zoomY = kill.y;
      }
    } else {
      zoom = 1;
    }
    // world-time effects
    parts.update(dtw, FX.gravityPxS2, FIELD.h + 60);
    for (const s of shards.items) {
      if (!s.alive) continue;
      s.age += dtw;
      if (s.age >= s.dur) {
        s.alive = false;
        continue;
      }
      s.vx *= 1 - Math.min(1, 0.35 * dtw);
      s.vy += s.g * dtw;
      s.x += s.vx * dtw;
      s.y += s.vy * dtw;
      s.rot += s.spin * dtw;
      if (s.y > FIELD.h + 80) s.alive = false;
    }
    for (const f of fxs.items) {
      if (!f.alive) continue;
      const step = f.kind === SK.HITFLASH ? ms : dtw * 1000;
      f.age += step;
      if (f.age >= f.dur) {
        f.alive = false;
        continue;
      }
      const sd = step / 1000;
      f.x += (f.vx + (f.kind === SK.HITFLASH ? 0 : windPx)) * sd;
      f.y += f.vy * sd;
      f.vx *= 1 - Math.min(1, 1.6 * sd);
    }
    for (const r of rings.items) {
      if (!r.alive) continue;
      r.age += dtw * 1000;
      if (r.age >= r.dur + r.delay) r.alive = false;
    }
    for (const p of popups.items) {
      if (!p.alive) continue;
      p.age += ms;
      if (p.age >= p.dur) {
        p.alive = false;
        p.sprite = null;
      }
    }
    for (const c of casings.items) {
      if (!c.alive) continue;
      c.age += ms;
      const sd = dt;
      c.vy += FX.gravityPxS2 * 1.2 * sd;
      c.x += c.vx * sd;
      c.y += c.vy * sd;
      c.rot += c.spin * sd;
      if (c.age >= c.dur || c.y > FIELD.h + 120) c.alive = false;
    }
    // gold sparkle trail
    if (snap && snap.targets && snap.targets.length) {
      sparkleClock += dtw;
      if (sparkleClock >= TG.sparkleEveryS) {
        sparkleClock = 0;
        for (let i = 0; i < snap.targets.length; i++) {
          const t = snap.targets[i];
          if (t.kind !== 'gold') continue;
          const a = rnd() * TAU;
          parts.spawn(PK.SPARKLE, t.sx + Math.cos(a) * t.rPx, t.sy + Math.sin(a) * t.rPx * 0.6, rr(-30, 30), rr(-60, 10), 0.55, rr(10, 20) * depthK(t.rPx), 1, 0, 1.5, 0, 3);
        }
      }
    }
    // ambient clay of the menu backdrop
    if (view && view.idle) {
      if (ambient.active) {
        ambient.age += dt;
        ambient.rot += ambient.spin * dt;
        if (ambient.age >= ambient.dur) ambient.active = false;
      } else {
        ambientWait -= dt;
        if (ambientWait <= 0) {
          ambientWait = rr(FX.ambientMinS, FX.ambientMaxS);
          const fromLeft = rnd() < 0.5;
          ambient.active = true;
          ambient.age = 0;
          ambient.dur = FX.ambientFlightS * rr(0.85, 1.15);
          ambient.x0 = fromLeft ? rr(-60, 200) : rr(FIELD.w - 200, FIELD.w + 60);
          ambient.y0 = rr(560, 650);
          ambient.vx = (fromLeft ? 1 : -1) * rr(380, 560);
          ambient.vy = rr(-330, -250);
          ambient.g = rr(110, 150);
          ambient.r = rr(15, 24);
          ambient.rot = rr(-0.3, 0.3);
          ambient.spin = rr(-0.6, 0.6);
          ambient.frame = rnd() < 0.8 ? 'clay_std_tilt' : 'clay_std_below';
        }
      }
    } else {
      ambient.active = false;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------- drawing
  function drawHouses(ctx, houses, ox, oy) {
    for (let i = 0; i < houses.length; i++) {
      const h = houses[i];
      if (!h || !h.sprite) continue;
      const m = sprites.meta(h.sprite);
      if (!m) continue;
      const cb = m.contentBox;
      const widthM = HS.widthM[h.sprite] ?? 3;
      const scale = (widthM * num(h.scale, 0)) / cb.w;
      if (!(scale > 0)) continue;
      const x = num(h.sx, 0) + ox;
      const y = num(h.sy, 0) + oy;
      sprites.draw(ctx, h.sprite, x, y, scale, 0, 1, m.anchor.x, m.anchor.y, !!h.mirrored);
      // a puff of smoke at the door right after a launch
      const fs = num(h.flashS, 1e9);
      if (fs < HS.puffS) {
        const u = fs / HS.puffS;
        const door = HS.door[h.sprite];
        if (door) {
          const sx = h.mirrored ? -1 : 1;
          const dx = (cb.x + door.x * cb.w - m.anchor.x) * scale * sx;
          const dy = (cb.y + door.y * cb.h - m.anchor.y) * scale;
          const size = HS.puffM * num(h.scale, 0) * (0.5 + u);
          sprites.drawIcon(ctx, 'fx_smoke_puff', x + dx, y + dy - u * size * 0.3, size, (1 - u) * 0.75);
        }
      }
    }
  }

  /**
   * One clay, drawn CONTINUOUSLY (owner feedback: no frame swap may ever pop). The look depends only on continuous inputs: the interpolated
   * screen position (Target.sx/sy: the elevation of the line of sight), rPx and the cosmetic spin. The top view crossfades into the
   * underside view with the elevation, the disc flattens near the horizon (edge-on), the spin is a gentle wobble; sizes are exact (the
   * cached bitmap of the next larger bucket, drawn at the exact scale), positions sub-pixel. A record of what was drawn goes to getDebug().
   */
  function drawTarget(ctx, t) {
    const r = num(t.rPx, 0);
    if (!(r > 0.5)) return;
    const sx = num(t.sx, 0);
    const sy = num(t.sy, 0);
    const kind = t.kind;
    const rabbit = kind === 'rabbit';
    const baseId = rabbit ? 'clay_rabbit' : kind === 'gold' ? 'clay_gold_tilt' : 'clay_std_tilt';
    const m = sprites.meta(baseId);
    if (!m) return;
    const body = m.body ?? DEFAULT_BODY;
    // elevation of the line of sight in degrees, from the interpolated screen row: continuous frame to frame
    const elev = Math.atan2(WORLD.horizonY - sy, WORLD.F) / DEG;
    let wB = 0;
    let squash = 1;
    let rot = num(t.rot, 0);
    if (!rabbit) {
      if (kind !== 'gold') wB = smoothstep(TG.belowFromDeg, TG.belowToDeg, elev);
      squash = TG.edgeAspect + (1 - TG.edgeAspect) * smoothstep(TG.edgeFromDeg, TG.edgeToDeg, Math.abs(elev));
      if (kind === 'battue') squash *= TG.battueAspect;
      rot = TG.wobbleRad * Math.sin(rot);
    }
    const scale = r / body.r;
    // rabbit: a soft shadow on the ground
    if (rabbit) {
      project(t.x, 0, t.z, P1);
      if (P1.visible) {
        ctx.globalAlpha = TG.shadowAlpha;
        ctx.fillStyle = COLORS.slate;
        ctx.beginPath();
        ctx.ellipse(sx, P1.sy, r * TG.shadowR, r * TG.shadowR * 0.24, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // motion streak: from where the clay was streakS ago to where it is; its strength grows smoothly with the speed (no on/off threshold)
    project(t.x, t.y, t.z, P1);
    project(t.x - t.vx * TG.streakS, t.y - t.vy * TG.streakS, t.z - t.vz * TG.streakS, P2);
    if (P1.visible && P2.visible) {
      const bx = sx + (P2.sx - P1.sx);
      const by = sy + (P2.sy - P1.sy);
      const dx = sx - bx;
      const dy = sy - by;
      const len = Math.sqrt(dx * dx + dy * dy);
      const k = smoothstep(r * 0.3, r * 1.2, len);
      if (k > 0.002) {
        const nx = -dy / len;
        const ny = dx / len;
        const w = r * 0.7 * Math.max(squash, 0.5);
        ctx.globalAlpha = TG.streakAlpha * k;
        ctx.fillStyle = kind === 'gold' ? COLORS.goldLight : COLORS.creamLight;
        ctx.beginPath();
        ctx.moveTo(sx + nx * w, sy + ny * w);
        ctx.lineTo(bx, by);
        ctx.lineTo(sx - nx * w, sy - ny * w);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = TG.streakAlpha * 0.6 * k;
        ctx.beginPath();
        ctx.moveTo(sx + nx * w * 0.45, sy + ny * w * 0.45);
        ctx.lineTo(bx - dx * 0.35, by - dy * 0.35);
        ctx.lineTo(sx - nx * w * 0.45, sy - ny * w * 0.45);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    if (kind === 'gold' && !reduceFlash()) {
      const pulse = 0.85 + 0.15 * Math.sin(nowMs * 0.012);
      ctx.globalCompositeOperation = 'lighter';
      sprites.drawIcon(ctx, 'fx_glow_gold', sx, sy, r * TG.goldGlowR * 2 * pulse, TG.goldGlowAlpha);
      ctx.globalCompositeOperation = 'source-over';
    }
    // the top view, then the underside view over it by its weight (the top view fades out in the last third, so no silhouette lingers)
    const aBase = wB > 0 ? Math.min(1, 3 * (1 - wB)) : 1;
    sprites.drawSquashed(ctx, baseId, sx, sy, scale, rot, squash, aBase, body.cx, body.cy);
    let hB = 0;
    if (wB > 0.002) {
      const mb = sprites.meta('clay_std_below');
      const bb = mb && mb.body ? mb.body : DEFAULT_BODY;
      const sb = r / bb.r;
      sprites.drawSquashed(ctx, 'clay_std_below', sx, sy, sb, rot, squash, wB, bb.cx, bb.cy);
      hB = mb ? mb.contentBox.h * sb : 0;
    }
    // what was drawn (tests and test-support/render/smoothness.mjs): centre, the ellipse's width and height, rotation, frames and blend
    if (drawnCount < drawn.length) {
      const d = drawn[drawnCount++];
      const hA = m.contentBox.h * scale;
      d.id = t.id;
      // where it lands on screen: the camera shake and the kill-cam zoom included (they move every clay)
      d.x = zoomX + (sx - zoomX) * zoom + shakeX;
      d.y = zoomY + (sy - zoomY) * zoom + shakeY;
      d.w = m.contentBox.w * scale;
      d.h = (hA * (1 - wB) + (hB || hA) * wB) * squash;
      d.rot = rot;
      d.a = baseId;
      d.b = wB > 0.002 ? 'clay_std_below' : baseId;
      d.wB = wB;
    }
  }

  function drawTargets(ctx, list) {
    const n = Math.min(list.length, order.length);
    for (let i = 0; i < n; i++) {
      // insertion sort by depth, far first, into the reusable index array
      const z = num(list[i].z, 0);
      let j = i;
      while (j > 0 && zs[j - 1] < z) {
        zs[j] = zs[j - 1];
        order[j] = order[j - 1];
        j--;
      }
      zs[j] = z;
      order[j] = i;
    }
    drawnCount = 0;
    for (let i = 0; i < n; i++) drawTarget(ctx, list[order[i]]);
  }

  function drawAmbient(ctx) {
    if (!ambient.active) return;
    const t = ambient.age;
    const x = ambient.x0 + ambient.vx * t;
    const y = ambient.y0 + ambient.vy * t + 0.5 * ambient.g * t * t;
    const m = sprites.meta(ambient.frame);
    if (!m) return;
    const body = m.body ?? { cx: m.width / 2, cy: m.height / 2, r: m.width * 0.42 };
    const fade = clamp01(Math.min(t / 0.25, (ambient.dur - t) / 0.4));
    sprites.draw(ctx, ambient.frame, x, y, ambient.r / body.r, ambient.rot, fade, body.cx, body.cy);
  }

  function drawShards(ctx) {
    for (const s of shards.items) {
      if (!s.alive) continue;
      const u = s.age / s.dur;
      const a = u < FX.shardFadeFrom ? 1 : 1 - (u - FX.shardFadeFrom) / (1 - FX.shardFadeFrom);
      sprites.draw(ctx, s.id, s.x, s.y, s.scale, s.rot, a, undefined, undefined, false, s.bucket);
    }
  }

  function drawFxSprites(ctx, kindWanted) {
    for (const f of fxs.items) {
      if (!f.alive || f.kind !== kindWanted) continue;
      const u = f.age / f.dur;
      if (f.kind === SK.SMOKE) {
        const size = f.size * (0.45 + (f.grow - 0.45) * easeOutCubic(u));
        const a = f.alpha * (u < 0.1 ? u / 0.1 : 1 - (u - 0.1) / 0.9);
        sprites.drawIcon(ctx, 'fx_smoke_puff', f.x, f.y, size, a, f.rot + u * 0.6, false, f.size * f.grow);
      } else if (f.kind === SK.DUST || f.kind === SK.GROUNDPUFF) {
        const size = f.size * (0.55 + (f.grow - 0.55) * easeOutCubic(u));
        const a = f.alpha * (1 - u) * (1 - u * 0.3);
        sprites.drawIcon(ctx, 'fx_dust_burst', f.x, f.y, size, a, f.rot, false, f.size * f.grow);
      } else if (f.kind === SK.HITFLASH) {
        const size = f.size * (0.6 + 0.7 * easeOutCubic(u));
        ctx.globalCompositeOperation = 'lighter';
        sprites.drawIcon(ctx, 'fx_flash_star', f.x, f.y, size, f.alpha * (1 - u), f.rot, false, f.size * 1.3);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  function drawRings(ctx) {
    for (const r of rings.items) {
      if (!r.alive || r.age < r.delay) continue;
      const u = clamp01((r.age - r.delay) / r.dur);
      const e = easeOutCubic(u);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      ctx.globalAlpha = r.alpha * (1 - u);
      ctx.lineWidth = Math.max(0.8, r.w0 * (1 - e));
      ctx.strokeStyle = r.color;
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawParticles(ctx, kind) {
    const P = parts;
    if (P.kindCount[kind] === 0) return;
    if (kind === PK.PELLET) {
      ctx.fillStyle = COLORS.slate;
      for (let i = 0; i < P.capacity; i++) {
        if (!P.alive[i] || P.kind[i] !== kind) continue;
        const u = 1 - P.life[i] / P.maxLife[i];
        ctx.globalAlpha = 0.75 * (1 - u);
        ctx.beginPath();
        ctx.arc(P.x[i], P.y[i], P.size[i] * (1 + 0.5 * u), 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (kind === PK.CHIP) {
      for (let i = 0; i < P.capacity; i++) {
        if (!P.alive[i] || P.kind[i] !== kind) continue;
        const u = 1 - P.life[i] / P.maxLife[i];
        const s = P.size[i];
        const c = Math.cos(P.rot[i]) * s;
        const sn = Math.sin(P.rot[i]) * s;
        ctx.globalAlpha = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
        ctx.fillStyle = CHIP_COLORS[P.color[i]] ?? COLORS.orange;
        ctx.beginPath();
        ctx.moveTo(P.x[i] + c, P.y[i] + sn);
        ctx.lineTo(P.x[i] - sn * 0.8, P.y[i] + c * 0.8);
        ctx.lineTo(P.x[i] - c * 0.9, P.y[i] - sn * 0.6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (kind === PK.SPARKLE) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < P.capacity; i++) {
        if (!P.alive[i] || P.kind[i] !== kind) continue;
        const u = 1 - P.life[i] / P.maxLife[i];
        const tw = 0.6 + 0.4 * Math.sin(P.rot[i] * 3 + i);
        sprites.drawIcon(ctx, 'fx_sparkle', P.x[i], P.y[i], P.size[i] * (1 - 0.5 * u), (1 - u) * tw * (reduceFlash() ? 0.5 : 1), P.rot[i] * 0.2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawPopups(ctx) {
    for (const p of popups.items) {
      if (!p.alive || !p.sprite) continue;
      const u = p.age / p.dur;
      const still = reduceMotion(); // Reduce motion twin (code review R-04): no pop, no rise, a fade only
      const pop = !still && p.age < FX.popupPopMs ? 1.45 - 0.45 * easeOutCubic(p.age / FX.popupPopMs) : 1;
      const a = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
      const y = still ? p.y : p.y - FX.popupRisePx * easeOutCubic(u);
      const s = p.sprite;
      ctx.globalAlpha = a;
      ctx.drawImage(s.canvas, p.x - s.ax * pop, y - s.ay * pop, s.w * pop, s.h * pop);
    }
    ctx.globalAlpha = 1;
  }

  function drawMuzzle(ctx) {
    if (gun.show < 0.5) return;
    const rf = reduceFlash();
    if (flashAge < FX.glowMs) {
      const u = flashAge / FX.glowMs;
      ctx.globalCompositeOperation = 'lighter';
      sprites.drawIcon(ctx, 'fx_glow', gun.muzzleX, gun.muzzleY, FX.glowPx * (rf ? 0.5 : 1) * (0.8 + 0.4 * u), (rf ? FX.glowReducedAlpha : FX.glowAlpha) * (1 - u));
      ctx.globalCompositeOperation = 'source-over';
    }
    if (flashAge < FX.flashFrameMs * 2) {
      const a = rf ? FX.flashReducedAlpha : 1;
      const out = gun.barrelAng + Math.PI; // pointing away from the shooter
      ctx.globalCompositeOperation = 'lighter';
      if (flashAge < FX.flashFrameMs) {
        sprites.drawIcon(ctx, 'fx_flash_star', gun.muzzleX + Math.cos(out) * 30, gun.muzzleY + Math.sin(out) * 30, FX.flashPx * (rf ? 0.6 : 1), a, flashAge * 0.01);
      } else {
        sprites.drawIcon(ctx, 'fx_flash_side', gun.muzzleX + Math.cos(out) * 70, gun.muzzleY + Math.sin(out) * 70, FX.flashPx * 0.95 * (rf ? 0.6 : 1), a * 0.9, out);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawGun(ctx) {
    if (gun.show <= 0.01) return;
    if (!sprites.draw(ctx, 'gun_ou', gun.x, gun.y, gun.scale, gun.rot, gun.alpha)) return;
  }

  function drawCasings(ctx) {
    for (const c of casings.items) {
      if (!c.alive) continue;
      const a = c.age < c.dur * 0.8 ? 1 : 1 - (c.age - c.dur * 0.8) / (c.dur * 0.2);
      sprites.drawIcon(ctx, 'fx_shell_casing', c.x, c.y, FX.casingPx, a, c.rot);
    }
  }

  function drawCrosshair(ctx) {
    if (crossAlpha <= 0.01) return;
    let bloom = 0;
    if (bloomAge < XH.bloomMs) bloom = 1 - easeOutCubic(bloomAge / XH.bloomMs);
    const r = XH.r * (1 + (reduceMotion() ? 0 : (XH.bloomScale - 1) * bloom)); // Reduce motion: the ring never grows
    const x = aim.x;
    const y = aim.y;
    const dry = dryAge < 260;
    const color = dry ? COLORS.terracotta : CROSSHAIR_COLORS[settings.crosshairColor] ?? CROSSHAIR_COLORS.white;
    ctx.globalAlpha = crossAlpha;
    ctx.lineCap = 'round';
    // outline pass then colour pass: ring, four ticks, centre dot
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? XH.outlineColor : color;
      ctx.lineWidth = pass === 0 ? XH.outline : XH.ring;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      const a = r + 5;
      const b = r + 5 + XH.tick;
      ctx.moveTo(x + a, y);
      ctx.lineTo(x + b, y);
      ctx.moveTo(x - a, y);
      ctx.lineTo(x - b, y);
      ctx.moveTo(x, y + a);
      ctx.lineTo(x, y + b);
      ctx.moveTo(x, y - a);
      ctx.lineTo(x, y - b);
      ctx.stroke();
      ctx.fillStyle = pass === 0 ? XH.outlineColor : color;
      ctx.beginPath();
      ctx.arc(x, y, pass === 0 ? XH.dot + 2 : XH.dot, 0, TAU);
      ctx.fill();
    }
    if (bloom > 0 && !reduceFlash()) {
      ctx.globalAlpha = crossAlpha * bloom * 0.6;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.5, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawKillCamOverlay(ctx) {
    if (kill.active) {
      const zin = clamp01(kill.age / FX.killCamInMs);
      const zout = clamp01((kill.dur - kill.age) / FX.killCamOutMs);
      const k = easeOutCubic(Math.min(zin, zout));
      const vm = sprites.meta('fx_vignette');
      if (vm) sprites.draw(ctx, 'fx_vignette', 0, 0, FIELD.w / vm.width, 0, FX.vignetteAlpha * k, 0, 0);
      const bar = FX.letterboxPx * k;
      ctx.fillStyle = '#0B0C0E';
      ctx.fillRect(-10, -10, FIELD.w + 20, bar + 10);
      ctx.fillRect(-10, FIELD.h - bar, FIELD.w + 20, bar + 10);
    }
    if (stillAge < FX.stillFlashMs) {
      ctx.globalAlpha = (reduceFlash() ? FX.stillFlashReducedAlpha : FX.stillFlashAlpha) * (1 - stillAge / FX.stillFlashMs);
      ctx.fillStyle = COLORS.creamLight;
      ctx.fillRect(0, 0, FIELD.w, FIELD.h);
      ctx.globalAlpha = 1;
    }
  }

  function draw(ctx, view) {
    if (!ctx) return;
    readSettings(view);
    const rm = reduceMotion();
    const t = num(view && view.nowMs, nowMs);
    const snap = view && view.snapshot;
    const idle = !!(view && view.idle);
    if (view && typeof view.stageId === 'string' && view.stageId !== stageId) setStage(view.stageId);
    // parallax offsets: the layers move against the aim (far 0.6 %, near 2.5 % of the offset) and with the recoil kick
    let px = 0;
    let py = 0;
    if (!rm) {
      if (idle) {
        px = Math.sin((t / 1000 / ST.idleDriftPeriodS) * TAU) * ST.idleDriftPx / ST.parallaxNear;
        py = Math.sin((t / 1000 / ST.idleDriftPeriodS) * TAU * 0.5 + 1) * ST.idleDriftPx * 0.15 / ST.parallaxNear;
      } else if (aim.visible || (view && view.showGun)) {
        px = aim.x - FIELD.cx;
        py = aim.y - FIELD.cy;
      }
    }
    const kickPx = rm ? 0 : GUN.recoilPx * gun.kick;
    SV.nowMs = t;
    SV.reduceMotion = rm;
    SV.zoom = viewZoom;
    drawnCount = 0;
    SV.farX = -px * ST.parallaxFar;
    SV.farY = -py * ST.parallaxFar + kickPx * ST.recoilFar;
    SV.nearX = -px * ST.parallaxNear;
    SV.nearY = -py * ST.parallaxNear + kickPx * ST.recoilNear;

    ctx.save();
    if (shakeX !== 0 || shakeY !== 0) ctx.translate(shakeX, shakeY);
    if (zoom !== 1) {
      ctx.translate(zoomX, zoomY);
      ctx.scale(zoom, zoom);
      ctx.translate(-zoomX, -zoomY);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (!stage.draw(ctx, 'far', SV)) {
      ctx.fillStyle = COLORS.skyLight;
      ctx.fillRect(-60, -60, FIELD.w + 120, FIELD.h + 120);
    }
    // menus (idle) draw no house: it would peek out between the menu panels (video review); a round draws the snapshot's houses
    const houses = !idle && snap && Array.isArray(snap.houses) ? snap.houses : null;
    if (houses) drawHouses(ctx, houses, SV.farX, SV.farY);
    if (snap && Array.isArray(snap.targets)) drawTargets(ctx, snap.targets);
    if (idle) drawAmbient(ctx);
    drawShards(ctx);
    drawFxSprites(ctx, SK.DUST);
    drawFxSprites(ctx, SK.GROUNDPUFF);
    drawRings(ctx);
    drawParticles(ctx, PK.CHIP);
    drawFxSprites(ctx, SK.HITFLASH);
    drawParticles(ctx, PK.SPARKLE);
    stage.draw(ctx, 'near', SV);
    drawParticles(ctx, PK.PELLET);
    drawFxSprites(ctx, SK.SMOKE);
    drawPopups(ctx);
    drawGun(ctx);
    drawMuzzle(ctx);
    drawCasings(ctx);
    drawCrosshair(ctx);
    ctx.restore();
    drawKillCamOverlay(ctx);
  }

  // ---------------------------------------------------------------------------------------------------------------- API
  function setStage(id) {
    if (typeof id !== 'string' || !STAGE_IDS.includes(id)) return;
    stageId = id;
    stage.setStage(id);
  }

  function reset() {
    parts.clear();
    for (const p of pools) p.clear();
    rnd = mulberry32(0x0c1a7);
    recoilAge = Infinity;
    dryAge = Infinity;
    openAge = Infinity;
    openPending = 0;
    shotsSinceOpen = 0;
    flashAge = Infinity;
    bloomAge = Infinity;
    shakeAge = Infinity;
    shakeX = 0;
    shakeY = 0;
    zoom = 1;
    kill.active = false;
    stillAge = Infinity;
    hitStopLeft = 0;
    holdOpen = false;
    labels.clear();
    ambient.active = false;
    ambientWait = 2;
    sparkleClock = 0;
  }

  function liveCount() {
    let n = parts.count;
    for (const p of pools) n += p.live;
    return n;
  }

  function getDebug() {
    const st = stage.status();
    return {
      particles: liveCount(),
      stage: stageId ?? '',
      layers: { far: st.layers.far, near: st.layers.near },
      shake: Math.sqrt(shakeX * shakeX + shakeY * shakeY),
      zoom,
      // additive (tests and the debug overlay)
      pools: {
        particles: parts.count, particlesCap: parts.capacity, shards: shards.live, shardsCap: shards.capacity, sprites: fxs.live,
        spritesCap: fxs.capacity, rings: rings.live, popups: popups.live, casings: casings.live,
      },
      gun: { x: gun.x, y: gun.y, rot: gun.rot, scale: gun.scale, muzzleX: gun.muzzleX, muzzleY: gun.muzzleY, show: gun.show, slide: gun.slide, alpha: gun.alpha },
      gunCovers: (x, y, margin = 0) => gunCovers(gun.x, gun.y, gun.rot, x, y, margin),
      crosshair: crossAlpha,
      killCam: kill.active,
      stillFlash: stillAge < FX.stillFlashMs,
      stageStatus: st,
      sprites: sprites.stats(),
      viewZoom,
      popups: popups.items.filter((p) => p.alive).map((p) => ({ x: p.x, y: p.y })),
      drawn: drawn.slice(0, drawnCount).map((d) => ({ ...d })),
    };
  }

  return {
    setStage,
    reset,
    handleEvents,
    update,
    draw,
    getDebug,
    /** Additive: device pixels per logical pixel of the baked sprites (presentation calls it on resize). */
    setDensity: (k) => {
      sprites.setDensity(k);
      warmGen = -1; // the cache was cleared: bake the clay buckets again (code review R-09)
    },
    dispose: () => stage.dispose(),
  };
}
