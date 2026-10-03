// Clay Rush: shared contracts. OWNER: architect (frozen). Changes only through docs/contract-notes.md and the Integrator.
//
// This file has two parts:
//   1. Runtime enums (frozen objects). Import these instead of typing string literals.
//   2. The canonical JSDoc typedefs between the <typedefs> markers. docs/architecture.md section 11 embeds the same block
//      verbatim (generated). If the two ever differ, THIS FILE wins.
//
// Conventions used by every typedef below:
//   - Time: milliseconds (ms) on the Clock timebase (performance.now() in the browser, a manual counter in tests), unless a
//     field name ends in S (seconds) or says "game seconds".
//   - Playfield coordinates: logical 1920 x 1080 px, origin top-left, y grows DOWN.
//   - Angles: degrees unless the name ends in Rad. Angular rates: deg/s. Accelerometer: g. Lengths on screen: px.
//   - "Device frame" = raw Joy-Con sensor axes X, Y, Z in report order, no swizzling, no sign changes.
//   - Every payload that crosses a module boundary is plain data (JSON-serialisable) unless it is a function-bearing
//     interface (InputProvider, MotionPipeline, Game, ...).

export const PROVIDER_KIND = Object.freeze({ JOYCON: 'joycon', SIM: 'sim', MOUSE: 'mouse' });
export const SIDE = Object.freeze({ LEFT: 'L', RIGHT: 'R', UNKNOWN: '?' });

/** Connection state machine of an input provider (section 5.3 of docs/architecture.md). */
export const CONN_STATE = Object.freeze({
  IDLE: 'idle',
  REQUESTING: 'requesting',
  CONNECTING: 'connecting',
  INITIALIZING: 'initializing',
  STREAMING: 'streaming',
  LOST: 'lost',
  ERROR: 'error',
});

/** Machine-readable error codes. The UI maps each to a string (docs/architecture.md section 5.4). */
export const INPUT_ERROR = Object.freeze({
  UNSUPPORTED_BROWSER: 'unsupported_browser',
  PERMISSION_DENIED: 'permission_denied',
  CANCELLED: 'cancelled',
  NOT_JOYCON: 'not_joycon',
  COOLDOWN: 'cooldown',
  GATT_FAILURE: 'gatt_failure',
  NO_DATA: 'no_data',
  LOST_SIGNAL: 'lost_signal',
});

