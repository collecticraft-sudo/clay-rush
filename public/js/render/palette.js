// Art direction data of Clay Rush ("Golden-hour countryside", docs/game-design.md 10) as pure data. OWNER: Render & Audio engineer.
// Colours, font stacks, text roles and the stage palettes of the procedural backdrops. No canvas access here, importable anywhere.

/**
 * Palette tokens (design 10, architecture 6.3): cream #FFF4DC, slate #1B1F24, clay orange #F26B1D, gold #F2C230, sky blue #3C7FC8, olive
 * #6B7F3A, terracotta #C8553D, plus the shades the HUD and the effects need.
 *
 * LEGACY NAMES (paper, ink, vermilion, indigo, matcha, ...) are kept as aliases of the new tokens so that UI code written against the
 * previous palette keeps drawing in the new colours until it migrates; new code uses the new names.
 */
const NEW = {
  cream: '#FFF4DC',
  creamLight: '#FFFAEE',
  creamDeep: '#F1DFBA',
  slate: '#1B1F24',
  slateSoft: '#2B3139',
  slateMid: '#3E4651',
  slateText2: '#4A5361',
  grey: '#8A929D',
  greyLight: '#C5CBD3',
  orange: '#F26B1D',
  orangeLight: '#FF9A52',
  orangeDeep: '#C2500E',
  gold: '#F2C230',
  goldLight: '#FFE58A',
  goldDeep: '#C8921A',
  sky: '#3C7FC8',
  skyLight: '#8FC4F2',
  skyDeep: '#22508A',
  olive: '#6B7F3A',
  oliveLight: '#A3B85E',
  terracotta: '#C8553D',
  white: '#FFFFFF',
  black: '#000000',
  smoke: '#E9E6E0',
  dust: '#D9C29A',
  brass: '#D9A93A',
  shellRed: '#C8302A',
};

export const COLORS = Object.freeze({
  ...NEW,
  // legacy aliases (previous palette names -> new tokens)
  paper: NEW.cream,
  paperLight: NEW.creamLight,
  paperShade: NEW.creamDeep,
  paperGradientBottom: NEW.creamDeep,
  ink: NEW.slate,
  inkSoft: NEW.slateSoft,
  inkText2: NEW.slateText2,
  inkGrey: NEW.grey,
  vermilion: NEW.orange,
  vermilionDeep: NEW.orangeDeep,
  indigo: NEW.skyDeep,
  goldShine: NEW.goldLight,
  matcha: NEW.olive,
  ice: NEW.skyLight,
  flame: NEW.orange,
  flameInner: NEW.gold,
  teal: NEW.olive,
  sunPale: NEW.orangeLight,
});

/**
 * Font stacks (architecture C-10, 6.3). The first family of each stack is a web font shipped in public/assets/fonts/ and loaded by
 * fonts.js: ClayDisplay = Bebas Neue (one weight, capitals only: display text is written in capitals by design), ClayUI = Barlow 600 and
 * 700 (two files, one family). Everything after it is the system fallback used until the file is there, or for good (`?fonts=0`,
 * `?assets=0`, a failed download). `serif` and `sans` are the old names of the same two stacks.
 */
const DISPLAY_STACK = '"ClayDisplay", "Bebas Neue", "Oswald", "Impact", "Arial Narrow Bold", sans-serif';
const UI_STACK = '"ClayUI", "Barlow", "Helvetica Neue", "Segoe UI", system-ui, sans-serif';
export const FONTS = Object.freeze({
  display: DISPLAY_STACK,
  ui: UI_STACK,
  serif: DISPLAY_STACK,
  sans: UI_STACK,
});

/**
 * Text roles. `size` is logical px at 1920 x 1080 and `weight` a CSS weight; minimum text size anywhere is 28 px. `tracking` is letter
 * spacing in em, `minSize` the floor of the shrink-to-fit helpers, `look` the default recipe of `drawStyled` (draw-util.js).
 *
 * Tuned for a CONDENSED display face: Bebas Neue is tall and narrow (cap height about 0.7 em, a capital about 0.4 em wide), so the display
 * roles are larger than they would be for a round face and get a little positive tracking; the display face has ONE weight registered for
 * 100..900 (fonts.js), the 700 in its font strings only gives the system fallback (Impact, Arial Narrow Bold) the bold it needs.
 * The UI face is Barlow: 600 for body text, 700 for emphasis and labels.
 * @type {Readonly<Record<string,{family:'display'|'ui', size:number, weight:number, tracking:number, minSize:number, look:string}>>}
 */
