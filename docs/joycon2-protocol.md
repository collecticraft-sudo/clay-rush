# Joy-Con 2 BLE Protocol: single source of truth

Project: 3D Fruit Dojo (fruit-slicing game, sword with a Joy-Con 2 strapped on, Chrome + Web Bluetooth on macOS; written under the working title "Joy-Con Ninja", renamed on 2026-09-30)
Author role: BLE protocol researcher. Research date: 2026-09-30. Language: English (owner request).

> **HONESTY NOTICE.** Nobody on the team could touch a physical Joy-Con 2. **Nothing in this document was observed by us on real hardware.** Every fact comes from third-party source code, third-party documentation or third-party captures, cross-checked as described below. Things that can only be confirmed on the physical device (or on the exact Chrome 154 + macOS 26.6 + Apple N1 Bluetooth stack of the owner's Mac) are labelled **UNVERIFIED-ON-HARDWARE** and collected in section 12 together with a 2-minute verification procedure for the diagnostics page.

> **Update 2026-09-30 (after this document was written).** The owner ran two native CoreBluetooth probes (not Chrome) against a Joy-Con 2 Right. They verified, for the Right unit only, the advertisement layout (3.1), the GATT table (section 4), the init sequence with mask 0xB7 (5.4), 63-byte reports with the marker byte 0x29 = `01`, about 33.4 Hz, and the accelerometer scale raw/4096 = g. Nothing about Chrome, the Left unit, the gyroscope, the keep-alive or the cooldown was verified. Details, raw-value summaries and the list of what stays open: `docs/hardware-findings.md`. Rows of the section 12 register carry a dated note where this evidence applies.

Companion file: `docs/joycon2-test-vectors.json` (machine-readable mirror of section 10; the hex in this document is normative).

---

## 0. How to read this document

**Confidence** (about the *third-party evidence*, not about our hardware):

| Tag | Meaning |
|---|---|
| **H** | Two or more independent sources agree (or one source is Chromium/SDL source code that can be read directly) and nothing credible contradicts it. |
| **M** | One hardware-tested source, or several sources that all derive from the same origin, or an inference from code that I read myself. |
| **L** | Single unverified source, guess, or the sources disagree. |

**Flags:** `UOH` = UNVERIFIED-ON-HARDWARE (see section 12). `DISPUTED` = sources disagree (see section 11). `NORMATIVE` = engineers implement exactly this. `ADVISORY` = recommendation.

**Sources** are cited by tag, for example `[ND-BT]`. The full URL list is in section 2. "Real capture" means a packet published by a third party, not captured by us.

**Licences.** Facts (UUIDs, offsets, constants) are reused; **no code was copied**. `joycon2android` is GPL-3.0 and `switch2_controller_research`, `switch2mac`, `Nadeflore/switch2-controllers` have no licence, so the reference code in this document is written from scratch.

---

## 1. Decisions for implementers (read this first)

| # | Decision | Value | Conf | Source |
|---|---|---|---|---|
| 1 | Transport | **Two transports, one packet pipeline.** (a) **The native Bluetooth bridge (section 9, built 2026-09-30, recommended):** a CoreBluetooth helper that the game's own server starts, which did the whole flow in the owner's native probe; any browser will do. (b) **Web Bluetooth in Chrome on macOS can do the whole flow on paper** (the second path; on the owner's Mac Chrome's chooser listed no device, cause unknown, UNVERIFIED-ON-HARDWARE). | M, UOH | `[MASCII]` `[CHR]` `[BCD]`, native probe 2026-09-30 |
| 2 | Scan filter | `manufacturerData` company id `0x0553`, product id at manufacturer-data bytes 5-6 (little endian): **Left 0x2067, Right 0x2066**, plus (only in the `strict` variant) "bonded-host address is all zero" (pairing mode). No service UUID is advertised and the local name is unreliable (section 3.2), so service/name filters must not be used. **Since 2026-09-30 the game's default is `lenient` (product id only), not `strict`: see the note in 3.3.** | H (layout, now also seen natively for the Right unit) | `[ND-BT]` `[JG-PROTO]` `[MASCII]` `[YUJI]` `[PS-PROTO]` + native scan |
| 3 | GATT | Service `ab7de9be-89fe-49ad-828f-118f09df7fd0` (must be in `optionalServices`). Input notify `...7fd2`, command write-without-response `649d4ac9-8eb7-4e6c-af44-1ea54fe5f005`, command response notify `c765a961-d9d8-4d36-a20a-5315b111836a`. | H | `[ND-BT]` `[MASCII]` `[JG-PROTO]` `[SEI]` |
| 4 | Init sequence | (optional response subscribe) then LED write, `0C 91 01 02 00 04 00 00 B7 00 00 00`, `0C 91 01 04 00 04 00 00 B7 00 00 00`, then subscribe to the input characteristic. Last-resort mask `0xFF`. No SMP pairing, no bonding needed. (Round 1 audit F1: the default mask was `0x37` until then, see 5.3.) | H (bytes), M (mask choice, UOH-3) | `[ND-CMD]` `[FR-CPP]` `[SEI]` `[MASCII]` `[PS-CODE]` |
| 5 | Keep-alive | Write the LED command again about once per second. macOS is reported to drop the link roughly 10-17 s after the host's last write. | M (single source), UOH | `[PS-PROTO]` |
| 6 | Report | 63-byte notification, little endian, buttons at 0x04, IMU timestamp (u32, microseconds) at 0x2A, temperature 0x2E, accel 0x30, gyro 0x36 (int16 x3 each). | H | `[ND-HID]` `[PS-PROTO]` `[JG-PROTO]` `[SDL]` + 2 real captures |
| 7 | IMU units | Accel: **raw / 4096 = g**. Gyro: **raw x 0.06103515625 = deg/s** (+-2000 dps full scale). **DISPUTED**: a community note says 48000 = 360 deg/s (0.0075 deg/s per LSB, 8.14 times smaller). Make the gyro scale a configurable constant and include a "turn the sword one full revolution" scale check in the calibration wizard. | Accel H, gyro M, DISPUTED | `[ND-HID]` `[SDL]` `[JG-DSU]` vs `[FR-CPP]` |
| 8 | Sample rate | **One IMU sample per notification, no batching.** Report rate equals the BLE connection interval: about **66 Hz (15 ms)** on macOS according to the only macOS source, 33 Hz or 67 Hz measured on Android. Chrome cannot request connection parameters. Expect 33-67 Hz, not 200 Hz. | M, UOH | `[PS-PROTO]` `[JG-DSU]` `[ND-BT]` |
| 9 | Time base | Compute `dt` from the IMU timestamp deltas (u32 wrap-safe), not from arrival times (arrivals are bursty). Sanity-check that the timestamp really is in microseconds. | M | `[ND-HID]` `[SDL]` |
| 10 | Axes | **Do not hard-code how the Joy-Con sits in the sword.** Parser returns raw sensor-frame values in report order. Frame conventions are only partly known (section 7.4). Calibration must discover gravity direction, swing axis and gyro sign. | H (that it must be discovered) | `[JG-DSU]` `[SDL]` |
| 11 | Pairing UX | The owner must hold **SYNC** every session (button-press wake only reconnects to the bonded console). Never pair in macOS Bluetooth settings. Chrome's chooser appears every session (`getDevices()` is flag-gated). | H | `[ND-BT]` `[JG-PROTO]` `[FR-PY]` `[ML]` `[BCD]` |
| 12 | Reconnect | Repeated connect attempts in a short time make the controller stop responding for minutes. Never loop `gatt.connect()`. At most one automatic retry, then wait for the user. | H (existence), L (duration) | `[FR-CPP]` `[JG-PROTO]` `[FR-PY]` `[OZ]` |
| 13 | Safety | Only ever write to the command characteristic (and optionally the vibration characteristic). Never write to `4147423d-...` (firmware update channel) or to `...7fdf`. | M | `[ND-BT]` `[JG-PROTO]` |

> **Note 2026-09-30 (decision table, see `docs/hardware-findings.md`).** Natively verified on a Joy-Con 2 Right, through CoreBluetooth and not Chrome: decision 2 (company id 0x0553, product id 0x2066 at idx 5-6; host-address bytes all zero while in pairing mode, non-zero before SYNC), decision 3 (service `ab7de9be-...7fd0`, the characteristics of section 4), decision 4 (LED, SET 0xB7, ENABLE 0xB7, then the input subscription; no SMP pairing; no 0xFF fallback needed), decision 6 (63-byte reports, marker 0x29 = `01`, IMU inactive in the first packet) and the accelerometer half of decision 7 (raw/4096 = g, |a| = 1.026 g near rest). Decision 8 has one native measurement (about 33.4 Hz over 14.5 s). Still unverified: everything about Chrome, decision 1 (Web Bluetooth does the whole flow), decision 5 (keep-alive), decision 7 gyro scale, the Left unit.

---

## 2. Evidence base (sources read for this document)

All GitHub files were read from source on 2026-09-30. "HW" = the authors state they tested on real Joy-Con 2 hardware.

| Tag | What | URL | Platform / licence | Used for | Reliability |
|---|---|---|---|---|---|
| `ND-BT` | ndeadly, Bluetooth interface (advertisements, pairing, GATT table, console init sequence, connection interval) | https://github.com/ndeadly/switch2_controller_research/blob/master/bluetooth_interface.md | docs from sniffer captures, no licence | GATT map, adverts, console sequence | H (most complete; captures are in that repo, binary, not analysed by me) |
| `ND-HID` | ndeadly, HID reports (input report 0x05 layout, motion data) | https://github.com/ndeadly/switch2_controller_research/blob/master/hid_reports.md | same | report layout, IMU FSR | H, one claim contradicted (counter semantics) |
| `ND-CMD` | ndeadly, commands (header, feature select, LED, vibration, memory read) | https://github.com/ndeadly/switch2_controller_research/blob/master/commands.md | same | command frames | H |
| `ND-MEM` | ndeadly, memory layout | https://github.com/ndeadly/switch2_controller_research/blob/master/memory_layout.md | same | flash map (not needed by the game) | H |
| `PS-PROTO` | Peterksharma, protocol notes | https://github.com/Peterksharma/switch2mac/blob/main/research/PROTOCOL.md | macOS CoreBluetooth, HW ("observed on real hardware"), no licence | macOS quirks, keep-alive, feature mask, stick calibration | M-H |
| `PS-CODE` | Peterksharma, Swift sources | https://github.com/Peterksharma/switch2mac/blob/main/Sources/FinallyTheControllerWorks/Protocol/Switch2Protocol.swift and `.../Bluetooth/ControllerSession.swift`, `.../Bluetooth/BridgeEngine.swift` | same | handshake order, scan code, offsets | M-H |
| `JG-PROTO` | JoeGeC, protocol doc (measured 2026-09-29 on Joy-Con 2 L and R) | https://github.com/JoeGeC/joycon2android/blob/main/docs/protocol.md | Android, HW, **GPL-3.0** | advert bytes, cooldown, Android rate, packet notes | H |
| `JG-DSU` | JoeGeC, motion frame doc + `MotionConverter.kt` + tools README | https://github.com/JoeGeC/joycon2android/blob/main/docs/dsu-motion.md , https://github.com/JoeGeC/joycon2android/blob/main/feature/dsu/domain/src/main/kotlin/com/joegec/joycon2android/dsu/motion/MotionConverter.kt , https://github.com/JoeGeC/joycon2android/blob/main/tools/README.md | Android, HW, GPL-3.0 | IMU scales, measured raw axes (Right JC), report rate, bias, gyro-sign method | M-H |
| `SDL` | SDL3 Switch 2 driver | https://github.com/libsdl-org/SDL/blob/main/src/joystick/hidapi/SDL_hidapi_switch2.c | C, zlib, **USB only** (Bluetooth returns "not supported") | gyro coefficient, IMU offsets, timestamp handling, 250 Hz sensor rate | H (code) |
| `MASCII` | mascii, Joy-Con 2 + Web Bluetooth demo (the only Web Bluetooth implementation found) | https://github.com/mascii/joy-con-2-web-bluetooth-api-demo/blob/main/src/App.vue , live demo https://joy-con-2-web-bluetooth-api-demo.pages.dev/ | Vue, MIT, 2025-07 | requestDevice options, connect flow, PIDs | H for the flow (README says Chrome/Edge, mentions macOS; no IMU use) |
| `SEI` | seitanmen, Joycon2forMac | https://github.com/seitanmen/Joycon2forMac/blob/main/README.md and `.../src/Joycon2BLEReceiver.mm` | macOS CoreBluetooth, MIT | real Right JC packet, init timings, mask 0xFF | M-H |
| `FR-CPP` | TheFrano, joycon2cpp | https://github.com/TheFrano/joycon2cpp/blob/main/README.md and `.../testapp/src/testapp.cpp`, `.../testapp/src/JoyConDecoder.cpp`, `.../testapp/src/DsuServer.cpp` | Windows, MIT, 141 stars | real Left JC packet, mask 0x37, cooldown, 48000=360 note | M-H (README field table has wrong offsets, code is right) |
| `YUJI` | yujimny, Joycon2test (Python/bleak) | https://github.com/yujimny/Joycon2test/blob/main/joycon2_ble_client.py | cross-platform, Apache-2.0 | PID bytes for L/R/GC, init timings | M |
| `OZ` | OZORDI, JoyCon2Mac | https://github.com/OZORDI/JoyCon2Mac/blob/main/JoyCon2Mac/BLEManager.mm and `.../JoyConDecoder.cpp` | macOS, custom licence | 180 s cooldown policy, decode offsets | M |
| `LOY`,`FR-PY`,`MOUSE` | loyahdev/joycon2mac, TheFrano/joycon2py, moutella/joycon2mouse | https://github.com/loyahdev/joycon2mac/blob/main/joycon.py , https://github.com/TheFrano/joycon2py/blob/main/README.md , https://github.com/moutella/joycon2mouse/blob/main/main.py | Python, MIT | button bit cross-check, "use SYNC, never button press", init timings | M |
| `ML` | mlstr0m, switch2bridge-macos (Pro Controller, bleak) | https://github.com/mlstr0m/switch2bridge-macos/blob/main/Switch2Bridge.py | macOS, MIT | "never appears in System Settings", scan windows | M |
| `TL`,`NF` | trevlars/switch2-controllers-linux, Nadeflore/switch2-controllers | https://github.com/trevlars/switch2-controllers-linux/blob/main/ngc/dsu.py , https://github.com/Nadeflore/switch2-controllers/blob/main/controller.py | Linux/Python; Joy-Con 2 **untested** in TL | offsets 0x30/0x36 (NF), +-8 g / +-2000 dps assumption (TL) | L-M |
| `CHR` | Chromium source (macOS Bluetooth backend and Web Bluetooth chooser) | https://github.com/chromium/chromium/blob/main/device/bluetooth/bluetooth_low_energy_adapter_apple.mm , `.../device/bluetooth/bluetooth_remote_gatt_characteristic_mac.mm` , `.../device/bluetooth/bluetooth_low_energy_device_mac.mm` , `.../content/browser/bluetooth/bluetooth_device_chooser_controller.cc` | BSD | how Chrome on macOS exposes manufacturer data, writes and discovery | H (code) |
| `BCD` | MDN browser-compat-data + Chrome docs | https://github.com/mdn/browser-compat-data/blob/main/api/Bluetooth.json , https://developer.chrome.com/docs/capabilities/bluetooth | CC0 | Chrome versions (manufacturerData 92, writeValueWithoutResponse 85, getDevices flag-gated) | H |
| `BLOCK` | Web Bluetooth GATT blocklist | https://github.com/WebBluetoothCG/registries/blob/master/gatt_blocklist.txt | Apache-2.0 | confirms no Nintendo UUID is blocked | H |
| `LOCAL` | Measurements on the owner's Mac made for this report | (commands run 2026-09-30) | | toolchain audit (section 9), Chrome version | H (measured) |

**Not accessed / not analysed:** the binary `.pcapng` captures in `ndeadly/switch2_controller_research/captures/` (I relied on the author's markdown). `mikuta0407/Joycon2Connector-ESP32-S3` was skimmed only (no protocol facts beyond the above).

---

## 3. Discovery: advertisements and scan filter

### 3.1 Advertisement content (`[ND-BT]`, H)

The connectable advertisement carries only two AD entries: **Flags** (`0x06`) and **Manufacturer Specific Data** (AD type `0xFF`). **No service UUID, and no usable local name** (`[ND-BT]`; `[JG-PROTO]` measured "the advertisement has no local name" on real L and R units). I found no source that documents the scan response; `[MASCII]` uses a name filter only for iOS, which suggests a name is sometimes known there, so treat names as unreliable.

Manufacturer data, indexed **after the 2-byte company id** (this is exactly how Chrome exposes it: `[CHR]` splits the first two bytes as little-endian company id and passes the rest as data):

| Idx | Size | Value | Meaning | Conf |
|---|---|---|---|---|
| 0 | 1 | `01` | constant | H |
| 1 | 1 | `00` | constant | H |
| 2 | 1 | `03` | constant | H |
| 3-4 | 2 | `7E 05` | vendor id 0x057E (Nintendo), little endian | H |
| 5-6 | 2 | PID LE | **Left `67 20` (0x2067), Right `66 20` (0x2066)**, Pro 2 `69 20`, NSO GameCube `73 20` | H (4 sources) |
| 7 | 1 | `00` | constant | H |
| 8 | 1 | `01` | constant | H |
| 9 | 1 | `00`, or `81` in a "wake console" advert | | H `[ND-BT]` |
| 10-15 | 6 | host address, reverse byte order | **all `00` = pairing mode (SYNC held)**; otherwise the address of the bonded host | H `[ND-BT]` `[JG-PROTO]` `[PS-PROTO]` |
| 16 | 1 | `0F` | constant | M |
| 17-23 | 7 | `00` | reserved | M |

Company id: `0x0553` (Nintendo's Bluetooth SIG id). `[ML]` claims some firmware shows `0x057E` as the company key ("both observed in the wild", written about the Pro Controller). L, DISPUTED, UOH. Only the lenient fallback in 3.3 covers this.

Three advert kinds (`[ND-BT]`, H): *standard* (SYNC held, host address zero), *reconnection* (button press on an already-bonded controller, host address = bonded host), *wake console* (idx 9 = `0x81`). `[JG-PROTO]` measured on real units: pairing `01 00 03 7E 05 66 20 00 01 00 [00 00 00 00 00 00] 0F ...`, wake `... [09 A7 9A 55 E2 98] 0F ...`.

### 3.2 Left vs Right (the only signals)

1. **Product id in manufacturer data idx 5-6** (before connecting). H.
2. **Characteristic presence after connecting** (robust fallback): the vibration characteristic `289326cb-a471-485d-a8f4-240c14f18241` exists on Left only, `fa19b0fb-cd1f-46a7-84a1-bbb09e00c149` on Right only (`[ND-BT]`, H). The extended response characteristics differ the same way (`63a3810f-...` L, `640ca58e-...` R).
3. GAP device name, expected `Joy-Con 2 (L)` / `Joy-Con 2 (R)` (`[MASCII]` uses it as an iOS-only name filter, `[JG-PROTO]` scanner and `[SEI]` match `(L)`/`(R)`). **Unreliable on macOS Chrome**: the mascii README says the chooser "may display 'Joy-Con 2 (R)' or 'DeviceName'". M.
4. The UI can simply ask the user ("left" / "right" button, as mascii does): then the filter selects the side and no inference is needed.

### 3.3 Concrete `requestDevice` filters (NORMATIVE, see section 8 for the verdict)

Chrome matches `manufacturerData` filters in the browser process against the parsed manufacturer map (`MatchesFilter` in `[CHR]` chooser controller). `dataPrefix` and `mask` must have the same length. Semantics per the Web Bluetooth specification (not re-verified in Chromium's matcher): a byte matches when `(data[i] & mask[i]) == (dataPrefix[i] & mask[i])`, and the advert data must be at least as long as `dataPrefix`.

1. **Lenient (the game's default since 2026-09-30):** 16-byte prefix and mask, mask `FF` only at idx 5, 6 (PID), so the host-address bytes are ignored (this is what `[MASCII]` uses with a 7-byte prefix). A second filter entry for company id `0x057E` covers the `[ML]` claim. It also offers adverts of Joy-Cons that are synced to a nearby Switch 2 (the "wake" and "reconnection" adverts), which are not connectable by us (`[JG-PROTO]`: link drops with status `0x3E`); choosing one of those would burn a connection attempt (cooldown, section 5.5).
2. **Strict (selectable with `?filter=strict`; it was the default until 2026-09-30): pairing-mode adverts of a given side only.** Same, plus mask `FF` at idx 10-15 (address must be zero). This hides the "wake" adverts described above.
3. **Last resort:** `acceptAllDevices: true` with `optionalServices`. The chooser then lists every BLE device nearby. The game's connect screen offers it after a closed chooser with the button "Can't see it? Extended search" (a real click: `requestDevice` needs the user gesture).

> **Note 2026-09-30 (3.3; evidence in `docs/hardware-findings.md`).** On the first real test Chrome's chooser listed **no device** with `strict`. A native scan then saw the Right unit send two adverts (idx 10-15 = a bonded console's address at 8.2 s before SYNC, all zero at 19.0 s after SYNC) and a second native probe saw the zero-address advert at 6.5 s, so "strict misses the bonded-host advert" is **only a possible cause, not the confirmed one** (other candidates: Chrome's macOS Bluetooth permission, scan timing, Chrome's manufacturer-data matching). The game therefore defaults to `lenient`, falls back to `all` on a click, and remembers the filter that reached `streaming`. Layout facts confirmed natively for the Right unit: company id 0x0553, product id `66 20` at idx 5-6, vendor id `7E 05` at idx 3-4, no name, no service UUID. Which filter lists the controller in Chrome: UNVERIFIED-ON-HARDWARE (UOH-1).

Exact code is in the reference recipe (section 5.6, function `requestJoyCon`).

---

## 4. GATT map

Source: `[ND-BT]` (sniffed GATT table, H). Service handles are those seen on the console; Chrome uses UUIDs, not handles.

**Primary service `ab7de9be-89fe-49ad-828f-118f09df7fd0`** (handles 0x0008-0x002A). Only this service is needed. `optionalServices: [thisUuid]` is mandatory, otherwise Web Bluetooth refuses access to it.

| Characteristic UUID | Handle | Props | Role | Game usage |
|---|---|---|---|---|
| `ab7de9be-89fe-49ad-828f-118f09df7fd2` | 0x000A | READ, NOTIFY | **Input report 0x05** (common report, 63 bytes, IMU + buttons + sticks + battery). Used by mascii, seitanmen, yujimny, joycon2cpp, joycon2android, switch2mac. | **USE (subscribe)** |
| `649d4ac9-8eb7-4e6c-af44-1ea54fe5f005` | 0x0014 | WRITE_NO_RESPONSE | **Command channel** (8-byte header + data). | **USE (write)** |
| `c765a961-d9d8-4d36-a20a-5315b111836a` | 0x001A | NOTIFY | **Command response #1** (header echoes command and subcommand). | USE (optional but recommended, to pace init) |
| `cc1bbbb5-7354-4d32-a716-a81cb241a32a` (L) / `d5a9e01e-2ffc-4cca-b20c-8b67142bf442` (R) | 0x000E | READ, NOTIFY | Joy-Con-specific input report 0x07/0x08 (console default, **different, packed motion format that nobody has decoded**) | IGNORE |
| `289326cb-a471-485d-a8f4-240c14f18241` (L) / `fa19b0fb-cd1f-46a7-84a1-bbb09e00c149` (R) | 0x0012 | WRITE_NO_RESPONSE | HD rumble output report | side detection only; haptics via command 0x0A instead |
| `ce49a830-dced-48ae-931e-c8cf88aadbea` (L) / `65a724b3-f1e7-4a61-8078-a342376b27ff` (R) | 0x0016 | WRITE_NO_RESPONSE | Rumble + command (console path, commands behind 17 zero bytes) | IGNORE (the plain command channel works) |
| `63a3810f-aec7-474b-9010-3d52403cb996` (L) / `640ca58e-0e88-410c-a7f3-426faf2b690b` (R) | 0x001E | NOTIFY | Extended command response | IGNORE |
| `4147423d-fdae-4df7-a4f7-d23e5df59f8d` | 0x0018 | WRITE_NO_RESPONSE | **Large command / firmware update** | **NEVER WRITE** |
| `d3bd69d2-841c-4241-ab15-f86f406d2a80` | 0x0022 | NOTIFY | unknown | IGNORE |
| `ab7de9be-89fe-49ad-828f-118f09df7fde` | 0x0026 | READ, NOTIFY | unknown | IGNORE |
| `ab7de9be-89fe-49ad-828f-118f09df7fdf` | 0x002A | WRITE_NO_RESPONSE | unknown; `[JG-PROTO]`: writing here "enables a subscription that never delivers data" (looks like the command characteristic, is not) | **AVOID** |
| descriptor `679d5510-5a24-4dee-9557-95df80486ecb` | 0x000C, 0x0010, 0x0028 | | "Set report rate?" The console writes `85 00` to the one under the 0x000E characteristic before enabling notifications (`[ND-BT]` init table). Effect unknown. | optional experiment only (section 12, UOH-9) |

Second proprietary service `00c5af5d-1964-4e30-8f51-1956f96bd280` (handles 0x0001-0x0007: `...bd281` READ, `...bd282` WRITE, `...bd283` READ). The console writes `01 00` to `...bd282` first. **Not needed** by any streaming implementation. Standard services `1800` (Device Name 0x2A00) and `1801` (empty!) also exist. The empty Generic Attribute service is a known quirk (`[ND-BT]`: implementations that assume every service has children may misbehave). Chromium's macOS backend runs `discoverServices:nil`, then characteristic and descriptor discovery for every service, and only then reports discovery complete (`[CHR]` `bluetooth_low_energy_device_mac.mm`); whether the empty service completes cleanly was not verified. Native macOS clients that iterate all services (`[PS-CODE]`, `[SEI]`, `[OZ]`) work, so this is expected to be fine (UOH-2).

**Pro Controller 2 and GameCube use other UUIDs** (`7492866c-...c0f8/c0f9`, `8261cba1-...`); irrelevant here. Do not mix them up.

**Web Bluetooth blocklist:** none of these UUIDs is on the blocklist (`[BLOCK]`, verified by grep). The blocklist forbids *writing* descriptor `0x2902`, which is irrelevant because `startNotifications()` writes the CCC itself.

---

## 5. Connection and initialisation (NORMATIVE recipe)

### 5.1 Pairing, bonding, security (H)

- **No SMP pairing.** The controller terminates any link that attempts Bluetooth SMP pairing/bonding (`[ND-BT]`, `[PS-PROTO]`, `[JG-PROTO]`). None of the characteristics above requires encryption, so a plain Chrome/CoreBluetooth connection does not trigger it.
- **Pairing/bonding is optional for streaming** (`[ND-BT]`: "Pairing itself is optional for communicating with the controller and receiving notifications"). The proprietary application-layer pairing (command 0x15, host address + LTK exchange) only makes the controller advertise toward that host when a button is pressed. Chrome cannot read the Mac's Bluetooth address, so **do not implement it**.
- Therefore every session starts with **holding SYNC** until the player LEDs sweep, while Chrome's chooser is open (scan windows are short: `[ML]` scans 30 s, `[MASCII]` order: click Connect, then press SYNC). Button-press "pairing" never works (`[FR-PY]`). The controller **never appears in macOS System Settings > Bluetooth** (`[ML]`); do not try to pair it there.
- SYNC is the small button next to the USB-C port (`[PS-PROTO]` README), "small pair button on the back" (`[ML]`).

### 5.2 Command frame format (H)

Every command is an 8-byte header plus optional data, written to `649d4ac9-...f005` with **write without response** (`[ND-CMD]`, `[PS-CODE]`, all implementations).

| Byte | Value | Meaning |
|---|---|---|
| 0 | command id | |
| 1 | `0x91` | request (`0x01` in a response) |
| 2 | `0x01` | transport = Bluetooth (`0x00` USB). DISPUTED for memory reads: see section 11, D8. |
| 3 | subcommand id | |
| 4 | `0x00` | unknown (response: `0x10`) |
| 5 | data length | (response: ACK `0x78`) |
| 6-7 | `00 00` | reserved |
| 8.. | data | |

Response (notification on `c765a961-...`): `cmd 01 01 sub 10 78 00 00` + data, for example `0c 01 01 02 10 78 00 00 00 00 00 00` (`[ND-CMD]` examples). Match on byte 0 (command) and byte 3 (subcommand) (`[JG-PROTO]`: "echoing id and sub").

Frames the game needs (all bytes verified against the reference recipe in 5.6; the SET/ENABLE bytes for mask `0xFF` are identical to the hex string printed in the `[SEI]` README `0c91010200040000FF000000`, and mask `0x37` to the console traffic in `[ND-BT]`, which goes to a different characteristic, see 5.3):

| Name | Bytes | Conf | Source |
|---|---|---|---|
| LED, player 1 | `09 91 01 07 00 08 00 00 01 00 00 00 00 00 00 00` (16 B) | H | `[ND-CMD]` `[MASCII]` `[SDL]` |
| Feature SET(mask) | `0C 91 01 02 00 04 00 00 MM 00 00 00` (12 B) | H | `[ND-CMD]` `[SEI]` `[MASCII]` |
| Feature ENABLE(mask) | `0C 91 01 04 00 04 00 00 MM 00 00 00` (12 B) | H | same |
| Vibration preset id | `0A 91 01 02 00 04 00 00 II 00 00 00` (12 B); ids: 1 low buzz ~1 s, 3 soft click-click (console "connection" sample), 5 stronger click, 6 short high beep | H (frame), M (feel) | `[ND-CMD]` |

LED payload length: `[ND-CMD]`, `[SDL]`, `[MASCII]` use 8 data bytes; `[PS-PROTO]` says 4. Use 8 (three sources, byte-exact with console traffic). `[MOUSE]` pads payloads to 8 bytes "because some buffer lengths seem to crash". Use exactly the frames above, do not invent lengths.

### 5.3 Feature mask (which fields are populated)

Bits (`[ND-CMD]`, `[PS-PROTO]`, H): `0x01` buttons, `0x02` sticks, **`0x04` IMU**, `0x10` optical mouse sensor (Joy-Con only), `0x20` battery current field (ND calls it "rumble"), `0x80` magnetometer. Command 0x0C sub 0x02 (SET) must precede sub 0x04 (ENABLE).

| Mask | Used by | Note |
|---|---|---|
| **`0xB7`** | switch2mac (`[PS-CODE]`, hardware-tested on macOS, "practical mask 0xB7 on Joy-Cons") | `0x37` plus the magnetometer bit. **Default** since the round 1 protocol audit (F1). The extra magnetometer bytes are ignored by the game; no source reports phantom ZL/ZR bits with it. |
| `0xFF` | mascii (Chrome Web Bluetooth), seitanmen (macOS), yujimny, joycon2android | works on the plain command characteristic in four projects, but `[PS-PROTO]` (citing Switch2Connect) says it "induces phantom ZL/ZR bits on Joy-Cons". Used only as the automatic **last resort** (section 5.4 step 9); the game ignores the RECENTER button for 1.5 s after such a switch. |
| `0x37` | Switch 2 console traffic for Joy-Con (`[ND-BT]`); joycon2cpp (`[FR-CPP]`) sends it only inside `SendJoyCon2OfficialInit`, written to the **rumble + command characteristic** (handle 0x0016) after a 17-byte zero prefix and a 15-command console-style sequence. Its plain-channel helper `SendCustomCommands`, the only code that would write 0x37 to `649d4ac9-...`, is defined and never called | buttons+sticks+IMU+mouse+current. **Expert option only** (`?mask=0x37`, diagnostics page). It is a strict subset of `0xB7` and contains the IMU bit, so it will very probably work, but **no source demonstrates it on the characteristic this game writes to** (the earlier text "IMU works there" was over-confident, protocol audit P1). Magnetometer bytes stay zero (visible in real capture V1). |

Hint for the fallback logic (inference, UOH-3): the `[FR-CPP]` decoder treats a report whose 12 motion bytes are all zero as "no motion data", which suggests those bytes are zero while the IMU is not enabled. With the IMU on, gravity keeps the accel bytes non-zero. Use `imuActive` from the parser.

### 5.4 Ordered steps (NORMATIVE) with timings

Timings differ between projects: `[SEI]` waits 0.5 s after characteristic discovery, 0.5 s between the two commands, enables notifications at 2.0 s; `[MASCII]` LED, 500 ms, SET, 500 ms, ENABLE, then subscribe; `[YUJI]` 0.5 s settle, 0.5 s between commands; `[FR-CPP]` 80-100 ms between commands; `[PS-CODE]` waits for each response (2 s timeout) and subscribes to the input characteristic last; `[JG-PROTO]` subscribes first, then writes with 500 ms spacing. Both orders work, so the recipe uses the conservative variant.

1. `requestDevice` (user gesture) with the default filter (lenient since 2026-09-30, see 3.3). Show status text meanwhile; the user holds SYNC.
2. `device.gatt.connect()` with a 15 s timeout of our own (I found no documented Chrome connect timeout to rely on). Register `gattserverdisconnected`.
3. Wait 300 ms ("stabilisation", `[YUJI]` 500 ms, `[MOUSE]` 500 ms).
4. `getPrimaryService(SERVICE)` then `getCharacteristics()`. Chrome on macOS discovers **all** services, characteristics and descriptors of the device (about 37 attributes, `[ND-BT]`) and completes discovery before `getPrimaryService` can resolve (`[CHR]` `bluetooth_low_energy_device_mac.mm`); expect 1-3 s (UOH-2, estimate). Errors during discovery are silently ignored by Chrome (a `TODO` in that file), so a **timeout is mandatory** (recipe uses 15 s).
5. Determine `side` (3.2). Get the command and input characteristics.
6. (Recommended) `startNotifications()` on `c765a961-...`. Failure is non-fatal. `[PS-PROTO]` says the response subscription "must precede any command" on their stack; `[MASCII]` skips it and works. Use it to pace init.
7. Write LED (player 1). This stops the LED sweep = visible "connected" cue. Wait for the response, or 500 ms.
8. Write SET(0xB7), wait, write ENABLE(0xB7), wait (response or 500 ms each).
9. `startNotifications()` on the input characteristic. **Watchdog:** no report 2 s later, re-send ENABLE; no report 4.5 s later, send SET+ENABLE with the fallback (`0xFF`; `0xB7` first when the expert mask `0x37` was chosen); no report 9 s later, fail with "no input data".
10. Start the 1 Hz keep-alive (5.5).

Nominal time to first report: about 3-6 s (connect + discovery + 3 x up to 500 ms). Serialise every GATT operation (5.6 does).

### 5.5 Keep-alive, disconnects, cooldown

**macOS keep-alive (M, single source, UOH-5).** `[PS-PROTO]` §9: "a connected Switch 2 controller's link is silently terminated about 10-17 seconds after the host's last write to it, even while input reports are still streaming inbound. Linux and Windows hosts do not exhibit this." Fix: re-issue a harmless command once per second (he re-sets the player LEDs; rumble writes also count). `[PS-CODE]` `ControllerSession.swift` implements it. Other macOS clients (`[SEI]`, `[ML]`, `[MOUSE]`) do not mention it and send no periodic writes, but none documents sessions longer than a few minutes, so this is not contradicted. **It is cheap, so always do it:** send the identical LED frame every 1000 ms when no write happened in the last 900 ms.

Chrome specifics from source (`[CHR]` `bluetooth_remote_gatt_characteristic_mac.mm`): `writeValueWithoutResponse` hands the bytes to CoreBluetooth and **resolves immediately** (it does not wait for `canSendWriteWithoutResponse`), and a second write/read on the *same* characteristic while one is pending fails with an "in progress" error. Consequences: (a) serialise writes through a promise chain, (b) do not flood the command characteristic (bursts can be silently dropped by CoreBluetooth), space init commands at least 100 ms apart, (c) haptics must be rate-limited (for example at most 10 per second).

**Disconnect handling.** On `gattserverdisconnected` stop timers and show a "press SYNC and reconnect" message. Chrome unloading the page (reload, close) tears the link down (mascii README: "Reloading the page will disconnect"). Call `device.gatt.disconnect()` in `pagehide`. What state the controller returns to afterwards is UOH-14; plan for "press SYNC again".

**Reconnect/cooldown quirk (H that it exists, L on duration).**
- `[FR-CPP]` README: "if you attempt to connect or pair them repeatedly in a short time span, they may stop responding or fail to connect entirely for several minutes. This appears to be a controller-level cooldown".
- `[JG-PROTO]`: "Rapid repeated connects make the controller stop responding. Press SYNC to re-advertise, and wait if it stays unresponsive." `[FR-PY]`: "Disconnecting and connecting in a short amount of time. Fix: wait a little before reconnecting".
- `[OZ]` implements 180 s between attempts to the same peripheral plus exponential back-off `30 s x 2^min(n,5)` after failures (their own policy, not a measured constant).
- Mitigations (ADVISORY): (1) strict pairing-only filter so wake adverts are never chosen (the game's default is lenient since 2026-09-30, see the note in 3.3; the trade-off is that a wake advert can be chosen by hand), (2) one connect attempt per user click, disable the button for 10 s after a failure, (3) at most one silent automatic retry after an unexpected drop, after 2 s, then wait for the user, (4) after 3 consecutive failures show "wait about 3 minutes, then hold SYNC again" (the UI text is the front-end's job), (5) never disconnect/reconnect for mode changes, keep one link for the whole session, (6) never call `gatt.connect()` in a loop or from a timer.

### 5.6 Reference recipe (Web Bluetooth). ADVISORY code, NORMATIVE bytes

Syntax-checked with `node --check` and the frame builders were printed and compared byte for byte with the sources. **It has never talked to a real controller (UOH).** Adapt it into `src/input/ble-provider.js`; it depends only on the parser in section 7.7.

```js
// Reference recipe for the Web Bluetooth provider. Written from the sources in docs/joycon2-protocol.md; never run against a real Joy-Con (UNVERIFIED-ON-HARDWARE).
export const SERVICE = 'ab7de9be-89fe-49ad-828f-118f09df7fd0';
export const CH = {
  input: 'ab7de9be-89fe-49ad-828f-118f09df7fd2',   // NOTIFY, 63-byte input report 0x05
  cmd: '649d4ac9-8eb7-4e6c-af44-1ea54fe5f005',     // WRITE_WITHOUT_RESPONSE, command channel
  resp: 'c765a961-d9d8-4d36-a20a-5315b111836a',    // NOTIFY, command responses
  vibL: '289326cb-a471-485d-a8f4-240c14f18241',    // exists on Left only  (used to detect the side)
  vibR: 'fa19b0fb-cd1f-46a7-84a1-bbb09e00c149',    // exists on Right only
};
export const PID = { L: 0x2067, R: 0x2066 };
export const NINTENDO_COMPANY_ID = 0x0553;

const frame = (cmd, sub, payload) => Uint8Array.from([cmd, 0x91, 0x01, sub, 0x00, payload.length, 0x00, 0x00, ...payload]);
export const LED = (mask) => frame(0x09, 0x07, [mask, 0, 0, 0, 0, 0, 0, 0]);          // 16 bytes
export const FEATURE_SET = (m) => frame(0x0C, 0x02, [m, 0, 0, 0]);                     // 12 bytes
export const FEATURE_ENABLE = (m) => frame(0x0C, 0x04, [m, 0, 0, 0]);                  // 12 bytes
export const VIBRATE = (id) => frame(0x0A, 0x02, [id, 0, 0, 0]);                       // 12 bytes, id 3 = soft click

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);

// Bytes AFTER the 2-byte company id: idx5..6 = product id (LE), idx10..15 = bonded-host address (all 0 in pairing mode).
function manufacturerFilter(pid, pairingOnly) {
  const dataPrefix = new Uint8Array(16), mask = new Uint8Array(16);   // dataPrefix and mask MUST have equal length
  dataPrefix[5] = pid & 0xFF; dataPrefix[6] = pid >> 8; mask[5] = 0xFF; mask[6] = 0xFF;
  if (pairingOnly) for (let i = 10; i < 16; i++) mask[i] = 0xFF;
  return { manufacturerData: [{ companyIdentifier: NINTENDO_COMPANY_ID, dataPrefix, mask }] };
}

/** Must be called from a click handler (user gesture). side: 'L' | 'R' | 'any'. pairingOnly = the `strict` filter; the game's default since 2026-09-30 is false (lenient, see 3.3). */
export function requestJoyCon(side = 'any', { pairingOnly = false, acceptAll = false } = {}) {
  if (acceptAll) return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE] });
  const pids = side === 'any' ? [PID.L, PID.R] : [PID[side]];
  return navigator.bluetooth.requestDevice({ filters: pids.map((p) => manufacturerFilter(p, pairingOnly)), optionalServices: [SERVICE] });
}

export async function openLink(device, { mask = 0xB7, onReport, onEvent = () => {} } = {}) {
  let alive = true, lastWriteAt = 0, lastReportAt = 0, keepTimer = 0, watchdog = 0;
  const pending = new Map();                                  // 'cmd:sub' -> resolve
  let chain = Promise.resolve();                              // ONE GATT operation at a time (Chrome rejects overlaps)
  const server0 = await timeout(device.gatt.connect(), 15000, 'gatt.connect');
  device.addEventListener('gattserverdisconnected', () => { alive = false; clearInterval(keepTimer); clearInterval(watchdog); onEvent({ type: 'disconnected' }); });
  await sleep(300);                                           // settle (sources use 500 ms)
  const service = await timeout(server0.getPrimaryService(SERVICE), 15000, 'getPrimaryService');
  const chars = new Map((await service.getCharacteristics()).map((c) => [c.uuid, c]));
  const side = chars.has(CH.vibL) ? 'L' : chars.has(CH.vibR) ? 'R' : '?';
  const cmdChar = chars.get(CH.cmd), inputChar = chars.get(CH.input);
  if (!cmdChar || !inputChar) throw new Error('required characteristics missing');

  const write = (bytes) => (chain = chain.catch(() => {}).then(async () => {   // whitelist: only ever write to the command characteristic
    if (!alive) return; lastWriteAt = performance.now();
    await (cmdChar.writeValueWithoutResponse ? cmdChar.writeValueWithoutResponse(bytes) : cmdChar.writeValue(bytes));
  }));
  const send = async (bytes, waitMs) => {                      // resolves on matching response OR after waitMs
    const key = bytes[0] + ':' + bytes[3];
    const got = new Promise((res) => pending.set(key, res));
    await write(bytes);
    await Promise.race([got, sleep(waitMs)]); pending.delete(key);
  };

  try {                                                        // command responses: optional, never fatal
    const resp = chars.get(CH.resp);
    resp.addEventListener('characteristicvaluechanged', (e) => { const v = e.target.value; const r = pending.get(v.getUint8(0) + ':' + v.getUint8(3)); if (r) r(); });
    await resp.startNotifications();
  } catch (err) { onEvent({ type: 'warn', message: 'no command responses: ' + err.message }); }

  await send(LED(0x01), 500);                                  // stops the pairing LED sweep = visible "connected" cue
  await send(FEATURE_SET(mask), 500);
  await send(FEATURE_ENABLE(mask), 500);
  inputChar.addEventListener('characteristicvaluechanged', (e) => {
    const dv = e.target.value; lastReportAt = performance.now();
    onReport(new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)), lastReportAt);   // copy: the buffer may be reused
  });
  await inputChar.startNotifications();

  keepTimer = setInterval(() => { if (alive && performance.now() - lastWriteAt > 900) write(LED(0x01)).catch(() => {}); }, 1000);   // macOS keep-alive
  const t0 = performance.now(); let stage = 0;
  watchdog = setInterval(() => {                               // no data: re-enable, then widen the feature mask
    if (!alive || performance.now() - lastReportAt < 1500) return;
    const waited = performance.now() - Math.max(t0, lastReportAt);
    if (stage === 0 && waited > 2000) { stage = 1; write(FEATURE_ENABLE(mask)); onEvent({ type: 'warn', message: 'no data 2 s: re-sent enable' }); }
    else if (stage === 1 && waited > 4500) { stage = 2; write(FEATURE_SET(0xFF)); write(FEATURE_ENABLE(0xFF)); onEvent({ type: 'warn', message: 'no data 4.5 s: retrying with mask 0xFF' }); }
    else if (stage === 2 && waited > 9000) { stage = 3; onEvent({ type: 'error', message: 'no input data' }); }
  }, 500);
  return { side, write, vibrate: (id) => write(VIBRATE(id)), close: () => { alive = false; clearInterval(keepTimer); clearInterval(watchdog); device.gatt.disconnect(); } };
}
```

---

## 6. Input report 0x05 (characteristic `...7fd2`)

Length: **63 bytes** (0x3F; `[ND-HID]` table ends with a reserved byte at 0x3E; `[SEI]` "63-byte data packets"; both real captures below are exactly 63). Little endian everywhere. Accept `length >= 60` (0x3C); the IMU fields end at 0x3B. `[JG-PROTO]`'s parser accepts >= 0x3B.

### 6.1 Layout (H unless noted)

| Offset | Size | Type | Field | Conf | Sources / notes |
|---|---|---|---|---|---|
| 0x00 | 4 | u32 | **Counter / clock.** DISPUTED (D5): `[ND-HID]` "increments by 1 each report" (documented for USB/console); `[JG-PROTO]` "in practice a millisecond clock" (parses it as u24). In both real captures it behaves like a ~1 kHz clock that started 3-4 s before the IMU clock (counter/1000 = 26.4 s vs IMU 22.2 s; 9.3 s vs 6.3 s). | M | treat as opaque, monotonic; **do not use for loss detection or dt** |
| 0x04 | 4 | u32 | **Buttons** (6.2) | H | `[ND-HID]` `[PS-CODE]` `[YUJI]` `[LOY]` `[JG-PROTO]` `[MASCII]` |
| 0x08 | 2 | | unknown, `FF 0F` in both real captures | M | `[ND-HID]` |
| 0x0A | 3 | 12+12 bit | **Left stick field** (6.3) | H | |
| 0x0D | 3 | 12+12 bit | **Right stick field** | H | |
| 0x10 | 2 | u16 | optical mouse X, absolute, wraps mod 65536 (feature 0x10, Joy-Con only) | H | `[ND-HID]` `[PS-CODE]` `[MASCII]` |
| 0x12 | 2 | u16 | optical mouse Y | H | |
| 0x14 | 2 | u16 | mouse surface quality | M | |
| 0x16 | 2 | u16 | mouse lift-off distance (0 = no surface) | M | |
| 0x18 | 1 | | unknown, 0 | M | |
| 0x19 | 6 | 3 x i16 | **magnetometer X/Y/Z** (feature 0x80), 0.15 uT/LSB (AKM AK09919) | M, D3 | `[ND-HID]` `[PS-CODE]`. `[SEI]` `[YUJI]` `[JG-PROTO]` read it at 0x18 (off by one; gives about 5900 uT, absurd). With 0x19 real capture V2 gives about 121 uT, large but plausible with magnets and hard iron. |
| 0x1F | 2 | u16 | **battery voltage in mV** | H | `[ND-HID]` `[OZ]` `[PS-CODE]` `[SEI]` (3.60 V shown for 3595) |
| 0x21 | 1 | u8 | charge state/rate (0 unplugged in captures; "rises and settles on 0x34", "0x20 when full" per `[ND-HID]`) | L | |
| 0x22 | 2 | i16 | battery current (feature 0x20); `[FR-CPP]` says 100 = 1 mA | L, D4 | `[YUJI]` `[JG-PROTO]` read 0x28, which is 0 in real captures |
| 0x24 | 5 | | zeros | M | |
| 0x29 | 1 | u8 | marker, always `01` (joycon2cpp uses it to recognise report 0x05) | M | `[ND-HID]` `[FR-CPP]` |
| 0x2A | 4 | u32 | **IMU timestamp, microseconds** | M (units, D6b) | `[ND-HID]`; `[SDL]` reads the same bytes (`data[0x2b..0x2e]`; its USB buffers start one byte earlier, presumably a report id prefix). SDL: "normally microseconds but sometimes something else". |
| 0x2E | 2 | i16 | **temperature**, deg C = 25 + raw / 127 (`[ND-HID]`: 1/126.9) | H | `[PS-PROTO]` `[FR-CPP]` `[YUJI]` `[SEI]`. Real captures: raw 5 and 8 = 25.0 and 25.1 deg C. |
| 0x30 | 6 | 3 x i16 | **accel X, Y, Z** | H | all sources |
| 0x36 | 6 | 3 x i16 | **gyro X, Y, Z** | H | all sources |
| 0x3C | 1 | u8 | left analog trigger (**GameCube pad only**, ignore for Joy-Con) | H | |
| 0x3D | 1 | u8 | right analog trigger (GameCube only) | H | |
| 0x3E | 1 | | reserved | H | |

**Do not use the field table in the `joycon2cpp` README.** It lists sticks at 0x08/0x0B, mouse at 0x0E, magnetometer at 0x16, battery at 0x1C/0x1E, temperature "5f 0e" at 0x2E. Those offsets are shifted for everything below 0x30 and its own worked example mislabels bytes (D2). Its *code* (`JoyConDecoder.cpp`) uses the correct offsets. The IMU offsets 0x30/0x36 are identical in every source, including `[NF]` (`data[48:50]`, `data[54:56]`) and `[SDL]`.

### 6.2 Buttons: u32 at 0x04 (H)

Five independent implementations agree on the bit positions once byte windows are aligned (`[ND-HID]` table, `[PS-CODE]` masks, `[YUJI]` masks shifted by 8 bits, `[LOY]` and `[MASCII]` byte offsets, `[JG-PROTO]`). `[FR-CPP]` labels B and X the other way round (naming/DS4 mapping), the only outlier.

| Byte (offset) | 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x20 | 0x40 | 0x80 |
|---|---|---|---|---|---|---|---|---|
| 0 (0x04) | Y | X | B | A | SR (right unit) | SL (right unit) | R | ZR |
| 1 (0x05) | Minus | Plus | Right stick click | Left stick click | Home | Capture | C | (none) |
| 2 (0x06) | Down | Up | Right | Left | SR (left unit) | SL (left unit) | L | ZL |
| 3 (0x07) | GR | GL | (none) | (none) | headset (Pro only) | (none) | (none) | (none) |

- **Bits `0xE0` of byte 3 (0x07) are set in every real capture** (`E0 FF 0F` at 0x07-0x09 in both the Left and Right packet) and are undefined. **Mask them out**; test only documented bits. The parser in 7.7 lists exactly the documented bits.
- A right Joy-Con only uses byte 0 and byte 1; a left Joy-Con uses bytes 1 and 2 (`[MASCII]` reads byte 6 for L and byte 4 for R).
- With mask `0xFF`, ZL/ZR can appear "pressed" on Joy-Cons (`[PS-PROTO]`). No source reports phantom bits with `0x37` or `0xB7` (UNVERIFIED-ON-HARDWARE, UOH-10). The game ignores RECENTER edges for 1.5 s after the watchdog changed the mask (`INPUT_CONFIG.action.recenterHoldOffMs`).
- **Recenter button (ADVISORY):** the strap may cover buttons. Accept the rising edge of any of: A, B, X, Y, R, ZR, L, ZL, SL, SR, Plus, Minus, Capture, C, stick click. **Avoid Home** (the console uses it for wake/power functions; side effects on a non-console host are unknown).

### 6.3 Sticks (H for encoding, M for field assignment)

Three bytes little endian form one 24-bit value: **X = value & 0xFFF, Y = value >> 12**, each 0-4095, uncalibrated (`[ND-HID]`, `[PS-CODE]`, `[YUJI]`, `[LOY]`, `[FR-CPP]`).
Assignment: a **Left** Joy-Con reports its stick in the field at **0x0A**, a **Right** one in the field at **0x0D** (`[PS-PROTO]` "verified in practice", `[FR-CPP]` code, `[LOY]`, `[JG-PROTO]`). The other field holds constant or garbage data (`[JG-PROTO]`): the real Right capture shows a constant `FF F7 7F` (2047,2047) in the left field. The Left real capture shows `FF F7 7F` at 0x0A, which is either a perfectly centred stick or the same constant, and `23 28 7A` at 0x0D, so the Left assignment is only M. The game does not need sticks. Rest position is not 2048 and varies per unit and axis (`[JG-PROTO]` measured L rest 2080/2157, R 2014/2022, travel about 900-3400); factory calibration lives in flash (`[ND-MEM]`, not needed).

---

## 7. Motion data (IMU)

### 7.1 Scales (accel H, gyro M and DISPUTED)

| Quantity | Conversion | Conf | Sources |
|---|---|---|---|
| Accelerometer | **g = raw / 4096** (full scale +-8 g, 8/32767 g per LSB) | **H** | `[ND-HID]` `[SDL]` `[JG-DSU]` (measured: "at rest gravity reads exactly 1.00 g") `[FR-CPP]` `[TL]`. My check on the two real captures: accel magnitude 1.0014 g and 1.0062 g (section 10). |
| Gyroscope | **deg/s = raw x 2000 / 32768 = raw x 0.06103515625** (full scale +-2000 dps, 16.384 LSB per deg/s) | **M** | `[ND-HID]` "default FSR +-2000 dps"; `[SDL]` uses `34.8 rad/s / INT16_MAX` = 1994 deg/s full scale (40.0 rad/s when the timestamp is not in microseconds); `[JG-DSU]` `MotionConverter` uses 0.06103515625 and calls the Switch 1 scales "verified on Joy-Con 2"; `[TL]` assumes 1/16.4. The ndeadly repository's `datasheets/` folder contains the TDK ICM-42670-P datasheet (file listing only; I did not open the PDF), which suggests that IMU; that part's +-2000 dps range is 16.4 LSB per deg/s (general datasheet knowledge, not verified here). L for the part identity. |

### 7.2 The disputed gyro scale (D1) and what to do about it

`joycon2cpp` (README + `DsuServer.cpp`: `gyro * 360 / 48000`), `JoyCon2Mac` (`JoyConDecoder.cpp`: `360/48000`) and the `joycon2android` protocol table say **"48000 = 360 deg/s"**, i.e. 0.0075 deg/s per LSB, a factor **8.14 smaller** than the value above. The joycon2cpp README credits a third party for the layout; the other two carry the same figure and appear to be copied from it (inference). The +-2000 dps value has three independent supports (datasheet-based `[ND-HID]`, SDL source with hardware testing over USB, joycon2android's own motion code). At-rest gyro readings in the real captures are (-2, 4, 2) and (7, -1, 19) LSB, i.e. up to 1.2 dps under the +-2000 scale (typical MEMS zero-rate offset; `[JG-DSU]` observed +0.2 and +0.9 dps biases) but only 0.14 dps under the 48000 scale (implausibly good).

**Decision (NORMATIVE):** default `GYRO_DPS_PER_LSB = 2000/32768`, exposed as a setting. **Calibration wizard (required step, UOH-6):** the player rotates the sword one full revolution about any axis at moderate speed between two button presses; the app integrates |omega| dt and computes `scale = 360 / integrated`. The wizard must not assume either candidate: `measuredScale = defaultScale x 360 / integratedDegrees`. An integrated angle of about 360 deg confirms the default; about 2930 deg (= 360 x 8.14) means the true scale is 0.0075; any other value is used as measured (and shown as a warning if it is far from both candidates). Store and use the measured factor. The owner can also do this in 30 seconds on the diagnostics page.

### 7.3 Timing: timestamp, dt, rate and latency

- **One motion sample per notification, no batching.** Report 0x05 carries a single accel+gyro sample (`[ND-HID]` motion data, 0x12 bytes). `[JG-DSU]`: "The Joy-Con reports once per BLE connection interval." So the IMU rate seen by the game equals the notification rate.
- **Rates by path:**

| Path | Rate | Conf | Source |
|---|---|---|---|
| USB | 250 Hz (4 ms) | H | `[SDL]` (sensor rate 250, timestamp calibration expects 4 ms) |
| Switch 2 console over BLE | 5 ms interval (about 200 Hz), set by a vendor HCI command; the controller never sends a connection-parameter request | H | `[ND-BT]` |
| macOS CoreBluetooth | about **66 Hz**, "gives the host no control over it" | M (D6) | `[PS-PROTO]` §9. His code comments assume 33 Hz for the UI refresh, so this is not consistent inside that project. |
| Android balanced / high priority | 30 ms (33 Hz) / 15 ms (67 Hz), measured | H | `[JG-DSU]` |
| Windows default | 60 ms (16.7 Hz) | H | `[ND-BT]` |
| **Chrome on macOS 26.6 + Apple N1** | **unknown: measure it** (Web Bluetooth has no API to set connection parameters or MTU) | UOH-4 | |

  A flick lasts 40-80 ms and at 30 ms sampling "its crest is often missed entirely" (`[JG-DSU]` tools README). For sword swings (100-300 ms) this means 3-20 samples per swing: enough for orientation integration, coarse for peak-speed detection. Compute blade speed from the orientation change between samples, not from a single gyro sample.
- **Delta time (NORMATIVE):** `dtUs = (ts[n] - ts[n-1]) >>> 0` (u32 wrap-safe; V3 test in section 10). Accept `0 < dtUs < 200000`. Because "some controllers don't seem to report this correctly" (`[ND-HID]`) and SDL found the base is sometimes not microseconds, validate: over each 1-second window compare `sum(dtUs)/1000` with the wall-clock span of arrivals; if the ratio is within 0.8-1.25 trust the timestamps, otherwise fall back to arrival times (`performance.now()` captured in the notification handler) and show a warning on the diagnostics page. Never use the counter at 0x00.
- **Clock alignment:** map controller time to local time with a running minimum of `(arrival - ts/1000)`; this removes burst jitter and gives a latency estimate.
- **Latency budget (ADVISORY, UOH-18):** average half connection interval (about 7.5 ms at 15 ms) + BLE stack and Chrome IPC (few ms, unmeasured) + frame alignment (average 8 ms at 60 fps) + display: about 35-50 ms, so the < 50 ms target is at the edge. Mitigate by rendering the blade at the *current* frame time using the last orientation and angular velocity (clamped extrapolation of at most one connection interval), and by draining all queued reports every frame before simulating.
- **Notification handler:** copy the bytes, timestamp with `performance.now()`, parse, push to a ring buffer. Do not allocate per packet beyond that and do no rendering work. 66 x 63 B = 4 KB/s, throughput is not an issue.

### 7.4 Axes and frames (what is known, what is not)

Raw order in the report is X, Y, Z for both accel and gyro (12 consecutive bytes each). The parser returns them as-is ("sensor frame").

| Statement | Conf | Source |
|---|---|---|
| **Right** Joy-Con raw frame, measured: +X = the controller's right, +Y = toward the tail, +Z = out of the button face; the accel-to-cemuhook mapping is `(-ax, -az, +ay)` and gyro `pitch=+gx, yaw=-gz, roll=+gy` (sign fit done for the right Joy-Con only) | M (single hardware source, terms "right/tail" are the author's) | `[JG-DSU]` `MotionConverter.kt` |
| **Left** Joy-Con and Pro are "assumed to share the raw frame - unverified" | L | `[JG-DSU]` |
| SDL's base mapping for both L and R is `x = raw x, y = raw z, z = -raw y` and the same for gyro (then rotated +-90 deg for a lone sideways Joy-Con) | H (code) | `[SDL]` |
| Both real stationary captures show **+1 g mostly on raw Z** (Left: (-66, 437, 4078); Right: (-1311, 1250, 3702)). Together with the first row this suggests Z is the face-normal axis, +Z out of the face when the unit is lying face-up. **Neither capture says which pose the unit was in**, so this cannot settle the accelerometer sign convention (audit P3, UOH-20) | M (inference) | this report |
| The frame is not guaranteed right-handed in the DS4-style output; gyro handedness must be checked against gravity | M | `[JG-DSU]` "the signs are DS4 hardware history" |

**Consequences for the motion pipeline (NORMATIVE):**
1. Never bake in "the blade is along axis N". Discover it: (a) still period gives the gravity direction in the sensor frame; (b) a swing gives the dominant rotation axis (gyro principal axis) and the blade direction relative to gravity in the rest pose the player holds; (c) let the player state which side of the sword faces forward only if needed.
2. **Gyro sign/handedness self-test** (from `[JG-DSU]` tools README, ADVISORY): for a slow single-axis turn between two still holds, gravity (unit vector) before `a0` and after `a1` implies the body turned about `-(a0 x a1)`; that direction must agree with the integral of the gyro over the same span. Antiparallel means the gyro sign convention is mirrored relative to accel: negate the gyro vector. This works for Left and Right and needs no prior knowledge (UOH-7).
3. Yaw turns about gravity and is invisible to accel, so yaw sign can only be validated against the on-screen response; provide a "flip horizontal" toggle in the wizard.

### 7.5 Bias and noise

- Gyro idles with a constant offset (`[JG-DSU]`: +0.2 dps yaw, +0.9 dps roll observed; real captures: up to 1.2 dps). Estimate at rest: `[JG-DSU]` adopts the mean of 240 consecutive samples when the spread is at most 40 LSB (about 2.4 dps). At 66 Hz that is 3.6 s; use about 1 s and spread <= 40 LSB, re-estimate whenever the sword is still (also gate on |a| = 1.00 +- 0.03 g).
- Factory gyro and accel offsets exist in flash (float triplets at 0x13040 and 0x13100 per `[SDL]`) but reading them needs the SPI-read command (D8) and buys little. Not needed.
- Simulator noise suggestion (UOH, not measured): gyro bias uniformly within +-1.5 dps, white noise sigma 0.15 dps, accel noise sigma 0.004 g.

### 7.6 Temperature, battery

- Temperature: 25 + raw/127 deg C (real captures: 25.04 and 25.06). Only for the diagnostics page.
- Battery: show **millivolts**; the real captures show 3679 mV and 3595 mV. `[JG-PROTO]` says the packet voltage reads about 0.6 V below the cell (about 3.30 V displays as 75 % and about 3.60 V as 100 % on a Switch 2) and interpolates Nintendo's thresholds; `[OZ]` assumes a 3.0-4.45 V scale. They disagree: there is no trustworthy state-of-charge mapping (UOH-17). Use three colour bands only (suggestion: >= 3.55 V ok, 3.30-3.55 V amber, < 3.30 V red) and label it approximate.

### 7.7 Reference parser (NORMATIVE layout, ADVISORY code)

Pure ES module, no DOM. Verified against the three vectors in section 10 (two real, one synthetic) and by a 20 000-case random round-trip against the builder in Appendix A, and cross-checked against an independent Python implementation.

```js
// Reference parser for Joy-Con 2 input report 0x05 (characteristic ...fd2). Pure function, no DOM.
export const ACCEL_G_PER_LSB = 1 / 4096;            // exact
export const GYRO_DPS_PER_LSB = 2000 / 32768;       // 0.06103515625, exact in binary
export const MIN_LEN = 0x3C;                        // 60 bytes needed for IMU fields; real reports are 63 bytes

// [byteOffset, bitMask, name]. Bits not listed (e.g. 0xE0 in byte 7) are deliberately ignored.
export const BUTTON_TABLE = [
  [4,0x01,'Y'],[4,0x02,'X'],[4,0x04,'B'],[4,0x08,'A'],[4,0x10,'SR_R'],[4,0x20,'SL_R'],[4,0x40,'R'],[4,0x80,'ZR'],
  [5,0x01,'MINUS'],[5,0x02,'PLUS'],[5,0x04,'R_STICK'],[5,0x08,'L_STICK'],[5,0x10,'HOME'],[5,0x20,'CAPTURE'],[5,0x40,'C'],
  [6,0x01,'DOWN'],[6,0x02,'UP'],[6,0x04,'RIGHT'],[6,0x08,'LEFT'],[6,0x10,'SR_L'],[6,0x20,'SL_L'],[6,0x40,'L'],[6,0x80,'ZL'],
  [7,0x01,'GR'],[7,0x02,'GL'],
];

function stick12(dv, o) {                            // 3 bytes LE -> two 12-bit values
  const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
  return { x: v & 0xFFF, y: v >>> 12 };
}

export function parseInputReport(bytes, side = '?') {
  if (!bytes || bytes.length < MIN_LEN) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const s16 = (o) => dv.getInt16(o, true);
  const pressed = BUTTON_TABLE.filter(([o, m]) => (dv.getUint8(o) & m) !== 0).map((b) => b[2]);
  const accelRaw = { x: s16(0x30), y: s16(0x32), z: s16(0x34) };
  const gyroRaw = { x: s16(0x36), y: s16(0x38), z: s16(0x3A) };
  const leftField = stick12(dv, 0x0A);
  const rightField = stick12(dv, 0x0D);
  const tempRaw = s16(0x2E);
  return {
    length: bytes.length,
    counter: dv.getUint32(0, true),
    buttonsRaw: dv.getUint32(4, true),
    pressed,
    stickFields: { left: leftField, right: rightField },
    stick: side === 'R' ? rightField : leftField,      // '?' falls back to the left field
    mouse: { x: dv.getUint16(0x10, true), y: dv.getUint16(0x12, true), quality: dv.getUint16(0x14, true), lift: dv.getUint16(0x16, true) },
    magRaw: { x: s16(0x19), y: s16(0x1B), z: s16(0x1D) },
    batteryMv: dv.getUint16(0x1F, true),
    chargeState: dv.getUint8(0x21),
    batteryCurrentRaw: s16(0x22),
    imuMarker: dv.getUint8(0x29),
    imuTimestampUs: dv.getUint32(0x2A, true),
    temperatureRaw: tempRaw,
    temperatureC: 25 + tempRaw / 127,
    accelRaw, gyroRaw,
    accelG: { x: accelRaw.x * ACCEL_G_PER_LSB, y: accelRaw.y * ACCEL_G_PER_LSB, z: accelRaw.z * ACCEL_G_PER_LSB },
    gyroDps: { x: gyroRaw.x * GYRO_DPS_PER_LSB, y: gyroRaw.y * GYRO_DPS_PER_LSB, z: gyroRaw.z * GYRO_DPS_PER_LSB },
    triggerL: dv.getUint8(0x3C), triggerR: bytes.length > 0x3D ? dv.getUint8(0x3D) : 0,
    imuActive: [0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39,0x3A,0x3B].some((o) => dv.getUint8(o) !== 0),
  };
}
export const imuDeltaUs = (prev, cur) => (cur - prev) >>> 0;   // u32 wrap-safe
export const hexToBytes = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
```

---

## 8. Web Bluetooth verdict

**Verdict: YES on paper.** Chrome (154 installed on this Mac) on macOS can perform the entire flow: scan by manufacturer data, connect, reach the vendor service, write commands without response, receive notifications. **Confidence M** because nobody has verified this exact stack (Chrome 154, macOS 26.6, Apple N1, real Joy-Con 2). All of it is **UOH**. *Update 2026-09-30: on the first real test Chrome's chooser listed no device on the owner's Mac (cause unknown, `docs/hardware-findings.md`), while a native CoreBluetooth probe did the whole flow; the native bridge of section 9 was built for that reason and is now the recommended path. The paper verdict above stays as the description of the Web Bluetooth path.*

Evidence and requirement checklist:

| Requirement | Finding | Conf | Source |
|---|---|---|---|
| Secure context | `http://localhost:8137` is a secure context; Web Bluetooth needs HTTPS or localhost. Do not use a LAN IP. | H | Chrome docs `[BCD]` |
| User gesture | `requestDevice` must be triggered by a click/pointerup/touchend. | H | `[BCD]` Chrome docs |
| `manufacturerData` filters | Chrome 92+ (installed 154). Chromium's macOS adapter exposes CoreBluetooth manufacturer data (company id LE + rest) to the filter matcher. | H | `[BCD]` `[CHR]` |
| Filter must be present at scan time | Pairing-mode adverts contain manufacturer data (that is the only content besides flags). | H | `[ND-BT]` |
| `optionalServices` | Needed for `ab7de9be-...7fd0`; not blocklisted. | H | `[BLOCK]` `[MASCII]` |
| Write without response | Chrome 85+; on macOS mapped to `CBCharacteristicWriteWithoutResponse`, promise resolves immediately. The command characteristic is WRITE_NO_RESPONSE. | H | `[BCD]` `[CHR]` `[ND-BT]` |
| Notifications | `startNotifications()` writes the CCC; each CoreBluetooth `didUpdateValue` becomes one `characteristicvaluechanged` event, no coalescing in that layer. 66 x 63 B is trivial throughput. | H (code), UOH-4 (rate) | `[CHR]` |
| A working public implementation | `mascii` demo does requestDevice with manufacturerData + `optionalServices`, connects, writes LED/feature commands and subscribes to `...7fd2`. It only decodes buttons and mouse, not IMU. | M | `[MASCII]` |
| No SMP | Chrome/CoreBluetooth do not pair unless a characteristic requires encryption; none does. | M | `[PS-CODE]` (same reasoning) |
| MTU | CoreBluetooth negotiates the ATT MTU itself; native macOS clients receive full 63-byte notifications. Web Bluetooth cannot set it. If notifications ever arrive truncated to 20 bytes the parser rejects them (length check) and diagnostics shows the length. | M, UOH-3 | `[SEI]` `[PS-CODE]`; Android needed `requestMtu(247)` (`[JG-PROTO]`) |
| One GATT op at a time | Chrome docs recommend manual queueing; Chromium macOS returns "in progress" on overlapping ops per characteristic. | H | `[BCD]` `[CHR]` |
| Reconnect without chooser | `getDevices()` is behind `#enable-experimental-web-platform-features`. **Do not use.** The chooser appears every session. | H | `[BCD]` |
| macOS permission | Chrome needs Bluetooth permission (System Settings > Privacy & Security > Bluetooth). First `requestDevice` triggers the system prompt. | M, UOH-16 | standard macOS behaviour; `[ML]` describes the same for its app |
| Tab must stay foreground | Timers in hidden tabs are throttled (keep-alive, watchdog). Show a warning when `document.hidden`. | M | general Chrome behaviour |

**What Web Bluetooth cannot do (accept these limits):** request connection interval or MTU (so no 200 Hz), reconnect silently, run in the background, read the host Bluetooth address (so no application-layer bonding), write to descriptor `0x2902` manually (not needed).

**Concrete options to pass** (full code in 5.6; this example is the `strict` variant, which is no longer the game's default since 2026-09-30, see 3.3):

```js
const mask = Uint8Array.of(0,0,0,0,0, 0xFF,0xFF, 0,0,0, 0xFF,0xFF,0xFF,0xFF,0xFF,0xFF);   // PID + host address
navigator.bluetooth.requestDevice({
  filters: [
    { manufacturerData: [{ companyIdentifier: 0x0553, mask,
        dataPrefix: Uint8Array.of(0,0,0,0,0, 0x67,0x20, 0,0,0, 0,0,0,0,0,0) }] },   // Left, pairing mode
    { manufacturerData: [{ companyIdentifier: 0x0553, mask,
        dataPrefix: Uint8Array.of(0,0,0,0,0, 0x66,0x20, 0,0,0, 0,0,0,0,0,0) }] },   // Right, pairing mode
  ],
  optionalServices: ['ab7de9be-89fe-49ad-828f-118f09df7fd0'],
});
```

**Five signs that the Web Bluetooth path does not work on a Mac** (they were written as the triggers for a fallback before the first real test; the fallback of section 9 now exists, and these remain the things to look at on the diagnostics page's Web Bluetooth mode): (1) the chooser never lists the controller with the lenient filter and with `acceptAllDevices` while the SYNC LEDs sweep (**this happened on 2026-09-30 with the old strict filter; the lenient and all filters were not tried before the bridge was built**); (2) `getPrimaryService` or `getCharacteristics` keeps timing out; (3) the link drops within 20 s even with the 1 Hz keep-alive; (4) the measured notification rate stays below 20 Hz; (5) `startNotifications` on the input characteristic fails repeatedly.

---

## 9. The native Bluetooth bridge (built 2026-09-30)

The bridge is described, as built, in `docs/native-bridge.md` (architecture, the helper's JSON-lines protocol, the HTTP and Server-Sent Events endpoints, the security model, the macOS permission, the string keys, the open items). This section keeps the toolchain audit that decided the language and summarises how the built bridge differs from the specification that stood here before.

### 9.1 Toolchain audit of this Mac (`[LOCAL]`, measured 2026-09-30)

| Item | Result |
|---|---|
| OS / Bluetooth | macOS 26.6 (25G72); Apple N1 Bluetooth chip (PCIe), state On |
| Chrome | 154.0.8037.58 (>= 92, so manufacturerData filters exist) |
| Node | v24.15.0. **No BLE API.** A BLE library (noble) would be an npm dependency, which violates the project rule. |
| Python | 3.14.7 (Homebrew), pip 26.2.1. **`bleak` is NOT installed** (`import bleak` fails). `pip install bleak` needs network and pulls PyObjC CoreBluetooth wrappers: a dependency, which the project rules do not allow (so the bridge is not written in Python). |
| Swift | Apple Swift 6.1.2 from the Command Line Tools (`/Library/Developer/CommandLineTools`, no Xcode.app). **Currently broken:** compiling anything that imports `Foundation` or `CoreBluetooth` fails with `error: redefinition of module 'SwiftBridging'` because a stale root-owned `/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap` (2023) sits next to `bridging.modulemap` (2025). |
| Workaround (verified) | A non-invasive clang VFS overlay that hides the stale file: `swiftc -vfsoverlay overlay.yaml -Xcc -ivfsoverlay -Xcc overlay.yaml file.swift`, where `overlay.yaml` maps `/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap` to an empty file. With it, a minimal CoreBluetooth scanner **typechecked and compiled** to an arm64 binary. I did **not run** it (running would trigger a Bluetooth permission prompt and scan). Permanent fix (needs admin, not done by us): delete that stale file or reinstall the Command Line Tools. |

### 9.2 What was built, and how it differs from the earlier specification

The bridge follows the plan of this section as it stood until 2026-09-30 (a native helper spawned by `server.js`, the same `parseInputReport` on its hex, `GET` events as Server-Sent Events, the Terminal as the responsible process for the Bluetooth permission), with these differences. The authoritative description is `docs/native-bridge.md`; section 3 of that document is the protocol as built.

| Earlier specification | As built |
|---|---|
| A Swift helper (`tools/joycon-bridge.swift`) with a clang overlay for the broken module map | An **Objective-C** helper (`bridge/joycon-bridge.m`) compiled with plain `clang` by `bridge/build.sh` (Swift is not used: the stale `module.modulemap` of 9.1 breaks every Swift build on this Mac) |
| stdout lines `{"t":"status",...}` and `{"t":"report","ms":...,"hex":...}`, stdin `connect`, `write`, `disconnect` | stdout lines `{"type":"hello",...}`, `{"type":"status","state":...,"code":...}`, `{"type":"advert",...}`, `{"type":"report","t":...,"hex":...}`, `{"type":"response",...}`; stdin `connect` (with `side`, `scanSeconds`, `keepAliveHz`, `mask`, `pairingOnly`), `disconnect`, `rumble`, `quit`. There is no generic `write`: the helper only ever writes the game's own frames to the command characteristic |
| `GET /bridge/events`, `POST /bridge/command`, `/bridge/connect`, `/bridge/disconnect` | `GET /__bridge/status`, `GET /__bridge/events`, `POST /__bridge/connect`, `/__bridge/disconnect`, `/__bridge/rumble`, each with an Origin rule and a custom header (docs/native-bridge.md 5) |
| `?input=bridge` (a name that was only reserved) | `?input=native` (the name `bridge` is ignored with a warning) |
| Keep-alive, init sequence and filter "as in 3.1, 5.4, 5.5" | The init sequence of 5.4 exactly as the native probe ran it (subscribe to the responses, LED, feature SET and ENABLE with mask 0xB7, subscribe to the input characteristic); the 1 Hz LED keep-alive of 5.5 in the helper; **no retry loop of any kind**; the advert choice prefers a pairing-mode advert (host address all zero) and falls back to the strongest Joy-Con 2 advert after a 1.5 s collection window (`pairingOnly` restores the strict rule) |

Benefits and limits are as predicted: no chooser, a native keep-alive immune to browser timer throttling, and no change to the report rate (same CoreBluetooth, same connection interval). Everything that needs the real helper and a real Joy-Con (Terminal's permission, the advert choice, the keep-alive over minutes, the Left unit, rumble, the behaviour after a disconnect) is listed as UOH-21 to UOH-33 in section 12.

---

## 10. Test vectors (parser unit tests)

Three 63-byte packets. **V1 and V2 are real captures published by third parties (not by us). V3 is synthetic**, built from the documented layout. Expected values were produced by the reference parser of 7.7, cross-checked with an independent Python parser (all fields identical) and, for V2, against the values printed by the tool that captured it. Units: accel g = raw/4096, gyro dps = raw x 0.06103515625 (exact binary fractions, compare exactly), temperature 25 + raw/127 (tolerance 1e-4).

### V1: real, Left Joy-Con 2, lying still, mask 0x37 sent through joycon2cpp's console-style init (hence mag bytes are zero)
Provenance: TheFrano/joycon2cpp README (MIT). Decoded here with the layout of section 6, not with that README's field table.

```
08670000000000e0ff0ffff77f23287a0000000000000000000000000000005f0e007907000000000001ce7b52010500beffb501ee0ffeff04000200000000
```

| Field | Expected |
|---|---|
| side passed to parser | L |
| length | 63 |
| counter (0x00) | 26376 |
| buttonsRaw (0x04) | 0xE0000000 |
| pressed | (none) |
| stick field left (0x0A) x, y | 2047, 2047 |
| stick field right (0x0D) x, y | 2083, 1954 |
| stick (side-selected) x, y | 2047, 2047 |
| mouse x, y, quality, lift | 0, 0, 0, 0 |
| magnetometer raw x, y, z (0x19) | 0, 0, 0 |
| battery mV (0x1F) | 3679 |
| charge state (0x21) | 0x00 |
| battery current raw (0x22) | 1913 |
| IMU marker (0x29) | 1 |
| IMU timestamp us (0x2A) | 22182862 |
| temperature raw / deg C (0x2E) | 5 / 25.0394 |
| accel raw x, y, z | -66, 437, 4078 |
| accel g x, y, z | -0.01611328125, 0.106689453125, 0.99560546875 |
| gyro raw x, y, z | -2, 4, 2 |
| gyro dps x, y, z | -0.1220703125, 0.244140625, 0.1220703125 |
| accel magnitude (g) | 1.0014 |
| analog triggers (0x3C, 0x3D) | 0, 0 |
| imuActive | true |

### V2: real, Right Joy-Con 2, held still-ish, mask 0xFF (mag and mouse sensor populated)
Provenance: seitanmen/Joycon2forMac README (MIT). That tool prints bytes without zero padding; padded here. The tool itself printed: PacketID 9295, RightStick X=2060 Y=1938, Accel (-1311, 1250, 3702), Gyro (7, -1, 19), Battery 3.60 V, Temperature 25.1 deg C. The parser reproduces all of them. (The tool's own magnetometer and battery-current values used off-by-one offsets and are not reproduced.)

```
4f240000000000e0ff0ffff77f0c287900000000ff11090c0047ff8a0245fe0b0e00760700000000000162d260000800e1fae204760e0700ffff1300000000
```

| Field | Expected |
|---|---|
| side passed to parser | R |
| length | 63 |
| counter (0x00) | 9295 |
| buttonsRaw (0x04) | 0xE0000000 |
| pressed | (none) |
| stick field left (0x0A) x, y | 2047, 2047 |
| stick field right (0x0D) x, y | 2060, 1938 |
| stick (side-selected) x, y | 2060, 1938 |
| mouse x, y, quality, lift | 0, 0, 4607, 3081 |
| magnetometer raw x, y, z (0x19) | -185, 650, -443 |
| battery mV (0x1F) | 3595 |
| charge state (0x21) | 0x00 |
| battery current raw (0x22) | 1910 |
| IMU marker (0x29) | 1 |
| IMU timestamp us (0x2A) | 6345314 |
| temperature raw / deg C (0x2E) | 8 / 25.0630 |
| accel raw x, y, z | -1311, 1250, 3702 |
| accel g x, y, z | -0.320068359375, 0.30517578125, 0.90380859375 |
| gyro raw x, y, z | 7, -1, 19 |
| gyro dps x, y, z | 0.42724609375, -0.06103515625, 1.15966796875 |
| accel magnitude (g) | 1.0062 |
| analog triggers (0x3C, 0x3D) | 0, 0 |
| imuActive | true |

### V3: SYNTHETIC, Left Joy-Con 2, fast swing, buttons pressed
Constructed by the researcher, **not captured from hardware**. Exercises: masking of unknown button bits (byte 7 = `E0`), three buttons, live left stick with the right field constant, negative values, charging state, negative temperature offset, and an IMU timestamp 2000 microseconds before the u32 wrap.

```
45230100000141e0ff0fac8d25fff77f00000000000000000047ff8a0245fe0a0f34b80b00000000000130f8ffff02ff000800e00010004000e00800000000
```

| Field | Expected |
|---|---|
| side passed to parser | L |
| length | 63 |
| counter (0x00) | 74565 |
| buttonsRaw (0x04) | 0xE0410100 |
| pressed | MINUS, DOWN, L |
| stick field left (0x0A) x, y | 3500, 600 |
| stick field right (0x0D) x, y | 2047, 2047 |
| stick (side-selected) x, y | 3500, 600 |
| mouse x, y, quality, lift | 0, 0, 0, 0 |
| magnetometer raw x, y, z (0x19) | -185, 650, -443 |
| battery mV (0x1F) | 3850 |
| charge state (0x21) | 0x34 |
| battery current raw (0x22) | 3000 |
| IMU marker (0x29) | 1 |
| IMU timestamp us (0x2A) | 4294965296 |
| temperature raw / deg C (0x2E) | -254 / 23.0000 |
| accel raw x, y, z | 2048, -8192, 4096 |
| accel g x, y, z | 0.5, -2, 1 |
| gyro raw x, y, z | 16384, -8192, 8 |
| gyro dps x, y, z | 1000, -500, 0.48828125 |
| accel magnitude (g) | 2.2913 |
| analog triggers (0x3C, 0x3D) | 0, 0 |
| imuActive | true |

### Timestamp delta checks

| prev (us) | current (us) | expected `dtUs` |
|---|---|---|
| 4294965296 (V3) | 2000 | **4000** (u32 wrap) |
| 1000 | 16000 | 15000 (about 66 Hz step) |

### Sanity facts from the real captures (use as extra assertions)

- |accel| in g: V1 = 1.0014, V2 = 1.0062 (both within 1 % of 1 g, which supports 4096 LSB per g).
- Real captures V1 and V2 share `E0 FF 0F` at 0x07-0x09; V1 has zero magnetometer bytes (mask 0x37), V2 does not (mask 0xFF).

---

## 11. Disagreements register

| ID | Topic | Positions | Resolution used here |
|---|---|---|---|
| D1 | **Gyro scale** | 0.06103515625 dps/LSB (`[ND-HID]`, `[SDL]`, `[JG-DSU]`, `[TL]` assumption) vs 0.0075 dps/LSB "48000 = 360" (`[FR-CPP]`, `[OZ]`, `[JG-PROTO]` table) | Default 0.0610, configurable, mandatory full-turn check (7.2). |
| D2 | `joycon2cpp` README field table (sticks 0x08/0x0B, mag 0x16, battery 0x1C/0x1E) vs everyone else | its worked example mislabels bytes; its code uses correct offsets | Section 6 layout. |
| D3 | Magnetometer offset 0x19 (`[ND-HID]`, `[PS-CODE]`) vs 0x18 (`[SEI]`, `[YUJI]`, `[JG-PROTO]`) | 0x19 yields about 121 uT on V2, 0x18 yields about 5900 uT | 0x19. Game does not use the magnetometer. |
| D4 | Battery current offset 0x22 (`[ND-HID]`, `[OZ]`, `[PS-CODE]`) vs 0x28 (`[YUJI]`, `[JG-PROTO]`), units | 0x28 is 0 in real captures | 0x22, informational only. |
| D5 | Counter at 0x00: "+1 per report" (`[ND-HID]`) vs "millisecond clock" (`[JG-PROTO]`) vs u24/u32 width | real captures fit a ms clock; byte 3 is 0 in both | Parse as u32, treat as opaque. |
| D6 | macOS report rate: about 66 Hz (`[PS-PROTO]` §9) vs 33 Hz assumption in the same project's code comments; Android 33/67 Hz | | Expect 33-67 Hz, measure (UOH-4). |
| D6b | IMU timestamp always microseconds? (`[ND-HID]` yes, `[SDL]` "sometimes something else") | | Validate at runtime (7.3). |
| D7 | Feature mask: `0x37` (console, `[FR-CPP]`, but on another characteristic) vs `0xB7` (`[PS-CODE]`, macOS) vs `0xFF` (4 projects; phantom ZL/ZR per `[PS-PROTO]`) | all reported working, on their own channel | 0xB7 default (round 1 audit F1), 0xFF last resort, 0x37 expert option. |
| D8 | Header byte 2 for SPI/memory reads: `0x01` (`[ND-BT]` console BLE trace, `[PS-CODE]`) vs `0x00` needed (`[JG-PROTO]`: with 0x01 "gets no reply") | different hosts | The game does not read flash. If you add it, try 0x00 first, then 0x01. |
| D9 | macOS 10-17 s drop without writes: only `[PS-PROTO]`; other macOS clients silent | | Keep-alive anyway. |
| D10 | B and X labels: `[ND-HID]` `[PS-CODE]` `[YUJI]` `[LOY]` (B=0x04, X=0x02) vs `[FR-CPP]` (swapped) | naming in a DS4 mapping | Section 6.2 table. |
| D11 | LED payload length 8 (`[ND-CMD]` `[SDL]` `[MASCII]`) vs 4 (`[PS-PROTO]`) | | 8. |
| D12 | Company id 0x0553 only (`[ND-BT]`, all Joy-Con sources) vs "0x057E also seen" (`[ML]`, about the Pro) | | 0x0553, second filter entry only in the lenient fallback. |
| D13 | Whether the counter/timestamp can detect packet loss | | Do not rely on it; the sword pipeline tolerates gaps. |

---

## 12. UNVERIFIED-ON-HARDWARE register and owner verification

Everything about the physical controller is unverified by us. The items below are what the diagnostics page must let the owner check. Suggested **2-minute procedure** for `public/diagnostics.html` (the UI is the front-end's job): open `http://localhost:8137/diagnostics.html`, click Connect, hold SYNC until the LEDs sweep, select the controller, then:

1. Status reaches "streaming" within about 10 s; LEDs stop sweeping (UOH-1, 2, 3).
2. Packet length = 63; packet rate and inter-arrival histogram are shown (UOH-4). Record the number in this document.
3. Joy-Con flat and still for 3 s with the **buttons up**: |accel| shown = 1.00 +- 0.03 g; raw accel Z about +4096 (+1 g; if it reads -4096 the game needs `accelSign = -1`, UOH-20); gyro rest about 0 +- 3 dps; `imuActive` true.
4. Turn the unit one full revolution flat on the desk between two button presses: integrated angle shown; about 360 deg confirms the gyro scale, about 2930 deg means scale 0.0075 (UOH-6).
5. Press a few buttons; shown names match the labels (UOH-10).
6. Leave it connected for 60 s without touching anything: must stay connected (keep-alive on). Optional expert toggle "disable keep-alive" and see whether it drops at about 15 s (UOH-5).
7. Battery mV and temperature plausible (about 3.5-4.2 V, about 25 deg C).

| ID | Unverified item | Where it matters | How to check |
|---|---|---|---|
| UOH-1 | Chrome 154 on macOS 26.6 lists a Joy-Con 2 in pairing mode with the strict filter (zero host address, both sides). **2026-09-30: the advert layout is verified natively for the Right unit; Chrome did NOT list the controller with `strict` on the first real test (cause unknown); the game now defaults to `lenient`. What Chrome lists per filter is still unverified.** | scan | step 1; else lenient filter, then acceptAllDevices; `about://bluetooth-internals` shows adverts |
| UOH-2 | `gatt.connect()` + discovery + `getPrimaryService` complete within seconds despite the empty Generic Attribute service. **2026-09-30: natively about 0.6 s + 0.8 s for the Right unit; through Chrome still unverified.** | connect | step 1, log timings |
| UOH-3 | The default mask 0xB7 yields IMU data and full 63-byte notifications (no truncation) on the plain command characteristic; 0x37 has no evidence there. **2026-09-30: verified natively for the Right unit (0xB7 on the first attempt, 63-byte packets, marker 0x29 = `01`); through Chrome (MTU, truncation) still unverified; 0x37 still has no evidence.** | init | step 2/3; the diagnostics mask selector and the game's `?mask=` |
| UOH-4 | Actual notification rate and jitter in Chrome/macOS/N1 (33? 66? higher?). **2026-09-30: one native measurement, about 33.4 Hz over 14.5 s (jitter not reported); Chrome's rate unverified.** | motion quality, latency | step 2 |
| UOH-5 | The link survives with 1 Hz keep-alive; the ~15 s drop without it is real | stability | step 6 |
| UOH-6 | Gyro scale (0.0610 vs 0.0075 dps/LSB) | blade speed and aiming | step 4 |
| UOH-7 | Gyro sign vs accel frame; Left Joy-Con axes | calibration | gravity cross-product self-test (7.4) |
| UOH-8 | IMU timestamp is microseconds and monotonic; counter semantics | dt | diagnostics shows both ratios |
| UOH-9 | `679d5510-...` "report rate" descriptor: writing `85 00` before subscribing changes the rate? (ND lists it with a question mark, the console does it) | rate | expert-only experiment, off by default; nothing shows it helps |
| UOH-10 | Button names and phantom ZL/ZR with mask 0xFF | recenter button | step 5 |
| UOH-11 | Cooldown duration after repeated connects | UX | note the time when it happens |
| UOH-12 | Pairing advert lifetime; zero host address on both L and R units. **2026-09-30: zero host address verified natively for the Right unit (after SYNC); the Left unit and the advert lifetime are unverified.** | scan | step 1 |
| UOH-13 | Vibration preset 3 or 6 works as slice haptics on Joy-Con 2 and does not disturb streaming | polish | expert button on diagnostics |
| UOH-14 | State of the controller after page reload / tab close; whether SYNC restores pairing advert | UX | manual |
| UOH-15 | Command writes are not dropped at 1 Hz keep-alive + haptics (Chrome resolves writes immediately) | stability | keep spacing >= 100 ms |
| UOH-16 | macOS Bluetooth permission prompt flow for Chrome | first run | first run |
| UOH-17 | Battery mV to percentage mapping | UI | none reliable |
| UOH-18 | End-to-end input-to-screen latency < 50 ms | game feel | measure with a 240 fps phone or the diagnostics latency probe |
| UOH-19 | Terminal Bluetooth permission for the native helper, and the Command Line Tools (superseded by UOH-21 to UOH-33 below, which are the detailed items of the bridge that was built) | bridge first run | section 9; docs/native-bridge.md 6 and 11 |
| UOH-20 | The accelerometer reports +1 g towards up at rest (raw Z about +4096 with the buttons up, assuming +Z points out of the button face). The Motion pipeline hard-codes it; neither the calibration nor the gyro sign test can detect the opposite (protocol audit F3) | calibration frame, screen mapping | rest check with the buttons up (step 3); if Z reads -4096 save `accelSign = -1` or use `?accelsign=-1` |
| UOH-21 | The helper, started by `node` from `start.command` in Terminal, may use Bluetooth through **Terminal's** permission (responsible-process attribution through the process chain), and macOS shows the prompt "Terminal would like to use Bluetooth" at the first connect (native bridge, NB-1) | native first run | first run of the bridge |
| UOH-22 | A helper started from an app that has no Bluetooth usage description exits with SIGABRT (exit code 134, mapped to `bluetooth_permission`); a permission that was refused reaches the helper as "unauthorized" and is reported without a crash (NB-2) | error texts | never send `connect` from such an app in tests; the owner sees the text if it happens |
| UOH-23 | The 1.5 s collection window and "strongest advert, weaker than -85 dBm ignored" choose the owner's controller and not a neighbour's (NB-3) | native advert choice | the diagnostics page lists every advert seen with its RSSI |
| UOH-24 | The preference of 2026-09-30: a pairing-mode advert (host address all zero) is chosen when it appears within the window; otherwise the strongest advert is connected to anyway, and **a controller that advertises towards its bonded console may or may not be connectable by the Mac** (NB-4) | native advert choice | connect once with SYNC held, once without; `pairingOnly` |
| UOH-25 | The 1 Hz LED keep-alive of the helper keeps the link up (the probe streamed only 14.5 s) and the link really drops at about 15 s without it; the LED write is harmless at 1 Hz for hours (NB-5) | native stability | the diagnostics page's 60 s keep-alive experiment |
| UOH-26 | Helper, pipe, Node, Server-Sent Events and Chrome deliver 33-66 reports per second without stalls, also in a background tab, and the clock mapping stays stable for a long session (NB-6) | native latency | diagnostics rates, latency probe, a 15-minute session |
| UOH-27 | The report rate and the constant 63-byte length over minutes; the first reports may have zero IMU bytes with the IMU active within a fraction of a second (NB-7; REAL_R_1, REAL_R_2) | native data | diagnostics |
| UOH-28 | What the controller does after `cancelPeripheralConnection`: advertises again, needs SYNC, cooldown length (NB-8) | native reconnect | the disconnect panel, part 3 checks |
| UOH-29 | The rumble frame through the helper (NB-9) | haptics | the diagnostics expert buttons |
| UOH-30 | The Left Joy-Con (0x2067) natively, and side detection by the vibration characteristic (NB-10) | Left unit | repeat the native first run with the Left unit |
| UOH-31 | Skipping a service whose characteristics cannot be read, exactly as the probe did (NB-11) | native discovery | none expected |
| UOH-32 | The `bluetooth_off` path, and Bluetooth turned off while streaming (NB-12) | error texts | turn Bluetooth off once |
| UOH-33 | The battery bands: the real captures report 3435 mV, which the bands (ok from 3550 mV) call "low" (NB-13, the same question as UOH-17) | battery line | charge the Joy-Con and read it again |

---

## 13. Top risks

1. **Low and bursty sample rate (33-67 Hz)** in Chrome/macOS: coarse swing sampling and a latency budget at the edge of 50 ms. Mitigation: dt from device timestamps, orientation-segment collision, extrapolation to render time, drain all reports per frame. Cannot be fixed from a web page.
2. **Gyro scale ambiguity (8.14x).** Wrong scale = blade moves 8x too far or too little. Mitigation: configurable constant plus mandatory one-revolution check.
3. **Link stability on macOS:** possible ~15 s drop without host writes (single source), cooldown after repeated connects (duration unknown), every session needs SYNC and the chooser. Mitigation: 1 Hz keep-alive, pairing filter (strict; the game's default is lenient since 2026-09-30, see 3.3), no reconnect loops, clear on-screen guidance.
4. **Unknown sensor axes/handedness for the Left Joy-Con and for the owner's mounting.** Mitigation: mounting-agnostic calibration including the gravity/gyro sign self-test.
5. **Web Bluetooth path unverified on this exact stack** (on the owner's Mac Chrome's chooser listed no device, 2026-09-30). The native bridge is the alternative; it uses Objective-C and `clang` because the Swift toolchain (Swift CLT) is broken on this Mac (9.1), and it is itself unverified against a real helper run (UOH-21 to UOH-33).
6. **Timestamp/counter semantics uncertain** (D5, D6b). Mitigation: runtime validation with arrival-time fallback.
7. **Documentation quality of sources:** several projects have wrong field tables (D2, D3, D4). Mitigation: this document's layout is cross-checked against two real captures; unit tests use them.

---

## Appendix A: Packet builder for the simulator provider

The simulator must go through the real parser: build **real 63-byte packets** and feed them to `parseInputReport`. (Adjust the import path to wherever the parser module lives.) The builder below is the inverse of the parser (same offsets, constant bits `E0 FF 0F` and marker `01` as in real captures). Random round-trip test: 20 000 random reports, 0 failures. The simulator should also model: timestamps in microseconds advancing about 15 000 per report with +-3 ms jitter and occasional two-packet bursts, gyro bias and noise (7.5), and `counter` as a millisecond clock.

```js
// Inverse of parseInputReport: builds a 63-byte report. Used by the SIMULATOR provider so that synthetic IMU data goes through the real parser.
import { BUTTON_TABLE } from './joycon2-parse.mjs';
export function buildInputReport(o = {}) {
  const b = new Uint8Array(63), dv = new DataView(b.buffer);
  dv.setUint32(0, (o.counter ?? 0) >>> 0, true);
  for (const name of o.pressed ?? []) {                       // button names as in BUTTON_TABLE
    const e = BUTTON_TABLE.find((t) => t[2] === name); if (e) b[e[0]] |= e[1];
  }
  b[7] |= 0xE0; b[8] = 0xFF; b[9] = 0x0F;                     // constant bits seen in every real capture
  const stick = (off, s) => { const v = (s.x & 0xFFF) | ((s.y & 0xFFF) << 12); b[off] = v & 255; b[off + 1] = (v >> 8) & 255; b[off + 2] = (v >> 16) & 255; };
  stick(0x0A, o.leftField ?? { x: 2047, y: 2047 }); stick(0x0D, o.rightField ?? { x: 2047, y: 2047 });
  dv.setUint16(0x1F, o.batteryMv ?? 3700, true); b[0x29] = 0x01;
  dv.setUint32(0x2A, (o.imuTimestampUs ?? 0) >>> 0, true);
  dv.setInt16(0x2E, o.temperatureRaw ?? 0, true);
  const a = o.accelRaw ?? { x: 0, y: 0, z: 4096 }, g = o.gyroRaw ?? { x: 0, y: 0, z: 0 };
  dv.setInt16(0x30, a.x, true); dv.setInt16(0x32, a.y, true); dv.setInt16(0x34, a.z, true);
  dv.setInt16(0x36, g.x, true); dv.setInt16(0x38, g.y, true); dv.setInt16(0x3A, g.z, true);
  return b;
}
```

## Appendix B: Guidance for the diagnostics page (ADVISORY)

Show live: connection state and timings (connect, discovery, first report), raw hex of the last packet and its length, all decoded raw integers and converted units (accel g and |a|, gyro dps and |omega|, temperature, battery mV), packet rate over 1 s and over 10 s, inter-arrival min/median/p95/max, IMU `dt` from timestamps vs arrival time and their ratio, `imuActive`, side, feature mask in use and which fallback stage fired, time since last write, keep-alive on/off, pressed buttons, the gyro one-revolution scale tool and the still-hold gravity-vs-gyro sign test. Useful Chrome tool: `about://bluetooth-internals` (`[BCD]` Chrome docs).
