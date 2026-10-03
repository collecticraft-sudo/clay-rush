// URL flag parsing (docs/architecture.md 9.2). OWNER: integrator. Pure: no DOM, no globals, importable in Node.
//
//   ?input=joycon|native|sim|mouse   provider. joycon = Web Bluetooth (Chrome), native = the native Bluetooth bridge (any browser, needs
//   the game started with start.command; docs/native-bridge.md). Both are created at boot without connecting: the connect screen's
//   click connects. The old reserved name "bridge" (never implemented) is not accepted: use native.
//   ?seed=N  ?mode=classic|timeattack|zen  ?difficulty=easy|normal|hard  ?stage=meadow|hills|alpine  ?skipsafety=1  ?skipcountdown=1  ?clock=manual  ?debug=1  ?mute=1
//   ?reducemotion=1  ?reduceflash=1  ?simhz=N  ?simmount=NAME  ?simside=L|R  ?simmirror=1  ?simgyro=alt  ?simseed=N
//   ?simcal=1  ?haptics=0 (rumble off; on by default for a real Joy-Con, UNVERIFIED-ON-HARDWARE)  ?fonts=0 (read by render/fonts.js)
//   ?assets=0|off  turn the generated art off on purpose: every picture is then drawn procedurally (paper and ink), as the game
//   draws without any image file. On by default; any other value is ignored with a warning (docs/assets-integration.md 6.3).
//   Real Joy-Con connection (round 1 findings M5 / F2): ?filter=lenient|strict|all  ?mask=0xB7 (0x37, 0xB7 or 0xFF, always with 0x)
//   ?filter: lenient (the default when the flag is absent) = product id only, strict = also the zero host address of a pairing-mode
//   advert, all = acceptAllDevices. An explicit ?filter wins over the filter the game remembered from the last successful connection.
//   ?side=L|R  (what the chooser offers and which feature mask is sent; the diagnostics page shows the matching URL)
//   ?accelsign=-1|1  the sign of the accelerometer (protocol audit F3; the diagnostics page measures it, default: the saved value or 1)
//   ?simaccelsign=-1  the simulator models a sensor that reports the gravity vector (test of ?accelsign)
//
// Unknown or illegal values never throw: they are ignored and reported in `warnings` (main.js prints them to the console).

import { SIM_MOUNTS } from './input/index.js';

export const INPUT_KINDS = Object.freeze(['joycon', 'native', 'sim', 'mouse']);
export const MODE_NAMES = Object.freeze(['classic', 'timeattack', 'zen']);
export const DIFFICULTY_NAMES = Object.freeze(['easy', 'normal', 'hard']);
export const STAGE_NAMES = Object.freeze(['meadow', 'hills', 'alpine']);
export const FILTER_NAMES = Object.freeze(['lenient', 'strict', 'all']); // the first one is the default (INPUT_CONFIG.defaultFilter)

const truthy = (v) => v === '1' || v === 'true' || v === '';

/**
 * @param {string|URLSearchParams} search  location.search or a URLSearchParams
 * @returns {{input:string|null, seed:number|null, mode:string|null, difficulty:string|null, stage:string|null, skipsafety:boolean, skipcountdown:boolean, clock:'manual'|'real',
 *   debug:boolean, mute:boolean, assets:boolean, reducemotion:boolean, reduceflash:boolean, simhz:number|undefined, simmount:string|undefined,
 *   simside:'L'|'R'|undefined, simmirror:boolean, simgyro:'alt'|'default', simseed:number|undefined, simcal:boolean, haptics:boolean,
 *   filter:'lenient'|'strict'|'all'|null, mask:number|null, side:'L'|'R'|null, accelsign:1|-1|null, simaccelsign:1|-1, warnings:string[]}}
 */
