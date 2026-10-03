# Motion findings: what the first real recording of the sword says

Date: 2026-09-30. Author: motion analyst. Companion document: `docs/motion-contract.md` (the design that follows from these numbers).

Every number in this file is computed from ONE recording by scripts in `tools/`; nothing is taken from a datasheet or from the third-party protocol notes unless it is said so. The rule of `docs/hardware-findings.md` holds here too: what the recording cannot show is listed in section 12 and stays **UNVERIFIED-ON-HARDWARE**.

| Item | Value |
|---|---|
| File | `recordings/imu-2026-09-30T18-42-24.jsonl` (4754 lines, 900 KB), made by `tools/record-imu.mjs` through the native bridge, one JSON line per report `{t, ht, step, hex}` |
| Device | one Joy-Con 2 **Right**, handled by the owner, hand-timed steps with a countdown text, no reference instrument |
| Parsed with | `parseInputReport` of `public/js/input/joycon2-parse.js`; gyro in dps = raw x 2000/32768, accel in g = raw / 4096, device time from the u32 microsecond timestamp at offset 0x2A |
| Steps (seconds asked) | `rest_table` 12, `hold_still` 10, `yaw_sweep` 22, `pitch_sweep` 22, `roll_360` 18, `table_spin_360` 18, `fast_swings_h` 14, `fast_swings_v` 14, `return_still` 12 |
| Samples | 4744 IMU-active reports in 9 steps. The steps are recorded back to back: the countdowns between them are NOT in the file, so the recording cannot be replayed as one continuous session (the "return to start" error printed by `tools/analyze-imu.mjs` integrates across those holes and means nothing) |
| Tools | `tools/analyze-motion.mjs` (every number of sections 2 to 8), `tools/replay-motion.mjs` (sections 9 to 11, and the contract), `tools/lib/imu-recording.mjs` (loader, stroke finder) |

Reproduce: `node tools/analyze-motion.mjs [--section rate|bias|tremor|sweeps|swings|accel|axes|scale]` and `node tools/replay-motion.mjs [--model base|abs27|abs12|relGravity|relRoll|rel] [--sweep-T]`.

## 0. The short version

1. **The gyroscope is used and it is good.** Scale is right (two independent checks within 1 %), bias is 0.7 dps at most and stable, noise is 0.05 to 0.36 dps, drift at rest is 0.02 to 0.2 degrees in 8 s. The owner's impression "the gyroscope is not used" comes from the mapping, not from the sensor (section 9).
2. **The cut threshold was a factor 8 too low.** 1000 px/s at 27.4 px per degree is 36.5 deg/s. The owner's slow aiming sweeps run at a median of 54 deg/s (p90 161, p99 253, max 326). Replayed through the shipped pipeline, the blade is in CUTTING for **50 % of the time of the yaw sweep and 62 % of the pitch sweep**. The deliberate fast swings peak at **694 to 1049 deg/s (horizontal, median 981)** and **632 to 962 deg/s (vertical, median 785)**. Between "aiming" (p99 253) and "swinging" (slowest hard swing 632) there is a wide empty band; a cut threshold of 300 deg/s sits at its bottom with a zero false-cut result and 100 % of the hard swings recognised.
3. **The cursor range was the other half of the problem.** At 27.4 px per degree the owner's sweeps and swings cover the whole screen several times: the cursor is pinned at a screen edge for 24 % of the yaw sweep, 22 % of the pitch sweep, 80 % of the horizontal swings and 90 % of the vertical swings. A slow 30 degree change of posture moves the cursor by about 1000 px. Drift is NOT the reason for "re-centre all the time".
4. **A relative (mouse-like) pointer in the local frame of the sword fixes it** and needs no gravity and no yaw reference (contract section 1). The dead zone has to sit near 5 deg/s: tremor of a hand that tries to hold still is at most 3.5 deg/s at the 99th percentile once the first seconds are trimmed.
5. The controller sends a steady **33 Hz** (30.0 ms steps, 31.25 ms about every eighth sample, single lost packets of 60 ms). At 1000 deg/s that is 30 degrees between two samples, so the path between samples has to be interpolated and the head extrapolated (section 7.5, contract 2.5).

## 1. Method and trimming rules

- Device time is the clock everywhere (microsecond timestamps, wrap-safe difference). Host arrival times are used only for the jitter statistic.
- **The owner was handling the device at the start of several steps.** The means printed by `tools/analyze-imu.mjs` are contaminated (whole-step mean bias in raw LSB: `rest_table` -7/-20/136, `hold_still` -115/63/-130, `return_still` -5/-8/18, against a clean 0/-5/12). All bias numbers below come from the **longest run of the `rest_table` step in which every gyro axis stays within 6 dps of the median**: samples 3.1 to 12.1 s of the step, 295 samples, 9.0 s. Medians are used wherever a mean would be pulled by handling.
- Trim points used for "hold still" statistics are printed with each number: `hold_still` from 4, 6 and 7 s; `return_still` from 2 and 4 s; sweeps from 1 to 21 s (the first and last second contain the start and stop of the movement); `roll_360` 2 to 14 s; `table_spin_360` 2 to 16 s (the owner was still putting it down during the first two seconds).
- "Bias removed" means the clean table bias (0.00, -0.31, +0.73 dps). "|w|" is the magnitude of the bias-removed gyro vector; "tangent speed" is the part of it that moves the tip of the blade (the roll component about the blade axis removed, forward = device +y, see section 4).
- **"Hard stroke"** (used in sections 7 and 10, and in the contract acceptance metrics): a local maximum of |w| of at least 150 dps (two maxima closer than 250 ms: the higher one) that has |a| of at least 2.0 g within 3 samples (about 90 ms) of the peak. The accelerometer criterion is independent of every gyro threshold under test, which keeps the definition from being circular. It finds 15 hard strokes in `fast_swings_h` and 6 in `fast_swings_v`.

## 2. Report rate and gaps

| Quantity | Measured |
|---|---|
| Rate per step | 32.9 to 33.2 Hz (mean 33.1 Hz) |
| dt between samples (device time) | median 30.00 ms, p1 30.00, p99 31.25, min 27.50, max 61.25 |
| Distribution | 4133 x 30.00 ms, 556 x 31.25 ms, 15 x 27.50, 13 x 28.75, 8 x 32.50, 9 gaps of 60.0 to 61.25 ms. All values are multiples of 1.25 ms (the timestamp resolution looks like 1.25 ms) |
| Lost packets | 9 gaps of exactly two periods (60 ms), 0.19 % of the samples; no gap of three or more |
| Duplicate timestamps | 1 (dt = 0) |
| Host arrival versus device time | jitter of the inter-arrival time minus the device dt: sd 2.9 ms, p1 -4.3, p99 +4.0 ms (extremes -33 and +31 ms, both single events); burst pairs (two reports less than 10 ms apart) 0.17 % |
| Worst per-step gap | 61 ms (`rest_table`), 60 ms elsewhere |

Meaning for the design:

- Between two samples the tip of a hard stroke travels up to 30 degrees (1000 deg/s x 30 ms); at the pointer gain of the contract that is 408 px horizontally per sample. The path must be interpolated (contract 2.5) or every fast stroke would be drawn and hit-tested as a chain of 400 px chords.
- The display runs at 60 fps: with a sample every 30 ms, a frame is 0 to 30 ms old. Holding the last position costs a mean error of 113 px (p95 319 px) on the hard strokes; linear extrapolation brings it to 18 px (p95 61), extrapolation with the measured acceleration and a no-reversal clamp to 13 px (p95 46) (section 7.5).
- The arrival jitter is small on the native bridge, so device timestamps and arrival times agree. Chrome's Web Bluetooth path was not measured (UNVERIFIED-ON-HARDWARE, UOH-4).
- A single lost packet doubles one step to 60 ms. The integration must treat 60 ms as normal (it already does: `maxGapMs` is 200).

