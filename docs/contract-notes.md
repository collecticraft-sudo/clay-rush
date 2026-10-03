# Contract notes (append only)

Deviations from `docs/architecture.md`, requests to other owners, and answers. One entry per item:

```
## YYYY-MM-DD, <role>: <short title>
What: ...
Why: ...
Who must act: ...
```

## 2026-10-01, Input & Motion engineer: the gun-oriented input and motion layer (architecture 4.1, 4.2)
What: implemented as specified, with these decisions and small deviations.
- **Order of events of one report (BLE and native providers).** The ActionEvents decoded from a report are now emitted AFTER that report's
  `sample` event (the report stream itself still emits packet, buttons, nav, sample). So when app.js turns a `fire` into a Shot synchronously,
  Motion already holds the sample whose `t` equals `fire.t`, and `motion.aimAt(t - compMs)` is valid even at compMs 0
  (test/input/ble-provider.test.js "C-05"). Requires app.js to push `sample` events into Motion as they arrive (it does).
- **Fire bounce guard** `INPUT_CONFIG.action.fireMinIntervalMs = 40` ms, measured on REPORT times (ButtonsEvent.t), not on the clock, so a burst
  of two reports delivered together keeps both shots. Other actions keep 120 ms on the clock. UNVERIFIED-ON-HARDWARE.
- **Phantom ZL/ZR hold-off after a watchdog mask change** (BLE provider, connection only): it now holds off `fire` as well as `recenter`, because
  ZR is the trigger now. This is NOT the app.js rule "ignore a recenter press while the blade moves" (app.js lines 42 and 592), which must not
  apply to `fire` (C-02): Integrator, keep `fire` out of it.
- `ACTION_ORDER` = fire, confirm, back, pause, recenter (a shot in the same report as a pause is handled first).
- **Labels** (`ACTION_LABELS` in input/provider-base.js): Right {confirm A, back B, pause +, recenter R, fire ZR}, Left {Down, Left, -, L, ZL}
  (with trigger 'R': fire and recenter swap, e.g. fire 'R', recenter 'ZR'), keyboard {Enter, Esc, P, Space, F}, mouse {click, right click,
  middle click, double click, Click}. The keyboard recentre label stays 'Space' (C also recentres).
- **Mouse**: every left press emits an `aim` sample at the press position, then `fire` (t = clock.now()). Not prevented: the release still
  arrives as a click. The SIMULATOR's left press also fires (source 'sim', label 'Click'), like `sim.fire()`.
- **`sim.fire()`** emits the reports due by clock.now() first and stamps the fire with the measurement time of the NEWEST report (<= now), the
  simulated device's "now"; not streaming: clock.now(). It returns the ActionEvent. This makes `motion.aimAt(fire.t)` valid and exact for bots.
- **`setTriggerButton('ZR'|'R')`** exists on all four providers (no-op on mouse and simulator); unknown values are ignored; the setting
  survives reconnects (it is not reset with the link state).
- **Motion aim history**: aimAt/shotDiagnostics use their own ring (`MOTION_CONFIG.shot.historySize` 2048 entries opened at least
  `minSpacingMs` 0.5 ms apart, so at least 1.02 s at ANY input rate; the trail ring of 384 samples would hold only 0.4 s of a 1 kHz mouse).
  `recent()` and the trail ring are unchanged. aimAt does not interpolate across a discontinuity (the earlier entry holds), across a hole
  longer than maxGapMs, or across a change of source (invalid). Invalid results still carry x, y (the nearest known position).
- **shotDiagnostics** jerk = the peak over the REAL samples in the window (IMU: |w|; aim samples: the deg/s-equivalent cursor speed);
  `valid` = both aimAt valid (it does not require the whole 150 ms window to be covered; app.js evaluates it 160 ms after the press, when the
  newest sample may be up to one report older).
- **aimCurve presets** (`MOTION_CONFIG.aimCurves`): precise {4, 11, vertical cap 4.8}, balanced {5, 14, 6} (= `pointer`), fast {6, 18, 7.2}.
  The vertical cap (round F1) scales with the slow gain. Only the relative pointer reads them; the simulator's absolute model ignores aimCurve.
  UNVERIFIED-ON-HARDWARE.
- **Calibration wizard**: unchanged; nothing in it is sword specific beyond the texts (two gravity poses about 90 degrees apart: "top up",
  then "point at the screen" works for a pistol grip). Nothing blocks a gun grip.
- **tools/analyze-shots.mjs** assumes the pistol frame forward = device +y, up = +z, identity mount (no wizard in a recording), bias from
  `rest_table`, auto-centre off. The plan `tools/shooting-steps.json` adds `"analyze": true` to `trigger_still` (record-imu ignores the field).
- **Diagnostics page**: only the sword wording changed ("virtual Joy-Con", "very fast moves", "the aim would point toward the grip"). The game
  name on it (and in bridge/Info.plist) is still "3D Fruit Dojo" because test/architecture/naming.test.js pins it; I will rename both when the
  Integrator flips that test (or the Integrator may do it).
Why: architecture 4.1 and 4.2, C-02, C-03, C-05.
Who must act:
- Lead: `shared/contracts.js` typedefs: `ActionLabels` gains `fire`; `InputProvider` gains `setTriggerButton(button)` and (sim) `fire()`;
  `MotionSettings` gains `aimCurve`; `MotionPipeline` gains `aimAt(tMs) -> {x, y, valid}` and `shotDiagnostics(tPressMs, compMs) ->
  {jerkPeakDps, displacementPx, valid}`.
