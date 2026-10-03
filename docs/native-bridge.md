# Native Bluetooth bridge (helper, server, provider, connect screen)

Status: built and tested with a fake helper and the real captures. Stage A (the helper, the server endpoints, the provider, the fake helper and their tests) and stage B (the connect screen, the flags, the diagnostics page, the documents and the end-to-end proof in a real browser, section 10) are done. **Nothing here was run against a real Joy-Con 2, and the real helper has never touched Bluetooth from the build sessions** (macOS stops it without the permission of a real app): everything that needs one carries the tag `UNVERIFIED-ON-HARDWARE` (list in section 11, registered as UOH-21 to UOH-33 in `docs/joycon2-protocol.md`).

## 1. Why this exists

On the owner's Mac, Chrome's Web Bluetooth chooser lists no device at all, not even with `acceptAllDevices`, although the Mac sees about 15 Bluetooth LE devices. A native CoreBluetooth probe (`probe.m`, run by the owner on 2026-09-30) worked end to end on the real Joy-Con 2 Right: scan, connect in 0.6 s, service discovery (exactly the GATT table of `docs/joycon2-protocol.md` section 4), init sequence acknowledged, 485 input packets in 14.5 s (about 33 Hz), always 63 bytes, accelerometer scale 4096 LSB per g confirmed (|a| = 1.026 g). The bridge is a productised version of that probe. Facts the probe established and this design relies on: advert company id `0x0553`, product id `0x2066` (Right) / `0x2067` (Left) at manufacturer data idx 7-8 counting the two company-id bytes (idx 5-6 after them); host-address bytes idx 12-17 (10-15 after the company id) are all zero in pairing mode; the controller appears in no macOS Bluetooth list and must **not** be paired in macOS settings; the init sequence that worked is: subscribe to the responses `c765a961-...`, write the LED frame, 0.5 s, feature SET `0xB7`, 0.5 s, feature ENABLE `0xB7`, 0.6 s, subscribe to the input characteristic `ab7de9be-...-7fd2`.

Swift cannot be used on this Mac (a stale `module.modulemap` in the Command Line Tools breaks every Swift build), so the helper is Objective-C compiled with `clang`.

## 2. Architecture

```
 Terminal (responsible process for macOS privacy: "Bluetooth" is asked for THIS app)
   |
   |  start.command  ->  bridge/build.sh  (clang, non-fatal)  ->  node server.js
   v
 +-------------------+   fetch POST /__bridge/connect|disconnect|rumble      +------------------------------+
 | browser page      | ---------------------------------------------------> | server.js  (127.0.0.1 only)   |
 | native-provider.js|   GET /__bridge/status                               |  Host guard, Origin rule,     |
 |  (InputProvider)  | <--------------------------------------------------- |  X-Joycon-Ninja header        |
 |  native-link.js   |   EventSource GET /__bridge/events (SSE, seq numbers)|  bridge/manager.js (lazy)     |
 +-------------------+                                                      +---------------+--------------+
        |                                                                                    | spawn (argument array)
        | parseInputReport + createReportStream (the SAME code as ble-provider.js)           | stdin: JSON commands
        v                                                                                    | stdout: JSON lines
 ImuSample / ButtonsEvent / PacketEvent / status / error                      +--------------v---------------+
                                                                              | bridge/build/joycon-bridge    |
                                                                              | (CoreBluetooth, Objective-C)  |
                                                                              +--------------+---------------+
                                                                                             | BLE
                                                                                       Joy-Con 2 (R or L)
```

Files:

| File | Role |
|---|---|
| `bridge/joycon-bridge.m`, `bridge/Info.plist` | the helper and its embedded property list (`NSBluetoothAlwaysUsageDescription`, bundle id `local.joyconninja.bridge`) |
| `bridge/build.sh`, `npm run build:bridge` | idempotent build (`--force`, `--check`), output `bridge/build/joycon-bridge` (git-ignored through `bridge/.gitignore`) |
| `bridge/manager.js` | helper manager: lazy spawn, build on demand, event fan-out, crash translation, cleanup |
| `server.js` | the `/__bridge/*` endpoints, the security rules, the lazy import of the manager |
| `public/js/input/native-link.js` | transport: fetch and EventSource, errors as `BridgeError` |
| `public/js/input/native-provider.js` | `createNativeProvider(opts)`: the InputProvider (also `createInputProvider('native', opts)`) |
| `public/js/ui/connect-model.js`, `ui/ui.js`, `ui/screens/connect.js`, `ui/screens/overlays.js`, `ui/layout-data.js` | the connect screen and the disconnect panel of the bridge (stage B) |
| `public/js/app.js`, `flags.js` | `?input=native`, the probe of `/__bridge/status`, the remembered path, two Joy-Con providers (stage B) |
| `public/diagnostics.html`, `input/diagnostics-page.js`, `input/diagnostics-tools.js` | the diagnostics page in native mode (stage B) |
| `start.command` | runs `bridge/build.sh` (non-fatal) before the server; `JOYCON_NO_BRIDGE=1` skips it |
| `test/bridge/*.test.js`, `test-support/bridge/*` | tests, a fake helper (it can also play a virtual sword, obey a control file and, with the control command `replay`, play windows of the first real IMU recording byte for byte in real time), a fake page, a minimal Node EventSource |
| `test/e2e/native.test.js`, `test-support/e2e/native-harness.js`, `test-support/e2e/native-screens.mjs` | the real game in headless Chrome against the real server and the fake helper; the script that takes the screenshots of `docs/img/` |
| `docs/joycon2-test-vectors.json` | two new real captures, `REAL_R_1` and `REAL_R_2` |

