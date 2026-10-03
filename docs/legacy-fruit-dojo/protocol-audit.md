# Joy-Con 2 protocol audit (independent, adversarial)

Auditor role: protocol auditor. Audit date: 2026-09-30. Language: English (owner request).
Scope: `public/js/input/` (UUIDs, scan filter, init bytes and order, packet offsets, buttons, side detection, timing) and the unit conversions in `public/js/motion/` (accel and gyro scales, sign handling, calibration).

> **HONESTY NOTICE.** Nobody on the team touched a physical Joy-Con 2, and neither did I. Everything below is derived from third-party source code and documents, from reading the Web Bluetooth specification and Chromium source, and from byte-level checks of the implementation against real packets that third parties published. Anything that only the physical device can confirm is labelled **UNVERIFIED-ON-HARDWARE** (UOH). I did **not** use `docs/joycon2-protocol.md` as evidence: I re-derived every row from primary sources and then compared. Where I found the protocol document wrong or over-confident, it is listed in section 4.

> **Dated note 2026-09-30 (added after the audit, not by the auditor).** The owner has since run two native CoreBluetooth probes against a Joy-Con 2 Right. They settle some rows below for that unit, through CoreBluetooth and not through Chrome, and leave the rest open. The summary is section 8; the facts and the open questions are in `docs/hardware-findings.md`. The audit text above and in sections 1 to 7 is unchanged.

## 1. Verdict

| Question | Answer |
|---|---|
| Is there a mismatch that would certainly stop the device working? | **No CRITICAL mismatch found.** Every UUID, every command byte, every packet offset, every scale factor and every button bit that the code uses matches the sources (details in section 5). |
| Is there something that plausibly stops it working on the first try? | **Yes, 3 MAJOR risks** (F1, F2, F3 below). None is a wrong byte; they are choices where the evidence for the chosen default is weaker than for the alternative, plus one hard dependency on an unverified assumption. All three can be settled in 2 minutes on the diagnostics page by the owner. |
| Independent checks that passed | Real captures V1 (Left) and V2 (Right), re-fetched from the third-party READMEs and decoded with the project parser: all fields as published, `\|a\|` = 1.0014 g and 1.0062 g. All six command frames byte-equal to bytes copied from third-party source. All five characteristic UUIDs string-equal to `joycon2cpp` constants. `node --test "test/input/*.test.js" "test/motion/*.test.js"`: 307 tests pass. |

## 2. Findings, most severe first

None of these is CRITICAL. Severity scale: CRITICAL = certain dead device; MAJOR = plausible failure or silent wrong behaviour on real hardware; MINOR = polish or robustness.

### F1 (MAJOR) The default feature mask 0x37 has no hardware evidence on the plain command characteristic

- Code: `INPUT_CONFIG.featureMask = 0x37`, sent as `0C 91 01 02 00 04 00 00 37 00 00 00` then `0C 91 01 04 ...` to characteristic `649d4ac9-...f005` (`ble-transport.js`, `configure()`). `fallbackMask = 0xFF` after 4.5 s.
- What the sources really show:
  - 0x37 appears in `joycon2cpp` only inside `SendJoyCon2OfficialInit`, which is written to the **`rumbleChar`** (handle 0x0016, "Vibration + Command", UUID `ce49a830-...` for Left and `65a724b3-...` for Right) with a **17-byte zero prefix**, after a 15-command console-style sequence. Its helper `SendCustomCommands`, the only code that writes 0x37 to the plain command characteristic, is **defined and never called** (`testapp.cpp` lines 471-490; a search for call sites finds none). ndeadly's console trace shows the same 0x37 on the 0x0016 handle.
  - Masks proven to give IMU data on `649d4ac9-...` by working projects: `0xFF` (mascii on Chrome Web Bluetooth, seitanmen on macOS, yujimny, JoeGeC on Android) and `0xB7` (switch2mac on macOS, "practical masks: 0xB7 on Joy-Cons").
  - 0x37 is a strict subset of 0xB7 (only the magnetometer bit 0x80 differs) and contains the IMU bit 0x04 that all sources document. So it will very probably work, but **no source demonstrates it on this channel**. The claim in `docs/joycon2-protocol.md` 5.3 that 0x37 is confirmed by `joycon2cpp` "IMU works there" is not supported by the code path I read (section 4, item P1).
- Why it matters: if 0x37 does not start the IMU, the first 4.5 s of every connect are lost, and the fallback then uses 0xFF, which switch2mac's own notes say "induces phantom ZL/ZR bits on Joy-Cons". A phantom ZL or ZR maps to RECENTER (`actions.js`, RECENTER = R/ZR/SR_R/SL_R on the Right unit and L/ZL/SR_L/SL_L on the Left unit). The `initial` baseline only protects against bits that are already set in the first report, so a phantom bit that appears after the mask change fires one spurious re-centre, and a flickering one fires repeated re-centres.
- Recommendation (does not change any documented byte): default `featureMask` to `0xB7` (hardware-tested on macOS, no phantom bits), use `0xFF` only as the last resort, and add `0xB7` to the mask selector of `diagnostics.html` (today it offers only 0x37 and 0xFF). Keep 0x37 as an expert option. Until changed, the owner's diagnostics step 1 will show which mask worked: UOH-3.
- Confidence in the finding: high (I read the source, not a summary). Whether 0x37 works: UNVERIFIED-ON-HARDWARE.

### F2 (MAJOR) The game cannot use any scan or mask fallback; only the diagnostics page can

