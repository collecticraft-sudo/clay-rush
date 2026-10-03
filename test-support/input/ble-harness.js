// Harness for the BLE provider tests: manual clock, fake timers, fake Bluetooth, event collectors. Test helper of the
// input engineer. The fake models docs/joycon2-protocol.md, not the hardware (UNVERIFIED-ON-HARDWARE).

import { createManualClock } from '../../public/js/shared/clock.js';
import { createInputProvider } from '../../public/js/input/index.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';
import { createFakeTimers } from './fake-timers.js';
import { createFakeBluetooth } from './fake-bluetooth.js';
import { FakeDocument } from './fake-dom.js';

export const CH = INPUT_CONFIG.characteristics;
export const FRAME = {
  led: '09910107000800000100000000000000',
  set37: '0c9101020004000037000000',
  enable37: '0c9101040004000037000000',
  setB7: '0c91010200040000b7000000',
  enableB7: '0c91010400040000b7000000',
  setFF: '0c91010200040000ff000000',
  enableFF: '0c91010400040000ff000000',
  vibrate3: '0a9101020004000003000000',
};

/**
 * @param {object} [behaviour]  fake device behaviour (see fake-bluetooth.js)
 * @param {object} [opts]       {noBluetooth, providerOpts}
 */
export function setup(behaviour = {}, opts = {}) {
  const clock = createManualClock(1000);
  const timers = createFakeTimers(clock);
  const fake = createFakeBluetooth({ clock, timers, behaviour });
  const document = new FakeDocument();
  const page = new EventTarget();
  const provider = createInputProvider('joycon', {
    clock, timers, bluetooth: opts.noBluetooth ? null : fake.bluetooth, document, pageTarget: page, strictTransitions: true, ...(opts.providerOpts ?? {}),
  });
  const rec = { status: [], errors: [], samples: [], actions: [], logs: [], buttons: [], packets: [] };
  provider.on('status', (s) => rec.status.push(s));
  provider.on('error', (e) => rec.errors.push(e));
  provider.on('sample', (s) => rec.samples.push(s));
  provider.on('action', (a) => rec.actions.push(a));
  provider.on('log', (l) => rec.logs.push(l));
  provider.on('buttons', (b) => rec.buttons.push(b));
  provider.on('packet', (p) => rec.packets.push(p));

  const t = {
    clock, timers, fake, document, page, provider, rec,
    /** provider.connect() with the rejection handled (tests inspect it through `await assert.rejects(p)`) */
    connect(o) {
      const p = provider.connect(o);
      p.catch(() => {});
      return p;
    },
    reconnect() {
      const p = provider.reconnect();
      p.catch(() => {});
      return p;
    },
    advance: (ms) => timers.advance(ms),
    /** advance in steps until predicate() is true, at most maxMs; returns the elapsed time */
    async until(predicate, maxMs = 20000, stepMs = 50) {
      let elapsed = 0;
      while (!predicate() && elapsed < maxMs) {
        await timers.advance(stepMs);
        elapsed += stepMs;
      }
      return elapsed;
    },
    /** distinct consecutive states seen in status events */
    states() {
      const out = [];
      for (const s of rec.status) if (out[out.length - 1] !== s.state) out.push(s.state);
      return out;
    },
    /** connect and run until streaming */
    async connected(o) {
      const p = t.connect(o);
      await t.until(() => provider.status.state === 'streaming' || provider.status.state === 'error', 30000);
      await p;
      return p;
    },
    frames: () => fake.commandFrames(),
    dispose() {
      provider.dispose();
      fake.stop();
    },
  };
  return t;
}