## 3. Gyro bias, noise and scale

### 3.1 Bias and noise (clean table window, 9.0 s)

| Axis | bias raw LSB (median) | bias dps | bias mean raw | noise sd raw | noise sd dps | peak-to-peak raw | sd of 1 s means (raw) |
|---|---|---|---|---|---|---|---|
| x | 0 | 0.00 | 0.03 | 0.88 | 0.05 | 6 | 0.10 |
| y | -5 | -0.31 | -5.17 | 5.93 | 0.36 | 95 | 0.29 |
| z | +12 | +0.73 | 12.39 | 0.92 | 0.06 | 5 | 0.24 |

- Median |w - bias| at rest is 0.14 dps (p99 1.55, max 2.99); the y axis carries all the outliers (the roll axis is noisier by a factor of 6 than x and z).
- Drift with the bias removed, integrated over 8.0 s at rest: x 0.02, y -0.08, z 0.20 degrees. Without any bias correction it would be 0.02, -2.52, 6.05 degrees in 8 s. The 1 s means are stable to 0.006 to 0.02 dps.
- The accelerometer at rest on the table reads (1.00, 0.01, -0.02) g, |a| 1.004, sd below 0.005 g: the scale 4096 LSB per g is right within about 1 %. Hand-held holds read |a| 0.98 to 1.00.
- No saturation anywhere: the largest raw gyro value is 16766 LSB (1023 dps, full scale is 32767) and the largest accelerometer value is 6.45 g (full scale 8 g).

Meaning: bias and noise are irrelevant for the pointer; the bias the calibration wizard will measure from a hand-held 2 s hold is wrong by at most the tremor mean (under 2 dps, section 5), which a dead zone of 5 dps absorbs. The online bias estimator is a nice-to-have.

### 3.2 Scale

The nominal 0.06103515625 dps per LSB is right. Three checks, the first two independent of how long the owner took:

| Check | Result |
|---|---|
| `roll_360`: the gyro-y integral against the unwrapped roll angle from gravity, `atan2(a.x, a.z)` (gravity roll is negated by a right-hand rotation, so slope -1 is the nominal scale with the right-hand sign) | regression slope **-1.00**, r = -1.00; gyro integral 1243 deg against a gravity angle of -1233 deg: ratio **1.01**. (The owner rolled 3.45 turns, not the 4 asked for; the gravity angle confirms the gyro whatever the count.) |
| `table_spin_360`: signed gyro-z integral over the moving core (2.0 to 17.0 s) | **-1431.4 deg = -3.98 turns**, 8.6 degrees (0.6 %) from four whole turns; the gyro z sign is right-handed (a negative integral is, by the right-hand rule with z up, a clockwise spin seen from above) |
| `pitch_sweep`: gyro-x integral against the elevation of the blade from gravity, increments over 0.3 s | slope 0.89 (regressing gyro on gravity) to 0.93 (gravity on gyro), r = 0.98. The pitch axis is less clean (the gravity elevation of a moving hand is biased by the swing) and leaves room for a per-axis gain error of up to about 10 %; UNVERIFIED-ON-HARDWARE |
| The alternative scale of the protocol notes (0.0075 dps per LSB) | would read 0.49 turns for the table spin: rejected |

Meaning: `gyroScale = 1`; the wizard's estimate (sign, scale snap) will confirm it. A 7 to 10 % per-axis error would change the cursor gain by the same 7 to 10 %, invisible next to a gain that varies by a factor of 3 over the speed range.

## 4. Axis mapping

Share of the rotational energy (sum of the squared bias-removed rates) per device axis:

| Step | x | y | z | Reading |
|---|---|---|---|---|
| `yaw_sweep` | 6 % | 10 % | **84 %** | yaw (turning left and right, also spinning flat) is gyro **z** |
| `pitch_sweep` | **90 %** | 7 % | 3 % | pitch (tip up and down) is gyro **x** |
| `roll_360` | 2 % | **96 %** | 1 % | roll about the long axis is gyro **y** |
| `table_spin_360` | 0 % | 6 % | **94 %** | |
| `fast_swings_h` | 11 % | 3 % | **85 %** | horizontal slashes are rotations about z |
| `fast_swings_v` | **90 %** | 4 % | 6 % | vertical slashes are rotations about x |

- At the hold poses gravity reads +z (for example (0.04, 0.03, 0.99) g in `hold_still`), so in this recording the device is held with **forward = +y, up = +z, right = +x**: the `faceUp` preset of the simulator (`SIM_MOUNTS.faceUp`). On the table (`rest_table`) gravity read +x (the device lay on its side), in `table_spin_360` +z (flat).
- Signs: +gyro y is a right-hand rotation about +y (slope -1.00 against gravity, above); +gyro x raises the +y axis (slope +0.9); +gyro z is a right-hand rotation about +z (counter-clockwise seen from above, i.e. turning left). The sign of the forward axis (tip towards +y or -y) cannot be told from this recording; it only mirrors the vertical direction, and the calibration wizard finds it.
- The yaw sweep is not a pure rotation about the world vertical: during it the gravity roll of the device ranged -41 to +40 degrees and the elevation of the blade -16 to +53 degrees, and the rotation axis lay 17 degrees (median) from device z against 19 degrees from the world vertical. The owner sweeps about the **sword's own up axis**, not about the vertical. This is why the contract chooses the local frame of the sword for the pointer (contract 1.3).
- During a vertical slash the blade passes very close to the vertical: the gravity elevation reaches +74 to +77 degrees at the top of the wind-up (and the wind-up rotates about 150 degrees over the top of the head), so any pointer built on the gravity direction sees the pole.

## 5. Tremor and hand wander while trying to hold still

Bias removed. Tangent speed = the speed that would move the cursor; |w| = total.

| Window | n | |w| median | p90 | p99 | max | tangent median | p90 | p99 |
|---|---|---|---|---|---|---|---|---|
| `hold_still` whole step | 334 | 4.4 | 66.0 | 267.7 | 336.8 | 2.6 | 39.6 | 202.4 |
| `hold_still` from 4 s | 201 | 2.4 | 11.7 | 52.2 | 101.4 | 1.2 | 4.6 | 15.3 |
| `hold_still` from 6 s | 134 | 1.7 | 7.5 | 15.8 | 16.5 | 0.9 | 3.2 | 8.0 |
| `hold_still` from 7 s | 101 | 1.4 | 3.0 | 4.9 | 5.8 | 0.7 | 1.5 | 2.9 |
| `return_still` whole step | 401 | 1.7 | 4.7 | 21.8 | 35.6 | 1.3 | 4.0 | 17.7 |
| `return_still` from 2 s | 334 | 1.5 | 2.7 | 3.6 | 5.0 | 1.2 | 2.4 | 3.5 |
| `return_still` from 4 s | 268 | 1.5 | 2.5 | 3.6 | 4.3 | 1.1 | 2.3 | 3.5 |
| `rest_table` from 4 s (on the table) | 267 | 0.1 | 0.2 | 0.4 | 0.5 | 0.1 | 0.1 | 0.1 |
| `fast_swings_v` last 2 s (still, after the swings) | 54 | 3.2 | 5.3 | 8.2 | 8.3 | 2.3 | 4.5 | 5.3 |