- Integrator: keep `fire` out of the "recenter while the blade moves" rule; call `provider.setTriggerButton(settings.triggerButton)` on connect
  and on settingsChanged and refresh the labels after it; `__clay.sim` can expose `sim.fire()`.
- UI: `MOTION_CONFIG.aimCurves[settings.aimCurve]` gives the px/deg of the tuning screen (it reads `pointer.gLoPxDeg/gHiPxDeg` today).

## 2026-10-01, Gameplay engineer: Clay Rush game module (public/js/game/) as implemented
What:
- **API** (`game/index.js`): `createGame(mode, seed, opts)`, `CONFIG`, `rankFor(result)`, `STAGES`, `emptyBest()`, `sanitizeBest(raw)`,
  `isNewBest(best, result)`, `updateBest(best, result) -> newTable` (pure, returns the new table; it does NOT return `{table, isNewBest}`:
  call `isNewBest` first), `bestKey(mode, difficulty, stageId) -> 'classic.<diff>' | 'timeattack.<diff>.<stage>' | null` (null for zen and
  practice: they keep no best), `accuracyPercent(result | accuracy)`, `formatDuration(s) -> 'm:ss'`. Best record:
  `{score, rank, broken, presented, accuracy, bestStreak, assist}` (no date: the game has no clock; the UI may add one beside it).
- **Additive snapshot field** `zen: {recentShots, recentHits} | null` (Zen statistics of the last 20 shots for `hud.zen.stats`). The validator
  ignores extra keys.
- **Hard (pellet travel)**: the `shot` event is emitted at the press (for the boom and recoil) with `hitIds: []`; the `hit` events follow
  60 to 100 ms later, when each target is resolved at press time + z / 420 m/s. Easy and Normal: `hitIds` lists the broken targets.
- **Shots that do nothing (no event)**: during `pull` (the delay after "Pull!"), `settle`, `stageCard`, `ending`, `over`, and during the Time
  Attack reload. A Shot in `ready` (Classic) calls the pull and uses no shell. `dryFire` only when the gun is empty in `flight`.
- **`reload` event in Classic**: entering `ready` emits `reload{phase:'start', ms:400}` (the two-shell insert) and `reload{phase:'done', ms:0}`
  when loaded; `shells.loaded` is 0 during the insert. Calling the pull early completes the insert at once. On `settle` the gun opens
  (`shells.loaded` 0, the unused shell is ejected).
- **Stage change**: `stageStart` is emitted at the START of the stage card; `snapshot.stage` and `snapshot.houses` switch to the new stage
  then (the renderer can crossfade during the card). The first stage's `stageStart` is in the first drained batch.
- **Stage index outside Classic**: Time Attack, Zen and practice report `stage.index` 0 and `stage.count` 1 (the chosen stage, default hills).
- **Difficulty**: Zen and practice report `difficulty: 'normal'` (ignored by design). Practice has no wind.
- **Scoring details**: the multiplier is taken AFTER the streak increment (the 3rd consecutive break already scores x2); every bonus including
  DOUBLE, TWO WITH ONE and PERFECT STAGE is multiplied (design 5 "on everything above"). First barrel = shell 0 of the pull (Time Attack: of
  the load). Kill cam: a gold break, or a centre hit that completes a double or the last pull of a stage.
- **Launch angles retuned for the fairness rule** (design numbers kept in spirit): with the design elevations most trap/skeet draws touched
  the ground in under 1.2 s (trap 8-20 deg: about 40 percent pass at Normal, 12 percent on Easy). Now trap 18-30 deg, skeetL 14-24, skeetR
  16-26, battue 9-15 (kind override), tower 6-16, skeet azimuth 95-112 deg. The battue double flies from skeetL twice (0.4 s apart): from the
  low skeetR house (1.2 m) a flat battue lands in under a second. Clamp sets (`houses.*.safe`) are tested for every kind, speed multiplier and
  wind. UNVERIFIED-ON-HARDWARE: feel to be checked in the first play session.
- **Wind** uses the design formula literally (`a = g + wind - k|v|v`, wind in m/s added as m/s^2, `CONFIG.physics.windAccelPerMps` = 1).
  Rabbits ignore the wind. Gusts: `gustAmp * sin(2 pi tWorld / period + seeded phase)`.
- **Debug hooks**: `debugSpawn(spec | spec[])` accepts `{kind, house, speed, azimuthDeg, elevationDeg, pos:{x,y,z}, vel:{x,y,z}, still}`
  (any explicit field skips the fairness rule; `still` targets do not move, for tests). In Classic `ready` it starts a debug pull (flight with
  2 shells, the pull counter does not advance). `debugSetAutoLaunch(true)` in Classic calls each pull as soon as the gun is loaded.
  Non-contract `game.debugInfo()` returns internal counters and the stage plan.
Why: design sections 3 to 8, architecture 5.
Who must act:
- Lead (design): Time Attack has no upper bound for a perfect player (+1.5 s per break, waves every 1.0 s with up to 3 airborne gives more
  than 1 s of bonus per second). Kept as designed; consider a hard round cap or a smaller late bonus.
- Integrator: `test/architecture/naming.test.js` still expects `storageKey: 'joyconNinja.v1'` in game/config.js; the key is now
  `CONFIG.storage.key = 'clayRush.v1'`. The legacy "gravity 1300 / spawn 1190" test now fails only on render/ and ui/ files.