- Code: the game calls `provider.connect()` with no options (`app.js` `connectProvider`), so it always uses the strict filter (16-byte prefix, address bytes 10-15 must be zero) and mask 0x37. The alternatives (`lenient`, `all`, other masks, side) exist only as controls on `diagnostics.html`, and a `BluetoothDevice` chosen there is lost when the page is left (Web Bluetooth has no persistent grant without an experimental flag).
- Why it matters: the strict filter depends on two facts that I could only confirm from documents: (1) macOS delivers the manufacturer data in the scan record that Chrome sees (Chromium's `bluetooth_low_energy_adapter_apple.mm` does parse it, first two bytes little-endian company id, remainder as data; but mlstr0m's macOS bridge warns "Some macOS BLE stacks expose name without manufacturer data"), and (2) a pairing-mode advert has six zero bytes at data indexes 10-15 (JoeGeC measured it on real units; ndeadly only labels those bytes "state fields"). If either is wrong on the owner's Mac, Chrome's list is empty in the game and there is no way to recover inside the game. The setup guide tells the owner to try the diagnostics page with "product id only" or "all devices", but that only proves the controller can be seen, it does not let the game use it.
- Recommendation: let the game read `?filter=strict|lenient|all` and `?mask=` URL flags (or persist the diagnostics choice in `localStorage`, key next to `joyconNinja.imu.v1`), and mention them in the guide. No protocol byte changes.
- Confidence: high that the limitation exists (code); the probability that strict fails is unknown: UNVERIFIED-ON-HARDWARE (UOH-1, UOH-12).

### F3 (MAJOR, cannot be settled by software) The orientation pipeline assumes the accelerometer reads +1 g toward "up"

- Code: `fusion.js` ("The accelerometer reads +1 g pointing UP at rest") and `calibration.js` `frameFromPoses` (`forward = normalize(u1 ...)` where `u1` is the mean accelerometer direction while the sword is held tip up).
- Evidence: both real captures show about +1 g on raw +Z (Left `-66, 437, 4078`, Right `-1311, 1250, 3702`), and JoeGeC's measured note says +Z is "out of the button face". That is the standard "specific force" convention only **if** both units were lying face up, and neither source states the pose. Nothing else in the sources settles it (JoeGeC's "at rest gravity reads -1.00 g" is measured after his own axis remap).
- Why software cannot detect it: the gyro sign self-test uses `u2 x u1`, which is identical under a global sign flip of the accelerometer, so the wizard would pass, but `forward` would point at the hilt and up/down and left/right on screen would be mirrored. Only `flipX` exists as a user fix.
- Recommendation: add one line to diagnostics checklist step 3: "Lay the Joy-Con flat on the desk, buttons up: raw accel Z must read about +4096 (+1 g)". If it reads -4096 the pipeline needs an `accelSign` parameter. The simulator cannot test this (it models the same convention, so it is circular).
- Status: UNVERIFIED-ON-HARDWARE (new item, proposed UOH-20; related to UOH-7).

### F4 (MINOR, documented) Gyro scale is genuinely disputed (8.14x)

- Sources for 0.06103515625 dps/LSB (2000 dps full scale): ndeadly `hid_reports.md`, JoeGeC `MotionConverter.kt` (`GYRO_DPS_PER_LSB = 0.06103515625f`), SDL (`34.8` rad/s full scale, i.e. 1994 dps, USB path only).
- Sources for 0.0075 dps/LSB ("48000 = 360 deg/s"): `joycon2cpp` README (credited to @german77), `JoyCon2Mac` `JoyConDecoder.cpp` (`360.0f / 48000.0f`), `joycon2android` protocol table.
- I could not resolve this from sources; my extra web search found nothing that measures it. Weak physical hint for 0.061: the real captures rest at gyro raw 2..19 LSB (up to 1.2 dps at 0.061, 0.14 dps at 0.0075), and typical MEMS zero-rate offsets are around 1 dps, which fits 0.061 better. That is inference, not proof.
- Code: default 2000/32768 in `joycon2-parse.js`; `motion-config.js` `scaleCandidates: [1, 0.12288]`. I verified 0.12288 = 0.0075 / 0.06103515625 exactly; the diagnostics `altTurnDeg: 2930` = 360 x 8.138 is correct. Both the one-revolution tool and the calibration wizard can select either scale. Consequences worth knowing: if the true scale is 0.0075, the int16 range covers only about +-245 dps, so fast sword swings will **clip in the sensor** and the blade will under-rotate on the fastest cuts; software cannot fix that (UOH-6).
- Status: handled correctly by design; the value itself is UNVERIFIED-ON-HARDWARE (UOH-6).

### F5 (MINOR) Parser does not check the report marker

- `imuMarker` (byte 0x29, always `01` in both real captures and used by `joycon2cpp` `JoyConDecoder` to validate the layout) is parsed but never used to accept or reject a report. `imuActive` only tests whether the 12 IMU bytes are non-zero. A different report type on the same characteristic would be read as garbage IMU data. Risk is low (the input characteristic carries only report 0x05 in every source). Suggest a diagnostics warning when `imuMarker !== 1`.

### F6 (MINOR) Vibration frame is not used by any hardware-tested project on the plain channel

- `VIBRATE(id)` = `0A 91 01 02 00 04 00 00 II 00 00 00` matches ndeadly `commands.md` and the `joycon2cpp` console init byte for byte, and it is only ever sent through the whitelisted command characteristic. Its effect on a real Joy-Con 2 over this channel is UNVERIFIED-ON-HARDWARE (UOH-13). It is rate limited and errors are swallowed, so it cannot kill the stream in code. Keep it off by default until the owner tests it.

## 3. Method and limits of this audit

- Sources read (tag, what, URL). Items marked (raw) I downloaded verbatim and searched with grep; items marked (summary) were read through a summarising fetch tool, so I only relied on them where at least one other source agrees.