The untrimmed rows (median 1.7 to 4.4, p90 4.7 to 66, p99 22 to 268) are the numbers quoted in the brief: they include the owner picking the device up (first 4 to 6 s of `hold_still`) and the settling after the last swing. The trimmed rows are the tremor.

Share of samples below a dead-zone radius (tangent speed):

| Dead zone (dps) | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 15 |
|---|---|---|---|---|---|---|---|---|---|
| `hold_still` from 7 s | 96.0 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| `hold_still` from 4 s (includes a bump of 101 dps at 5 s) | 66.2 | 78.1 | 87.1 | 91.5 | 93.0 | 95.5 | 97.5 | 98.0 | 98.5 |
| `return_still` from 2 s | 79.9 | 96.4 | 99.4 | 100 | 100 | 100 | 100 | 100 | 100 |
| `fast_swings_v` last 2 s | 38.9 | 72.2 | 87.0 | 94.4 | 100 | 100 | 100 | 100 | 100 |

Wander (angle moved by the aim direction): in `hold_still` from 7 s, 1 s windows move the tip by a median 0.24 degrees (p90 0.35, max 0.40); over the 3 s the integrated excursion is 0.38 degrees in yaw and 0.69 in pitch. In `return_still` from 2 s: median 0.27 degrees per second (p90 0.94, max 1.11); over 10 s the excursion is 1.9 degrees in yaw and 2.0 in pitch.

Meaning for the design:

