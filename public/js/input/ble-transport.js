// Web Bluetooth transport for the Joy-Con 2. OWNER: input engineer.
//
// requestJoyCon: the chooser (must be called synchronously inside a user gesture). openLink: connect, discover, detect the
// side, run the documented init commands, subscribe to the input characteristic and keep the link alive. No game
// knowledge, no state machine (that is ble-provider.js).
//
// Everything here follows docs/joycon2-protocol.md sections 3 to 5 and has NEVER talked to a real controller:
// UNVERIFIED-ON-HARDWARE (UOH-1 to UOH-5, UOH-15). The one thing a real scan has confirmed (docs/hardware-findings.md, 2026-09-30) is
// the advertisement layout: company id 0x0553 and the product id at data idx 5-6. What Chrome's chooser lists for each filter is not.
// Chooser filters (see buildRequestOptions): 'lenient' is the DEFAULT (product id only), 'strict' additionally requires the zero
// host address of a pairing-mode advert, 'all' is acceptAllDevices. On the first real test Chrome's chooser listed nothing with
// 'strict' (cause UNVERIFIED-ON-HARDWARE: one native scan saw a bonded-console advert before SYNC, which 'strict' cannot match;
// another saw the zero-address advert at once; Chrome's Bluetooth permission and chooser timing are other candidates). Hard rules:
//   * Only the command characteristic is ever written (protocol section 1, decision 13). The firmware-update channel
//     and the look-alike `...7fdf` are never touched.
//   * One GATT operation at a time (Chrome rejects overlapping operations on a characteristic), writes at least 100 ms
//     apart, `writeValueWithoutResponse` when the browser has it.
//   * Never loop gatt.connect(): one attempt per call. The retry policy lives in the provider.
//   * The keep-alive re-sends the LED frame every second when no write happened for 900 ms (macOS reportedly drops the
//     link 10-17 s after the host's last write; a single source, UOH-5).

import { INPUT_ERROR } from '../shared/contracts.js';
import { INPUT_CONFIG } from './input-config.js';
import { LED, FEATURE_SET, FEATURE_ENABLE, VIBRATE, commandKey } from './joycon2-build.js';
import { bytesToHex } from './joycon2-parse.js';
import { sleep, withTimeout } from './timers.js';

/** Error with a machine-readable InputErrorInfo code. */
export class LinkError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'LinkError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// --------------------------------------------------------------------------------------------------------------------
// Chooser

function manufacturerFilter(companyId, pid, pairingOnly) {
  // Bytes AFTER the 2-byte company id: idx 5-6 = product id (little endian), idx 10-15 = host address: all zero in the advert seen
  // after SYNC, the bonded console's address in the one seen before it (real scan, docs/hardware-findings.md). Only `pairingOnly`
  // (the 'strict' filter) looks at idx 10-15. dataPrefix and mask MUST have the same length.
  const dataPrefix = new Uint8Array(16);
  const mask = new Uint8Array(16);
  dataPrefix[5] = pid & 0xff;
  dataPrefix[6] = pid >> 8;
  mask[5] = 0xff;
  mask[6] = 0xff;
  if (pairingOnly) for (let i = 10; i < 16; i++) mask[i] = 0xff;
  return { manufacturerData: [{ companyIdentifier: companyId, dataPrefix, mask }] };
}

/** The chooser filters buildRequestOptions understands. The first one is the default (INPUT_CONFIG.defaultFilter). */
export const REQUEST_FILTERS = Object.freeze(['lenient', 'strict', 'all']);

/**
 * Options for navigator.bluetooth.requestDevice (protocol 3.3).
 *   lenient  (default) product id only, for the wanted side (or both), plus a second entry for company id 0x057E. The host address
 *            bytes are ignored, so both adverts the real controller sends (bonded-console address, zero address) match
 *   strict   pairing-mode adverts of the wanted side only (zero host address): the most selective; it listed nothing in Chrome on
 *            the first real-hardware test (cause UNVERIFIED-ON-HARDWARE)
 *   all      acceptAllDevices (what the connect screen's "Extended search" button uses)
 * An unknown filter name falls back to the default. Never filters by name or service UUID: the advert carries neither (protocol 3.1).
 * @param {{side?:'L'|'R'|'any', filter?:'lenient'|'strict'|'all'}} [o]
 */
