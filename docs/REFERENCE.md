# Clay Rush: reference

The details that the [README](../README.md) leaves out: the game rules, controls and settings (part 1), the developer notes (part 2) and how the project was made (part 3). For setup, connection, calibration, troubleshooting, the hardware checklist and the recording session, read [the guide](GUIDE.md). Every game number below is a starting value that lives in `public/js/game/config.js` (aim values in `public/js/motion/motion-config.js`); [`game-design.md`](game-design.md) explains each one.

## Part 1. Rules, controls and settings

### Aiming

**How you turn the Joy-Con** moves the crosshair, like a mouse: turn left and it goes left, raise the top and it goes up. It is a relative gyro pointer (the same pipeline as the previous game, `docs/motion-contract.md`): turns slower than 5 degrees per second are ignored (hand tremor), and the faster you turn, the further the crosshair travels per degree, so slow turns aim precisely and a fast swing crosses the screen. The "Aim curve" setting picks the gains (below), "Sensitivity" multiplies them. When you hold still, "Auto-recentre" glides the crosshair back to the centre; **R** recentres at once. The Joy-Con reports 33 times per second, so the crosshair is interpolated between reports and extrapolated by at most 35 ms.

The mouse is an absolute pointer (the cursor is the aim) and the simulator is an absolute virtual gun driven by the mouse; neither needs a calibration.

### The shot

- The gun is an over-and-under: **two shells per pull** in Classic. Firing an empty gun gives a dry click and no shot.
- **The hit test is in screen space at the instant of the shot**: a clay is hit when the distance from the aim point to its centre is at most the pattern radius plus the clay radius. The pattern radius is `0.10 + 0.018 x depth` metres (0.46 m at 20 m), about 34 to 38 px on screen at Normal; the difficulty and Zen multiply it.
- **Centre hit** ("SMOKED!"): within 0.35 of the pattern radius. A bigger burst, +50 points, and the kill cam may trigger (slow motion x0.25 for 0.45 s on a centre hit that ends a double or a stage, or on the gold clay; off with "Reduce motion").
- One shot can break several clays: each one scores, plus "TWO WITH ONE!" (+200).
- **Trigger compensation**: with a Joy-Con the shot uses the aim from "Trigger steadiness" milliseconds (default 40) before the press, taken from the aim history, where the press time is the time of the first report that shows the trigger down. The mouse, the keyboard and the simulator use 0.
- **Hard** resolves the shot after the pellet travel time (depth / 650 m/s), at the clay's later position, so you must lead. Easy and Normal resolve at once.

### Controls

| Action | Right Joy-Con | Left Joy-Con | Keyboard | Mouse |
|---|---|---|---|---|
| Aim | turn the Joy-Con | turn the Joy-Con | none | move |
| Shoot | ZR | ZL | F | left button press |
| Call "Pull!" (Classic, gun loaded) | ZR, or A, Y, X | ZL, or Down, Right, Up | F or Enter | left click |
| Recentre the aim | R | L | C or Space | double click |
| Pause | + | - or Capture | P or Esc | middle click |
| Menus: move | stick | stick | arrow keys | the pointer |
| Menus: select | A, Y or X | Down, Right or Up | Enter | click |
| Menus: back | B | Left | Esc | right click |

The setting "Trigger" set to **R** swaps the trigger and the recentre button (R shoots and ZR recentres; L and ZL on a Left unit). **M** mutes and unmutes. The rail buttons (SL, SR), HOME and the stick clicks are never mapped: the rail is where a strap or a hand touches the Joy-Con. A real Joy-Con never selects a menu item by pointing at it; the mouse clicks menu items. The game pauses by itself when the window loses focus, when the tab is hidden and when the Joy-Con disconnects. Sound starts after your first click or key press (a Chrome rule).

### Modes

| | Classic | Time Attack | Zen |
|---|---|---|---|
| Goal | best score over three stages | best score in 90 seconds | practice |
| Launches | you call each pull ("Pull!"), or "Auto pull" calls it 1.2 s after the gun is loaded | automatic, one wave of 1 or 2 clays at a time | automatic, one wave at a time (gap 1.2 s, 30 percent doubles) |
| Shells | 2 per pull | each wave refills the gun to 2 | unlimited |
| Clock | none | 90 s, +1.5 s per break for the first 20, +0.75 s up to break 40, then +0.25 s; at most 120 s shown; ends at 0 or after 180 s | none |
| Distance | the difficulty | the difficulty | the Easy distance (0.55) |
| Rank | share of clays broken: S 95, A 85, B 70, C 50 percent, D below | score: S 9000, A 6500, B 4500, C 2500, D below | none ("END SESSION" in the pause panel shows hits and accuracy) |