- A hand that tries to hold still gives a tangent speed below **5 deg/s in 100 % of the samples** (two steps, 435 samples) and below 6 deg/s in 100 % of the residual steady stretch after a swing. A dead zone of **5 deg/s** removes the tremor completely; the contract's replay shows a cursor range of 0.0 px over both windows, against 78 px and 29 px for the shipped absolute pointer (9.8 and 12.1 px in x).
- The idle test for the auto-centre (sword at rest) can be **8 deg/s** (above the tremor p99 of 3.5 and below the slowest deliberate aiming); it should end above 14 deg/s.
- A calibration hold (the wizard's 2 s stillness rule, mean below 6 and peak below 15 deg/s) is achievable: the holds trimmed from 2 s (`return_still`) and 7 s (`hold_still`) have a maximum of 5.0 and 5.8.
- Tremor is not the cause of the owner's "too sensitive" feeling: at 27.4 px per degree the trimmed holds move the cursor by under 80 px. What the owner sees is the movement of the sword itself mapped at 13 to 27 px per degree (section 9).
- This is a calm hold on a chair-height demonstration. During play the hand is tenser. The dead zone should be generous; it costs nothing in the aiming range because the gain curve of the contract grows smoothly from the edge of the dead zone.

## 6. Intentional slow aiming

`yaw_sweep` (asked: sweep left and right about 60 degrees each side, 5 round trips) and `pitch_sweep` (about 40 degrees each side, 5 round trips). What the owner did, from the integrated angle:

| Step | Half-cycles found | Amplitude of a half-cycle | Duration of a half-cycle | Mean speed of a half-cycle | Peak-to-peak of the whole step |
|---|---|---|---|---|---|
| `yaw_sweep` 1 to 21 s | 17 | median 70.8 deg (min 6.9, max 98.8) | median 1.33 s | median 61.6 deg/s | 99.6 deg |
| `pitch_sweep` 1 to 21 s | 18 | median 42.1 deg (min 27.8, max 51.2) | median 1.07 s | median 39.3 deg/s | 57.9 deg |

(Seven to eight round trips of a smaller amplitude than asked, at 1 to 1.3 s per half-cycle. Nothing in the recording says what the owner looked at, so these are the amplitudes and speeds of a person who was asked to "aim slowly".)

Distribution of the angular speed (bias removed):

| Step | n | q50 | q75 | q90 | q95 | q99 | max | share of samples at or above 100 / 150 / 200 / 250 / 300 / 400 / 500 dps |
|---|---|---|---|---|---|---|---|---|
| `yaw_sweep` 1..21 s, \|w\| | 662 | 54.3 | 108.9 | 160.7 | 199.4 | 253.2 | 325.5 | 28.9 / 12.5 / 5.0 / 1.2 / 0.3 / 0 / 0 % |
| `yaw_sweep` 1..21 s, tangent | 662 | 48.0 | 104.1 | 155.7 | 194.3 | 252.9 | 319.2 | 26.0 / 11.5 / 4.2 / 1.2 / 0.3 / 0 / 0 % |
| `pitch_sweep` 1..21 s, \|w\| | 662 | 42.3 | 53.9 | 66.2 | 74.5 | 86.6 | 107.3 | 0.2 / 0 / 0 / 0 / 0 / 0 / 0 % |
| `roll_360` 2..14 s, \|w\| | 398 | 91.3 | 150.6 | 212.6 | 259.3 | 385.4 | 530.6 | 45.2 / 25.9 / 11.1 / 5.5 / 3.3 / 1.0 / 0.3 % |
| `roll_360` 2..14 s, tangent | 398 | 14.3 | 25.1 | 39.8 | 50.3 | 86.7 | 122.9 | 0.5 / 0 / 0 / 0 / 0 / 0 / 0 % |
| `table_spin_360` 2..16 s, \|w\| | 463 | 103.2 | 137.3 | 162.7 | 179.4 | 256.5 | 284.9 | 51.8 / 18.6 / 3.2 / 1.3 / 0 / 0 / 0 % |

Time-weighted share (linear interpolation between samples) of `yaw_sweep` above 100 / 150 / 200 / 250 / 300 / 400 dps: 28.9 / 12.1 / 4.6 / 1.0 / 0.24 / 0 %.

Meaning:

- **Ordinary aiming is fast.** The median aiming speed is 42 to 54 deg/s, a quarter of the yaw sweep is faster than 109 deg/s, 5 % is faster than 199 deg/s. The shipped threshold of 36 deg/s lies below the median: it could never separate aiming from cutting.
- A threshold of **300 deg/s is exceeded by 0.3 % of the samples** of the most vigorous aiming (two isolated samples in the yaw sweep, peak 325), a threshold of 250 by 1.2 % (time share 1.0 %), 200 by 5 %.
- Rolling the wrist about the blade axis (`roll_360`) produces |w| up to 530 deg/s but the tip speed stays at or below 123 deg/s: **the cut decision must use the tangent speed, not |w|** (otherwise 3.3 % of a roll test cuts at 300).
- The table spin (a flat spin about the vertical, a legitimate yaw) stays below 285 deg/s; nothing in the slow steps gets above 326.
- A half-cycle of 70 degrees at about 60 deg/s is what a slow aiming movement looks like (contract 2.2 gives it about 400 px, 20 % of the screen width, at that speed; the faster parts of the same sweeps reach a cursor range of 55 % of the width), and a hard stroke crosses the screen once.

## 7. Fast swings

`fast_swings_h` (asked: 8 fast horizontal slashes, one every 1.5 s) and `fast_swings_v` (8 fast vertical slashes, top to bottom). The owner did 15 and 6 hard strokes, with slow returns or wind-ups in between.

### 7.1 Per stroke

Horizontal (15 hard strokes; the last run, from 11.2 s, is three strokes with fast returns in between, so two of its entries are inflated in the "samples above" column for the low thresholds only):

| # | t (s) | peak \|w\| (dps) | angle swept (deg) | rise 10 % to peak (ms) | peak \|a\| (g) |
|---|---|---|---|---|---|
| 1 | 0.5 | 981 | 144 | 121 | 5.75 |
| 2 | 1.2 | 878 | 125 | 150 | 3.65 |
| 3 | 2.0 | 990 | 130 | 180 | 4.69 |
| 4 | 2.9 | 831 | 139 | 180 | 4.16 |
| 5 | 3.9 | 1004 | 170 | 181 | 4.58 |
| 6 | 4.9 | 694 | 115 | 303 | 3.04 |
| 7 | 5.7 | 983 | 136 | 121 | 4.24 |
| 8 | 6.6 | 875 | 137 | 181 | 3.05 |
| 9 | 7.4 | 1049 | 150 | 151 | 4.68 |
| 10 | 8.3 | 851 | 140 | 181 | 3.11 |
| 11 | 9.3 | 1017 | 152 | 151 | 4.67 |
| 12 | 10.0 | 980 | 137 | 91 | 3.79 |
| 13 | 11.2 | 789 | 118 | 120 | 3.34 |
| 15 | 12.4 | 992 | 137 | 91 | 4.54 |
| 17 | 13.7 | 1009 | 134 | 90 | 4.49 |

Peaks: min 694, q25 863, **median 981**, q75 998, max 1049 deg/s. Angle swept per stroke: median 137 (115 to 170) degrees. The two non-hard local maxima (269 and 205 dps at 11.9 and 13.1 s) are the fast returns between strokes 13 and 15 and 15 and 17, accelerations of 1.5 and 1.3 g.

Vertical (6 hard strokes and 5 returns):

| # | t (s) | kind | peak \|w\| | angle swept | peak \|a\| |
|---|---|---|---|---|---|
| 1 | 0.4 | hard | 962 | 121 | 5.81 |
| 2 | 1.5 | return | 189 | 109 | 1.17 |
| 3 | 2.2 | hard | 855 | 111 | 6.45 |
| 4 | 3.5 | return | 229 | 109 | 1.27 |
| 5 | 4.3 | hard | 632 | 116 | 4.47 |
| 6 | 5.5 | return | 236 | 136 | 1.20 |
| 7 | 6.1 | hard | 788 | 113 | 5.13 |
| 8 | 7.6 | return | 176 | 100 | 0.93 |
| 9 | 8.0 | hard | 692 | 119 | 4.75 |
| 10 | 9.6 | return | 192 | 107 | 1.03 |
| 11 | 10.1 | hard | 782 | 121 | 4.94 |

Hard strokes: peaks min 632, q25 714, **median 785**, q75 838, max 962 deg/s; angle swept median 118 (111 to 121) degrees; rise median 196 ms. The owner's vertical slashes are a circular overhead movement: the returns are slow (176 to 236 deg/s) wind-ups of 100 to 136 degrees that carry the tip over the top; the slash comes back down. **The earlier figure "vertical peaks median 184, max 855" counts these returns as swings.**

### 7.2 How long a stroke stays above a candidate threshold

Hard strokes only. "Samples" = consecutive samples at or above the threshold around the peak; "ms" = time above it with linear interpolation of the two crossings.

| Threshold (deg/s) | H: share of strokes reaching it | H samples median / min | H ms median / min | V: share reaching | V samples median / min | V ms median / min |
|---|---|---|---|---|---|---|
| 150 | 100 % | 8 / 7 | 261 / 223 | 100 % | 7.5 / 7 | 246 / 224 |
| 200 | 100 % | 7 / 6 | 217 / 189 | 100 % | 7 / 6 | 209 / 193 |
| 250 | 100 % | 6 / 6 | 193 / 169 | 100 % | 6 / 5 | 186 / 166 |
| 300 | 100 % | 6 / 5 | 178 / 152 | 100 % | 5 / 5 | 165 / 148 |
| 400 | 100 % | 5 / 4 | 148 / 128 | 100 % | 4 / 4 | 134 / 120 |
| 500 | 100 % | 4 / 4 | 126 / 105 | 100 % | 3.5 / 3 | 110 / 98 |
| 600 | 100 % | 4 / 2 | 108 / 63 | 100 % | 3 / 1 | 80 / 53 |

The vertical returns (the five non-hard maxima) peak at 176, 189, 192, 229 and 236 deg/s: **none of them reaches 250**, two exceed 200 (and are above 200 for 198 and 258 ms).

Meaning:

- At 300 deg/s every hard stroke has at least **5 consecutive samples (at least 148 ms)** above the threshold, at 450 at least 4 samples. A minimum duration of two consecutive samples (25 ms as a time, which is one 30 ms step) never rejects a real stroke for any threshold up to about 500 deg/s, and it rejects the isolated single-sample events of fast aiming (contract 2.4: at 300 it turns the two entries of the yaw sweep into none; at 250 it takes 5 entries down to 3).
- A threshold of **600 or more starts to lose strokes** (14 of 15 horizontal at 600 and 700, 4 of 6 vertical at 700 when a minimum duration of zero is used, 3 of 6 with 25 ms): the settings range must stop at 700 and the Hard preset must stay well below the slowest stroke of the session (632) - 450 does.
- A threshold of **250 or less starts to cut the vertical returns** (229 and 236 dps), i.e. slow repositioning moves: the Easy preset (225) does cut them, by design.
- A stroke is 115 to 170 degrees of rotation in 200 to 330 ms, with a rise from 10 % of the peak to the peak in a median 150 to 200 ms: the cut starts while the sword is still accelerating, so the threshold crossing is sharp (two or three 30 ms samples between 10 % and 100 %). The state machine has to live with one or two samples of decision latency (contract 2.4: the first chord is delivered retroactively).

### 7.3 Tip speed versus total speed in strokes

The ratio of the tangent peak to the |w| peak is 0.99 to 1.00 for all 21 hard strokes (it is 0.80 and 0.73 only for the two fast returns between strokes 13, 15 and 17): in a real slash there is almost no roll about the blade axis, so the tangent and the total speed agree.

### 7.4 Time resolution of the cut decision

With the contract's rule (enter at 300 deg/s after two samples, leave below 195) the cut starts **30 ms (one sample) after the first sample at or above 300** and ends 15 to 31 ms after the last one above it (median 30 ms for horizontal strokes, 15 to 31 ms for vertical). Because the first chord is delivered retroactively, 95 % of the cursor path of a horizontal stroke (median; minimum 86 %) and 90 % of a vertical one (minimum 87 %) is inside cut segments.

### 7.5 Interpolation and extrapolation

A hard stroke moves the cursor up to 408 px (horizontal) or 352 px (vertical) between two samples at the contract's gain. With the path between two samples modelled as a quadratic (velocity linear in time, which is exactly the trapezoid rule the integration uses), the error of drawing the head at a 60 fps frame time inside a sample interval (phases 0.2 to 1.0 of the interval) is, over the horizontal hard strokes:

| Predictor | mean | p95 | max |
|---|---|---|---|
| hold the last position | 113 px | 319 px | 416 px |
| last position + velocity x time | 18 px | 61 px | 104 px |
| with the last measured acceleration, velocity never reversing | **13 px** | **46 px** | 100 px |

This is a model-based estimate: the "truth" is the interpolated path to the next sample, which is the best available at 33 Hz. The numbers show the order of magnitude: holding the last sample makes the drawn head lag the real sword by about 110 px on average at stroke speed, the contract's predictor by about 13 px.

## 8. Accelerometer

| Step | \|a\| median | \|a\| p99 | \|a\| max | \| \|a\| - 1 \| p90 | p99 | max | share above 0.5 g / 1 g / 2 g |
|---|---|---|---|---|---|---|---|
| `yaw_sweep` 1..21 s | 1.00 | 1.20 | 1.34 | 0.11 | 0.22 | 0.34 | 0 |
| `pitch_sweep` 1..21 s | 0.99 | 1.10 | 1.15 | 0.08 | 0.12 | 0.18 | 0 |
| `roll_360` 2..14 s | 1.00 | 1.19 | 1.39 | 0.10 | 0.21 | 0.39 | 0 |
| `table_spin_360` 2..16 s | 0.99 | 1.07 | 1.16 | 0.04 | 0.10 | 0.16 | 0 |
| `hold_still` from 7 s | 0.99 | 1.01 | 1.01 | 0.02 | 0.02 | 0.03 | 0 |
| `fast_swings_h` | 1.09 | 4.74 | 5.75 | 2.25 | 3.74 | 4.75 | 33.8 / 24.6 / 12.6 % |
| `fast_swings_v` | 0.99 | 5.00 | 6.45 | 0.52 | 4.00 | 5.45 | 10.3 / 7.9 / 5.4 % |

- In the hard strokes |a| has p95 4.1 g (horizontal) and 3.2 g (vertical) over the whole step, peaks 5.75 g and 6.45 g, below the 8 g full scale (no clipping in 4744 samples).
- **The accelerometer separates hard strokes from everything else very cleanly**: the largest | |a| - 1 | anywhere in the slow steps is 0.39 g, the smallest peak of a hard stroke is 2.04 g (a factor of 5). The peak of |a| sits at the gyro peak or 30 to 60 ms after it (median +30 ms horizontal, +61 ms vertical): it is a late and mount-dependent signal.
- The implied lever arm from the pivot to the sensor, (peak |a| - 1 g) / w_peak^2, is 0.11 m (median, range 0.09 to 0.16) for the horizontal slashes and 0.23 m (0.17 to 0.28) for the vertical ones: the owner swings from the wrist horizontally and from the elbow vertically. The accelerometer magnitude therefore depends on how the sword is swung, not only on how fast.
- Gravity cannot be used during a swing (|a| is 3 to 6 g); the fusion already gives it zero weight while cutting.

Meaning: **the decision to cut is made on the angular speed** (clean, symmetric, no lever-arm dependence, available without delay). The accelerometer could serve as a second opinion ("impact") but it arrives later, depends on the swing style and adds a parameter; the contract does not use it (risk R4 in the contract lists it as the first thing to add if real play shows false cuts that a gyro threshold cannot remove).

## 9. What the shipped defaults did to this recording

Replay through the real `public/js/motion/pipeline.js` with a nominal calibration (identity frame, sign +1, scale 1, the table bias), default settings (sensitivity 1.0, cut threshold 1000 px/s, auto-centre on), every step from a fresh pipeline, cursor at the centre at the start:

| Step (window) | Cursor range (x of width, y of height) | Pinned at an edge (share of time) | In CUTTING (share of time) |
|---|---|---|---|
| `hold_still` from 7 s | x 9.8 px, y 78.3 px | 0 | 0 |
| `return_still` from 2 s | x 12.1 px, y 28.8 px | 0 | 0 |
| `yaw_sweep` 1..21 s | 100 % / 64.5 % | 24.3 % | **50.3 %** (38 separate entries) |
| `pitch_sweep` 1..21 s | 16.8 % / 100 % | 22.1 % | **61.6 %** (20 entries) |
| `roll_360` 2..14 s | 24.6 % / 62.8 % | 0 | 15.9 % (12 entries) |
| `table_spin_360` 2..16 s | 100 % / 16.4 % | 77.1 % | 19.0 % (6 entries) |
| `fast_swings_h` | - | 80.1 % | 15 of 15 hard strokes cut |
| `fast_swings_v` | - | 90.0 % | only 3 of 6 hard strokes cut (the cursor is clamped at the edge for most of the stroke) |

Largest movement of the cursor between two samples: 1820 px (horizontal swings) and 2131 px (vertical) - more than a screen width per sample. A slow posture change (30 degrees of yaw and 20 of pitch over 2 s at 15 and 10 deg/s, injected on the real still data) moves the cursor by 996 px (-863, -499).

How the owner's four remarks read against this:

1. "The gyroscope does not seem to be used, the cursor always has to be re-centred and re-calibrated." The gyro is used (sections 3, 4). What the owner sees is an absolute pointer at 27.4 px per degree: the whole screen is 70 degrees wide, the owner's own sweeps are 100 degrees peak to peak, a hard slash is 137 degrees. The cursor sits at an edge for a quarter of a sweep and for 80 to 90 % of a swing; a slow change of posture moves it by a whole screen. **It is not gyro drift**: drift at rest is 0.02 to 0.2 degrees in 8 s.
2. "The cut threshold is far too low." 36.5 deg/s against a median aiming speed of 54 deg/s: the blade is cutting for half of every aiming sweep.
3. "The sensitivity is far too high even at its minimum." The minimum of the old range (0.5) is 13.7 px per degree: the owner's 70 degree half-cycle covers 960 px, half the screen, and a slash 1900 px. With the cursor also cutting all the time this reads as "everything moves and cuts". (It is an interpretation: nothing in the recording measures the owner's feeling.)
4. The connection works: 33 Hz, no dropouts beyond 9 single lost packets.

