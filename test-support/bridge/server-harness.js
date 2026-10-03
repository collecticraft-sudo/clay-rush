// Helpers for the server-side bridge tests: a server with the FAKE helper, a raw HTTP client, an SSE client. Test helper of the
// input engineer. Everything here models the protocol of docs/native-bridge.md, never a real Joy-Con (UNVERIFIED-ON-HARDWARE).

import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FAKE_HELPER = join(ROOT, 'test-support', 'bridge', 'fake-helper.mjs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred, ms = 5000, step = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(step);
  }
  return false;
}

/** Is a process alive? (signal 0 checks existence only) */
export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Start a server whose bridge uses the fake helper. `scenario` and `env` are given to the helper; `bridge` are manager options.
 * @returns {Promise<{server:object, port:number, origin:string, log:()=>object[], pids:()=>number[], cleanup:()=>Promise<void>}>}
 */
export async function startBridgeServer({ scenario = 'happy', env = {}, bridge = {}, heartbeatMs = 10000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'joycon-bridge-test-'));
  const logFile = join(dir, 'helper.log');
  const helperEnv = { ...process.env, FAKE_HELPER_SCENARIO: scenario, FAKE_HELPER_LOG: logFile, ...env };
  delete helperEnv.JOYCON_BRIDGE_BIN; // a developer's own override must never leak into the tests
  const server = await startServer({
    port: 0,
    quiet: true,
    bridgeHeartbeatMs: heartbeatMs,
    bridge: {
      bin: FAKE_HELPER,
      env: helperEnv,
      helloTimeoutMs: 3000,
      stopGraceMs: 300,
      log: () => {},
      ...bridge,
    },
  });
  const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    server,
    port: server.port,
    origin: `http://localhost:${server.port}`,
    log,
    pids: () => log().filter((e) => e.event === 'start').map((e) => e.pid),
    commands: () => log().filter((e) => e.event === 'command').map((e) => e.cmd),
    async cleanup() {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Raw request: `path` is sent as given. JSON bodies are serialised unless `rawBody` is set. */
export function request(port, { method = 'GET', path = '/', headers = {}, body, rawBody } = {}) {
  return new Promise((resolvePromise, reject) => {
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
    const h = { Host: `localhost:${port}`, ...headers };
    if (payload !== undefined) {
      h['Content-Length'] = Buffer.byteLength(payload);
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolvePromise({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A same-origin POST as the game page would send it. */
export const post = (b, path, body, extraHeaders = {}) => request(b.port, {
  method: 'POST', path, body, headers: { Origin: b.origin, 'X-Joycon-Ninja': '1', ...extraHeaders },
});

export const getJson = (b, path, extraHeaders = {}) => request(b.port, { path, headers: { Origin: b.origin, ...extraHeaders } });

/** An SSE listener. `events` are the parsed `data:` objects, `comments` the `:` lines. */
export function openEvents(b, { headers = {}, path = '/__bridge/events' } = {}) {
  const events = [];
  const comments = [];
  let status = null;
  let resHeaders = null;
  let buffer = '';
  let closed = false;
  let req;
  const ready = new Promise((resolvePromise, reject) => {
    req = http.request({ host: '127.0.0.1', port: b.port, path, headers: { Host: `localhost:${b.port}`, Origin: b.origin, Accept: 'text/event-stream', ...headers } }, (res) => {
      status = res.statusCode;
      resHeaders = res.headers;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) comments.push(line.slice(1).trim());
            else if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
          }
        }
      });
      res.on('close', () => { closed = true; });
      resolvePromise();
    });
    req.on('error', (err) => { closed = true; reject(err); });
    req.end();
  });
  return {
    events, comments,
    ready,
    get status() { return status; },
    get headers() { return resHeaders; },
    get closed() { return closed; },
    /** the distinct consecutive states (a fresh helper prints a startup `idle` after the replayed one) */
    states: () => {
      const out = [];
      for (const e of events) if (e.type === 'status' && !e.warning && out[out.length - 1] !== e.state) out.push(e.state);
      return out;
    },
    byType: (type) => events.filter((e) => e.type === type),
    waitFor: (pred, ms = 5000) => waitFor(() => events.some(pred), ms),
    close() { req.destroy(); },
  };
}