**Time Attack waves**: a wave is a double with a probability that rises from 15 percent at the start to 60 percent at 90 s. The next wave starts when every clay of the previous one is broken or lost, after a gap that shrinks from 1.4 s to 0.5 s; there is no other reload, so two misses leave the gun empty until the next wave. The first wave comes after 1 s. At most one gold clay per round.

### Stages (Classic)

| Stage | Pulls | Clays | Content | Wind |
|---|---|---|---|---|
| 1 Morning Meadow | 10 | 10 | singles from the trap house, 18 to 22 m/s, one mini in the last 3 pulls | none |
| 2 Golden Hills | 8 | 12 | 4 skeet crossers (left and right), 4 doubles (skeet pair or trap pair 0.4 s apart), one gold clay | steady 1.5 m/s |
| 3 Alpine Dusk | 8 | 14 | 2 tower singles, 3 mixed doubles, 2 rabbit and clay, a battue double at the end | 2.5 m/s with gusts of 1 m/s |

Between stages a 2.5 s stage card. Time Attack and Zen play one stage of your choice (default Golden Hills). Every throw is checked at launch to stay at least 1.2 s in view (the fairness rule).

### Clays

| Kind | Size | Flight | Points |
|---|---|---|---|
| standard | 0.6 m (an arcade size; a real clay is 0.11 m) | ballistic with drag | 100 |
| mini | 0.38 m | 1.25 x faster | 150 |
| battue | 0.6 m, edge-on | fast (x1.2) and flat, dips suddenly at the end | 150 |
| rabbit | 0.6 m wheel | rolls and hops along the ground | 150 |
| gold | 0.6 m | like a standard, at most one per stage, never in Zen | 300 |

A clay is lost when it lands, flies out of range, leaves the screen or after 6 s.

### Scoring

| Event | Points |
|---|---|
| Hit | the points of the kind |
| Centre hit ("SMOKED!") | +50 |
| First barrel (broken with the first shell of the pull) | +25 |
| Distance | +4 per metre beyond 25 m (measured at the Normal distance, so a throw scores the same at every difficulty) |
| Double (both clays of a double) | +100, "DOUBLE!" |
| Two with one shot | +200 |
| Perfect stage (every clay of a stage) | +500, "PERFECT STAGE" |

Everything is multiplied by the streak: x1 (0 to 2 breaks in a row), x2 (3 to 5), x3 (6 to 9), x4 (10 and more). A lost clay resets the streak; a missed shot alone does not.

### Difficulty

The difficulty changes the **distance** (owner decision, 2026-10-03): the whole world (house positions, speeds, gravity, wind) is scaled by a factor `k`, so the clays trace about the same paths on screen while they and the shot pattern look `1/k` times bigger.

| | Easy | Normal | Hard |
|---|---|---|---|
| Distance (world scale k) | 0.55 (clays about 1.8 x bigger) | 1 | 1.45 (clays about 0.7 x as big) |
| Clay speed | x0.9 | x1 | x1 |
| Pattern radius | x1.15 | x1 | x1 |
| Shot | instant | instant | pellet travel at 650 m/s |
| Wind | x0.5 | x1 | x1.2 |

The backdrop zooms with the distance: the far and near layers are scaled by `k` to the power -0.35, kept between 0.8 and 1.4 (Easy about 1.23, Hard about 0.88), eased over a third of a second, or changed at once with "Reduce motion". It is cosmetic: the game logic does not use it.

### Settings

From the menu choose "SETTINGS"; changes apply at once and are remembered by the browser (`localStorage` key `clayRush.v1`; if storage is blocked they are kept in memory for the session). The key in brackets is the name used by `__clay.setSetting`.

