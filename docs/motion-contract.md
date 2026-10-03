# Motion contract (round "sword tuning", 2026-09-30)

What this is: the exact interface and the numbers that the **Motion engineer**, the **Settings engineer** and the **Integrator** implement IN PARALLEL after the first real test of the sword. Evidence for every number is in `docs/motion-findings.md` (a real Joy-Con 2 Right recording, `recordings/imu-2026-09-30T18-42-24.jsonl`) and is reproducible with `tools/replay-motion.mjs`, which is a **reference prototype of sections 2.1 to 2.5** (not production code: port the formulas, do not import it).

Where this document and `docs/architecture.md` or `docs/game-design.md` disagree, this document wins for everything it covers; the Integrator syncs the two older documents (section 6.4). Everything that depends on the physical controller or on how the owner finds the feel is **UNVERIFIED-ON-HARDWARE** (risks, section 7).

Conventions: angles in degrees, angular speed in deg/s (`dps` in code names), playfield px (1920 x 1080, y down), times in ms unless a name ends in `S`. "Tip speed" (`s`) is the angular speed at which the tip of the blade moves: the gyro vector without its roll component about the blade axis.

## 0. Decisions at a glance

| # | Decision | Section |
|---|---|---|
| D1 | Real sensors (Joy-Con over Bluetooth or the native bridge) use a **relative, mouse-like pointer in the local frame of the sword**: the cursor moves by `gain(tip speed) x tip velocity`; no absolute orientation, no gravity, no yaw reference. The **simulator keeps the absolute model** (it is a mouse in disguise) and the mouse/debug aim path is untouched. | 1, 2.6 |
| D2 | Pointer curve: dead zone **5 deg/s**, gain **5 px/deg** just above it rising smoothly to **14 px/deg** at 305 deg/s and above; `sensitivity` (default 1.0, range 0.3 to 2.0) scales the whole curve. | 2.2 |
| D3 | The cut decision is made in **angular tip speed (deg/s)**, independent of `sensitivity`: enter at **300** (default), leave below **0.65 x**, **25 ms** minimum duration, first chord delivered retroactively, swing grace 100 ms. Range 100 to 700 step 25; presets **Easy 225, Normal 300, Hard 450**. | 2.4, 3 |
| D4 | Idle soft auto-centre: after **1.0 s** below **8 deg/s** (and 500 ms without cutting) the cursor glides to the centre at **120 to 800 px/s**; it stops at once above **14 deg/s** and never runs while cutting. | 2.3 |
| D5 | 33 Hz robustness: the path between two samples is a **quadratic** (velocity linear in time); collision segments are cut into **chords of at most about 48 px**; the ring that feeds the trail holds interpolated samples every **8 ms**; `headAt` extrapolates up to **35 ms** with a no-reversal clamp. | 2.5 |
| D6 | **Every "speed" that the game, the renderer and the audio see keeps its old scale**: `BladeSample.speed` and `BladeSegment.speed` are in "px/s-equivalent" = tip speed x **10/3** (300 deg/s = 1000 px/s), so nothing in `game/`, `render/` and `audio/` changes. New fields carry the real units. | 4.2 |
| D7 | `Settings`: `sensitivity` 0.3..2.0 step 0.1 default 1.0 (new meaning), `cutThreshold` 100..700 step 25 default 300 deg/s (new unit). Storage document **v2**; a v1 document keeps everything except these two settings, which are reset once, with a one-time notice. | 3 |
| D8 | Ownership is disjoint file by file (section 6); the seams between the three roles are exactly the names printed in sections 3 and 4. | 6 |
| D9 | **Round F1 (2026-09-30, after the verifier's finding F1): the VERTICAL axis of the relative pointer follows the elevation of the blade** (rotation about the horizontal axis perpendicular to the blade, from the gravity direction of the orientation filter) with a gain capped at **6 px/deg**, used only while a calm accelerometer reading has confirmed the tilt; the horizontal axis, the curve and the cut decision are unchanged. This amends D1 ("no gravity") for the vertical axis only. | 2.9 |

## 1. The pointer model

### 1.1 Candidates and what the replay said

Six models were replayed over all nine steps (`node tools/replay-motion.mjs`); details and per-step numbers in findings section 11.

| Model | What it is | Result on the real recording |
|---|---|---|
| **base** | the shipped pipeline: absolute orientation (gyro yaw, gravity pitch), 27.4 px/deg, cut 1000 px/s | cursor pinned at a screen edge 24 % of the yaw sweep, 80 % of the horizontal and 90 % of the vertical swings; a slow 30 + 20 degree posture change moves it 996 px; 50 % and 62 % of the two slow sweeps are CUTTING; 3 of 6 vertical strokes do not register |
| **abs27** | same pointer, new cut logic | pointer problems unchanged (same edge time, same 996 px) |
| **abs12** | absolute, 12 px/deg (the best an absolute model can do about sensitivity) | the owner's own sweep (100 degrees peak to peak) covers 65 % of the width; the screen width needs 160 degrees; the posture change still moves the cursor 436 px; pinned 79 % of the vertical swings |
| **relGravity** | relative, tip velocity decomposed with the gravity direction every sample ("player space") | direction of the cursor reverses (up to 175 degrees between two consecutive fast samples) in 7 of 21 hard strokes, because the vertical slashes pass the pole (elevation up to 77 degrees, the wind-up carries the blade over the head) |
| **relRoll** | relative, sword-plane velocity rotated by a tracked, clamped gravity roll | turns the owner's yaw sweeps into diagonals (y range 52 % against 31 %), needs a roll estimator, gains nothing measurable |
| **rel (chosen)** | relative, local frame of the sword | hold windows: cursor range 0.0 px; yaw sweep 55 % of the width; hard stroke 94 % (horizontal) and 142 % (vertical) of the screen; 133 px for the posture change; 0 % false CUTTING; 21 of 21 hard strokes cut |

### 1.2 Decision

**Relative pointer in the local frame of the sword for every real sensor** (`provider.kind` `joycon`, including the native bridge). Reasons, in order of weight:

1. **The yaw of an absolute pointer is unobservable.** There is no magnetometer; yaw comes from integrating the gyro. Drift itself is tiny here (0.02 to 0.2 degrees in 8 s), but the absolute pointer cannot know the player's posture: turn the body 30 degrees and the whole map moves 800 px. A relative pointer has nothing to lose when the posture changes (133 px for the test above, and the idle auto-centre returns the cursor).
2. **Range.** An absolute map needs a rotation range equal to the screen angle; at the gain that makes the screen comfortable (more than 12 px/deg) the owner hits the edges, at lower gains he cannot reach them. A relative pointer with a speed-dependent gain has both: fine aiming at low speed, a full-screen slash at stroke speed (94 % of the width for the owner's median horizontal stroke).
3. **No reference to lose.** No edge slip, no soft centring of references, no "re-centre" button needed after a reconnect. The cursor is the only state and it is clamped: moving back moves it back at once.
4. **Dead zone and acceleration are natural** in a relative pointer and remove tremor completely (range 0.0 px over both still windows).

### 1.3 Why the local frame (no gravity) inside the relative model

> **Amended by round F1 (section 2.9): the HORIZONTAL axis stays in the local frame as argued below; the VERTICAL axis now uses the gravity direction.** Sustained vigorous swinging on the real recording showed that the local frame's vertical axis drifts (the wrist rolls between the strokes, which tilts the sword's own pitch axis: net -357 degrees of local pitch against +1 degree of real elevation over `fast_swings_h`). Bullets 2 and 3 below ("needs nothing but the calibrated frame", "no orientation filter") no longer hold for the vertical axis; risk R12 lists what it costs.

- The owner rotates about the **sword's own axes** (rotation axis 17 degrees from the device z axis, 19 from the world vertical; energy share 84 to 90 % on the sword's own yaw and pitch axes). A gravity-referenced ("player space") pointer would turn his horizontal sweeps into diagonals, and it is undefined at the pole, which his vertical slashes pass.
- It needs **nothing but the calibrated frame** (right, forward, up in device coordinates) and the gyro: no orientation filter, no accelerometer trust, no startup transient, no dependency on cutting state. Fewer failure modes at 33 Hz.
- Roll about the blade axis does not move the tip and is ignored by construction.
- **Cost, stated honestly:** wrist roll tilts the pointer axes by the roll angle. If the sword is rolled 40 degrees and then turned about the world vertical, the cursor moves 40 degrees off the horizontal. The recording shows no need for compensation (relRoll is not better), but it is one owner; if play shows otherwise, `relRoll` (prototype mode `roll`) is the documented fallback (risk R3).

### 1.4 Which model serves which provider

| Source | Pointer | Cut decision | `pointerModel` |
|---|---|---|---|
| Joy-Con over Web Bluetooth or the native bridge (IMU samples, `pushImu`) | relative, local frame | angular tip speed, deg/s (2.4) | `'relative'` (default) |
| Simulator (IMU samples generated from the virtual mouse) | absolute (`AimMapper`, unchanged, 27.4 px/deg x sensitivity) | cursor speed in px/s, threshold `T x 10/3` (2.6) | `'absolute'` |
| Mouse, `ninja.swing` debug swings (`pushAim`) | none (the position is given) | cursor speed in px/s, threshold `T x 10/3` (2.6) | (not used) |

The simulator stays absolute because its whole purpose is that the virtual sword aims where the mouse points; a relative pointer would break every simulator scenario and the e2e tests without improving anything the owner feels.

## 2. Formulas and default numbers

All constants live in `MOTION_CONFIG` (section 2.8), separate and tunable in minutes. Reference implementation: `tools/replay-motion.mjs` (class `Proto`, `PARAMS`).

### 2.1 Tip velocity (per IMU sample)

Inputs: `w` = (gyro - bias) x `gyroSign` x `gyroScale`, in deg/s, device frame (exactly as today); `frame` = `{right, forward, up}` of the calibration (device coordinates, orthonormal, `right x forward = up`).