- Render, UI, audio: the old fruit `CONFIG` blocks (field, caps.particles, fruits, combo, ...) are gone. Read `CONFIG.storage`, `STAGES`,
  `CONFIG.ranks`, `CONFIG.juice.killCam`, `CONFIG.timeattack`, `CONFIG.classic` instead.

## 2026-10-01, Gameplay engineer: Time Attack balance (lead decision)
What: time bonus per break by its rank in the round, +1.5 s (breaks 1-20), +0.75 s (21-40), +0.25 s after (`CONFIG.timeattack.bonusSteps`);
hard cap of 180 s of real round time (`CONFIG.timeattack.roundCapS`): the round ends with `timeUp` and endReason 'timer' when the clock
reaches 0 or the cap is reached. `snapshot.timeLeft` may be above 0 when the cap ends the round. design 7.2 updated. This resolves the
"Time Attack has no upper bound" item of the previous entry.
Who must act: nobody (HUD may show the 180 s cap if it wants: `CONFIG.timeattack.roundCapS`).

## 2026-10-01, UI engineer: UI rebuilt for Clay Rush (facade, facts, intents, storage) and what app.js must do
What:
- **Facade** `ui/presentation.js` `createPresentation(deps)` as 8.1; it only wires `render/world.js` `createWorldRenderer`, `render/hud.js`
  `createHud` and `audio/audio.js` `createAudio` into `ui/presentation-core.js` `createPresentationCore(deps, factories)` (tests inject fakes
  there). Additive deps: `bestHelpers` (below), `createWorldRenderer` / `createHud` overrides. A factory that throws degrades to a plain sky,
  no HUD, silent audio (logged), never a crash. Additive `debug: {ui, world, hud, assets, storage, getWorldView(), getStageId(), getLayout(),
  getWorldDebug()}`.
- **step input**: `{nowMs, dtS, snapshot, events, aim:{x, y, visible, trackingOk, speedDps?}, debug}`. `aim.speedDps` is ADDITIVE: the pointer
  speed in deg/s for the tuning screen (`motion.getState().angularSpeedDps` or the deg/s speed of the newest sample); without it the screen
  shows an estimate marked "≈" (px/s divided by 5 px/deg x sensitivity).
- **World view**: `showCrosshair` is true on `playing` and calibration step 4 only (as 8.1). The tuning screen draws its OWN crosshair at
  `aim` in the colour of the setting, because the world renderer's idle mode draws none.
- **Intents** as 8.3. `startRound{mode, difficulty, stage}`: Classic sends `stage: 'meadow'` (ignored by the game), Zen sends
  `difficulty: 'normal'`, practice (calibration step 4) sends `{mode:'practice', difficulty:'easy', stage:'hills'}`. `endRound.reason`:
  'quit' = abandoned (pause > Quit, disconnect > Back to menu, back during practice, "Calibrate again"); 'finished' = the round is over
  and nothing more is expected (results > Menu, practice hit) OR Zen "End session" from the pause panel, after which the UI WAITS for
  `roundOver` to show the session results (1.5 s fallback to the menu). `fire{t, source}` only while `gameActive` (also `confirm` in phase
  'ready'). The UI also emits `clearCalibration`, `quickRecenter` and `recenter` as before.
- **Facts**: as 8.3. `shotFeedback{jerkPeakDps, displacementPx, compMs, valid}` is shown on the tuning screen; the UI does NOT emit `fire` there
  (no game is active), it only draws a test-shot mark.
- **Storage** `createStorage({key?, backend?, matchMedia?, now?, overrides?, bestHelpers?})`, key 'clayRush.v1', document
  `{v:1, best, settings, safetyAck, playMsTotal}`; settings exactly the table of 8.4. API: `getSettings, updateSettings, resetSettings, bestKey,
  getBest(mode, difficulty, stageId), getAllBest, recordResult(RoundResult) -> {isNewBest, best, previous}, resetBest, getSafetyAck,
  setSafetyAck, getPlayMsTotal, addPlayMs, isPersistent`. `ui/` may not import `game/index.js` (rule 3), so the best helpers are INJECTED.
Why: architecture 8; rule 3 forbids ui -> game/index.js.
Who must act (Integrator, app.js):
1. `createStorage({..., bestHelpers: {bestKey, emptyBest, sanitizeBest, isNewBest, updateBest}})` from `game/index.js` (a local fallback with
   the same keys and record shape is used without them; tested against the real helpers).
2. The UI records the best score and the play time itself on the `roundOver` fact: app.js must NOT record them again (9.1 says app.js does).
3. Send `ui.notify({type:'shotFeedback', ...})` after EVERY Joy-Con `fire` action (not only game shots), so the tuning screen works.
4. Pass `aim` (and optionally `aim.speedDps`) to `presentation.step`; stop passing `blade` / `segments`.
5. On `settingsChanged{patch, settings}` apply `triggerButton` (provider.setTriggerButton), motion settings and the volume (the presentation
   already sets the volume itself).
6. `test/architecture/english-only.test.js` still asserts fruit-era facts (`render/renderer.js` is scanned, `"settings.on": "On"` with double
   quotes); `naming.test.js` and the gravity/spawn-line magic-number test are fruit-era too. The UI strings now say 'ON' / 'OFF' (display
   capitals) in single-quoted JS. `test-support/ui/art-stub.js` and `italian-leaks.js` are kept only because those tests import them.