| Setting | Range | Default |
|---|---|---|
| Sensitivity (`sensitivity`) | 0.5 to 3.0 in steps of 0.1 | 1.0 |
| Aim curve (`aimCurve`) | `precise` (6 to 17 px per degree, vertical cap 13), `balanced` (8 to 24, cap 19), `fast` (11 to 32, cap 25) | `balanced` |
| Trigger (`triggerButton`) | `ZR` or `R` | `ZR` |
| Trigger steadiness (`triggerCompMs`) | 0 to 100 ms in steps of 10 | 40 |
| Aim assist (`aimAssist`) | off, or Light: pattern x1.15 and the aim pulled 25 percent of the way towards a clay within 1.6 pattern radii; results marked "assist" | off |
| Auto-recentre (`autoCenter`) | on or off (always off for the simulator) | on |
| Flip left and right (`flipX`) | on or off | off |
| Auto pull (`autoPull`) | on or off | off |
| Rumble (`rumble`) | on or off: rumble preset 5 on every shot | on |
| Crosshair (`crosshairColor`) | `white`, `yellow`, `green`, `magenta` | `white` |
| Volume (`volume`) | 0 to 1 in steps of 0.1 | 0.8 |
| Reduce flashes (`reduceFlash`), Reduce motion (`reduceMotion`) | on or off | off |

The menu also remembers the last difficulty (`difficulty`, default `normal`) and stage (`stage`, default `hills`). "RESET BEST SCORES" clears the records after a confirmation. "AIM AND TRIGGER TUNING" shows the pointer speed and, 160 ms after every trigger press, the "Trigger jerk" and "Shot moved" readings (the guide explains how to use them). The aim gains are about 1.6 times those of the previous game's sword (`MOTION_CONFIG.shooter`), raised after the owner's first play session; UNVERIFIED-ON-HARDWARE.

## Part 2. Developer notes

Nothing in this part is needed to play.

### Tests

```bash
npm test                 # everything: unit, integration (Node) and end-to-end (headless Chrome)
npm run test:unit        # everything except the browser
npm run test:e2e         # only the headless-Chrome suite
```

The tests use Node's built-in test runner only (`node --test`): there are no test dependencies. Every script sets `--test-timeout=120000`, so a stuck test fails after two minutes instead of hanging. On the development Mac (macOS 26.6, Node 24.15, 2026-10-03) `npm run test:unit` ran **1164 tests, 1164 passed, 0 skipped, in about 15 seconds**; this is what the GitHub Actions workflow runs (on macOS with Node 22; the bridge suites need clang). `npm test` adds the headless-Chrome suite (nine files under `test/e2e/`) and needs Google Chrome: set `CHROME_PATH` to point at a Chrome binary, `E2E_SCREENSHOTS=/some/folder` to keep screenshots, or `E2E_OPTIONAL=1` to accept a run without the browser tests (they are then reported as skipped, never as passed).

| Layer | Where | What it proves |
|---|---|---|
| Contracts and architecture guards | `test/shared`, `test/architecture` | type definitions and validators agree, import boundaries hold, the documents are in English and their links work, the name "Clay Rush" is used everywhere a player reads it |
| Modules | `test/input`, `test/motion`, `test/game`, `test/render`, `test/audio`, `test/ui`, `test/assets` | the packet parser against the test packets, the Bluetooth state machine against a **fake** Bluetooth stack, the trigger timing, the motion pipeline, game rules, physics, fairness and determinism, the audio recipes, the UI state machine, the optional art loader |
| Whole app in Node | `test/app` | the real `app.js` with a fake canvas on a manual clock: rounds played by a bot, the simulator, the native and Web Bluetooth paths, stick navigation, flags |
| Server and native bridge | `test/server`, `test/bridge` | static server security and MIME types, `start.command`, the helper compiles and passes its self-test (it never touches Bluetooth), the whole chain with a **fake helper process** |
| End to end | `test/e2e` | headless Chrome over the DevTools protocol: everything stays on localhost, a bot plays Classic, Time Attack and Zen, determinism, keyboard, settings, the simulator calibration, storage failure, audio, the art and `?assets=0`, viewports, the diagnostics page, a performance smoke test |

The Bluetooth and simulator tests run against **models of the protocol document**, so a green test proves the code follows the document, never that a physical Joy-Con behaves like it (UNVERIFIED-ON-HARDWARE).

### URL flags