```
tv = w x forward                 // cross product: velocity of the blade tip direction, deg/s, perpendicular to forward
aR = tv . right                  // = - w . up     (tip moving towards the sword's right)
aU = tv . up                     // = + w . right  (tip moving towards the sword's up)
s  = hypot(aR, aU)               // tip speed, deg/s (roll about forward does not contribute)
vR = flipX ? -aR : aR ; vU = aU
```

Signs (they reproduce the existing convention: yaw to the right moves the cursor right, pointing up moves it up): turning the blade to the right gives `w . up < 0`, hence `vR > 0`; tipping the blade up gives `w . right > 0`, hence `vU > 0`. A sample with `s < 1e-6` has zero pointer velocity.

The cut decision, the dead zone, the gain, the idle test and the meter all use `s`. `BladeSample.angularSpeedDps` stays `|w|` (total), for diagnostics.

### 2.2 Pointer curve (dead zone, acceleration, gain)

```
e  = s - deadDps                                       // deadDps = 5
F(s) = 0                                               if e <= 0
F(s) = sensitivity * e * ( gLo + (gHi - gLo) * smoothstep( min(1, e / rampDps) ) )     // px/s
       gLo = 5 px/deg, gHi = 14 px/deg, rampDps = 300, smoothstep(x) = x*x*(3 - 2x)
cursor velocity (px/s):  vx = F(s) * vR / s ,   vy = - F(s) * vU / s        (screen y is down)
```

`sensitivity` multiplies the speed and nothing else; it does not touch the dead zone, the ramp, the cut decision or the idle test. The gain is zero at the edge of the dead zone and continuous everywhere (no step), so a wobble just above 5 deg/s moves the cursor a few px per second, not a jump.

Values (sensitivity 1.0; `px/deg` = F / s):

| tip speed (deg/s) | 5 | 6 | 8 | 10 | 20 | 30 | 50 | 75 | 100 | 150 | 200 | 300 | 450 | 600 | 800 | 1000 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F (px/s) | 0 | 5 | 15 | 25 | 76 | 129 | 250 | 437 | 678 | 1345 | 2236 | 4128 | 6230 | 8330 | 11130 | 13930 |
| effective px/deg | 0 | 0.8 | 1.9 | 2.5 | 3.8 | 4.3 | 5.0 | 5.8 | 6.8 | 9.0 | 11.2 | 13.8 | 13.8 | 13.9 | 13.9 | 13.9 |

At sensitivity 0.6 multiply the F row by 0.6, at 1.5 by 1.5 (for example 100 deg/s: 407 and 1017 px/s). For reference the shipped mapping was 27.4 px/deg at every speed (13.7 at its minimum).

Integration (per sample, device time): with `v0` the cursor velocity of the previous accepted sample and `v1` of this one, `dt` the device step in seconds,

```
p1 = clamp( p0 + 0.5 * (v0 + v1) * dt , playfield )            // trapezoid; no hidden offset beyond the edge
```

`dtMs === null` (first sample, a hole of 200 ms or more) integrates nothing: `p1 = p0` and `v0 := v1`. A lost packet (dt 60 ms) is integrated normally. `sensitivity` and `flipX` changes take effect on the next sample and do not raise a discontinuity in the relative model (the cursor does not jump).

### 2.3 Idle soft auto-centre

Runs only when `autoCenter` is on, the blade is not cutting, and `t - lastCuttingT >= quietMs` (500 ms). Uses the tip speed `s`.

```
not centring:  if s < idleDps (8):  idleFor += dt;  if idleFor >= idleHoldS (1.0 s): start centring (centreStartT = t)
               else idleFor = 0
centring:      stop (idleFor = 0) as soon as  s > idleBreakDps (14)  or  cutting  or  t - lastCuttingT < quietMs
step:          d = | centre - p | ;  if d > 0.5:
                   speed = clamp( centreGain * d , centreMinPxS , centreMaxPxS ) * min(1, (t - centreStartT) / centreRampMs)
                   p += (centre - p) / d * min(d, speed * dt)
               centreGain 2.5 /s, centreMinPxS 120, centreMaxPxS 800, centreRampMs 300
```

- `MotionState.refDriven` (and `BladeSample`-level equivalent used by the menu dwell) is **true on every sample on which a centring step moved the cursor**, exactly the R2-01 semantics of today: the menu dwell never arms on a cursor that the centring dragged onto a target, and the tuning-screen reach test ignores those positions.
- The `recenter` event with `kind: 'auto'` fires when the centring **arrives** (`d <= 0.5`) after having moved the cursor by at least 40 px since it started (`centreArriveEventPx`).
- The menu dwell ("Hold to select", 900 ms) completes before the 1.0 s rest hold expires, as in the shipped design.
- Measured with real hand-held tremor as input: from a corner (1020 px away) the cursor is within 100 px of the centre after 2.5 s and within 20 px after 3.0 s, from the bottom edge 1.8 s and 2.4 s (hold time included); 0 samples of centring while the tip moved faster than 21 deg/s or while cutting (findings 10.4).

### 2.4 Cut decision (angular speed, hysteresis, minimum duration)

Applies to IMU samples in the **relative** model. Per sample at time `t` with tip speed `s`:

```
T = cutThreshold * cutMul                // deg/s, cutThreshold 300, cutMul 1 (Zen 0.8 -> 240)
R = releaseRatio * T                      // 0.65 * T
discontinuity (gap, lost link, recentre ease, reanchor):  cutting = false; candidate = null; (lastLeftT = t if it was cutting); forceNewSwing = true; emit no segment; return

if not cutting:
    if s >= T:
        if candidate == null: candidate = { tAbove: t, held: [] }        // its anchor is the position of the PREVIOUS sample
        if t - candidate.tAbove >= minDurationMs (25):  ENTER           // a second sample at or above T, at least 25 ms after the first
    elif candidate != null and s >= R and t - candidate.tAbove < candidateMaxMs (100):  keep the candidate (a dip that stays above R)
    else: candidate = null and drop its held chords
    if candidate != null and not ENTER: candidate.held += the chords of the interval that ends at this sample
else:                                     // cutting
    if s < R:  cutting = false; lastLeftT = t
```

- **ENTER:** `cutting = true`. `swingId += 1` unless a swing exists, `forceNewSwing` is false and `t - lastLeftT <= swingGraceMs` (100): then it **continues** the same `swingId`. The held chords of the candidate plus the chords of the current interval are emitted as segments (`drainSegments`) at this sample, and the interpolated ring samples of those intervals are patched to `cutting: true` and the swing id (so the trail colours are right).
- **While cutting** the chords of every interval are emitted as segments. The chord of the interval that ends at the LEAVING sample is not emitted (`segmentValid => cutting`, unchanged invariant).
- Consequence of the 25 ms rule at 33 Hz: a swing needs two samples at or above `T` at least 25 ms apart with no sample below `R` in between (at 33 Hz: two consecutive samples, 30 ms apart); the cut starts **one sample (30 ms) after the first sample at or above `T`**, but the first chord is delivered retroactively, so 95 % (horizontal) and 90 % (vertical) of the cursor path of a real stroke is inside cut segments (median).
- A single-sample spike (one sample at or above `T`, the next below `R`) never cuts. A dip to a speed still above `R` keeps the swing.
- The rule is in time, not samples: at 66 Hz or 250 Hz it means 2 or 7 samples.
- `sensitivity` does not enter: replayed at 0.3, 1.0 and 2.0 the CUTTING sequence is identical.
- **Safety cap (IMU, relative):** a sample whose `|w|` exceeds `cut.safetyCapDegPerS` (2190) is ignored completely (no pointer motion, no candidate) and raises `gyro_saturated`; the next sample integrates over the device step from the last accepted one. It never happens in the recording (maximum 1049 deg/s). The aim path and the absolute model keep the px/s cap.

