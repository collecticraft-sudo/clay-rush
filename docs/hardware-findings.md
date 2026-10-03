# Hardware findings: what the first real-hardware tests proved, and what they did not

Date: 2026-09-30. Device: one Joy-Con 2 **Right** (product id 0x2066). Host: the owner's Mac.

This file records facts from the owner's real runs, separately from the third-party documents that the rest of the project is built on. Its rule is the project's rule: **nothing is claimed that was not observed**. Anything that only the physical controller (or Chrome on the owner's Mac) can settle stays **UNVERIFIED-ON-HARDWARE**. Figures below are the owner's summaries of tool output; raw logs were not attached to this repository.

The two probes were **native CoreBluetooth programs, not Chrome and not this game**. They say a lot about the controller and nothing about Chrome's Web Bluetooth chooser. **The same day the game got a native Bluetooth bridge, a productised version of the probe that worked** (section 7); the bridge itself has not been run against the controller.

## 1. Test A: a CoreBluetooth scan (Joy-Con 2 R, in range, about 15 unrelated BLE devices nearby)

Observed:

- Manufacturer data starts `53 05 | 01 00 03 7e 05 66 20 ...`. That is company id 0x0553 (little endian), then data bytes idx 0 to 6 = `01 00 03 7e 05 66 20`, so idx 3-4 = `7e 05` (vendor id 0x057E) and idx 5-6 = `66 20` (product id 0x2066, Joy-Con 2 Right).
- Connectable adverts, RSSI -31 to -39 dBm.
- Two different adverts: at 8.2 s (before SYNC) the host-address bytes idx 10-15 were non-zero (a bonded console's address; the real value is deliberately not recorded here, examples use the made-up `aa bb cc dd ee ff`); at 19.0 s (after SYNC) the same six bytes were all zero.
- No local name and no service UUID in the advert.

## 2. Test B: a full native CoreBluetooth session (same Joy-Con 2 R), first attempt, no retry

Observed:

- Advert seen at 6.5 s: product id 0x2066, connectable, host-address bytes `00 00 00 00 00 00` (pairing mode), RSSI -40 dBm. At that moment even the `strict` filter would have matched.
- GATT connect about 0.6 s, service discovery about 0.8 s. Two services: `00C5AF5D-1964-4E30-8F51-1956F96BD280` (characteristics `...BD281` read, `...BD282` write, `...BD283` read) and `AB7DE9BE-89FE-49AD-828F-118F09DF7FD0` with exactly the 11 characteristics of `docs/joycon2-protocol.md` section 4 (input `...7fd2` read+notify, `D5A9E01E...` read+notify, `FA19B0FB...` write-no-response, `649D4AC9...F005` write-no-response, `65A724B3...` write-no-response, `4147423D...` write-no-response, `C765A961...` notify, `640CA58E...` notify, `D3BD69D2...` notify, `...7fde` read+notify, `...7fdf` write-no-response). The right-side UUIDs match the (R) variants of the document.
- Init worked exactly as documented: subscribe to `C765A961...` first, LED write (response `09 01 01 07 10 78 00 00`), feature SET with mask 0xB7 (response `0c 01 01 02 10 78 ...`), ENABLE with mask 0xB7 (response `0c 01 01 04 10 78 ...`), then subscribe to the input characteristic `...7fd2`. Mask 0xB7 was enough: no 0xFF fallback.
- Streaming: 485 input packets in 14.5 s, about 33.4 Hz (the low end of the documented 33-67 Hz range). Every packet was exactly 63 bytes; byte 0x29 was `01` (IMU marker) in the last packet. The first packet had all motion fields at zero (IMU not yet active), the second already carried data.
- Accelerometer scale: the last packet, at (nearly) rest, read (-0.211, -0.036, 1.003) g with raw/4096, so |a| = 1.026 g.
- No SMP pairing was needed, and the controller never appeared in macOS Bluetooth settings.

## 3. What is now verified (for this Joy-Con 2 Right, through native CoreBluetooth)

| Fact | Project item upgraded |
|---|---|
| Advertisement layout for the Right unit: company id 0x0553, constants at idx 0-2, vendor id at idx 3-4, product id 0x2066 at idx 5-6; no name, no service UUID | protocol 3.1 (Right); the layout half of UOH-1 |
| Host-address bytes idx 10-15 are all zero in an advert seen after SYNC and in the advert of Test B (pairing mode), and non-zero (a bonded host) in an advert seen before SYNC | protocol 3.1 idx 10-15 for the Right unit; the "zero address" half of UOH-12 |
| GATT table of the Right unit: the vendor service with the 11 documented characteristics, plus a second service `00C5AF5D-...` | protocol section 4 (Right variants) |
| The init sequence of protocol 5.4 with mask 0xB7 starts the IMU on the first attempt; command responses arrive; no SMP pairing; no 0xFF fallback needed | decision 4, D7 and the native part of UOH-3 |
| Notifications are 63 bytes, the IMU marker at 0x29 is `01`, the IMU is inactive in the very first packet and active in the second | decision 6, audit F5, the length half of UOH-3 |
| Connect about 0.6 s and discovery about 0.8 s natively | the native part of UOH-2 (Chrome's discovery is another matter) |
| Report rate about 33.4 Hz over 14.5 s | one native measurement for UOH-4 (Chrome's rate is not measured) |
| Accelerometer scale raw/4096 = g (|a| = 1.026 g near rest) | the accel half of decision 7 |

## 4. What was NOT proven (all still UNVERIFIED-ON-HARDWARE)

- **Anything about Chrome.** The owner reported that Chrome's Bluetooth chooser listed **no device** while the game used the old default filter (`strict`). The cause is unknown. Candidates: Chrome is not allowed in macOS System Settings, Privacy & Security, Bluetooth; the chooser's scan window or timing; how Chrome matches the `manufacturerData` filter against CoreBluetooth's advert; Chrome seeing the bonded-host advert (Test A) instead of the zero-address one. Test B saw the zero-address advert within 6.5 s, so the theory "the strict filter misses the bonded-host advert" is **only a possible cause, not the confirmed one**.
- **What each filter lists in Chrome** (`lenient`, `strict`, `all`), and the name Chrome shows for the controller in the chooser (the advert has no local name, so whether Chrome shows any name at all is unknown).
- **GATT through Chrome**: `gatt.connect()`, discovery, `getPrimaryService`, the notification subscriptions, and whether Chrome's timings match the native ones.
- **The game's own behaviour** on the real controller: the 4.5 s watchdog, the keep-alive (macOS drop after 10-17 s without host writes, UOH-5; Test B streamed only 14.5 s and this note does not say how the link ended), the auto-reconnect, the cooldown (UOH-11), vibration (UOH-13), buttons (UOH-10).
- **The gyroscope**: the scale (0.0610 vs 0.0075 dps/LSB, UOH-6) and the sign (UOH-7). The last packet of Test B was taken while the controller was being moved (raw gyro -578, -696, 852), so it says nothing about either.
- **The accelerometer sign convention** (UOH-20): the +1.003 g on Z was measured in an unstated pose.
- **The Left Joy-Con** (product id 0x2067): its advert, its GATT table and its axes are still only documented.
- **Timestamp semantics** (UOH-8), pairing-window length (UOH-12), what state the controller returns to after a page reload (UOH-14), the battery mapping (UOH-17).

## 5. What the game does about it (code changes of the same day)

- **The default chooser filter is now `lenient`** (product id only, plus the company 0x057E entry), not `strict`. It ignores idx 10-15, so it matches the adverts of both Test A and Test B. `?filter=strict` and `?filter=all`, and the diagnostics page, still select the others. Nothing here shows that `lenient` makes Chrome list the controller: UNVERIFIED-ON-HARDWARE (UOH-1).
- **Connect screen fallback.** After Chrome's chooser is closed without a choice (code `cancelled`, which counts no failure and starts no cooldown) the screen shows a short hint and a button "Can't see it? Extended search". The click calls `requestDevice` with `acceptAllDevices: true` and `optionalServices` (it must be a click: Web Bluetooth needs the user gesture, so nothing retries by itself). A wrong pick in that list ends as `not_joycon` and does cost the 10 s cooldown.
- **The filter that worked is remembered**: after an attempt reaches `streaming`, the game keeps its filter in memory for the page and in localStorage (`joyconNinja.ble.v1`) and uses it the next time. Order: button, then `?filter=`, then the remembered filter, then the default.
- The fake Bluetooth stack has a chooser mode `empty-unless-all` that reproduces the **symptom** (filters list nothing, `acceptAllDevices` lists the controller); the tests prove the wiring, not Chrome.
- **The native Bluetooth bridge** (section 7): the primary way to connect since the end of the same day.

## 6. Next checks, in order (each one narrows the unknown cause)

1. **macOS permission.** System Settings, Privacy & Security, Bluetooth: is Google Chrome switched on? (UOH-16; the protocol document expects a prompt on the first `requestDevice`.)
2. **Does Chrome see the advert at all?** Open `chrome://bluetooth-internals`, Devices tab, start a scan with the Joy-Con in SYNC mode. Note whether the controller appears, how it is named, and its manufacturer data (company 0x0553 and the bytes of idx 0-15). This separates "Chrome cannot see it" from "the filter did not match".
3. **The game with the new default** (`lenient`), SYNC held, a click within a few seconds. Note the result. If the list is empty, close it and press "Can't see it? Extended search"; note how the Joy-Con is named in the extended list and whether it connects.
4. **The diagnostics page**, filters in order `lenient`, `strict`, `all`: write down the first one that lists the controller, how long after SYNC, and whether the lights were still sweeping.
5. **If Chrome connects:** compare its connect and discovery times and its packet rate with the native 0.6 s, 0.8 s and 33.4 Hz; run the hands-off 60 s check (UOH-5); use the one-revolution tool (UOH-6) and the rest check with the buttons up (UOH-20).
6. **If Chrome never lists the controller with `all` either:** use the native bridge (section 7), which does not need Chrome's chooser; Test B shows that a native helper can do the whole flow. Note what Chrome did and report it: it is useful to know why the chooser was empty.
7. Repeat with the Joy-Con 2 **Left** if the owner has one.

## 7. Evidence of 2026-09-30, later the same day: the native bridge

**What was built.** `bridge/joycon-bridge.m` (an Objective-C CoreBluetooth helper compiled with `clang`), `bridge/manager.js` and the `/__bridge/` endpoints of `server.js`, the native provider (`public/js/input/native-provider.js`), the connect screen with a primary button "Connect Joy-Con (native bridge)", a progress line per helper phase, a 45 s countdown, a cancel button and an English text for every error, and a native mode of the diagnostics page. Design and protocol: `docs/native-bridge.md`.

**What was proved, and how.**

- Software chain, with a **fake helper** (`test-support/bridge/fake-helper.mjs`) that speaks the helper's JSON-lines protocol, replays the two real captures of the probe (`REAL_R_1`, `REAL_R_2`) and then plays a virtual sword through the real packet builder: the provider, the server, the manager, the security rules, the connect screen in a real headless Chrome (every progress line in order, the countdown, cancel, the error texts, the calibration wizard with the virtual sword, a Zen round in which the cursor follows the synthetic motion and a swing cuts a fruit, a crash of the bridge in the middle of a game with a working reconnect, the diagnostics page in native mode). These tests prove the wiring against the protocol document and the probe's captures.
- The real helper compiles without warnings and passes its own `--selftest`, which covers the pure parts (command frames byte for byte, advert parsing, the choice among adverts including the 2026-09-30 preference, JSON lines). It never creates a `CBCentralManager` in `--version` and `--selftest`.

**What was NOT proved (all UNVERIFIED-ON-HARDWARE, UOH-21 to UOH-33).** Nobody ran the real helper against Bluetooth: macOS stops a process that uses Bluetooth without the permission of an app with a usage description (exit code 134), so automated sessions never send it `connect`. So it is open whether Terminal's permission reaches the helper (UOH-21), whether the 1.5 s collection window and the pairing preference choose the owner's controller (UOH-23, UOH-24), whether the 1 Hz keep-alive keeps the link for minutes (UOH-25), how the controller behaves after a disconnect (UOH-28), the Left unit (UOH-30) and everything else in `docs/native-bridge.md` section 11.

**One number worth acting on.** Both real captures report a battery of **3435 mV**. The game's bands (ok from 3550 mV, low from 3300 mV) call that "low", and the screen says "Battery: low". That is consistent with the documented bands, so they are unchanged; the owner should **charge the Joy-Con before a sword session**, because a low charge can also make the link unstable (an assumption, UNVERIFIED-ON-HARDWARE, UOH-17, UOH-33).

## 8. Evidence of 2026-09-30, evening: the first real IMU recording (sword tuning round)

**What was done.** The owner handled the Joy-Con 2 Right through the native bridge while `tools/record-imu.mjs` wrote every report, byte for byte, to `recordings/imu-2026-09-30T18-42-24.jsonl` (nine hand-timed steps, 4744 reports). The full analysis, every table and the reasoning are in **`docs/motion-findings.md`**; the contract derived from it is `docs/motion-contract.md`. This section only lists what the recording settled about the hardware, and what it did not, in the style of the sections above.

**Verified for this unit, by this one recording (hand-timed, no reference instrument).**

| Fact | Project item upgraded |
|---|---|
| The IMU report rate through the native bridge is a steady 33 Hz (median device step 30 ms, worst gap about 60 ms: one lost packet in the whole file); timestamps in microseconds | UOH-4, UOH-8, UOH-26, UOH-27 (native path, over 142 s) |
| The nominal gyro scale 0.06104 dps per LSB is right within the accuracy of a hand-timed test: four table turns integrated to 1435 degrees over the middle 15.2 s, about 3.99 turns | UOH-6, D1 (the finer 0.0075 scale is not what this unit does), F4 |
| Gyro bias and noise are small and steady: rest bias (0, -0.31, +0.73) deg/s (raw 0, -5, +12), median noise 0.12 deg/s, integrated drift 0.02 to 0.19 degrees in 8 s | HW-3 (drift), the online bias estimator |
| Gyro axes: pitch (tip up and down) is mostly gyro x, roll about the long axis mostly gyro y, yaw (also spinning flat on a table) mostly gyro z | HW-11 (Right unit), the mount convention of the calibration wizard |
| A hand that tries to hold still: median angular speed 1.7 to 3.1 deg/s, p90 4.7 to 12.6, p99 22 to 47 (tremor and slow wander) | the 5 deg/s dead zone |
| Intentional slow aiming: yaw sweep median 50.7 deg/s, p90 164, p99 260 (max 326); pitch sweep median 41.6, p90 66, p99 87 | HW-9 (what a cut threshold must stay above) |
| The owner's fast slashes: horizontal peaks median 831 deg/s (max 1049), vertical swings were gentler (median peak 184 deg/s by the analysis tool; the 6 hard vertical strokes of the contract, with at least 2 g at the peak, run 632 to 962 deg/s; the 15 horizontal ones 694 to 1049); accelerometer magnitude in swings up to 5.75 g (horizontal) and 6.45 g (vertical) | HW-9, HW-10 (no gyro saturation: 1049 deg/s is far from 2000) |
| The game's first defaults were wrong for this hand: 1000 px/s at 27.4 px/deg is 36 deg/s, so ordinary aiming cut everything, and 27.4 px/deg spans the screen in 70 degrees, so a normal change of arm posture pinned the cursor at an edge | the owner's feedback of the same day; the contract D1 to D7 |
| **A button press during a swing.** The R shoulder button registered for one report in the middle of a 1009 deg/s stroke (fast_swings_h, 13.7 s) and for six reports in the roll test. The R button is mapped to "recenter", and a recenter in the middle of a stroke breaks the cut | HW-6, UOH-10 (the grip reaches R); `app.js` now ignores a recenter press while the blade moves (docs/contract-notes.md) |

**What was NOT settled (still UNVERIFIED-ON-HARDWARE).** Chrome's Web Bluetooth rate and jitter; the Left unit; whether the new pointer and the cut threshold FEEL right (every number is derived from one recording of one person; tense play, other people, a child, a heavy sword); the accelerometer sign (the recording was taken in unstated poses); whether the recording was taken with the Joy-Con strapped to the sword; the physical gyro full-scale range beyond 1049 deg/s.

**Where the new behaviour is tested against this recording.** `test/motion/real-replay.test.js` (the pipeline alone, metrics A1 to A9), `test/app/real-replay-app.test.js` (the same metrics through the BLE provider, the parser, `app.js`, the game and the UI), `test/e2e/real-replay.test.js` (played into a real browser with the art on), and the table printed by `node tools/replay-integrated.mjs`. The hardware checklist section of `docs/GUIDE.md` has a 5-minute check for the owner to repeat the same three observations (holding still, slow aiming, slashing) on the real sword.