All flags are optional, go after `?` and are joined with `&`, for example `http://localhost:8141/?input=sim&seed=7`. Wrong values are ignored and reported in Chrome's console (they never crash the game). Source: `public/js/flags.js` (and `public/js/render/fonts.js` for `fonts`).

| Flag | Values | Default | Effect |
|---|---|---|---|
| `input` | `native`, `joycon`, `sim`, `mouse` | connect screen | choose the control method at start: `native` = the native Bluetooth bridge, `joycon` = Chrome's Web Bluetooth (both are created without connecting: the connect screen's button connects), `sim` and `mouse` connect at once |
| `mode` | `classic`, `timeattack`, `zen` | none | skip the menu and start that mode; implies `skipsafety=1` and, without `input`, `input=mouse` |
| `difficulty` | `easy`, `normal`, `hard` | the saved choice | the difficulty of the `mode` round |
| `stage` | `meadow`, `hills`, `alpine` | the saved choice | the stage of a Time Attack or Zen `mode` round |
| `seed` | integer | random per round | fixed seed for every round (the same clays every time) |
| `skipsafety` | `1` | off | skip the safety screen without remembering your agreement |
| `skipcountdown` | `1` | off | with `mode`, start without the 3-2-1 |
| `clock` | `manual` | real | manual clock: time moves only through `__clay.advance(ms)` (tests and agents) |
| `debug` | `1` | off | check every game snapshot and event against the contracts and look up every text strictly; problems go to the console |
| `mute` | `1` | off | never create the audio context |
| `reducemotion`, `reduceflash` | `1` | off | force the accessibility settings on (not remembered) |
| `haptics` | `0` | on | no rumble for the session |
| `assets` | `0`, `off` | on | turn the optional generated art off: no picture and no font file is requested and everything is drawn procedurally |
| `fonts` | `0`, `off` | on | keep the art but use the system fonts instead of Bebas Neue and Barlow; implied by `assets=0` |
| `simhz` | 10 to 1000 | 66 | simulator packet rate |
| `simmount` | `faceUp`, `faceSide`, `upsideDown`, `tipFlipped`, `tilted`, `sideRail` | `faceUp` | how the virtual Joy-Con is held |
| `simside` | `L`, `R` | `R` | virtual Joy-Con side |
| `simmirror` | `1` | off | mirrored gyroscope sign in the simulator |
| `simgyro` | `alt` | default | the alternative gyroscope scale in the simulator |
| `simseed` | integer | 1 | simulator noise and timing-jitter seed |
| `simcal` | `1` | off | run the real calibration wizard against the simulator instead of its exact built-in calibration |
| `simaccelsign` | `-1` | `1` | the simulator models a sensor with the opposite gravity sign (to test `accelsign`) |
| `filter` | `lenient`, `strict`, `all` | `lenient`, or the filter that worked last time | which devices Chrome's Bluetooth list offers (Web Bluetooth only): any Joy-Con 2 by product id, only Joy-Cons in pairing mode, or every device nearby |
| `mask` | `0xB7`, `0xFF`, `0x37` (always with `0x`) | `0xB7` | which sensor fields the Joy-Con is asked to send |
| `side` | `L`, `R` | both | which Joy-Con the list offers or the bridge looks for |
| `accelsign` | `1`, `-1` | saved value, else `1` | sign of the accelerometer (the diagnostics page measures it) |

`?input=bridge` (an old reserved name) is ignored with a warning: use `native`.

### Automation: `window.__clay`

`window.__clay` (`public/js/clay-api.js`) is always present and is what the end-to-end tests and the bots use. Under `?clock=manual` the game moves only when you call `advance` (or a call that waits for frames), so a run is a pure function of the seed and the calls.