export function buildRequestOptions(o = {}, cfg = INPUT_CONFIG) {
  const fallback = cfg.defaultFilter ?? 'lenient';
  const filter = REQUEST_FILTERS.includes(o.filter) ? o.filter : fallback;
  const optionalServices = [cfg.service];
  if (filter === 'all') return { acceptAllDevices: true, optionalServices };
  const side = o.side ?? 'any';
  const pids = side === 'L' ? [cfg.pid.L] : side === 'R' ? [cfg.pid.R] : [cfg.pid.L, cfg.pid.R];
  const pairingOnly = filter === 'strict';
  const filters = pids.map((pid) => manufacturerFilter(cfg.companyId, pid, pairingOnly));
  if (filter === 'lenient') for (const pid of pids) filters.push(manufacturerFilter(cfg.altCompanyId, pid, false));
  return { filters, optionalServices };
}

/**
 * Must be called synchronously from a click handler (Web Bluetooth needs the user gesture): it calls requestDevice
 * before returning. Returns the raw promise.
 */
export function requestJoyCon(bluetooth, o = {}, cfg = INPUT_CONFIG) {
  return bluetooth.requestDevice(buildRequestOptions(o, cfg));
}

/** Map a requestDevice() rejection to an InputErrorInfo code (guidance of architecture 5.4). */
export function classifyRequestError(err) {
  const name = err?.name ?? '';
  const message = String(err?.message ?? err ?? 'requestDevice failed');
  if (name === 'NotFoundError' && /adapter/i.test(message)) return { code: INPUT_ERROR.GATT_FAILURE, message: `Bluetooth adapter not available: ${message}` };
  if (name === 'NotFoundError' || name === 'AbortError') return { code: INPUT_ERROR.CANCELLED, message: `chooser closed without a choice: ${message}` };
  if (name === 'SecurityError') return { code: INPUT_ERROR.PERMISSION_DENIED, message: `Bluetooth permission refused: ${message}` };
  return { code: INPUT_ERROR.GATT_FAILURE, message: `requestDevice failed (${name || 'Error'}): ${message}` };
}

/** Map a GATT-phase rejection to a LinkError. `stage` is 'connect' | 'discovery' | 'notify' | 'write'. */
export function classifyGattError(err, stage) {
  if (err instanceof LinkError) return err;
  const name = err?.name ?? '';
  const message = String(err?.message ?? err ?? 'GATT operation failed');
  if (stage === 'discovery' && (name === 'NotFoundError' || name === 'SecurityError' || name === 'NotSupportedError')) {
    return new LinkError(INPUT_ERROR.NOT_JOYCON, `the device has no Joy-Con 2 service (${name}: ${message})`, err);
  }
  return new LinkError(INPUT_ERROR.GATT_FAILURE, `${stage} failed (${name || 'Error'}): ${message}`, err);
}

/** Left/Right from what the device and the GATT table tell us. Characteristic presence beats the name, the name beats the hint. */
export function detectSide(uuids, deviceName, hint, cfg = INPUT_CONFIG) {
  const c = cfg.characteristics;
  const hasL = uuids.has(c.vibrationLeft);
  const hasR = uuids.has(c.vibrationRight);
  if (hasL && !hasR) return { side: 'L', source: 'characteristic' };
  if (hasR && !hasL) return { side: 'R', source: 'characteristic' };
  const name = String(deviceName ?? '');
  if (name.includes(cfg.nameMarker.L) && !name.includes(cfg.nameMarker.R)) return { side: 'L', source: 'name' };
  if (name.includes(cfg.nameMarker.R) && !name.includes(cfg.nameMarker.L)) return { side: 'R', source: 'name' };
  if (hint === 'L' || hint === 'R') return { side: hint, source: 'hint' };
  return { side: '?', source: 'none' };
}

// --------------------------------------------------------------------------------------------------------------------
// The link

