// Parser and builder tests (docs/architecture.md 5.12). The vectors of docs/joycon2-test-vectors.json are the only source
// of truth for the byte layout: V1 and V2 are REAL third-party captures, V3 is synthetic. A green test here proves
// conformance to the protocol document, never to a physical Joy-Con (UNVERIFIED-ON-HARDWARE).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInputReport, BUTTON_TABLE, ACCEL_G_PER_LSB, GYRO_DPS_PER_LSB, MIN_LEN, REPORT_LENGTH, OFFSET, imuDeltaUs, counterDelta, hexToBytes, bytesToHex,
} from '../../public/js/input/joycon2-parse.js';
import { buildInputReport, LED, FEATURE_SET, FEATURE_ENABLE, VIBRATE, commandKey } from '../../public/js/input/joycon2-build.js';
import { BUTTON_NAMES } from '../../public/js/shared/contracts.js';
import { createRng } from '../../public/js/shared/rng.js';
import { VECTORS, vector } from '../../test-support/input/vectors.js';

test('constants match the protocol document', () => {
  assert.equal(ACCEL_G_PER_LSB, VECTORS.constants.ACCEL_G_PER_LSB);
  assert.equal(GYRO_DPS_PER_LSB, VECTORS.constants.GYRO_DPS_PER_LSB);
  assert.equal(MIN_LEN, VECTORS.constants.minLength);
  assert.equal(REPORT_LENGTH, 63);
});

for (const v of VECTORS.vectors) {
  test(`protocol vector ${v.id}: every field`, () => {
    const bytes = hexToBytes(v.hex);
    assert.equal(bytes.length, v.lengthBytes);
    const r = parseInputReport(bytes, v.side);
    const e = v.expected;
    assert.equal(r.length, 63);
    assert.equal(r.counter, e.counter);
    assert.equal(r.buttonsRaw, e.buttonsRaw);
    assert.deepEqual(r.pressed, e.pressed);
    assert.deepEqual(r.stickFields, e.stickFields);
    assert.deepEqual(r.stick, e.stick);
    assert.deepEqual(r.mouse, e.mouse);
    assert.deepEqual(r.magRaw, e.magRaw);
    assert.equal(r.batteryMv, e.batteryMv);
    assert.equal(r.chargeState, e.chargeState);
    assert.equal(r.batteryCurrentRaw, e.batteryCurrentRaw);
    assert.equal(r.imuMarker, e.imuMarker);
    assert.equal(r.imuTimestampUs, e.imuTimestampUs);
    assert.equal(r.temperatureRaw, e.temperatureRaw);
    assert.ok(Math.abs(r.temperatureC - e.temperatureC) < 1e-4);
    assert.deepEqual(r.accelRaw, e.accelRaw);
    assert.deepEqual(r.gyroRaw, e.gyroRaw);
    // accelG and gyroDps are exact binary fractions: compare exactly
    assert.deepEqual(r.accelG, e.accelG);
    assert.deepEqual(r.gyroDps, e.gyroDps);
    assert.equal(r.triggerL, e.triggerL);
    assert.equal(r.triggerR, e.triggerR);
    assert.equal(r.imuActive, e.imuActive);
  });
}

test('timestamp delta checks: u32 wrap safe', () => {
  for (const c of VECTORS.timestampDeltaChecks) assert.equal(imuDeltaUs(c.prevUs, c.curUs), c.expectedDeltaUs, c.note);
  assert.equal(counterDelta(4294967290, 5), 11);
});

test('real captures V1 and V2: |accel| is within 1 % of 1 g (supports 4096 LSB per g)', () => {
  for (const id of ['V1', 'V2']) {
    const { bytes, side } = vector(id);
    const a = parseInputReport(bytes, side).accelG;
    const mag = Math.hypot(a.x, a.y, a.z);
    assert.ok(Math.abs(mag - 1) < 0.01, `${id}: |a| = ${mag}`);
  }
  // the two real captures share E0 FF 0F at 0x07-0x09; V1 (mask 0x37) has zero magnetometer bytes, V2 (mask 0xFF) does not
  const v1 = vector('V1').bytes;
  const v2 = vector('V2').bytes;
  for (const b of [v1, v2]) assert.deepEqual([...b.slice(7, 10)], [0xe0, 0xff, 0x0f]);
  assert.deepEqual([...v1.slice(0x19, 0x1f)], [0, 0, 0, 0, 0, 0]);
  assert.ok(v2.slice(0x19, 0x1f).some((x) => x !== 0));
});