```js
await __clay.ready;                                        // boot finished
__clay.start('classic', { difficulty: 'hard', seed: 1 }); // plays at once: skipCountdown and autoLaunch default to true
__clay.advance(1000);                                      // manual clock only, frames of at most 16 ms
const s = __clay.snapshot();                               // plain JSON: the game snapshot plus screen, overlay, aim, provider, calibrated, nowMs
const r = await __clay.shootTarget(s.targets[0].id, { leadMs: 60 }); // aims at the projected clay and fires: {events, shot, hit}
await __clay.fire({ x: 960, y: 400 });                     // a shot there (source 'debug', no compensation): {events, shot}
await __clay.callPull();                                   // Classic, phase ready: {events, called}
__clay.aim(800, 500); __clay.press('pause'); __clay.nav('down');
__clay.setSetting('aimCurve', 'fast'); __clay.getSettings(); __clay.setSeed(7);
__clay.getMotionState(); __clay.getUiState(); __clay.getCalibration(); __clay.getConfig(); __clay.getAssets(); __clay.getPerf();
__clay.debug.spawn({ kind: 'gold', house: 'trap' });       // launch targets now; returns their ids
__clay.sim?.fire();                                        // ?input=sim: pull the simulated trigger through the whole input chain
```

- `start(mode, {difficulty, stage, seed, skipCountdown = true, autoLaunch = true})`: `autoLaunch` makes Classic call every pull by itself; `false` stops every automatic launch.
- `fire()` and `shootTarget()` resolve with the game events of the 150 ms after the shot (Hard pellet travel included); under the manual clock they advance the clock themselves.
- `press(action)` accepts `fire`, `confirm`, `back`, `pause`, `recenter`; `nav(dir)` accepts `up`, `down`, `left`, `right` (one stick flick or arrow key).
- Also: `pause()`, `resume()`, `reanchor(x, y)`, `now()`, `version`, `manualClock`; `debug.autoLaunch(on)`, `debug.forceScreen(screen)`, `debug.getLog()`, `debug.getCounters()`, `debug.getMotionDebug()`, `debug.setCalibration(cal)`, `debug.getProviderStatus()`, `debug.getAudio()`, `debug.getWakeLock()`, `debug.draw()`, `debug.getWorld()`, `debug.getUiView()`; `sim.setTarget`, `sim.setPose`, `sim.clearPose`, `sim.playCalibrationScript`, `sim.simulateLoss`, `sim.simulateRecovery`, `sim.getTruth`.

Coordinates are playfield pixels (1920 x 1080). The contract is `docs/architecture.md` section 9.3, and later additions are in `docs/contract-notes.md`.

### Performance

The design targets are 60 fps at 1080p, game physics in fixed steps of 1/120 s and less than 50 ms from sensor to screen. Measured with `node --test test/e2e/perf.test.js` on the development Mac on 2026-10-03: headless Chrome 154 at 1920 x 1080, the simulator, the generated art and both web fonts, 20 seconds of Classic on the real clock, with other work running on the same machine.

| Measure | Value |
|---|---|
| Frame interval (1200 frames) | 16.67 ms on average (60.0 fps), p99 16.8 ms, max 16.8 ms, no long tasks |
| JavaScript cost of one frame (game step plus drawing) | 1.03 ms on average, p95 1.8 ms, p99 2.1 ms, worst 14.3 ms |
| The same with `?assets=0` (procedural drawing) | 1.17 ms on average |
| Input to draw (software only) | about 11 ms |

These numbers describe a headless Chrome with a software rasteriser. They say nothing about your display or GPU, and nothing about the Bluetooth part of the delay: the 60 fps and 50 ms targets on real hardware are UNVERIFIED-ON-HARDWARE.

### The art layer (optional generated pictures)

The look has two layers. The **procedural drawing** paints everything with canvas paths and gradients (sky, hills, houses, clays with a rim, the gun silhouette) and needs no file at all: it is the complete fallback and what most tests exercise. The **generated art** in `public/assets/` adds three stages with two backdrop layers each (a far JPEG and a near transparent PNG, in `backgrounds/`), the clays, shards, launch houses, effects and icons (`sprites/`), the gun and the logo (`ui/`) and three font files (`fonts/`). `public/assets/manifest.json` lists every file with its size and sha256; `public/assets/PROVENANCE.csv` ties every file to its source.

- **Optional, per picture.** A missing file, a failed decode or a slow load means that object is drawn procedurally, in the same frame. `?assets=0` skips the art altogether.
- **A skin, never game state.** Hit tests, sizes and timings do not depend on the pictures; `game/`, `motion/`, `input/` and `shared/` never import the art modules (a guard test).
- Backdrops load per stage; the contract is `docs/architecture.md` sections 6 and 7.

### Project layout

