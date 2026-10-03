// Script of public/diagnostics.html (docs/architecture.md 5.10). OWNER: input engineer.
//
// A standalone page: it talks to an InputProvider (the native Bluetooth bridge, `?input=native`, the default; real Joy-Con 2 over Web
// Bluetooth, `?input=joycon`; or the simulator, `?input=sim`) and to the pure maths of diagnostics-tools.js. No game code, no Motion import. It never claims anything about the hardware: the owner
// converts UNVERIFIED-ON-HARDWARE items into verified ones by ticking the checklist (docs/joycon2-protocol.md section 12).
// The English labels of this page live here (LABELS) and in diagnostics.html, not in ui/strings.en.js.

import { createRealClock } from '../shared/clock.js';
import { createInputProvider } from './index.js';
import { INPUT_CONFIG } from './input-config.js';
import { createStickTracker } from './stick.js';
import {
  createRateMeter, intervalStats, histogram, createScaleTool, createSignTest, createRestCheck, createLatencyProbe, batteryBand, formatHex,
  CHECKLIST, NATIVE_CHECKLIST, buildReport, saveScale, saveAccelSign, loadAccelSign, loadScale, clearSavedRecord, buildGameUrl,
  parseMode, formatAdverts, createKeepAliveExperiment,
} from './diagnostics-tools.js';

