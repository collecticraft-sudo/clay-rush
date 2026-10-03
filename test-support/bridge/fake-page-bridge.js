// A FAKE browser side of the native bridge for the provider tests: a `fetch` that answers like the /__bridge/ endpoints of server.js and an
// `EventSource` the test pushes events into. Test helper of the input engineer. It models docs/native-bridge.md, not a real server or a real
// Joy-Con (UNVERIFIED-ON-HARDWARE). The provider under test gets it through opts.fetch and opts.EventSource; time comes from a manual clock.

import { createManualClock } from '../../public/js/shared/clock.js';
import { createFakeTimers, flush } from '../input/fake-timers.js';
import { FakeDocument } from '../input/fake-dom.js';
import { createNativeProvider } from '../../public/js/input/native-provider.js';
import { VECTORS } from '../input/vectors.js';

export const vectorHex = (id) => VECTORS.vectors.find((v) => v.id === id).hex;

const OK_STATUS = Object.freeze({ available: true, reason: null, built: true, canBuild: false, state: 'idle' });

/**
 * @param {object} [o]
 * @param {object} [o.status]           body of GET /status
 * @param {number} [o.statusHttp]       HTTP status of GET /status (default 200)
 * @param {boolean} [o.statusThrows]    GET /status fails like a network error
 * @param {boolean} [o.statusNever]     GET /status never answers
 * @param {boolean} [o.connectThrows]   POST /connect fails like a network error
 * @param {{status:number, body:object}} [o.connectError]  POST /connect answers with this error
 * @param {Promise<void>} [o.connectGate]  POST /connect waits for this promise before it answers
 * @param {boolean} [o.autoOpen]        EventSource opens by itself (default true)
 */
export function createFakePageBridge(o = {}) {
  const calls = [];
  const sources = [];
  let seq = 0;
  const cfg = { status: OK_STATUS, statusHttp: 200, autoOpen: true, ...o };

  const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  async function fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    const path = String(url).replace(/^.*\/__bridge/, '');
    const headers = init.headers ?? {};
    const body = init.body !== undefined ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers, keepalive: init.keepalive === true, url: String(url) });
    if (method === 'POST' && headers['X-Joycon-Ninja'] !== '1') return response(403, { ok: false, code: 'forbidden', message: 'missing header' });
    if (path === '/status') {
      if (cfg.statusNever) return new Promise(() => {}); // a server that never answers
      if (cfg.statusThrows) throw new TypeError('fetch failed');
      return response(cfg.statusHttp, cfg.status);
    }
    if (path === '/connect') {
      if (cfg.connectThrows) throw new TypeError('fetch failed');
      const atRequest = seq;
      if (cfg.connectGate) await cfg.connectGate;
      if (cfg.connectError) return response(cfg.connectError.status, cfg.connectError.body);
      return response(200, { ok: true, seq: atRequest });
    }
    if (path === '/disconnect' || path === '/rumble') return response(200, { ok: true });
    return response(404, { ok: false, code: 'not_found' });
  }

  class FakeEventSource {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      sources.push(this);
      if (cfg.autoOpen) queueMicrotask(() => this.open());
    }

    open() {
      if (this.closed || this.readyState === 1) return;
      this.readyState = 1;
      this.onopen?.({});
    }

    message(obj) {
      this.onmessage?.({ data: JSON.stringify(obj) });
    }

    raw(text) {
      this.onmessage?.({ data: text });
    }

    error() {
      this.readyState = 0;
      this.onerror?.({});
    }

    close() {
      this.readyState = 2;
      this.closed = true;
    }
  }

  const bridge = {
    fetch,
    EventSource: FakeEventSource,
    calls,
    sources,
    config: cfg,
    /** the open stream of the provider (the newest one) */
    get source() {
      return sources[sources.length - 1] ?? null;
    },
    /** Sequence number of the last event sent. */
    get seq() {
      return seq;
    },
    /** Send one event to the newest open stream, numbered like the server numbers them (unless `seq` is given). */
    emit(event) {
      const e = { ...event };
      if (e.seq === undefined) e.seq = ++seq;
      else seq = Math.max(seq, e.seq);
      const s = sources.filter((x) => x.readyState === 1 && !x.closed).pop();
      s?.message(e);
      return e;
    },
    status: (state, extra = {}) => bridge.emit({ type: 'status', state, ...extra }),
    report: (hex, t) => bridge.emit({ type: 'report', t, hex }),
    posts: (path) => calls.filter((c) => c.method === 'POST' && c.path === path),
  };
  return bridge;
}

/**
 * Provider + fake bridge + manual clock + fake timers + collectors.
 * @param {object} [o]  {bridge: createFakePageBridge options, provider: createNativeProvider options}
 */
export function setupNative(o = {}) {
  const clock = createManualClock(1000);
  const timers = createFakeTimers(clock);
  const bridge = createFakePageBridge(o.bridge);
  const document = new FakeDocument();
  const page = new EventTarget();
  const provider = createNativeProvider({
    clock, timers, fetch: bridge.fetch, EventSource: bridge.EventSource, document, pageTarget: page, strictTransitions: true, ...(o.provider ?? {}),
  });
  const rec = { status: [], errors: [], samples: [], actions: [], logs: [], buttons: [], packets: [], bridge: [] };
  provider.on('status', (s) => rec.status.push(s));
  provider.on('error', (e) => rec.errors.push(e));
  provider.on('sample', (s) => rec.samples.push(s));
  provider.on('action', (a) => rec.actions.push(a));
  provider.on('log', (l) => rec.logs.push(l));
  provider.on('buttons', (b) => rec.buttons.push(b));
  provider.on('packet', (p) => rec.packets.push(p));
  provider.on('bridge', (b) => rec.bridge.push(b));

  const t = {
    clock, timers, bridge, document, page, provider, rec,
    /** provider.connect() with the rejection handled (tests inspect it through `await assert.rejects(p)`) */
    connect(opts) {
      const p = provider.connect(opts);
      p.catch(() => {});
      return p;
    },
    reconnect() {
      const p = provider.reconnect();
      p.catch(() => {});
      return p;
    },
    advance: (ms) => timers.advance(ms),
    flush,
    /** let the provider's promise chain run until the connect request has been posted and answered */
    async posted() {
      for (let i = 0; i < 200 && bridge.posts('/connect').length === 0; i++) await flush();
      await flush();
      await flush();
    },
    /** distinct consecutive states seen in status events */
    states() {
      const out = [];
      for (const s of rec.status) if (out[out.length - 1] !== s.state) out.push(s.state);
      return out;
    },
    /** Drive a normal attempt up to (but not including) the first report: posted, scanning ... helper streaming. */
    async toHelperStreaming(side = 'R') {
      await t.posted();
      bridge.status('scanning', { message: 'waiting for Bluetooth' }); // the real helper sends `scanning` twice: accepted, then really scanning
      bridge.status('scanning', { message: 'scanning for a Joy-Con 2' });
      bridge.emit({ type: 'advert', side, pid: 8294, rssi: -40, host: '00 00 00 00 00 00', pairing: true });
      bridge.status('connecting', { side });
      bridge.status('discovering', { side });
      bridge.status('initialising', { side });
      bridge.status('streaming', { side });
      await flush();
    },
    dispose() {
      provider.dispose();
    },
  };
  return t;
}
