// Fake Web Bluetooth stack with a fake Joy-Con 2. Test helper of the input engineer.
//
// HONESTY: this fake models docs/joycon2-protocol.md, NOT the physical controller. It knows the GATT table, the command
// frames, the feature-mask handshake and the 63-byte report layout as the document describes them, plus the failure
// modes the document warns about (chooser cancelled, connect timeouts, missing service, controller that stays silent,
// links that drop, the macOS "no host write for N seconds" drop, overlapping GATT operations). A green test against
// this fake proves conformance to the document, never to a real Joy-Con (UNVERIFIED-ON-HARDWARE).

import { INPUT_CONFIG } from '../../public/js/input/input-config.js';
import { buildInputReport } from '../../public/js/input/joycon2-build.js';
import { bytesToHex } from '../../public/js/input/joycon2-parse.js';

const CH = INPUT_CONFIG.characteristics;
const DECOYS = [
  '4147423d-fdae-4df7-a4f7-d23e5df59f8d', // firmware update channel: NEVER write
  'ab7de9be-89fe-49ad-828f-118f09df7fdf', // look-alike of the command characteristic: NEVER write
  'ab7de9be-89fe-49ad-828f-118f09df7fde',
  'cc1bbbb5-7354-4d32-a716-a81cb241a32a',
];

const domError = (name, message) => {
  const e = new Error(message);
  e.name = name;
  return e;
};

/**
 * @param {object} o
 * @param {{now:()=>number}} o.clock
 * @param {import('../../public/js/input/timers.js').Timers} o.timers   fake timers of test-support/input/fake-timers.js
 * @param {object} [o.behaviour]
 */