## 3. Protocols

### 3.1 Helper, stdout (one JSON object per line, flushed after every line)

| Line | Fields | Notes |
|---|---|---|
| `{"type":"hello","version":1}` | | first line; the server refuses another version |
| `{"type":"status",...}` | `state`, optional `code`, `message`, `side` (`L`/`R`), `warning`, `dropped` | `state` is one of `idle`, `scanning`, `connecting`, `discovering`, `initialising`, `streaming`, `disconnected`, `error`. `code` only with `error`. `scanning` is sent twice: when the command is accepted ("waiting for Bluetooth", a permission prompt may be open; the game shows "Waiting for the Mac's Bluetooth. If macOS asks for permission, choose Allow.") and when the scan really starts (the scan time runs from there; the game starts its 45 s countdown). A line with `warning` is not a state change (`bad_length`, `busy`, `bad_command`, `unknown_command`, `characteristics_failed`, `response_subscribe_failed`). `side` is known from the chosen advert and is corrected by the GATT table (vibration characteristic present on one side only) |
| `{"type":"advert","side":"R","pid":8294,"rssi":-40,"host":"00 00 00 00 00 00","pairing":true}` | | only Nintendo adverts (company `0x0553`, product `0x2066`/`0x2067`) of the wanted side at -85 dBm or stronger, once per (device, pairing flag); printed whether or not the advert will be chosen. **The host address of a controller that is bonded to a console is never printed**: `host` is `"non-zero"` and `pairing` is `false` |
| `{"type":"report","t":12345.678,"hex":"<126 hex chars>"}` | `t` = helper monotonic ms | one line per input notification of exactly 63 bytes; anything else is dropped and counted (`warning:"bad_length"` on the first and every 100th) |
| `{"type":"response","hex":"..."}` | | every notification of the command-response characteristic |

Error codes (`status` with `state:"error"`): `bluetooth_permission` (authorization denied or restricted, state unauthorized, or Bluetooth not ready within 30 s), `bluetooth_off` (powered off or unsupported), `no_device` (nothing found within `scanSeconds`; also "seen but not in pairing mode"), `connect_failed` (connect failed or 20 s timeout), `gatt_failure` (discovery failed or 15 s timeout, characteristics missing, subscription not confirmed, link dropped during setup), `lost_signal` (disconnect while streaming).

### 3.2 Helper, stdin (one JSON object per line)

| Command | Fields | Effect |
|---|---|---|
| `connect` | `side` `"R"`/`"L"`/`"any"`, `scanSeconds` (5-120, default 45), `keepAliveHz` (0-5, default 1; 0 = off), `mask` (0-255, default 183 = `0xB7`), `pairingOnly` (default **false**) | one attempt: scan; the first qualifying advert opens a 1.5 s collection window; when it ends the strongest **pairing-mode** advert (host-address bytes all zero, SYNC held) wins, and **if none appeared the strongest matching advert is connected to anyway** (changed 2026-09-30, see section 8); `pairingOnly:true` makes only pairing-mode adverts qualify; then connect (20 s), discover (15 s), init as the probe, subscribe |
| `disconnect` | | cancels the scan or the connection; answers `status disconnected` (silent when there is nothing to do) |
| `rumble` | `id` (0-255) | the game's vibration frame `0A 91 01 02 00 04 00 00 ID 00 00 00`, only while streaming, at most 10 per second |
| `quit` | | clean exit |

The helper also exits cleanly (code 0) on stdin EOF and on SIGTERM/SIGINT, after cancelling the peripheral connection. `--version` prints the hello line and exits 0; `--selftest` prints the hello line and one `{"type":"selftest","ok":true,"checks":N,"failures":0}` line (frame bytes, advert parsing, candidate choice, JSON escaping, line splitting) and exits 0 or 1. **Neither creates a `CBCentralManager`; the manager is created by the first `connect` command**, never at start-up (macOS kills a process that touches Bluetooth without permission).