```
start.command               double-click launcher (macOS): builds the bridge, starts the server, opens Chrome, keeps the display awake
server.js                   dependency-free static server, 127.0.0.1:8141, and the /__bridge/ endpoints of the native Bluetooth bridge
bridge/                     the native Bluetooth bridge: joycon-bridge.m (CoreBluetooth helper, Objective-C), build.sh, manager.js, Info.plist
package.json                "type": "module", scripts: start, test, test:unit, test:e2e, build:bridge, build:assets
public/
  index.html                one canvas, one module script
  diagnostics.html          the Joy-Con verification page
  css/game.css
  assets/                   the optional generated art: backgrounds, sprites, ui, fonts, manifest.json, PROVENANCE.csv
  js/
    main.js                 browser bootstrap
    app.js                  wiring: input, motion, game, presentation, frame loop, trigger compensation
    clay-api.js             window.__clay
    flags.js                URL flags
    wake-lock.js            asks the browser to keep the screen awake during a session
    shared/                 contracts, validators, clock, random numbers, playfield, the world projection
    input/                  Joy-Con providers (native bridge, Web Bluetooth), simulator, mouse, keyboard, packet parser, button actions
    motion/                 orientation filter, calibration wizard, relative pointer, aim history
    game/                   pure game rules: stages, launches, physics, the shot, scoring, modes, ranks
    render/  audio/  ui/    canvas drawing (world, HUD, effects, optional art), synthesised sound, screens and state machine, English strings
tools/                      record-imu.mjs, shooting-steps.json, analyze-shots.mjs (the recording session); analyze-imu.mjs,
                            analyze-motion.mjs, replay-motion.mjs (the previous game's recording analysis); build-clay-assets.mjs
recordings/                 imu-2026-09-30T18-42-24.jsonl: the previous game's real Joy-Con 2 Right recording that the tests replay
design/                     art sources: raw/ (the generated pictures), sprites/ (cut from the sheets), fonts/src/, tools/, PROVENANCE-jobs.csv
test/                       node --test suites
test-support/               fakes and helpers: fake Bluetooth, fake bridge helper, fake canvas, DevTools client, app harness, render tools
docs/
  GUIDE.md                  setup, calibration, troubleshooting, the HARDWARE CHECKLIST and the recording session
  REFERENCE.md              this file
  architecture.md           module contracts (the source of truth together with public/js/shared/contracts.js)
  game-design.md            game design and every number
  contract-notes.md         log of deviations and decisions
  joycon2-protocol.md       Joy-Con 2 protocol research and the UNVERIFIED-ON-HARDWARE register
  native-bridge.md          the native Bluetooth bridge: design, protocols, security, macOS permission
  hardware-findings.md      what the owner's real-hardware runs proved and did not prove
  motion-contract.md, motion-findings.md   the motion pipeline and the analysis of the real recording
  joycon2-test-vectors.json real and synthetic packets used by the parser tests
  screens/                  screenshots used by the guide (taken with the simulator)
  img/                      the gameplay GIF of the README
  legacy-fruit-dojo/        the documents of the game this one was forked from, kept for reference only
.github/workflows/test.yml  runs npm run test:unit on every push
LICENSE  LICENSE-ASSETS.md  CREDITS.md   the MIT licence of the code, the terms of the art, video and third-party files, the credits
```

Data flow for every frame: samples from the control method (Joy-Con reports, simulator reports or mouse positions) go into the motion pipeline, which keeps the crosshair and an aim history; trigger presses become shots with the compensated aim; the game consumes the shots in fixed 120 Hz steps; the presentation draws the interpolated state. Details: `docs/architecture.md` section 3.

### Tools

Developer tools; the game never needs them.