export const TEXT_STYLES = Object.freeze({
  display: Object.freeze({ family: 'display', size: 190, weight: 700, tracking: 0.03, minSize: 120, look: 'banner' }),
  headline: Object.freeze({ family: 'display', size: 92, weight: 700, tracking: 0.04, minSize: 60, look: 'headline' }),
  button: Object.freeze({ family: 'display', size: 64, weight: 700, tracking: 0.06, minSize: 40, look: 'plate' }),
  buttonSmall: Object.freeze({ family: 'display', size: 50, weight: 700, tracking: 0.06, minSize: 36, look: 'plate' }),
  buttonTiny: Object.freeze({ family: 'display', size: 40, weight: 700, tracking: 0.06, minSize: 34, look: 'plate' }),
  banner84: Object.freeze({ family: 'display', size: 110, weight: 700, tracking: 0.04, minSize: 76, look: 'banner' }),
  banner110: Object.freeze({ family: 'display', size: 150, weight: 700, tracking: 0.04, minSize: 104, look: 'banner' }),
  banner132: Object.freeze({ family: 'display', size: 190, weight: 700, tracking: 0.04, minSize: 132, look: 'banner' }),
  stageCard: Object.freeze({ family: 'display', size: 170, weight: 700, tracking: 0.05, minSize: 110, look: 'banner' }),
  body: Object.freeze({ family: 'ui', size: 34, weight: 600, tracking: 0.005, minSize: 30, look: 'plain' }),
  bodyBold: Object.freeze({ family: 'ui', size: 34, weight: 700, tracking: 0.005, minSize: 30, look: 'plain' }),
  small: Object.freeze({ family: 'ui', size: 28, weight: 600, tracking: 0.01, minSize: 28, look: 'plain' }),
  hudLabel: Object.freeze({ family: 'ui', size: 28, weight: 700, tracking: 0.14, minSize: 28, look: 'label' }),
  hudInfo: Object.freeze({ family: 'display', size: 50, weight: 700, tracking: 0.06, minSize: 36, look: 'label' }),
  hudNumber: Object.freeze({ family: 'display', size: 96, weight: 700, tracking: 0.02, minSize: 72, look: 'numeral' }),
  hudTimer: Object.freeze({ family: 'display', size: 84, weight: 700, tracking: 0.02, minSize: 56, look: 'numeral' }),
  numeral: Object.freeze({ family: 'display', size: 96, weight: 700, tracking: 0.02, minSize: 72, look: 'numeral' }),
  numeralTimer: Object.freeze({ family: 'display', size: 84, weight: 700, tracking: 0.02, minSize: 56, look: 'numeral' }),
  popup44: Object.freeze({ family: 'display', size: 56, weight: 700, tracking: 0.03, minSize: 40, look: 'popup' }),
  popup64: Object.freeze({ family: 'display', size: 80, weight: 700, tracking: 0.03, minSize: 40, look: 'popup' }),
  popupLabel: Object.freeze({ family: 'ui', size: 28, weight: 700, tracking: 0.08, minSize: 28, look: 'plain' }),
});

const fontCache = Object.create(null);
const fontSizedCache = new Map();

/** CSS font shorthand for a style, optionally with another size. Memoised: a repeat call allocates nothing. */
export function fontString(style, sizeOverride) {
  const s = TEXT_STYLES[style] ?? TEXT_STYLES.body;
  if (sizeOverride === undefined || sizeOverride === s.size) {
    return fontCache[style] ?? (fontCache[style] = `${s.weight} ${s.size}px ${FONTS[s.family]}`);
  }
  let byStyle = fontSizedCache.get(style);
  if (!byStyle) {
    byStyle = new Map();
    fontSizedCache.set(style, byStyle);
  }
  let f = byStyle.get(sizeOverride);
  if (!f) {
    f = `${s.weight} ${sizeOverride}px ${FONTS[s.family]}`;
    if (byStyle.size > 200) byStyle.clear();
    byStyle.set(sizeOverride, f);
  }
  return f;
}

const spacingCache = new Map();