## 10. The numbers that decide the design (measured on this recording)

### 10.1 Cut threshold (relative pointer, tangent speed, hysteresis 0.65, contract 2.4)

False cutting in the slow steps and recognition of the hard strokes, for a range of thresholds, with and without the 25 ms minimum duration (`node tools/replay-motion.mjs --sweep-T`). "Cut" for a hard stroke: CUTTING at the peak sample +-60 ms and at least half of the cursor path of the stroke inside cut segments.

| T (deg/s) | min duration | yaw CUTTING share (entries) | pitch | roll | table spin | hold | hard H cut | hard V cut | cut path share median H / V |
|---|---|---|---|---|---|---|---|---|---|
| 150 | 25 ms | 11.65 % (17) | 0 | 0 | 21.4 % | 0 | 15/15 | 6/6 | 100 / 101 % |
| 200 | 25 ms | 4.39 % (10) | 0 | 0 | 4.3 % | 0 | 15/15 | 6/6 | 98 / 96 % |
| 225 | 25 ms | 2.27 % (6) | 0 | 0 | 1.7 % | 0 | 15/15 | 6/6 | 97 / 96 % |
| 250 | 25 ms | 1.06 % (3) | 0 | 0 | 1.1 % | 0 | 15/15 | 6/6 | 96 / 96 % |
| **300** | 25 ms | **0.00 % (0)** | 0 | 0 | 0 | 0 | **15/15** | **6/6** | 95 / 90 % |
| 300 | 0 ms | 0.61 % (2) | 0 | 0 | 0 | 0 | 15/15 | 6/6 | 95 / 90 % |
| 350 | 25 ms | 0 | 0 | 0 | 0 | 0 | 15/15 | 6/6 | 93 / 87 % |
| 450 | 25 ms | 0 | 0 | 0 | 0 | 0 | 15/15 | 6/6 | 88 / 81 % |
| 500 | 25 ms | 0 | 0 | 0 | 0 | 0 | 15/15 | 6/6 | 83 / 77 % |
| 600 | 25 ms | 0 | 0 | 0 | 0 | 0 | 14/15 | 5/6 | 77 / 65 % |
| 700 | 25 ms | 0 | 0 | 0 | 0 | 0 | 13/15 | 1/6 | 67 / 23 % |

