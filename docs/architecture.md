# Clay Rush: Architecture and Module Contracts

| Item | Value |
|---|---|
| Name | **Clay Rush**. Folder and package `clay-shooter`, debug API `window.__clay`, storage key `clayRush.v1`, log prefix `[clay-rush]`. |
| Version | 1.0, contract freeze 2026-10-01, for parallel implementation |
| Forked from | "3D Fruit Dojo" (`joycon-ninja`). Its documents are in `docs/legacy-fruit-dojo/` for reference ONLY: they describe the old game. |
| Read first | `docs/game-design.md` (what to build, every number), this file (who builds what and the interfaces), `public/js/shared/contracts.js` (enums and typedefs), `public/js/shared/world.js` (the projection), `public/js/shared/validate.js` (validators). For the controller: `docs/hardware-findings.md`, `docs/motion-findings.md`, `docs/native-bridge.md`, `docs/joycon2-protocol.md`. |
| Language | Code, comments, docs, UI text: English. The owner talks Italian with the lead, never in files. |

> **HARDWARE HONESTY.** Nothing about shooting with a real Joy-Con 2 has been measured yet (the recording session comes after the first playable
> build). Every statement about trigger feel, trigger jerk, rumble or aim precision on the real controller is `UNVERIFIED-ON-HARDWARE`. Write that
> exact tag in code comments and docs where it applies. Never write "works on the Joy-Con".

## 0. Rules (unchanged from the previous project unless noted)

1. **Ownership is absolute** (section 2). Edit only your files. Need something elsewhere: implement against the contract, write the request in
   `docs/contract-notes.md` (append only), and tell the lead in your final report.
2. **Contract = `shared/contracts.js` + `shared/validate.js` + `shared/world.js` + this file.** The shared files are frozen (lead only).
3. **Imports** (enforced by `test/architecture/boundaries.test.js`): `shared/` imports only `shared/`; `input/` -> shared, input; `motion/` -> shared,
   motion; `game/` -> shared, game; `render/`, `audio/`, `ui/` -> shared, render, audio, ui; root files (`app.js`, `main.js`, `clay-api.js`,
   `flags.js`, `wake-lock.js`) anything. Every module may import the data modules `game/config.js`, `motion/motion-config.js`, `input/input-config.js`.
   Relative imports with `.js` only, no bare specifiers, no external URLs.
4. **One time base**: ms on the injected Clock. Nobody outside `shared/clock.js` reads `performance.now()`; `Date.now()` only in motion's calibration stamp.
5. **`game/`, `motion/`, `shared/` are pure**: no DOM, storage, timers, network, `Math.random` (game uses `shared/rng.js` streams). Importable in Node.
6. **Every module importable in Node** (no top-level `window`/`document`); inject browser objects.
7. **Zero runtime dependencies, offline.** Images and fonts under `public/assets/` are OPTIONAL: every drawing has a procedural fallback
   (`?assets=0` must give a complete, good-looking game).
8. **Numbers live in config modules**: `game/config.js` (CONFIG), `motion/motion-config.js` (MOTION_CONFIG), `input/input-config.js` (INPUT_CONFIG),
   `render/art-config.js` (ART_CONFIG). No magic numbers in logic.
9. **Validators in tests**: assert module outputs with `assertValid(kind, value)`.
10. **Deterministic**: same seed + same scripted shots + same manual-clock steps = identical snapshots.
11. **Tests**: `node --test`, files in `test/<area>/`, helpers in `test-support/<area>/` (never in `test/`). Run your own area with
    `node --test --test-concurrency=3 "test/<area>/**/*.test.js"`. The machine is shared by several agents: never run the whole suite, never more
    than one headless Chrome at a time, never kill a process you did not start, use your own server port (8300 + a number you pick) if you need one.
12. **Delete what no longer applies** in your area (fruit code, fruit tests, fruit fixtures). Keep the tests of reused code green.
13. **English-only guard**: no Italian words in code, strings or docs (`test/architecture/english-only.test.js`).

## 1. Decisions