export const LABELS = Object.freeze({
  uoh: 'UNVERIFIED-ON-HARDWARE',
  uohPass: 'verified by the owner',
  uohFail: 'FAILED (owner)',
  none: 'none',
  notYet: 'not yet',
  modeReal: 'Real Joy-Con (Chrome\'s Bluetooth)',
  modeNative: 'Native bridge (recommended)',
  modeSim: 'Simulator (no Bluetooth)',
  untested: 'untested',
  pass: 'OK',
  fail: 'KO',
  errors: {
    unsupported_browser: 'This browser does not support Web Bluetooth: use Google Chrome on a Mac, opened from localhost.',
    permission_denied: 'Bluetooth permission denied: check System Settings > Privacy & Security > Bluetooth for Chrome.',
    cancelled: 'No Joy-Con chosen (list closed). No cooldown: you can try again right away.',
    not_joycon: 'The chosen device does not have the Joy-Con 2 service.',
    cooldown: 'Cooldown in progress: attempts repeated too quickly can block the Joy-Con.',
    gatt_failure: 'Connection failed (GATT). Hold SYNC and try again after the cooldown.',
    no_data: 'Connected but no IMU data after 9 s (try the 0xB7, 0xFF and 0x37 masks).',
    lost_signal: 'Connection lost or data interrupted.',
  },
  // the native bridge: a bridge error code -> what to do (the game's own texts are in strings.en.js; these are the page's short technical ones)
  nativeErrors: {
    bluetooth_permission: 'macOS is not giving Bluetooth permission to the app that started the game: restart it with start.command from Terminal and allow Bluetooth; if you declined it, System Settings > Privacy & Security > Bluetooth > Terminal.',
    bluetooth_off: 'The Mac\'s Bluetooth is off.',
    no_device: 'No Joy-Con found within the scan time: hold SYNC, stay close to the Mac; if you have tried many times, wait a minute.',
    not_pairing: 'A Joy-Con was seen but it is not in SYNC mode (with “SYNC mode only” on): hold SYNC.',
    connect_failed: 'Connection failed: wait a few seconds, hold SYNC and try again.',
    gatt_failure: 'Reading the services or starting up failed: wait a few seconds and try again.',
    lost_signal: 'Connection lost: hold SYNC and reconnect.',
    stalled: 'The bridge has stopped responding: try again in a few seconds.',
    helper_crashed: 'The helper stopped suddenly: try again, otherwise restart the game with start.command.',
    helper_failed: 'The helper will not start: restart the game with start.command.',
    build_failed: 'Building the helper failed: xcode-select --install is needed, then restart the game.',
    helper_missing: 'The native bridge is not available on this Mac (helper or compiler missing: xcode-select --install).',
    no_compiler: 'The native bridge is not available: the compiler is missing (xcode-select --install).',
    not_macos: 'The native bridge only works on macOS.',
    bridge_missing: 'This server is an old version without the bridge: restart the game with start.command.',
    bridge_unreachable: 'Cannot talk to the game server: check that the Terminal window is still open.',
    bridge_busy: 'The bridge is already in use (another tab?).',
    bridge_refused: 'The bridge refused the request: open the page from the address that start.command shows.',
  },
  native: {
    phases: {
      idle: 'idle', checking: 'checking the bridge', starting: 'starting the bridge', building: 'building the helper (first time only)', waitingBluetooth: 'waiting for Bluetooth (macOS permission?)',
      scanning: 'looking for the Joy-Con: hold SYNC', connecting: 'connecting', discovering: 'reading the services', initialising: 'initializing', waitingData: 'waiting for the first data', streaming: 'streaming',
    },
    bridge: {
      unknown: 'not checked yet',
      unreachable: 'unreachable (old server, or opened without start.command)',
      available: (s) => `available${s.built ? ' (helper built)' : s.canBuild ? ' (the helper is built on the first connection)' : ''}`,
      unavailable: (s) => `not available: ${s.reason ?? 'unknown reason'}`,
    },
    scan: (s) => `${s} s left`,
    dropped: (d, bad) => `${d} with the wrong length, ${bad} with invalid hex`,
  },
  keepAlive: {
    idle: 'Press “Start”: the page disconnects, turns keep-alive off and reconnects.',
    armed: 'Waiting for the connection: hold SYNC when prompted, then do not touch anything.',
    running: (s) => `Streaming without keep-alive for ${s} s of 60: do not touch anything.`,
    survived: 'No drop in 60 s without keep-alive: on this Joy-Con and this Mac keep-alive was not needed (to be confirmed: UNVERIFIED-ON-HARDWARE).',
    dropped: (s) => `The link dropped after ${s} s without keep-alive${s >= 8 && s <= 25 ? ': consistent with the drop at about 15 s reported by the community (UOH-5). Keep-alive is needed.' : '.'}`,
    never_connected: 'It never connected: try again (hold SYNC) or see the error above.',
    stopped: 'Stopped.',
  },
  scale: {
    idle: 'Press “Start”.',
    holding: (pct) => `Hold the Joy-Con still... ${pct}%`,
    rotating: 'Rotate NOW through ONE full revolution (360°), then press “Stop”.',
    done: 'Test complete. You can save the scale or repeat the test.',
    verdict: {
      default: 'About 360°: the default scale (2000/32768 °/s per unit) looks correct.',
      alt: 'About 2930°: the true scale looks like 0.0075 °/s per unit (factor 0.12288). Save it. Note: with this scale the sensor full scale would be only about 245 true °/s, so very fast moves would saturate.',
      other: (x) => `Different from the two candidates: measured factor ${x}. Repeat more slowly or save this value.`,
      too_short: 'Rotation too short (less than 90°). Repeat the test.',
      implausible: 'Implausible value. Repeat the test.',
    },
    saved: 'Saved in this browser: Clay Rush will use it at the next start.',
    savedMemory: 'localStorage is not available: the scale stays only on this page.',
  },
  sign: {
    idle: 'Press “Start”.',
    holdA: (pct) => `Hold the Joy-Con still... ${pct}%`,
    turning: 'Now slowly rotate the Joy-Con by 70-90° around a horizontal axis and hold it still for 1.5 s.',
    verdict: {
      ok: 'OK: gyroscope and accelerometer agree.',
      mirrored: 'Mirrored: the gyroscope has the opposite sign. This is not a problem, the game\'s calibration compensates for it.',
      undetermined: 'Undetermined: repeat with a cleaner rotation around a single horizontal axis.',
      too_small: 'Rotation too small: gravity moved by less than 30°. Repeat.',
    },
  },
  rest: {
    idle: 'Press “Start” with the Joy-Con flat, buttons up.',
    running: 'Do not move the Joy-Con...',
    pass: 'Passed.',
    failMoved: 'Moved during the check: repeat it, keeping the Joy-Con still.',
    failAccel: '|a| is outside 1.00 ± 0.03 g and also outside 0.85 - 1.15 g: the game does not accept it.',
    gameOk: 'The value differs from 1.00 g but is within the margin the game accepts (0.85 - 1.15 g): the game uses it as a reference. This is not a fault.',
    failGyro: 'Gyroscope at rest beyond ± 3 °/s.',
    failImu: 'imuActive is false: the sensor data is zero.',
  },
  // accelerometer sign (round 1 finding F3): the Z reading with the buttons up
  zSign: {
    plus: 'Z reads +1 g with the buttons up: the expected sign, nothing to do.',
    minus: 'Z reads -1 g with the buttons up: the sign is OPPOSITE. Save “-1”: without it, the aim would point toward the grip and the screen would be upside down.',
    not_flat: 'The Joy-Con was not flat: Z carries less than 95% of the reading. Lay it on the table with the buttons up and repeat.',
  },
  accel: {
    idle: 'First run the rest check with the buttons up.',
    ready: (s) => `Ready to save the sign ${s > 0 ? '+1 (default)' : '-1'}.`,
    saved: (s) => `Saved in this browser: Clay Rush will use the sign ${s > 0 ? '+1' : '-1'} at the next start.`,
    savedMemory: 'localStorage is not available: the sign stays only on this page.',
    current: (s) => `Previously saved sign: ${s > 0 ? '+1' : '-1'}.`,
  },
  saved: {
    none: 'No saved values: the game uses its defaults.',
    some: (scale, sign) => `Values saved for the game (they apply to every later start): ${scale !== null ? `gyroscope scale ${scale}` : 'no scale'}, ${sign !== null ? `accelerometer sign ${sign > 0 ? '+1' : '-1'}` : 'no sign'}.`,
    cleared: 'Values cleared: from the next start the game goes back to its defaults.',
    clearedMemory: 'localStorage is not available: no value was saved.',
  },
  suggestion: { ok: 'suggested: OK', ko: 'suggested: KO', wait: 'waiting for data' },
  // Titles of the checklist steps as the page shows them. They are the same steps as the shorter plain-ASCII titles in diagnostics-tools.js
  // (CHECKLIST / NATIVE_CHECKLIST), which are the ones that go into the JSON report for the team; the two sets are kept apart on purpose
  // (this one uses typographic quotes and units, and a few steps are worded for the person at the table).
  checklist: {
    1: 'Connect: the state reaches “streaming” within about 10 s and the lights stop sweeping',
    2: 'The packet length is 63; rate and histogram are visible (note the number)',
    3: 'Joy-Con flat with the BUTTONS UP and still for 3 s: |a| = 1.00 ± 0.03 g, raw Z about +4096 (+1 g), gyroscope about 0 ± 3 °/s, imuActive true',
    4: 'One full revolution: about 360° confirms the gyroscope scale, about 2930° means 0.0075 °/s per unit',
    5: 'Press a few buttons: the names shown match; note any phantom ZL/ZR',
    6: 'Stay connected for 60 s without touching anything (keep-alive on)',
    7: 'Battery in mV and temperature are plausible (about 3.5-4.2 V, about 25 °C)',
    8: 'The gravity vs gyroscope test says “ok” (or “mirrored”, which the calibration handles)',
    9: 'Latency probe: software part only; measure the display part with a 240 fps camera',
    10: 'Native bridge: started from Terminal, macOS asks once for Bluetooth permission for Terminal, the state reaches “streaming” and packets arrive steadily',
    11: 'Keep-alive experiment: 60 s with keep-alive off (does the link drop at about 15 s?) and 60 s with keep-alive on',
    12: 'Joy-Con choice and reconnection: with SYNC held, the SYNC-mode advert is chosen; without SYNC the bridge still connects (or says so); after a drop, note whether SYNC is needed again',
  },
  report: { copied: 'Report copied to the clipboard.', shown: 'Automatic copy failed: copy the text below by hand.' },
  warnings: {
    hidden: 'The tab is in the background: Chrome slows down timers (keep-alive, watchdog). Keep it in front.',
    unsupported: 'This browser does not support Web Bluetooth: use Google Chrome on a Mac, opened from localhost.',
  },
});

const num = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '-');
const vec = (v, digits = 3) => (v ? `${num(v.x, digits)}, ${num(v.y, digits)}, ${num(v.z, digits)}` : '-');
const rawVec = (v) => (v ? `${v.x}, ${v.y}, ${v.z}` : '-');
const mag = (v) => Math.hypot(v.x, v.y, v.z);