| Command | What it does |
|---|---|
| `node tools/record-imu.mjs --port 8141 --steps tools/shooting-steps.json` | the guided recording session through the running server (close the game tab first); options `--side R\|L\|any`, `--out-dir recordings`. Writes `recordings/imu-<stamp>.jsonl`, one line per report |
| `node tools/analyze-shots.mjs [recording.jsonl]` | replays a recording through the real report stream, button mapping and motion pipeline and recommends `triggerCompMs`; options `--json`, `--trigger ZR\|R`, `--steps a,b`, `--plan file`, `--aim-curve precise\|balanced\|fast`, `--sensitivity n`, `--auto-center`, `--bias x,y,z` |
| `node tools/analyze-imu.mjs recordings/<file>.jsonl` | gyro bias, noise, scale, axes, drift |
| `node tools/analyze-motion.mjs`, `node tools/replay-motion.mjs` | the analysis behind `docs/motion-findings.md` (the previous game's sword recording) |
| `npm run build:assets` | `tools/build-clay-assets.mjs`: rebuilds `public/assets/` (backdrops, sprites, gun, logo, manifest, provenance) from `design/` (needs the raw generated pictures in `design/raw/`, which are not in the repository) and ffmpeg |
| `npm run build:bridge` | compiles the native Bluetooth helper (`start.command` does it for you) |
| `node test-support/render/smoothness.mjs`, `node test-support/render/shoot-difficulty.mjs` | the clay motion smoothness and the same throw at the three difficulties, in the real game in headless Chrome |

### Known limitations

- **Never played with a real Joy-Con 2.** The owner played Clay Rush with the mouse only. The trigger feel, the 40 ms compensation, the rumble, the 1.6x aim gains, the pistol grip in the calibration and the difficulty with a real controller are UNVERIFIED-ON-HARDWARE; the [hardware checklist](GUIDE.md#10-hardware-checklist) and the [recording session](GUIDE.md#12-the-recording-session) settle them.
- `tools/analyze-shots.mjs` replays a recording with the motion pipeline's reference gains (the previous game's sword values, Balanced 5 to 14 px per degree), not the 1.6x shooter gains the game plays with: its pixel displacements are about 1.6 times smaller than in the game. The recommended compensation is chosen by comparing those displacements with each other, so it is affected much less.
- Chrome's Web Bluetooth path has never been run against a real controller (on the owner's Mac Chrome's chooser showed no device in the previous game); the native bridge is the recommended path.
- With the native bridge you hold SYNC at the start of every session and after every lost link. The calibration is not remembered between sessions; "JUST RECENTRE" is the quick option within a session.
- A Joy-Con keeps one Bluetooth link at a time: close the game before you use the diagnostics page or `tools/record-imu.mjs`, and the other way round.
- The Left Joy-Con as a gun was never tried.
- The screenshots in `docs/screens/` were taken on 2026-10-02, before the 0.6 m clays and the distance-based difficulty: some show smaller clays than the game draws now.
- The blade and cut code of the previous game is still in `public/js/motion/` and keeps its tests, but nothing consumes it.

## Part 3. How the project was made

Clay Rush was forked from the owner's [3D Fruit Dojo](https://github.com/collecticraft-sudo/3d-fruit-dojo) on 2026-10-01 and built in a few days by the owner and a team of AI agents working with Claude:

1. **Reuse what was proven.** The Bluetooth stack, the native bridge, the motion pipeline and the test tools came from the previous game, together with its lessons (the [3D Fruit Dojo playbook](https://github.com/collecticraft-sudo/3d-fruit-dojo/blob/main/playbook/NEW-GAME-PLAYBOOK.md)). A design bible and an architecture document with exact contracts came before any new code (`docs/game-design.md`, `docs/architecture.md`).
2. **Parallel engineers on disjoint files** (input and motion, gameplay, render and audio, UI), an integrator, then the owner's play tests. Every deviation from a contract is logged in `docs/contract-notes.md`. The owner's feedback changed the clays (0.30 to 0.60 m), the aim gains (1.6x), the difficulty (from speed to distance) and the Time Attack waves (never more clays than shells).
3. **Art with Higgsfield GPT Image 2.5**: 13 generated pictures (six backdrop layers at 2k, sheets of clays, shards, effects, houses and icons, the gun and the logo at 1k) for 5.5 credits in all, listed with their job ids in `design/PROVENANCE-jobs.csv`. The sheets were cut into sprites by `design/tools/slice-sheet.mjs` and `design/tools/alpha-extent.mjs`, and `tools/build-clay-assets.mjs` scales, encodes and lists everything in `public/assets/`. The fonts (Bebas Neue and Barlow, SIL OFL) were subset to Latin with `pyftsubset`.
4. **Honesty labels everywhere.** Anything that only the physical controller can settle is tagged UNVERIFIED-ON-HARDWARE and listed in the guide.