Chosen numbers (findings 10.1): 300 deg/s is the lowest round threshold with 0 % false CUTTING in every slow step (owner's aiming: median 54, p99 253, max 326) and 21 of 21 hard strokes recognised (slowest peak 632); Easy 225 still keeps about 2 % false cutting in the most vigorous aiming; Hard 450 keeps all strokes with 88 % / 81 % of the stroke path in cut segments.

### 2.5 The path between two samples, segments, trail ring, head

At 33 Hz the tip moves up to 408 px between two samples at stroke speed. For the interval between two consecutive accepted IMU samples (`dt <= maxGapMs`) with endpoint positions `p0`, `p1` and cursor velocities `v0`, `v1` (px/s):

```
p(tau) = p0 + v0 * tau + 0.5 * (v1 - v0) / dt * tau^2           // quadratic, velocity linear in time; each point clamped to the playfield; p(dt) := p1
len    = max( |p1 - p0| , 0.5 * (|v0| + |v1|) * dt )
```

1. **Collision chords** (only while CUTTING, plus the retroactive ones): `n = clamp( ceil(len / maxChordPx), 1, maxSubSteps )` with `maxChordPx = 48`, `maxSubSteps = 32`. Sub-step `j = 1..n` covers `tau = (j-1)/n * dt .. j/n * dt` and becomes a `BladeSegment { t0, x0, y0, t1, x1, y1, speed, swingId }` with `speed` = the interpolated tip speed at its end x 10/3 (px/s-equivalent). Chords shorter than 1 px are not emitted. Sub-steps are uniform in time, so the longest chord is about 1.3 x `maxChordPx` (measured 61 px; hard bound: 2 x = 96 px). Consecutive segments of one cut run are contiguous (`t0` and position equal to the previous `t1` and position). The game needs no change: it already tests every segment against every object.
2. **Trail ring** (`recent()`): between two real samples `m = clamp(ceil(dtMs / trailStepMs), 1, 8)` (`trailStepMs = 8`) points uniform in time are inserted into the history ring with `interpolated: true` (the real sample is the last, `interpolated: false`); the ring size is `tracker.historySize = 384`. The `blade` **event** is still emitted once per real sample (architecture 6.2 unchanged); only `recent()` contains the interpolated ones. They carry `cutting`, `swingId`, `speed`, `speedDps`, `trackingOk: true`, `discontinuity: false`, `segmentValid: false`, `source: 'imu'`, and `vx`, `vy`.
3. **Head extrapolation** (`headAt(nowMs)`, for drawing the head/cursor only, never for collision): when the newest sample is a real IMU sample of the relative model, `trackingOk`, not a discontinuity:

```
ext = clamp( nowMs - t_last , 0 , pointer.extrapolateMaxMs (35) )
a   = (v_last - v_prev) / dt_prev                      // from the last two accepted samples; 0 if there is no previous one
if a . v_last < 0:  tt = min( ext , |v_last| / ( - a . v_last / |v_last| ) )   // decelerating: stop when the velocity would reverse
else                tt = ext
head = clamp( p_last + v_last * tt + 0.5 * a * tt^2 , playfield )
```

   For the absolute model and the aim path `headAt` is unchanged (linear, `extrapolateMaxMs` 15). Measured on the horizontal hard strokes (phases 0.2 to 1.0 of a sample interval, truth = the quadratic path to the next sample): hold last 113 px mean / 319 px p95; linear 18 / 61; this predictor **13 / 46**.

### 2.6 Absolute model (simulator) and aim path: unchanged, with the new threshold units

- `pointerModel === 'absolute'` runs `AimMapper` exactly as today (references, soft centring, edge slip, recentre ease) with `ppd = pxPerDegBase x sensitivity`; `sensitivityRange` becomes `[0.3, 2.0, 0.1]` (default 1.0) so that one `MotionSettings` range serves both models. `pxPerDegBase` stays 27.4 (`INPUT_CONFIG.sim.pxPerDeg` too).
- The cut decision for the absolute model and for `pushAim` samples stays the **existing px/s tracker** (`BladeTracker`: 50 ms window, enter at T, leave below 0.65 T, merge 6 px / 8 ms, swing grace 100 ms, **no minimum duration**), with the threshold converted: `T_px = cutThreshold x cutMul x cut.aimPxPerDps`, `aimPxPerDps = 10/3`. At the default 300 deg/s that is **1000 px/s, the shipped mouse behaviour**: existing mouse, simulator and debug-swing tests keep their speeds (Easy 225 -> 750 px/s, Hard 450 -> 1500 px/s; the old presets were 700, 1000, 1500).
- `BladeSample.speedDps` for those sources is `speed / (10/3)` (so the settings meter and the tuning screen mean the same thing for every provider).

### 2.7 Behaviour of the pipeline calls in the relative model

| Call | Behaviour |
|---|---|
| `reset()`, `setCalibration(cal)` (also `null`), end of the wizard (step 3 passed), `startCalibration` | cursor := centre (960, 540); velocity memory cleared; the next sample has `discontinuity: true` |
| `recenter(kind)` | cursor is placed at the centre; the emitted samples ease from the old cursor position to `centre + motion since the call` over `recenterEaseMs` (150) and carry `discontinuity: true` (no cutting), as today. Emits `recenter`. Ignored without a calibration, during the full wizard, and for the aim source |
| `beginQuickRecenter()`, `confirmCenter()` | unchanged flows; completion sets the cursor to the centre (step 3 has nothing else to set: there are no references) |
| `reanchor(x, y)` | cursor := (x, y) at the next IMU sample, `discontinuity: true`; the test hook for the acceptance metrics |
| `markDiscontinuity('lost')` | next sample `discontinuity: true`; **the cursor does not move** and nothing is re-referenced (a hole loses only the motion inside it); `recenter('reconnect')` remains valid (it centres the cursor) |
| `setSettings` | `sensitivity` clamp [0.3, 2.0]; `cutThreshold` clamp [100, 700]; `cutMul` [0.1, 3]; changes take effect on the next sample; `swingId` is not reset |
| `poll(now)` | unchanged (tracking lost after 200 ms: one synthetic sample, `trackingOk: false`, leave CUTTING; the first real sample afterwards is a discontinuity) |
| `getState().yawDeg / pitchDeg` | `null` in the relative model (there are no absolute angles); the diagnostics overlay uses `getDebug()` |
| `getDebug()` | adds `pointer: { model, tipSpeedDps, vx, vy, centring, idleForS }` |
| orientation filter, online bias, wizard | unchanged; in the relative model the filter is **not needed for pointing** (it may still run for `getDebug().q` and the gyro bias estimator's rest detection uses the accelerometer directly); the wizard (frame, sign, scale, bias) is unchanged |

### 2.8 `MOTION_CONFIG` additions and changes (motion-config.js, deep-frozen data)

```js
input: {                                   // absolute model (simulator): unchanged, except:
  sensitivityDefault: 1.0, sensitivityRange: [0.3, 2.0, 0.1],
  // pxPerDegBase 27.4, restDegPerS, restHoldS, restBreakDegPerS, slewDegPerS, cutQuietMs, edgeSlip*, recenterEaseMs: unchanged
},
pointer: {                                 // NEW: relative model
  deadDps: 5, rampDps: 300, gLoPxDeg: 5, gHiPxDeg: 14,
  idleDps: 8, idleBreakDps: 14, idleHoldS: 1.0, quietMs: 500,
  centreGain: 2.5, centreMinPxS: 120, centreMaxPxS: 800, centreRampMs: 300, centreArriveEventPx: 40,
  maxChordPx: 48, maxSubSteps: 32, trailStepMs: 8, maxTrailSteps: 8,
  extrapolateMaxMs: 35,
  gravityVertical: true, verticalMaxPxDeg: 6, gravityMinCos: 0.05,        // round F1 (2.9)
},
fusion: { gravityConfirmTrust: 0.4, gravityConfirmTiltDeg: 8, unconfirmedTauS: 0.3 },   // round F1 (2.9), added to the unchanged fusion values
cut: {
  thresholdDefault: 300, thresholdRange: [100, 700, 25],            // deg/s
  releaseRatio: 0.65, minDurationMs: 25, candidateMaxMs: 100, swingGraceMs: 100,
  aimPxPerDps: 10 / 3,                                               // aim path and absolute model: T_px = T * aimPxPerDps
  speedWindowMs: 50, mergeSegmentPx: 6, mergeFlushMs: 8,             // px tracker (aim path, absolute model): unchanged
  safetyCapDegPerS: 2190, safetyCapMousePxPerS: 60000,               // unchanged
},
tracker: { historySize: 384, segmentQueueMax: 1024 },                // was 128 / 512 (interpolated samples, sub-segments)
extrapolateMaxMs: 15,                                                // absolute model and aim path: unchanged
```

Everything else (`fusion`, `gyroBias`, `calibration`, `trackingLostMs`, `maxGapMs`, `orientationResetGapMs`, `saturation`, ...) is unchanged. All numbers are starting values, UNVERIFIED-ON-HARDWARE, except where the findings measured them on the one recording.

### 2.9 The vertical axis in the gravity frame (round F1, after verifier finding F1)

**The finding.** Replaying `fast_swings_h` whole (15 slashes) with the contract's pointer, the cursor sat on a screen edge 35 % of the time, its median height was 987 of 1080 and only 10 % of the CUTTING samples were in the middle half of the screen height (29 % for `fast_swings_v`). The unclamped cursor path netted +4222 px downward over a back-and-forth test that should net about zero. A constant gain of 9 or 14 px/deg did not remove it, so it was not the acceleration curve alone. Reproduce: `node tools/verify-round-1/ratchet3.mjs; node tools/verify-round-1/edges.mjs; node tools/verify-round-1/bands.mjs`.

**Root cause (measured, `docs/motion-findings.md` section 15).**

1. *Wrist roll tilts the sword's own pitch axis.* Integrating the gyro into a full orientation, the tip of the sword in `fast_swings_h` stays at an elevation of 10 to 35 degrees (net change +1 degree) while it swings 160 degrees in azimuth; but the owner rolls the sword about its blade by +17 to -35 degrees during the slashes. The local vertical rate `w . right` is the rotation about the sword's own right axis, so it carries `sin(roll)` of the horizontal turning rate, with a different sign and size for the forward and the return stroke: its integral over the step is **-357 degrees** (the real elevation change: +1). The same rate taken about the horizontal axis gives +12 degrees.
2. *Gain hysteresis.* With the accelerating curve, up and down movements of unequal speed through the same angle move the cursor unequally (a fast leg at 14 px/deg, the slower way back at 5 to 9): every cycle leaves a residue in the direction of the fast leg. In the slashes the tip rises a few degrees during the fast part and falls back during the slow pause. With the roll removed (the vertical rate taken about the horizontal axis, the curve kept) the drift changes sign instead of vanishing: median y 108 (the cursor ends at the TOP edge), 21 % of the CUTTING samples in the middle half; with a constant gain (9 px/deg, no acceleration) it is 89 %. It is a second, independent cause.
3. *No return path in continuous play.* The idle centring needs 0.5 s without cutting plus 1.0 s under 8 deg/s and is off while swinging; the pauses between slashes are 20 to 50 deg/s. The verifier's first option, a spring to the centre whenever the blade is not CUTTING, was replayed on the old pointer: a y-only spring of 1 per second brings `fast_swings_h` to 52 % of the CUTTING samples in the middle half (2 to 4 per second: 59 to 60 %; the vertical chops: 30 %, no better than before) and compresses slow vertical aiming (the pitch sweep's y range 284 to 233 px at 1 per second, 205 px at 2); an x-and-y spring also squeezes the yaw sweep (1066 to 955 px at 1 per second, 627 px at 4). It fights exactly what the dead zone and the curve were built to protect, so it was rejected.

**The fix (D9).** Per IMU sample, in the relative model:

```
u  = world up in device coordinates (the orientation filter's predicted gravity direction)
n  = forward x u                      // the horizontal axis about which the elevation of the blade changes, |n| = cos(elevation)
pitchRate = (w . n) / |n|             // deg/s, positive = the tip rises; clamped to +-s (s = tip speed); needs |n| >= gravityMinCos
vy = - verticalGain(s) * pitchRate    // px/s, y is down
verticalGain(s) = sensitivity * min( pointerGainPxPerDeg(s), verticalMaxPxDeg )     // gain of 2.2 capped at 6 px/deg (above about 75 deg/s)
```

- `vx` is unchanged (`F(s) * aR / s`, local frame). The dead zone, the ramp, the idle centring, the cut decision (`s`, deg/s), the segments, the trail and `headAt` are unchanged; `vy` replaces the old vertical component. `flipX` mirrors x only.
- Identity mount, level and upright sword: `n = right`, so `pitchRate = w . right`, the old local rate. The difference appears with roll and with pitch: it is the rate that matters to a person (the tip rising) whatever the wrist does, and it is still right when the sword is upside down (the wind-up over the head).
- **Below about 75 deg/s the vertical gain IS the horizontal gain** (slow vertical aiming feels exactly as before: the pitch sweep covers 26.4 % of the height, the contract reference 26.3 %); above it the gain is flat at `verticalMaxPxDeg` x sensitivity, so a fast leg and a slow leg through the same elevation angle move the cursor about equally. A flat gain from the dead zone (a ramp of 30 deg/s to 6 or 7 px/deg) was also measured: slightly better path independence (96 % of the CUTTING samples in the middle half instead of 93 %), but it raises the vertical range of the owner's pitch sweep by 17 % (6 px/deg) to 37 % (7 px/deg), against owner remark (3); rejected.
- **Trust in the tilt.** The orientation filter reports `confirmed`: false after every (re)initialisation (start, hole of more than 1 s, reset), true from the first correction with a trust weight of at least `fusion.gravityConfirmTrust` (0.4) whose residual tilt error is at most `fusion.gravityConfirmTiltDeg` (8 degrees), i.e. the first time a calm accelerometer reading agreed with the gyro-integrated gravity direction. While unconfirmed the vertical axis uses the local rate `tip.vU` with the same capped gain, and the filter corrects with the faster time constant `fusion.unconfirmedTauS` (0.3 s; relative model only, the absolute model keeps its schedule) after the 1 s start-up boost. Reason: a start or a reconnection in the middle of a hard swing initialises the tilt from a contaminated reading (measured on synthetic slashes with a lever arm: the tilt starts up to 60 degrees off and is still 30 to 40 degrees off after 4 s of continuous slashing, the cursor height then wanders over 280 to 640 px); the local rate is never worse than before round F1. On the recording the tilt is confirmed 0.03 s into the slow steps (`hold_still`: 1.0 s), 0.7 s into `fast_swings_v` and 3.3 s into `fast_swings_h` (the owner was still handling the sword and swinging without a calm moment; until then the local rate with the capped gain runs).
- **Zenith.** Within `pointer.gravityMinCos` (0.05, 2.9 degrees) of the vertical the pitch axis is undefined: the local rate with the capped gain is used. In between the axis is ill-conditioned (an error of 2 degrees in the tilt is 11 degrees of axis direction at 80 degrees elevation) but the owner's over-the-head wind-ups cross it only slowly, and the tip speed clamp bounds every error. A blend of the two rates over 72 to 87 degrees was measured and rejected: it re-introduces the local drift in the chops (cutting samples' median y 500 to 650 instead of 322).
- **Config** (`MOTION_CONFIG`): `pointer.gravityVertical` (true; false restores the vertical axis of 2.2 exactly, for A/B and rollback), `pointer.verticalMaxPxDeg` (6), `pointer.gravityMinCos` (0.05), `fusion.gravityConfirmTrust` (0.4), `fusion.gravityConfirmTiltDeg` (8), `fusion.unconfirmedTauS` (0.3).
- **API.** `getDebug().pointer` gains `pitchRateDps` (null while the local rate is used), `elevationDeg` and `gravityConfirmed`. `pointer.js` exports `gravityPitchRate`, `verticalGainPxPerDeg`. No other interface changes; the `BladeSample` fields and the segment semantics are as in section 4.