/**
 * Wire the page. `env` exists for embedding and tests; the defaults are the page's own globals.
 * @param {{document?:Document, window?:Window}} [env]
 */
export function startDiagnostics(env = {}) {
  const doc = env.document ?? globalThis.document;
  const win = env.window ?? globalThis.window;
  const $ = (id) => doc.getElementById(id);
  const text = (id, value) => {
    const e = $(id);
    const s = String(value);
    if (e && e.textContent !== s) e.textContent = s;
  };
  const params = new URLSearchParams(win.location?.search ?? '');
  const mode = parseMode(win.location?.search ?? ''); // native (default) | joycon (Web Bluetooth) | sim
  const kind = mode; // the provider kind of createInputProvider ('native', 'joycon' or 'sim')
  const isNative = mode === 'native';
  doc.body.classList.toggle('sim', mode === 'sim');
  doc.body.classList.toggle('native', isNative);
  doc.body.classList.toggle('ble', mode === 'joycon');
  text('mode-chip', mode === 'sim' ? LABELS.modeSim : isNative ? LABELS.modeNative : LABELS.modeReal);
  const modeSelect = $('mode-select');
  if (modeSelect) {
    modeSelect.value = mode;
    modeSelect.addEventListener('change', () => {
      // a new mode is a new page: the provider of this one lets go of the Joy-Con first (one central at a time)
      try {
        provider?.disconnect();
      } catch {
        /* the page is going away anyway */
      }
      win.location.search = `?input=${modeSelect.value}`;
    });
  }

  const clock = createRealClock();
  const memoryStore = {};
  const logLines = [];
  let logDirty = true;
  const addLog = (t, level, message) => {
    logLines.push(`${(t / 1000).toFixed(2).padStart(8)}  ${String(level).toUpperCase().padEnd(5)} ${message}`);
    while (logLines.length > INPUT_CONFIG.diagnostics.logLines) logLines.shift();
    logDirty = true;
  };

  // --- provider
  const numParam = (name) => {
    const v = Number(params.get(name));
    return params.has(name) && Number.isFinite(v) ? v : undefined;
  };
  const simOpts = {
    hz: numParam('simhz'), mount: params.get('simmount') || undefined, side: params.get('simside') === 'L' ? 'L' : 'R',
    mirrorGyro: params.get('simmirror') === '1', gyroScaleTrue: params.get('simgyro') === 'alt' ? 'alt' : 'default', seed: numParam('simseed'),
    accelSign: params.get('simaccelsign') === '-1' ? -1 : 1,
  };
  let provider;
  try {
    provider = createInputProvider(kind, { clock, target: kind === 'sim' ? $('simpad') : undefined, sim: simOpts });
  } catch (err) {
    const w = $('st-warning');
    w.hidden = false;
    w.textContent = String(err.message ?? err);
    return null;
  }
  if (kind === 'sim') {
    text('sim-flags', `simhz=${simOpts.hz ?? 66}  simmount=${simOpts.mount ?? 'faceUp'}  simside=${simOpts.side}  simmirror=${simOpts.mirrorGyro ? 1 : 0}  simgyro=${simOpts.gyroScaleTrue}  simaccelsign=${simOpts.accelSign}  simseed=${simOpts.seed ?? 1}`);
  }

  // --- data
  const rateMeter = createRateMeter();
  const latency = createLatencyProbe();
  const seenButtons = new Set();
  let pressedNow = [];
  let lastPacket = null;
  let renderedPacket = null;
  let lastSample = null;
  let streamingSince = null;
  let status = provider.status;
  // the stick, exactly as the game reads it (input/stick.js): raw field, centre estimate, normalised position, the flicks it would make. A second tracker
  // of the page's own, fed by the same packets, so the page shows the numbers the game uses and needs nothing from the provider.
  const stickTracker = createStickTracker({ side: provider.status.side });
  let stickState = null;
  let lastNav = null;
  let navCount = 0;

  let bridgeStatus = null; // native mode: what GET /__bridge/status said at load, or {unreachable:true}
  const kaExperiment = createKeepAliveExperiment();
  let kaNote = '';
  const scale = { tool: createScaleTool(), active: false, result: null, note: '' };
  const sign = { tool: createSignTest(), active: false };
  const rest = { tool: createRestCheck(), active: false };
  const checklistState = {};

  provider.on('packet', (p) => {
    if (p.report) stickState = stickTracker.push(p.report.stickFields).state;
    lastPacket = p;
    rateMeter.push(p.arrivedAt);
  });
  provider.on('sample', (s) => {
    lastSample = s;
    if (scale.active) scale.tool.push(s);
    if (sign.active) sign.tool.push(s);
    if (rest.active) rest.tool.push(s);
  });
  provider.on('nav', (n) => {
    if (n.phase !== 'down') return;
    lastNav = n.dir;
    navCount++;
  });
  provider.on('buttons', (b) => {
    pressedNow = b.pressed;
    for (const name of b.pressed) seenButtons.add(name);
  });
  provider.on('log', (l) => addLog(l.t, l.level, l.message));
  provider.on('error', (e) => addLog(e.at, 'error', `${e.code}: ${e.message}`));
  provider.on('status', (s) => {
    const prev = status;
    status = s;
    stickTracker.setSide(s.side); // a new unit may be the other side (the other field, another centre)
    if (s.state === 'requesting' || s.state === 'connecting') stickTracker.reset();
    if (s.state === 'streaming' && prev.state !== 'streaming') streamingSince = clock.now();
    if (s.state !== 'streaming') streamingSince = null;
    if (s.state === 'requesting' || s.state === 'connecting') {
      rateMeter.reset();
      lastPacket = null;
      renderedPacket = null;
    }
    kaExperiment.onState(s.state, clock.now());
    addLog(clock.now(), 'state', `${prev.state} -> ${s.state}${s.error ? ` (${s.error.native?.code ?? s.error.code})` : ''}`);
  });
  provider.on('bridge', (b) => addLog(b.at, 'bridge', `${b.phase}${b.helperState ? ` (helper: ${b.helperState})` : ''}`));

  // --- connection controls (joycon only)
  const onClick = (id, fn) => {
    const e = $(id);
    if (e) e.addEventListener('click', fn);
  };
  onClick('btn-connect', () => {
    // synchronous inside the click handler: Web Bluetooth needs the user gesture
    provider
      .connect({
        side: $('opt-side').value, filter: $('opt-filter').value, mask: Number($('opt-mask').value), keepAlive: $('opt-keepalive').checked,
        ...(isNative ? { pairingOnly: $('opt-pairing')?.value === 'only' } : {}),
      })
      .catch(() => {});
  });
  onClick('btn-reconnect', () => provider.reconnect().catch(() => {}));
  onClick('btn-disconnect', () => provider.disconnect());
  // The Joy-Con talks to one page at a time (round 1 finding M4): opening the game lets go of it first. Runs inside the click, so
  // the new tab still opens normally.
  onClick('open-game', () => provider.disconnect());
  onClick('game-url', () => provider.disconnect());
  // The URL that makes the game use the scan filter, mask, side and accelerometer sign chosen here (round 1 findings M5 / F2 / F3).
  const gameUrlOptions = () => ({
    input: isNative ? 'native' : undefined,
    filter: $('opt-filter')?.value,
    mask: Number($('opt-mask')?.value),
    side: $('opt-side')?.value,
    accelSign: accelState.measured === 'minus' || accelState.saved === -1 ? -1 : null,
  });
  const accelState = { measured: null, saved: null, note: '' };
  function updateGameUrl() {
    const a = $('game-url');
    if (!a) return;
    const url = buildGameUrl(win.location?.origin ?? '', gameUrlOptions());
    a.href = url;
    if (a.textContent !== url) a.textContent = url;
  }
  for (const id of ['opt-side', 'opt-filter', 'opt-mask']) $(id)?.addEventListener('change', updateGameUrl);
  const keepAliveBox = $('opt-keepalive');
  if (keepAliveBox) keepAliveBox.addEventListener('change', () => provider.setKeepAlive?.(keepAliveBox.checked));
  for (const btn of doc.querySelectorAll('[data-vib]')) btn.addEventListener('click', () => provider.vibrate?.(Number(btn.dataset.vib)));
  if (kind === 'sim') provider.connect().catch(() => {});

  // native mode: is the bridge there? (the same GET /__bridge/status the game's connect screen asks)
  if (isNative) {
    const fetchFn = typeof win.fetch === 'function' ? win.fetch.bind(win) : null;
    if (!fetchFn) bridgeStatus = { unreachable: true };
    else {
      Promise.resolve()
        .then(() => fetchFn('/__bridge/status', { cache: 'no-store' }))
        .then((res) => (res && res.ok ? res.json() : null))
        .then((json) => { bridgeStatus = json && typeof json === 'object' ? json : { unreachable: true }; }, () => { bridgeStatus = { unreachable: true }; });
    }
  }

  // the 60 s keep-alive experiment (UOH-5): disconnect, keep-alive off, connect again, watch for a drop
  onClick('ka-start', () => {
    kaNote = '';
    if (keepAliveBox) keepAliveBox.checked = false;
    provider.setKeepAlive?.(false);
    provider.disconnect();
    kaExperiment.start();
    provider
      .connect({
        side: $('opt-side').value, filter: $('opt-filter')?.value, mask: Number($('opt-mask').value), keepAlive: false,
        ...(isNative ? { pairingOnly: $('opt-pairing')?.value === 'only' } : {}),
      })
      .catch(() => {});
  });
  onClick('ka-stop', () => {
    kaExperiment.stop();
    kaNote = LABELS.keepAlive.stopped;
  });

  // --- tools
  const storage = () => {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  };
  onClick('scale-start', () => {
    scale.tool.start();
    scale.active = true;
    scale.result = null;
    scale.note = '';
    $('scale-stop').disabled = false;
    $('scale-save').disabled = true;
  });
  onClick('scale-stop', () => {
    scale.result = scale.tool.stop();
    scale.active = false;
    $('scale-stop').disabled = true;
    $('scale-save').disabled = !(scale.result && scale.result.gyroScale);
  });
  onClick('scale-save', () => {
    const res = saveScale(storage(), scale.result, new Date().toISOString(), undefined, memoryStore);
    scale.note = res.ok ? (res.persistent ? LABELS.scale.saved : LABELS.scale.savedMemory) : res.reason;
  });
  onClick('sign-start', () => {
    sign.tool = createSignTest();
    sign.active = true;
  });
  onClick('rest-start', () => {
    rest.tool = createRestCheck();
    rest.active = true;
    accelState.measured = null;
    accelState.note = '';
  });
  accelState.saved = loadAccelSign(storage());
  const savedState = { note: '' };
  onClick('saved-clear', () => {
    const res = clearSavedRecord(storage(), undefined, memoryStore);
    accelState.saved = null;
    scale.note = '';
    savedState.note = res.persistent ? LABELS.saved.cleared : LABELS.saved.clearedMemory;
    updateGameUrl();
  });
  onClick('accel-save', () => {
    const sign = accelState.measured === 'minus' ? -1 : accelState.measured === 'plus' ? 1 : null;
    if (sign === null) return;
    const res = saveAccelSign(storage(), sign, new Date().toISOString(), undefined, memoryStore);
    if (res.ok) {
      accelState.saved = sign;
      accelState.note = res.persistent ? LABELS.accel.saved(sign) : LABELS.accel.savedMemory;
    } else accelState.note = res.reason;
    updateGameUrl();
  });

  // --- checklist
  const list = $('checklist');
  const checklistItems = isNative ? [...CHECKLIST, ...NATIVE_CHECKLIST] : CHECKLIST;
  for (const item of checklistItems) {
    const li = doc.createElement('li');
    li.dataset.item = String(item.id);
    li.innerHTML = `
      <div class="head"><span class="num">${item.id}</span><b></b><span class="uoh" data-uoh-item="${item.id}">${LABELS.uoh}</span><span class="small muted">${item.uoh.join(', ')}</span></div>
      <div class="small muted" data-suggest="${item.id}"></div>
      <div class="ctl"><select data-status="${item.id}"><option value="untested">${LABELS.untested}</option><option value="pass">${LABELS.pass}</option><option value="fail">${LABELS.fail}</option></select>
      <input type="text" data-note="${item.id}" placeholder="note (for example: 4 s, 62 Hz)" autocomplete="off"></div>`;
    li.querySelector('b').textContent = LABELS.checklist[item.id] ?? item.title;
    list.appendChild(li);
    checklistState[item.id] = { status: 'untested', note: '' };
    li.querySelector('select').addEventListener('change', (e) => {
      checklistState[item.id].status = e.target.value;
      renderBadges();
    });
    li.querySelector('input').addEventListener('input', (e) => {
      checklistState[item.id].note = e.target.value;
    });
  }

  function renderBadges() {
    for (const badge of doc.querySelectorAll('[data-uoh-item]')) {
      const s = checklistState[badge.dataset.uohItem]?.status ?? 'untested';
      badge.textContent = s === 'pass' ? LABELS.uohPass : s === 'fail' ? LABELS.uohFail : LABELS.uoh;
      badge.className = `uoh${s === 'pass' ? ' pass' : s === 'fail' ? ' fail' : ''}`;
    }
  }

  // --- report
  function currentReport() {
    const d = provider.getDiagnostics?.() ?? {};
    const stream = d.stream ?? {};
    const st = provider.status;
    return buildReport({
      createdAt: new Date().toISOString(),
      userAgent: win.navigator?.userAgent ?? null,
      kind,
      side: st.side,
      deviceName: st.deviceName,
      featureMask: st.featureMask,
      state: st.state,
      errorCode: st.error?.code ?? null,
      failures: st.failures,
      timings: d.timings ?? null,
      watchdogStage: d.watchdogStage ?? null,
      keepAlive: d.keepAlive ?? null,
      packetLength: lastPacket?.length ?? null,
      imuActive: lastPacket?.report?.imuActive ?? null,
      rate1s: rateMeter.rate(clock.now(), 1000),
      rate10s: rateMeter.rate(clock.now(), 10_000),
      interArrival: intervalStats(rateMeter.intervals()),
      dtSource: stream.dtSource ?? null,
      dtRatio: stream.dtRatio ?? null,
      counterRatio: stream.counterRatio ?? null,
      dropped: stream.dropped ?? null,
      bursts: stream.bursts ?? null,
      gaps: stream.gaps ?? null,
      batteryMv: lastSample?.batteryMv ?? null,
      batteryLevel: st.battery.level,
      tempC: lastSample?.tempC ?? null,
      scale: scale.result,
      signTest: sign.tool.state().result,
      restCheck: rest.tool.state().result,
      accelSign: { measured: accelState.measured, saved: accelState.saved },
      latency: latency.stats(),
      keepAliveExperiment: kaExperiment.state(clock.now()).result,
      native: isNative ? nativeReport() : null,
      checklist: checklistState,
    });
  }
  function nativeReport() {
    const info = provider.getBridgeInfo?.() ?? {};
    const d = provider.getDiagnostics?.() ?? {};
    return {
      bridge: bridgeStatus, phase: info.phase ?? null, helperState: info.helperState ?? null, lastCode: info.lastCode ?? null, adverts: info.adverts ?? [],
      dropped: info.dropped ?? null, badReports: info.badReports ?? null, scanSeconds: info.scanSeconds ?? null, events: d.native?.events ?? null,
      pairingOnly: $('opt-pairing')?.value === 'only',
    };
  }
  onClick('btn-report', async () => {
    const json = JSON.stringify(currentReport(), null, 2);
    $('report-text').value = json;
    let copied = false;
    try {
      await win.navigator.clipboard.writeText(json);
      copied = true;
    } catch {
      try {
        $('report-text').select();
        copied = doc.execCommand('copy');
      } catch {
        copied = false;
      }
    }
    text('report-msg', copied ? LABELS.report.copied : LABELS.report.shown);
  });

  // --- rendering
  function renderLive() {
    if (!lastPacket || lastPacket === renderedPacket) return;
    renderedPacket = lastPacket;
    text('lv-hex', formatHex(lastPacket.bytes));
    text('lv-len', `${lastPacket.length} bytes${lastPacket.length === 63 ? '' : '  (expected 63)'}`);
    const r = lastPacket.report;
    if (!r) {
      text('lv-counter', 'packet rejected (too short)');
      return;
    }
    text('lv-counter', r.counter);
    text('lv-ts', `${r.imuTimestampUs} us`);
    text('lv-araw', rawVec(r.accelRaw));
    text('lv-a', `${vec(r.accelG, 4)}   |a| = ${num(mag(r.accelG), 4)} g`);
    text('lv-graw', rawVec(r.gyroRaw));
    text('lv-g', `${vec(r.gyroDps, 3)}   |w| = ${num(mag(r.gyroDps), 3)} °/s`);
    text('lv-temp', `${num(r.temperatureC, 1)} °C  (raw ${r.temperatureRaw})`);
    const band = batteryBand(r.batteryMv);
    const bandLabel = { ok: 'ok', low: 'low', critical: 'critical', unknown: 'unknown' }[band];
    const battEl = $('lv-batt');
    if (battEl) {
      battEl.textContent = `${r.batteryMv} mV  -  ${bandLabel} (approximate)`;
      battEl.className = `v ${band === 'ok' ? 'ok' : band === 'low' ? 'warn' : band === 'critical' ? 'bad' : ''}`;
    }
    text('lv-imu', String(r.imuActive));
    // F5 (protocol audit): the byte at 0x29 is 0x01 in every capture the notes describe. The game does not depend on it (the parser
    // exposes it and never rejects a report for it), but a different value would mean another report layout: say so, do not hide it.
    const marker = lastPacket?.report?.imuMarker;
    const markerEl = $('lv-marker');
    if (markerEl) {
      markerEl.textContent = marker === undefined ? '-' : marker === 1 ? '0x01 (expected)' : `0x${Number(marker).toString(16).padStart(2, '0')}: DIFFERENT from 0x01, the packet format may not be the documented one`;
      markerEl.className = `v ${marker === undefined || marker === 1 ? '' : 'warn'}`;
    }
  }

  let lastSlow = -Infinity;
  /** The "Stick" rows of the live table: what the game reads from the stick, so the owner can check centre, direction and flicks in half a minute. */
  function renderStick() {
    const st = stickState;
    const cfg = INPUT_CONFIG.stick;
    if (!st || !lastPacket || !lastPacket.report) {
      for (const id of ['lv-stick-raw', 'lv-stick-norm', 'lv-stick-centre', 'lv-stick-dir']) text(id, '-');
      return;
    }
    const f = lastPacket.report.stickFields;
    text('lv-stick-raw', `used (${st.side === 'L' ? 'left' : st.side === 'R' ? 'right' : 'auto'} field)  x ${st.raw.x}  y ${st.raw.y}     left field ${f.left.x} / ${f.left.y}   right field ${f.right.x} / ${f.right.y}`);
    const sg = (v) => (v >= 0 ? '+' : '') + num(v, 2);
    text('lv-stick-norm', `x ${sg(st.nx)}   y ${sg(st.ny)} (up = +)   magnitude ${num(st.mag, 2)}   ${st.deadZone ? 'in the dead zone' : st.mag >= cfg.moveThreshold ? 'past the move threshold' : 'between the dead zone and the move threshold'}   (dead zone < ${cfg.deadZone}, move >= ${cfg.moveThreshold}, re-arm < ${cfg.rearm}, half range ${cfg.halfRange} ASSUMED)`);
    text('lv-stick-centre', st.centred ? `x ${num(st.centre.x, 1)}   y ${num(st.centre.y, 1)}   (estimated from the first untouched reports; nominal ${cfg.nominalCentre})` : `x ${cfg.nominalCentre}   y ${cfg.nominalCentre}   (nominal: not estimated yet, let go of the stick)`);
    text('lv-stick-dir', `${st.held ? `held: ${st.held}` : st.armed ? 'centred, ready' : 'let the stick return near the centre'}     last flick: ${lastNav ?? 'none'}     flicks so far: ${navCount}`);
  }

  function renderSlow(now) {
    const st = provider.status;
    const d = provider.getDiagnostics?.() ?? {};
    const stream = d.stream ?? {};

    // connection
    const chip = $('st-state');
    if (chip) {
      chip.textContent = st.state;
      chip.className = `chip ${st.state}`;
    }
    text('st-track', st.state === 'streaming' ? (st.trackingOk ? 'fresh data' : 'stale data') : '');
    const nativeCode = st.error?.native?.code;
    text('st-error', st.error ? `${nativeCode ?? st.error.code}: ${(nativeCode && LABELS.nativeErrors[nativeCode]) || LABELS.errors[st.error.code] || ''}  [${st.error.message}]` : LABELS.none);
    const wait = st.cooldownUntil !== null ? Math.max(0, Math.ceil((st.cooldownUntil - now) / 1000)) : 0;
    text('st-cooldown', wait > 0 ? `${wait} s${st.failures >= INPUT_CONFIG.longCooldownAfterFailures ? '  (long cooldown after 3 failures)' : ''}` : LABELS.none);
    text('st-side', `${st.side}   ${st.deviceName ?? ''}`);
    text('st-mask', st.featureMask === null ? LABELS.notYet : `0x${st.featureMask.toString(16).toUpperCase()}   watchdog: stage ${d.watchdogStage ?? 0}   keep-alive: ${d.keepAlive === null || d.keepAlive === undefined ? '-' : d.keepAlive ? 'on' : 'off'}`);
    const t = d.timings;
    text('st-timings', t ? `request ${num(t.requestMs, 0)} ms  |  connection ${num(t.connectMs, 0)} ms  |  discovery ${num(t.discoveryMs, 0)} ms  |  init ${num(t.initMs, 0)} ms  |  first packet ${num(t.firstReportMs, 0)} ms` : LABELS.notYet);
    text('st-writes', d.writeCount ? `${d.writeCount}, the last one ${d.lastWriteAt === null ? '-' : `${num((now - d.lastWriteAt) / 1000, 1)} s ago`}` : 'none');
    text('st-uptime', streamingSince === null ? '-' : `${num((now - streamingSince) / 1000, 0)} s`);
    const busy = st.state === 'requesting' || st.state === 'connecting' || st.state === 'initializing' || st.state === 'streaming';
    const connectBtn = $('btn-connect');
    if (connectBtn) {
      connectBtn.disabled = busy || wait > 0 || (!isNative && st.error?.code === 'unsupported_browser');
      connectBtn.textContent = wait > 0 ? `Connect (wait ${wait} s)` : 'Connect';
    }
    const reconnectBtn = $('btn-reconnect');
    if (reconnectBtn) reconnectBtn.disabled = busy || wait > 0 || (!isNative && st.deviceName === null);
    const disconnectBtn = $('btn-disconnect');
    if (disconnectBtn) disconnectBtn.disabled = st.state === 'idle';
    const warn = $('st-warning');
    if (warn) {
      const message = st.error?.code === 'unsupported_browser' && !isNative ? LABELS.warnings.unsupported : doc.hidden ? LABELS.warnings.hidden : '';
      warn.hidden = !message;
      warn.textContent = message;
    }
    for (const btn of doc.querySelectorAll('[data-vib]')) btn.disabled = st.state !== 'streaming';

    // the native bridge block and the keep-alive experiment
    if (isNative) renderNative(now);
    kaExperiment.tick(now);
    renderKeepAlive(now);

    // live extras
    renderStick();
    text('lv-buttons', pressedNow.length ? pressedNow.join(' + ') : 'none');
    text('lv-seen', seenButtons.size ? [...seenButtons].join(', ') : 'none so far');

    // rates
    const r1 = rateMeter.rate(now, 1000);
    const r10 = rateMeter.rate(now, 10_000);
    text('rt-1s', r1 === null ? '-' : `${num(r1, 1)} Hz`);
    text('rt-10s', r10 === null ? '-' : `${num(r10, 1)} Hz`);
    const iv = rateMeter.intervals();
    const stats = intervalStats(iv);
    text('rt-iv', stats.count ? `min ${num(stats.min, 1)}  median ${num(stats.median, 1)}  p95 ${num(stats.p95, 1)}  max ${num(stats.max, 1)} ms  (${stats.count} intervals)` : '-');
    text('rt-dt', stream.dtSource ? `${stream.dtSource === 'device' ? 'device timestamps' : 'arrival times (the timestamps are inconsistent)'}   ratio ${num(stream.dtRatio, 3)}` : '-');
    text('rt-counter', stream.counterRatio === null || stream.counterRatio === undefined ? '-' : `${num(stream.counterRatio, 3)}  (1 = the counter is a clock in ms)`);
    text('rt-loss', stream.packets ? `${stream.dropped} / ${stream.bursts} / ${stream.gaps}` : '-');
    const h = histogram(iv, { binMs: 2.5, maxMs: 60 });
    const histEl = $('rt-hist');
    if (histEl) {
      const total = Math.max(1, ...h.bins.map((b) => b.count), h.overflow);
      if (histEl.childElementCount !== h.bins.length + 1) {
        histEl.textContent = '';
        for (let i = 0; i < h.bins.length + 1; i++) histEl.appendChild(doc.createElement('i'));
      }
      h.bins.forEach((b, i) => {
        histEl.children[i].style.height = `${Math.max(1, (70 * b.count) / total)}px`;
        histEl.children[i].title = `${b.from}-${b.to} ms: ${b.count}`;
      });
      histEl.children[h.bins.length].style.height = `${Math.max(1, (70 * h.overflow) / total)}px`;
      histEl.children[h.bins.length].title = `60+ ms: ${h.overflow}`;
    }

    // tools
    renderTools();

    // latency
    const l = latency.stats();
    text('lat-stats', l.count ? `min ${num(l.min, 1)}   avg ${num(l.avg, 1)}   p95 ${num(l.p95, 1)}   max ${num(l.max, 1)} ms   (${l.count} frames)` : '-');

    // suggestions
    const sug = suggestions(st, d, r1);
    for (const item of checklistItems) {
      const s = sug[item.id];
      const el = doc.querySelector(`[data-suggest="${item.id}"]`);
      if (el && s) el.textContent = `${s.text}${s.detail ? `  -  ${s.detail}` : ''}`;
    }

    if (logDirty) {
      logDirty = false;
      text('log', logLines.length ? logLines.join('\n') : '-');
      const logEl = $('log');
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function renderNative(now) {
    const info = provider.getBridgeInfo?.() ?? {};
    const st = bridgeStatus ?? info.bridge ?? null;
    text('nb-status', !st ? LABELS.native.bridge.unknown : st.unreachable ? LABELS.native.bridge.unreachable : st.available ? LABELS.native.bridge.available(st) : LABELS.native.bridge.unavailable(st));
    text('nb-phase', `${info.phase ?? 'idle'}: ${LABELS.native.phases[info.phase ?? 'idle'] ?? ''}`);
    text('nb-helper', info.helperState ?? '-');
    const left = info.scanStartedAt !== null && info.scanStartedAt !== undefined && info.phase === 'scanning' && Number.isFinite(info.scanSeconds)
      ? Math.max(0, Math.ceil(info.scanSeconds - (now - info.scanStartedAt) / 1000)) : null;
    text('nb-scan', left === null ? '-' : LABELS.native.scan(left));
    text('nb-adverts', formatAdverts(info.adverts));
    text('nb-dropped', info.dropped !== undefined ? LABELS.native.dropped(info.dropped, info.badReports ?? 0) : '-');
    text('nb-code', info.lastCode ?? '-');
  }

  function renderKeepAlive(now) {
    const k = kaExperiment.state(now);
    const start = $('ka-start');
    const stop = $('ka-stop');
    if (start) start.disabled = k.phase === 'armed' || k.phase === 'running';
    if (stop) stop.disabled = !(k.phase === 'armed' || k.phase === 'running');
    let msg = LABELS.keepAlive.idle;
    if (k.phase === 'armed') msg = LABELS.keepAlive.armed;
    else if (k.phase === 'running') msg = LABELS.keepAlive.running(Math.round(k.elapsedS));
    else if (k.phase === 'done') msg = k.result.verdict === 'dropped' ? LABELS.keepAlive.dropped(Math.round(k.result.dropS)) : LABELS.keepAlive[k.result.verdict];
    else if (kaNote) msg = kaNote;
    text('ka-msg', msg);
    text('ka-elapsed', k.phase === 'running' ? `${num(k.elapsedS, 0)} s` : k.phase === 'done' && k.result.verdict === 'dropped' ? `${num(k.result.dropS, 1)} s (then dropped)` : k.phase === 'done' && k.result.verdict === 'survived' ? '60 s (no drop)' : '-');
    text('ka-verdict', k.phase === 'done' ? msg : '-');
  }

  function renderTools() {
    // scale
    const s = scale.tool.state();
    const progress = $('scale-progress');
    if (progress) {
      progress.hidden = s.phase !== 'holding';
      progress.value = s.holdProgress;
    }
    if (s.phase === 'idle') text('scale-msg', LABELS.scale.idle);
    else if (s.phase === 'holding') text('scale-msg', LABELS.scale.holding(Math.round(s.holdProgress * 100)));
    else if (s.phase === 'rotating') text('scale-msg', LABELS.scale.rotating);
    else text('scale-msg', scale.note || LABELS.scale.done);
    text('scale-angle', s.phase === 'idle' ? '-' : `${num(s.result ? s.result.integratedDeg : s.integratedDeg, 0)}°`);
    if (s.result) {
      const v = s.result.verdict;
      const label = v === 'other' ? LABELS.scale.verdict.other(num(s.result.gyroScale, 4)) : LABELS.scale.verdict[v];
      text('scale-verdict', `${label}${s.result.gyroScale ? `  (gyroScale = ${num(s.result.gyroScale, 5)})` : ''}`);
    } else text('scale-verdict', '-');

    // sign
    const sg = sign.tool.state();
    const sp = $('sign-progress');
    if (sp) {
      sp.hidden = !(sign.active && sg.phase !== 'done');
      sp.value = sg.holdProgress;
    }
    if (!sign.active) text('sign-msg', LABELS.sign.idle);
    else if (sg.phase === 'holdA') text('sign-msg', LABELS.sign.holdA(Math.round(sg.holdProgress * 100)));
    else if (sg.phase === 'turning') text('sign-msg', `${LABELS.sign.turning} (${num(sg.movedDeg, 0)}°)`);
    else if (sg.result) text('sign-msg', LABELS.sign.verdict[sg.result.verdict]);
    text('sign-angle', sg.result ? `${num(sg.result.angleDeg, 1)}°` : '-');
    text('sign-cos', sg.result ? num(sg.result.cos, 2) : '-');
    text('sign-verdict', sg.result ? LABELS.sign.verdict[sg.result.verdict] : '-');

    // rest
    const rs = rest.tool.state();
    const rp = $('rest-progress');
    if (rp) {
      rp.hidden = !(rest.active && !rs.result);
      rp.value = rs.progress;
    }
    if (!rest.active) text('rest-msg', LABELS.rest.idle);
    else if (!rs.result) text('rest-msg', LABELS.rest.running);
    else {
      const res = rs.result;
      const why = res.pass ? LABELS.rest.pass : res.verdict === 'game_ok' ? LABELS.rest.gameOk : res.moved ? LABELS.rest.failMoved : !res.passAccel ? LABELS.rest.failAccel : !res.passGyro ? LABELS.rest.failGyro : !res.imuActive ? LABELS.rest.failImu : LABELS.rest.failMoved;
      text('rest-msg', why);
      text('rest-a', `${num(res.accelMagG, 4)} g`);
      text('rest-av', vec(res.accelMeanG, 4));
      text('rest-g', `${vec(res.gyroMeanDps, 2)}  ±  ${vec(res.gyroStdDps, 2)} °/s`);
      text('rest-verdict', `${res.verdict === 'ok' ? 'OK' : res.verdict === 'game_ok' ? 'OK for the game' : 'KO'}  (${res.samples} samples, peak ${num(res.gyroPeakDps, 1)} °/s)`);
      text('rest-z', LABELS.zSign[res.zSign]);
      if (accelState.measured !== res.zSign) {
        accelState.measured = res.zSign;
        updateGameUrl();
      }
    }
    // accelerometer sign panel
    const measuredSign = accelState.measured === 'minus' ? -1 : accelState.measured === 'plus' ? 1 : null;
    const saveBtn = $('accel-save');
    if (saveBtn) {
      saveBtn.disabled = measuredSign === null;
      saveBtn.textContent = measuredSign === null ? 'Save the measured sign' : `Save accelSign = ${measuredSign > 0 ? '+1' : '-1'}`;
    }
    {
      const sScale = loadScale(storage());
      const sSign = loadAccelSign(storage());
      text('saved-msg', savedState.note || (sScale || sSign !== null ? LABELS.saved.some(sScale ? num(sScale.gyroScale, 5) : null, sSign) : LABELS.saved.none));
    }
    text('accel-msg', accelState.note || (measuredSign !== null ? LABELS.accel.ready(measuredSign) : accelState.saved !== null ? LABELS.accel.current(accelState.saved) : LABELS.accel.idle));
  }

  function suggestions(st, d, r1) {
    const wait = { text: LABELS.suggestion.wait, detail: '' };
    const yes = (detail) => ({ text: LABELS.suggestion.ok, detail });
    const no = (detail) => ({ text: LABELS.suggestion.ko, detail });
    const out = {};
    const t = d.timings;
    out[1] = st.state === 'streaming' && t ? (t.totalMs !== null && t.totalMs <= 10_000 ? yes(`streaming after ${num(t.totalMs / 1000, 1)} s from the request`) : no('streaming slow or absent')) : wait;
    out[2] = lastPacket && lastPacket.report ? (lastPacket.length === 63 && r1 !== null && r1 >= 20 ? yes(`63 bytes, ${num(r1, 1)} Hz`) : no(`${lastPacket.length} bytes, ${r1 === null ? '-' : num(r1, 1)} Hz`)) : wait;
    const rr = rest.tool.state().result;
    out[3] = rr
      ? rr.pass
        ? rr.zSign === 'plus' ? yes(`|a| ${num(rr.accelMagG, 3)} g, Z = ${num(rr.accelMeanG.z, 3)} g`)
          : rr.zSign === 'minus' ? no(`Z = ${num(rr.accelMeanG.z, 3)} g with the buttons up: opposite sign, save accelSign = -1`)
            : no('it was not flat: Z carries less than 95% of the reading')
        : no('rest check not passed')
      : wait;
    out[4] = scale.result ? (scale.result.verdict === 'default' ? yes('about 360°') : no(`verdict: ${scale.result.verdict}`)) : wait;
    out[5] = seenButtons.size ? { text: LABELS.suggestion.ok, detail: `buttons seen: ${[...seenButtons].join(', ')}` } : wait;
    out[6] = streamingSince !== null ? (clock.now() - streamingSince >= 60_000 ? yes('connected for over 60 s') : { text: LABELS.suggestion.wait, detail: `${num((clock.now() - streamingSince) / 1000, 0)} s of 60` }) : wait;
    out[7] = lastSample && lastSample.batteryMv ? (lastSample.batteryMv >= 3000 && lastSample.batteryMv <= 4400 && lastSample.tempC > 10 && lastSample.tempC < 45 ? yes(`${lastSample.batteryMv} mV, ${num(lastSample.tempC, 1)} °C`) : no(`${lastSample.batteryMv} mV, ${num(lastSample.tempC, 1)} °C`)) : wait;
    const sr = sign.tool.state().result;
    out[8] = sr ? (sr.verdict === 'ok' || sr.verdict === 'mirrored' ? yes(sr.verdict) : no(sr.verdict)) : wait;
    const ls = latency.stats();
    out[9] = ls.count ? { text: LABELS.suggestion.ok, detail: `software part average ${num(ls.avg, 1)} ms` } : wait;
    if (isNative) {
      const info = provider.getBridgeInfo?.() ?? {};
      out[10] = st.state === 'streaming' && r1 !== null ? (r1 >= 20 && (info.dropped ?? 0) === 0 ? yes(`streaming, ${num(r1, 1)} Hz, no dropped packets`) : no(`${num(r1, 1)} Hz, ${info.dropped ?? 0} dropped`)) : wait;
      const k = kaExperiment.state(clock.now());
      out[11] = k.phase === 'done' ? (k.result.verdict === 'survived' ? yes('no drop in 60 s without keep-alive (keep-alive was not needed)') : k.result.verdict === 'dropped' ? yes(`drop after ${num(k.result.dropS, 1)} s without keep-alive (keep-alive is needed)`) : no('never connected')) : wait;
      out[12] = info.adverts?.length ? yes(formatAdverts(info.adverts)) : wait;
    }
    return out;
  }

  function frame() {
    const now = clock.now();
    if (lastSample) latency.record(now, lastSample.t);
    renderLive();
    if (now - lastSlow >= 200) {
      lastSlow = now;
      renderSlow(now);
    }
    win.requestAnimationFrame(frame);
  }
  renderBadges();
  updateGameUrl();
  renderSlow(clock.now());
  win.requestAnimationFrame(frame);
  win.addEventListener('pagehide', () => provider.dispose());
  return { provider, currentReport };
}

// Start automatically when loaded by diagnostics.html; importing the module in Node does nothing.
if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('diag-root')) {
  startDiagnostics({ document, window });
}