(The 225 row comes from the same script with `--T 225`; the others from the default sweep. With 0 ms the rows for 150 to 250 show more false cutting: 16.0 % / 6.1 % / 2.1 % for 150 / 200 / 250 (and 3.5 % at 225); at 600 and 700 a zero minimum still loses 1 and 2 horizontal strokes, at 700 five of six vertical ones.) Conclusions: Normal 300 is the lowest round value with no false cutting, all hard strokes recognised and a margin of 52 % under the slowest stroke of the session (632); Easy 225 still keeps false cutting at about 2 % of the most vigorous aiming of the session (it is the price of "easy"); Hard 450 keeps every stroke of this owner with a margin of 29 % under 632 and still 88 % / 81 % of the stroke path inside cut segments; above 500 the path share and then the strokes fall away, so 700 is the last value worth offering.

### 10.2 Pointer model (section 11 and contract section 1 give the full comparison)

Decided from the replay of six models over the nine steps: two absolute models (27.4 and 12 px per degree), one relative model in player space (gravity decomposition), one relative model with roll tracking, and the chosen relative model in the local frame of the sword; the shipped pipeline is the baseline.

### 10.3 Gain curve

The pointer speed function of the contract (dead zone 5 deg/s, gain from 5 to 14 px per degree over 300 deg/s of speed above the dead zone) turns the owner's own motion into:

| Motion of the recording | Pointer result |
|---|---|
| hard horizontal stroke (median 137 degrees) | path of 1814 px = **94 % of the screen width** (min 1453, max 2251 px) |
| hard vertical stroke (median 118 degrees) | path of 1533 px = 142 % of the screen height (1420 to 1624 px): a slash crosses the screen once and clamps |
| yaw sweep 1..21 s (99.6 degrees peak to peak, median speed 54 deg/s) | cursor x range 55 % of the width, y range 31 % |
| pitch sweep 1..21 s (57.9 degrees peak to peak) | cursor y range 26 % of the height, x range 2.7 % |
| the two still windows | cursor range 0.0 px |
| slow posture change (30 + 20 degrees at 15 and 10 deg/s) | cursor ends 133 px from where it was (shipped: 996 px) |

### 10.4 Idle auto-centre

Real hand-held tremor (`return_still` from 2 s) as input, cursor placed far from the centre first: within 100 px of the centre after 2.5 s from a corner (1020 px away), 2.35 s from the right edge, 1.8 s from the bottom edge, 1.3 s from 152 px away; within 20 px after 3.0, 2.9, 2.4 and 1.9 s (the 1.0 s rest hold and the 0.3 s ramp are included). It never ran while the tip moved faster than 21 deg/s or while the blade was cutting (0 samples in the yaw, pitch and both fast steps).

## 11. The pointer models side by side (replay, same recording)

| Model | hold range (x / y px) | yaw sweep x / y range | edge time yaw / fast H / fast V | hard strokes cut H / V | posture change | Verdict |
|---|---|---|---|---|---|---|
| base (shipped: absolute, 27.4 px/deg, 1000 px/s) | 9.8-12.1 / 28.8-78.3 | 100 % / 64 % | 24 % / 80 % / 90 % | 15/15, 3/6 | 996 px | rejected |
| abs27 (absolute, 27.4, new cut logic) | same | same | same | 15/15, 6/6 | 996 px | rejected: the pointer itself is the problem |
| abs12 (absolute, 12 px/deg) | 4.3-5.3 / 12.6-34.3 | 65 % / 37 % | 0 % / 33 % / 79 % | 15/15, 6/6 | 436 px | rejected: needs 160 degrees of rotation for the screen width; posture still moves the cursor by 436 px |
| relGravity (relative, gravity decomposition every sample) | 0 / 0 | 55 % / 38 % | 0 / 22 % / 48 % | 15/15, 6/6 | 133 px | rejected: the direction of the cursor reverses (up to 175 degrees between two consecutive fast samples) in 7 of 21 hard strokes where the blade passes the pole |
| relRoll (relative, sword plane rotated by a tracked gravity roll) | 0 / 0 | 56 % / 52 % | 0 / 28 % / 9 % | 15/15, 6/6 | 133 px | rejected: turns the owner's yaw sweeps into diagonals (y range 52 % against 31 %), needs a roll estimator, gains nothing measurable |
| **rel (relative, local frame of the sword)** | **0 / 0** | **55 % / 31 %** | **0 / 33 % / 9 %** | **15/15, 6/6** | **133 px** | **chosen** |

"Edge time" is the share of time the cursor sits on the boundary of the playfield. For the relative models the fast-swing edge time is high (33 % horizontal) because a hard stroke (94 % of the width) is followed by a slow return; with a relative pointer that is not a problem: the cursor never "gets stuck", moving back moves it back at once.

## 12. What the recording cannot tell

- **No ground-truth orientation.** There is no camera, no turntable, no second sensor. Angles are integrated gyro angles, cross-checked only by gravity (valid at rest and in slow motion) and by the owner's hand-counted turns.
- **Hand-timed, hand-judged steps.** The owner's amplitude and speed in the sweeps are not the asked ones (70 degrees instead of 120, 8 round trips instead of 5). The roll test is 3.45 turns, not 4. The table spin is the only step whose integer outcome gives a clean scale check; its start contains handling.
- **One controller, right side only, one mount, one person.** The bias, the noise, the per-axis gain, the mount frame (forward +y, up +z) and the swing style (wrist horizontally, elbow vertically, a circular overhead wind-up) are those of one owner and one Joy-Con 2 Right. The Left unit (product id 0x2067) is not covered. A taller or weaker person swings slower; a child may never reach 300 deg/s (risk R2).
- **No calm-versus-tense comparison.** The tremor numbers are from a person who was asked to hold still, sitting or standing in a quiet moment, not from the middle of a round. A hand holding a sword with adrenaline is tenser.
- **Not a game session.** Nobody was cutting fruit; "aiming" here is the owner's slow sweeps, not targeting a moving fruit. What speed the owner uses to place the cursor in play is unknown.
- **Mount on the real sword.** The recording was made with the Joy-Con held (strapped on the sword or not: the file does not say); the wizard must find the mount of the real sword. Every formula in the contract uses the calibrated frame, none assumes the `faceUp` mount; the replay uses it because the recording implies it.
- **The sign of the forward axis and of the yaw** (the tip direction and the left/right sense) cannot be seen in the file. The wizard finds the former; the `flipX` setting covers the latter.
- **Latency.** Device timestamps give intervals, not the delay from motion to screen. The Chrome Web Bluetooth path was not recorded.
- **The pole.** The vertical slashes pass within 13 to 16 degrees of the vertical; nothing is known about how the owner's other gestures look.
- **Feel.** All gains, dead zone, presets and the idle timings are design values derived from speeds and ranges; whether the owner finds them comfortable is **UNVERIFIED-ON-HARDWARE** and is the first thing to tune on the sword (the tuning screen exists for this).

## 13. Design consequences (number to decision)

