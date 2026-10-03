// English UI strings of Clay Rush. OWNER: UI engineer. This is the ONLY place where player-visible text of the game lives (plus the labels of
// diagnostics.html / diagnostics-page.js, owned by the Input engineer, and the <noscript> line of index.html).
//
// Conventions:
//   - Display strings (titles, buttons, banners, HUD) are drawn with ClayDisplay (Bebas Neue), which has CAPITALS ONLY: they are written in
//     capitals here so that what you read in this file is what the player sees. Body strings (ClayUI, Barlow) use normal sentence case.
//   - American spelling for "center" is NOT used: the game says "centre" (British, like "recentre") everywhere, consistently.
//   - Placeholders are {name}; ui.js and the HUD fill them through t(key, params).
//   - The HUD keys of docs/architecture.md 8.5 are in the "hud." block; the HUD reads them through hv.t.
//
// UNVERIFIED-ON-HARDWARE: the pairing wording (SYNC button, lights) and how the Joy-Con 2 feels held like a pistol are assumptions until the
// recording session; edit the strings, not the layout.

const STRINGS_TABLE = {
  // ---------------------------------------------------------------- boot and safety
  'boot.loading': 'Loading…',
  'safety.title': 'BEFORE YOU PLAY',
  'safety.l1': 'Clear the space around you: keep at least 2 metres free in every direction.',
  'safety.l2': 'Put the wrist strap on and keep a firm grip on the Joy-Con.',
  'safety.l3': 'Never point the Joy-Con at people or pets, even as a joke.',
  'safety.l4': 'Take a break every 15 minutes. If your wrist, arm or shoulder hurts, stop.',
  'safety.l5': 'The game has bright flashes: turn on "Reduce flashes" if they bother you.',
  'safety.reduceFlash': 'REDUCE FLASHES',
  'safety.wait': 'PLEASE READ…',
  'safety.ok': "GOT IT, LET'S SHOOT",

  // ---------------------------------------------------------------- connect
  'connect.title': 'CONNECT YOUR JOY-CON',
  'connect.subtitle': 'Hold a Joy-Con 2 like a pistol: top towards the screen, ZR under your index finger.',
  'connect.steps.title': 'HOW TO CONNECT',
  'connect.step1': '1. If the Joy-Con is paired with the console or another device, turn that device off.',
  'connect.step2': '2. Hold down the small SYNC button on the Joy-Con until the lights sweep.',
  'connect.step3': '3. Press "Connect Joy-Con" and keep the lights sweeping. If Chrome opens a list, choose your Joy-Con in it.',
  'connect.step4': '4. Wait for "Connected", then calibrate your aim.',
  'connect.button': 'CONNECT JOY-CON',
  'connect.searching': 'Searching…',
  'connect.connecting': 'Connecting…',
  'connect.connected': 'Connected: Joy-Con ({side})',
  'connect.side.left': 'left',
  'connect.side.right': 'right',
  'connect.side.unknown': 'side unknown',
  'connect.battery': 'Battery: {pct}%',
  'connect.batteryUnknown': 'Battery: not available',
  'connect.batteryLevel.ok': 'Battery: good',
  'connect.batteryLevel.low': 'Battery: low',
  'connect.batteryLevel.critical': 'Battery: almost empty',
  'connect.cooldown.warning': 'After an attempt, wait about 10 seconds before the next one: quick repeated attempts can stop the Joy-Con from being found.',
  'connect.cooldown.wait': 'TRY AGAIN IN {s} S',
  'connect.cooldown.long': 'Too many attempts in a row: wait about 3 minutes, then hold SYNC again.',
  'connect.err.unsupported': 'This browser has no Web Bluetooth. Use Google Chrome on a Mac.',
  'connect.err.cancelled': 'No Joy-Con chosen. Try again when you are ready.',
  'connect.err.failed': 'Connection failed. Check that the Joy-Con is on and not connected elsewhere.',
  'connect.err.notJoycon': 'The device you chose does not look like a Joy-Con 2.',
  'connect.err.permission': 'Chrome is not allowed to use Bluetooth. Check System Settings > Privacy & Security > Bluetooth.',
  'connect.err.noData': 'The Joy-Con is connected but sends no data. Hold SYNC again and retry.',
  'connect.alt.title': 'Or play without a Joy-Con',
  'connect.alt.sim': 'SIMULATOR',
  'connect.alt.sim.desc': 'The mouse moves a virtual Joy-Con.',
  'connect.alt.mouse': 'MOUSE',
  'connect.alt.mouse.desc': 'Aim with the mouse, click to shoot.',
  'connect.diagnostics': 'Joy-Con diagnostics',
  'connect.continue': 'CONTINUE',
  'connect.back': 'BACK',
  'connect.calibrate': 'CALIBRATE AIM AGAIN',
  'connect.needCalibration': 'Calibrate your aim first: press Continue.',
  'connect.fallback.button': "CAN'T SEE IT? EXTENDED SEARCH",
  'connect.fallback.hint': 'Joy-Con not in the list? Extended search shows every nearby Bluetooth device.',
  'connect.fallback.hintExtended': 'Still nothing? Hold SYNC until the lights sweep, then try again.',
  // native Bluetooth bridge (docs/native-bridge.md): the provider hands the UI the KEY of an error or of a progress phase
  'connect.native.button': 'CONNECT JOY-CON',
  'connect.native.secondary': "NOT WORKING? TRY CHROME'S BLUETOOTH",
  'connect.native.secondaryToNative': 'TRY THE NATIVE BRIDGE',
  'connect.native.hint': 'Keep holding SYNC until "Connected" appears: a few seconds are usually enough.',
  'connect.native.cancel': 'CANCEL',
  'connect.native.countdown': 'Time left: {s} s',
  'connect.native.anyBrowser': 'No Web Bluetooth in this browser: the native bridge works anyway.',
  'connect.native.note.noCompiler': "Native bridge not available: install Apple's developer tools (in Terminal: xcode-select --install) and restart the game.",
  'connect.native.step1': '1. Turn the console off. You do not need to pair the Joy-Con in the Mac settings.',
  'connect.native.step2': '2. Press "Connect Joy-Con". The first time, macOS asks Bluetooth permission for Terminal: choose Allow.',
  'connect.native.step3': '3. Right away, hold the small SYNC button next to the USB-C port until the lights sweep.',
  'connect.native.step4': '4. Wait for "Connected", then calibrate your aim.',
  'connect.native.progress.checking': 'Checking the Bluetooth bridge…',
  'connect.native.progress.starting': 'Starting the Bluetooth bridge…',
  'connect.native.progress.building': 'Preparing the Bluetooth bridge (first time only, a few seconds)…',
  'connect.native.progress.waitingBluetooth': "Waiting for the Mac's Bluetooth. If macOS asks for permission, choose Allow.",
  'connect.native.progress.scanning': 'Looking for the Joy-Con. Hold SYNC now until the lights sweep.',
  'connect.native.progress.connecting': 'Joy-Con found. Connecting…',
  'connect.native.progress.discovering': "Reading the Joy-Con's services…",
  'connect.native.progress.initialising': 'Preparing the Joy-Con…',
  'connect.native.progress.waitingData': 'Waiting for the first motion data…',
  'connect.err.native.permission': 'macOS does not let this app use Bluetooth. Restart the game with start.command and allow Bluetooth. Declined before? System Settings > Privacy & Security > Bluetooth: turn on Terminal.',
  'connect.err.native.bluetoothOff': "The Mac's Bluetooth is off. Turn it on, then try again.",
  'connect.err.native.noDevice': 'No Joy-Con found. Hold SYNC until the lights sweep, close to the Mac. Tried many times? Wait a minute first.',
  'connect.err.native.notPairing': 'A Joy-Con was seen, but it is not in pairing mode. Hold SYNC until the lights sweep and try again.',
  'connect.err.native.connectFailed': "Can't connect to the Joy-Con. Wait a few seconds, hold SYNC and try again.",
  'connect.err.native.gatt': 'The connection to the Joy-Con failed. Wait a few seconds and try again.',
  'connect.err.native.lost': 'The Joy-Con disconnected. Hold SYNC until the lights sweep, then reconnect.',
  'connect.err.native.noData': 'The Joy-Con is connected but sends no motion data. Hold SYNC and try again.',
  'connect.err.native.stalled': 'The Bluetooth bridge stopped responding. Try again in a few seconds.',
  'connect.err.native.crashed': 'The Bluetooth bridge stopped. Try again; if it happens again, restart the game with start.command.',
  'connect.err.native.helperFailed': 'The Bluetooth bridge will not start. Close the game and restart it with start.command.',
  'connect.err.native.buildFailed': "Can't prepare the Bluetooth bridge. Install Apple's developer tools (xcode-select --install) and restart. Meanwhile use the simulator or the mouse.",
  'connect.err.native.unavailable': 'The Bluetooth bridge is not available. Use Chrome with Web Bluetooth, the simulator or the mouse.',
  'connect.err.native.oldServer': 'The game was started with an old version. Close it and reopen it with start.command.',
  'connect.err.native.noServer': "Can't reach the game. Check that the Terminal window is still open.",
  'connect.err.native.busy': 'The Bluetooth bridge is already in use (another game tab?). Close it and try again.',
  'connect.err.native.refused': 'The Bluetooth bridge refused the request. Open the game from the address start.command shows.',
  'connect.err.native.unknown': 'Something went wrong with the Bluetooth bridge. Try again.',

  // ---------------------------------------------------------------- calibration (C-06)
  'cal.title': 'AIM CALIBRATION',
  'cal.s1.title': 'HOLD IT STILL',
  'cal.s1.text': 'Hold the Joy-Con still with its top pointing up. You can also stand it on a table.',
  'cal.s2.title': 'POINT AT THE SCREEN',
  'cal.s2.text': 'Point it at the screen like a pistol and hold it still.',
  'cal.s3.title': 'CENTRE YOUR AIM',
  'cal.s3.text': 'Aim at the centre of the screen and press {button}. Or hold still for 3 seconds.',
  'cal.s4.text': 'SHOOT THE CLAY: PRESS {fire}!',
  'cal.s4.textClick': 'SHOOT THE CLAY: CLICK ON IT!',
  'cal.s4.paused': 'PAUSED: PRESS ANY BUTTON',
  'cal.s4.lost': 'Missed? No problem: another clay is on its way.',
  'cal.still': 'Hold still…',
  'cal.moved': "You moved. Let's start that step again.",
  'cal.badPose': 'The two poses are too similar. Step 1: top up. Step 2: pointing at the screen.',
  'cal.badAccel': 'The sensor reads an unusual value. Stand the Joy-Con on a flat table and try again.',
  'cal.timeout': 'This step timed out. Try again.',
  'cal.noData': 'The Joy-Con sends no data. Check the connection.',
  'cal.noCalibration': 'Calibration is missing. Run the full calibration.',
  'cal.signUnknown': 'Could not measure the direction of rotation. If the crosshair moves the wrong way, calibrate again.',
  'cal.ok': 'Calibration complete! Nice shot.',
  'cal.retry': 'CALIBRATE AGAIN',
  'cal.tryAgain': "Can't hit the clay? Calibrate again.",
  'cal.quick': 'JUST RECENTRE',
  'cal.quick.hint': 'Same grip as before? Just recentre.',
  'cal.flipX.hint': 'Crosshair moving the wrong way?',
  'cal.flipX.button': 'FLIP LEFT AND RIGHT',

  // ---------------------------------------------------------------- menu
  'menu.title': 'CLAY RUSH',
  'menu.tagline': 'Call "Pull!", swing, lead the clay, shoot.',
  'menu.classic': 'CLASSIC',
  'menu.classic.desc': 'Tour of the range: three stages, two shells per pull.',
  'menu.timeattack': 'TIME ATTACK',
  'menu.timeattack.desc': 'Waves of one or two clays. Breaks add time to the clock.',
  'menu.zen': 'ZEN',
  'menu.zen.desc': 'Practice at your pace. No score, no clock.',
  'menu.best': 'BEST {n}',
  'menu.bestFor': 'BEST ({detail}) {n}',
  'menu.best.none': 'NO SCORE YET',
  'menu.best.zen': 'FREE PRACTICE',
  'menu.bestScores': 'BEST SCORES',
  'menu.settings': 'SETTINGS',
  'menu.controller': 'CONTROLLER',
  'menu.provider.joycon': 'Joy-Con ({side})',
  'menu.provider.sim': 'Simulator',
  'menu.provider.mouse': 'Mouse',

  // ---------------------------------------------------------------- setup (difficulty and stage)
  'setup.difficulty': 'DIFFICULTY',
  'setup.stage': 'STAGE',
  'setup.start': 'START',
  'setup.back': 'BACK',
  'setup.classic.note': 'Classic plays all three stages in order.',
  'difficulty.easy': 'EASY',
  'difficulty.normal': 'NORMAL',
  'difficulty.hard': 'HARD',
  'difficulty.easy.desc': 'The clays fly much closer: big targets, a wider pattern, half the wind.',
  'difficulty.normal.desc': 'The standard range.',
  'difficulty.hard.desc': 'The clays fly far away and the pellets need a little lead.',
  'stage.meadow': 'MORNING MEADOW',
  'stage.hills': 'GOLDEN HILLS',
  'stage.alpine': 'ALPINE DUSK',
  'stage.meadow.desc': 'Spring morning, no wind. Going-away singles.',
  'stage.hills.desc': 'Late afternoon, steady breeze. Crossers and doubles.',
  'stage.alpine.desc': 'Dusk in the mountains, gusty wind. High birds and rabbits.',

  // ---------------------------------------------------------------- countdown
  'countdown.go': 'GO!',
  'countdown.classic': 'STAGE 1: {stage}',

  // ---------------------------------------------------------------- HUD (docs/architecture.md 8.5) and in-round
  'hud.score': 'SCORE',
  'hud.best': 'BEST',
  'hud.pull': 'PULL {n}/{total}',
  'hud.pullPrompt': 'PRESS {fire} TO CALL PULL!',
  'hud.pullPromptClick': 'CLICK TO CALL PULL!',
  'hud.zenStage': 'ZEN · {name}',
  'hud.timeAttackStage': 'TIME ATTACK · {name}',
  'hud.reloading': 'RELOADING',
  'hud.wind': '{speed} M/S',
  'hud.time': '{s}',
  'hud.stage': 'STAGE {n}: {name}',
  'hud.stageCard.title': 'STAGE {n}',
  'hud.stageCard.name': '{name}',
  'hud.banner.double': 'DOUBLE!',
  'hud.banner.twoWithOne': 'TWO WITH ONE!',
  'hud.banner.smoked': 'SMOKED!',
  'hud.banner.streak': 'STREAK x{n}',
  'hud.banner.perfect': 'PERFECT STAGE',
  'hud.banner.timeUp': 'TIME!',
  'hud.banner.newBest': 'NEW BEST!',
  'hud.lowBattery': 'Joy-Con battery low',
  'hud.zen.stats': '{hits} HITS, {acc}% OF THE LAST 20',
  'hud.dry': 'EMPTY',
  'hud.multiplier': 'x{n}',
  'hud.recentered': 'Aim recentred',

  // ---------------------------------------------------------------- pause
  'pause.title': 'PAUSED',
  'pause.resume': 'RESUME',
  'pause.recentre': 'RECENTRE AIM',
  'pause.settings': 'SETTINGS',
  'pause.quit': 'QUIT TO MENU',
  'pause.endSession': 'END SESSION',
  'pause.tip': 'Rest your arm: shake out your wrist and breathe.',
  'pause.autoBlur': 'Paused: this window is no longer in front.',
  'pause.resuming': '{n}',
  'pause.confirm.title': 'QUIT THIS ROUND?',
  'pause.confirm.text': 'Your score for this round will be lost.',
  'pause.confirm.yes': 'YES, QUIT',
  'pause.confirm.no': 'KEEP PLAYING',

  // ---------------------------------------------------------------- results
  'results.title.complete': 'ROUND COMPLETE',
  'results.title.timer': "TIME'S UP",
  'results.title.quit': 'ROUND OVER',
  'results.title.zen': 'SESSION OVER',
  'results.score': 'SCORE',
  'results.best': 'BEST {n}',
  'results.newBest': 'NEW BEST!',
  'results.rank': 'RANK',
  'results.broken': 'BROKEN',
  'results.brokenValue': '{broken}/{presented}',
  'results.accuracy': 'ACCURACY',
  'results.accuracyNone': '–',
  'results.streak': 'BEST STREAK',
  'results.doubles': 'DOUBLES',
  'results.hits': 'HITS',
  'results.shots': 'SHOTS',
  'results.assist': 'Aim assist was on',
  'results.again': 'PLAY AGAIN',
  'results.menu': 'MENU',

  // ---------------------------------------------------------------- best scores
  'best.title': 'BEST SCORES',
  'best.classic': 'CLASSIC',
  'best.timeattack': 'TIME ATTACK: {stage}',
  'best.empty': '–',
  'best.assist': '* = aim assist was on',
  'best.back': 'BACK',
  'best.note': 'Best score per mode and difficulty. Zen keeps no score.',

  // ---------------------------------------------------------------- settings (docs/architecture.md 8.4)
  'settings.title': 'SETTINGS',
  'settings.group.aim': 'AIM AND TRIGGER',
  'settings.group.game': 'GAME AND COMFORT',
  'settings.sensitivity': 'Sensitivity',
  'settings.sensitivity.hint': 'How far the crosshair moves when you turn the Joy-Con.',
  'settings.aimCurve': 'Aim curve',
  'settings.aimCurve.hint': 'Precise: steady for slow aiming. Fast: big swings with little wrist movement.',
  'settings.aimCurve.precise': 'PRECISE',
  'settings.aimCurve.balanced': 'BALANCED',
  'settings.aimCurve.fast': 'FAST',
  'settings.triggerButton': 'Trigger',
  'settings.triggerButton.hint': 'The button that shoots. The other one recentres the aim.',
  'settings.triggerButton.ZR': 'ZR',
  'settings.triggerButton.R': 'R',
  'settings.triggerCompMs': 'Trigger steadiness',
  'settings.triggerCompMs.hint': 'Pulling the trigger jerks the wrist: the shot uses your aim this many milliseconds earlier.',
  'settings.triggerCompMs.value': '{n} MS',
  'settings.aimAssist': 'Aim assist',
  'settings.aimAssist.hint': 'Light: a slightly wider pattern that leans towards a nearby clay. Scores are marked.',
  'settings.aimAssist.off': 'OFF',
  'settings.aimAssist.light': 'LIGHT',
  'settings.autoCenter': 'Auto-recentre',
  'settings.autoCenter.hint': 'When you hold still, the crosshair glides back to the centre.',
  'settings.flipX': 'Flip left and right',
  'settings.flipX.hint': 'Turn this on if the crosshair moves the wrong way.',
  'settings.autoPull': 'Auto pull',
  'settings.autoPull.hint': 'Classic: the clays are called for you shortly after the gun is loaded.',
  'settings.rumble': 'Rumble',
  'settings.rumble.hint': 'The Joy-Con vibrates on every shot.',
  'settings.crosshairColor': 'Crosshair',
  'settings.crosshairColor.hint': 'Pick the colour you see best against the sky.',
  'settings.crosshairColor.white': 'White',
  'settings.crosshairColor.yellow': 'Yellow',
  'settings.crosshairColor.green': 'Green',
  'settings.crosshairColor.magenta': 'Magenta',
  'settings.volume': 'Volume',
  'settings.volume.hint': 'Press M at any time to mute.',
  'settings.reduceFlash': 'Reduce flashes',
  'settings.reduceFlash.hint': 'No full-screen flashes and softer muzzle flashes.',
  'settings.reduceMotion': 'Reduce motion',
  'settings.reduceMotion.hint': 'No camera shake, no slow-motion zoom, fewer particles.',
  'settings.on': 'ON',
  'settings.off': 'OFF',
  'settings.tune': 'AIM AND TRIGGER TUNING',
  'settings.reset': 'RESET BEST SCORES',
  'settings.reset.confirm': 'DELETE ALL BEST SCORES?',
  'settings.reset.text': 'This cannot be undone.',
  'settings.reset.yes': 'YES, DELETE',
  'settings.reset.no': 'CANCEL',
  'settings.reset.done': 'Best scores deleted.',
  'settings.back': 'BACK',
  'settings.percent': '{n}%',

  // ---------------------------------------------------------------- aim and trigger tuning
  'tune.title': 'AIM AND TRIGGER TUNING',
  'tune.intro': 'Aim at the ring and press {fire}. Watch how much the shot moves, then adjust.',
  'tune.speed': 'Pointer speed',
  'tune.speedValue': '{n} °/S',
  'tune.lastShot': 'LAST SHOT',
  'tune.jerk': 'Trigger jerk',
  'tune.jerkValue': '{n} °/S',
  'tune.drift': 'Shot moved',
  'tune.driftValue': '{n} PX',
  'tune.comp': 'Compensation',
  'tune.compValue': '{n} MS',
  'tune.none': 'Press {fire} to take a test shot.',
  'tune.invalid': 'No reading for that shot: hold the Joy-Con steady and try again.',
  'tune.verdict.good': 'Steady shot: the compensation works.',
  'tune.verdict.bad': 'The shot moved a lot: raise "Trigger steadiness" or squeeze the trigger more gently.',
  'tune.mouseNote': 'Trigger readings need a Joy-Con: the mouse and the simulator have no trigger jerk. You can still try the aim settings here.',
  'tune.back': 'BACK',

  // ---------------------------------------------------------------- overlays
  'disc.title': 'JOY-CON DISCONNECTED',
  'disc.text': 'The game is paused. Trying to reconnect…',
  'disc.textIdle': 'Trying to reconnect…',
  'disc.failed': "Can't reconnect. Check the battery and move closer to the Mac.",
  'disc.cooldown': 'Wait about 10 seconds before trying again.',
  'disc.wait': 'TRY AGAIN IN {s} S',
  'disc.retry': 'TRY AGAIN',
  'disc.useMouse': 'CONTINUE WITH THE MOUSE',
  'disc.menu': 'BACK TO MENU',
  'disc.recovered': 'Joy-Con reconnected! Hold it still to recentre.',
  'disc.recentering': 'Recentring… hold still',
  'disc.native.text': 'The Joy-Con disconnected. Hold SYNC until the lights sweep, then press "Reconnect".',
  'disc.native.retry': 'RECONNECT',
  'disc.native.wait': 'RECONNECT IN {s} S',

  // ---------------------------------------------------------------- hint line (glyph labels of the active controller)
  'hint.move': 'Move',
  'hint.select': 'Select',
  'hint.back': 'Back',
  'hint.change': 'Change',
  'hint.fire': 'Shoot',
  'hint.pull': 'Pull!',
  'hint.recentre': 'Recentre',
  'hint.pause': 'Pause',
  'hint.resume': 'Resume',
  'hint.continue': 'Continue',
  'hint.stick': 'STICK',
  'hint.arrows': 'ARROWS',
  'hint.click': 'CLICK',

  // ---------------------------------------------------------------- misc
  'audio.muted': 'Audio muted',
  'audio.unmuted': 'Audio on',
  'mode.classic': 'CLASSIC',
  'mode.timeattack': 'TIME ATTACK',
  'mode.zen': 'ZEN',
};

/** @type {Readonly<Record<string,string>>} */
export const STRINGS = Object.freeze({ ...STRINGS_TABLE });
export const STRING_KEYS = Object.freeze(Object.keys(STRINGS));

// Development builds throw on a missing key, production builds return the key. Node (tests) and ?debug=1 are development;
// a throwing t() inside the render loop of a real session would freeze the game, so the browser default is lenient.
let strict = typeof window === 'undefined';

/** Switch strict (throwing) mode on or off. The presentation turns it on for ?debug=1. */
export function setStrictStrings(on) {
  strict = !!on;
}

export function isStrictStrings() {
  return strict;
}

/**
 * Look up a string and replace {name} placeholders.
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function t(key, params) {
  const text = STRINGS[key];
  if (text === undefined) {
    if (strict) throw new Error(`strings.en.js: missing key "${key}"`);
    return key;
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** Decimal point, fixed digits (one by default): 1 -> "1.0". */
export function formatDecimal(value, digits = 1) {
  return Number(value).toFixed(digits);
}

/** Thousands separator for scores: 12345 -> "12,345". */
export function formatScore(n) {
  const v = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