**What it measured** (replay of the real recording, default settings; before in brackets; `test/motion/real-replay.test.js` F1, `test/motion/gravity-vertical.test.js`):

| Metric | `fast_swings_h` (whole) | `fast_swings_v` (from 0.6 s, the ready pose) |
|---|---|---|
| CUTTING samples in y 270 to 810 | **94 %** (10 %) | 52 % (35 %) |
| median y, all samples / CUTTING samples | 681 / 664 (987 / 1027) | 528 / 322 (1017 / 986) |
| samples on the bottom edge / in the lowest 180 px | 0 % / 0 % (24.8 % / 67 %) | 0 % / 0 % (5.1 % / 57 %) |
| unclamped net vertical path of the cursor | +92 px (+4222 px) | -11 px (+2297 px) |
| vertical extent of a hard stroke | 42 to 214 px (72 to 457) | 387 to 431 px (896 to 1074) |

*The vertical step replayed whole from its first sample* (the verifier's convention) starts with the sword over the head at 74 degrees elevation and the cursor at the centre, so the cursor is referenced to the overhead pose: median y 1038 and 43 % of the CUTTING samples in the middle half (the old pointer: 1035 and 29 %), bottom edge 2.4 % (6.2 %) and still 64 % of the samples in the lowest 180 px (62 %): the sword rests at the ready pose, which maps far below the overhead-centred cursor. This replay convention therefore does NOT show the fix for the vertical step; the ready-pose window does. The vertical axis is referenced to the pose at the last (re)centre, like the horizontal one, and only the idle glide (1.5 s of rest, never reached in that step) or a recentre moves the reference; in the game the cursor is centred at the ready pose by the calibration, which is what the 0.6 s window reproduces. (`tools/verify-round-1/bands.mjs` re-implements the OLD pointer to print its unclamped path by speed band, so it cannot show the fix; the same quantity from the pipeline is `netVy` in test F1.)

The same improvement holds at sensitivity 0.3, 0.6, 1.5 and 2.0 (for example at 2.0: 66 % in the middle half and 1.9 % on the bottom edge, before 21 % and 28.8 %). A1 to A9 pass with the reference values moved only where the vertical axis enters (A2 yaw y range 22.3 % instead of 30.7 %: a horizontal sweep now leaks less into the vertical; A2 pitch 26.4 %, A4 V share median 86 % min 84 %, A8 131.6 px). Synthetic slashes at a constant elevation with the wrist rolling between the strokes (150 degrees in 220 ms, lever arms 0 to 0.3 m, all six mounts, both accelerometer signs): cursor height range 2 px against 540 px and pinned at the bottom edge with the local axis.

**Costs, stated honestly.**
- *The vertical chops are shorter.* A hard vertical stroke of the recording crossed the whole screen height (896 to 1074 px, partly because the local frame integrated the swing through the zenith); it now covers 387 to 431 px (36 to 40 % of the height): the chop from over the head to the ready pose moves the cursor from the top edge to just below the centre, where the sword points. To cut lower the player chops lower. The gain cap is one number (`verticalMaxPxDeg`); raising it towards 14 makes the chops longer and brings the drift back (cap 8: 64 % of the cutting samples in the middle half, cap 10: 43 %).
- *The two axes are no longer isotropic above about 75 deg/s*: horizontal 5 to 14 px/deg, vertical at most 6. A diagonal slash at 45 degrees draws at about 23 degrees on the screen. `tune.gain` ("Crosshair speed: ... in a fast swing") describes the horizontal axis; the text was not changed (UI strings are outside this fix, `docs/contract-notes.md`).
- *Horizontal hysteresis is untouched.* There is no gravity reference for yaw; a "fast out, slow back" slash pattern would still walk the cursor sideways (the recording has only fast strokes in both directions, and the horizontal cursor stays balanced there: 31 % / 28 % of the samples in the two outer eighths of the width, measured with the old pointer, the horizontal axis being unchanged). The idle centring and the recentre are the only remedies. UNVERIFIED-ON-HARDWARE.
- Vertical slow aiming, the horizontal axis, the cut decision and everything in sections 2.1 to 2.8 are as before.

## 3. The settings model

### 3.1 Fields (the two that change; every other setting is unchanged)

| Key | Type | Unit and meaning | Range | Step | Default | Old (removed) |
|---|---|---|---|---|---|---|
| `sensitivity` | number | multiplier of the whole pointer curve (2.2); 1.0 = 5 px/deg at slow aim rising to 14 px/deg in a fast swing; the simulator uses it as the multiplier of 27.4 px/deg as before | 0.3 to 2.0 | 0.1 | **1.0** | 0.5 to 2.0, 27.4 px/deg x value |
| `cutThreshold` | number | minimum tip speed that slices, **deg/s**, before the mode multiplier | **100 to 700** | **25** | **300** | 400 to 2400 px/s, step 100, default 1000 |

`SETTINGS_SPEC` (storage.js) and `MOTION_CONFIG` must agree: a parity test (Settings engineer) asserts `SETTINGS_SPEC.sensitivity` = `MOTION_CONFIG.input.sensitivityRange` and `SETTINGS_SPEC.cutThreshold` = `MOTION_CONFIG.cut.thresholdRange` (min, max, step).

### 3.2 Presets and the labels the player sees

| Where | Preset | Value |
|---|---|---|
| Sword tuning screen, row "Pointer speed" (NEW, three cells like the threshold presets) | **Relaxed** | `sensitivity` 0.6 |
| | **Standard** | 1.0 |
| | **Fast** | 1.5 |
| Sword tuning screen, row "Threshold preset" (existing) | **Easy** | `cutThreshold` **225** |
| | **Normal** | **300** |
| | **Hard** | **450** |

A preset cell is highlighted when the current value equals its value. `TUNING_DEFAULTS` = `{ sensitivity: 1, cutThreshold: 300 }`.

Displayed values: `sensitivity` as today ("1.0"); `cutThreshold` as `"{value} °/s ({label})"` with the label **Easy for 250 or less, Normal for 251 to 375, Hard above 375** (was 700 / 1200 px/s boundaries); the steppers move by 0.1 and by 25.

### 3.3 Storage: version bump and one-time migration

- `STORAGE_VERSION = 2`. The localStorage key is **unchanged** (`joyconNinja.v1`, `CONFIG.storageKey`), only the `v` inside the document moves: high scores, `safetyAck` and `playMsTotal` survive.
- Document: `{ v: 2, best, settings, safetyAck, playMsTotal, notice }` with `notice` = `null` or `'motion-2'`.
- **Load rule.** A stored document whose `v` is missing or below 2: keep `best`, `safetyAck`, `playMsTotal` and every setting **except** `sensitivity` and `cutThreshold`, which are reset to 1.0 and 300 (they are in other units: 1000 px/s would read as 700 deg/s, the maximum); set the in-memory `notice` to `'motion-2'`. A document with `v >= 2` is read as today (sanitised and clamped) and its stored `notice` is kept. No stored document: no notice. Corrupted JSON: as today (defaults), no notice.
- The upgraded document is written by the first `save()` after load (any change, or the acknowledgement below); until then a reload repeats the migration, which is idempotent.
- **One-time notice.** New storage methods `getNotice(): null | 'motion-2'` and `ackNotice(): void` (clears the notice and saves, so the document is now `v: 2`). The UI shows the toast `settings.migrated` (3.6) once, the first time the menu is shown after boot while `getNotice()` is not null, and then calls `ackNotice()`. The toast must not block input and uses the existing toast mechanism.
- Tests (Settings engineer, `test/ui/storage.test.js`): a v1 document with `sensitivity 1.5, cutThreshold 1400, volume 0.3, hand left, best {...}` loads with sensitivity 1.0, cutThreshold 300, the rest intact and `getNotice() === 'motion-2'`; after `ackNotice()` the raw document is `v: 2`, `notice: null`; a v2 document is untouched; `updateSettings({cutThreshold: 1400})` clamps to 700; `snapToSpec` lands on multiples of 25 from 100.

### 3.4 What each screen does with the new units

| Screen / file | Change |
|---|---|
| Settings (`ui/screens/settings.js`) | `settingValueText('cutThreshold')` per 3.2; the live meter reads **`blade.speedDps`** and **`blade.cutThresholdDps`**: text `settings.meter` ("Blade speed: {n} °/s"), bar **0 to 900 °/s** (`METER.max = 900`), bar turns vermilion at or above the threshold marker; the marker is at `settings.cutThreshold` (Settings screen has `cutMul` 1) |
| Sword tuning (`ui/screens/tuning.js`, `layout-data.js`, `ui.js` tuning part) | meter max 900 °/s; "Last swing: {n} °/s"; verdict "Too slow: {n} °/s needed" (n = the threshold); swing detection: a **swing is any tip speed above 150 °/s** and ends after 0.25 s below it (`UI_TIMING.tuneSwingMinDps = 150`, was 250 px/s), its peak (in °/s) is "Last swing"; the reach test, the four rings and the practice fruit are unchanged; `tune.span` ("The screen spans {w}° of sword rotation") is **replaced** by `tune.gain` (3.6); a new row of three pointer-speed preset cells (3.2) - exact y is the Settings engineer's choice provided nothing overlaps and every selectable element is at least 84 x 84 px and is selected only by dwell, click or Enter, never by a cut; "Default values" writes sensitivity 1.0 and threshold 300 |
| Calibration step 4 (`ui/screens/calibration.js`) | the live blade speed reads `blade.speedDps` (text `cal.speed` "Blade speed: {n} °/s", bar 0 to 900) |
| `ui.js` | step sizes `{ sensitivity: 0.1, cutThreshold: 25, volume: 0.1 }`; preset ids `tune.preset.easy/normal/hard` keep their ids with values 225/300/450, new ids `tune.pointer.relaxed/standard/fast`; `BladeView` mapping of `speedDps` and `cutThresholdDps` (section 4.4); the migration toast (3.3) |
| `presentation.js` | `IDLE_BLADE` gets `speedDps: 0, cutThresholdDps: 300` |

### 3.5 `layout-data.js` constants

`TUNING_PRESETS` values 225 / 300 / 450 (ids unchanged), new `TUNING_POINTER_PRESETS` (ids `tune.pointer.relaxed|standard|fast`, values 0.6 / 1.0 / 1.5), `TUNING_METER.max = 900`, `TUNING_DEFAULTS = { sensitivity: 1, cutThreshold: 300 }`. Hit targets for the new cells have `{ cut: false, dwell: true }` like the existing presets.

### 3.6 Strings (`strings.en.js`)

Existing keys whose **text changes** (they are in the tables of `docs/game-design.md` section 13, so the **Integrator changes the same two table rows in the same change**; `test/ui/strings.test.js` compares the two):

| Key | New text |
|---|---|
| `cal.speed` | `Blade speed: {n} °/s` |
| `settings.meter` | `Blade speed: {n} °/s` |

Existing additions (not in the design tables, only logged in contract-notes) whose text changes: `tune.last` -> `Last swing: {n} °/s`; `tune.verdict.slow` -> `Too slow: {n} °/s needed`. `tune.span` is **removed** (replaced by `tune.gain`); update the expected list of additions in `test/ui/strings.test.js`.

New keys, in **one clearly marked section** of `strings.en.js` ("Sword controls round, 2026-09-30") and exported in `STRING_KEYS_ADDITIONS`:

| Key | Text |
|---|---|
| `settings.migrated` | `The sword controls were retuned, so Sensitivity and Slice threshold are back at their new default values. You can change both in Settings.` |
| `tune.gain` | `Crosshair speed: {lo} px per degree when aiming slowly, {hi} px per degree in a fast swing` (`lo` = `gLoPxDeg x sensitivity`, `hi` = `gHiPxDeg x sensitivity`, both with one decimal, read from `MOTION_CONFIG.pointer`) |
| `tune.pointer` | `Pointer speed` |
| `tune.pointer.relaxed` | `Relaxed` |
| `tune.pointer.standard` | `Standard` |
| `tune.pointer.fast` | `Fast` |

`settings.cut.hint` ("Minimum speed needed to slice. Lower = easier.") and `settings.sens.hint` ("How far the crosshair moves when you rotate the sword.") stay valid. The Italian-leak guard applies to every new string. The Settings engineer appends one entry to `docs/contract-notes.md` listing the additions and the changed texts (the strings test requires the log).

## 4. API changes

### 4.1 Pipeline surface (`createMotionPipeline`, `MotionPipeline`)

| Item | Change |
|---|---|
| `createMotionPipeline(opts)` | new option `pointerModel: 'relative' \| 'absolute'`, **default `'relative'`**; other options unchanged |
| **NEW** `setPointerModel(model)` / `getPointerModel()` | selects the model. Like `setAccelSign`, it is meant to be called when the provider changes, **before** `reset()` and `setCalibration(null)`; it does not reset anything itself. Unknown values are ignored |
| `setSettings(patch)` / `getSettings()` | `sensitivity` and `cutThreshold` in the new units and ranges (3.1); `getSettings()` returns the same keys |
| `pushImu(sample)` | relative model: sections 2.1 to 2.5; absolute model: as today |
| `pushAim(sample)` | unchanged behaviour; the threshold conversion of 2.6 |
| `drainSegments()` | returns the chords of 2.5 (several per IMU sample while cutting); otherwise as today |
| `recent(windowMs)` | includes `interpolated` samples (2.5) |
| `headAt(now)` | 2.5 |
| `recenter`, `reanchor`, `markDiscontinuity`, `beginQuickRecenter`, `confirmCenter`, `startCalibration`, `cancelCalibration`, `setCalibration`, `reset`, `poll` | 2.7 |
| events | `blade`, `calibration`, `warning` unchanged; `recenter` kinds: `manual`, `auto`, `calibration`, `reconnect` (`edge` only in the absolute model) |

### 4.2 `BladeSample` (additive, `shared/contracts.js` typedef comment and the game-design references updated by the Integrator)

| Field | Meaning | Change |
|---|---|---|
| `speed` | **px/s-equivalent** of the cut-decision speed: `speedDps x 10/3` for IMU samples; the real cursor px/s over the last 50 ms for aim samples and the absolute model (equal to `speedDps x 10/3` by the conversion of 2.6) | **meaning kept, source changed**: the game, the trail, the audio and `BladeSegment.speed` see the same scale as before (Standard threshold = 1000) |
| `speedDps` | cut-decision speed in deg/s: the tip speed `s` (relative IMU), or `speed / (10/3)` (aim, absolute) | NEW, always a number |
| `vx`, `vy` | cursor velocity in px/s at this sample (0 for aim samples); used by the path and the extrapolation | NEW |
| `interpolated` | `true` only for ring samples inserted between two real samples (2.5) | NEW, boolean |
| `angularSpeedDps` | `|w|` (total), `null` for aim samples | unchanged |
| `cutting`, `swingId`, `discontinuity`, `trackingOk`, `source`, `x`, `y`, `t` | as before; `cutting` follows 2.4 (relative) or the px tracker (others) | |
| `segmentValid`, `x0`, `y0`, `t0` | `segmentValid` is true when this sample emitted at least one segment; `(x0, y0, t0)` is the start of the first segment emitted by this sample; invariant `segmentValid => cutting && !discontinuity` holds | semantics widened, invariant kept |

`BladeSegment` is unchanged in shape; its `speed` is in the px/s-equivalent scale; sub-segments are contiguous.

### 4.3 `MotionState` and `MotionSettings`

`MotionState` gains `speedDps` (number), `cutThresholdDps` (number, effective `cutThreshold x cutMul`) and `pointerModel`; `speed` keeps its meaning (px/s-equivalent); `refDriven` semantics per 2.3 (true while the centring moves the cursor, or an ease is running). `MotionSettings`: `sensitivity` and `cutThreshold` as in 3.1; `cutMul`, `autoCenter`, `flipX` unchanged. `Settings` (storage) typedef: the same two keys with the comments of 3.1.

### 4.4 What `app.js` and the UI read (Integrator)

```js
// useProvider(kind): before motion.reset() and motion.setCalibration(null)
motion.setPointerModel(kind === 'sim' ? 'absolute' : 'relative');   // 'mouse' never sends IMU samples
// applySettings(): unchanged call shape
motion.setSettings({ sensitivity: s.sensitivity, cutThreshold: s.cutThreshold, autoCenter: s.autoCenter && provider?.kind !== 'sim', flipX: s.flipX });
// stepInner(): BladeView (presentation.step input)
const ms = motion.getState(); const st = motion.getSettings();
const blade = {
  samples: motion.recent(260), latest: motion.latest(), head: motion.headAt(now),
  cutting: ms.cutting, trackingOk: ..., refDriven: ms.refDriven === true,
  speed: ms.speed,                                   // px/s-equivalent: trail colours, swoosh, renderer debug (unchanged scale)
  cutThreshold: ms.cutThresholdDps * (10 / 3),       // px/s-equivalent of the effective T: trail, swoosh (Standard = 1000, as before)
  speedDps: ms.speedDps,                             // NEW: settings meter, tuning screen, calibration step 4
  cutThresholdDps: ms.cutThresholdDps,               // NEW: effective T in deg/s (includes the Zen multiplier)
};
```

`BladeView` typedef gains `speedDps` and `cutThresholdDps` (Integrator updates `shared/contracts.js`). Nothing in `game/`, `render/` and `audio/` changes: they read `speed`, `cutThreshold` and segments in the old scale. `ninja-api.js`: `setSetting('sensitivity'|'cutThreshold', v)` goes through `storage.updateSettings` (new ranges apply); `getMotionDebug()` keeps returning `getDebug()`.

### 4.5 How the game-design numbers map (Integrator updates `docs/game-design.md` and `docs/architecture.md`)

| Design text | Shipped | New |
|---|---|---|
| 1.2 "Default cut threshold" | 1000 px/s (about 36 deg/s) | **300 deg/s** tip speed (1000 px/s-equivalent for the mouse and the trail) |
| 5.1 "Blade speed" | polyline length over 50 ms, px/s | relative IMU path: tip speed per sample, deg/s; aim path and simulator: the same px/s measure, divided by 10/3 to get deg/s-equivalent |
| 5.1 "Segment merging 6 px / 8 ms" | all sources | aim path and absolute model unchanged; relative model: chords of at most about 48 px, chords under 1 px dropped |
| 5.1 "Safety cap 2190 deg/s x pxPerDeg" | one segment | relative IMU: a sample above 2190 deg/s is ignored; aim/absolute: px/s cap unchanged |
| 5.2 table `T` | 1000 px/s, 400 to 2400 step 100, presets 700 / 1000 / 1500 | **300 deg/s, 100 to 700 step 25, presets 225 / 300 / 450** |
| 5.2 Zen x0.8, enter at T, leave below 0.65 T, swing grace 100 ms | | unchanged multipliers: Zen 240 deg/s, leave below 195; **new: minimum duration 25 ms and retroactive first chord** (relative IMU path) |
| 5.2 prose "1000 px/s cleanly separates..." (HW-9) | unverified | measured on one recording: aiming p99 253, hard strokes at least 632 (findings 10.1); still UNVERIFIED for other people and for tense play |
| 8.2 mapping `x = 960 + yawDeg x pxPerDeg` | absolute, 27.4 px/deg | relative curve (2.2); the absolute formula stays for the simulator |
| 8.3 auto-recenter 8 deg/s / 1.0 s / 500 ms, slew 3 deg/s; edge slip | references | idle 8 / 14 deg/s, 1.0 s, 500 ms, cursor glide 120 to 800 px/s, no references, no edge slip (relative); unchanged for the simulator |
| 8.4 trail ramp `T + 1200`, `T + 3000` | px/s | unchanged numbers in px/s-equivalent (300 deg/s = 1000, 660 deg/s = 2200, 1200 deg/s = 4000) |
| 12.7 meter "0 to 4000 px/s" | | 0 to 900 deg/s |
| 12.7.1 presets 700 / 1000 / 1500, swing 250 px/s, "screen spans {w} degrees" | | 225 / 300 / 450, swing 150 deg/s, `tune.gain`, plus the pointer-speed presets |
| 14 settings table | `sensitivity` 0.5 to 2.0 (27.4 px/deg x v), `cutThreshold` 400 to 2400 px/s | 3.1 |
| 15.3 "the 70 degree screen span keeps the swing modest" | | a median hard stroke of 137 degrees crosses the screen once; the gain is speed-dependent (2.2) |
| 16.5 item 4 threshold tests | 900 / 1100 px/s, dip to 700, below 650 | aim path: same tests, same px/s (Standard = 1000); relative IMU path: tip speed 290 does not cut, 310 held for two samples cuts, a one-sample spike never cuts, dip to 210 keeps the swing, below 195 ends it |
| 17 HW-2, HW-3, HW-9, HW-10 | unverified | HW-2: the 70 x 39 degree span is replaced by the gain curve (comfort UNVERIFIED); HW-3: drift measured 0.02 to 0.2 degrees in 8 s on one unit; HW-9: see above; HW-10: maximum measured 1049 deg/s, no saturation |
| Appendix A `cut`, `input` | | 2.8 |

## 5. Acceptance metrics (a node test replays the real recording)

### 5.1 Fixture and helpers (Motion engineer)

- Copy the recording to `test-support/motion/fixtures/imu-2026-09-30T18-42-24.jsonl` (900 KB) and add `test-support/motion/real-recording.js` (a port of `tools/lib/imu-recording.mjs` and the adapters of `tools/replay-motion.mjs`): `loadRealRecording()`, `REAL_BIAS_DPS = { x: 0, y: -0.30517578125, z: 0.732421875 }` (raw 0, -5, +12 times 0.06103515625: the median of the clean `rest_table` window), `realCalibration()` (identity frame, `gyroSign` 1, `gyroScale` 1, bias as above, `accelG0` 1, `side 'R'`), `stepSamples(name, fromS, toS)`, `hardStrokes(name)`, `replay(name, { fromS, toS, settings, pointerModel, config })`, `injectPostureChange(samples, ...)`.
- `stepSamples` builds `ImuSample`s: `seq` 0.., `t` and `arrivedAt` = device time in ms relative to the window start, `dtMs` = null for the first sample else the device delta, `dtSource: 'device'`, `accel` = raw/4096 g, `gyro` = raw x 2000/32768 dps, `side: 'R'`, `buttons: []`, `batteryMv: 3435`, `tempC: null`, `imuActive: true`. **Steps are replayed one at a time from a fresh pipeline** (the countdowns between the steps are not in the file); the first sample of a window has `dtMs: null`; the cursor starts at the centre (`reset()` + `setCalibration(realCalibration())`).
- **Hard stroke** (the reference events; the test asserts the counts): local maxima of `|gyro - bias|` of at least 150 dps, peaks closer than 250 ms merged (the higher wins), with `|accel| >= 2.0 g` within 3 samples of the peak. Extent: walk outwards from the peak while the speed is above 100 dps, stopping at a local minimum below half the peak. **Expected: 15 in `fast_swings_h`, 6 in `fast_swings_v`.**
- `tools/replay-motion.mjs` stays in the repository as the cross-check; its printed numbers are the reference values below (run it to refresh them).

### 5.2 The metrics

"Window" = replayed from its own start with a fresh pipeline unless said otherwise. Defaults: `sensitivity` 1.0, `cutThreshold` 300, `autoCenter` true (except where stated). Reference values are from the prototype with the contract constants (2.8).

| # | Metric | Procedure | Pass | Reference value |
|---|---|---|---|---|
| A1 | **Cursor excursion while holding still (trimmed)** | windows `hold_still` from 7 s and `return_still` from 2 s; range of x and y over the window; CUTTING time share | x range <= 10 px and y range <= 10 px in both windows; CUTTING 0 % | 0.0 px / 0.0 px in both; 0 % (the shipped pointer: 9.8 x 78.3 px and 12.1 x 28.8 px) |
| A2 | **Screen coverage, yaw and pitch sweeps** | `yaw_sweep` 1 to 21 s and `pitch_sweep` 1 to 21 s; range of the cursor as a share of 1920 x 1080; share of time on the playfield boundary | yaw: x range in [35 %, 80 %], y range <= 50 %; pitch: y range in [15 %, 40 %], x range <= 10 %; boundary time <= 5 % in both | yaw 55.5 % x / 30.7 % y; pitch 26.3 % y / 2.7 % x; boundary 0 % |
| A3 | **False cutting in slow motion** | time share with CUTTING over `yaw_sweep` 1..21 s, `pitch_sweep` 1..21 s, `roll_360` 2..14 s, `table_spin_360` 2..16 s and the two hold windows; also the same runs at `sensitivity` 0.3, 1.0 and 2.0 | **under 2 % in every window** (and under 2 % for yaw plus pitch combined); the CUTTING sequences at the three sensitivities are identical sample by sample | 0.00 % everywhere (the shipped pipeline: 50.3 %, 61.6 %, 15.9 %, 19.0 %) |
| A4 | **Hard strokes that produce a cut** | for each hard stroke of `fast_swings_h` and `fast_swings_v` (replayed whole): "cut" = CUTTING at some sample within 60 ms of the peak and the emitted segments cover at least 50 % of the cursor path inside the stroke extent; report horizontal and vertical separately | **at least 90 % of the strokes each**; median segment-path share at least 80 %, minimum at least 60 % | H 15/15 (path share median 95 %, min 86 %); V 6/6 (median 90 %, min 87 %) (the shipped pipeline: V 3/6) |
| A5 | **Idle auto-centre time** | replay `return_still` from 2 s after `reanchor(x, y)` on the first sample, for (60, 60), (1860, 540), (960, 1040), (1100, 600); time until the cursor is within 100 px and within 20 px of (960, 540), counted from the first sample (the 1.0 s hold is included); then the same with `autoCenter: false` | within 100 px in **at most 3.0 s** for all four, within 20 px in at most 3.6 s; `autoCenter: false`: cursor never moves (range 0.0 px); exactly one `recenter` event `kind: 'auto'` per run (the start at 1100, 600 is 152 px away: at least 40 px travelled) | 2.50 / 2.35 / 1.84 / 1.33 s within 100 px; 3.01 / 2.86 / 2.35 / 1.87 s within 20 px |
| A5b | **Centring never fights a swing** | over `yaw_sweep`, `pitch_sweep`, `fast_swings_h`, `fast_swings_v`: count of samples with `refDriven === true` while `cutting` or tip speed above 21 deg/s | 0 | 0 |
| A6 | **No tunnelling at the maximum measured speeds** | `fast_swings_h` and `fast_swings_v` replayed whole, all segments drained: (i) longest chord; (ii) contiguity inside each cut run (`t0` = previous `t1`, positions within 0.5 px); (iii) a dense reference path at 1 ms (quadratic interpolation of consecutive real `BladeSample`s from their `x`, `y`, `vx`, `vy`, clamped): largest distance of a dense point to the union of the emitted segments; (iv) `recent()` spacing of interpolated samples; (v) largest cursor step between two IMU samples (information) | (i) <= 96 px; (ii) 0 gaps; (iii) <= 12 px; (iv) consecutive samples of `recent()` at most 8.5 ms apart everywhere (also across a 60 ms lost-packet interval); (v) <= 450 px | (i) 61 px H, 55 px V; (ii) 0; (iii) 6.6 px H, 2.9 px V; (v) 408 px H, 352 px V; peak cursor speed 14,592 px/s (maximum tip speed 1049 deg/s) |
| A7 | **Head extrapolation error at 60 fps** | `fast_swings_h` hard strokes, manual clock: after real sample k call `headAt(t_k + f x dt)` for `f` in 0.2, 0.4, 0.6, 0.8, 1.0; truth = `p_k + v_k tau + 0.5 (v_{k+1} - v_k) / dt tau^2` (`tau = f dt`, clamped) from the two real `BladeSample`s | mean <= 20 px and p95 <= 60 px | mean 13.1 px, p95 45.5 px, max 99.5 px (hold last: 113 / 319 / 416) |
| A8 | **Posture independence** | `injectPostureChange` on `return_still` from 2 s: add 15 deg/s to gyro z and 10 deg/s to gyro x from 0.5 s to 2.5 s (30 and 20 degrees; the prototype also rotates the accelerometer about device x accordingly, which the relative pointer ignores); cursor offset from the centre 300 ms after the change ends; autoCenter stays on (the hold timer cannot have expired) | <= 250 px | 133 px (-114, -69) (the shipped pointer: 996 px) |
| A9 | **Cut onset** | for each hard stroke: time between the first sample with tip speed at or above 300 and the first CUTTING sample; existence of a segment with `t0` at or before the time of the sample preceding that first sample | <= 35 ms for every stroke; the retroactive chord exists for every stroke | 30 ms (31.25 max); chord present |
| A10 | **Curve and direction unit tests** | constant-speed rotations through `pushImu` on the six mount presets and both sides: the value table of 2.2 at tip speeds 5, 6, 10, 30, 100, 300, 1000 (sensitivity 1.0, 0.6, 1.5); yaw to the right moves x right, pitch up moves y up, roll about the blade moves nothing (+-2 px), `flipX` mirrors x, sensitivity 2.0 doubles the excursion at the same speed, a constant 4.9 deg/s gives 0 px after 10 s, 5.5 deg/s gives 25 px +-2 after 10 s (F = 2.5 px/s) | all within 1 px/s of the table (speed) and the stated tolerances | see 2.2 |
| A11 | **Cut state machine unit tests** | synthetic tip-speed profiles: 290 never cuts; 310 for two samples cuts; one sample at 600 never cuts; dip to 210 keeps the swing; below 195 ends it; re-entry within 100 ms keeps `swingId`, later starts a new one; the retroactive chord is emitted with the ENTER sample; `cutMul` 0.8 -> 240; discontinuity clears the candidate; `setSettings` mid-swing re-evaluates without resetting `swingId`; rates 33, 66 and 250 Hz; a 60 ms gap in the middle of a stroke does not break it | as stated | - |
| A12 | **Simulator, mouse and debug swings unchanged** | the existing suites of `test/motion`, `test/input/sim*`, `test/app`, `test/ui` run with `pointerModel: 'absolute'` (motion tests) and the integrator wiring (app tests): mapping (960 + 274 px for 10 degrees), auto-centre constants, edge slip, `reanchor` for the simulator teleport, the px/s tracker tests at T_px 1000 | green with the threshold conversion of 2.6 (Standard = 1000 px/s) | - |

| A13 | **Cursor height under sustained slashing (round F1)** | `fast_swings_h` whole and `fast_swings_v` from 0.6 s (the ready pose), default settings; also at sensitivity 0.6 and 2.0 | H: at least 75 % of the CUTTING samples in y 270 to 810, median y 300 to 800, at most 3 % of the samples on the bottom edge and 15 % in the lowest 180 px, unclamped net vertical path at most 800 px; V: CUTTING median y at most 750, median y 300 to 800, at most 3 % on the bottom edge and 15 % in the lowest 180 px, net at most 500 px, every hard stroke spans at least 250 px vertically; at 0.6 and 2.0 at least 50 % in the middle half and at most 5 % on the bottom edge (H) | H 94 %, 681, 0 % / 0 %, +92 px; V 322, 528, 0 % / 0 %, -11 px, 387 to 431 px (before: 10 %, 987, 24.8 % / 67 %, +4222; V 986, 1017, 5.1 % / 57 %, +2297) |
| A14 | **Vertical model unit and physical tests (round F1)** | `test/motion/gravity-vertical.test.js`: `gravityPitchRate` (level, rolled, inverted, zenith, every mount), `verticalGainPxPerDeg`, synthetic slashes with the wrist rolling between the strokes (all six mounts, lever arms 0 to 0.3 m, both accelerometer signs), path independence of fast and slow legs, directions, the confirmation gate and its start in the middle of a swing, the zenith | as stated in the test names; the old vertical axis (`gravityVertical: false`) must fail the physical test (cursor pinned at the bottom) | cursor height range 2 px (old: 540 px) |

The A1 to A9 and A13 checks are in one test file, `test/motion/real-replay.test.js`, under 5 s in total; the reference numbers are printed in the assertion messages so a regression shows the gap.

## 6. File ownership, seams and the tests each role touches

### 6.1 Ownership (disjoint)

| Role | Owns (may edit) |
|---|---|
| **Motion engineer** | `public/js/motion/**` (pipeline, `aim.js` kept for the absolute model, `blade-tracker.js` kept for the px path plus the angular tracker and pointer code, `motion-config.js` with 2.8), `public/js/input/input-config.js` (motion parts only; `sim.pxPerDeg` stays 27.4), `test/motion/**`, `test-support/motion/**` (adds the real recording as a fixture, 5.1) |
| **Settings engineer** | `public/js/ui/storage.js`, `public/js/ui/screens/settings.js`, `tuning.js`, `calibration.js` (only what this contract changes), `public/js/ui/layout-data.js` (3.5), `public/js/ui/ui.js` (only: step sizes, preset wiring, the tuning swing tracker and its `UI_TIMING`, the `BladeView` fields of 4.4, the migration toast), `public/js/ui/presentation.js` (only `IDLE_BLADE`), `public/js/ui/strings.en.js` (existing keys of 3.6 and the new keys in one marked section), their tests: `test/ui/{storage,tuning,layout-data,strings,pressed,ui-flow,integration}.test.js`, `test-support/ui/**` constants that mention 1000 px/s or 27.4 |
| **Integrator** | `public/js/app.js`, `public/js/ninja-api.js` (4.4), docs sync (`docs/architecture.md`, `docs/game-design.md` including the two section 13 rows of 3.6, `docs/GUIDE.md`, `README.md`, `docs/hardware-findings.md` pointer to the findings), `public/js/shared/contracts.js` typedef comments (BladeSample, BladeSegment note, MotionSettings, MotionState, BladeView, Settings) and `public/js/shared/validate.js` only if a new field is to be validated (optional: the current validators do not reject the new fields), `test/app/**`, `test/e2e/**`, `test-support/e2e/**`, `test-support/bridge/**` (fake helper) |
| Nobody | `public/js/game/**`, `public/js/render/**`, `public/js/audio/**`: no change is needed (D6). If a test there pins a px/s value that comes from `cutThreshold` 1000, the test's owner tells the Integrator |

`docs/contract-notes.md`: each role appends its own entry (append only). The entries the roles owe are listed in 7.3.

### 6.2 The seams (the only names the roles share)

- Motion publishes: `MOTION_CONFIG.pointer`, `MOTION_CONFIG.cut`, `MOTION_CONFIG.input.sensitivityRange`, `setPointerModel`, `getPointerModel`, the `BladeSample`/`MotionState` fields of 4.2 and 4.3, `getState().cutThresholdDps`, and `drainSegments`/`recent`/`headAt` as in 2.5.
- Settings reads: `MOTION_CONFIG.pointer.gLoPxDeg`, `gHiPxDeg`, `MOTION_CONFIG.cut.thresholdRange`, `MOTION_CONFIG.input.sensitivityRange` (data module, allowed by the import rules); `BladeView.speedDps`, `cutThresholdDps`.
- Integrator wires: `setPointerModel` per provider, the `BladeView` fields, the settings push.
- Until the other side lands, each role stubs the names it needs from this document and runs its own suite; the integration check is `npm test` after all three have landed.

### 6.3 Tests known to need edits

- Motion: `test/motion/mapping.test.js`, `pipeline.test.js`, `reconnect.test.js`, `fuzz.test.js`, `accelsign.test.js`, `robustness.test.js`, `sim-integration.test.js` - the tests that depend on the absolute mapping create the pipeline with `pointerModel: 'absolute'`; thresholds in px/s become `cutThreshold` in deg/s (Standard 300 ~ 1000 px/s on the px path); `tracker.test.js` keeps passing unchanged (the px tracker is kept); new: curve, angular tracker, path/sub-segments, extrapolation, real replay (A1 to A11).
- Settings: `storage.test.js` (3.3), `tuning.test.js` (units, presets, `tune.gain`, verdict in deg/s, swing threshold 150 deg/s, reach test unchanged), `layout-data.test.js` (new cells, `TUNING_METER.max`), `strings.test.js` (changed texts, additions list, `tune.span` removed), the parity test of 3.1.
- Integrator: `test/app/app.test.js` (the settings tests use `cutThreshold: 1400` and `{ v: 1, sensitivity: 1.5, cutThreshold: 1400 }`: use 450 and a v2 document, and add a test that a v1 document is migrated and that the notice toast appears once), `test/e2e/game.test.js` and the native e2e tests. **Native e2e and the fake helper:** the fake helper drives a simulator-model virtual sword by screen points (`moveTo`); in the relative model the cursor no longer lands on the target, and a glide of 1000 px in 200 ms is only about 180 deg/s, below 300. The e2e tests that cut or aim through the native path must (a) place the cursor with `motion.reanchor(x, y)` (exposed through `__ninja`) and (b) make their swings at least 600 deg/s at the tip (for example 100 degrees in 150 ms). The `?input=sim` e2e tests are unaffected (absolute).

### 6.4 Documents the Integrator syncs

`docs/architecture.md`: 3.3 (mapping formula: relative for real sensors, absolute for the simulator), 6.1 (default settings 1 / 300), 6.2 (`headAt`, `recent`, `drainSegments`), 6.3 (tracker rules: angular decision, minimum duration, retroactive chord), 6.5 and 6.6 (mapping and re-centring), 6.8 (config), 8.7 (storage v2, `getNotice`, `ackNotice`), 11 (typedefs). `docs/game-design.md`: the rows of 4.5 and the two strings. `docs/GUIDE.md` and `README.md`: tuning advice in deg/s and px per degree. `docs/hardware-findings.md`: a pointer to `docs/motion-findings.md` and the list of what it verified (gyro scale, bias, rate, axes) and did not.

## 7. Risks, open items, deviations

### 7.1 Risks (all UNVERIFIED-ON-HARDWARE unless stated)

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Feel.** Gains (5 to 14 px/deg), dead zone 5, idle timings, presets are derived from one recording and the owner's remarks; the owner may still find the cursor too fast or too slow | everything is in `MOTION_CONFIG` and the two settings; the tuning screen shows `tune.gain`, the reach test and presets Relaxed / Standard / Fast (0.6 / 1.0 / 1.5); first check on the sword: hold still (cursor must not move), sweep slowly (cursor follows, no cut), slash (cut, crosses most of the screen) |
| R2 | **Slower swingers** (weaker wrist, children): the slowest hard stroke here is 632 deg/s; someone swinging at 250 would never cut at 300 | Easy 225 and the range down to 100; the tuning screen verdict shows the last swing in deg/s |
| R3 | **Local frame and wrist roll**: rolling the sword tilts the pointer axes; the recording does not need compensation | fallback documented (prototype mode `roll`, findings 11); do not add before real play shows it |
| R4 | **Accelerometer as a second opinion** for false cuts: the recording separates hard strokes from slow motion by a factor of 5 in `| |a| - 1 |` (0.39 g against 2.04 g), but the peak lags the gyro by 30 to 60 ms and depends on the swing style (lever arm 0.11 to 0.23 m) | not used; first thing to add if real play shows false cuts that a gyro threshold cannot remove |
| R5 | The minimum duration delays CUTTING by one sample (30 ms) and the drawn head runs up to 35 ms ahead of the data (maximum error 100 px at stroke speed) | the first chord is delivered retroactively; the predictor is clamped against reversal; both constants are in config |
| R6 | A relative pointer spends time at the screen edges after big strokes (33 % of the time in the horizontal swing test, 9 % vertical) | **Amended by round F1 (2.9): the verifier showed this was not only edge time but a drift of the cursor centroid to the bottom edge (finding F1); the vertical axis now follows the elevation of the blade.** Horizontally: no hidden offset, the cursor leaves the edge as soon as the sword reverses; the idle centring brings it back after 1.0 s |
| R7 | Simulator (absolute) and real sword (relative) now differ: green simulator tests do not prove the feel | the real-recording replay (5) is the test of the relative path; the e2e native tests need the changes of 6.3 |
| R8 | A garbage single sample below the saturation cap (for example 1500 deg/s from a corrupted packet) would move the cursor about 320 px and is rejected by the minimum duration for cutting but not for pointing | not seen in 4744 samples; the cap of 2.4 only covers saturation |
| R9 | One controller, one person, one mount, right side only; the Left unit is undocumented | formulas use the calibrated frame only; the wizard finds the mount |
| R10 | Dead zone versus bias error: a wizard bias error above about 1.5 deg/s (5 minus the tremor p99 of 3.5) lets the cursor creep at up to 15 px/s when holding still | the online estimator corrects it at rest; 5 deg/s leaves the margin |
| R11 | Web Bluetooth (Chrome) rate and jitter were not measured; the native bridge gave 33 Hz with 2.9 ms jitter | the path is device-time based; unchanged assumptions `maxGapMs` 200 |
| R12 | **The vertical axis depends on the orientation filter (round F1).** A tilt error rotates the pitch axis about the blade, so a yaw rate leaks `sin(error)` of itself into the vertical (alternating strokes cancel); the accelerometer sign convention (UOH-20) is assumed as for the wizard's frame (the owner's first test with the wizard's frame moved the cursor the right way, which supports but does not prove it); the filter starts from one reading | `confirmed` gate and the local fallback (2.9); the wizard measures the sign on the diagnostics page; `gravityVertical: false` restores the old axis |
| R13 | **The vertical gain is capped at 6 px/deg (round F1)**: vertical chops cover about 40 % of the screen height, diagonals are flattened, `tune.gain` describes the horizontal axis only | one number (`verticalMaxPxDeg`); the tuning screen's pointer-speed presets scale it with the sensitivity |
| R14 | **Horizontal hysteresis is not covered (round F1)**: a pattern of fast strokes one way and slow returns the other walks the cursor sideways in continuous play; the recording has only fast strokes both ways; yaw has no absolute reference | the idle glide and the recentre; first thing to try if play shows it: a flatter horizontal curve above 100 deg/s |

### 7.2 What this contract deliberately does not do

No change to the calibration wizard, the frame discovery, the gyro bias estimator, the tracking-lost rule, the game rules, the hit radii, the scoring, the audio or the renderer. No accelerometer gating. No roll compensation. No per-axis scale. No change to the mouse provider.

### 7.3 Deviations to record in `docs/contract-notes.md` (each role appends its own)

- Motion: D1/D5 (two pointer models, `setPointerModel`), the angular cut decision with minimum duration and retroactive chord (changes architecture 6.3 rules 1, 3 and 4 for the relative model), sub-segments and the widened `segmentValid` semantics, interpolated samples in `recent()` (architecture 6.2 "one BladeSample per ImuSample" still holds for the `blade` event), `headAt` 35 ms, `historySize` 384 and `segmentQueueMax` 1024, `getState().yawDeg/pitchDeg` null in the relative model, `sensitivityRange`.
- Settings: D7 (units, ranges, presets, labels, storage v2 and the notice), the strings of 3.6, the tuning-screen additions.
- Integrator: D6 (`speed` scale kept, new `speedDps`/`cutThresholdDps`), `setPointerModel` per provider, the game-design and architecture rows of 4.5 and 6.4, the e2e adaptations.

## 8. Integration status (added by the Integrator, 2026-09-30)

All three roles landed and were wired (`docs/contract-notes.md`, the Integrator entry of the sword tuning round). `docs/architecture.md` (3.3, 6.1 to 6.3, 6.5, 6.6, 6.8, 8.7, 9.8, and the embedded typedefs of 11), `docs/game-design.md` (the rows of 4.5), `docs/GUIDE.md`, `README.md` and `docs/hardware-findings.md` (section 8) are synced. The acceptance metrics of section 5 were reproduced on the **integrated app path** (recorded reports through the BLE provider, the parser, `app.js`, the game and the UI, `test/app/real-replay-app.test.js`, `node tools/replay-integrated.mjs`) within about two points of the reference values, and the same recording was played into a real browser with the art on (`test/e2e/real-replay.test.js`). Two things the contract did not foresee, both recorded there: the owner's grip presses the R shoulder button (mapped to "recenter") in the middle of a stroke, so `app.js` ignores a recenter press while the blade moves (100 deg/s or more, or cutting, plus 250 ms); and Zen's x0.8 puts its threshold at 240 deg/s, where the owner's most vigorous aiming cuts about 2 % of the time (harmless there, left as designed). Everything about the feel is still UNVERIFIED-ON-HARDWARE: `docs/GUIDE.md` section 11 has the 5-minute check.

## 9. Round F1 addendum (fixer, 2026-09-30)

The verifier's finding F1 (sustained vigorous swinging pins the cursor to the bottom edge) was reproduced exactly and fixed at its root: section 2.9 (D9), risks R12 to R14, metrics A13 and A14, `docs/motion-findings.md` section 15, `docs/contract-notes.md` (fixer entry of the sword-tuning verification round). Sections 1.2, 1.3, 2.1 to 2.8 and 4 stand as written except where 2.9 and the amended notes in 1.3 and R6 say otherwise; `BladeSample`, `BladeSegment`, `MotionState` and `MotionSettings` are unchanged. Everything about how the vertical axis feels on the sword is UNVERIFIED-ON-HARDWARE (`docs/GUIDE.md` section 11 has the check).

`tools/replay-motion.mjs` (the prototype of sections 2.1 to 2.5, section 5.1) keeps the local-frame model of before round F1: its `rel` numbers are the reference values of A1 to A9 as printed in section 5.2, and they equal the pipeline's for everything the vertical axis does not touch (the cut decision, the horizontal axis, the chords, A5, A9). For the vertical axis and for the pipeline as shipped use `node tools/replay-integrated.mjs` (the integrated app path) and `test/motion/real-replay.test.js`; the verifier's scripts `tools/verify-round-1/{ratchet3,edges,bands}.mjs` reproduce F1 (they drive the real pipeline, so they now show the fixed behaviour; `gravityVertical: false` in the pipeline config shows the old one).