| Finding | Decision (contract section) |
|---|---|
| Aiming p99 253, max 326 deg/s; hard strokes at least 632 | cut threshold in **deg/s, 300** default, range 100 to 700, Easy 225, Hard 450 (2.4, 3) |
| Strokes stay above 300 for at least 5 samples; single-sample spikes exist in fast aiming | minimum duration **25 ms**, hysteresis 0.65, retroactive first chord (2.4) |
| Roll produces |w| up to 530 at tip speed 123 | decide on the **tangent** speed (2.1) |
| Tremor p99 3.5, max 5.0 after trimming | dead zone **5 deg/s** (2.2), idle test 8 deg/s (2.3) |
| Yaw at 54 deg/s median, strokes 137 degrees, posture moves the absolute cursor by 996 px | relative pointer with a speed-dependent gain 5 to 14 px per degree (1, 2.2) |
| Rotation about the sword's own axes, pole passes in vertical slashes | local frame of the sword, no gravity in the pointer (1.3, 2.1) |
| 33 Hz, 408 px per sample at stroke speed, 113 px head lag if held | quadratic path, sub-segments of at most 48 px, head extrapolation up to 35 ms (2.5) |
| 9 lost packets of 60 ms, no longer gaps | no special handling beyond the existing 200 ms gap rule |
| Gyro scale within 1 %, bias under 1 dps, no saturation | no scale or bias work beyond the existing wizard; saturation warning stays |
| Accelerometer peaks 5 to 6 g after the gyro peak, lever-arm dependent | not used for the decision (R4) |
| Drift not a problem | the relative pointer needs no yaw reference; the old edge slip and soft-centring references are for the simulator only (2.6) |

## 14. As implemented (motion engineer, 2026-09-30)

What the contract (`docs/motion-contract.md`) asked for is in `public/js/motion/`; this section records what was built and the numbers the PIPELINE (not the prototype) produces on the recording. The replay is `test/motion/real-replay.test.js` (metrics A1 to A9, under 0.3 s), fed by the fixture `test-support/motion/fixtures/imu-2026-09-30T18-42-24.jsonl` (a byte-for-byte copy of the recording) and `test-support/motion/real-recording.js`. Everything below is **UNVERIFIED-ON-HARDWARE** for feel; it is proven against this one recording and against synthetic sensors only.

### 14.1 Where things are

| File | What |
|---|---|
| `pointer.js` | tip velocity (2.1), curve (2.2), `RelativePointer` (integration, idle soft auto-centre 2.3), the path of one interval: `planChords`, `planTrail`, `pathPoint`, `extrapolateHead` (2.5) |
| `angular-tracker.js` | `AngularCutTracker`: the cut decision in deg/s with hysteresis, minimum duration, retroactive first chord, swing ids (2.4) |
| `pipeline.js` | `pointerModel` (`'relative'` default, `'absolute'` for the simulator), `setPointerModel` / `getPointerModel`, `_relativeStep` (one IMU sample), the ease of `recenter`, `reanchor`, the new `BladeSample` and `MotionState` fields; the absolute model and the aim path run the old code (`aim.js`, `blade-tracker.js`) with the threshold converted to px/s |
| `motion-config.js` | `pointer` block (new), `cut` block (deg/s), `tracker` sizes 384 / 1024, `input.sensitivityRange` 0.3 to 2.0 |

### 14.2 The numbers that shipped (all in `MOTION_CONFIG`, all starting values)

| Item | Value |
|---|---|
| Dead zone | 5 deg/s of tip speed |
| Curve | `F(s) = sensitivity x e x (5 + 9 x smoothstep(min(1, e / 300)))` px/s with `e = s - 5`: 0.8 px/deg at 6 deg/s, 2.5 at 10, 6.8 at 100, 13.8 at 300, 14 beyond; `sensitivity` (default 1.0, 0.3 to 2.0, step 0.1) scales the speed only |
| Cut threshold | 300 deg/s (Normal), range 100 to 700 step 25, Easy 225, Hard 450, Zen x 0.8 = 240; leave below 0.65 x T; minimum duration 25 ms (two samples at 33 Hz); a dip that stays above the leave level keeps the candidate for 100 ms; swing grace 100 ms; samples above 2190 deg/s are ignored |
| Idle auto-centre | after 1.0 s below 8 deg/s and 500 ms without cutting (so at least 1.5 s after a swing); glide 120 to 800 px/s (2.5 x distance), 300 ms ramp; stops at once above 14 deg/s; `recenter` event `auto` on arrival after at least 40 px of travel |
| 33 Hz robustness | quadratic path (velocity linear in time), chords of about 48 px (at most 32 per interval, longest measured 61.5 px), trail ring samples every 8 ms (`trailStepMs`, at most 8 per interval), `headAt` extrapolates up to 35 ms with the last acceleration and never reverses |
| Sizes | history ring 384 samples (3 s of trail), segment queue 1024 |
| Speed scale for the game | `BladeSample.speed` = tip speed x 10/3 (300 deg/s = 1000 px/s), `speedDps` carries the real unit |

### 14.3 What the pipeline measures on the recording

| Metric | Contract pass | Prototype | Pipeline |
|---|---|---|---|
| A1 cursor range while holding still (`hold_still` from 7 s, `return_still` from 2 s) | at most 10 x 10 px, no cut | 0.0 x 0.0 px | 0.0 x 0.0 px, 0 % CUTTING |
| A2 yaw sweep / pitch sweep coverage | yaw x 35 to 80 %, y at most 50 %; pitch y 15 to 40 %, x at most 10 %; boundary at most 5 % | 55.5 x 30.7 %, 2.7 x 26.3 %, 0 % | identical |
| A3 false CUTTING (yaw, pitch, roll, spin, both holds; sensitivity 0.3, 1.0, 2.0) | under 2 %, identical sequences | 0.00 % | 0.00 % everywhere, sequences identical (also in both fast steps) |
| A4 hard strokes that cut | at least 90 %, path share median 80 %, min 60 % | H 15/15 (95 / 86 %), V 6/6 (90 / 87 %) | H 15/15 (94.7 / 86.5 %), V 6/6 (89.8 / 87.0 %) |
| A5 idle centre, within 100 px / 20 px (corner, right edge, bottom, near) | 3.0 s / 3.6 s at most, one `auto` event | 2.50 / 2.35 / 1.84 / 1.33 s; 3.01 / 2.86 / 2.35 / 1.87 s | identical to the millisecond, one event each; `autoCenter` off: range 0.0 px |
| A5b centring while cutting or above 21 deg/s | 0 | 0 | 0 |
| A6 longest chord / gaps / dense path to chords / trail spacing / biggest step | 96 px / 0 / 12 px / 8.5 ms / 450 px | 61 / 55 px, 0, 6.6 / 2.9 px, -, 408 / 352 px | 61.5 / 55.0 px, 0, 6.60 / 2.92 px, 7.81 ms (also with extra 60 ms steps in the middle of strokes), 408 / 352 px |
| A7 head error at 60 fps | mean 20, p95 60 px | 13.1 / 45.5 px | 11.5 / 42.1 px (holding the last sample: 105 / 316 px) |
| A8 posture change 30 + 20 degrees | at most 250 px | 133 px | 133 px (-114, -69); the absolute model on the same input: far beyond 700 px |
| A9 cut onset | at most 35 ms, retroactive chord | 30 ms (31.25 max) | 31.25 ms (horizontal) and 30 ms (vertical) at most; every stroke has its chord from the sample before the first fast one, delivered with the ENTER sample |

The other tests: `pointer-curve.test.js` (A10: the value table through `pushImu` on six mounts, both sides, three sensitivities; directions; dead zone 4.9 and 5.5 deg/s; flipX), `angular-tracker.test.js` (A11: the state machine alone and through `pushImu`, 33, 66 and 250 Hz, gaps, discontinuities, cutMul, cap), `relative-path.test.js` (chords, trail ring, head, new fields) and `relative-pointer.test.js` (idle centre, ease, reanchor, holes, reset, tracking loss, the wizard in the relative model, a saved calibration, a 30 000-sample fuzz). The legacy suites (mapping, recentring, calibration, simulator integration, the px tracker) run with `createAbsolutePipeline` and are unchanged except for the new units and the ring size (contract-notes).