/**
 * @typedef {Object} LinkOptions
 * @property {{now:()=>number}} clock
 * @property {import('./timers.js').Timers} timers
 * @property {(bytes:Uint8Array, arrivedAt:number)=>void} onReport   a private copy of each notification, clock read first thing
 * @property {(stage:string, info?:object)=>void} [onStage]          'connected' | 'discovered' | 'commands' | 'subscribed'
 * @property {(event:object)=>void} [onEvent]                        {type:'disconnected'|'warn'|'write', ...}
 * @property {()=>boolean} [isCancelled]                             polled between steps; true aborts with code `cancelled`
 * @property {(handle:{close:()=>void})=>void} [onHandle]            called first thing with the function that tears the attempt down
 * @property {number} [mask]                                         feature mask, default INPUT_CONFIG.featureMask
 * @property {boolean} [keepAlive]                                   default true
 * @property {'L'|'R'|'any'} [sideHint]
 * @property {object} [config]
 */

/**
 * Connect to an already chosen device and start the input stream. Resolves when the input characteristic is
 * subscribed and the keep-alive runs (the provider then waits for the first report). Rejects with a LinkError.
 * @param {*} device  BluetoothDevice
 * @param {LinkOptions} o
 */
export async function openLink(device, o) {
  const cfg = o.config ?? INPUT_CONFIG;
  const { clock, timers } = o;
  const mask = o.mask ?? cfg.featureMask;
  const ch = cfg.characteristics;
  const emit = (event) => o.onEvent?.(event);
  const stage = (name, info) => o.onStage?.(name, info);

  let alive = true;
  let connectPending = false; // gatt.connect() was called and has not settled: disconnect() must still abort it
  let keepAliveOn = o.keepAlive !== false;
  let keepTimer = null;
  let lastWriteAt = -Infinity;
  let lastHapticAt = -Infinity;
  let writeCount = 0;
  let keepAliveFailures = 0;
  const listeners = []; // [target, type, fn] for removal
  const pending = new Map(); // command key -> resolve

  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  };

  function stopKeepAlive() {
    if (keepTimer !== null) timers.clearInterval(keepTimer);
    keepTimer = null;
  }

  let closed = false;
  function close() {
    // Idempotent: only the FIRST close touches the GATT server. A late second call (the abandoned openLink() reaching its
    // own error path) must not disconnect a newer attempt that already uses the same BluetoothDevice.
    if (closed) return;
    closed = true;
    alive = false;
    stopKeepAlive();
    for (const [target, type, fn] of listeners.splice(0)) {
      try {
        target.removeEventListener(type, fn);
      } catch {
        /* ignore */
      }
    }
    for (const resolve of pending.values()) resolve();
    pending.clear();
    try {
      // also aborts a gatt.connect() that is still pending, so it cannot complete later behind our back
      if (device.gatt && (device.gatt.connected || connectPending)) device.gatt.disconnect();
    } catch {
      /* ignore: the link is going away anyway */
    }
    connectPending = false;
  }

  const abortIfNeeded = () => {
    if (!alive || o.isCancelled?.()) throw new LinkError(INPUT_ERROR.CANCELLED, 'connection attempt cancelled');
  };

  // ONE GATT operation at a time (protocol 5.5 / 8): every operation goes through this promise chain.
  // The chain waits for the REAL operation, not for the caller's timed view of it (round 2 finding m4): when the response
  // subscription takes 3.6 s and the caller gave up at 3 s, the next write used to start while that operation was still
  // pending, and Chrome answers an overlapping GATT operation with "already in progress". The wait for a hung operation is
  // capped (cfg.serialHangCapMs) so that a dead link can never block every later write for ever.
  let chain = Promise.resolve();
  const serial = (op, timeout) => {
    const raw = chain.then(op);
    chain = new Promise((resolve) => {
      const id = timers.setTimeout(resolve, cfg.serialHangCapMs);
      const done = () => {
        timers.clearTimeout(id);
        resolve();
      };
      raw.then(done, done);
    });
    return timeout ? withTimeout(timers, raw, timeout.ms, timeout.makeError) : raw;
  };

  try {
    o.onHandle?.({ close }); // lets the provider tear a half-open attempt down at once (disconnect() during connecting)
    listen(device, 'gattserverdisconnected', () => {
      if (!alive) return;
      alive = false;
      stopKeepAlive();
      emit({ type: 'disconnected' });
    });

    // 1. connect
    if (!device.gatt) throw new LinkError(INPUT_ERROR.NOT_JOYCON, 'the chosen device has no GATT server');
    connectPending = true;
    const server = await withTimeout(timers, Promise.resolve().then(() => device.gatt.connect()), cfg.connectTimeoutMs, () => new LinkError(INPUT_ERROR.GATT_FAILURE, `timeout: gatt.connect() did not finish in ${cfg.connectTimeoutMs} ms`)).then(
      (value) => {
        connectPending = false;
        return value;
      },
      (e) => {
        throw classifyGattError(e, 'connect');
      },
    );
    abortIfNeeded();
    stage('connected');

    // 2. settle, then discover the vendor service and its characteristics (one overall deadline)
    await sleep(timers, cfg.settleMs);
    abortIfNeeded();
    const chars = new Map();
    await withTimeout(
      timers,
      (async () => {
        let service;
        try {
          service = await server.getPrimaryService(cfg.service);
        } catch (e) {
          if (!e || e.name !== 'NotFoundError') throw classifyGattError(e, 'discovery');
          // n9: a NotFoundError is classified as "not a Joy-Con", which starts the cooldown and locks a healthy controller out. Right
          // after gatt.connect() the attribute table may still be empty for a moment (UNVERIFIED-ON-HARDWARE: whether Chrome on macOS
          // does that), so ask once more after the settle time before giving the verdict.
          await sleep(timers, cfg.settleMs);
          if (!alive) throw new LinkError(INPUT_ERROR.CANCELLED, 'connection attempt cancelled');
          try {
            service = await server.getPrimaryService(cfg.service);
          } catch (e2) {
            throw classifyGattError(e2, 'discovery');
          }
        }
        try {
          for (const c of await service.getCharacteristics()) chars.set(String(c.uuid).toLowerCase(), c);
        } catch (e) {
          throw classifyGattError(e, 'discovery');
        }
      })(),
      cfg.discoveryTimeoutMs,
      () => new LinkError(INPUT_ERROR.GATT_FAILURE, `timeout: service discovery did not finish in ${cfg.discoveryTimeoutMs} ms`),
    );
    abortIfNeeded();

    // 3. required characteristics and side
    const cmdChar = chars.get(ch.command);
    const inputChar = chars.get(ch.input);
    if (!cmdChar || !inputChar) {
      throw new LinkError(INPUT_ERROR.NOT_JOYCON, `required characteristics missing (${[!cmdChar && 'command', !inputChar && 'input'].filter(Boolean).join(', ')})`);
    }
    if (cfg.forbiddenCharacteristics.includes(String(cmdChar.uuid).toLowerCase())) throw new LinkError(INPUT_ERROR.NOT_JOYCON, 'refusing to write to a forbidden characteristic');
    const detected = detectSide(new Set(chars.keys()), device.name, o.sideHint, cfg);
    if (o.sideHint === 'L' || o.sideHint === 'R') {
      if (detected.source === 'characteristic' && detected.side !== o.sideHint) emit({ type: 'warn', message: `chooser filter said ${o.sideHint} but the GATT table says ${detected.side}: trusting the GATT table` });
    }
    stage('discovered', { side: detected.side, sideSource: detected.source, characteristics: chars.size });

    // write path: whitelisted to the command characteristic, serialised, spaced
    const write = (bytes, kind = 'command') =>
      serial(async () => {
        if (!alive) return false;
        const wait = cfg.writeSpacingMs - (clock.now() - lastWriteAt);
        if (wait > 0) await sleep(timers, wait);
        if (!alive) return false;
        lastWriteAt = clock.now();
        writeCount++;
        emit({ type: 'write', kind, hex: bytesToHex(bytes), at: lastWriteAt });
        await (typeof cmdChar.writeValueWithoutResponse === 'function' ? cmdChar.writeValueWithoutResponse(bytes) : cmdChar.writeValue(bytes));
        return true;
      });

    const waitFor = (promise, ms) =>
      new Promise((resolve) => {
        const id = timers.setTimeout(resolve, ms);
        promise.then(() => {
          timers.clearTimeout(id);
          resolve();
        });
      });

    // resolves on the matching response OR after waitMs (protocol 5.4: "wait for the response, or 500 ms")
    const send = async (bytes, waitMs, kind) => {
      const key = commandKey(bytes);
      let got;
      const gotPromise = new Promise((resolve) => {
        got = resolve;
      });
      pending.set(key, got);
      try {
        await write(bytes, kind);
        await waitFor(gotPromise, waitMs);
      } finally {
        pending.delete(key);
      }
    };

    const configure = async (m, kind) => {
      await send(FEATURE_SET(m), cfg.initSpacingMs, kind);
      await send(FEATURE_ENABLE(m), cfg.initSpacingMs, kind);
    };

    // 4. command responses (optional, never fatal)
    const respChar = chars.get(ch.response);
    if (respChar) {
      try {
        listen(respChar, 'characteristicvaluechanged', (e) => {
          const v = e.target.value;
          if (!v || v.byteLength < 4) return;
          const resolve = pending.get(`${v.getUint8(0)}:${v.getUint8(3)}`);
          if (resolve) resolve();
        });
        await serial(() => respChar.startNotifications(), { ms: cfg.responseSubscribeTimeoutMs, makeError: () => new Error('startNotifications timeout') });
      } catch (e) {
        emit({ type: 'warn', message: `no command responses: ${e?.message ?? e}` });
      }
    }
    abortIfNeeded();

    // 5. init: LED (stops the pairing sweep = the visible "connected" cue), SET, ENABLE
    try {
      await send(LED(0x01), cfg.initSpacingMs, 'init');
      abortIfNeeded();
      await configure(mask, 'init');
    } catch (e) {
      throw classifyGattError(e, 'write');
    }
    abortIfNeeded();
    stage('commands');

    // 6. input notifications: the handler copies the bytes and stamps the arrival first thing
    listen(inputChar, 'characteristicvaluechanged', (e) => {
      const arrivedAt = clock.now();
      if (!alive) return;
      const dv = e.target.value;
      const bytes = new Uint8Array(dv.byteLength);
      bytes.set(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      o.onReport(bytes, arrivedAt);
    });
    try {
      await serial(() => inputChar.startNotifications(), { ms: cfg.connectTimeoutMs, makeError: () => new LinkError(INPUT_ERROR.GATT_FAILURE, 'timeout: startNotifications on the input characteristic') });
    } catch (e) {
      throw classifyGattError(e, 'notify');
    }
    abortIfNeeded();

    // 7. keep-alive
    keepTimer = timers.setInterval(() => {
      if (!alive || !keepAliveOn) return;
      if (clock.now() - lastWriteAt <= cfg.keepAliveIdleMs) return;
      write(LED(0x01), 'keepalive').then(
        () => {
          keepAliveFailures = 0;
        },
        (e) => {
          if (++keepAliveFailures === 3) emit({ type: 'warn', message: `keep-alive writes keep failing: ${e?.message ?? e}` });
        },
      );
    }, cfg.keepAliveMs);
    stage('subscribed');

    return {
      side: detected.side,
      sideSource: detected.source,
      deviceName: device.name ?? null,
      isAlive: () => alive,
      write,
      /** Vibration preset (UNVERIFIED-ON-HARDWARE UOH-13): best effort, rate limited, errors swallowed. */
      vibrate(presetId) {
        const now = clock.now();
        if (!alive || now - lastHapticAt < cfg.hapticMinIntervalMs) return false;
        lastHapticAt = now;
        write(VIBRATE(presetId), 'haptic').catch(() => {});
        return true;
      },
      /** SET then ENABLE with a mask (watchdog stage 2 uses the fallback mask). */
      configure: (m) => configure(m, 'watchdog'),
      /** ENABLE only (watchdog stage 1). */
      enable: (m) => write(FEATURE_ENABLE(m), 'watchdog'),
      setKeepAlive(on) {
        keepAliveOn = !!on;
      },
      stats: () => ({ lastWriteAt: lastWriteAt === -Infinity ? null : lastWriteAt, writeCount, keepAlive: keepAliveOn }),
      close,
    };
  } catch (err) {
    close();
    throw err instanceof LinkError ? err : classifyGattError(err, 'connect');
  }
}