## 2026-10-01, Render & Audio engineer: render/ and audio/ rebuilt for Clay Rush (APIs as implemented, additive fields, removed modules)
What:
- **Removed** (fruit-only): `render/renderer.js`, `render/trail.js`, `render/banner.js`, the fruit `render/sprites.js`, `render/painters.js`,
  `render/fx.js` and `render/hud.js` (the last four are NEW files with the same names), `palette.js` `FRUIT_ART`, `FRUIT_IDS`, `GOLDEN_ART`,
  `BOMB_ART`, `POWERUP_ART`, `juiceColorOf`, `JUICE_COLORS`; `stage.js` `stageIdFor`, `veilFor`, `createStage().setMode/needsFallback/prefetch/resize`.
  Kept unchanged in API: `assets.js` (log prefix now `[clay-rush]`), `layout.js`, `ease.js`, `draw-util.js` (looks retuned), `fonts.js` API.
  `fx.js` still exports `createPerfGovernor` (plus the generic `ParticlePool`, `ObjectPool`).
- **world.js** exactly 6.1, plus ADDITIVE: `setDensity(k)` (device px per logical px of the baked sprites, default 2), `dispose()`, and
  `getDebug()` extra fields `{pools, gun:{x, y, rot, muzzleX, muzzleY, show}, crosshair, killCam, stillFlash, stageStatus, sprites}`.
  `update(dtS, view)` and `draw(ctx, view)` also call `setStage(view.stageId)` when it changes, so passing the stage in the view is enough.
  The points popups ("+175", digits only) are drawn by the WORLD at the hit point, not by the HUD. The gun opens and ejects the spent hulls on
  `phase{phase:'settle'}` (Classic) and on `reload{phase:'start'}` (Time Attack).
- **hud.js** exactly 6.2, plus ADDITIVE `showBanner(name)` (e.g. `hud.showBanner('newBest')` for "NEW BEST!", which has no GameEvent) and
  `getDebug()`. Export `HUD_KEYS` (= the 8.5 list), `formatClock`, `formatScore`. Zen and practice draw no score panel (design 7.3).
  Parameters passed to `hv.t`: `hud.pull {n, total}`, `hud.pullPrompt {fire}` (= `hv.labels.fire`), `hud.wind {speed}` (string, one
  decimal), `hud.time {s}` (string "M:SS", already formatted), `hud.stage {n, name}`, `hud.stageCard.title {n}`, `hud.stageCard.name {name}`,
  `hud.banner.streak {n}`, `hud.zen.stats {hits, acc}` (acc = integer percent of the last 20 shots), `hud.multiplier {n}`; the others none.
  `hud.best` is reserved (not drawn: the snapshot carries no best score).
- **stage.js**: `createStage({assets, createCanvas, config}) -> {setStage(id), draw(ctx, 'far'|'near', view), status(), dispose()}`; the
  procedural twin of each stage is a cached canvas painted by `painters.js` (`?assets=0` and the moments before the art arrives).
- **palette.js**: new tokens of design 10 plus `CROSSHAIR_COLORS` and `STAGE_PALETTES`; the previous names (`paper`, `ink`, `vermilion`,
  `indigo`, `matcha`, ...) are kept as ALIASES of the new tokens so older UI code draws in the new colours. `TEXT_STYLES` gains `stageCard`,
  `hudLabel`, `hudInfo`; `TEXT_LOOKS` gains `label`.
- **audio.js**: `createAudio` signature unchanged; numbers now in `audio/audio-config.js` `AUDIO_CONFIG` (a caller's `config.audio` block
  overrides keys, `game/config.js` needs no `audio` block any more). Buses renamed `game | event | ui | amb` (`duck(group, amount, ms)` takes
  these). `update(dtS, {screen, stageId, snapshot})` drives the ambience (level by screen: playing/countdown 1, paused 0.35, results 0.6,
  menu 0.85, other 0.75; nothing before a stage is known). NAMED functions: `uiMove uiSelect uiConfirm uiBack uiError uiWhoosh countdown go
  record countTick rankStamp resultsFanfare recenter connectOk`. New sound ids: `shot dryClick shellInsert gunOpen clayBreak goldBreak throw
  clayLand pullCue double streakUp stageClear stageStart timeTick timeBonus timeUp slowmo bird cricket` (+ the UI ids). Removed: every fruit
  sound and `tick`, `gameOver`. Levels calibrated with the offline render (test/audio/offline-render.test.js, headless Chrome).
Why: architecture 6, fork cleanup (rule 12).
Who must act:
- Integrator: `server.js` MIME has no `.woff2`; the fonts are served as `application/octet-stream` with `nosniff`. Chrome loads them anyway
  (checked in the render preview) but please add `'.woff2': 'font/woff2'`. `test/app/art-app.test.js` imports
  `test-support/render/fake-canvas.js` (kept, same API).
- UI engineer: nothing required (presentation-core already uses the 6.1 / 6.2 / 6.4 APIs). Optional: call `hud.showBanner('newBest')`.