| ID | Decision |
|---|---|
| C-01 | 2.5D: game logic in world metres (`shared/world.js`), hit test in screen space at the shot instant (design section 4). The projection is in `shared/` so the game, the renderer and the debug API agree to the pixel. |
| C-02 | The trigger is an **action `fire`** (`ACTION.FIRE`). Right unit: ZR fires, R recentres. Left unit: ZL fires, L recentres. Setting `triggerButton: 'ZR' \| 'R'` swaps the two (the third option "A" of the design is dropped: A must stay "confirm" in menus). The `fire` ActionEvent's `t` is the timestamp of the input report (ImuSample.t of the report) that first showed the button down, not the time it was handled. |
| C-03 | Mouse: a left-button **press** (pointerdown, button 0) on the canvas emits `fire` (source `mouse`, t = clock.now() at the event) AND, as before, the release still reaches the UI as a click for menu targets. The UI ignores `fire` outside the playing screen (and outside calibration's test-shot step). Keyboard: F fires (source `keyboard`); Enter stays `confirm`; C recentres (Space keeps recentre too). |
| C-04 | **The UI is still the only consumer of actions** (old A-10). In `playing` (game active) the UI turns `fire` into an intent `{type:'fire', t, source}`; in phase `ready` it also turns `confirm` into a fire intent (A or Enter calls "Pull!"). app.js turns the intent into a `Shot` (C-05) and queues it for the next `game.update`. |
| C-05 | **Trigger compensation** happens in app.js: `compMs = source === 'joycon' ? settings.triggerCompMs : 0`; `{x, y} = motion.aimAt(t - compMs)` (fallback: `motion.headAt(now)` when `aimAt` is not valid); `Shot = {t, x, y, source, compMs}`. In Zen with assist the game applies the assist, not app.js. |
| C-06 | Calibration: the motion wizard (steps 1 to 3) is reused unchanged in its math. Step 4 is a **practice round** (`createGame('practice', seed)`): one slow clay every 3 s from the trap house; the first `practice {phase:'hit'}` event ends calibration. The texts change: "Hold the Joy-Con still with its top pointing up", "Point it at the screen like a pistol", "Aim at the centre and press A", "Shoot the clay: press ZR". |
| C-07 | Menus: stick, A, B for a real Joy-Con. Pointer selection with the Joy-Con is OFF (no dwell, no cut-select). The mouse clicks menu items. |
| C-08 | Rumble: on every `shot` event app.js calls `provider.vibrate?.(5)` when `settings.rumble` is true (rate limited by the provider). UNVERIFIED-ON-HARDWARE. |
| C-09 | The blade/cut code of motion stays in place and keeps its tests, but nothing consumes `BladeSegment`s any more (app.js drains and drops them). |
| C-10 | Fonts: `ClayDisplay` (Bebas Neue, one weight) and `ClayUI` (Barlow 600 for weights up to 650, Barlow 700 above), files in `public/assets/fonts/` (`range-display.woff2`, `range-ui-600.woff2`, `range-ui-700.woff2`, OFL texts beside them). Bebas Neue has capitals only: display text is written in capitals by design. |
| C-11 | Art: `public/assets/manifest.json` is built by `tools/build-clay-assets.mjs` (lead). Asset ids are listed in section 7. Groups: `core`, `stage:meadow`, `stage:hills`, `stage:alpine`. There is no mid layer: stages have `far` (opaque JPEG) and `near` (transparent PNG). |
| C-12 | Debug API `window.__clay` (section 9.3), URL flags (9.2). The simulator provider stays (absolute model) so bots and videos can aim and shoot. |

## 2. Ownership (who edits what)

| Role | Files |
|---|---|
| **Lead / architect** | `public/js/shared/**`, `test/shared/**`, `docs/architecture.md`, `docs/game-design.md`, `tools/build-clay-assets.mjs`, `public/assets/**`, `design/**`, `package.json` |
| **Input & Motion engineer** | `public/js/input/**`, `public/js/motion/**`, `public/diagnostics.html`, `test/input/**`, `test/motion/**`, `test/bridge/**`, `test-support/input/**`, `test-support/motion/**`, `test-support/bridge/**`, `bridge/**`, `tools/record-imu.mjs`, `tools/analyze-imu.mjs`, `tools/analyze-shots.mjs` (new), `tools/shooting-steps.json` (new), `tools/replay-motion.mjs`, `tools/lib/imu-recording.mjs`, `recordings/**` |
| **Gameplay engineer** | `public/js/game/**`, `test/game/**`, `test-support/game/**` |
| **Render & Audio engineer** | `public/js/render/**`, `public/js/audio/**`, `test/render/**`, `test/audio/**`, `test/assets/**`, `test-support/render/**`, `test-support/stage/**`, `test-support/audio/**`, `test-support/assets/**` |
| **UI engineer** | `public/js/ui/**`, `public/css/**`, `test/ui/**`, `test-support/ui/**` |
| **Integrator** (after the four above) | `public/js/app.js`, `public/js/main.js`, `public/js/clay-api.js` (renamed from `ninja-api.js`), `public/js/flags.js`, `public/js/wake-lock.js`, `public/index.html`, `server.js`, `start.command`, `README.md`, `docs/GUIDE.md`, `test/app/**`, `test/e2e/**`, `test/architecture/**`, `test/server/**`, `test-support/app/**`, `test-support/e2e/**`, `tools/replay-integrated.mjs`, `tools/build-assets.mjs`, `tools/asset-spec.mjs` (delete the last two) |
| everyone | `docs/contract-notes.md` (append only, dated, signed with the role) |

## 3. Data flow and frame order (app.js, Integrator)

```
provider events ─ sample ─> motion.pushImu           aim ─> motion.pushAim
                 ─ action/nav ─> ui.notify(...)       status ─> ui.notify({type:'provider'})
ui intents ─ fire{t,source} ─> app: Shot{t, x, y, source, compMs} (C-05) ─> shotQueue
           ─ startRound{mode, difficulty, stage, seed?} ─> game = createGame(mode, seed, opts)
frame (step):
  1 injectDue (debug), provider.tick (sim), motion.poll(now), motion.drainSegments() (dropped)
  2 state = ui.getState()
  3 if state.gameActive && game: game.update(dtS, shotQueue.splice(0), now); events = game.drainEvents()
       (shots queued while the game is not active are DROPPED, never replayed later)
     if game.isOver() first time: ui.notify({type:'roundOver', result: game.getResult()})
  4 aim = {x, y, visible, trackingOk} from motion.headAt(now) (crosshair; extrapolated <= 35 ms)
  5 presentation.step({nowMs, dtS, snapshot: game?.snapshot() ?? null, events, aim, debug})
  6 rumble on shot events (C-08), clay-api afterStep
draw (rAF): presentation.draw()
```

### 3.1 Units recap
World metres and m/s (`shared/world.js`), playfield px (1920 x 1080), angles in degrees, angular rates deg/s, time ms on the Clock except the
game's internal seconds (`t`, `tWorld`, `...S` fields).

## 4. Input & Motion contract

### 4.1 Input (`public/js/input/`)
- `ACTION.FIRE` mapping as C-02 / C-03. `createButtonActions` must let a fire edge through at least every **70 ms** (two quick shots of an
  over-and-under are about 150 to 250 ms apart); other actions keep their debounce. The recentre hold-off logic of the old game (ignore R while
  the sword moves fast) must NOT apply to fire.
- Provider method `setTriggerButton('ZR'|'R')` on every provider that has buttons (no-op on the mouse). Default 'ZR'. `getActionLabels()` gains
  `fire` ('ZR', 'R', 'ZL', 'L', 'Click', 'F').
- Mouse provider: emits `aim` at the press position, then `action fire` (C-03). It must not also emit `confirm` for that press.
- Simulator provider: `sim.fire()` emits a fire action with source `sim` at the current simulated time (for bots).
- `ActionEvent` keeps its shape `{t, action, label, source}`; `ActionLabels` gains `fire`.

### 4.2 Motion (`public/js/motion/`)
- New method `aimAt(tMs) -> {x, y, valid}`: the pointer position at time `tMs`, linearly interpolated between the two history samples (real or
  interpolated, NOT extrapolated) around `tMs`; `valid` false when the history does not cover `tMs` (older than the ring, or no sample) or tracking
  was not ok then. For aim (mouse) samples: the latest sample at or before `tMs`. Ring depth must cover at least 300 ms.
- Settings gain `aimCurve: 'precise'|'balanced'|'fast'` (design 6.2; 'balanced' = the current curve) applied by `setSettings`.
- New method `shotDiagnostics(tPressMs, compMs) -> {jerkPeakDps, displacementPx, valid}`: the peak angular speed in [tPress, tPress + 150 ms] and the
  distance between `aimAt(tPress - compMs)` and `aimAt(tPress + 80)`. Used by the aim tuning screen and the analysis tool.
- Everything else of the pipeline is unchanged (calibration wizard, recentre, relative model, simulator absolute model).
- `tools/shooting-steps.json` + `tools/analyze-shots.mjs`: the recording plan of design section 11 and an analysis that replays a recording through
  the real pipeline, finds the trigger presses (ZR edges in the reports) and reports, per candidate `compMs` in 0..100 step 10, the median and p90
  of the displacement between the compensated aim and the aim 200 ms before the press (the "intended" aim when holding still), and recommends the
  best value. Must run on synthetic data in tests (no hardware needed).

## 5. Game contract (`public/js/game/`)

Exports from `game/index.js`: `createGame(mode, seed, opts) -> Game` (typedef in contracts.js), `CONFIG` (from `config.js`), `rankFor(result)`,
`STAGES` (stage table: `{id, name, pulls, wind, ...}` used by the UI menus), best-score helpers `emptyBest()`, `sanitizeBest(raw)`,
`isNewBest(best, result)`, `updateBest(best, result)`, `bestKey(mode, difficulty, stageId)`, `accuracyPercent(result)`, `formatDuration(s)`.

Behaviour: design sections 3 to 7 exactly, all numbers in `config.js`. Fixed world tick 1/120 s with the real-time accumulator of the old game
(`timeScale` slows world ticks; timers that must not slow (Time Attack clock, pull delay, stage card) run on real time). Interpolation:
`snapshot().alpha` and `Target.sx/sy` already interpolated. The phase machine and events of contracts.js. `debugSpawn` and `debugSetAutoLaunch`
for tests and bots. Shots: handled in order at the start of the update, each resolved at its own instant (Hard: travel time), after the world
has been advanced to the shot's press time if it lies inside the frame (do NOT resolve against positions newer than the press time).

Snapshot size: at most 12 targets airborne, houses <= 5, events ring 32. `snapshot()` allocates a new plain object (callers may keep it).

## 6. Render & Audio contract

### 6.1 World renderer (`render/world.js`, new)
```js
createWorldRenderer({ assets, createCanvas, config? }) -> {
  setStage(stageId),                 // 'meadow'|'hills'|'alpine': assets.load('stage:<id>'); crossfade 400 ms from the previous stage
  reset(),                           // clear fx (new round)
  handleEvents(events, nowMs),       // GameEvent[] of this frame: shot, hit, lost, launch, killCam, hitStop, dryFire, reload, stageStart ...
  update(dtS, view),                 // real seconds: fx, recoil, shake, crosshair bloom, kill-cam zoom
  draw(ctx, view),                   // the whole world pass in playfield coordinates (the caller applied the letterbox transform)
  getDebug() -> { particles:number, stage:string, layers:{far:bool, near:bool}, shake:number, zoom:number },
}
WorldView = {
  nowMs, snapshot /* GameSnapshot|null */, stageId,
  aim: { x, y, visible },            // crosshair (extrapolated head from motion), playfield px
  showGun: boolean, showCrosshair: boolean,
  idle: boolean,                     // menu backdrop: slow drift, no gun, no crosshair, occasional ambient clay across the sky
  settings: { reduceMotion, reduceFlash, crosshairColor: 'white'|'yellow'|'green'|'magenta' },
}
```
Draw order (design section 2): far layer (parallax with aim), houses (far first), targets and shards (far first), near layer, pellet clouds,
muzzle flash and smoke, gun (bottom right, follows the aim a little, recoil kick), crosshair. Camera shake and the kill-cam zoom apply to the
whole world pass. Every sprite has a procedural painter (sky gradient + hills + meadow per stage palette, clay = ellipse with dark rim and
ridges, shard polygons, house boxes, gun silhouette, flash star, smoke circles). No per-frame allocation on the hot path, cached scaled sprites.

### 6.2 HUD (`render/hud.js`)
```js
createHud({ assets, createCanvas }) -> {
  reset(), handleEvents(events, nowMs), update(dtS),
  draw(ctx, snapshot, hv),           // hv = { nowMs, t: (key, params) => string, labels: ActionLabels, reduceMotion, reduceFlash, battery: 'ok'|'low'|'critical'|'unknown' }
}
```
Design section 9 HUD layout plus banners ("DOUBLE!", "STREAK x3", "PERFECT STAGE", "SMOKED!", "TWO WITH ONE!", points popups) and the stage card
(phase `stageCard`) and the "Press {fire}: PULL!" prompt (phase `ready`). All text comes through `hv.t(key, params)`; the keys are fixed in
section 8.5 (the UI engineer adds them to `strings.en.js`).

### 6.3 Text and fonts
`render/fonts.js` loads the three files of C-10 (two FontFaces with the same family `ClayUI` and weight ranges `100 650` and `651 900`).
`render/palette.js`: families `ClayDisplay` and `ClayUI` with system fallbacks (`"ClayDisplay", "Bebas Neue", "Oswald", "Impact", "Arial Narrow Bold", sans-serif`
and `"ClayUI", "Barlow", "Helvetica Neue", "Segoe UI", system-ui, sans-serif`), a new palette (section 10 of the design: cream `#FFF4DC`, slate
`#1B1F24`, clay orange `#F26B1D`, gold `#F2C230`, sky blue `#3C7FC8`, olive `#6B7F3A`, terracotta `#C8553D`), `TEXT_STYLES` re-tuned for the condensed
display face. `draw-util.js` (`drawText`, `fitText`, `drawDigits`, `bakeTextSprite`, ...) stays the one text helper for the UI and the HUD.

### 6.4 Audio (`audio/`)
`createAudio` keeps its signature and engine. New recipes (design section 8): `shot`, `dryClick`, `clayBreak` (variant `centre`), `goldBreak`,
`shellInsert`, `gunOpen`, `pullCue`, `throw` (trap clunk), `double`, `streakUp`, `stageClear`, `timeTick`, `timeUp`, plus ambience loops
`ambience:<stageId>` (wind noise, sparse synthesised birds for meadow and hills, crickets for alpine) started and stopped by `update`.
`handleGameEvent(ev)` maps the clay events; `update(dtS, { screen, stageId, snapshot })` drives the ambience (on during menu backdrop and play, ducked
in pause). UI sounds (`uiMove`, `uiConfirm`, `uiBack`, `countdown`, `go`, `record`, `cal*`, `connectOk`, `recenter`) stay.

## 7. Assets (`public/assets/manifest.json`, built by the lead)

| Group | Ids |
|---|---|
| `stage:<id>` (meadow, hills, alpine) | `bg_<id>_far` (2560 x 1440 JPEG, opaque, horizon at 62 percent), `bg_<id>_near` (1920 x 1080 PNG, transparent, grass along the bottom) |
| `core` targets | `clay_std_tilt`, `clay_std_below`, `clay_std_edge`, `clay_gold_tilt`, `clay_rabbit` (256 px canvases, field `body: {cx, cy, r}` = the radius the game's `rPx` maps to) |
| `core` shards | `shard_std_1` .. `shard_std_6`, `shard_gold_1`, `shard_gold_2` (128 px) |
| `core` fx | `fx_flash_star`, `fx_flash_side`, `fx_smoke_puff`, `fx_smoke_trail`, `fx_dust_burst`, `fx_shell_casing` (256 px) |
| `core` houses | `house_trap`, `house_skeet`, `house_tower` (512 px, anchor = bottom centre of the content: the ground point) |
| `core` icons | `icon_shell_full`, `icon_shell_empty`, `icon_clay`, `icon_trophy`, `icon_wind`, `icon_clock`, `icon_star` (128 px) |
| `core` ui | `gun_ou` (anchor = its bottom-right corner, field `muzzle: {x, y}` = muzzle position as a fraction of width and height), `logo_title` (the "CLAY RUSH" logo) |

`render/assets.js` (the loader) is reused unchanged in API. The UI kit (buttons, panels, toggles) is drawn procedurally in a clean modern style:
rounded rectangles, cream panels with a slate outline, orange focus ring; no generated button images.

## 8. UI contract (`public/js/ui/`, `public/css/`)

### 8.1 Facade (`ui/presentation.js`)
`createPresentation({canvas, clock, storage?, audio?, document?, window?, matchMedia?, createCanvas?, hasBluetooth?, config?, assets?})` returns
`{ ui, step(input), draw(), resize(), getPerf(), setArtLoading(on), audio, storage, dispose(), debug }`.
- `step({nowMs, dtS, snapshot, events, aim: {x, y, visible, trackingOk}, debug})`: runs the UI state machine, forwards `events` to the world renderer,
  the HUD and `audio.handleGameEvent`, chooses the stage (snapshot.stage.id while playing; 'hills' for menus; the chosen stage on setup screens),
  updates the renderer and the audio ambience.
- `draw()`: world pass (`world.draw`) with `showGun/showCrosshair` true only on `playing` and calibration step 4, HUD on `playing`/`paused`, then the
  screen UI on top. Menus show the world in `idle` mode as a living backdrop.
- `ui`: `{ onIntent(fn), notify(fact), getState(), force(screen, opts), getView(), pointerClick(x, y), pointerMove(x, y), activate(id), getTargets() }`.

### 8.2 Screens and flow
`boot -> safety -> connect -> calibration (Joy-Con only) -> menu`. Menu: Classic, Time Attack, Zen, Best scores, Settings, Controller. Classic and
Time Attack go to `setup` (difficulty; Time Attack and Zen also the stage), then `countdown` (3, 2, 1, GO with the stage name) -> `playing`.
`back`/`pause` -> `paused` (Resume, Recentre, Settings, Quit to menu) -> resume countdown. `roundOver` -> `results` (score count-up, stats, stamped
rank, NEW BEST, Play again, Menu). `best` lists the best scores per mode and difficulty. `tuning` (from Settings, "Aim and trigger tuning"): live
crosshair over the hills backdrop, a target ring, the pointer speed in deg/s, and after each ZR press the `shotDiagnostics` numbers (fact
`shotFeedback`). Overlays: `disconnected`, `confirm`. Every screen has the bottom hint line with the active controller's glyph labels.

### 8.3 Facts in (`ui.notify`) and intents out (`ui.onIntent`)
Facts: `ready{skipSafety}`, `action{event}`, `nav{event}`, `provider{kind, transport, status, labels, capabilities}`, `calibration{...}` (motion
wizard events, unchanged), `bridgeProbe`, `bridge`, `recentered`, `roundOver{result}`, `visibility`, `blur`, `motionWarning`, NEW
`shotFeedback{jerkPeakDps, displacementPx, compMs, valid}`.
Intents: `connect{provider, filter?}`, `disconnect`, `reconnect`, `useMouse`, `startCalibration`, `cancelCalibration`, `confirmCenter`,
`quickRecenter`, `clearCalibration`, `recenter`, `settingsChanged{settings}`, `openDiagnostics`, NEW `startRound{mode, difficulty, stage, seed?}`
(mode 'practice' on calibration step 4), NEW `fire{t, source}` (C-04), `endRound{reason:'finished'|'quit'}`.
`getState()` -> `{screen, overlay, gameActive, resuming, calibrationStep, systemCursor, roundMode}`; `gameActive` true on `playing` (no overlay,
not resuming) and on calibration step 4.

### 8.4 Storage and settings (`ui/storage.js`)
Key `clayRush.v1`, document `{v:1, best, settings, safetyAck, playMsTotal}`. `best` from `game/` helpers (keys from `bestKey`).
| Setting | Range / values | Default |
|---|---|---|
| `sensitivity` | 0.5 .. 3.0 step 0.1 | 1.0 |
| `aimCurve` | 'precise' 'balanced' 'fast' | 'balanced' |
| `triggerButton` | 'ZR' 'R' | 'ZR' |
| `triggerCompMs` | 0 .. 100 step 10 | 40 |
| `rumble` | bool | true |
| `aimAssist` | bool (Off / Light) | false |
| `autoPull` | bool | false |
| `autoCenter` | bool | true |
| `crosshairColor` | 'white' 'yellow' 'green' 'magenta' | 'white' |
| `difficulty` | 'easy' 'normal' 'hard' (last chosen) | 'normal' |
| `stage` | 'meadow' 'hills' 'alpine' (last chosen) | 'hills' |
| `volume` | 0 .. 1 step 0.1 | 0.8 |
| `reduceFlash`, `reduceMotion` | bool | false (reduceMotion true when prefers-reduced-motion) |
| `flipX` | bool | false |

### 8.5 HUD string keys (the UI engineer adds them, the HUD uses them through `hv.t`)
`hud.score`, `hud.best`, `hud.pull` ("PULL {n}/{total}"), `hud.pullPrompt` ("PRESS {fire} TO CALL PULL!"), `hud.reloading` ("RELOADING"),
`hud.wind` ("{speed} M/S"), `hud.time` ("{s}"), `hud.stage` ("STAGE {n}: {name}"), `hud.stageCard.title` ("STAGE {n}"), `hud.stageCard.name` ("{name}"),
`hud.banner.double` ("DOUBLE!"), `hud.banner.twoWithOne` ("TWO WITH ONE!"), `hud.banner.smoked` ("SMOKED!"), `hud.banner.streak` ("STREAK x{n}"),
`hud.banner.perfect` ("PERFECT STAGE"), `hud.banner.timeUp` ("TIME!"), `hud.banner.newBest` ("NEW BEST!"), `hud.lowBattery` ("Joy-Con battery low"),
`hud.zen.stats` ("{hits} HITS, {acc}% OF THE LAST 20"), `hud.dry` ("EMPTY"), `hud.multiplier` ("x{n}").

## 9. Integrator contract

### 9.1 `app.js`
`createApp(env)` as before (env injection unchanged). Changes: route per section 3; Shot building (C-05); rumble (C-08); provider `setTriggerButton`
on connect and on `settingsChanged`; motion `setSettings({sensitivity, aimCurve, autoCenter, flipX})`; `shotFeedback` fact after each Joy-Con shot
(`motion.shotDiagnostics(t, compMs)` evaluated 160 ms after the press); practice round for calibration step 4; best scores and play time recorded
through storage on `roundOver`.

### 9.2 URL flags (`flags.js`)
`input` (joycon, native, sim, mouse), `seed`, `mode` (classic, timeattack, zen; implies skipsafety and, without `input`, `input=mouse`),
`difficulty`, `stage`, `skipsafety`, `skipcountdown`, `debug`, `mute`, `reducemotion`, `reduceflash`, `clock=manual`, `assets=0|off`, `fonts=0`,
`haptics=0` (rumble off), simulator flags (`simhz`, `simmount`, `simside`, `simgyro`, `simseed`, `simaccelsign`, `simmirror`, `simcal`),
Bluetooth flags (`filter`, `mask`, `side`, `accelsign`).

### 9.3 `window.__clay` (`clay-api.js`)
`version`, `ready` (Promise), `manualClock`, `now()`, `advance(ms)`, `getConfig()`, `getSettings()`, `setSetting(k, v)`, `setSeed(n)`,
`start(mode, {difficulty, stage, seed, skipCountdown = true, autoLaunch = true})`, `snapshot()` (GameSnapshot flattened plus `screen`, `overlay`,
`aim`, `provider`, `calibrated`, `nowMs`, `game`), `pause()`, `resume()`, `aim(x, y)` (moves the crosshair: mouse/sim/debug aim sample),
`fire({x, y}?) -> Promise<{events}>` (a debug shot at x, y or at the current aim; under the manual clock the effects are applied when it resolves),
`shootTarget(id, {offsetPx = 0, leadMs = 0}) -> Promise<{events, hit}>` (bot helper: aims at the projected target and fires), `callPull()`,
`press(action)`, `nav(dir, phase)`, `getMotionState()`, `getUiState()`, `getAssets()`, `getPerf()`, `debug: {spawn(spec), autoLaunch(on),
forceScreen(screen, opts), getLog(), getCounters(), getAudio(), draw(), getUiView(), setCalibration(cal)}`, `sim` (simulator hooks).

### 9.4 Tests the Integrator owns
`test/app` (wiring in Node with fakes), `test/architecture` (boundaries with `clay-api.js`, english-only, naming, delivery), `test/e2e` (headless
Chrome: boot to menu, play a Classic stage with a bot through `__clay.shootTarget`, results, `?assets=0` run, screenshots of every screen
under `E2E_SCREENSHOTS=dir`).

## 10. Definition of done (every engineer)
- Your area's tests pass (`node --test --test-concurrency=3 "test/<area>/**/*.test.js"`), fruit leftovers deleted, validators used in tests.
- Contract deviations written in `docs/contract-notes.md`.
- A final report to the lead: what was built, the public API exactly as implemented, deviations, what is UNVERIFIED-ON-HARDWARE, test counts.