| Tag | Source | URL |
|---|---|---|
| S1 | ndeadly, HID reports (raw) | https://github.com/ndeadly/switch2_controller_research/blob/master/hid_reports.md |
| S2 | ndeadly, commands (summary) | https://github.com/ndeadly/switch2_controller_research/blob/master/commands.md |
| S3 | ndeadly, Bluetooth interface (summary) | https://github.com/ndeadly/switch2_controller_research/blob/master/bluetooth_interface.md |
| S4 | mascii, Web Bluetooth demo (raw) | https://github.com/mascii/joy-con-2-web-bluetooth-api-demo/blob/main/src/App.vue |
| S5 | seitanmen, Joycon2forMac (raw README, summary of .mm) | https://github.com/seitanmen/Joycon2forMac |
| S6 | TheFrano, joycon2cpp (raw testapp.cpp and README, summary of JoyConDecoder.cpp) | https://github.com/TheFrano/joycon2cpp |
| S7 | OZORDI, JoyCon2Mac (summary) | https://github.com/OZORDI/JoyCon2Mac |
| S8 | Peterksharma, switch2mac (raw PROTOCOL.md, summary of Swift files) | https://github.com/Peterksharma/switch2mac/blob/main/research/PROTOCOL.md |
| S9 | JoeGeC, joycon2android (summary) | https://github.com/JoeGeC/joycon2android/blob/main/docs/protocol.md , `docs/dsu-motion.md` , `feature/dsu/domain/src/main/kotlin/com/joegec/joycon2android/dsu/motion/MotionConverter.kt` , `tools/README.md` |
| S10 | SDL3 Switch 2 driver (summary) | https://github.com/libsdl-org/SDL/blob/main/src/joystick/hidapi/SDL_hidapi_switch2.c |
| S11 | yujimny, Joycon2test (summary) | https://github.com/yujimny/Joycon2test/blob/main/joycon2_ble_client.py |
| S12 | loyahdev, joycon2mac (summary, buttons only) | https://github.com/loyahdev/joycon2mac/blob/main/joycon.py |
| S13 | Nadeflore, switch2-controllers (summary) | https://github.com/Nadeflore/switch2-controllers/blob/main/controller.py |
| S14 | mlstr0m, switch2bridge-macos (summary) | https://github.com/mlstr0m/switch2bridge-macos/blob/main/Switch2Bridge.py |
| S15 | Web Bluetooth specification source (raw) | https://github.com/WebBluetoothCG/web-bluetooth/blob/main/index.bs |
| S16 | Chromium: chooser matcher and macOS advert parsing (raw) | https://github.com/chromium/chromium/blob/main/content/browser/bluetooth/bluetooth_device_chooser_controller.cc , https://github.com/chromium/chromium/blob/main/device/bluetooth/bluetooth_low_energy_adapter_apple.mm |
| S17 | Web Bluetooth GATT blocklist (raw) | https://github.com/WebBluetoothCG/registries/blob/master/gatt_blocklist.txt |