### 14.4 Differences from the prototype and small decisions

- Chords shorter than 1 px are merged into the next chord instead of being dropped (`pointer.minChordPx`): a cut run stays contiguous and its first chord starts exactly where the run began. The recording gives 595 chords in the horizontal step (the prototype counted 601 tiny ones).
- The first sample after `reset()`, `setCalibration()`, `startCalibration()`, `markDiscontinuity()`, a hole, a lost track and `reanchor()` is a discontinuity that moves nothing; `recenter()` eases and flags its samples.
- Interpolated trail samples are never stamped earlier than the last emitted sample (a synthetic tracking-lost sample carries the poll time), so `recent()` stays chronological.
- `vx` and `vy` of a `BladeSample` are real only in the relative model (0 for aim samples and for the absolute model).
- Not done, on purpose: no calibration persistence in Motion (it is a pure module; `getCalibration()` is JSON-safe and includes the online bias, `setCalibration()` makes the relative pointer work with no wizard), no roll compensation, no accelerometer gating, no change to the wizard.

## 15. Round F1: where the cursor goes during sustained swinging (fixer, 2026-09-30)

Verifier finding F1 (`docs/motion-verification-round-1.md` section 4): with the pointer of section 14, `fast_swings_h` replayed whole leaves the cursor on the bottom edge for 24.8 % of the samples and only 10 % of the CUTTING samples in the middle half of the screen height. This section is the measurement of why, done on the same recording (`recordings/imu-2026-09-30T18-42-24.jsonl`, one Joy-Con 2 Right, one person). All numbers: UNVERIFIED-ON-HARDWARE beyond this recording.

**Reproduced exactly** (`replay('fast_swings_h', { config: { pointer: { gravityVertical: false } } })` of `test-support/motion/real-recording.js`: the pipeline of before the fix): median y 987, CUTTING samples in y 270..810 = 10 %, bottom edge 24.8 %, lowest 180 px 67 %, unclamped net vertical path +4222 px and horizontal -811 px (the verifier's numbers to the pixel). `fast_swings_v` from its first calm moment (0.6 s; the step starts with the sword over the head at 74 degrees elevation, so a cursor centred on sample 0 means "over the head = centre"): median y 1017, 35 % in the middle half, net +2297 px.

**What the tip really does.** Integrating the gyro into a full orientation (quaternion, gravity from the first calm sample) and reading the tip direction in the world:

| | `fast_swings_h` | `fast_swings_v` |
|---|---|---|
| tip elevation | 10 to 35 degrees all the time (mean 24), one excursion to 87 at 12 s | rest 9 to 19, wind-up over the head to 60 to 78 (once 87), chop back down to 9 |
| tip azimuth | swings between about 0 and 165 degrees, 15 strokes, net +30 | wind-up circles the head (about +350 degrees per cycle), the chop comes down in front |
| wrist roll about the blade | +17 at one end of the stroke, -35 at the other, changing DURING the strokes | upright (about +10) at rest and in the chop, about 170 degrees (inverted) in the wind-up |
| integral of the local vertical tip rate `w . right` (what the pointer integrated) | **-357 degrees** | -100 degrees |
| integral of the elevation rate (rotation about the horizontal axis perpendicular to the blade) | **+12 degrees** (true change +1) | -92 degrees (true -59; the error is the passes near the zenith) |

The horizontal slashes are pure azimuth sweeps at almost constant elevation; the local frame sees them as diagonal because the sword is rolled, and since the roll differs between the forward and the return stroke the forward and return contributions to the local pitch do not cancel. That is cause 1 of contract 2.9 (roll coupling): 4222 px of the 4222 px.

**Second cause, found by taking the roll out.** Replacing only the vertical rate by the elevation rate and keeping the accelerating curve moved the cursor from the bottom edge to the top (median y 108, 21 % of the CUTTING samples in the middle half): the tip rises a few degrees during the fast part of a stroke (gain 14 px/deg) and falls back during the slow pause (gain 4 to 5), so the residue per stroke is always upward. In a prototype with the gravity-frame rate on both axes, a constant gain gives 96 % (5 px/deg), 89 % (9) and 58 % (14) of the CUTTING samples in the middle half. The gain must not depend on the speed for the vertical axis to be a function of where the blade points, and it cannot be 14 for the slow legs (owner remark 3: the slow gain is 5). The compromise in the contract: the curve up to 6 px/deg and flat above (about 75 deg/s and up), which leaves slow vertical aiming exactly as it was (pitch sweep 26.4 % of the height against 26.3 %).

**What was tried and did not work** (all on the recording): an axis lock above 300 deg/s (the verifier's what-if, median y unchanged); a y-only spring to the centre whenever the blade is not CUTTING, 0.5 / 1 / 2 / 4 per second (26 / 52 / 60 / 59 % in the middle half, and the pitch sweep's y range shrinks by 18 % at 1 per second); an x-and-y spring (squeezes the yaw sweep from 1066 px to 627 px at 4 per second); the full player-space decomposition with the gravity direction on both axes (the horizontal axis then integrates the azimuth of the circular wind-up: in `fast_swings_v` the cursor is on a side edge 47 to 52 % of the time; round 1 rejected the same model for its direction reversals at the pole, this is a second reason); a vertical displacement from the difference of the elevation between two samples instead of the gyro rate (exact over the interval, but half a sample late against the horizontal axis, which shears a fast diagonal; on the recording it was not better); a blend of the gravity and local vertical rates near the zenith (re-introduces the local drift in the chops); a flat vertical gain from the dead zone (96 % instead of 93 % in the middle half at the price of +17 to +37 % slow vertical sensitivity).

**The fix and what it gives** are in `docs/motion-contract.md` 2.9. On the recording: `fast_swings_h` 94 % of the CUTTING samples in the middle half, median y 681, net vertical path +92 px, bottom edge 0 %; `fast_swings_v` from 0.6 s 52 % (35 % before), median y 528, net -11 px, lowest 180 px 0 % (57 %). The vertical chops are shorter (387 to 431 px instead of 896 to 1074).

**Orientation filter under swinging (new measurements, needed because the vertical axis now uses the tilt).** Synthetic rigid-body slashes (150 degrees in 220 ms, peak 990 deg/s, lever arm 0 to 0.3 m, exact gravity, 33 Hz) after a calm start: the cursor height stays within 2 px over 10 cycles at every lever arm (the local axis: pinned at the bottom edge); the gravity correction is off during the strokes and the gyro integration at 33 Hz is accurate enough for the tilt. A START in the middle of a stroke initialises the tilt from a contaminated reading (up to 60 degrees wrong) and the tilt is still 30 to 40 degrees wrong after 4 s of continuous slashing (the trust is 0 in the strokes and low in the pauses): the cursor height then wanders over 280 to 640 px. Hence the `confirmed` gate and the faster correction while unconfirmed (contract 2.9). On the recording the tilt is confirmed 0.03 s into the slow steps, 0.7 s into `fast_swings_v` and 3.3 s into `fast_swings_h`.

**What it does not say.** Nothing about the feel. One person's slashes are pure azimuth sweeps at constant elevation; other people swing differently (more diagonal, a wrist flick, a two-handed grip) and the horizontal axis still has no gravity reference: fast strokes one way and slow returns the other would still walk the cursor sideways (the recording has only fast strokes both ways). The accelerometer sign convention (UOH-20) is assumed, as it already was for the wizard's frame.
