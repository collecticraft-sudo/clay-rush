// Joy-Con 2 packet and command builders. OWNER: input engineer.
//
// buildInputReport is the exact inverse of parseInputReport (docs/joycon2-protocol.md Appendix A). It is used by the
// SIMULATOR, so that synthetic motion travels through the real parser, and by the tests. The command frame builders
// produce the bytes the BLE provider writes to the command characteristic (protocol 5.2, NORMATIVE bytes).
// Nothing here talks to a device; the frames are UNVERIFIED-ON-HARDWARE (only their byte layout is specified by
// third-party documents).

import { BUTTON_TABLE, OFFSET, REPORT_LENGTH } from './joycon2-parse.js';

const clampInt16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/**
 * Build a 63-byte input report.
 * @param {object} [o]
 * @property {number} [o.counter]              u32 at 0x00 (a millisecond clock in the real captures)
 * @property {string[]} [o.pressed]            button names as in BUTTON_TABLE
 * @property {{x:number,y:number}} [o.leftField] 12-bit stick fields
 * @property {{x:number,y:number}} [o.rightField]
 * @property {{x:number,y:number,quality:number,lift:number}} [o.mouse]
 * @property {{x:number,y:number,z:number}} [o.magRaw]
 * @property {number} [o.batteryMv]
 * @property {number} [o.chargeState]
 * @property {number} [o.batteryCurrentRaw]
 * @property {number} [o.imuTimestampUs]       u32, microseconds
 * @property {number} [o.temperatureRaw]
 * @property {{x:number,y:number,z:number}} [o.accelRaw]  int16 (values outside the range are clipped like the real field)
 * @property {{x:number,y:number,z:number}} [o.gyroRaw]
 * @property {number} [o.triggerL]
 * @property {number} [o.triggerR]
 * @property {number} [o.length]               total length, default 63; shorter values produce a truncated notification
 * @returns {Uint8Array}
 */
export function buildInputReport(o = {}) {
  const b = new Uint8Array(REPORT_LENGTH);
  const dv = new DataView(b.buffer);
  dv.setUint32(OFFSET.counter, (o.counter ?? 0) >>> 0, true);
  for (const name of o.pressed ?? []) {
    const row = BUTTON_TABLE.find((r) => r[2] === name);
    if (row) b[row[0]] |= row[1];
  }
  b[7] |= 0xe0; // constant bits seen in every real capture (undefined meaning, masked by the parser table)
  b[8] = 0xff;
  b[9] = 0x0f;
  const stick = (off, s) => {
    const v = (s.x & 0xfff) | ((s.y & 0xfff) << 12);
    b[off] = v & 255;
    b[off + 1] = (v >> 8) & 255;
    b[off + 2] = (v >> 16) & 255;
  };
  stick(OFFSET.leftStick, o.leftField ?? { x: 2047, y: 2047 });
  stick(OFFSET.rightStick, o.rightField ?? { x: 2047, y: 2047 });
  const m = o.mouse ?? { x: 0, y: 0, quality: 0, lift: 0 };
  dv.setUint16(OFFSET.mouse, m.x & 0xffff, true);
  dv.setUint16(OFFSET.mouse + 2, m.y & 0xffff, true);
  dv.setUint16(OFFSET.mouse + 4, m.quality & 0xffff, true);
  dv.setUint16(OFFSET.mouse + 6, m.lift & 0xffff, true);
  const mag = o.magRaw ?? { x: 0, y: 0, z: 0 };
  dv.setInt16(OFFSET.mag, clampInt16(mag.x), true);
  dv.setInt16(OFFSET.mag + 2, clampInt16(mag.y), true);
  dv.setInt16(OFFSET.mag + 4, clampInt16(mag.z), true);
  dv.setUint16(OFFSET.battery, (o.batteryMv ?? 3700) & 0xffff, true);
  dv.setUint8(OFFSET.chargeState, (o.chargeState ?? 0) & 0xff);
  dv.setInt16(OFFSET.batteryCurrent, clampInt16(o.batteryCurrentRaw ?? 0), true);
  b[OFFSET.imuMarker] = 0x01;
  dv.setUint32(OFFSET.imuTimestamp, (o.imuTimestampUs ?? 0) >>> 0, true);
  dv.setInt16(OFFSET.temperature, clampInt16(o.temperatureRaw ?? 0), true);
  const a = o.accelRaw ?? { x: 0, y: 0, z: 4096 };
  const g = o.gyroRaw ?? { x: 0, y: 0, z: 0 };
  dv.setInt16(OFFSET.accel, clampInt16(a.x), true);
  dv.setInt16(OFFSET.accel + 2, clampInt16(a.y), true);
  dv.setInt16(OFFSET.accel + 4, clampInt16(a.z), true);
  dv.setInt16(OFFSET.gyro, clampInt16(g.x), true);
  dv.setInt16(OFFSET.gyro + 2, clampInt16(g.y), true);
  dv.setInt16(OFFSET.gyro + 4, clampInt16(g.z), true);
  b[OFFSET.triggerL] = (o.triggerL ?? 0) & 0xff;
  b[OFFSET.triggerR] = (o.triggerR ?? 0) & 0xff;
  return o.length !== undefined && o.length !== REPORT_LENGTH ? b.slice(0, o.length) : b;
}

// --------------------------------------------------------------------------------------------------------------------
// Command frames (protocol 5.2): 8-byte header (cmd, 0x91, 0x01, sub, 0x00, data length, 0x00, 0x00) plus data.

const frame = (cmd, sub, payload) => Uint8Array.from([cmd, 0x91, 0x01, sub, 0x00, payload.length, 0x00, 0x00, ...payload]);

/** Player LED pattern (player 1 = 0x01), 16 bytes. Also the keep-alive frame (protocol 5.5). */
export const LED = (mask = 0x01) => frame(0x09, 0x07, [mask & 0xff, 0, 0, 0, 0, 0, 0, 0]);
/** Feature SET(mask), 12 bytes. Must precede ENABLE. */
export const FEATURE_SET = (mask) => frame(0x0c, 0x02, [mask & 0xff, 0, 0, 0]);
/** Feature ENABLE(mask), 12 bytes. */
export const FEATURE_ENABLE = (mask) => frame(0x0c, 0x04, [mask & 0xff, 0, 0, 0]);
/** Vibration preset (1 low buzz, 3 soft click, 5 stronger click, 6 short high beep), 12 bytes. UNVERIFIED-ON-HARDWARE (UOH-13). */
export const VIBRATE = (presetId) => frame(0x0a, 0x02, [presetId & 0xff, 0, 0, 0]);

/** Key that matches a command with its response notification: command id (byte 0) and subcommand (byte 3). */
export const commandKey = (bytes) => `${bytes[0]}:${bytes[3]}`;