- Independent checks I ran (scripts kept in the scratchpad, not in the project):
  1. Downloaded the raw real packet from the `joycon2cpp` README (V1, Left) and from the `seitanmen` README (V2, Right, printed there as unpadded hex tokens), rebuilt the 63 bytes, and ran the project's `parseInputReport`. Results match what those projects print (V2: packet id 9295, right stick 2060/1938, accel -1311/1250/3702, gyro 7/-1/19). `|a|` at offset 0x30 = 1.001 g and 1.006 g; at offsets 0x2C and 0x2E it is 0.08-0.44 g, so the accelerometer really starts at 0x30. The V2 hex in `docs/joycon2-test-vectors.json` is byte-identical to the README.
  2. Built the six command frames with the project builders and compared them with hex copied from third-party code (table in section 5.3): all equal.
  3. Extracted the five characteristic UUID constants from `joycon2cpp` `testapp.cpp` and compared with `INPUT_CONFIG`: all equal (the service UUID and the fd2 characteristic are also literal in the mascii source).
  4. Printed the actual `requestDevice` options for Left and Right and checked them against the Web Bluetooth canonicalisation rules (section 5.6).
  5. Re-derived the button table from four independent bit tables (S1, S5 via S9's u32 bitmaps, S6 masks, S8 masks), converted every u32 mask to (byte, bit), and compared with `BUTTON_TABLE` (section 5.4).
  6. Re-derived the sign of the gravity-rotation gyro test (section 5.7) on paper.
  7. Ran the project's input and motion test suites: 307 pass, 0 fail (they test the code against the protocol document, so they cannot catch a protocol-document error; that is what this audit is for).
- Not accessed: the ndeadly `.pcapng` captures, the Switch2Connect source, the Chromium `MatchesBluetoothDataFilter` body (only its call site and the comment "Check data filter size is less than device manufacturer data size" were visible; the length rule is also in the specification text), any real device.
- Fetch summarisation caveat: several rows rest on summaries. The critical ones (UUIDs, init bytes, request options, offsets, buttons) each have at least one raw source or two agreeing summaries; the table's confidence column says which.

## 4. Where `docs/joycon2-protocol.md` is wrong, over-confident or unsupported

| ID | Claim in the protocol document | What I found | Effect |
|---|---|---|---|
| P1 | 5.3 and decision 4: mask 0x37 is used by `joycon2cpp` "IMU works there", so it is safe as the default | `joycon2cpp` sends 0x37 through the 0x0016 vibration+command characteristic with a 17-byte zero prefix after a long console-style init; its plain-channel 0x37 helper is never called | F1. Default mask is under-evidenced; fallback hits the phantom-bit mask |
| P2 | 3.3 and section 8: the strict filter "hides wake adverts", presented as normative | Only JoeGeC measured the zero address in pairing adverts; ndeadly does not label bytes 10-15 as an address; macOS may omit manufacturer data in some scans (S14) | F2. Needs a game-side fallback, not only a diagnostics one |
| P3 | 7.4 line "Both real stationary captures show +1 g mostly on raw Z ... suggests Z is the face-normal axis" | True as observation; the pose is not documented by either source, so it cannot support the "+1 g toward up" convention that the pipeline hard-codes | F3 |
| P4 | 6.2: "Five independent implementations agree" on buttons | Correct for the bit table (I re-derived it), but `joycon2cpp` labels B and X the other way round (its masks: B 0x000200, X 0x000400). The project follows the majority; harmless because B is only BACK and X only a CONFIRM alias | none |
| P5 | Table row "Timestamp `[ND-HID]` microseconds, M" | Consistent with both captures (IMU clock 22.2 s and 6.3 s as microseconds, counter behaves like a millisecond clock started 3-4 s earlier) but only two data points; SDL says "sometimes something else". The runtime ratio check (0.8..1.25) is the right mitigation | none; keep UOH-8 |

## 5. Audit table

Legend. Result: MATCH = code equals what the sources say; MATCH (partial) = matches but with the caveat in the row; RISK = matches the sources but the choice is weakly supported; ASSUMED = depends on something no source settles. Confidence is about the third-party evidence, not about our hardware: H = two or more independent sources (or raw source) agree, M = one hardware-tested source or agreeing derivatives, L = single or disputed. **Every row is UNVERIFIED-ON-HARDWARE** in the sense that nobody here touched a device; the extra tag in the last column marks rows whose UOH id is in the protocol document section 12.

### 5.1 Discovery (scan filter)

| Item | Spec value (my re-derivation) | Code value | Sources | Result | Confidence | UOH id |
|---|---|---|---|---|---|---|
| Company identifier | 0x0553 (Nintendo BT SIG id), Chrome passes it as the map key, data is the bytes AFTER the 2-byte id (little-endian id) | `companyId: 0x0553` (1363) | S3, S4, S5, S6 (1363), S16 (`U16FromLittleEndian(span.first<2>())`, data = `subspan(2)`) | MATCH | H | UOH-1 |
| Alternative company id 0x057E | Only claim is S14 (Pro Controller, "both observed in the wild") | Second filter entry only in `lenient` | S14 | MATCH (partial): harmless extra, never in `strict` | L | UOH-1 |
| Left product id | 0x2067, bytes `67 20` at data idx 5-6 | `pid.L: 0x2067`, `dataPrefix[5]=0x67, [6]=0x20` | S4, S8, S9, S11 | MATCH | H | UOH-1 |
| Right product id | 0x2066, bytes `66 20` | `pid.R: 0x2066` | S4, S8, S9, S11 | MATCH | H | UOH-1 |
| Data index of the PID | idx 5-6 after the company id (mascii prefix `00 00 00 00 00 PID`) | idx 5 and 6, mask `FF FF` there | S4 (raw), S6 (`d[3]=7E, d[4]=05`, PID next), S9 ("bytes [5..6]"), S11 ("index 5") | MATCH | H | UOH-1 |
| Mask semantics | Prefix match: `(data[i] & mask[i]) == (prefix[i] & mask[i])`, data must be at least as long as the prefix; `dataPrefix` and `mask` must have equal, non-zero length | 16-byte prefix and 16-byte mask; real adverts carry 24 data bytes (S3 table: 26 bytes with company id) so length is satisfied | S15 (matches + canonicalising rules), S16 (size comment) | MATCH | H | UOH-1 |
| Pairing-mode selector | Host address bytes at idx 10-15 are zero while SYNC is held | strict: mask `FF` at idx 10-15 with prefix 0 | S9 (bytes [10..15]), S8; S3 does not name the bytes | RISK (see F2): only one source measured zero | M | UOH-1, UOH-12 |
| Filter count and shape | One manufacturerData entry per filter object (a second entry with the same company id inside one filter throws TypeError) | 1 entry per filter; strict Left/Right = 2 filters, lenient = 4 | S15 (canonicalisation step) | MATCH | H | none |
| No name or service filter | Advert has only Flags + Manufacturer data; name unreliable | No `name`, `namePrefix`, `services` in any filter | S3, S9, S4 (mascii uses names only for Bluefy on iOS) | MATCH | H | UOH-1 |
| `optionalServices` | Must list the vendor service or `getPrimaryService` fails | `optionalServices: [service]` in strict, lenient and all | S15, S4 (raw) | MATCH | H | UOH-1 |
| `acceptAllDevices` fallback | Valid only without `filters`, with `optionalServices` | `{acceptAllDevices:true, optionalServices}` | S15 | MATCH | H | UOH-1 |
| User activation | `requestDevice` needs a user gesture | `connect()` calls `requestJoyCon` synchronously; `app.js` `connectProvider` is synchronous | S15, code | MATCH | H | none |
| Left vs Right before connect | PID in the advert; or the user's side button | `side` option selects the PID, default both | S4, S11 | MATCH | H | UOH-1 |

### 5.2 GATT (UUIDs and properties)

| Item | Spec value | Code value | Sources | Result | Confidence | UOH id |
|---|---|---|---|---|---|---|
| Vendor service | `ab7de9be-89fe-49ad-828f-118f09df7fd0` | same (`INPUT_CONFIG.service`) | S3, S4 (raw), S6 | MATCH | H | UOH-2 |
| Input characteristic (NOTIFY) | `ab7de9be-89fe-49ad-828f-118f09df7fd2` | same | S3, S4, S5, S6, S8, S11 | MATCH | H | UOH-3 |
| Command characteristic (WRITE_NO_RESPONSE) | `649d4ac9-8eb7-4e6c-af44-1ea54fe5f005` | same | S3, S4, S5, S6, S7, S8, S11 | MATCH | H | UOH-3 |
| Command response (NOTIFY) | `c765a961-d9d8-4d36-a20a-5315b111836a` | same | S3, S6, S7, S8 | MATCH | H | UOH-3 |
| Left-only vibration characteristic | `289326cb-a471-485d-a8f4-240c14f18241` | `vibrationLeft` same | S3, S6, S8, S13 | MATCH | H | UOH-1 |
| Right-only vibration characteristic | `fa19b0fb-cd1f-46a7-84a1-bbb09e00c149` | `vibrationRight` same | S3, S6, S8, S13 | MATCH | H | UOH-1 |
| Forbidden: firmware update channel | `4147423d-fdae-4df7-a4f7-d23e5df59f8d` (WRITE_NO_RESPONSE "Output Report (Firmware Update)") | in `forbiddenCharacteristics`, never written (only `cmdChar` is ever written) | S3 | MATCH | H | none |
| Forbidden: look-alike | `ab7de9be-...7fdf` (WRITE_NO_RESPONSE, unknown) | in `forbiddenCharacteristics` | S3 (table), protocol doc cites S9 for "subscription that never delivers data" (not re-verified by me) | MATCH | M | none |
| Blocklist | No Nintendo UUID is blocklisted; 0x2902 is write-excluded (irrelevant, `startNotifications` writes the CCC) | none used | S17 (raw, read in full) | MATCH | H | none |
| Empty Generic Attribute service | Exists (handles 0x0030); some stacks stall on empty services | Discovery uses `getPrimaryService(service)` + `getCharacteristics()` with a 15 s timeout | S3 | MATCH (partial): timeout covers it | M | UOH-2 |
| Write type | WRITE_WITHOUT_RESPONSE for all command writes | `writeValueWithoutResponse` when available, else `writeValue` | S3, S4 (raw), S6, S8, S11 | MATCH | H | UOH-15 |

### 5.3 Initialisation (bytes and order)

| Item | Spec value | Code value | Sources | Result | Confidence | UOH id |
|---|---|---|---|---|---|---|
| Command header | 8 bytes: `cmd, 91, 01, sub, 00, len, 00, 00`, then data | `frame(cmd,sub,payload)` | S2 (raw header table), S8, S4 | MATCH | H | UOH-3 |
| LED player 1 | `09 91 01 07 00 08 00 00 01 00 00 00 00 00 00 00` (16 B) | `LED(1)` printed: `09910107000800000100000000000000` | S2, S4, S6 (init line), S10 | MATCH (byte-equal, script-checked) | H | UOH-3 |
| Feature SET | `0C 91 01 02 00 04 00 00 MM 00 00 00` | `FEATURE_SET(m)`; 0x37 -> `0c9101020004000037000000`, 0xFF -> `...ff000000` | S2, S4, S5, S6 | MATCH (byte-equal, script-checked) | H | UOH-3 |
| Feature ENABLE | `0C 91 01 04 00 04 00 00 MM 00 00 00` | `FEATURE_ENABLE(m)` | S2, S4, S5, S6 | MATCH (byte-equal, script-checked) | H | UOH-3 |
| Order | SET before ENABLE (all sources) | LED, SET, ENABLE, then subscribe input | S4, S5, S8, S11 | MATCH | H | UOH-3 |
| Feature bit meanings | 0x01 buttons, 0x02 sticks, 0x04 IMU, 0x10 mouse, 0x20 battery current, 0x80 magnetometer | mask 0x37 = 0x01+0x02+0x04+0x10+0x20 (IMU bit set) | S2, S8 | MATCH | H | UOH-3 |
| Default mask value | Hardware-proven on this channel: 0xFF (S4, S5, S11, S9), 0xB7 (S8). 0x37: console path only (see F1) | `featureMask: 0x37` | S6 (raw), S8, S4 | RISK (F1) | L for 0x37 on this channel | UOH-3 |
| Fallback mask | 0xFF works but "induces phantom ZL/ZR bits" | `fallbackMask: 0xFF`, stage 2 at 4.5 s | S8 (raw) | MATCH (partial): would be better 0xB7 then 0xFF | M | UOH-3, UOH-10 |
| Response subscription | Must precede commands on macOS native stack; optional on Chrome (mascii skips it) | Subscribed first, failure non-fatal | S8, S4 | MATCH | M | UOH-3 |
| Input subscription | Last step after enabling features | `startNotifications` on `...7fd2` after ENABLE | S4, S5, S8 | MATCH | H | UOH-3 |
| Inter-command timing | 500 ms (mascii, seitanmen, yujimny), 80-100 ms (joycon2cpp) | wait for matching response or 500 ms, writes >= 100 ms apart | S4, S5, S6, S11 | MATCH | H | UOH-15 |
| Response matching | Response echoes command id (byte 0) and subcommand (byte 3): `0c 01 01 02 10 78 00 00` | key `${bytes[0]}:${bytes[3]}` on both sides | S2 | MATCH | H | none |
| Keep-alive | Any host write every ~1 s (macOS drops the link about 10-17 s after the last host write, single source) | LED(1) re-sent every 1 s if idle for 900 ms | S8 (raw) | MATCH | M (single source) | UOH-5 |
| Vibration preset | `0A 91 01 02 00 04 00 00 II 00 00 00`, 3 = soft click | `VIBRATE(id)` printed for id 3: `0a9101020004000003000000` | S2, S6 | MATCH (byte-equal) | H (frame), L (effect) | UOH-13 |
| SMP pairing / bonding | Controller disconnects on SMP pairing; app-layer bonding (0x15) optional | Neither used | S3, S8 | MATCH | H | UOH-14 |
| Reconnect cooldown | Repeated connects make the controller unresponsive for minutes | one attempt per click, 10 s / 180 s cooldown, one silent retry | S6 README (raw), S7 (180 s), S9 | MATCH (policy, not a byte) | H (exists), L (duration) | UOH-11 |

### 5.4 Input report 0x05: layout, endianness, signedness

| Item | Spec value | Code value | Sources | Result | Confidence | UOH id |
|---|---|---|---|---|---|---|
| Length | 63 bytes (Peterksharma says 63-64); IMU ends at 0x3B | `MIN_LEN = 0x3C` (60), accepts longer | S1, S5, S8, real captures | MATCH | H | UOH-3 |
| Endianness | Little endian throughout | all `getInt16/Uint16/Uint32(..., true)` | S1, S5, S6, S8 | MATCH | H | none |
| Counter | u32 at 0x00, opaque; never used for dt | parsed as u32; only diagnostics use it | S1 ("increments by 1"), captures (behaves like a ms clock) | MATCH | M | UOH-8 |
| Buttons | u32 at 0x04 (S9/S5 read u32 at 0x03; same bits, byte 3 is the counter's top byte, always 0 in captures) | bytes 4..7 via table | S1 (raw), S5, S8, S9 | MATCH | H | UOH-10 |
| Left stick field | 3 bytes at 0x0A, X = v & 0xFFF, Y = v >> 12 | `stick12(0x0A)` | S1, S5, S6, S8 | MATCH | H | none (sticks unused) |
| Right stick field | 0x0D | `stick12(0x0D)` | same | MATCH | H | none |
| Which field a unit fills | Left unit -> 0x0A, Right unit -> 0x0D (S8 "verified in practice") | `side==='R' ? right : left` | S8, S6 | MATCH | M | none |
| Mouse sensor | 0x10..0x17 (u16 x, y, quality, lift) | offsets 0x10/0x12/0x14/0x16 as u16 | S1, S4 (16, 18) | MATCH | H | none |
| Magnetometer | 0x19 (S1, S8) vs 0x18 (S5, S11): disputed | 0x19 | S1, S8 vs S5, S11 | MATCH (game does not use it) | M | none |
| Battery voltage | u16 mV at 0x1F | `getUint16(0x1F)` | S1, S5, S6, S8 | MATCH | H | UOH-17 |
| Battery current | i16 at 0x22 (S1, S8) vs 0x28 (S5, S11) | 0x22 (informational) | S1, S8 | MATCH | L | none |
| Marker | 0x29 = 0x01 | parsed, not enforced (F5) | S1, S6 | MATCH (partial) | M | UOH-3 |
| IMU timestamp | u32 LE at 0x2A, microseconds ("some controllers don't seem to report this correctly") | `getUint32(0x2A)` | S1, S10 (`data[0x2b..0x2e]` in a buffer with a leading report-id byte) | MATCH | M | UOH-8 |
| Temperature | i16 at 0x2E, 25 + raw/127 | `25 + raw/127` | S1 (1/126.9), S5, S6, S8 | MATCH | H | UOH-17 |
| Accel X, Y, Z | int16 LE at 0x30, 0x32, 0x34 | same | S1, S5, S6, S8, S9, S13, real captures | MATCH (checked: `|a|` = 1.001 / 1.006 g only at 0x30) | H | UOH-3 |
| Gyro X, Y, Z | int16 LE at 0x36, 0x38, 0x3A | same | same | MATCH | H | UOH-3 |
| Signedness of IMU values | Signed 16-bit | `getInt16` | all | MATCH | H | none |
| Triggers | u8 at 0x3C, 0x3D, GameCube only | read only when present, else 0 | S1 | MATCH | H | none |
| Right Joy-Con buttons (byte 4) | ZR 0x80, R 0x40, SL 0x20, SR 0x10, A 0x08, B 0x04, X 0x02, Y 0x01 | `BUTTON_TABLE` rows byte 4 | S1 (raw), S8, S9 (u32 masks converted), S5 (masks) | MATCH; S6 has B/X swapped (outlier) | H | UOH-10 |
| Shared byte 5 | Capture 0x20, Home 0x10, LStick 0x08, RStick 0x04, Plus 0x02, Minus 0x01, C 0x40 | rows byte 5 | S1, S8, S9 | MATCH | H | UOH-10 |
| Left Joy-Con buttons (byte 6) | ZL 0x80, L 0x40, SL 0x20, SR 0x10, Left 0x08, Right 0x04, Up 0x02, Down 0x01 | rows byte 6 | S1, S8, S9, S6 (Left uses offset 4; masks D-pad 0x01..0x08, L 0x40) | MATCH | H | UOH-10 |
| Byte 7 | GL 0x02, GR 0x01; bits 0xE0 set in both real captures and undefined | table lists GR/GL only, so 0xE0 is ignored | S1, real captures | MATCH | H | UOH-10 |
| Which buttons exist per side | Right unit: A/B/X/Y, R/ZR, Plus, SL/SR (right), stick; Left unit: D-pad, L/ZL, Minus, Capture, SL/SR (left), stick | `BUTTON_ACTIONS` uses only buttons of the matching side (Left pause = MINUS/CAPTURE, Right = PLUS; HOME and stick clicks never mapped) | S1, S6, S9 | MATCH | H | UOH-10 |
| Left vs Right detection (after connect) | Presence of the side-specific vibration characteristic; name `(L)`/`(R)` is a weaker hint | `detectSide`: characteristic, then name, then hint | S3, S6 (characteristic matching), S5 and S7 (name) | MATCH | H (characteristics), M (name) | UOH-1 |

### 5.5 Motion units, timestamps and signs

| Item | Spec value | Code value | Sources | Result | Confidence | UOH id |
|---|---|---|---|---|---|---|
| Accel scale | 1 g = 4096 LSB (ndeadly 8/32767 g per LSB is the same to 0.003%) | `1/4096` exact | S1, S6, S7, S9, S10 (`8g/INT16_MAX`), captures (`|a|` about 1.00) | MATCH | H | UOH-3 |
| Gyro scale, default | 0.06103515625 dps/LSB (+-2000 dps) | `2000/32768` | S1, S9 (`MotionConverter.kt`), S10 (34.8 rad/s) | MATCH (disputed, F4) | M | UOH-6 |
| Gyro scale, alternative | 0.0075 dps/LSB ("48000 = 360 deg/s") | candidate `0.12288` relative factor, `altTurnDeg: 2930`, sim alt `0.0075` | S6, S7, S9 protocol table | MATCH (arithmetic verified) | L | UOH-6 |
| Scale selection | Not knowable from sources | One-revolution tool + calibration wizard select between the candidates (tolerance 12 %) | n/a | MATCH (design) | n/a | UOH-6 |
| Saturation limit | int16 full scale = about 2000 dps (default scale) or 245 dps (alt) | `saturation: gyroDps 1990` on default-scale dps = raw 32604 either way | derived | MATCH | M | UOH-6 |
| Axis order in the report | X, Y, Z consecutive for both sensors | parser returns raw order, "sensor frame", no remap | all sources | MATCH | H | UOH-7 |
| Axis directions and signs | Right unit measured: +X right, +Y toward the tail, +Z out of the button face; Left unit unverified; SDL remaps to its own frame; "signs are DS4 hardware history" | Not hard-coded: mounting-agnostic calibration finds forward/up from two gravity poses and the gyro sign from the gravity-rotation test | S9, S10 | MATCH (design) | M | UOH-7 |
| Gyro sign test math | A world-fixed vector in the body frame obeys `du/dt = -w x u`, so the body turned about `-(u0 x u1)` = `u1 x u0`; independent of the accelerometer sign | `nExp = normalize(cross(u2, u1))` with `u1` = pose 1, `u2` = pose 2, compared to the integrated gyro vector | derived by me, matches S9 `tools/README.md` method | MATCH (derivation re-done) | H | UOH-7 |
| Accel sign convention | Assumed: accel vector points UP at rest (specific force) | `fusion.js` and `frameFromPoses` assume it | captures only show +Z about +1 g, pose unknown | ASSUMED (F3) | L | UOH-7 (proposed UOH-20) |
| dt source | `dtUs = (ts[n]-ts[n-1]) >>> 0`, accept 0 < dt < 200 ms, validate against arrival times | `report-stream.js`: same rule, ratio window 0.8..1.25, arrival fallback | S1, S10 | MATCH | M | UOH-8 |
| u32 wrap | `>>> 0` on the difference | `(ts - prevTs) >>> 0`, `imuDeltaUs` | derived | MATCH | H | none |
| Counter use | never for dt or loss detection | counter only feeds diagnostics ratio | S1 vs captures | MATCH | M | UOH-8 |
| One sample per notification | yes, no batching | one `sample` per report | S1, S9 | MATCH | M | UOH-4 |
| Expected report rate | Windows 16.7 Hz, Android 33/67 Hz, macOS about 66 Hz (single source), console 200 Hz | not hard-coded; measured on diagnostics | S3, S8, S9 | MATCH | M | UOH-4 |
| Temperature offset | 25 + raw/127 | same | S1, S5, S6, S8 | MATCH | H | UOH-17 |

### 5.6 Web Bluetooth specifics

| Item | Spec value | Code value | Sources | Result | Confidence | UOH id |
|---|---|---|---|---|---|---|
| `requestDevice` options shape | `filters` (each with `manufacturerData` list of `{companyIdentifier, dataPrefix, mask}`) plus `optionalServices` | printed for Left: one filter, `companyIdentifier 1363`, prefix `00000000006720000000000000000000`, mask `0000000000ffff000000ffffffffffff`, `optionalServices [service]` | S15, S4 | MATCH | H | UOH-1 |
| Canonicalisation | `dataPrefix` non-empty; `mask` same length; a filter with an empty manufacturerData list throws | 16 = 16 bytes, one entry each | S15 | MATCH | H | none |
| Company id lookup in Chrome | Map lookup by id, then data filter on the bytes after the id | matches the way the code defines idx | S16 | MATCH | H | UOH-1 |
| Secure context | `http://localhost` qualifies | server on `localhost:8137` | S15, Chrome docs | MATCH | H | none |
| No blocking header | `Permissions-Policy` or similar could block Bluetooth; CSP does not govern Web Bluetooth | `server.js` sends CSP, nosniff, no-store, no-referrer only | code | MATCH | H | none |
| One GATT operation at a time | Overlapping operations on one characteristic are rejected | promise chain `serial()` for every write and subscription | S15 note, Chromium behaviour cited by the protocol doc (not re-read by me) | MATCH | M | UOH-15 |
| Notification copy | The event's `DataView` buffer may be reused | handler copies to a private `Uint8Array` | Web Bluetooth practice | MATCH | H | none |
| Service access | `getPrimaryService(uuid)` allowed only for `filters.services` or `optionalServices` | service is in `optionalServices` | S15 | MATCH | H | UOH-2 |
| Persistent device | `getDevices()` is flag-gated, chooser every session | not used; reconnect only within the page | Chrome docs (cited by the protocol doc, not re-read by me) | MATCH | M | UOH-14 |
| Timeouts | Chrome silently ignores some discovery errors, so a timeout is needed | 15 s connect, 15 s discovery | protocol doc cites Chromium; behaviour not re-verified by me | MATCH | M | UOH-2 |

### 5.7 Notes on the two derived checks

- **Gyro sign test.** For a body rotating with angular velocity `w` (body axes), a vector fixed in the world seen from the body changes as `du/dt = -w x u`. Over a small turn about unit axis `n` by angle `t`, `u1 = u0 - t (n x u0)`, so `u0 x u1 = -t n_perp`; hence `n ∝ -(u0 x u1) = u1 x u0`. The code calls pose 1 `u1` and pose 2 `u2`, and computes `cross(u2, u1)`, which is exactly that. Replacing every accelerometer sample by its negative leaves `u0 x u1` unchanged, which is why the gyro sign is safe against F3 but the blade direction is not.
- **Fusion correction.** `fusion.js` says `d(u_p)/dt = u_p x omega`, the same kinematics as above, and its correction term `omega_c = k (u_m x u_p)` drives `u_p` toward `u_m`. Consistent.

## 6. UNVERIFIED-ON-HARDWARE register (delta to protocol document section 12)

Everything in section 5 is UNVERIFIED-ON-HARDWARE. The items where this audit changes what the owner should look at:

| ID | Item | How to check on the diagnostics page |
|---|---|---|
| UOH-3 (changed) | Which mask starts the IMU on `649d4ac9-...`: 0x37 (no evidence on this channel), 0xB7 (switch2mac), 0xFF (four projects) | Step 1. Try 0x37; if "watchdogStage" is above 0, note it and try 0xFF; report which one worked and whether ZL/ZR show as pressed with no touch (F1) |
| UOH-1, UOH-12 (changed) | Strict filter lists the controller in the game, not only in diagnostics | Try the game (strict) and the diagnostics filters in order strict, lenient, all; report which was the first to list the controller (F2) |
| UOH-6 | Gyro scale 0.0610 vs 0.0075 dps/LSB | Step 4, one revolution: about 360 deg or about 2930 deg. If 2930, note that fast swings above about 245 dps clip in the sensor |
| UOH-20 (new) | Accel sign convention (F3) | New sub-step of step 3: lay the Joy-Con buttons up on the desk; raw accel Z must be about +4096. If it is about -4096, the pipeline needs an accel sign parameter before calibration can be trusted |
| UOH-3, UOH-4, UOH-5, UOH-7, UOH-8, UOH-10, UOH-11, UOH-13, UOH-15 | Unchanged | As in the protocol document |

## 7. Summary of recommended changes (for the maintainers, not applied by the auditor)

1. `input-config.js`: set `featureMask: 0xB7`, keep `fallbackMask: 0xFF`; add 0xB7 (183) to the mask select in `diagnostics.html`; keep 0x37 selectable. (F1)
2. `app.js` / `ble-provider.js`: accept `?filter=` and `?mask=` URL flags (or persist the diagnostics choice) so the game can use a working fallback. Mention the flags in `docs/setup-and-calibration-guide.md`. (F2)
3. `diagnostics-tools.js` CHECKLIST step 3: add the face-up +4096 check and the UOH-20 id. (F3)
4. `joycon2-parse.js`: expose `imuMarker !== 1` as a diagnostics warning. (F5)
5. `docs/joycon2-protocol.md`: correct claim P1 (5.3, D7), note P2 and P3. (section 4)

## 8. Update 2026-09-30: what native hardware evidence says about these findings

Source: `docs/hardware-findings.md` (two native CoreBluetooth probes on a Joy-Con 2 Right; not Chrome, not this game). Added after the audit; nothing above was edited.

| Item | Before | After the native probes | Still open |
|---|---|---|---|
| F1 (mask) | 0xB7 and 0xFF evidenced by other projects, 0x37 not on this channel | The init sequence with **0xB7** started the IMU on the first attempt (no 0xFF fallback), command responses arrived, 63-byte packets | Through Chrome; 0x37 still has no evidence; phantom ZL/ZR with 0xFF |
| F2 (strict filter, game-side fallback) | "the probability that strict fails is unknown" | The game has the flags since round 1. **On the first real test Chrome's chooser listed nothing with `strict`, cause unknown.** Natively the Right unit sent a bonded-console advert (idx 10-15 non-zero) before SYNC and a zero-address advert after it; a second probe saw the zero-address advert within 6.5 s, so the theory "strict misses the bonded-host advert" is only a possible cause. The game's default is now `lenient`, the connect screen has a "Can't see it? Extended search" button (acceptAllDevices) and the filter that worked is remembered | What Chrome lists for each filter; Chrome's Bluetooth permission; scan timing (next checks in section 6 of `docs/hardware-findings.md`) |
| P2 (strict filter presented as normative) | Only JoeGeC measured the zero address | The zero address in pairing mode is now also measured natively (Right unit); the bonded-host address before SYNC is measured too | The Left unit; Chrome's matching |
| 5.1 "Pairing-mode selector" row (RISK) | one source | Zero host address in pairing mode: verified natively (Right). Company id 0x0553, PID `66 20` at idx 5-6, vendor id at idx 3-4: verified | Left PID advert; macOS Chrome delivering manufacturer data to the matcher |
| F3 (accel sign) | unsettled | The accelerometer scale raw/4096 = g is confirmed (|a| = 1.026 g near rest, z = +1.003 g) | The sign convention needs a known pose (buttons up); UOH-20 stays open |
| F4 (gyro scale) | disputed | Not settled: the packet with gyro data was taken while the controller moved | UOH-6 |
| F5 (marker byte 0x29) | never used | The marker was `01` in the last packet of the native stream; the first packet had no IMU data yet | The parser still does not check it |

### 8.1 Second update 2026-09-30: the native Bluetooth bridge was built

The native probe of section 8 worked end to end while Chrome's chooser listed no device, so the game got a **native Bluetooth bridge** (`docs/native-bridge.md`): a CoreBluetooth helper that reproduces the probe's flow, started by the game's own server. The audit's findings are not changed by it, with these consequences:

| Item | With the bridge |
|---|---|
| F1 (mask) | The helper sends the init sequence the probe ran (mask `0xB7` by default, `?mask=` and the diagnostics selector still work). Verified natively for the Right unit by the probe; the **helper itself** has never been run against a controller by the people who built it (UOH-21 to UOH-33) |
| F2 (filter, game-side fallback) | The chooser and its filters are not involved on the native path. The helper chooses among Joy-Con 2 adverts itself: a pairing-mode advert (host address all zero) is preferred, otherwise the strongest one is connected to after a 1.5 s window (UOH-23, UOH-24). The Web Bluetooth path and its filters are unchanged |
| F3 (accel sign), F4 (gyro scale), F5 (marker) | Unchanged: the same parser, the same Motion pipeline, the same diagnostics tools (rest check with the buttons up, one revolution). The native diagnostics mode shows the same values |
| F6 (vibration frame) | The helper writes the same frame (`0A 91 01 02 00 04 00 00 ID 00 00 00`) to the command characteristic only, at most 10 per second (UOH-13, UOH-29) |
| Write whitelist (protocol decision 13) | Kept: the helper has exactly one write call site, and it writes only to the command characteristic `649d4ac9-...`; the firmware-update channel and `...7fdf` are never named in its code (`test/bridge/helper.test.js` checks it) |

Nothing in this update claims anything about the physical controller that the probes did not observe. Every item of the bridge that needs the real helper or a real Joy-Con is UNVERIFIED-ON-HARDWARE.