export function createFakeBluetooth({ clock, timers, behaviour = {} }) {
  const b = {
    side: 'R', // 'L' | 'R' | 'none' | 'both': which side-specific characteristic exists
    name: 'Joy-Con 2 (R)',
    // 'select' | 'cancel' | 'permission' | 'adapter' | 'error' | 'empty-unless-all'. 'empty-unless-all' models the SYMPTOM of the first real test
    // (Chrome's chooser listed nothing for the game's filters): a request WITH `filters` finds no device and the closed chooser rejects with
    // NotFoundError; a request with `acceptAllDevices` lists the controller and selects it. It does not model how Chrome matches filters.
    chooser: 'select',
    chooserDelayMs: 0,
    connect: 'ok', // 'ok' | 'fail' | 'hang'
    connectDelayMs: 50,
    service: 'ok', // 'ok' | 'missing' | 'security' | 'hang'
    discoveryDelayMs: 100,
    omitCharacteristics: [], // uuids that do not exist
    reports: 'stream', // 'stream' | 'none' | 'inactive' | 'truncated'
    requireMask: null, // number: the IMU only streams once ENABLE was written with EXACTLY this mask
    rateHz: 66,
    respond: true,
    respondDelayMs: 20,
    opLatencyMs: 5, // duration of one GATT operation (used to detect overlapping operations)
    dropWithoutWriteMs: null, // models the single-source macOS claim: the link dies this long after the last host write
    reuseBuffer: true, // Chrome may reuse the DataView buffer between notifications
    startTimestampUs: 5_000_000,
    startCounter: 26_000,
    batteryMv: 3700,
    notifyFails: false, // startNotifications on the input characteristic rejects
    serviceNotFoundFirst: 0, // the first N getPrimaryService calls answer NotFoundError (a discovery race right after connect)
    streamStartDelayMs: 0, // the first report comes this long after the stream was allowed (a slow controller: late first report)
    respSubscribeMs: 0, // extra duration of startNotifications on the command-response characteristic (a slow one overlaps the next op)
    writeFails: false,
    ...behaviour,
  };

  const delay = (ms) => (ms > 0 ? new Promise((resolve) => timers.setTimeout(resolve, ms)) : Promise.resolve());

  const log = {
    requests: [], // options passed to requestDevice
    writes: [], // every characteristic write {t, uuid, bytes, hex}
    notifications: [], // {t, uuid} startNotifications calls
    overlaps: [], // GATT operations that overlapped another one
    inProgressErrors: 0,
    connectCalls: 0,
    serviceCalls: 0,
    disconnectCalls: 0,
    reports: 0,
  };

  const state = {
    connected: false,
    featureSet: null,
    featureEnabled: null,
    led: null,
    lastWriteAt: null,
    streamTimer: null,
    streamStarting: null,
    dropTimer: null,
    k: 0,
    pressed: [],
    motion: null, // (k) => {accelRaw, gyroRaw}
    optionalServices: [],
    silenced: false,
    activeOps: 0,
  };

  class FakeCharacteristic extends EventTarget {
    constructor(uuid, properties) {
      super();
      this.uuid = uuid;
      this.properties = properties;
      this.value = null;
      this.notifying = false;
      this.busy = false;
    }

    async op(name, work) {
      if (this.busy) {
        log.inProgressErrors++;
        throw domError('NetworkError', 'GATT operation already in progress.');
      }
      if (state.activeOps > 0) log.overlaps.push(`${name} on ${this.uuid}`);
      this.busy = true;
      state.activeOps++;
      try {
        await delay(b.opLatencyMs);
        if (!state.connected) throw domError('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.');
        return await work();
      } finally {
        state.activeOps--;
        this.busy = false;
      }
    }

    async startNotifications() {
      return this.op('startNotifications', async () => {
        if (this.uuid === CH.input && b.notifyFails) throw domError('NetworkError', 'GATT Error: Not supported.');
        if (this.uuid === CH.response && b.respSubscribeMs > 0) await delay(b.respSubscribeMs);
        this.notifying = true;
        log.notifications.push({ t: clock.now(), uuid: this.uuid });
        refreshStreaming();
        return this;
      });
    }

    async stopNotifications() {
      this.notifying = false;
      refreshStreaming();
      return this;
    }

    async writeValueWithoutResponse(data) {
      return this.op('write', async () => {
        if (b.writeFails) throw domError('NetworkError', 'GATT operation failed for unknown reason.');
        onWrite(this, data);
      });
    }

    async writeValue(data) {
      return this.writeValueWithoutResponse(data);
    }
  }

  const chars = new Map();
  const addChar = (uuid, properties) => {
    if (!b.omitCharacteristics.includes(uuid)) chars.set(uuid, new FakeCharacteristic(uuid, properties));
  };
  addChar(CH.input, { read: true, notify: true });
  addChar(CH.command, { writeWithoutResponse: true });
  addChar(CH.response, { notify: true });
  if (b.side === 'L' || b.side === 'both') addChar(CH.vibrationLeft, { writeWithoutResponse: true });
  if (b.side === 'R' || b.side === 'both') addChar(CH.vibrationRight, { writeWithoutResponse: true });
  for (const uuid of DECOYS) addChar(uuid, { writeWithoutResponse: true });

  const inputChar = () => chars.get(CH.input);
  const respChar = () => chars.get(CH.response);

  function onWrite(char, data) {
    const bytes = new Uint8Array(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data);
    state.lastWriteAt = clock.now();
    log.writes.push({ t: clock.now(), uuid: char.uuid, bytes, hex: bytesToHex(bytes) });
    if (char.uuid !== CH.command) return; // decoys swallow the write; the tests fail on any entry in log.writes for them
    const [cmd, , , sub] = bytes;
    const mask = bytes[8];
    if (cmd === 0x0c && sub === 0x02) state.featureSet = mask;
    else if (cmd === 0x0c && sub === 0x04) state.featureEnabled = mask;
    else if (cmd === 0x09 && sub === 0x07) state.led = mask;
    refreshStreaming();
    const rc = respChar();
    if (b.respond && rc && rc.notifying) {
      timers.setTimeout(() => {
        const resp = Uint8Array.from([cmd, 0x01, 0x01, sub, 0x10, 0x78, 0, 0, 0, 0, 0, 0]);
        rc.value = new DataView(resp.buffer);
        rc.dispatchEvent(new Event('characteristicvaluechanged'));
      }, b.respondDelayMs);
    }
  }

  // --- the fake controller: streams reports while the handshake of the protocol document is complete
  const streamAllowed = () => {
    if (b.reports === 'none' || state.silenced || !state.connected) return false;
    const ic = inputChar();
    if (!ic || !ic.notifying) return false;
    if (state.featureEnabled === null) return false;
    if (b.requireMask !== null) return state.featureEnabled === b.requireMask;
    return (state.featureEnabled & 0x04) !== 0; // the IMU bit
  };

  const buffer = new Uint8Array(63);
  const view = new DataView(buffer.buffer);
  function emitReport() {
    const period = 1000 / b.rateHz;
    const k = state.k++;
    const motion = state.motion ? state.motion(k) : {};
    const bytes = buildInputReport({
      counter: (b.startCounter + Math.round(k * period)) >>> 0,
      imuTimestampUs: (b.startTimestampUs + Math.round(k * period * 1000)) >>> 0,
      pressed: state.pressed,
      batteryMv: b.batteryMv,
      temperatureRaw: 5,
      accelRaw: motion.accelRaw ?? { x: 0, y: 0, z: 4096 },
      gyroRaw: b.reports === 'inactive' ? { x: 0, y: 0, z: 0 } : motion.gyroRaw ?? { x: 0, y: 0, z: 0 },
      ...(b.reports === 'inactive' ? { accelRaw: { x: 0, y: 0, z: 0 } } : {}),
      length: b.reports === 'truncated' ? 20 : 63,
    });
    const ic = inputChar();
    if (b.reuseBuffer && bytes.length === 63) {
      buffer.set(bytes);
      ic.value = view;
    } else {
      ic.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    log.reports++;
    ic.dispatchEvent(new Event('characteristicvaluechanged'));
  }

  function refreshStreaming() {
    const should = streamAllowed();
    if (should && state.streamTimer === null && state.streamStarting === null) {
      if (b.streamStartDelayMs > 0) {
        state.streamStarting = timers.setTimeout(() => {
          state.streamStarting = null;
          if (streamAllowed() && state.streamTimer === null) state.streamTimer = timers.setInterval(emitReport, 1000 / b.rateHz);
        }, b.streamStartDelayMs);
      } else {
        state.streamTimer = timers.setInterval(emitReport, 1000 / b.rateHz);
      }
    } else if (!should) {
      if (state.streamTimer !== null) {
        timers.clearInterval(state.streamTimer);
        state.streamTimer = null;
      }
      if (state.streamStarting !== null) {
        timers.clearTimeout(state.streamStarting);
        state.streamStarting = null;
      }
    }
  }

  function stopAll() {
    if (state.streamTimer !== null) timers.clearInterval(state.streamTimer);
    if (state.streamStarting !== null) timers.clearTimeout(state.streamStarting);
    if (state.dropTimer !== null) timers.clearInterval(state.dropTimer);
    state.streamTimer = null;
    state.streamStarting = null;
    state.dropTimer = null;
  }

  // --- GATT objects
  class FakeGatt {
    get connected() {
      return state.connected;
    }

    async connect() {
      log.connectCalls++;
      if (b.connect === 'hang') return new Promise(() => {});
      await delay(b.connectDelayMs);
      if (b.connect === 'fail') throw domError('NetworkError', 'Connection attempt failed.');
      // a new session: the controller forgot the previous handshake and subscriptions
      state.connected = true;
      state.featureSet = null;
      state.featureEnabled = null;
      for (const c of chars.values()) c.notifying = false;
      state.lastWriteAt = clock.now();
      if (b.dropWithoutWriteMs !== null && state.dropTimer === null) {
        state.dropTimer = timers.setInterval(() => {
          if (state.connected && clock.now() - state.lastWriteAt > b.dropWithoutWriteMs) control.dropLink();
        }, 500);
      }
      return this;
    }

    disconnect() {
      log.disconnectCalls++;
      if (!state.connected) return;
      state.connected = false;
      stopAll();
      device.dispatchEvent(new Event('gattserverdisconnected'));
    }

    async getPrimaryService(uuid) {
      if (!state.connected) throw domError('NetworkError', 'GATT Server is disconnected. Cannot retrieve services.');
      if (b.service === 'hang') return new Promise(() => {});
      await delay(b.discoveryDelayMs);
      if (uuid !== INPUT_CONFIG.service || !state.optionalServices.includes(uuid)) throw domError('SecurityError', `Origin is not allowed to access the service ${uuid}.`);
      if (b.service === 'security') throw domError('SecurityError', 'Access to the service is blocked.');
      if (b.service === 'missing') throw domError('NotFoundError', 'No Services matching UUID found in Device.');
      if (++log.serviceCalls <= b.serviceNotFoundFirst) throw domError('NotFoundError', 'No Services matching UUID found in Device.');
      return {
        uuid,
        async getCharacteristics() {
          await delay(b.opLatencyMs);
          return [...chars.values()];
        },
        async getCharacteristic(u) {
          const c = chars.get(u);
          if (!c) throw domError('NotFoundError', 'No Characteristics matching UUID found in Service.');
          return c;
        },
      };
    }
  }

  const device = new (class FakeDevice extends EventTarget {
    constructor() {
      super();
      this.id = 'fake-joycon-2';
      this.name = b.name;
      this.gatt = new FakeGatt();
    }
  })();

  const bluetooth = {
    async requestDevice(options) {
      log.requests.push(options);
      state.optionalServices = options?.optionalServices ?? [];
      await delay(b.chooserDelayMs);
      if (b.chooser === 'cancel') throw domError('NotFoundError', 'User cancelled the requestDevice() chooser.');
      if (b.chooser === 'empty-unless-all' && !options?.acceptAllDevices) throw domError('NotFoundError', 'User cancelled the requestDevice() chooser.');
      if (b.chooser === 'permission') throw domError('SecurityError', 'Bluetooth permission has been blocked.');
      if (b.chooser === 'adapter') throw domError('NotFoundError', 'Bluetooth adapter not available.');
      if (b.chooser === 'error') throw domError('TypeError', 'Failed to execute requestDevice on Bluetooth: invalid filters.');
      return device;
    },
  };

  const control = {
    device,
    log,
    chars,
    behaviour: b,
    /** The link dies (controller powered off, out of range): the browser fires gattserverdisconnected. */
    dropLink() {
      if (!state.connected) return;
      state.connected = false;
      stopAll();
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
    setButtons(names) {
      state.pressed = names;
    },
    setMotion(fn) {
      state.motion = fn;
    },
    /** Stop / resume reports without touching the link (a controller that goes silent). */
    silence(on = true) {
      state.silenced = on;
      refreshStreaming();
    },
    get state() {
      return { ...state };
    },
    /** True when nothing but the command characteristic was ever written. */
    onlyCommandWrites: () => log.writes.every((w) => w.uuid === CH.command),
    commandFrames: () => log.writes.filter((w) => w.uuid === CH.command).map((w) => w.hex),
    stop: stopAll,
  };

  return { bluetooth, ...control };
}
