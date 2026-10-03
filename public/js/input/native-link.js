// Transport of the native Bluetooth provider: fetch + EventSource towards the /__bridge/ endpoints of server.js (docs/native-bridge.md).
// OWNER: input engineer. No game knowledge and no state machine (that is native-provider.js).
//
// Everything is injected (fetch, EventSource, timers), so the module is importable in Node and testable without a browser.
// Rules it keeps:
//   * Every POST carries the custom header X-Joycon-Ninja: 1 (the server refuses a POST without it: a foreign web page cannot add
//     it without a CORS preflight, which the server never approves). The browser adds the Origin header by itself.
//   * One EventSource per link. A broken stream is reported once and closed at once: the browser's automatic reconnection is never
//     used, because the retry policy belongs to the provider's state machine (one attempt per call, no loops).
//   * Failures are BridgeError objects with a machine-readable bridge code (see NATIVE_ERRORS in native-provider.js); the server's
//     JSON error `code` is used when it sent one.
//
// Whether the real helper behind these endpoints works is UNVERIFIED-ON-HARDWARE.

export const BRIDGE_PATH = '/__bridge';
export const BRIDGE_HEADER = 'X-Joycon-Ninja';

/** Error with a bridge code: `bridge_unreachable`, `bridge_missing`, `bridge_refused`, `bridge_busy`, or a code sent by the server. */
export class BridgeError extends Error {
  constructor(code, message, httpStatus = null) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function errorFromResponse(status, body) {
  const code = body && typeof body.code === 'string' ? body.code : null;
  const message = body && typeof body.message === 'string' ? body.message : `the bridge answered HTTP ${status}`;
  if (status === 404) return new BridgeError('bridge_missing', 'this server has no bridge endpoints (an older server.js is running): restart the game', status);
  if (status === 403) return new BridgeError('bridge_refused', `the bridge refused the request (HTTP 403): ${message}`, status);
  if (status === 409) return new BridgeError('bridge_busy', message, status);
  if (code) return new BridgeError(code, message, status);
  return new BridgeError('bridge_unreachable', message, status);
}

/**
 * @param {object} o
 * @param {typeof fetch} o.fetch
 * @param {new (url:string) => any} o.EventSource
 * @param {import('./timers.js').Timers} o.timers
 * @param {(event:object) => void} o.onEvent          every parsed SSE message
 * @param {(err:BridgeError) => void} o.onStreamError  the stream broke AFTER it was open (already closed when this is called)
 * @param {string} [o.baseUrl]                        default '' (same origin as the page)
 * @param {number} [o.openTimeoutMs]                  default 5000
 */
export function createNativeLink(o) {
  const { timers } = o;
  const base = `${o.baseUrl ?? ''}${BRIDGE_PATH}`;
  const openTimeoutMs = o.openTimeoutMs ?? 5000;
  let source = null;

  async function call(method, path, body, init = {}) {
    let res;
    try {
      res = await o.fetch(`${base}${path}`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json', [BRIDGE_HEADER]: '1' } : {},
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        cache: 'no-store',
        ...init,
      });
    } catch (err) {
      throw new BridgeError('bridge_unreachable', `cannot reach the game server: ${err && err.message ? err.message : err}`);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw errorFromResponse(res.status, json);
    return json ?? {};
  }

  function closeEvents() {
    const s = source;
    source = null;
    if (!s) return;
    s.onopen = null;
    s.onmessage = null;
    s.onerror = null;
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }

  return {
    /** GET /__bridge/status -> {available, reason, built, canBuild, state} */
    status: () => call('GET', '/status'),

    /** Open the event stream. Resolves when it is open; rejects with a BridgeError when it cannot be opened in time. */
    openEvents() {
      closeEvents();
      return new Promise((resolve, reject) => {
        let settled = false;
        let opened = false;
        const es = new o.EventSource(`${base}/events`);
        source = es;
        const timer = timers.setTimeout(() => {
          if (settled) return;
          settled = true;
          closeEvents();
          reject(new BridgeError('bridge_unreachable', `the event stream did not open within ${openTimeoutMs} ms`));
        }, openTimeoutMs);
        es.onopen = () => {
          if (settled) return;
          settled = true;
          opened = true;
          timers.clearTimeout(timer);
          resolve();
        };
        es.onmessage = (e) => {
          if (source !== es) return;
          let event;
          try {
            event = JSON.parse(e.data);
          } catch {
            return; // a malformed message is ignored
          }
          if (event && typeof event === 'object') o.onEvent(event);
        };
        es.onerror = () => {
          if (source !== es) return;
          closeEvents(); // never let the browser reconnect on its own
          if (!settled) {
            settled = true;
            timers.clearTimeout(timer);
            reject(new BridgeError('bridge_unreachable', 'the event stream could not be opened (server stopped, or it refused the request)'));
          } else if (opened) o.onStreamError(new BridgeError('bridge_unreachable', 'the event stream from the game server broke'));
        };
      });
    },

    closeEvents,
    isOpen: () => source !== null,

    /** POST /__bridge/connect -> {ok:true, seq}. Throws BridgeError. */
    connect: (params) => call('POST', '/connect', params),

    /** POST /__bridge/disconnect. Never throws. `keepalive` lets the request outlive a page that is being closed. */
    async disconnect({ keepalive = false } = {}) {
      try {
        await call('POST', '/disconnect', {}, keepalive ? { keepalive: true } : {});
      } catch {
        /* the server may be gone already: nothing more to do */
      }
    },

    /** POST /__bridge/rumble. Never throws. */
    async rumble(id) {
      try {
        await call('POST', '/rumble', { id });
      } catch {
        /* best effort */
      }
    },
  };
}