/** CSS `letter-spacing` value of a role at a size, for `ctx.letterSpacing` ('2.4px' for tracking 0.04 em at 60 px). Memoised. */
export function letterSpacingPx(style, size) {
  const s = TEXT_STYLES[style];
  const px = s ? size ?? s.size : size ?? 0;
  const key = `${style}|${px}`;
  let v = spacingCache.get(key);
  if (v === undefined) {
    const em = s ? s.tracking : 0;
    v = `${Math.round(em * px * 100) / 100}px`;
    if (spacingCache.size > 400) spacingCache.clear();
    spacingCache.set(key, v);
  }
  return v;
}

/** Crosshair colours of the settings (design 10: colour-blind friendly choices). */
export const CROSSHAIR_COLORS = Object.freeze({ white: '#FFFFFF', yellow: '#FFE14D', green: '#62F27E', magenta: '#FF5BDB' });

/**
 * Stage palettes of the procedural backdrops (render/painters.js), matched to the generated art: Morning Meadow (spring, blue sky),
 * Golden Hills (late afternoon, Tuscan gold), Alpine Dusk (violet sky, orange glow behind snowy peaks).
 */
export const STAGE_PALETTES = Object.freeze({
  meadow: Object.freeze({
    sky: Object.freeze(['#3A86D4', '#5AA2E2', '#9CCDF0', '#D9EEF8']),
    sun: Object.freeze({ x: 150, y: 70, r: 260, color: '#FFF8DA', alpha: 0.75 }),
    haze: '#CFE6F2',
    mountains: Object.freeze(['#9DB9D6', '#86A8C8']),
    snow: null,
    hills: Object.freeze(['#8FB27A', '#79A564', '#5F9150']),
    hillTint: '#BFD7B0',
    trees: '#3E6E3C',
    treesFar: '#6E9670',
    hedge: '#4F7F3E',
    fence: '#6B5236',
    grass: Object.freeze(['#7DB43A', '#8CC444', '#6FA232', '#5E8E2A']),
    stripeA: '#86BE40',
    stripeB: '#79B036',
    nearGrass: Object.freeze(['#3F7F24', '#5DA132', '#86C24A']),
    flowers: Object.freeze(['#FFFFFF', '#FFD84A']),
    accent: '#F3E7C8',
    clouds: true,
    stars: false,
    lake: null,
  }),
  hills: Object.freeze({
    sky: Object.freeze(['#3F7F9F', '#6EA4B4', '#D9D9B0', '#F6DFA0']),
    sun: Object.freeze({ x: 1880, y: 560, r: 320, color: '#FFE9A8', alpha: 0.85 }),
    haze: '#F2D9A2',
    mountains: Object.freeze(['#A69BB8', '#9289A8']),
    snow: null,
    hills: Object.freeze(['#D9A85A', '#E2B864', '#C99446']),
    hillTint: '#E8C98A',
    trees: '#4E6A34',
    treesFar: '#7F8A56',
    hedge: '#5C6F33',
    fence: '#7A5638',
    grass: Object.freeze(['#94A845', '#A3B650', '#869A3C', '#788C34']),
    stripeA: '#9DB04C',
    stripeB: '#8EA244',
    nearGrass: Object.freeze(['#5D6F2A', '#7F9436', '#B3B85A']),
    flowers: Object.freeze(['#E2492E', '#F2C230']),
    accent: '#F6D9A0',
    clouds: true,
    stars: false,
    lake: null,
  }),
  alpine: Object.freeze({
    sky: Object.freeze(['#232A66', '#4A3F8E', '#B06A9A', '#F2925A']),
    sun: Object.freeze({ x: 1030, y: 560, r: 420, color: '#FFB070', alpha: 0.55 }),
    haze: '#9A7FB8',
    mountains: Object.freeze(['#6F78B8', '#5A62A0']),
    snow: '#E9E4F6',
    hills: Object.freeze(['#2F5A6E', '#2A4F5E', '#244452']),
    hillTint: '#53708A',
    trees: '#1D3A40',
    treesFar: '#34506A',
    hedge: '#22403F',
    fence: '#3A3238',
    grass: Object.freeze(['#2C5A48', '#336652', '#27503F', '#214636']),
    stripeA: '#2F6050',
    stripeB: '#295746',
    nearGrass: Object.freeze(['#1E3E36', '#2C5648', '#47706A']),
    flowers: Object.freeze(['#7C7CF2', '#B9A8FF']),
    accent: '#FFB070',
    clouds: false,
    stars: true,
    lake: '#B07AB8',
  }),
});