Hard rules in the helper: one connection attempt per `connect` (the only call site of `connectPeripheral:`), no retry loop of any kind, one write call site which only ever writes to the command characteristic `649d4ac9-...` (write without response, at least 100 ms apart), the keep-alive is the LED frame every `1/keepAliveHz` s when no write happened for 90 % of that interval (the same rule as `ble-transport.js`), no other device is ever printed or logged.

### 3.3 HTTP (server.js)

| Request | Body | Answer |
|---|---|---|
| `GET /__bridge/status` | | `{"available":bool,"reason":string\|null,"built":bool,"canBuild":bool,"state":string}`. `reason` is `not_macos`, `helper_missing` (override binary missing), `no_compiler`, `bridge_module_error`, or null |
| `GET /__bridge/events` | | `text/event-stream`: `: connected`, then the last status replayed with `"replay":true`, then every helper line as `data: {...}`, plus server-made events, plus `: heartbeat` every 10 s. Any number of listeners |
| `POST /__bridge/connect` | `{side, scanSeconds?, keepAliveHz?, mask?, pairingOnly?}` validated field by field, unknown keys dropped | `{"ok":true,"seq":N}` or `{"ok":false,"code","message"}`: 400 bad body, 403 forbidden, 409 `busy` (a session is running) / `cancelled`, 413, 415, 503 `helper_missing` / `no_compiler` / `not_macos` / `build_failed` / `helper_failed` / `stopping` |
| `POST /__bridge/disconnect` | `{}` | `{"ok":true}`; also cancels a connect that is still preparing the helper |
| `POST /__bridge/rumble` | `{id}` | `{"ok":true}` or `{"ok":true,"dropped":true}` |

Server-made events: `{"type":"bridge","phase":"building"|"built"|"starting"}` (compiling the helper on first use, then starting it) and, when the helper dies, `{"type":"status","state":"error","code":"bluetooth_permission"|"helper_crashed","message":...,"source":"server"}`. **Exit code 134 or signal SIGABRT (how macOS stops a process that uses Bluetooth without permission) becomes `bluetooth_permission`; every other unexpected exit becomes `helper_crashed`.**

Every event carries `seq`, a counter that never goes backwards. The answer to `connect` carries the last `seq` from BEFORE that attempt (the server takes it when it accepts the request, before it builds or starts anything): every event with a higher `seq` (`building`, `starting`, all helper lines) belongs to the attempt, everything up to it is the tail of an earlier session and is ignored by the provider, as is every `replay` event.

Server behaviour worth knowing: the helper is started lazily by the first connect and reused until the server stops; it is built first when the binary is missing or older than its source and `clang` exists; when the last event listener leaves while a session runs, the server sends `disconnect` after 8 s (a crashed tab must not keep the controller connected); on stop the server sends `quit`, then SIGTERM, then SIGKILL (600 ms apart) and `close()` resolves only when the process is gone; a helper that outlives a killed server exits by itself because its stdin closes. `JOYCON_BRIDGE_BIN` overrides the helper path (the tests point it at `test-support/bridge/fake-helper.mjs`).

## 4. Provider behaviour (native-provider.js)

Same interface as `ble-provider.js` (`kind: 'joycon'`, `connect`, `reconnect`, `disconnect`, `vibrate`, `setKeepAlive`, `getActionLabels`, `getDiagnostics`, `on`/`off`, `dispose`), same `createProviderBase`, status store, cooldown rules and report pipeline (`parseInputReport`, `createReportStream`, `createButtonActions`). Everything is injectable: `fetch`, `EventSource`, `clock`, `timers`, `document`, `pageTarget`, `baseUrl`, `config`, `native` (numbers).

Additions beyond the BLE provider: `provider.transport` (`'native'`; the BLE provider has none, the UI tells the two apart with it), `provider.getBridgeInfo()` (phase, its string key, helper state, bridge status, adverts seen, `scanStartedAt`, `scanSeconds`, last bridge code, dropped and bad-report counts), a provider event `'bridge'` `{phase, helperState, key, at, scanStartedAt, scanSeconds}`, `getDiagnostics().native`, `status.error.native = {code, key}`. `capabilities.needsUserGesture` is `false` (there is no chooser).