test('length handling: shorter than 60 bytes is rejected, 60 and 62 are accepted', () => {
  const full = vector('V1').bytes;
  assert.equal(parseInputReport(full.slice(0, 59)), null);
  assert.equal(parseInputReport(full.slice(0, 20)), null);
  assert.equal(parseInputReport(new Uint8Array(0)), null);
  assert.equal(parseInputReport(null), null);
  assert.equal(parseInputReport('not bytes'), null);
  const r60 = parseInputReport(full.slice(0, 60));
  assert.equal(r60.length, 60);
  assert.deepEqual(r60.accelRaw, { x: -66, y: 437, z: 4078 });
  assert.equal(r60.triggerL, 0, 'the trigger bytes lie beyond a 60 byte report');
  assert.equal(r60.triggerR, 0);
  assert.equal(parseInputReport(full.slice(0, 62)).length, 62);
});

test('accepts Uint8Array views, DataView, ArrayBuffer and plain arrays without copying semantics leaking', () => {
  const { bytes } = vector('V2');
  const ref = parseInputReport(bytes, 'R');
  const padded = new Uint8Array(bytes.length + 10);
  padded.set(bytes, 5);
  assert.deepEqual(parseInputReport(padded.subarray(5, 5 + bytes.length), 'R'), ref, 'a subarray with a byteOffset');
  assert.deepEqual(parseInputReport(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 'R'), ref);
  assert.deepEqual(parseInputReport(bytes.slice().buffer, 'R'), ref);
  assert.deepEqual(parseInputReport(Array.from(bytes), 'R'), ref);
});

test('unknown button bits are masked (byte 7 = 0xE0 in every real capture)', () => {
  const { bytes } = vector('V1');
  assert.deepEqual(parseInputReport(bytes).pressed, []);
  for (const bit of [0x04, 0x08, 0x10, 0x20, 0x40, 0x80]) {
    const copy = bytes.slice();
    copy[7] |= bit;
    assert.deepEqual(parseInputReport(copy).pressed, [], `byte 7 bit 0x${bit.toString(16)} must be ignored`);
  }
  const copy = bytes.slice();
  copy[7] = 0xe3; // GR and GL are documented (Pro Controller grips), the rest is not
  assert.deepEqual(parseInputReport(copy).pressed, ['GR', 'GL']);
});

test('BUTTON_TABLE lists exactly the contract button names in order, one bit each', () => {
  assert.deepEqual(BUTTON_TABLE.map((r) => r[2]), [...BUTTON_NAMES]);
  const seen = new Set();
  for (const [offset, mask, name] of BUTTON_TABLE) {
    assert.ok(offset >= 4 && offset <= 7);
    assert.equal(mask & (mask - 1), 0, `${name}: exactly one bit`);
    const key = `${offset}:${mask}`;
    assert.ok(!seen.has(key), `${name}: duplicate bit`);
    seen.add(key);
  }
});

test('every documented button is detected by its own bit', () => {
  const base = vector('V1').bytes;
  for (const [offset, mask, name] of BUTTON_TABLE) {
    const copy = base.slice();
    copy[offset] |= mask;
    assert.deepEqual(parseInputReport(copy).pressed, [name]);
  }
});

test('the stick reported for a side is its own field; unknown side falls back to the left field', () => {
  const v = vector('V2');
  const r = parseInputReport(v.bytes);
  assert.deepEqual(r.stick, r.stickFields.left);
  assert.deepEqual(parseInputReport(v.bytes, 'R').stick, { x: 2060, y: 1938 });
  assert.deepEqual(parseInputReport(v.bytes, 'L').stick, { x: 2047, y: 2047 });
});

test('imuActive is false only when the twelve motion bytes are all zero', () => {
  const bytes = vector('V1').bytes.slice();
  for (let i = 0x30; i <= 0x3b; i++) bytes[i] = 0;
  assert.equal(parseInputReport(bytes).imuActive, false);
  bytes[0x3b] = 1;
  assert.equal(parseInputReport(bytes).imuActive, true);
});

test('hex helpers round trip', () => {
  const { hex, bytes } = vector('V3');
  assert.equal(bytesToHex(bytes), hex);
  assert.deepEqual(hexToBytes(hex), bytes);
  assert.deepEqual(hexToBytes('0a 0B-ff'), Uint8Array.of(10, 11, 255));
  assert.deepEqual(hexToBytes(''), new Uint8Array(0));
});

// ------------------------------------------------------------------------------------------------ builder