## 2026-10-01, Integrator: app.js, clay-api.js and the root files wired for Clay Rush (as implemented), fixes in other areas
What:
- **app.js** follows architecture 3 and 9.1. Shots: `buildShot(t, source)` with `compMs = source === 'joycon' ? settings.triggerCompMs : 0`,
  `motion.aimAt(t - compMs)` when valid, else `motion.headAt(now)`, clamped to 1920 x 1080; queued, consumed by `game.update(dtS, shots, now)` only
  while `ui.getState().gameActive`, otherwise dropped (counted in `__clay.debug.getCounters().shotsDropped`). `roundOver` is sent once, checked
  every frame (also while not active: Zen "End session" ends the round from the pause panel with `game.end('quit')` and the UI waits for it).
  `endRound`: 'quit' = `game.end('quit')` and drop; 'finished' = drop a finished round (or the practice round), end Zen. Best scores and play time
  are NOT recorded by app.js (the UI does it on `roundOver`). `bestHelpers` from game/index.js go to `createStorage` and `createPresentation`.
  Motion gets `{sensitivity, aimCurve, autoCenter (off for the simulator), flipX}`; `provider.setTriggerButton(settings.triggerButton)` on
  every provider change, on every transition to `streaming` and on `settingsChanged`, then the provider fact (labels) is sent again.
  Rumble: `provider.vibrate?.(5)` per `shot` event when `settings.rumble` and `?haptics` is not 0. `motion.drainSegments()` is drained and
  dropped every frame. The recentre hold-off (100 deg/s, 250 ms) applies to `recenter` only, never to `fire`.
- **shotFeedback** is sent for EVERY provider fire action (Joy-Con, simulator, mouse, keyboard; not debug), 160 ms after the press, with
  `compMs` as C-05 (0 for everything but a Joy-Con), so the tuning screen also shows numbers with the mouse and the simulator. Evaluated on the
  Clock in the frame (no timer), so it works under `?clock=manual`.
- **window.__clay** (public/js/clay-api.js): as 9.3. `fire({x, y}?)` queues a Shot with source 'debug', compMs 0 (and moves the crosshair there
  with `aim`); it resolves with `{events, shot}` after the frames of the next 150 ms (FIRE_TAIL_MS, Hard pellet travel included); under the
  manual clock it advances the clock itself. `shootTarget(id, {offsetPx = 0, leadMs = 0})` aims at `Target.sx/sy` (with `leadMs`: the world
  position moved along its velocity with gravity, projected by shared/world.js) and resolves `{events, shot, hit}`. `callPull()` fires only in
  phase ready (`{events, called}`). `start(mode, {difficulty, stage, seed, skipCountdown = true, autoLaunch = true})`: autoLaunch true makes
  Classic call every pull by itself (`debugSetAutoLaunch(true)`), false stops every automatic launch. `aim(x, y)`: simulator = `setTarget`
  teleport, otherwise an aim sample into Motion. Additive: `reanchor`, `getCalibration`, `debug.getWorld()`, `debug.getMotionDebug()`,
  `debug.getProviderStatus()`, `debug.getWakeLock()`, `snapshot().gameActive`; `sim.fire()` is exposed. `press(action)` accepts 'fire'.