export const ACTION = Object.freeze({ CONFIRM: 'confirm', BACK: 'back', PAUSE: 'pause', RECENTER: 'recenter', FIRE: 'fire' });
export const ACTION_SOURCE = Object.freeze({ JOYCON: 'joycon', KEYBOARD: 'keyboard', MOUSE: 'mouse', SIM: 'sim', DEBUG: 'debug' });
/** Menu navigation (analog stick of a Joy-Con, arrow keys): a direction pushed (`down`) and released (`up`). One flick = one `down`. */
export const NAV_DIR = Object.freeze({ UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right' });
export const NAV_PHASE = Object.freeze({ DOWN: 'down', UP: 'up' });

// ------------------------------------------------------------------------------------------------ Clay Rush game (docs/game-design.md)
export const GAME_MODE = Object.freeze({ CLASSIC: 'classic', TIME_ATTACK: 'timeattack', ZEN: 'zen' });
/** 'practice' is the calibration test-shot round (one slow clay every 3 s from the trap house). It is not a menu mode. */
export const ROUND_MODE = Object.freeze({ ...GAME_MODE, PRACTICE: 'practice' });
export const DIFFICULTY = Object.freeze({ EASY: 'easy', NORMAL: 'normal', HARD: 'hard' });
export const STAGE_ID = Object.freeze({ MEADOW: 'meadow', HILLS: 'hills', ALPINE: 'alpine' });
/**
 * Round phases. Classic cycles ready -> pull -> flight -> settle (-> stageCard between stages) -> ... -> ending -> over.
 * Time Attack, Zen and practice stay in 'flight' (launches are automatic) until ending -> over.
 */
export const GAME_PHASE = Object.freeze({
  READY: 'ready', PULL: 'pull', FLIGHT: 'flight', SETTLE: 'settle', STAGE_CARD: 'stageCard', ENDING: 'ending', OVER: 'over',
});
export const TARGET_KIND = Object.freeze({ STANDARD: 'standard', MINI: 'mini', BATTUE: 'battue', RABBIT: 'rabbit', GOLD: 'gold' });
/** Which sprite frame a target is drawn with (render picks clay_std_tilt / clay_std_below / clay_std_edge / clay_rabbit / clay_gold_tilt). */
export const TARGET_FRAME = Object.freeze({ TILT: 'tilt', BELOW: 'below', EDGE: 'edge', RABBIT: 'rabbit', GOLD: 'gold' });
export const HOUSE_ID = Object.freeze({ TRAP: 'trap', SKEET_L: 'skeetL', SKEET_R: 'skeetR', TOWER: 'tower', RABBIT_L: 'rabbitL' });
export const LOST_REASON = Object.freeze({ GROUND: 'ground', FAR: 'far', OFFSCREEN: 'offscreen', TIMEOUT: 'timeout' });
export const END_REASON = Object.freeze({ COMPLETE: 'complete', TIMER: 'timer', QUIT: 'quit' });
export const RANK = Object.freeze({ S: 'S', A: 'A', B: 'B', C: 'C', D: 'D' });

export const GAME_EVENT = Object.freeze({
  STAGE_START: 'stageStart',
  READY: 'ready',
  PULL: 'pull',
  LAUNCH: 'launch',
  SHOT: 'shot',
  DRY_FIRE: 'dryFire',
  HIT: 'hit',
  LOST: 'lost',
  DOUBLE: 'double',
  TWO_WITH_ONE: 'twoWithOne',
  STREAK: 'streak',
  STAGE_CLEAR: 'stageClear',
  RELOAD: 'reload',
  KILL_CAM: 'killCam',
  HIT_STOP: 'hitStop',
  TIME_BONUS: 'timeBonus',
  TICK: 'tick',
  TIME_UP: 'timeUp',
  PHASE: 'phase',
  PRACTICE: 'practice',
});

export const SCREEN = Object.freeze({
  BOOT: 'boot',
  SAFETY: 'safety',
  CONNECT: 'connect',
  CALIBRATION: 'calibration',
  MENU: 'menu',
  SETUP: 'setup',
  SETTINGS: 'settings',
  BEST: 'best',
  TUNING: 'tuning',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  PAUSED: 'paused',
  RESULTS: 'results',
});

export const CAL_STEP_FAIL = Object.freeze({
  MOVED: 'moved',
  BAD_POSE: 'bad_pose',
  BAD_ACCEL: 'bad_accel',
  TIMEOUT: 'timeout',
  NO_DATA: 'no_data',
  NO_CALIBRATION: 'no_calibration',
});

export const MOTION_WARNING = Object.freeze({
  GYRO_SCALE_SUSPECT: 'gyro_scale_suspect',
  GYRO_SIGN_FLIPPED: 'gyro_sign_flipped',
  DT_FALLBACK: 'dt_fallback',
  SAMPLE_GAP: 'sample_gap',
  ACCEL_SATURATED: 'accel_saturated',
  GYRO_SATURATED: 'gyro_saturated',
  LOW_SAMPLE_RATE: 'low_sample_rate',
  ACCEL_GAIN_OFF: 'accel_gain_off',
});

/** Joy-Con 2 button names exactly as produced by BUTTON_TABLE in the protocol parser (docs/joycon2-protocol.md 7.7). */
export const BUTTON_NAMES = Object.freeze([
  'Y', 'X', 'B', 'A', 'SR_R', 'SL_R', 'R', 'ZR',
  'MINUS', 'PLUS', 'R_STICK', 'L_STICK', 'HOME', 'CAPTURE', 'C',
  'DOWN', 'UP', 'RIGHT', 'LEFT', 'SR_L', 'SL_L', 'L', 'ZL',
  'GR', 'GL',
]);

export const CONTRACT_VERSION = 1;

// <typedefs>
/**
 * ============================ PRIMITIVES ============================
 * @typedef {{x:number, y:number, z:number}} Vec3
 * @typedef {{x:number, y:number}} Point                Playfield px (1920 x 1080, origin top-left, y down).
 * @typedef {'L'|'R'|'?'} Side                          '?' = not known (yet).
 * @typedef {'joycon'|'sim'|'mouse'} ProviderKind       The native Bluetooth bridge reports 'joycon' too (same controller); `InputProvider.transport` tells it apart.
 * @typedef {'classic'|'timeattack'|'zen'} GameMode
 * @typedef {'classic'|'timeattack'|'zen'|'practice'} RoundMode
 * @typedef {'confirm'|'back'|'pause'|'recenter'|'fire'} ActionName   'fire' = the trigger (ZR by default), its t is the press time of the report that first showed it.
 *
 * @typedef {Object} Clock
 * @property {() => number} now                          Monotonic ms. Real clock = performance.now(). Never Date.now().
 * @property {boolean} manual                            true only for the manual test clock (?clock=manual).
 * @property {(ms:number) => void} [advance]             Present only when manual === true.
 *
 * ============================ INPUT ============================
 * ImuSample: ONE motion sample, produced by the real packet parser (BLE, simulator) and consumed by the Motion pipeline.
 * @typedef {Object} ImuSample
 * @property {number} seq                 0,1,2,... +1 per emitted sample within one provider session.
 * @property {number} t                   ms, Clock timebase: best estimate of the instant the sample was TAKEN. Non-decreasing,
 *                                        never later than arrivedAt.
 * @property {number} arrivedAt           ms, Clock timebase: when the notification handler ran.
 * @property {number|null} dtMs           Integration step since the previous sample, ms. From device timestamps when they pass
 *                                        the sanity check, else from arrival times. null on the first sample of a session and
 *                                        after a gap (dt <= 0 or dt >= 200 ms): consumers MUST NOT integrate across null.
 * @property {'device'|'arrival'|'synthetic'} dtSource
 * @property {Vec3} accel                 g, device frame. Specific force: at rest it points to world UP with magnitude ~1.
 * @property {Vec3} gyro                  deg/s, device frame, default scale 2000/32768 deg/s per LSB, bias NOT removed,
 *                                        sign NOT corrected (Motion does both).
 * @property {Side} side
 * @property {ReadonlyArray<string>} buttons   Names (BUTTON_NAMES) currently pressed. Shared frozen [] when none.
 * @property {number|null} batteryMv      Millivolts from the packet, null if unknown.
 * @property {number|null} tempC
 * @property {boolean} imuActive          false when the 12 motion bytes were all zero (IMU not enabled).
 *
 * @typedef {Object} AimSample            Direct aim from a pointer (mouse provider, debug swing). Playfield px.
 * @property {number} t                   ms, Clock timebase.
 * @property {number} x
 * @property {number} y
 * @property {boolean} [discontinuity]    true = teleport, do not connect to the previous sample.
 *
 * @typedef {Object} ButtonsEvent
 * @property {number} t
 * @property {Side} side
 * @property {ReadonlyArray<string>} pressed
 * @property {ReadonlyArray<string>} down         Newly pressed since the previous event.
 * @property {ReadonlyArray<string>} up           Newly released.
 *
 * @typedef {Object} ActionEvent          Edge event. Debounced by the emitter (no auto-repeat).
 * @property {number} t
 * @property {ActionName} action
 * @property {string} label               Display label for the UI, e.g. 'ZR', 'Space'.
 * @property {'joycon'|'keyboard'|'mouse'|'sim'|'debug'} source
 *
 * @typedef {Object} NavEvent            Menu navigation edge from the analog stick (provider event 'nav') or the arrow keys. `phase` 'down' is the
 *                                        flick (edge-triggered with hysteresis, input/stick.js), 'up' its release (the UI uses it to stop the auto-repeat of a value row).
 * @property {number} t
 * @property {'up'|'down'|'left'|'right'} dir
 * @property {'down'|'up'} phase
 * @property {'joycon'|'keyboard'|'mouse'|'sim'|'debug'} source
 * @property {number} [nx]                Normalised stick position at the edge (Joy-Con only), -1..1, y positive = up.
 * @property {number} [ny]
 *
 * @typedef {Object} ActionLabels         What to show in "Pause: {button}" style hints, for the ACTIVE provider.
 * @property {string} confirm
 * @property {string} back
 * @property {string} pause
 * @property {string} recenter
 * @property {string} fire                The trigger: ZR, R, ZL, L, Click or F.
 *
 * @typedef {Object} InputErrorInfo
 * @property {'unsupported_browser'|'permission_denied'|'cancelled'|'not_joycon'|'cooldown'|'gatt_failure'|'no_data'|'lost_signal'} code
 * @property {string} message             English, technical, for logs and the diagnostics page. NOT shown to the player.
 * @property {boolean} retryable          false only for unsupported_browser.
 * @property {number} at                  ms, Clock timebase.
 * @property {{code:string, key:string}} [native]   Additive, native Bluetooth bridge only: the bridge's own error code (docs/native-bridge.md 4) and the
 *                                        string key of the text that says what to do (strings.en.js). The UI prefers it to the `code` mapping.
 *
 * @typedef {Object} BatteryInfo
 * @property {number|null} mv
 * @property {'ok'|'low'|'critical'|'unknown'} level   BLE: ok >= 3550 mV, low 3300-3549, critical < 3300, unknown = no packet yet.
 * @property {number|null} pct            null for BLE (no trustworthy mV -> % map, UNVERIFIED-ON-HARDWARE), null for mouse.
 *
 * @typedef {Object} InputStatus          Immutable snapshot, a new object on every change.
 * @property {ProviderKind} kind
 * @property {'idle'|'requesting'|'connecting'|'initializing'|'streaming'|'lost'|'error'} state
 * @property {Side} side
 * @property {BatteryInfo} battery
 * @property {boolean} trackingOk         Provider-level: data is flowing and usable (streaming and fresh, pointer inside).
 * @property {InputErrorInfo|null} error  Last error, kept until the next successful streaming.
 * @property {number|null} cooldownUntil  ms, Clock timebase. connect()/reconnect() reject with 'cooldown' before this instant.
 * @property {number} failures            Consecutive failed attempts (reset to 0 when streaming starts).
 * @property {string|null} deviceName
 * @property {number|null} packetRateHz   Over the last 1 s, null until 2 packets.
 * @property {number|null} lastPacketAt
 * @property {number|null} featureMask    BLE only: mask in use (0xB7 default, 0xFF last resort; 0x37 is an expert choice).
 *
 * @typedef {Object} PacketEvent          Diagnostics feed, one per notification/synthetic packet.
 * @property {number} arrivedAt
 * @property {number} length
 * @property {Uint8Array} bytes           A COPY (the browser reuses its buffer).
 * @property {Object|null} report         Result of parseInputReport (docs/joycon2-protocol.md 7.7), null if rejected.
 * @property {number|null} t              The ImuSample.t derived from it, null if rejected.
 *
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} imu                Emits 'sample' (ImuSample). false for the mouse provider (emits 'aim').
 * @property {boolean} aim                Emits 'aim' (AimSample).
 * @property {boolean} buttons            Emits 'buttons'.
 * @property {boolean} needsUserGesture   connect() must run synchronously inside a click/keydown handler.
 * @property {boolean} needsCalibration   Motion needs the mount calibration wizard (true only for 'joycon').
 * @property {boolean} hasBattery
 * @property {boolean} canVibrate
 *
 * @typedef {Object} ConnectOptions
 * @property {'L'|'R'|'any'} [side]       Chooser filter for BLE. Default 'any'.
 * @property {'lenient'|'strict'|'all'} [filter]   BLE scan filter, default 'lenient' = INPUT_CONFIG.defaultFilter (product id only). 'strict' also requires the zero host address of a pairing-mode advert; 'all' is acceptAllDevices (docs/joycon2-protocol.md 3.3, docs/hardware-findings.md).
 * @property {number} [mask]              BLE feature mask override (expert), default 0xB7.
 * @property {boolean} [keepAlive]        BLE 1 Hz keep-alive, default true (expert toggle on the diagnostics page).
 * @property {boolean} [pairingOnly]      Native bridge only: connect only to a controller whose advert is in pairing mode (default false: pairing-mode adverts are preferred, any other Joy-Con 2 advert is the fallback).
 * @property {number} [scanSeconds]       Native bridge only: how long the helper looks for an advert (5 to 120, default 45).
 *
 * @typedef {Object} InputProvider
 * @property {ProviderKind} kind
 * @property {ProviderCapabilities} capabilities
 * @property {InputStatus} status                                   Getter, latest immutable snapshot.
 * @property {(opts?:ConnectOptions) => Promise<void>} connect      Resolves when state === 'streaming'. Rejects with an Error whose
 *                                                                  .code is an InputErrorInfo.code and .info is the InputErrorInfo.
 * @property {() => Promise<void>} reconnect                        Re-use the known device WITHOUT the chooser (BLE), subject to cooldown.
 * @property {() => Promise<void>} disconnect                       User-driven, goes to 'idle', never throws.
 * @property {(now:number) => void} [tick]                          Sim only: emit all samples due up to `now`.
 * @property {() => ActionLabels} getActionLabels
 * @property {'native'} [transport]                                 Additive: set by the native Bluetooth bridge provider only (kind stays 'joycon').
 * @property {() => object} [getBridgeInfo]                         Native bridge only: {phase, key, helperState, bridge, adverts, scanStartedAt, scanSeconds, lastCode, dropped, badReports}.
 * @property {(presetId:number) => void} [vibrate]                  BLE and native bridge, rate limited, optional (UNVERIFIED-ON-HARDWARE).
 * @property {Calibration|null} [nominalCalibration]                Sim only: exact calibration of the virtual mount.
 * @property {(type:string, fn:(payload:any) => void) => (() => void)} on   Returns an unsubscribe function.
 * @property {(type:string, fn:Function) => void} off
 * @property {() => void} dispose                                   Remove every listener and timer.
 * @property {(button:'ZR'|'R') => void} setTriggerButton   Which shoulder button fires (the other recentres); no-op on the mouse and the simulator.
 * @property {() => import('./contracts.js').ActionEvent} [fire]   Simulator only (on its sim hook object): emit a fire action at the newest report time.
 * Events: 'sample' ImuSample | 'aim' AimSample | 'buttons' ButtonsEvent | 'action' ActionEvent | 'status' InputStatus |
 *         'error' InputErrorInfo | 'packet' PacketEvent | 'log' {t:number, level:'info'|'warn'|'error', message:string} |
 *         'teleport' {t:number, x:number, y:number}   (simulator only, additive: the virtual mouse jumped; the host calls MotionPipeline.reanchor(x, y)) |
 *         'bridge' {phase:string, helperState:string, key:string|null, at:number, scanStartedAt:number|null, scanSeconds:number}   (native bridge only, additive: progress of the attempt)
 *
 * ============================ MOTION ============================
 * Sword frame (right-handed): right x forward = up. World frame: x = right, y = forward (towards the screen), z = up.
 * @typedef {Object} Calibration          Serialisable. Kept in memory for the session only (NOT trusted across sessions).
 * @property {1} version
 * @property {Side} side
 * @property {number} createdAt           Date.now() at creation (only place where wall-clock time is allowed).
 * @property {{right:Vec3, forward:Vec3, up:Vec3}} frame   Sword axes expressed in DEVICE coordinates. Orthonormal,
 *                                        right-handed. forward = blade tip direction, up = the direction that is up when the
 *                                        sword points horizontally at the screen (top edge of the blade).
 * @property {Vec3} gyroBiasDps           Device frame, subtracted from ImuSample.gyro.
 * @property {1|-1} gyroSign              Multiplier applied to all three gyro axes after bias removal.
 * @property {number} gyroScale           Multiplier on ImuSample.gyro (1 = protocol default 2000/32768 deg/s per LSB). The two known candidates are
 *                                        1 and 0.12288 (= 0.0075 / 0.06103515625, the disputed '48000 = 360 deg/s' scale).
 * @property {'default'|'stored'|'estimated'} gyroScaleSource
 * @property {number} [accelG0]           Additive (round 2 M2): the accelerometer magnitude at rest (g) learned in step 1, 0.85 to 1.15 accepted; Motion divides every accelerometer reading by it. Absent = 1.
 * @property {{poseAngleDeg:number|null, stillPeakDps:number, warnings:string[]}} quality
 *
 * @typedef {Object} MotionSettings
 * @property {number} sensitivity         0.3..2.0 (step 0.1, default 1.0): the multiplier of the whole pointer curve (relative model: 5 px/deg at slow aim rising to 14 px/deg in a fast swing, times this); the simulator's absolute model: pxPerDeg = 27.4 * sensitivity. It never touches the cut decision.
 * @property {number} cutThreshold        deg/s of TIP speed (100..700 step 25, default 300), base value before the mode multiplier. The cut decision is made in deg/s, independent of sensitivity; the aim path and the simulator compare px/s against cutThreshold * cutMul * 10/3.
 * @property {number} cutMul              Mode multiplier (classic/arcade 1, zen 0.8). Effective T = cutThreshold * cutMul (deg/s).
 * @property {boolean} autoCenter         Soft centring at rest.
 * @property {boolean} flipX              Mirror the horizontal axis (yaw sign cannot be validated by physics, see 6.4).
 * @property {'precise'|'balanced'|'fast'} [aimCurve]   Pointer gain preset (MOTION_CONFIG.aimCurves), default balanced.
 *
 * @typedef {Object} BladeSample          One per input sample (IMU or aim), emitted synchronously by pushImu/pushAim.
 * @property {number} t                   ms, Clock timebase.
 * @property {number} x                   Playfield px, clamped to 0..1920.
 * @property {number} y                   Clamped to 0..1080.
 * @property {number} speed               px/s-EQUIVALENT of the cut-decision speed: tip speed (deg/s) x 10/3 for IMU samples of the relative model, the cursor px/s over the last 50 ms (polyline length / span, at least 2 samples) for aim samples and the simulator. Standard threshold = 1000. The game, the trail and the audio read this scale and did not change.
 * @property {number} speedDps           Additive (sword tuning round): the cut-decision speed in deg/s (the tip speed, or speed / (10/3) for aim samples and the simulator). Always a number.
 * @property {number} vx                  Additive: cursor velocity at this sample in px/s (0 for aim samples and the absolute model); used by the path between two samples and the head extrapolation.
 * @property {number} vy
 * @property {boolean} interpolated       Additive: true only for samples that Motion inserted into its history ring between two real samples (every 8 ms, relative model); `recent()` returns them, the 'blade' event never does.
 * @property {boolean} cutting            Hysteresis state: enter >= T, leave < 0.65 T (relative model: two samples at or above T at least 25 ms apart).
 * @property {number} swingId             Integer, +1 per new swing (a re-entry within 100 ms keeps the id). 0 before the first.
 * @property {boolean} segmentValid       true = this sample delivered at least one collision-eligible segment (relative model: one or more chords of at most about 48 px; px tracker: cutting, length >= 6 px after merging), not a discontinuity, not dropped by the safety cap. The invariant segmentValid => cutting && !discontinuity holds.
 * @property {number} x0                  Start of the first segment this sample delivered (last anchor position; equals x when there is no segment).
 * @property {number} y0
 * @property {number} t0
 * @property {boolean} discontinuity      Trail must break; no cut may be tested across this sample.
 * @property {boolean} trackingOk
 * @property {number|null} angularSpeedDps  Total sword angular speed |w| for IMU samples, null for aim samples (the cut decision uses speedDps, the tip speed without the roll about the blade).
 * @property {'imu'|'aim'} source
 *
 * @typedef {Object} BladeSegment         A collision-eligible chord of the blade path, the ONLY thing Game.update() consumes. The relative model delivers several contiguous chords of at most about 48 px per IMU sample while cutting (no tunnelling at 33 Hz); `speed` is in the px/s-equivalent scale.
 * @property {number} t0
 * @property {number} x0
 * @property {number} y0
 * @property {number} t1
 * @property {number} x1
 * @property {number} y1
 * @property {number} speed
 * @property {number} swingId
 *
 * @typedef {Object} RecenterEvent
 * @property {number} t
 * @property {'manual'|'auto'|'edge'|'calibration'|'reconnect'} kind   ('edge' only in the absolute model; in the relative model 'auto' fires when the idle glide arrives at the centre)
 *
 * @typedef {Object} MotionWarning
 * @property {number} t
 * @property {'gyro_scale_suspect'|'gyro_sign_flipped'|'dt_fallback'|'sample_gap'|'accel_saturated'|'gyro_saturated'|'low_sample_rate'|'accel_gain_off'} code
 * @property {string} message
 *
 * @typedef {{type:'started', t:number, quick:boolean}
 *   | {type:'progress', t:number, step:1|2|3, phase:'waiting'|'holding'|'transition', progress:number, meanDps:number, peakDps:number, accelMagG:number}
 *   | {type:'stepPassed', t:number, step:1|2|3}
 *   | {type:'stepFailed', t:number, step:1|2|3, reason:'moved'|'bad_pose'|'bad_accel'|'timeout'|'no_data'|'no_calibration'}
 *   | {type:'done', t:number, quick:boolean, calibration:Calibration, warnings:string[]}
 *   | {type:'cancelled', t:number}} CalibrationEvent
 *
 * @typedef {Object} MotionState
 * @property {boolean} calibrated
 * @property {null|1|2|3} calibrationStep
 * @property {number} x
 * @property {number} y
 * @property {number} speed               px/s-equivalent (see BladeSample.speed)
 * @property {number} speedDps           Additive: cut-decision speed in deg/s
 * @property {number} cutThresholdDps    Additive: effective cut threshold in deg/s (cutThreshold x cutMul, so 240 in a Zen round at Normal)
 * @property {'relative'|'absolute'} pointerModel   Additive: 'relative' for a real Joy-Con, 'absolute' for the simulator
 * @property {boolean} cutting
 * @property {number} swingId
 * @property {number|null} yawDeg         Relative to the current centre reference; null in the relative model (there are no absolute angles).
 * @property {number|null} pitchDeg
 * @property {number} angularSpeedDps
 * @property {boolean} trackingOk         false when no sample for 200 ms or uncalibrated.
 * @property {boolean} refDriven          Additive (R2-01): the newest IMU sample's position came (partly) from the REFERENCES moving (soft centring, edge slip, recentre ease, re-reference; in the relative model the idle glide to the centre and the recentre ease), not from the sword. The menu dwell never starts on a cursor the reference dragged onto a target. false for aim samples.
 * @property {number|null} sampleRateHz
 * @property {number} lastSampleT
 *
 * @typedef {Object} MotionPipeline
 * @property {(s:ImuSample) => void} pushImu
 * @property {(s:AimSample) => void} pushAim
 * @property {(nowMs:number) => void} poll                Call every frame: tracking loss, auto-centre, segment flush.
 * @property {(patch:Partial<MotionSettings>) => void} setSettings
 * @property {() => MotionSettings} getSettings
 * @property {(cal:Calibration|null) => void} setCalibration
 * @property {() => Calibration|null} getCalibration
 * @property {(opts?:{side?:Side}) => void} startCalibration   Steps 1..3 (step 4 is a practice round run by Game/UI).
 * @property {() => void} cancelCalibration
 * @property {() => void} confirmCenter                   Player pressed recenter/confirm during step 3.
 * @property {() => void} beginQuickRecenter              Step 3 only (hold still 1.5 s or confirmCenter), frame unchanged.
 * @property {(kind?:'manual'|'reconnect') => void} recenter
 * @property {(reason:string) => void} markDiscontinuity  Next blade sample has discontinuity = true. Reason 'lost' also restarts the orientation filter from gravity (relative model: the cursor does not move, a hole loses only the motion inside it).
 * @property {(model:'relative'|'absolute') => void} setPointerModel   Additive (sword tuning round): 'relative' (a real Joy-Con, the default) or 'absolute' (the simulator). Call it when the provider changes, before reset() and setCalibration(null); it resets nothing itself. A relative pointer is a mouse in the local frame of the sword (dead zone, acceleration curve, idle soft auto-centre).
 * @property {() => 'relative'|'absolute'} getPointerModel
 * @property {(sign:1|-1) => void} setAccelSign          Additive (round 2 M3): the accelerometer sign of the ACTIVE provider (see createMotionPipeline accelSign). Call before reset() when the provider changes.
 * @property {(scale:number|null) => void} setGyroScaleOverride  Additive (round 2 M3): the stored gyro scale of the ACTIVE provider, or null. Call before reset() and setCalibration(null) when the provider changes.
 * @property {(x:number, y:number) => void} reanchor      Additive (integrator): the sensor pose JUMPED (simulator teleport) or a test wants the cursor somewhere. Absolute model: restarts the filter from gravity and the next IMU sample maps to (x, y); relative model: the cursor is put at (x, y) at the next IMU sample. Both with a discontinuity.
 * @property {() => object} getDebug                      Additive (motion): internal state for the overlay and tests, never for game logic.
 * @property {() => BladeSegment[]} drainSegments         Returns and clears the eligible segments since the last call, oldest first (several per IMU sample while cutting in the relative model).
 * @property {(windowMs:number) => BladeSample[]} recent  Samples with t >= latest.t - windowMs (relative to the NEWEST sample), oldest first (ring of 384; the relative model adds `interpolated` samples every 8 ms between two real ones).
 * @property {() => BladeSample|null} latest
 * @property {(nowMs:number) => Point|null} headAt        Newest position, extrapolated for drawing the blade head only (relative model: up to 35 ms with the last acceleration, never reversing; absolute model and aim path: linear, at most 15 ms). Never used for collision.
 * @property {(tMs:number) => {x:number, y:number, valid:boolean}} aimAt   Pointer position at tMs, interpolated in the aim history (never extrapolated); valid false outside the history or when tracking was not ok (x, y then the nearest known position). Used for the trigger-compensated shot.
 * @property {(tPressMs:number, compMs:number) => {jerkPeakDps:number, displacementPx:number, valid:boolean}} shotDiagnostics   Trigger jerk of one press (aim tuning screen).
 * @property {() => MotionState} getState
 * @property {() => void} reset                           Clears filter, tracker and history. Keeps settings and calibration.
 * @property {(type:string, fn:(payload:any) => void) => (() => void)} on
 * @property {(type:string, fn:Function) => void} off
 * Events: 'blade' BladeSample | 'calibration' CalibrationEvent | 'recenter' RecenterEvent | 'warning' MotionWarning
 *
 * ============================ SHOT (input -> app -> game) ============================
 * @typedef {Object} Shot                 One trigger pull, built by app.js from a 'fire' ActionEvent (docs/architecture.md 4.2).
 * @property {number} t                   ms, Clock timebase: the press time (ActionEvent.t), NOT the time app.js handled it.
 * @property {number} x                   Playfield px: the trigger-compensated aim point (motion.aimAt(t - compMs)), clamped to the field.
 * @property {number} y
 * @property {'joycon'|'keyboard'|'mouse'|'sim'|'debug'} source
 * @property {number} compMs              The compensation that was applied (0 for mouse, keyboard, sim, debug).
 *
 * ============================ GAME ============================
 * @typedef {Object} GameOptions
 * @property {'easy'|'normal'|'hard'} [difficulty]   Default 'normal'. Ignored by zen and practice.
 * @property {'meadow'|'hills'|'alpine'} [stage]      Time Attack and Zen: the stage played (default 'hills'). Classic plays all three in order.
 * @property {boolean} [assist]           Aim assist Light (docs/game-design.md 6.5). Default false.
 * @property {boolean} [autoPull]         Classic: call "Pull!" automatically 1.2 s after 'ready'. Default false.
 * @property {boolean} [reduceMotion]     No hit-stop, no kill-cam slow motion (the events still fire with durationMs 0).
 *
 * @typedef {Object} Target               An airborne target (broken targets leave the list; their 'hit' event carries what fx need).
 * @property {number} id                  Unique within the round, +1 per launch, never reused.
 * @property {'standard'|'mini'|'battue'|'rabbit'|'gold'} kind
 * @property {'tilt'|'below'|'edge'|'rabbit'|'gold'} frame
 * @property {number} x @property {number} y @property {number} z      World metres (shared/world.js), current tick.
 * @property {number} vx @property {number} vy @property {number} vz   m/s.
 * @property {number} sx @property {number} sy   Projected playfield px of the centre, INTERPOLATED with snapshot.alpha.
 * @property {number} rPx                 Drawn radius in px (half the drawn diameter: worldSize/2 * F / z).
 * @property {number} rot                 rad, screen rotation of the sprite (cosmetic).
 * @property {number} ageS                World seconds since launch.
 * @property {number} pullIndex           Which pull of the stage launched it (Classic), else the launch counter.
 *
 * @typedef {Object} House                A launcher drawn on the field.
 * @property {'trap'|'skeetL'|'skeetR'|'tower'|'rabbitL'} id
 * @property {string|null} sprite         'house_trap' | 'house_skeet' | 'house_tower' | null (rabbitL has no building).
 * @property {number} x @property {number} y @property {number} z
 * @property {number} sx @property {number} sy   Projected ground point (bottom centre of the building).
 * @property {number} scale               px per metre at its depth (F / z).
 * @property {boolean} mirrored
 * @property {number} flashS              Seconds since its last launch (a huge number when it never launched): drives a puff at the door.
 *
 * @typedef {Object} GameSnapshot         Plain data, JSON-serialisable, a new object per call.
 * @property {1} v
 * @property {'classic'|'timeattack'|'zen'|'practice'} mode
 * @property {'easy'|'normal'|'hard'} difficulty
 * @property {number} seed
 * @property {'ready'|'pull'|'flight'|'settle'|'stageCard'|'ending'|'over'} phase
 * @property {number} t                   Real seconds since the round started (timers).
 * @property {number} tWorld              World seconds (slowed by timeScale).
 * @property {number} alpha               0..1, interpolation factor between the last two world ticks (already applied to Target.sx/sy).
 * @property {number} timeScale           0..1 (kill cam 0.25, hit stop 0).
 * @property {{index:number, id:'meadow'|'hills'|'alpine', count:number, name:string}} stage   index 0-based; count = stages in this round.
 * @property {{index:number, count:number|null, targetsLeft:number}} pull   Classic: pull index in the stage (0-based) and pulls in the stage; else count null.
 * @property {{x:number, gust:number}} wind   m/s, + = to the right; gust is the current extra.
 * @property {{loaded:number, capacity:number, reloadingS:number, infinite:boolean}} shells   reloadingS > 0 while a reload runs.
 * @property {number} score
 * @property {number} streak              Consecutive broken targets.
 * @property {number} multiplier          1..4.
 * @property {number} multiplierProgress  0..1 towards the next multiplier step (1 at x4).
 * @property {number|null} timeLeft       Time Attack seconds left, else null.
 * @property {number|null} timeTotal
 * @property {Target[]} targets
 * @property {House[]} houses             Houses of the current stage, far first.
 * @property {{x:number, y:number, leftS:number, zoom:number}|null} killCam
 * @property {{shown:number, hit:number}|null} practice
 * @property {{presented:number, broken:number, lost:number, shots:number, hits:number, centre:number, doubles:number, bestStreak:number}} stats
 *   hits = shots that broke at least one target; accuracy = hits / shots.
 * @property {boolean} assist
 * @property {'complete'|'timer'|'quit'|null} endReason
 * @property {GameEvent[]} events         The last 32 events (debugging only; consumers use drainEvents()).
 *
 * Every GameEvent has {seq:int, t:number (real seconds of the round), type} plus the fields below (validated by shared/validate.js):
 *   stageStart {index, id, name, windX}                     ready {stageIndex, pullIndex}
 *   pull {delayMs}                                          launch {ids:number[], house, double:boolean}
 *   shot {x, y, shell:int (0 first barrel, 1 second, -1 unlimited), hitIds:number[], source, compMs}
 *   dryFire {x, y}
 *   hit {id, kind, x, y (px), z (m), rPx, vx, vy (px/s on screen), points, centre, firstBarrel, multiplier, streak, shardSeed:int}
 *   lost {id, kind, x, y, reason:'ground'|'far'|'offscreen'|'timeout'}
 *   double {points, x, y}   twoWithOne {points, x, y}   streak {level (new multiplier), streak}
 *   stageClear {index, perfect, bonus}   reload {phase:'start'|'done', ms}   killCam {x, y, durationMs, scale}   hitStop {ms}
 *   timeBonus {deltaS, timeLeft}   tick {secondsLeft}   timeUp {score}   phase {phase}   practice {phase:'thrown'|'hit'|'lost'}
 * @typedef {Object} GameEvent
 *
 * @typedef {Object} RoundResult
 * @property {'classic'|'timeattack'|'zen'|'practice'} mode
 * @property {'easy'|'normal'|'hard'} difficulty
 * @property {'meadow'|'hills'|'alpine'|null} stageId    null for Classic (all stages).
 * @property {number} score @property {number} presented @property {number} broken @property {number} lost
 * @property {number} shots @property {number} hits @property {number|null} accuracy   hits / shots, null when no shot.
 * @property {number} bestStreak @property {number} doubles @property {number} centre
 * @property {number} durationS
 * @property {'complete'|'timer'|'quit'} endReason
 * @property {'S'|'A'|'B'|'C'|'D'|null} rank   null for zen and practice.
 * @property {boolean} assist
 *
 * @typedef {Object} Game
 * @property {(frameDtS:number, shots:Shot[], nowMs:number) => void} update   Real frame time in s (clamped to 0.1 inside); shots in press order.
 * @property {() => GameSnapshot} snapshot
 * @property {() => GameEvent[]} drainEvents      Each event exactly once.
 * @property {() => boolean} isOver
 * @property {() => RoundResult|null} getResult   null until isOver().
 * @property {(reason?:'quit') => void} end       Ends the round now (endReason 'quit').
 * @property {(spec:object) => number[]} debugSpawn   Launch targets now (kind, house, speed, azimuthDeg, elevationDeg), returns their ids.
 * @property {(on:boolean) => void} debugSetAutoLaunch   false: no automatic launches (Classic pulls still work when called).
 *
 * ============================ PRESENTATION ============================
 * @typedef {Object} Settings             Persisted in localStorage key 'clayRush.v1' (docs/architecture.md 8.4).
 *
 * ============================ DEBUG API (window.__clay) ============================
 * See docs/architecture.md 9.3 for the exact method list.
 */
// </typedefs>