test('builder: re-encoding the parsed fields of each vector reproduces the exact bytes', () => {
  for (const v of VECTORS.vectors) {
    const r = parseInputReport(hexToBytes(v.hex), v.side);
    const rebuilt = buildInputReport({
      counter: r.counter, pressed: r.pressed, leftField: r.stickFields.left, rightField: r.stickFields.right, mouse: r.mouse, magRaw: r.magRaw,
      batteryMv: r.batteryMv, chargeState: r.chargeState, batteryCurrentRaw: r.batteryCurrentRaw, imuTimestampUs: r.imuTimestampUs,
      temperatureRaw: r.temperatureRaw, accelRaw: r.accelRaw, gyroRaw: r.gyroRaw, triggerL: r.triggerL, triggerR: r.triggerR,
    });
    assert.equal(bytesToHex(rebuilt), v.hex, v.id);
  }
});

test('builder round trip: 20 000 seeded random reports are lossless', () => {
  const rng = createRng(20240930);
  const i16 = () => rng.int(-32768, 32767);
  const vec = () => ({ x: i16(), y: i16(), z: i16() });
  for (let n = 0; n < 20000; n++) {
    const pressed = BUTTON_TABLE.filter(() => rng.chance(0.2)).map((r) => r[2]);
    const o = {
      counter: rng.int(0, 0xffffffff), pressed,
      leftField: { x: rng.int(0, 4095), y: rng.int(0, 4095) }, rightField: { x: rng.int(0, 4095), y: rng.int(0, 4095) },
      mouse: { x: rng.int(0, 65535), y: rng.int(0, 65535), quality: rng.int(0, 65535), lift: rng.int(0, 65535) },
      magRaw: vec(), batteryMv: rng.int(0, 65535), chargeState: rng.int(0, 255), batteryCurrentRaw: i16(),
      imuTimestampUs: rng.int(0, 0xffffffff), temperatureRaw: i16(), accelRaw: vec(), gyroRaw: vec(), triggerL: rng.int(0, 255), triggerR: rng.int(0, 255),
    };
    const r = parseInputReport(buildInputReport(o), 'R');
    assert.equal(r.counter, o.counter);
    assert.deepEqual(r.pressed, pressed);
    assert.deepEqual(r.stickFields, { left: o.leftField, right: o.rightField });
    assert.deepEqual(r.mouse, o.mouse);
    assert.deepEqual(r.magRaw, o.magRaw);
    assert.equal(r.batteryMv, o.batteryMv);
    assert.equal(r.chargeState, o.chargeState);
    assert.equal(r.batteryCurrentRaw, o.batteryCurrentRaw);
    assert.equal(r.imuTimestampUs, o.imuTimestampUs);
    assert.equal(r.temperatureRaw, o.temperatureRaw);
    assert.deepEqual(r.accelRaw, o.accelRaw);
    assert.deepEqual(r.gyroRaw, o.gyroRaw);
    assert.equal(r.triggerL, o.triggerL);
    assert.equal(r.triggerR, o.triggerR);
  }
});

test('builder: int16 fields clip like the real field, length option truncates', () => {
  const r = parseInputReport(buildInputReport({ accelRaw: { x: 99999, y: -99999, z: 1 }, gyroRaw: { x: 40000, y: -40000, z: 0 } }));
  assert.deepEqual(r.accelRaw, { x: 32767, y: -32768, z: 1 });
  assert.deepEqual(r.gyroRaw, { x: 32767, y: -32768, z: 0 });
  assert.equal(buildInputReport({ length: 20 }).length, 20);
  assert.equal(buildInputReport().length, 63);
  assert.equal(buildInputReport()[OFFSET.imuMarker], 1);
});

test('command frames are byte-exact against the protocol document (UNVERIFIED-ON-HARDWARE: only the layout is specified)', () => {
  assert.equal(bytesToHex(LED(1)), '09910107000800000100000000000000');
  assert.equal(LED(1).length, 16);
  assert.equal(bytesToHex(FEATURE_SET(0x37)), '0c9101020004000037000000');
  assert.equal(bytesToHex(FEATURE_ENABLE(0x37)), '0c9101040004000037000000');
  assert.equal(bytesToHex(FEATURE_SET(0xff)), '0c91010200040000ff000000', 'the hex printed in the seitanmen README, lower case');
  assert.equal(bytesToHex(FEATURE_ENABLE(0xff)), '0c91010400040000ff000000');
  assert.equal(bytesToHex(VIBRATE(3)), '0a9101020004000003000000');
  for (const f of [FEATURE_SET(0x37), FEATURE_ENABLE(0x37), VIBRATE(6)]) assert.equal(f.length, 12);
  assert.equal(commandKey(FEATURE_SET(0x37)), '12:2');
  assert.equal(commandKey(FEATURE_ENABLE(0x37)), '12:4');
  assert.equal(commandKey(LED(1)), '9:7');
});
