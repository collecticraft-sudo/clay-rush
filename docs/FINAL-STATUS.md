# Clay Rush: final status (v1.0.0, 2026-10-03)

Rule of the project: **nothing is claimed about the real Joy-Con 2 that was not measured**. Everything that only the physical controller can
settle is tagged **UNVERIFIED-ON-HARDWARE**.

## 1. What is finished

- A dependency-free web game (HTML5 Canvas 2D, ES modules, a small Node server) with three modes: Classic (three stages, 26 pulls, 36 clays),
  Time Attack (waves of one or two clays, breaks add time, a 180 s cap) and Zen (practice). It is played with a Joy-Con 2 through the native
  Bluetooth bridge for macOS, with Chrome's Web Bluetooth, with a simulator, or with the mouse.
- Difficulty is distance: the whole range is scaled about the shooter (Easy 0.55, Normal 1, Hard 1.45) with a backdrop zoom, so the paths on
  screen stay the same and only the size of clays, houses and shot pattern changes. Hard adds a small pellet travel time (750 m/s).
- Two shells per pull, hit test at the press time, trigger compensation (0 to 100 ms, default 40) with a tuning screen, aim presets with the
  shooting gains, sensitivity up to 3.0, aim assist, auto pull, rumble, reduce motion and reduce flashes.
- Smooth clays: one continuous look per clay (no picture swaps), exact sizes, sub-pixel drawing; the measured worst position jerk is
  1.69 px/frame² with no pops (`test-support/render/smoothness.mjs --check`).
- Art generated with Higgsfield GPT Image 2.5 (13 pictures, 5.5 credits), two OFL fonts (Bebas Neue, Barlow), synthesised audio. Every picture
  and font is optional (`?assets=0`, `?fonts=0`).
- Content: README with a gameplay GIF, guide with the hardware checklist and the recording session, reference, credits, licences, CI, and a
  32.6 s presentation video (release asset) made from real gameplay captured frame by frame.

## 2. How it was checked

| Check | Result (development Mac, macOS 26.6, Node 24.15, Chrome 154, 2026-10-03) |
|---|---|
| `npm test` (unit, integration, headless-Chrome end-to-end) | 1263 tests, 1263 passed, 0 failed, 0 skipped, 111 s |
| `npm run test:unit` | 1210 tests, 1210 passed |
| Independent QA (played every flow in headless Chrome) and white-box code review | all blockers and major findings fixed; a second fix round for the issues seen while making the video |
| Frame time, 20 s of Classic at 1920 x 1080 with the art | 60 fps, p99 frame interval 16.8 ms; JavaScript per frame about 1 ms average |

The CI workflow runs `npm run test:unit` on macOS with Node 22; locally the suite was run with Node 24 only. Numbers from headless Chrome say
nothing about the owner's display or the Bluetooth delay.

## 3. Verified on real hardware

Only for the input stack shared with the previous game ([3D Fruit Dojo](https://github.com/collecticraft-sudo/3d-fruit-dojo),
`docs/hardware-findings.md`): one Joy-Con 2 Right connects through the native bridge and streams at a steady 33 Hz; the accelerometer and gyro
scales, bias and noise come from the recording `recordings/imu-2026-09-30T18-42-24.jsonl`.

**Nothing was verified for Clay Rush itself on hardware.** The owner played Clay Rush with the mouse; the changes to aim sensitivity, clay size,
difficulty and Time Attack came from that feedback.

## 4. UNVERIFIED-ON-HARDWARE

The trigger feel and the wrist jerk on ZR, the 40 ms default compensation, the rumble, the shooting aim gains and the sensitivity range, the aim
stability while holding still, the pistol grip in calibration, how each difficulty feels with the controller, the end-to-end latency, the Left
Joy-Con, Chrome's Web Bluetooth path, and the bridge's keep-alive and reconnect during a long session. The guide's hardware checklist
(section 10) and the recording session (section 12, `tools/record-imu.mjs` with `tools/shooting-steps.json`, then `tools/analyze-shots.mjs`)
turn these into measurements.

## 5. Known limitations

- macOS only for the real controller (the native bridge is Objective-C with CoreBluetooth); the mouse and the simulator work in any Chrome.
- The raw Higgsfield outputs are not in the repository, so `npm run build:assets` cannot rebuild the backdrops, the gun and the logo from a
  fresh clone (the shipped files in `public/assets/` and the cut sprites in `design/sprites/` are included).
- Best scores live in the browser's local storage only.
