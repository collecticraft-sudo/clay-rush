// Art configuration of Clay Rush: data only, one place for every tunable number of the render layer. OWNER: Render & Audio engineer.
//
// Nothing here changes game rules (those live in game/config.js). The art is optional everywhere: when an asset is missing the procedural
// painter of render/painters.js draws a matching fallback. Times in ms unless the key ends in S (seconds); lengths in logical playfield px
// (1920 x 1080) unless the key ends in M (world metres).

export const ART_CONFIG = Object.freeze({
  /** Folder of the shipped assets, relative to the page (server root is public/). */
  baseUrl: 'assets/',

  /** Loader (render/assets.js). */
  loader: Object.freeze({
    concurrency: 4,
    manifestTimeoutMs: 4000,
    imageTimeoutMs: 15000,
    layerTimeoutMs: 30000,
    /** How long the Integrator waits for group `core` before it lets the game start with the procedural art (it keeps loading). */
    bootWaitMs: 2500,
    scaledCacheMaxEntries: 220,
    scaledCacheMaxBytes: 96 * 1024 * 1024,
  }),

  /** Device pixels per logical pixel of the baked sprites (the world renderer's default; setDensity() changes it). */
  density: 2,

  /** Stage backdrops (render/stage.js): far layer (2560 x 1440 JPEG) + near layer (1920 x 1080 transparent PNG). */
  stage: Object.freeze({
    crossfadeMs: 400,
    /** A stage change waits this long for the new art (the old art stays on screen) before its procedural twin is shown (QA F4). */
    waitArtMs: 2500,
    /** Horizon of the far picture as a fraction of its height (design 2: 62 percent); it is drawn so that it lands on WORLD.horizonY. */
    farHorizonFrac: 0.62,
    /** Extra width on each side so that parallax and shake never show an edge. */
    farOverscanPx: 44,
    /**
     * Difficulty view (snapshot.worldScale k): the far and near layers are zoomed about the horizon point (960, WORLD.horizonY) by
     * clamp(k ^ -zoomExp, zoomMin, zoomMax): Easy (k 0.55) looks clearly closer, Hard (k 1.45) wider. The far picture is drawn farBaseScale
     * larger than the overscanned field at k = 1 so that the zoom-out of Hard still covers the field (it is clamped to what the picture
     * covers, with zoomMarginPx to spare for shake and parallax). Menus use 1; changes ease in over zoomTauS (a cut with Reduce motion).
     */
    farBaseScale: 1.12,
    zoomExp: 0.35,
    zoomMin: 0.8,
    zoomMax: 1.4,
    zoomMarginPx: 14,
    zoomTauS: 0.35,
    nearOverscanPx: 48,
    /** Parallax: fraction of the aim offset from the centre (design 2: far 0.6 percent, near 2.5 percent). */
    parallaxFar: 0.006,
    parallaxNear: 0.025,
    /** Share of the gun recoil kick (px) that each layer follows. */
    recoilFar: 0.25,
    recoilNear: 1.1,
    /** Idle drift of the menu backdrop (sinusoid, px and seconds). */
    idleDriftPx: 26,
    idleDriftPeriodS: 38,
    /** Decoded stage groups kept at once (the one shown plus the one fading in). */
    maxResidentStages: 2,
    /** Alpha of each layer (the knob for a near layer that is too loud). */
    layerAlpha: Object.freeze({
      meadow: Object.freeze({ far: 1, near: 1 }),
      hills: Object.freeze({ far: 1, near: 1 }),
      alpine: Object.freeze({ far: 1, near: 1 }),
    }),
  }),

  /** Houses: width in metres of the drawn content box (the sprite is scaled by House.scale, px per metre). */
  houses: Object.freeze({
    widthM: Object.freeze({ house_trap: 2.9, house_skeet: 2.7, house_tower: 4.2 }),
    /** Puff at the door after a launch (House.flashS), seconds and size in metres. */
    puffS: 0.7,
    puffM: 1.3,
    /** Where the door is, as a fraction of the drawn content (x from the left, y from the top). */
    door: Object.freeze({
      house_trap: Object.freeze({ x: 0.5, y: 0.45 }),
      house_skeet: Object.freeze({ x: 0.48, y: 0.32 }),
      house_tower: Object.freeze({ x: 0.5, y: 0.22 }),
    }),
    /** Menu backdrop: houses drawn when there is no snapshot (world metres, same as the game's table). */
    idle: Object.freeze({
      meadow: Object.freeze(['trap']),
      hills: Object.freeze(['trap', 'tower']),
      alpine: Object.freeze(['trap', 'tower']),
    }),
    positions: Object.freeze({
      trap: Object.freeze({ x: 0, y: 0.4, z: 14, sprite: 'house_trap' }),
      skeetL: Object.freeze({ x: -22, y: 3.0, z: 32, sprite: 'house_skeet' }),
      skeetR: Object.freeze({ x: 22, y: 1.2, z: 34, sprite: 'house_skeet' }),
      tower: Object.freeze({ x: -14, y: 6.0, z: 46, sprite: 'house_tower' }),
    }),
  }),

  /** Targets. */
  targets: Object.freeze({
    /** Motion streak behind a clay: how far back in time (s) it reaches and its alpha. */
    streakS: 0.07,
    streakAlpha: 0.32,
    /** Gold clay: glow radius in body radii and its alpha; one sparkle every sparkleEveryS. */
    goldGlowR: 4,
    goldGlowAlpha: 0.45,
    sparkleEveryS: 0.12,
    /** Rabbit: ground shadow (radius in body radii, alpha). */
    shadowR: 1.2,
    shadowAlpha: 0.28,
    /** Sprite size buckets: scale steps of this ratio (cached scaled sprites, drawn with a small residual scale). */
    bucketRatio: 1.12,
    /**
     * CONTINUOUS LOOK of a clay (no frame swap ever): the elevation of the line of sight (from the interpolated screen position) blends the
     * top view into the underside view between belowFromDeg and belowToDeg, and squashes the disc vertically towards edgeAspect within
     * edgeToDeg of the horizon (a level disc seen edge-on). A battue is always flat (battueAspect). The cosmetic spin becomes a gentle
     * wobble of +-wobbleRad (rabbits roll: they keep the full rotation).
     */
    belowFromDeg: 13,
    belowToDeg: 23,
    edgeFromDeg: 0.5,
    edgeToDeg: 12,
    edgeAspect: 0.42,
    battueAspect: 0.4,
    wobbleRad: 0.2,
    /** Clay radii (px) whose size buckets are baked ahead of time (a few per frame), so no bake happens while a clay flies. */
    prewarmRPx: Object.freeze([2, 120]),
    prewarmPerFrame: 3,
  }),

  /** Gun (gun_ou anchored at its bottom-right corner on the playfield's bottom-right corner). */
  gun: Object.freeze({
    heightPx: 600,
    /** Offset of the anchor from the playfield corner (positive = further right / lower). */
    anchorDx: 34,
    anchorDy: 40,
    /**
     * Follow the aim like an FPS: the gun shifts right / down as the aim goes right / down and turns its barrels towards the crosshair
     * (fraction of the angle difference, clamped). It must NEVER hide the crosshair: when the crosshair would come within clearPx of the
     * gun's silhouette it slides back along the line from the crosshair (as far as needed, at once; it comes back with slideTauS). A target
     * under the silhouette makes the gun fade to coverAlpha (fadeTauS).
     */
    followX: 0.12,
    followY: 0.14,
    turnK: 0.6,
    turnMaxDeg: 30,
    followTauS: 0.07,
    clearPx: 54,
    slideTauS: 0.12,
    coverAlpha: 0.35,
    fadeTauS: 0.12,
    /** The gun's silhouette in the picture's pixels (both the generated picture and the painted one): x0, y0, x1, y1, ... */
    silhouette: Object.freeze([6, 30, 34, 4, 300, 160, 470, 280, 560, 330, 689, 470, 689, 800, 520, 800, 430, 730, 330, 570, 230, 410, 80, 190]),
    /** Recoil (design 6.4): 8 px back along the barrel and 3 degrees of muzzle rise, back in 140 ms. */
    recoilPx: 8,
    recoilDeg: 3,
    recoilMs: 140,
    /** Dry fire: a small twitch. */
    dryPx: 2,
    dryMs: 90,
    /** Opening after a pull (casings out) and closing with fresh shells; dip in px and degrees. */
    openMs: 170,
    openHoldMs: 260,
    closeMs: 230,
    holdOpenMaxMs: 2000,
    openDipPx: 46,
    openDeg: -7,
    /** Breech position (fraction of the sprite) where casings come out. */
    breechX: 0.5,
    breechY: 0.5,
    /** Gun hidden (menus) slides down by this much. */
    hideDy: 700,
    showMs: 320,
  }),

  /** Crosshair (design 10: white ring, dark outline, centre dot; colour from settings). */
  crosshair: Object.freeze({
    r: 27,
    ring: 3.6,
    outline: 7.5,
    dot: 3.2,
    gap: 0.55,
    tick: 11,
    bloomScale: 1.55,
    bloomMs: 190,
    outlineColor: '#1B1F24',
    hiddenFadeMs: 160,
  }),

  /** Effects. Caps are hard pool sizes (allocated once). */
  fx: Object.freeze({
    caps: Object.freeze({ particles: 640, shards: 64, sprites: 48, rings: 12, popups: 12, casings: 6 }),
    /** Muzzle flash: two frames (star then side), additive glow. */
    flashFrameMs: 30,
    flashPx: 230,
    flashReducedAlpha: 0.35,
    glowPx: 420,
    glowMs: 140,
    glowAlpha: 0.75,
    glowReducedAlpha: 0.18,
    /** Muzzle smoke drifting with the wind (px/s per m/s of wind) and rising. */
    smokePx: 170,
    smokeMs: 1280,
    smokeRisePxS: 46,
    windPxPerMs: 22,
    /**
     * Camera shake on a shot (design 6.4, softened after QA F8): ONE smooth bump (raised cosine: it starts and ends with zero speed, so a
     * clay still flying never jerks), mostly down with a little sideways, 3 px over 90 ms; half of it while another clay is airborne. The
     * recoil feel lives in the gun kick.
     */
    shakePx: 3,
    shakeMs: 90,
    shakeSideK: 0.35,
    shakeAirborneK: 0.5,
    centreShakePx: 2,
    centreShakeMs: 90,
    /** Pellet cloud (design 8: 12 dots fading in 250 ms). */
    pellets: 12,
    pelletMs: 250,
    pelletSpreadPx: 30,
    pelletR: 2.6,
    /** Break: shards (count 6..10, fade at 1.2 s), chips, dust, powder ring, flash, popup. */
    shardsMin: 6,
    shardsMax: 10,
    shardS: 1.2,
    shardFadeFrom: 0.55,
    shardSpeed: Object.freeze([160, 560]),
    shardInherit: 0.3,
    shardSizeK: 0.95,
    shardSpin: 14,
    gravityPxS2: 1500,
    chips: 16,
    chipsCentre: 26,
    chipS: 0.75,
    dustK: 5.2,
    dustMs: 900,
    ringMs: 380,
    ringK: 6.5,
    hitFlashMs: 110,
    hitFlashK: 5,
    sparkles: 22,
    sparkleS: 0.9,
    centreBurstK: 1.45,
    /** Clay radius (px) at which the break effects have their nominal size (they scale with depth around it). */
    depthRefPx: 12,
    /** Points popup: rises and fades. */
    popupRisePx: 64,
    popupBannerZone: Object.freeze({ halfW: 440, top: 150, bottom: 400 }), // popups that would rise into the banner strip start below it
    /** Label blocks of the breaks (render/label-layout.js): nominal width, gaps, life, the top limit, the SMOKED! line (QA F5, F13). */
    labels: Object.freeze({ w: 300, gap: 6, lifeMs: 950, top: 110, edge: 24, smokedH: 66, smokedGap: 6, max: 16 }),
    popupMs: 950,
    popupPopMs: 140,
    popupSize: 64,
    popupSizeBig: 84,
    /** Ground puff of a target that hit the ground. */
    groundPuffMs: 700,
    groundPuffPx: 70,
    /** Shell casings ejected when the gun opens. */
    casingPx: 74,
    casingS: 1.1,
    casingVx: Object.freeze([380, 620]),
    casingVy: Object.freeze([-920, -640]),
    casingSpin: 16,
    /** Hit stop (world freeze of the fx, not of the UI). */
    hitStopMaxMs: 80,
    /** Kill cam: zoom on the point with a letterbox vignette (design 8). */
    killCamInMs: 110,
    killCamOutMs: 160,
    letterboxPx: 74,
    vignetteAlpha: 0.55,
    stillFlashMs: 80,
    stillFlashAlpha: 0.35,
    stillFlashReducedAlpha: 0.12,
    /** Idle (menu backdrop): one ambient clay every minS..maxS seconds. */
    ambientMinS: 3.5,
    ambientMaxS: 8,
    ambientFlightS: 3.6,
  }),

  /** HUD layout (render/hud.js), logical px. */
  hud: Object.freeze({
    margin: 40,
    score: Object.freeze({ x: 44, y: 34, w: 440, h: 128, digits: 84, ringR: 42 }),
    top: Object.freeze({ y: 34, h: 96 }),
    wind: Object.freeze({ x: 1876, y: 34, icon: 92 }),
    shells: Object.freeze({ x: 56, y: 1040, w: 52, h: 108, gap: 14 }),
    tally: Object.freeze({ x: 236, y: 1012, size: 34, gap: 6, max: 16 }),
    prompt: Object.freeze({ y: 924, size: 54 }),
    banner: Object.freeze({ y: 262, size: 128, holdMs: 760, inMs: 200, outMs: 260, from: 1.9, maxQueue: 3 }),
    smoked: Object.freeze({ size: 62, holdMs: 520, risePx: 50, offsetPx: 118 }),
    card: Object.freeze({ inMs: 380, outMs: 320, holdMs: 1800, w: 860, h: 370, y: 410 }),
    toastMs: 6000,
    insertMs: 400,
    timeWarnS: 10,
  }),
});
