// Clay Rush: input configuration (data only). OWNER: input engineer.
//
// Every number that steers the input layer lives here (docs/architecture.md rule 9 and section 5.6). Values marked
// UNVERIFIED-ON-HARDWARE come from docs/joycon2-protocol.md (third-party sources) and were never observed on a real
// Joy-Con 2. The file is data-only and importable by every module (architecture section 2.3).

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export const INPUT_CONFIG = deepFreeze({
  // The `connect` block of docs/game-design.md Appendix A (kept verbatim for the UI).
  connect: { cooldownS: 10, autoReconnectAttempts: 1, autoReconnectDelayS: 2, lowBatteryPct: 15 },

  // --- Reconnect and cooldown policy (architecture A-14, protocol 5.5). UNVERIFIED-ON-HARDWARE (UOH-11).
  cooldownS: 10, // after a failed connect or a lost link
  longCooldownS: 180, // after `longCooldownAfterFailures` consecutive failures
  longCooldownAfterFailures: 3,
  autoReconnectAttempts: 1, // silent retries after a lost link; never a loop
  autoReconnectDelayS: 2,

  // --- BLE identifiers (protocol sections 3.1, 3.3, 4). UNVERIFIED-ON-HARDWARE (UOH-1, UOH-2).
  service: 'ab7de9be-89fe-49ad-828f-118f09df7fd0',
  characteristics: {
    input: 'ab7de9be-89fe-49ad-828f-118f09df7fd2', // NOTIFY, 63-byte input report 0x05
    command: '649d4ac9-8eb7-4e6c-af44-1ea54fe5f005', // WRITE_WITHOUT_RESPONSE, the ONLY characteristic we ever write to
    response: 'c765a961-d9d8-4d36-a20a-5315b111836a', // NOTIFY, command responses (optional)
    vibrationLeft: '289326cb-a471-485d-a8f4-240c14f18241', // exists on the Left unit only (side detection)
    vibrationRight: 'fa19b0fb-cd1f-46a7-84a1-bbb09e00c149', // exists on the Right unit only (side detection)
  },
  // Never written, never subscribed (protocol section 4 and rule 11 of the architecture).
  forbiddenCharacteristics: [
    '4147423d-fdae-4df7-a4f7-d23e5df59f8d', // large command / firmware update channel
    'ab7de9be-89fe-49ad-828f-118f09df7fdf', // looks like the command characteristic, is not
  ],
  companyId: 0x0553, // Nintendo's Bluetooth SIG id as exposed by Chrome (protocol 3.1)
  altCompanyId: 0x057e, // second filter entry of the lenient filter only (protocol D12)
  pid: { L: 0x2067, R: 0x2066 }, // product id, manufacturer data idx 5-6, little endian
  // Chooser filter used when the caller names none (`?filter=`, the diagnostics page and the connect screen fallback can). 'lenient' =
  // product id only (+ company 0x057E entry); 'strict' adds "host address bytes idx 10-15 are zero"; 'all' = acceptAllDevices.
  // Why lenient: on the first real-hardware test Chrome's chooser listed nothing with 'strict', cause unknown. A real CoreBluetooth
  // scan (docs/hardware-findings.md, 2026-09-30) saw the controller send TWO adverts (a bonded-console address before SYNC, the zero
  // address after it), so 'strict' can match only one of them; a second native probe saw the zero-address advert at once, so that is
  // only a POSSIBLE cause. 'lenient' needs fewer assumptions. Whether it lists the controller in Chrome is UNVERIFIED-ON-HARDWARE (UOH-1).
  defaultFilter: 'lenient',
  // localStorage key of the filter that last led to a connection (app.js reads and writes it inside try/catch; memory fallback).
  filterStorageKey: 'joyconNinja.ble.v1',
  // localStorage key of the connection path that last reached `streaming`: {"v":1,"path":"native"|"chrome"} (app.js, inside try/catch).
  // The connect screen offers that path first the next time.
  pathStorageKey: 'joyconNinja.path.v1',
  nameMarker: { L: '(L)', R: '(R)' }, // GAP name hint ("Joy-Con 2 (L)"), unreliable on macOS Chrome (protocol 3.2)

  // --- Initialisation and streaming (protocol 5.3, 5.4, 5.5). UNVERIFIED-ON-HARDWARE (UOH-3, UOH-5, UOH-15).
  // Feature mask sent by SET/ENABLE on the plain command characteristic. Round 1 finding F1 (docs/protocol-audit.md): 0x37 is only
  // ever written by joycon2cpp inside a console-style init to a DIFFERENT characteristic (rumble + command, 17-byte zero prefix);
  // its plain-channel helper that would send 0x37 is defined and never called. The masks that projects use successfully on
  // 649d4ac9-...-f005 are 0xB7 (switch2mac, macOS) and 0xFF (mascii on Chrome Web Bluetooth, seitanmen on macOS, yujimny, JoeGeC).
  // 0xB7 = 0x37 plus the magnetometer bit (0x80), which only adds bytes the game never reads; it has no phantom ZL/ZR bits.
  // 0x37 stays selectable (?mask=0x37, diagnostics page) as an expert option. Whether any of them works on the owner's Joy-Con is
  // UNVERIFIED-ON-HARDWARE (UOH-3); the diagnostics page shows which one does and the URL that makes the game use it.
  featureMask: 0xb7,
  fallbackMask: 0xff, // last resort of watchdog stage 2 (may induce phantom ZL/ZR bits: see action.recenterHoldOffMs)
  connectTimeoutMs: 15000,
  discoveryTimeoutMs: 15000,
  responseSubscribeTimeoutMs: 3000, // the command-response subscription is optional: do not let it stall the init
  serialHangCapMs: 10000, // the GATT chain waits at most this long for one hung operation before it lets the next one go (round 2 m4)
  settleMs: 300, // pause between gatt.connect() and service discovery
  initSpacingMs: 500, // wait for a command response, or at most this long, between init commands
  writeSpacingMs: 100, // minimum gap between two writes (CoreBluetooth may drop bursts)
  keepAliveMs: 1000, // keep-alive cadence (macOS drops the link about 10-17 s after the last host write, single source)
  keepAliveIdleMs: 900, // send the keep-alive only when no write happened for this long
  watchdogMs: [2000, 4500, 9000], // stage 1 re-ENABLE, stage 2 SET+ENABLE with fallbackMask, stage 3 fail with no_data
  lostAfterMs: 2500, // streaming without a report for this long (visible tab) = link lost
  trackingStaleMs: 400, // provider-level trackingOk turns false when the newest IMU sample is older than this
  watchTickMs: 250, // housekeeping tick: silence detection, trackingOk, packet rate
  hapticMinIntervalMs: 100, // vibrate() rate limit (10 per second)

  // --- Battery (protocol 7.6). Millivolts only, no percentage (A-15, UOH-17).
  batteryLowMv: 3550,
  batteryCriticalMv: 3300,

  // --- Report stream (architecture 5.5, protocol 7.3).
  report: {
    minLength: 60, // shorter notifications are rejected (truncated MTU, UOH-3)
    dtMaxUs: 200000, // device timestamp deltas at or above this are a gap
    trustWindowMs: 1000, // window over which device timestamps are compared with arrival times
    trustMinIntervals: 8, // minimum intervals in a window before it is judged
    trustRatioMin: 0.8,
    trustRatioMax: 1.25,
    badStreakToFallback: 3, // consecutive unusable timestamp deltas => use arrival times (stuck timestamps)
    arrivalDtFloorMs: 0.5, // the arrival-fallback dt never goes below this
    arrivalMeanPackets: 32, // the arrival-fallback dt is the mean arrival interval of this many recent packets
    arrivalDtMaxMs: 200, // arrival deltas at or above this are a gap
    offsetLeakPerMs: 0.0002, // the running-minimum clock offset creeps up by 0.2 ms per second (clock drift up to 200 ppm)
    rateWindowMs: 1000,
    rateRingSize: 512,
    lossRatio: 1.6, // a device delta above this multiple of the typical delta counts as dropped packets
    burstRatio: 0.2, // an arrival delta below this fraction of the typical delta while the device delta is normal = burst
  },

  // --- Actions (architecture 5.7; Clay Rush architecture 4.1, C-02).
  // minIntervalMs: contact-bounce guard between two edges of the same action (every action except `fire`, measured on the clock).
  // fireMinIntervalMs: the guard of `fire`, measured on the REPORT times (ButtonsEvent.t), so a burst of reports delivered together
  // cannot swallow a real second shot. Must stay below 70 ms: the two shots of an over-and-under are about 150 to 250 ms apart, and at
  // 33 Hz a press, release, press takes at least 60 ms of report time. 40 ms still drops a one-report bounce at 33 Hz.
  // UNVERIFIED-ON-HARDWARE: nobody has measured how fast a real ZR can be pulled twice, nor whether it bounces.
  // recenterHoldOffMs: after the feature mask was changed by the watchdog (stage 2) the actions of the ZL/ZR/L/R shoulder buttons
  // (`recenter` AND `fire`) ignore edges for this long: a mask that "induces phantom ZL/ZR bits" (protocol audit F1) must not fire
  // spurious re-centres or shots. It happens only while connecting. UNVERIFIED-ON-HARDWARE (UOH-10).
  action: { minIntervalMs: 120, fireMinIntervalMs: 40, recenterHoldOffMs: 1500 },
  // The trigger (C-02): 'ZR' (default) fires with ZR (ZL on a Left unit) and recentres with R (L); 'R' swaps the two.
  triggerButtons: ['ZR', 'R'],
  defaultTriggerButton: 'ZR',

  // --- Analog stick as the menu pointer (docs/contract-notes.md, "Stick navigation"). Pure data of input/stick.js.
  // MEASURED (recordings/imu-2026-09-30T18-42-24.jsonl, one Joy-Con 2 Right, 399 reports of the untouched `rest_table` step): the right stick field
  // rests at x 1998.4 (sd 0.6, range 1996..2001) and y 2006.8 (sd 0.5, range 2006..2008), i.e. 49 and 40 LSB below the nominal 12-bit centre,
  // so the centre is ESTIMATED per session; the unused (left) field of a Right unit reads exactly 2047 / 2047 in all 4754 reports. While the
  // owner handled the controller (the other steps) the field wandered to x 726..2520 and y 1687..2984, which is why the thresholds below are
  // far above the noise. ASSUMED, UNVERIFIED-ON-HARDWARE: the full travel (`halfRange`: the largest deflection seen in the recording was 1272 LSB,
  // so the half range is at least that), the direction (larger y = up, larger x = right) and that the Left unit behaves alike.
  stick: {
    nominalCentre: 2047, // used until a centre could be estimated, and as the plausibility anchor of the estimate
    halfRange: 1500, // ASSUMED half travel in LSB: the normalised value is (raw - centre) / halfRange, clamped to -1..1
    deadZone: 0.35, // below this normalised magnitude the stick counts as centred (reported as such, never moves anything)
    moveThreshold: 0.55, // a flick fires ONE move when the magnitude first reaches this
    rearm: 0.3, // the next move needs the magnitude to fall below this first (hysteresis: one flick, one move)
    yUp: 1, // 1: a larger raw y is "up" (the Joy-Con convention); -1 flips it. UNVERIFIED-ON-HARDWARE
    // The centre is the mean of `window` consecutive reports that agree within `maxSpread` LSB (rest noise measured: 3 to 6 LSB) and lie within
    // `maxOffset` LSB of the nominal centre (a stick held to one side for the whole window never becomes the centre).
    centre: { window: 12, maxSpread: 24, maxOffset: 450 },
  },

  // --- Mouse provider (architecture 5.9).
  mouse: { silenceMs: 200 }, // first sample after this much silence is a discontinuity

  // --- Simulator (architecture 5.8, protocol Appendix A). It models the protocol document, not the device.
  sim: {
    hz: 66, // A-12; ?simhz=250 selects the design's 250 Hz
    jitterMs: 3, // +-3 ms on the report timestamps (scaled down so timestamps stay monotonic at high rates)
    jitterMaxPeriodFraction: 0.35,
    baseLatencyMs: 4, // fixed delivery delay from measurement to arrival
    latencyJitterMs: 2, // 0..2 ms extra delivery delay
    burstProb: 0.03, // probability that a report is held back and delivered together with the next one
    gyroBiasDps: 1.5, // constant bias per axis, uniform within +-this (protocol 7.5)
    gyroNoiseDps: 0.15, // white noise sigma
    accelNoiseG: 0.004,
    leverM: 0.45, // accelerometer distance from the pivot along the blade (lever-arm contamination)
    followTauMs: 5, // critically damped follower time constant (<= 6 ms, A-22 / architecture 5.8)
    alphaSmoothMs: 25, // angular acceleration used by the lever arm is taken from a low-passed rate
    stepMs: 1, // physics sub-step
    pxPerDeg: 27.4, // fixed base mapping of the virtual mouse (A-22)
    maxCatchUpMs: 250, // tick() never emits reports older than this behind `now` (they become a gap)
    selfTickMs: 4, // real-clock self-scheduling interval
    startTimestampUs: 3000000, // IMU timestamp of the first report (any value works; wrap tests override it)
    startCounter: 3500, // 0x00 counter (a millisecond clock in the real captures)
    temperatureRaw: 5, // about 25 deg C
    batteryMv: 3700,
    gyroLsbDps: { default: 2000 / 32768, alt: 0.0075 }, // true dps per LSB of the two disputed scales (protocol D1)
    defaultGyroLsbDps: 2000 / 32768,
    calibrationScript: { tipUpStillMs: 2600, rotateMs: 1200, pointStillMs: 2200, holdCentreMs: 3200 },
  },

  // --- Diagnostics page (architecture 5.10).
  diagnostics: {
    storageKey: 'joyconNinja.imu.v1', // shared with main.js (A-13)
    scale: { holdStillMs: 1000, deadbandDps: 2, defaultTolerance: 0.12, candidateRatio: 0.12288, altTurnDeg: 2930 },
    restCheckMs: 3000,
    signHoldMs: 2000,
    signMinAngleDeg: 30,
    latencyWindow: 300,
    logLines: 60,
  },
});
