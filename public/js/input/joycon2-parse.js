// Joy-Con 2 input report 0x05 parser. OWNER: input engineer.
//
// Pure functions, no DOM, no globals. The byte layout is NORMATIVE and comes from docs/joycon2-protocol.md sections 6
// and 7.7; it is verified against the two real third-party captures (V1, V2) and the synthetic vector V3 of
// docs/joycon2-test-vectors.json. Whether a physical Joy-Con 2 really sends this layout through Chrome on macOS is
// UNVERIFIED-ON-HARDWARE (UOH-3); the two captures were taken by third parties with other host stacks.
//
// Units: accel g = raw / 4096 (protocol 7.1, high confidence); gyro deg/s = raw * 2000/32768 (medium confidence and
// DISPUTED, protocol D1 and 7.2: the Motion pipeline applies Calibration.gyroScale on top; UNVERIFIED-ON-HARDWARE, UOH-6).

export const ACCEL_G_PER_LSB = 1 / 4096; // exact
export const GYRO_DPS_PER_LSB = 2000 / 32768; // 0.06103515625, exact in binary
export const MIN_LEN = 0x3c; // 60 bytes: enough for every IMU field
export const REPORT_LENGTH = 63; // real reports are exactly this long

/** [byteOffset, bitMask, name]. Bits that are not listed (for example 0xE0 in byte 7) are deliberately ignored. */
export const BUTTON_TABLE = Object.freeze(
  [
    [4, 0x01, 'Y'], [4, 0x02, 'X'], [4, 0x04, 'B'], [4, 0x08, 'A'], [4, 0x10, 'SR_R'], [4, 0x20, 'SL_R'], [4, 0x40, 'R'], [4, 0x80, 'ZR'],
    [5, 0x01, 'MINUS'], [5, 0x02, 'PLUS'], [5, 0x04, 'R_STICK'], [5, 0x08, 'L_STICK'], [5, 0x10, 'HOME'], [5, 0x20, 'CAPTURE'], [5, 0x40, 'C'],
    [6, 0x01, 'DOWN'], [6, 0x02, 'UP'], [6, 0x04, 'RIGHT'], [6, 0x08, 'LEFT'], [6, 0x10, 'SR_L'], [6, 0x20, 'SL_L'], [6, 0x40, 'L'], [6, 0x80, 'ZL'],
    [7, 0x01, 'GR'], [7, 0x02, 'GL'],
  ].map((row) => Object.freeze(row)),
);

/** Byte offsets of the fields (protocol 6.1), exported for the builder and the diagnostics page. */
export const OFFSET = Object.freeze({
  counter: 0x00, buttons: 0x04, leftStick: 0x0a, rightStick: 0x0d, mouse: 0x10, mag: 0x19, battery: 0x1f, chargeState: 0x21,
  batteryCurrent: 0x22, imuMarker: 0x29, imuTimestamp: 0x2a, temperature: 0x2e, accel: 0x30, gyro: 0x36, triggerL: 0x3c, triggerR: 0x3d,
});

const IMU_BYTES = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b];

/** Accept Uint8Array, DataView, ArrayBuffer or a plain array; returns a Uint8Array view (no copy when possible). */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  return null;
}

function stick12(dv, o) {
  // three bytes little endian -> two 12-bit values
  const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
  return { x: v & 0xfff, y: v >>> 12 };
}

/**
 * Parse one input report.
 * @param {Uint8Array|DataView|ArrayBuffer|number[]} input
 * @param {'L'|'R'|'?'} [side]  only selects which stick field is reported as `stick`
 * @returns {object|null}  null when the input is too short (truncated notification) or not bytes
 */
export function parseInputReport(input, side = '?') {
  const bytes = toBytes(input);
  if (!bytes || bytes.length < MIN_LEN) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const s16 = (o) => dv.getInt16(o, true);

  const pressed = [];
  for (let i = 0; i < BUTTON_TABLE.length; i++) {
    const row = BUTTON_TABLE[i];
    if ((dv.getUint8(row[0]) & row[1]) !== 0) pressed.push(row[2]);
  }
  const accelRaw = { x: s16(OFFSET.accel), y: s16(OFFSET.accel + 2), z: s16(OFFSET.accel + 4) };
  const gyroRaw = { x: s16(OFFSET.gyro), y: s16(OFFSET.gyro + 2), z: s16(OFFSET.gyro + 4) };
  const leftField = stick12(dv, OFFSET.leftStick);
  const rightField = stick12(dv, OFFSET.rightStick);
  const temperatureRaw = s16(OFFSET.temperature);
  let imuActive = false;
  for (let i = 0; i < IMU_BYTES.length; i++) {
    if (dv.getUint8(IMU_BYTES[i]) !== 0) {
      imuActive = true;
      break;
    }
  }

  return {
    length: bytes.length,
    counter: dv.getUint32(OFFSET.counter, true),
    buttonsRaw: dv.getUint32(OFFSET.buttons, true),
    pressed,
    stickFields: { left: leftField, right: rightField },
    stick: side === 'R' ? rightField : leftField, // '?' falls back to the left field (protocol 6.3)
    mouse: { x: dv.getUint16(OFFSET.mouse, true), y: dv.getUint16(OFFSET.mouse + 2, true), quality: dv.getUint16(OFFSET.mouse + 4, true), lift: dv.getUint16(OFFSET.mouse + 6, true) },
    magRaw: { x: s16(OFFSET.mag), y: s16(OFFSET.mag + 2), z: s16(OFFSET.mag + 4) },
    batteryMv: dv.getUint16(OFFSET.battery, true),
    chargeState: dv.getUint8(OFFSET.chargeState),
    batteryCurrentRaw: s16(OFFSET.batteryCurrent),
    imuMarker: dv.getUint8(OFFSET.imuMarker),
    imuTimestampUs: dv.getUint32(OFFSET.imuTimestamp, true),
    temperatureRaw,
    temperatureC: 25 + temperatureRaw / 127,
    accelRaw,
    gyroRaw,
    accelG: { x: accelRaw.x * ACCEL_G_PER_LSB, y: accelRaw.y * ACCEL_G_PER_LSB, z: accelRaw.z * ACCEL_G_PER_LSB },
    gyroDps: { x: gyroRaw.x * GYRO_DPS_PER_LSB, y: gyroRaw.y * GYRO_DPS_PER_LSB, z: gyroRaw.z * GYRO_DPS_PER_LSB },
    triggerL: bytes.length > OFFSET.triggerL ? dv.getUint8(OFFSET.triggerL) : 0, // beyond a 60 byte report: GameCube pad only, 0 for a Joy-Con
    triggerR: bytes.length > OFFSET.triggerR ? dv.getUint8(OFFSET.triggerR) : 0,
    imuActive,
  };
}

/** u32 wrap-safe difference between two IMU timestamps in microseconds (protocol 7.3). */
export const imuDeltaUs = (prev, cur) => (cur - prev) >>> 0;

/** Wrap-safe difference between two 0x00 counters (diagnostics only; the counter is never used for dt). */
export const counterDelta = (prev, cur) => (cur - prev) >>> 0;

export function hexToBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  return Uint8Array.from(clean.match(/../g) ?? [], (x) => parseInt(x, 16));
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
}