- **Root files**: ninja-api.js deleted, `window.__ninja` gone; main.js and index.html say Clay Rush (no font preload: fonts.js loads them and
  `?assets=0` must request nothing under /assets/); server.js serves `.woff2` as `font/woff2`. tools/build-assets.mjs, tools/asset-spec.mjs and
  tools/replay-integrated.mjs deleted (the last one measured sword cuts); so were the fruit-only helpers and tests of test-support/app,
  test-support/e2e (replay-browser, guide-screens, native-screens) and test/app, test/e2e (real-replay, improvements). `tools/lib/report.mjs`,
  `overlay.mjs`, `build.mjs`, `measure.mjs`, `check.mjs`, `csv.mjs`, `ffmpeg.mjs`, `fonts.mjs`, `png.mjs` were only used by the deleted
  tools/build-assets.mjs as far as I can see; they are not mine (tools/lib/imu-recording.mjs is the input engineer's): lead, delete them if unused.
- **Fixes in other areas** (minimal, found while playing in Chrome):
  1. `render/stage.js` (Render): a stage chosen while both resident slots were on screen (during a 400 ms crossfade, e.g. menu -> setup -> a
     quick stage change) was never loaded: `startLoad` returned on a full `ensureCapacity` and nothing retried, so the round showed the
     procedural backdrop for good (reproduced by test/e2e/art.test.js "art 1": meadow -> hills -> alpine). Added `loadWanted()` after a
     crossfade ends. Render tests stay green.
  2. `ui/ui.js` (UI) focus: on the connect screen the main button is disabled while the bridge is probed, so the focus fell back to
     "Simulator" and stayed there: Enter then started the simulator instead of "CONNECT JOY-CON"; and during an attempt a second Enter jumped to
     the simulator. Now a fallback focus returns to the default target once it is enabled, and `connect.main` keeps the focus while an attempt
     disables it. UI tests stay green.
- **Seen, not fixed (cosmetic, owners decide)**: the HUD detects phase changes and the score target in `draw()`; under `?clock=manual` a
  synchronous loop of `advance()` draws nothing, so the stage card starts sliding in at the next draw and the score shows 0 until the next
  draws (real play draws every frame: no effect; the e2e tests draw a few frames before a picture). A banner of the last pull ("DOUBLE!") is
  drawn under the stage card at the start of a stage. On the results screen the world is frozen (dt 0), so the gun and the crosshair of the
  last frame stay visible under the dim. Nothing calls `hud.showBanner('newBest')` (the results screen shows NEW BEST! itself).
  `docs/architecture.md` has no embedded typedef block any more although contracts.js says section 11 embeds it: test/architecture/docs-sync
  now only checks that contracts.js keeps its block and that the architecture names it.
Why: architecture 3, 9; the owner's game must run end to end.
Who must act: Lead: the tools/lib leftovers; the stale "section 11 embeds" line of contracts.js. Render: optional, read the phase from the
`phase` events in `handleEvents` so the HUD does not depend on draws. Nobody else.

## 2026-10-03, Gameplay engineer: difficulty = distance, Time Attack waves (owner rebalance)
What:
- **World scale** `k` = `CONFIG.difficulty.<d>.distanceMul` (easy 0.7, normal 1, hard 1.25; Zen `CONFIG.zen.distanceMul` 0.7, practice 1).
  House positions, launch jitter and speeds x k; gravity, wind acceleration, rabbit hops x k; drag / k; zFar x k (lost and hit test).
  Clay sizes and the pattern radius stay in metres. shared/world.js is unchanged (zNear 4: the closest house is the trap at 9.8 m).
  The snapshot carries the scaled values (`houses[].x/y/z/sx/sy/scale`, targets) plus an additive field `worldScale` (k). Debug spawns
  with explicit `pos`/`vel` take them as actual metres; an explicit `speed` is Normal-world m/s (x k).
- **Difficulty table**: easy {k 0.7, speed x0.9, pattern x1.15, wind x0.5, instant}, normal unchanged, hard {k 1.25, speed x1.05,
  pattern x0.95, wind x1.2, pellet travel at 650 m/s (`CONFIG.shot.pelletSpeed`, was 420)}.
- **Distance bonus** uses z / k (same throw, same score at every difficulty).
- **Time Attack**: one wave at a time (1 or 2 targets, `doubleChance` 0.15 -> 0.6 over 90 s), each wave refills the gun to 2 instantly
  (`reload` start/done with ms 0, only when it was not full); the next wave starts `gapS` (1.4 -> 0.5 s) after every target of the
  previous one is resolved. The 0.6 s reload after 2 shots is removed (`CONFIG.timeattack.reloadS`, `intervalS`, `maxAirborne`,
  `retryS` are gone); `shells.reloadingS` is always 0 in Time Attack. A Time Attack `debugSpawn` counts as a wave and refills the gun.
  Clock, bonus steps and the 180 s cap unchanged. Zen uses the same one-wave model (`CONFIG.zen.gapS` 1.2, `doubleChance` 0.3).
  `CONFIG.waves.<stage>` is now `{singles: [...], doubles: [...]}`.
- design sections 3, 4, 7.2, 7.4 updated.
Why: owner feedback after playing the integrated build (Hard far too hard, Easy not easier, more clays than shells in Time Attack).
Who must act: nobody expected (the renderer draws houses and targets from the snapshot). Render/HUD: if anything reads
`CONFIG.houses.*.x/y/z` directly, use `snapshot.houses` instead; the HUD shell reload animation in Time Attack now only sees ms 0
reloads. UNVERIFIED-ON-HARDWARE: the feel of every difficulty.
- UI: `ui/strings.en.js` `difficulty.*.desc` still describe the old table; suggested: Easy "The clays fly closer: bigger targets, a wider
  pattern, half the wind." Hard "The clays fly farther and the pellets take a moment to arrive: lead a little."

## 2026-10-03, Gameplay engineer: distance accentuated (owner)
What: world scale k easy 0.55, normal 1, hard 1.45 (Zen 0.55, practice 1). Hard speedMul 1.0 and patternMul 1.0 (were 1.05 / 0.95),
pellet travel 650 m/s unchanged; Easy unchanged (0.9 / 1.15 / wind 0.5). zNear: at k 0.55 the nearest point any house or target reaches
is the trap launch point at 7.7 m (measured over 200 launches per house and kind, also for incoming tower clays), no clamp needed; the
fairness rule holds at every k (clamps stay rare: at most 5 in 200 for the slow Zen battue). rPx easy/normal = 1/0.55 = 1.82.
`snapshot.worldScale` unchanged in meaning (k); the game makes no camera change. design 7.4 and 3 updated.
Who must act: Render: optional cosmetic backdrop zoom from `snapshot.worldScale`. UI: difficulty descriptions (see the previous entry).

## 2026-10-03, Render & Audio engineer: smooth clays (no frame swap, no hit-stop freeze) and the difficulty view zoom
What:
- **Cause 1 (the jerks the owner saw)**: `Target.frame` (game `frameFor`, by the elevation of the line of sight) swaps tilt -> edge -> tilt as a
  trap clay crosses the horizon and tilt -> below at 18 degrees; the renderer drew the frame as a different picture, so the clay popped from a
  disc to a vertical sliver for ~15 frames (aspect jump 2.1 per frame, 9 to 18 pops per 20 s run). Now `render/world.js` ignores
  `Target.frame` for standard / mini / battue / gold clays: one base picture, the underside view crossfaded in by the elevation (13..23 deg),
  a continuous vertical squash near the horizon (edge-on), battue always flat, the cosmetic spin as a +-0.2 rad wobble (rabbits keep rolling);
  all from continuous inputs (interpolated sy, rPx, rot). Streak strength is a smooth function of speed (no on/off threshold).
- **Cause 2**: the 40 ms hit stop froze the OTHER clay of a double (position jerk 17.3 px/frame^2). `game/game.js` (minimal, gameplay's file):
  the hit stop is held only when no other clay still flies (event `hitStop` then has ms 0); `test/game/juice.test.js` updated (the freeze test
  split in two). Also `snapshot().targets[].rot` is now interpolated like the position (`b.rot - b.spin * DT * (1 - alpha)`).
- **Bake hitches**: the clay size buckets are baked ahead (sprites `prewarm`/`pump`, 3 per frame, re-queued when the art changes), so a clay
  crossing a bucket never pays a bake; drawing stays sub-pixel at the exact size from the next larger bucket.
- **Difficulty view**: the far and near layers zoom about (960, 670) by clamp(worldScale ^ -0.35, 0.8, 1.4) (Easy 1.23, Hard 0.88), eased
  (tau 0.35 s, a cut with Reduce motion), menus 1, never past the zoom that still covers the field; the far picture is drawn 1.12 x larger at
  k = 1 to give Hard its headroom (horizon kept on 670). Additive `getDebug()`: `viewZoom`, `drawn[] {id, x, y, w, h, rot, a, b, wB}`,
  `stageStatus.zoom`. HUD: the shell insert animation now starts on `ready` / `reload done` events (not on a draw).
- Tools: `test-support/render/smoothness.mjs` (real game, manual clock, per-frame metrics, `--check`), `shoot-difficulty.mjs`.
Who must act: Gameplay: review the hit-stop rule and the rot interpolation in game.js (tests green). Nobody else.

## 2026-10-03, Gameplay engineer: final QA and code review fixes (docs/qa/final/)
What:
- **F9 world scale about the camera**: the world is scaled by k about C = (0, 1.6, 0) (`p' = C + k (p - C)`); the ground plane is
  `y = 1.6 (1 - k)` (`snapshot.houses[].sx/sy` are the ground points on it; rabbits roll one radius above it). Every screen position and
  path is identical to Normal (tested within 1 px for k 0.55 and 1.45); only the drawn sizes change (x 1/k). Target and house `y` values
  in the snapshot are in that scaled world (renderers that only project them need no change).
- **F6 Hard**: pellet speed 750 m/s (the requested 1000 m/s measured 95 percent for a bot aiming straight at the clay: no challenge;
  750 gives 68 percent with one shot per clay, 72 percent with both shells; a leading bot 100 percent), Hard patternMul 1.1.
- **G-05**: the Hard pellet flight is scheduled in world time (a kill cam slows the pellets like the clays).
- **F2**: the Time Attack clock is honest: `timeLeft = min(clock, 120, 180 - elapsed)`, so the round always ends at 0 with ticks.
- **F3**: every Time Attack / Zen wave is a pull of its own: `double` events (+100 x multiplier in Time Attack, 0 points in Zen) and
  `stats.doubles` now work in both.
- **F1 / G-01**: Time Attack ranks S 175,000, A 85,000, B 33,000, C 17,000 (measured table in design 7.2; one table for all difficulties).
- **G-03 / G-04**: `end('finished')` (or 'complete') gives endReason 'complete'; `end()` during phase 'ending' keeps the round's own
  reason (a quit right after "TIME!" keeps a 'timer' result). Integrator: Zen "End session" should call `game.end('finished')`, and
  `finishRound` should announce `roundOver` with `game.getResult()` when the game was in 'ending' instead of dropping it.
- **G-02**: new game method `setReduceMotion(on)` (additive to the Game typedef): from then on no hit stop and no kill-cam slow motion
  (running ones are cleared). Integrator: call it from `applySettings` when `reduceMotion` changes mid-round.
- **R-01**: the game emits `stageClear` (with `perfect`) and then, in the same tick, `stageStart` of the next stage (pinned by a test).
  The order is right; the banner is lost because `render/hud.js` clears its queue on `stageStart`. Render: keep a queued
  `hud.banner.perfect` on `stageStart` (or show it on the stage card). No game change.
- **F12** left as designed (lead decision). G-06 (snapshot allocations) not changed: allowed by the contract. G-08 is in clay-api.js
  (Integrator): use `WORLD.g * snapshot.worldScale` and, after F9, the scaled ground.
Who must act: Integrator (G-02, G-03, G-04 wiring, G-08), Render (R-01 in hud.js).

## 2026-10-03, Input & Motion engineer: final review fixes (docs/qa/final/CODE-REVIEW.md)
What:
- S-01: the owner's console Bluetooth address is gone from `docs/hardware-findings.md`, `bridge/joycon-bridge.m` (selftest) and
  `test/input/ble-transport.test.js`; examples use the made-up `aa bb cc dd ee ff`. The local helper binary was rebuilt. The recordings hold
  only 63-byte input reports (no advert, no host address): nothing to scrub. The address is still quoted in `docs/qa/final/CODE-REVIEW.md`
  (gitignored, lead's file).
- S-02: `motion-config.js` (block `shooter`) now says the gains followed owner feedback after playing with the MOUSE and were never tried
  on a real Joy-Con. Still wrong elsewhere (not my files): `docs/game-design.md:114`, `docs/FINAL-STATUS.draft.md:39`.
- A-01 (`public/js/app.js` buildShot, minimal): a non-Joy-Con fire (keyboard) whose time is not covered by the history uses the newest
  measured sample (`aimAt(motion.latest().t)`), not the extrapolated head.
- I-01: the simulator no longer maps a double click to recenter (two quick shots are a double click); its recenter label is 'Space'.
- I-02: in the aim history a real IMU sample is never overwritten by a later IMU sample with the same time (keep the first measurement).
- I-03: the phantom-bit hold-off after the 0xFF fallback is now per BUTTON (ZL/ZR) (`createButtonActions().holdOffButtons`): with the
  trigger on R shots pass. With trigger ZR a real ZR in that 1.5 s is still dropped (safe: only right after a connection).
- I-04: 'balanced' now reads `aimCurves.balanced` like the other presets.
- `tools/analyze-shots.mjs` replays with `MOTION_CONFIG.shooter` (as app.js), `--sword` for the old gains.
- Diagnostics page: no visible "joyconNinja" key in the save messages; the exported report says `tool: 'clay-rush diagnostics'`.
- Tests: the weak actions hold-off test replaced by per-button cases; shooter gains pinned (motion and test/app); the C-05 app test now
  fails without compensation; app tests for A-01 and I-01.
Who must act: lead for the two S-02 texts above and CODE-REVIEW.md.

## 2026-10-03, Render & Audio engineer: final QA / code review fixes (F4, F5, F8, F10, F11, F13, F15, F22, F23, F24, F26, R-01..R-09)
What:
- F4 `render/stage.js`: a stage change keeps the painted backdrop until the new art is decoded, then crossfades (procedural only after
  `stage.waitArtMs` 2.5 s or a failed load); additive `stage.prefetch(id|null)`; the world prefetches the NEXT Classic stage (by
  `STAGE_IDS` order and `snapshot.stage.index/count`) and keeps it resident. Only the next stage is preloaded (two decoded stages at most,
  about 23 MB each), not all three.
- F5/F13: new `render/label-layout.js`; the world's points popups and the HUD's SMOKED! are one block per break, stacked, inside the field,
  below the banner strip (both modules feed it the same hit events and clock).
- F8: the shake is one raised-cosine bump, 3 px / 90 ms, half while another clay flies. F10: wind sock, arrow and speed on the stage card; "best
  so far" is not in `hv`, so it is not drawn. F11: Zen and Time Attack show the stage name without a number (`hud.stageCard.name`). F15:
  display roles are drawn in capitals (`draw-util.displayCaps`), and the trigger guard of the procedural gun is attached. F22, F23 (+0.25), F24
  (clay icons in the tally).
- R-01: PERFECT STAGE is kept across the `stageStart` of the same tick and shown after the card. R-02/F26: the gun opens once per pull
  (settle), holds until `reload done`, no phantom hull; audio: `gunOpen` only after shots, `shellInsert` only on `reload done`. R-03: the
  sprite cache drops only the ids whose picture changed. R-04: Reduce motion popups and crosshair. R-05: cover margin per layer, aim clamped.
  R-06: HUD and digit option objects reused, memoised spacing / clock / wind strings. R-07, R-08, R-09 done.
Who must act: nobody.

## 2026-10-03, UI engineer: final QA / code review fixes (U-01..U-10, F7, F11, F14, F16-F19, F21, F25)
What:
- U-01: an uncalibrated real Joy-Con never reaches menu/setup/settings/best/tuning/countdown/play: it is routed to the connect screen (no BACK,
  B ignored, toast, auto-continue into the wizard). Mid-round (reconnect to the other unit): the round stays paused, `startCalibration` is
  emitted, the full wizard returns to the pause panel and resumes with the 3-2-1 (NO practice round, no `startRound`); Resume is gated too.
- F7: a mouse click is press + release on the same target in the same screen/overlay generation (`ui.pointerDown` / `ui.pointerUp`, wired
  on the canvas; `pointerClick` stays for the debug API).
- F11 / F18 (no render change): the presentation hands the HUD a per-mode `hv.t` that maps `hud.stage` to `hud.zenStage` "ZEN · {name}" (Zen)
  and `hud.timeAttackStage` "TIME ATTACK · {name}" (Time Attack), and `hud.pullPrompt` with a click label to "CLICK TO CALL PULL!".
- Reduce motion mid-round: the UI already emits `settingsChanged{patch:{reduceMotion}}` and passes the setting to world and HUD every frame
  (tested); the game side (G-02) remains app.js/game's.
- Results are no longer time-frozen (the gun and crosshair animate away, F21). Settings open on the first row (F19).
- `storage.isOverridden(key)` (URL flags lock their rows, U-07); a stored document with another `v` is never overwritten (U-06).
Who must act: Integrator: `test/e2e/stick-nav.test.js:43-44` expects the settings focus on `set.back`; it is now `row:sensitivity` (hint
"STICK: Change   B: Back"); move to BACK first (e.g. Down x7 / Right) before the "up to reduceMotion" steps. Render (optional): F20 (trap
house between the menu panels) is the idle backdrop's.

## 2026-10-03, Render & Audio engineer: video review fixes (gun over the crosshair, houses on menus, top-bar stage label)
What:
- `render/world.js` gun: FPS-like follow (shift right/down with the aim, barrels turn towards the crosshair, up to 30 deg). It never hides
  the crosshair: a silhouette polygon of the gun picture (`ART_CONFIG.gun.silhouette`) is tested every frame and the gun slides back along the
  line from the crosshair by exactly what keeps it `clearPx` (54) away (at once; back with a 120 ms ease); a clay under the silhouette fades
  the gun to 35 percent. Recoil and the muzzle flash use the actual muzzle. Additive debug: `getDebug().gun.slide/alpha/scale` and
  `getDebug().gunCovers(x, y, margin)`.
- Idle (menus) draws no house (`ART_CONFIG.houses.idle` is now unused).
- `render/hud.js`: the top bar names the new stage when the stage card has slid in (not at `stageStart`).
Who must act: nobody.