export function parseFlags(search = '') {
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(String(search ?? ''));
  const warnings = [];
  const get = (k) => (q.has(k) ? q.get(k) : null);
  const bool = (k) => {
    const v = get(k);
    if (v === null) return false;
    if (truthy(v)) return true;
    if (v !== '0' && v !== 'false') warnings.push(`?${k}=${v} ignored (use 1)`);
    return false;
  };
  const int = (k) => {
    const v = get(k);
    if (v === null) return undefined;
    if (!/^-?\d{1,15}$/.test(v)) {
      warnings.push(`?${k}=${v} ignored (integer expected)`);
      return undefined;
    }
    return Number(v);
  };

  let input = get('input');
  if (input !== null) {
    input = input.toLowerCase();
    if (!INPUT_KINDS.includes(input)) {
      warnings.push(input === 'bridge' ? '?input=bridge ignored: that name was never implemented, use ?input=native' : `?input=${input} ignored (joycon, native, sim or mouse expected)`);
      input = null;
    }
  }

  let mode = get('mode');
  if (mode !== null) {
    mode = mode.toLowerCase();
    if (!MODE_NAMES.includes(mode)) {
      warnings.push(`?mode=${mode} ignored (classic, timeattack or zen expected)`);
      mode = null;
    }
  }

  const oneOf = (k, names) => {
    let v = get(k);
    if (v === null) return null;
    v = v.toLowerCase();
    if (names.includes(v)) return v;
    warnings.push(`?${k}=${v} ignored (${names.join(', ')} expected)`);
    return null;
  };
  const difficulty = oneOf('difficulty', DIFFICULTY_NAMES);
  const stage = oneOf('stage', STAGE_NAMES);

  const seedRaw = int('seed');
  let simhz;
  const simhzRaw = get('simhz');
  if (simhzRaw !== null) {
    const n = Number(simhzRaw);
    if (Number.isFinite(n) && n >= 10 && n <= 1000) simhz = n;
    else warnings.push(`?simhz=${simhzRaw} ignored (10 to 1000 expected)`);
  }

  let simmount = get('simmount') ?? undefined;
  if (simmount !== undefined && !Object.hasOwn(SIM_MOUNTS, simmount)) {
    warnings.push(`?simmount=${simmount} ignored (known: ${Object.keys(SIM_MOUNTS).join(', ')})`);
    simmount = undefined;
  }

  let simside = get('simside');
  if (simside !== null) {
    simside = simside.toUpperCase();
    if (simside !== 'L' && simside !== 'R') {
      warnings.push(`?simside=${simside} ignored (L or R expected)`);
      simside = undefined;
    }
  } else simside = undefined;

  const simgyroRaw = get('simgyro');
  if (simgyroRaw !== null && simgyroRaw !== 'alt' && simgyroRaw !== 'default') warnings.push(`?simgyro=${simgyroRaw} ignored (alt expected)`);

  const clockRaw = get('clock');
  if (clockRaw !== null && clockRaw !== 'manual' && clockRaw !== 'real') warnings.push(`?clock=${clockRaw} ignored (manual expected)`);

  let filter = get('filter');
  if (filter !== null) {
    filter = filter.toLowerCase();
    if (!FILTER_NAMES.includes(filter)) {
      warnings.push(`?filter=${filter} ignored (lenient, strict or all expected)`);
      filter = null;
    }
  }

  // The feature mask must be written with the 0x prefix: "37" would be read as decimal 37 = 0x25, which is not what anybody means.
  let mask = get('mask');
  if (mask !== null) {
    const m = /^0x([0-9a-f]{1,2})$/i.exec(mask);
    const value = m ? parseInt(m[1], 16) : 0;
    if (value < 1) {
      warnings.push(`?mask=${mask} ignored (write it in hex with the 0x prefix, for example 0xB7)`);
      mask = null;
    } else mask = value;
  }

  let side = get('side');
  if (side !== null) {
    side = side.toUpperCase();
    if (side === 'ANY') side = null;
    else if (side !== 'L' && side !== 'R') {
      warnings.push(`?side=${side} ignored (L or R expected)`);
      side = null;
    }
  }

  const sign = (k) => {
    const v = get(k);
    if (v === null) return null;
    if (v === '-1') return -1;
    if (v === '1') return 1;
    warnings.push(`?${k}=${v} ignored (-1 or 1 expected)`);
    return null;
  };
  const accelsign = sign('accelsign');
  const simaccelsign = sign('simaccelsign') ?? 1;

  // ?assets=0 or ?assets=off (also false / no) switches the art off; ?assets=1 or on is the default; anything else is a typo
  let assets = true;
  const assetsRaw = get('assets');
  if (assetsRaw !== null) {
    const v = assetsRaw.toLowerCase();
    if (v === '0' || v === 'off' || v === 'false' || v === 'no') assets = false;
    else if (v !== '1' && v !== 'on' && v !== 'true' && v !== 'yes' && v !== '') warnings.push(`?assets=${assetsRaw} ignored (0 or off turns the art off)`);
  }

  let skipsafety = bool('skipsafety');
  if (mode && !skipsafety) skipsafety = true; // ?mode implies ?skipsafety=1
  if (mode && input === null) input = 'mouse'; // ...and, without ?input, ?input=mouse

  return {
    input,
    seed: seedRaw === undefined ? null : seedRaw >>> 0,
    mode,
    difficulty,
    stage,
    skipsafety,
    skipcountdown: bool('skipcountdown'),
    clock: clockRaw === 'manual' ? 'manual' : 'real',
    debug: bool('debug'),
    mute: bool('mute'),
    assets,
    reducemotion: bool('reducemotion'),
    reduceflash: bool('reduceflash'),
    simhz,
    simmount,
    simside,
    simmirror: bool('simmirror'),
    simgyro: simgyroRaw === 'alt' ? 'alt' : 'default',
    simseed: int('simseed'),
    simcal: bool('simcal'),
    haptics: get('haptics') === null ? true : bool('haptics'),
    filter,
    mask,
    side,
    accelsign,
    simaccelsign,
    warnings,
  };
}