Phases (the `'bridge'` event; one string key each, section 9): `checking` (asking `GET /__bridge/status`), `starting` (the stream is open, the server starts the helper), `building` (compiling the helper, first start only), `waitingBluetooth` (the helper's first `scanning` status: it waits for Bluetooth, a macOS permission prompt may be open), `scanning` (its second `scanning` status, or the first advert: the scan really runs; `scanStartedAt` is set here and the game counts `scanSeconds` down from it), `connecting`, `discovering`, `initialising`, `waitingData` (the helper says `streaming`, the first IMU sample is awaited), `streaming`.

State mapping:

| Helper state | Provider state | Notes |
|---|---|---|
| (connect called) | `requesting` (`connecting` when it is a reconnect out of `lost`) | the UI shows "Searching…" |
| `scanning` (first: waiting for Bluetooth, second: the scan runs) | `requesting` | phase `waitingBluetooth`, then `scanning` |
| `connecting`, `discovering` | `connecting` | |
| `initialising` | `initializing` | `featureMask` set |
| `streaming` | `initializing` | waits for the first IMU sample (9 s, else `no_data`) |
| first `ImuSample` | `streaming` | announced BEFORE the sample, like BLE |
| `error` while streaming, `disconnected` while streaming, silence for 2.5 s with a visible tab, event stream broken | `lost` | cooldown 10 s, 180 s after 3 failures |
| `error` before streaming | `error` (`lost` again when the attempt was a reconnect out of `lost`) | |

Error mapping (new string keys in section 9). `count` = starts the cooldown; only failures that involved the controller do:

| Bridge code | `InputErrorInfo.code` | count |
|---|---|---|
| `bluetooth_permission` | `permission_denied` | no |
| `bluetooth_off`, `no_device`, `not_pairing` (derived: only non-pairing adverts were seen) | `gatt_failure` | no |
| `connect_failed`, `gatt_failure`, `stalled` (a stage made no progress: 55 s scanning, 30 s connecting, 25 s discovering, 22 s initialising) | `gatt_failure` | yes |
| `lost_signal` | `lost_signal` | yes |
| `no_data` | `no_data` | yes |
| `helper_crashed`, `helper_failed`, `build_failed`, `bridge_unreachable`, `bridge_busy`, `bridge_refused`, `unknown` | `gatt_failure` | no |
| `helper_missing`, `no_compiler`, `not_macos`, `bridge_module_error`, `bridge_missing` (HTTP 404: an older server without the endpoints) | `unsupported_browser` (not retryable) | no |

Timing: the helper's `t` is mapped onto the Clock with a running minimum of `clock.now() - t` (leaking up by `report.offsetLeakPerMs`), which removes the jitter of pipes and SSE batching, and is handed to the report stream as the arrival time. The stream still takes `dt` from the IMU timestamp (u32 wrap-safe) and falls back to these arrival times only when the IMU timestamps are unusable, so the `ImuSample`s are identical to the BLE path (a test compares them with a bare report stream). No automatic retry after a lost link by default (`autoRetry` option, 0): a lost Joy-Con is not advertising in pairing mode any more, so a silent retry would search for 45 s and burn the controller's connect budget; the UI offers "Reconnect".

## 5. Security model

Any web page in the owner's browser can send requests to `http://localhost`. The bridge can connect a Bluetooth device, so:

1. The server listens on `127.0.0.1` only and keeps the DNS-rebinding Host guard for every request.
2. Every `/__bridge/*` request is refused with 403 unless its `Origin` header (when present) is exactly `http://localhost:PORT` or `http://127.0.0.1:PORT` (this server's own port) and its `Sec-Fetch-Site` (when present) is `same-origin` or `none`. `Origin: null`, another port, `https`, an empty value and a joined duplicate are refused. `same-site` is refused too: another local dev server on `localhost:3000` is same-site but not same-origin.
3. Every POST additionally needs the header `X-Joycon-Ninja: 1`. A cross-site page cannot add a custom header without a CORS preflight, and the server never answers a preflight (OPTIONS is 405) and never sends any `Access-Control-*` header.
4. Bodies are JSON, at most 2 KB, `Content-Type: application/json` required; fields are validated one by one and only known ones are forwarded. The helper gets them as JSON over a pipe: the helper is started with an argument array, and nothing from a request is ever put in a command line or a shell.
5. The helper prints no other device, never prints a bonded console's address, and only ever writes to the command characteristic.
6. `GET /__bridge/events` cannot carry a custom header (EventSource limitation), so it relies on rules 1 and 2; listeners that fall 256 KB behind are dropped.
7. The bridge module is loaded lazily and failures are contained: a broken bridge can never stop the game server from starting.

## 6. macOS Bluetooth permission

macOS attributes the Bluetooth privacy permission to the **responsible process**, the app at the top of the process chain. `start.command` runs inside Terminal, so Terminal is the app that is asked: the first `connect` makes macOS show "Terminal would like to use Bluetooth" (from the usage description embedded in the helper). Allow it once; later runs are silent. If it was refused: System Settings > Privacy & Security > Bluetooth > switch Terminal on.

The helper must be started from Terminal, which is the supported way. **A server started from an app that has no Bluetooth usage description, such as the Claude app's own session, is killed by macOS at the first Bluetooth contact (SIGABRT, exit code 134)**; the manager translates that into `bluetooth_permission`, and the message says to start the game from Terminal. Automated tests and agent sessions therefore never send `connect` to the real helper. The attribution through `node` -> `joycon-bridge` is standard macOS behaviour but UNVERIFIED-ON-HARDWARE (section 11).

## 7. Build and run

```
npm run build:bridge          # bash bridge/build.sh: builds if missing or older than a source, otherwise "up to date"
bash bridge/build.sh --force  # always rebuild
bash bridge/build.sh --check  # exit 0 and "can-build" when clang is available, builds nothing
./start.command               # builds (non-fatal), starts the server, opens Chrome
JOYCON_NO_BRIDGE=1 ./start.command            # skip the build step
JOYCON_BRIDGE_BIN=/path/to/helper node server.js   # use another helper binary (tests use a fake)
```

`build.sh` finds clang with `xcode-select -p` (never by running the `/usr/bin/clang` stub, which opens an install dialog on a Mac without the tools), compiles with `-fobjc-arc -O2 -Wall -Wextra`, embeds `Info.plist` with `-sectcreate __TEXT __info_plist`, writes to a private temporary file, runs `--selftest` on it, and only then moves it into place. Warnings are shown but never stop the build. Without clang it prints the `xcode-select --install` hint; the game still works with the mouse and the simulator. Exit codes: 0 built or up to date, 1 cannot build, 2 the compiler failed, 3 the new binary failed its self-test.

## 8. Decisions that go beyond the brief

- **Pairing-mode preference (changed 2026-09-30; `pairingOnly`, default false).** Stage A required the host-address bytes of an advert to be all zero by default (`pairingOnly:true`), on the reasoning that a controller that advertises towards its bonded console may not be connectable by a Mac and would burn the controller's connect budget. The owner's real probe connected to a zero-host advert without any problem and showed that a bonded-host advert is what the controller sends **before** SYNC is held; a bonded-host advert may be connectable too (UNVERIFIED-ON-HARDWARE, UOH-24). The helper now **prefers** pairing-mode adverts: the first qualifying advert opens the 1.5 s collection window and, when it ends, the strongest pairing-mode advert wins; if none appeared in the window the strongest matching advert (-85 dBm or stronger) is connected to anyway. `"pairingOnly":true` keeps the strict rule as an explicit option (the diagnostics page's "SYNC mode only"); with it a controller that was seen but never in pairing mode ends as `no_device` ("seen but not in pairing mode", derived code `not_pairing`). A failed connect to a non-pairing advert says so in its message. The choice is one pure function (`BridgeAdvertQualifies`, `BridgeAdvertVisible`, `BridgeBestCandidate`) that the runtime and the helper's `--selftest` share; the self-test runs synthetic adverts through it (only a bonded advert, a bonded one stronger than a pairing one, several pairing ones, weak ones, RSSI 127, the wrong side, another company id, `pairingOnly`).
- The bonded host address is never printed (`"host":"non-zero"`), a privacy choice; the field is still the brief's `host` string for pairing adverts.
- `rumble` is also an HTTP endpoint (`POST /__bridge/rumble`), because the provider needs it for `vibrate()`.
- `--selftest` prints a second line with the self-test result (after the hello line).
- `connect` accepts `mask` and `pairingOnly` besides `side`, `scanSeconds`, `keepAliveHz`.
- The idle auto-disconnect (8 s after the last listener left), the `seq` numbers and the `replay` flag are additions of the server.
- **One name for the provider kind.** `createInputProvider('native', opts)` (and the export `createNativeProvider`); the old reserved name `bridge` is an unknown kind and `?input=bridge` is ignored with a warning that names `?input=native`. The status still says `kind: 'joycon'`.
- **No automatic retry anywhere.** Not in the helper, not in the provider (`autoRetry` 0), not in the UI: after a lost link the disconnect panel says "hold SYNC, then press Reconnect" and waits for the click. A cancelled attempt costs no cooldown; real failures keep the provider's rules (10 s, 180 s after three).
- **The connect screen remembers the path that last reached `streaming`** (localStorage `joyconNinja.path.v1`), offers it first next time, and `?input=joycon` / `?input=native` override it. A first run, or a path that never worked, always starts with the native button when the bridge is available.
- **Enter is always the main button on the native screen,** wherever the pointer rests (a click on "Cancel" leaves the pointer over the Chrome button, and the Enter after it must not open Chrome's chooser); "Cancel" answers to a click and Esc, never to Enter (a second Enter must not undo the first).
- **The probe** of `GET /__bridge/status` runs at boot and each time the connect screen opens again, on the real clock only (never under `?clock=manual`, `?input=sim|mouse`, `?mode`); 404, a network error, no `fetch`/`EventSource` or no answer within 2.5 s all mean "not available" (the legacy screen, with a line about `xcode-select --install` when the reason is `no_compiler` or `helper_missing`).

## 9. New string keys (final texts, in `public/js/ui/strings.en.js`)

Stage A proposed the texts; stage B improved the wording where a first-time user could misread it (every error says what to do next, SYNC is located on the controller, the permission prompt is named, "Reconnect" matches the button) and added the keys marked *new*. `test/ui/strings.test.js` compares every row below with `strings.en.js`: the document cannot drift from the game.

Progress texts (`NATIVE_PROGRESS_KEYS`, shown while the provider is busy; the provider's `'bridge'` event carries the key). `waitingBluetooth` is new: the helper sends `scanning` twice, first while it waits for Bluetooth (a macOS permission prompt may be open), then when the scan really starts; only the second one starts the 45 s countdown.

| Key | Text |
|---|---|
| `connect.native.progress.checking` | Checking the Bluetooth bridge… |
| `connect.native.progress.starting` | Starting the Bluetooth bridge… |
| `connect.native.progress.building` | Preparing the Bluetooth bridge (first time only, a few seconds)… |
| `connect.native.progress.waitingBluetooth` | Waiting for the Mac's Bluetooth. If macOS asks for permission, choose Allow. |
| `connect.native.progress.scanning` | Looking for the Joy-Con. Hold SYNC now (the small button next to the USB-C port) until the lights sweep. |
| `connect.native.progress.connecting` | Joy-Con found. Connecting… |
| `connect.native.progress.discovering` | Reading the Joy-Con's services… |
| `connect.native.progress.initialising` | Preparing the Joy-Con… |
| `connect.native.progress.waitingData` | Waiting for the first motion data… |

Error texts (`NATIVE_ERRORS`; the key is `status.error.native.key`):

| Key | Text |
|---|---|
| `connect.err.native.permission` | macOS is not letting this app use Bluetooth. Restart the game with start.command from Terminal and allow Bluetooth when macOS asks. Already declined? System Settings > Privacy & Security > Bluetooth: turn on Terminal. |
| `connect.err.native.bluetoothOff` | The Mac's Bluetooth is off. Turn it on from the menu bar or from System Settings, then try again. |
| `connect.err.native.noDevice` | No Joy-Con found. Hold SYNC until the lights sweep, staying close to the Mac. If you have already tried many times, wait a minute: the Joy-Con refuses repeated connections. |
| `connect.err.native.notPairing` | A Joy-Con was seen, but it is not in pairing mode. Hold SYNC until the lights sweep and try again. |
| `connect.err.native.connectFailed` | Can't connect to the Joy-Con. Wait a few seconds, hold SYNC and try again. |
| `connect.err.native.gatt` | The connection to the Joy-Con failed. Wait a few seconds and try again. |
| `connect.err.native.lost` | The Joy-Con disconnected. Hold SYNC until the lights sweep, then reconnect it. |
| `connect.err.native.noData` | The Joy-Con is connected but is not sending motion data. Hold SYNC and try again. |
| `connect.err.native.stalled` | The Bluetooth bridge has stopped responding. Try again in a few seconds. |
| `connect.err.native.crashed` | The Bluetooth bridge stopped suddenly. Try again; if it happens again, close the game and restart it with start.command. |
| `connect.err.native.helperFailed` | The Bluetooth bridge will not start. Close the game and restart it with start.command. |
| `connect.err.native.buildFailed` | Can't prepare the Bluetooth bridge. Install Apple's developer tools (type in Terminal: xcode-select --install) and restart the game. Meanwhile you can use the simulator or the mouse. |
| `connect.err.native.unavailable` | The Bluetooth bridge is not available. On a Mac you need Apple's developer tools (type in Terminal: xcode-select --install) and a restart of the game. Otherwise use Chrome with Web Bluetooth, the simulator or the mouse. |
| `connect.err.native.oldServer` | The game was started with an old version. Close it and reopen it with start.command. |
| `connect.err.native.noServer` | Can't reach the game. Check that the Terminal window is still open. |
| `connect.err.native.busy` | The Bluetooth bridge is already in use (another game tab?). Close it and try again in a few seconds. |
| `connect.err.native.refused` | The Bluetooth bridge refused the request. Open the game from the address that start.command shows. |
| `connect.err.native.unknown` | Something went wrong with the Bluetooth bridge. Try again. |

UI-only keys (not produced by the provider): the button, the second path, the cancel button, the countdown, the steps of the left panel (`{button}` is replaced by `connect.native.button`), the note shown when the bridge cannot be built, and the two texts of the disconnect panel.

| Key | Text |
|---|---|
| `connect.native.button` | Connect Joy-Con (native bridge) |
| `connect.native.secondary` | Not working? Try Chrome's Bluetooth |
| `connect.native.secondaryToNative` | Try the native bridge (recommended) |
| `connect.native.hint` | Keep holding SYNC until “Connected” appears: a few seconds are usually enough. |
| `connect.native.cancel` | Cancel |
| `connect.native.countdown` | Time left: {s} s |
| `connect.native.anyBrowser` | This browser has no Web Bluetooth: the native bridge works anyway. |
| `connect.native.note.noCompiler` | Native bridge not available: install Apple's developer tools (type in Terminal: xcode-select --install) and restart the game. |
| `connect.native.step1` | 1. Turn off the console. Do not pair the Joy-Con in the Mac's Bluetooth settings: it is not needed. |
| `connect.native.step2` | 2. Press “{button}”. The first time, macOS asks for Bluetooth permission for Terminal: choose Allow. |
| `connect.native.step3` | 3. Right away, hold down SYNC (the small button next to the USB-C port) until the lights sweep. |
| `connect.native.step4` | 4. Wait for “Connected”, then calibrate the sword. |
| `disc.native.text` | The Joy-Con disconnected. Hold SYNC until the lights sweep, then press “Reconnect”. |
| `disc.native.retry` | Reconnect |
| `disc.native.wait` | Reconnect in {s} s |

## 10. Stage B: the work list and where each item was done

| # | Item | Done in |
|---|---|---|
| 1 | The old guard of `test/architecture/delivery.test.js` (which asserted that no native bridge exists) replaced by the decision "it IS built" (files, endpoints), a test of the new factory kind, and a scan for stale "not built" statements; fate of `createInputProvider('bridge')`: an unknown kind (TypeError) | `test/architecture/delivery.test.js`, `test/input/index.test.js` |
| 2 | English strings: every key of section 9 (final texts, improved where a first-time user could misread), `STRING_KEYS_ADDITIONS`, the contract-notes entry, parity tests | `public/js/ui/strings.en.js`, `test/ui/strings.test.js`, `docs/contract-notes.md` |
| 3 | `public/js/input/index.js` exports `createNativeProvider` and the kind `'native'`; the `'bridge'` throw is gone | `public/js/input/index.js`, `test/input/index.test.js` |
| 4 | `?input=native` (created at boot, not connected); `app.js` keeps two Joy-Con providers, probes `/__bridge/status`, forwards the provider's `'bridge'` event as a fact, remembers the path, `openDiagnostics` and `pagehide` let go of both | `public/js/flags.js`, `public/js/app.js`, `test/app/flags.test.js`, `test/app/native-app.test.js` |
| 5 | The connect screen: primary button, Web Bluetooth as the second path (and the "Extended search" rules unchanged), one progress line per helper phase, a visible 45 s countdown, "Cancel", an English text for every error code, the disconnect panel with "hold SYNC, then Reconnect" and no automatic retry | `public/js/ui/connect-model.js`, `ui.js`, `layout-data.js`, `screens/connect.js`, `screens/overlays.js`, `test/ui/connect-native.test.js`, `test/ui/presentation.test.js` |
| 6 | The diagnostics page: mode selector with "Native bridge (recommended)", the bridge block, `pairingOnly`, the keep-alive toggle, rates and histogram, the 60 s keep-alive experiment (UOH-5), the vibration test through `vibrate()`, three more checklist steps, the game link with `?input=native` | `public/diagnostics.html`, `public/js/input/diagnostics-page.js`, `diagnostics-tools.js`, `test/input/diagnostics-tools.test.js`, `test/e2e/native.test.js` |
| 7 | Documents: README, GUIDE (connection chapters and the 10-minute checklist rewritten with the native path first, the macOS permission, troubleshooting rows, screenshots), architecture, protocol, protocol audit, hardware findings, this file, the contract notes | `README.md`, `docs/*.md`, `docs/img/11-*.jpg` to `22-*.jpg` |
| 8 | The open items of section 11 registered as UOH-21 to UOH-33 in the protocol register and in the GUIDE's checklist index | `docs/joycon2-protocol.md` section 12, `docs/GUIDE.md` section 11 |
| + | The helper's connect preference (section 8), its self-test and the fake helper's motion model, control file and phase delays | `bridge/joycon-bridge.m`, `test/bridge/helper.test.js`, `test-support/bridge/fake-helper.mjs` |

## 11. UNVERIFIED-ON-HARDWARE (native path)

The NB ids are the ones the code comments and the tests use; each is registered as a UOH item in `docs/joycon2-protocol.md` section 12 (NB-n = UOH-(20+n)) and appears in the GUIDE's HARDWARE CHECKLIST.

| Id | What is not verified |
|---|---|
| NB-1 | The helper, started by `node` from `start.command` in Terminal, is allowed to use Bluetooth through Terminal's permission (responsible-process attribution through the process chain), and the first-connect prompt appears. |
| NB-2 | A helper started from an app without a Bluetooth usage description exits with SIGABRT / code 134 (mapped to `bluetooth_permission`); a denied permission reaches the helper as `unauthorized` and is reported without a crash. |
| NB-3 | The 1.5 s collection window and "strongest RSSI, weaker than -85 dBm ignored" choose the owner's controller next to the Mac and not a neighbour's. |
| NB-4 | The pairing-mode preference of 2026-09-30: whether an advert with a bonded host address is connectable by a Mac (the helper now connects to it after the 1.5 s window when no pairing-mode advert appeared) or whether that burns the controller's connect budget; `pairingOnly:true` behaviour. |
| NB-5 | The 1 Hz LED keep-alive keeps the link up (the probe streamed 14.5 s only); whether the link really drops at about 15 s without it (UOH-5); whether the LED write is harmless at 1 Hz for hours. |
| NB-6 | Helper -> pipe -> Node -> SSE -> Chrome delivers 33-66 reports per second without stalls, including in a background tab (EventSource is not timer-throttled, the provider's silence check is); the clock mapping stays stable for a long session. |
| NB-7 | The report rate and the constant 63-byte length over minutes (UOH-4 was 33.4 Hz over 14.5 s), and that the first reports may have zero IMU bytes (REAL_R_1) with the IMU active within a fraction of a second (REAL_R_2) and no watchdog on the helper side. |
| NB-8 | How the controller behaves after `cancelPeripheralConnection`: advertising again, need for SYNC, length of its cooldown (UOH-11). |
| NB-9 | The rumble frame through the helper (UOH-13). |
| NB-10 | The Left Joy-Con (`0x2067`) natively, and side detection by the vibration characteristic. |
| NB-11 | Skipping a service whose characteristics cannot be read, exactly like the probe. |
| NB-12 | The `bluetooth_off` path and Bluetooth turned off while streaming. |
| NB-13 | The battery bands: the real captures report 3435 mV, which the current bands (ok from 3550 mV) call "low" (protocol 7.6, UOH-17). The bands are unchanged (they agree with the documented ones); the GUIDE tells the owner to charge the Joy-Con before a sword session, because a low charge can also make the link unstable (an assumption). |

## 12. Tests

`npm test` runs `test/bridge/` with the rest (`npm run test:unit` includes it):

| File | What it proves |
|---|---|
| `helper.test.js` | the real helper compiles without warnings; `--version`, `--selftest` (42 checks, among them the advert choice on synthetic adverts), served mode, quit, EOF, SIGTERM and SIGINT exit 0; malformed input never crashes it; source rules (one connect site, one write site, manager created only on connect); the connect preference of 2026-09-30. Never sends `connect` |
| `build-script.test.js` | idempotent build, rebuild on a newer source or plist, `--force`, `--check`, missing clang, failing compiler, failing self-test, warnings shown, concurrent builds |
| `server-bridge.test.js` | status, happy path with the real captures, several listeners, replay, heartbeat, busy, rumble, permission and crash mapping, bad helper output, the security rules (header, Origin, Sec-Fetch-Site, Host, CORS, bodies), no path traversal regression, stop cleanup including SIGKILL, idle disconnect, build on demand |
| `native-provider.test.js` | REAL_R_1 and REAL_R_2, samples identical to a bare report stream, dt and fallback to the helper clock, status sequences, every error mapping and the cooldown rules, sequence numbers, disconnect, vibrate, lifecycle |
| `integration.test.js` | provider -> real HTTP -> server -> manager -> fake helper process, end to end |
| `bridge-delivery.test.js` | the files, the plist, `package.json`, `start.command`, this document and the real captures' labels |

Stage B added, outside `test/bridge/`:

| File | What it proves |
|---|---|
| `test/ui/connect-native.test.js` | the connect model and targets (layout choice, primary and second path, progress per phase, the countdown, every error code, cooldown rules, geometry), the state machine (Enter, "Cancel", Esc, stale progress), the disconnect panel for the native path |
| `test/ui/strings.test.js` | every string key of the bridge exists; section 9 of this document shows exactly the texts the game uses; the error texts say what to do |
| `test/ui/presentation.test.js` | the native connect screen and the disconnect panel draw (fake 2D context) |
| `test/app/native-app.test.js` | the real `app.js` against a fake page side: the probe, the facts, the progress, the remembered path, cancel, the error codes, a link loss, `?input=native`, the diagnostics link |
| `test/input/diagnostics-tools.test.js` | the mode, the native checklist, the advert line, the keep-alive experiment, the game link |
| `test/e2e/native.test.js` | the real game in headless Chrome against the real server and the fake helper (a virtual sword through the real packet builder): the first-run flow, the failure paths, a crash in the middle of a game with a working reconnect, the diagnostics page in native mode |
| `test/architecture/delivery.test.js` | the bridge exists, the factory kind `native`, and no document says "not built" any more |

A green test proves the software chain. It says nothing about the real helper talking to a real Joy-Con.
