// Clay Rush static server (code name clay-shooter). OWNER: integrator; the /assets/ delivery rules (MIME types, ETag, 304) belong to the
// Asset engineer, docs/assets-integration.md 1.9. docs/architecture.md 9.5. The /__bridge/ endpoints (native Bluetooth bridge) are
// docs/native-bridge.md; the helper manager behind them is bridge/manager.js.
//
// Dependency-free (node:http, node:fs, node:path, node:url, plus the local bridge/manager.js, which is loaded lazily and itself uses
// Node built-ins only). Serves the `public/` folder on 127.0.0.1:8141. Web Bluetooth needs a secure context and `http://localhost`
// qualifies, so nothing else is needed. The server is bound to the loopback interface on purpose and is never reachable from the LAN.
//
// Native Bluetooth bridge (for Macs where Chrome's Web Bluetooth chooser lists nothing): a compiled CoreBluetooth helper is spawned
// on the first /__bridge/connect and its JSON lines are forwarded to pages as Server-Sent Events:
//   GET  /__bridge/status      {available, reason, built, canBuild, state}
//   GET  /__bridge/events      SSE: every helper line as `data:`, the last status replayed first, a comment heartbeat every 10 s
//   POST /__bridge/connect     {side:"R"|"L"|"any", scanSeconds?, keepAliveHz?, mask?, pairingOnly?}
//   POST /__bridge/disconnect  {}
//   POST /__bridge/rumble      {id}
// SECURITY: any web page in the owner's browser can reach http://localhost. So every /__bridge request must carry an Origin header
// (when the browser sends one) equal to this server's own origin and a Sec-Fetch-Site of same-origin or none, and every POST
// additionally needs the custom header X-Joycon-Ninja: 1, which a cross-site page cannot add without a CORS preflight that this
// server never approves. Bodies are validated field by field and sent to the helper as JSON over a pipe: no shell is involved.
//
//   node server.js            start (PORT=1234 node server.js uses another port)
//   import { startServer }    used by the tests (test/server, test/e2e, test/bridge)
//
// Exit codes: 0 normal stop or "already running" (a Clay Rush server answers /__health on the port), 1 the port is taken by
// something else or the server cannot start.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 8141;
export const HOST = '127.0.0.1';
export const HEALTH_BODY = '{"ok":true,"name":"clay-shooter"}';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(HERE, 'public');

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.csv': 'text/csv; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
});

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

// The generated art lives under /assets/ (public/assets/, docs/assets-integration.md 1.9). Those files change only when the owner rebuilds
// them, so they may be cached, but never without asking the server first: `no-cache` plus a weak ETag (size and mtime) makes every reload a
// cheap conditional request (304, no body) and a rebuilt file is picked up at once. Everything else keeps `no-store`.
export const ASSETS_CACHE_CONTROL = 'no-cache';
const assetEtag = (st) => `W/"${st.size}-${st.mtimeMs}"`;

/** True when an If-None-Match header lists `etag` (weak comparison, RFC 9110 section 13.1.2) or is `*`. */
export function etagMatches(header, etag) {
  if (typeof header !== 'string' || header === '') return false;
  if (header.trim() === '*') return true;
  const bare = (t) => t.trim().replace(/^W\//, '');
  const wanted = bare(etag);
  return header.split(',').some((t) => bare(t) === wanted);
}

// Documents may only load code, styles, images and connections from this server: the game is offline by design, and this makes the
// browser refuse an accidental external fetch. Inline styles stay allowed (the diagnostics page and the fatal-error box use them);
// no inline script is allowed. Web Bluetooth is not governed by CSP.
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res, status, body, headers = {}, isHead = false) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': buf.length, ...headers });
  res.end(isHead ? undefined : buf);
}

const text = (res, status, message, isHead, extra = {}) => send(res, status, `${message}\n`, { 'Content-Type': 'text/plain; charset=utf-8', ...extra }, isHead);

/**
 * Map a request target to an absolute file path inside `root`, or return a reason for refusing it.
 * Rejects: NUL bytes, malformed percent-encoding, backslashes, any `..` segment (also encoded), absolute Windows-style paths.
 * The caller must still check the real path (symlinks) with realpath.
 * @returns {{ok:true, file:string} | {ok:false, status:number, reason:string}}
 */
export function resolveRequestPath(rawUrl, root) {
  // Only origin-form targets ("/index.html?x=1") are accepted: no absolute-form, no protocol-relative "//host/x", no backslashes
  // (the URL parser would silently turn "\\" into "/"), no raw NUL bytes.
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return { ok: false, status: 400, reason: 'bad request target' };
  if (rawUrl.includes('\\') || rawUrl.includes('\0')) return { ok: false, status: 400, reason: 'illegal character in request target' };
  let pathname;
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return { ok: false, status: 400, reason: 'bad request target' };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, status: 400, reason: 'malformed percent-encoding' };
  }
  if (decoded.includes('\0')) return { ok: false, status: 400, reason: 'NUL byte in path' };
  if (decoded.includes('\\')) return { ok: false, status: 400, reason: 'backslash in path' };
  if (!decoded.startsWith('/')) return { ok: false, status: 400, reason: 'path must be absolute' };
  const segments = decoded.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '..' || s === '.')) return { ok: false, status: 400, reason: 'path traversal' };
  // Dot files (.git, .env, ...) are never served from a static folder.
  if (segments.some((s) => s.startsWith('.'))) return { ok: false, status: 404, reason: 'not found' };
  const rel = segments.join(path.sep);
  const file = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (file !== root && !file.startsWith(rootWithSep)) return { ok: false, status: 400, reason: 'path traversal' };
  return { ok: true, file };
}

function hostAllowed(hostHeader, port) {
  // DNS-rebinding guard: only the loopback names on our own port are accepted.
  if (!hostHeader) return false;
  const h = String(hostHeader).toLowerCase();
  const ok = new Set(['localhost', '127.0.0.1', '[::1]']);
  const [name, p] = h.startsWith('[') ? [h.slice(0, h.indexOf(']') + 1), h.slice(h.indexOf(']') + 2)] : h.split(':');
  if (!ok.has(name)) return false;
  return p === undefined || p === '' || Number(p) === port;
}

// --------------------------------------------------------------------------------------------------------------------
// Native Bluetooth bridge endpoints (docs/native-bridge.md)

export const BRIDGE_HEADER = 'X-Joycon-Ninja';
const BRIDGE_ROUTES = Object.freeze({
  '/__bridge/status': 'GET',
  '/__bridge/events': 'GET',
  '/__bridge/connect': 'POST',
  '/__bridge/disconnect': 'POST',
  '/__bridge/rumble': 'POST',
});
const BRIDGE_BODY_LIMIT = 2048;
const SSE_BACKLOG_LIMIT = 256 * 1024; // a listener that falls this far behind is dropped
const SSE_HEARTBEAT_MS = 10000;

/** The Origin rule: a browser-sent Origin must be this server's own, and a Sec-Fetch-Site must be same-origin or none. */
export function bridgeOriginAllowed(headers, port) {
  const origin = headers.origin;
  if (origin !== undefined && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) return false;
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > BRIDGE_BODY_LIMIT) {
      req.resume();
      resolve({ ok: false, status: 413, reason: 'body too large' });
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BRIDGE_BODY_LIMIT) {
        finish({ ok: false, status: 413, reason: 'body too large' });
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return finish({ ok: true, value: {} });
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, status: 400, reason: 'body is not valid JSON' });
      }
    });
    req.on('error', () => finish({ ok: false, status: 400, reason: 'request error' }));
  });
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clampNumber = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Field-by-field validation of a connect body; only known, typed fields reach the helper. */
export function parseConnectBody(body) {
  if (!isPlainObject(body)) return { error: 'the body must be a JSON object' };
  const out = { side: 'any' };
  if (body.side !== undefined) {
    if (body.side !== 'R' && body.side !== 'L' && body.side !== 'any') return { error: 'side must be "R", "L" or "any"' };
    out.side = body.side;
  }
  if (body.scanSeconds !== undefined) {
    if (typeof body.scanSeconds !== 'number' || !Number.isFinite(body.scanSeconds)) return { error: 'scanSeconds must be a number' };
    out.scanSeconds = clampNumber(body.scanSeconds, 5, 120);
  }
  if (body.keepAliveHz !== undefined) {
    if (typeof body.keepAliveHz !== 'number' || !Number.isFinite(body.keepAliveHz)) return { error: 'keepAliveHz must be a number' };
    out.keepAliveHz = clampNumber(body.keepAliveHz, 0, 5);
  }
  if (body.mask !== undefined) {
    if (!Number.isInteger(body.mask) || body.mask < 0 || body.mask > 255) return { error: 'mask must be an integer from 0 to 255' };
    out.mask = body.mask;
  }
  if (body.pairingOnly !== undefined) {
    if (typeof body.pairingOnly !== 'boolean') return { error: 'pairingOnly must be true or false' };
    out.pairingOnly = body.pairingOnly;
  }
  return { value: out };
}

/**
 * Create (but do not start) the request handler. `root` must be an existing directory.
 * @param {{root?:string, getPort?:()=>number}} [opts]
 */
export function createRequestHandler(opts = {}) {
  const root = fs.realpathSync(path.resolve(opts.root ?? DEFAULT_ROOT));
  const assetsPrefix = path.join(root, 'assets') + path.sep;
  const getPort = opts.getPort ?? (() => DEFAULT_PORT);

  // The bridge manager is created on the first /__bridge request: the game server never depends on the bridge code.
  let bridgePromise = null;
  const getBridge = () => {
    bridgePromise ??= import('./bridge/manager.js').then((m) => m.createBridgeManager(opts.bridge ?? {}));
    return bridgePromise;
  };

  const json = (res, status, body, extra = {}) => send(res, status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  const refuse = (res, status, code, message, extra = {}) => json(res, status, { ok: false, code, message }, extra);

  /** GET /__bridge/events: Server-Sent Events. */
  async function bridgeEvents(req, res) {
    const bridge = await getBridge();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.write(': connected\n\n');
    const write = (event) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.writableLength > SSE_BACKLOG_LIMIT) {
        res.destroy(); // a listener that cannot keep up must not make the server buffer for ever
        return;
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
    }, opts.bridgeHeartbeatMs ?? SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    const unsubscribe = bridge.subscribe(write);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on('close', cleanup);
    req.on('error', cleanup);
  }

  async function handleBridge(req, res, pathname) {
    const wanted = BRIDGE_ROUTES[pathname];
    if (!wanted) return refuse(res, 404, 'not_found', 'unknown bridge endpoint');
    if (req.method !== wanted) return refuse(res, 405, 'method_not_allowed', `use ${wanted}`, { Allow: wanted });
    if (!bridgeOriginAllowed(req.headers, getPort())) return refuse(res, 403, 'forbidden', 'cross-origin request refused');
    if (wanted === 'POST') {
      if (req.headers[BRIDGE_HEADER.toLowerCase()] !== '1') {
        req.resume();
        return refuse(res, 403, 'forbidden', `missing ${BRIDGE_HEADER}: 1`);
      }
      const length = Number(req.headers['content-length'] ?? 0);
      if (length > 0 && !/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
        req.resume();
        return refuse(res, 415, 'unsupported_media_type', 'send application/json');
      }
    }

    let bridge;
    try {
      bridge = await getBridge();
    } catch (err) {
      console.error('[server] the bridge module failed to load:', err && err.message ? err.message : err);
      if (pathname === '/__bridge/status') return json(res, 200, { available: false, reason: 'bridge_module_error', built: false, canBuild: false, state: 'idle' });
      return refuse(res, 500, 'bridge_module_error', 'the bridge module failed to load');
    }

    if (pathname === '/__bridge/status') return json(res, 200, await bridge.getStatus());
    if (pathname === '/__bridge/events') return bridgeEvents(req, res);

    const body = await readJsonBody(req);
    if (!body.ok) return refuse(res, body.status, 'bad_request', body.reason);
    if (pathname === '/__bridge/connect') {
      const parsed = parseConnectBody(body.value);
      if (parsed.error) return refuse(res, 400, 'bad_request', parsed.error);
      const result = await bridge.connect(parsed.value);
      if (!result.ok) return refuse(res, result.status, result.code, result.message);
      return json(res, 200, { ok: true, seq: result.seq });
    }
    if (pathname === '/__bridge/disconnect') return json(res, 200, bridge.disconnect());
    // rumble
    if (!isPlainObject(body.value) || !Number.isInteger(body.value.id) || body.value.id < 0 || body.value.id > 255) return refuse(res, 400, 'bad_request', 'id must be an integer from 0 to 255');
    return json(res, 200, bridge.rumble(body.value.id));
  }

  async function stopBridge() {
    if (!bridgePromise) return;
    const bridge = await bridgePromise.catch(() => null);
    if (bridge) await bridge.stop();
  }

  async function handle(req, res) {
    const isHead = req.method === 'HEAD';
    try {
      if (!hostAllowed(req.headers.host, getPort())) return text(res, 403, 'forbidden host', isHead);

      const target = req.url ?? '/';
      const pathname = target.split('?')[0].split('#')[0];
      if (pathname === '/__bridge' || pathname.startsWith('/__bridge/')) return await handleBridge(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed', isHead, { Allow: 'GET, HEAD' });

      if (pathname === '/__health') return send(res, 200, HEALTH_BODY, { 'Content-Type': 'application/json; charset=utf-8' }, isHead);

      const r = resolveRequestPath(target, root);
      if (!r.ok) return text(res, r.status, r.reason, isHead);

      let file = r.file;
      let st = await fs.promises.stat(file).catch(() => null);
      if (st && st.isDirectory()) {
        // No directory listing: only an index.html inside the folder is served.
        file = path.join(file, 'index.html');
        st = await fs.promises.stat(file).catch(() => null);
      }
      if (!st || !st.isFile()) return text(res, 404, 'not found', isHead);

      // Symlink escape: the real path must still be inside the root.
      const real = await fs.promises.realpath(file).catch(() => null);
      if (!real || (real !== root && !real.startsWith(root + path.sep))) return text(res, 404, 'not found', isHead);

      const type = MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
      if (real.startsWith(assetsPrefix)) {
        const etag = assetEtag(st);
        const cacheHeaders = { 'Cache-Control': ASSETS_CACHE_CONTROL, ETag: etag };
        if (etagMatches(req.headers['if-none-match'], etag)) {
          res.writeHead(304, { ...SECURITY_HEADERS, ...cacheHeaders });
          return res.end();
        }
        return send(res, 200, await fs.promises.readFile(real), { 'Content-Type': type, ...cacheHeaders }, isHead);
      }
      const body = await fs.promises.readFile(real);
      return send(res, 200, body, type.startsWith('text/html') ? { 'Content-Type': type, 'Content-Security-Policy': CSP } : { 'Content-Type': type }, isHead);
    } catch (err) {
      if (!res.headersSent) text(res, 500, 'internal error', isHead);
      else res.destroy();
      console.error('[server] request failed:', err && err.message ? err.message : err);
    }
  }
  handle.stopBridge = stopBridge;
  return handle;
}

/** GET /__health on the given port; resolves true when a Clay Rush server answers. */
export function probeHealth(port, host = HOST, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/__health', timeout: timeoutMs, headers: { Host: `localhost:${port}` } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 1000) req.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(res.statusCode === 200 && j && j.ok === true && j.name === 'clay-shooter');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Start listening on 127.0.0.1. Port 0 picks a free port (tests).
 * `bridge` are the options of bridge/manager.js (tests pass a fake helper binary), `bridgeHeartbeatMs` the SSE heartbeat (default 10 s).
 * @param {{port?:number, root?:string, quiet?:boolean, bridge?:object, bridgeHeartbeatMs?:number}} [opts]
 * @returns {Promise<{server:http.Server, port:number, url:string, close:()=>Promise<void>}>}
 */
export function startServer(opts = {}) {
  const wanted = opts.port ?? DEFAULT_PORT;
  let actualPort = wanted;
  const handler = createRequestHandler({ root: opts.root, getPort: () => actualPort, bridge: opts.bridge, bridgeHeartbeatMs: opts.bridgeHeartbeatMs });
  const server = http.createServer(handler);
  server.keepAliveTimeout = 2000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: wanted, host: HOST, exclusive: true }, () => {
      actualPort = server.address().port;
      server.off('error', reject);
      // after start a socket-level error on the server object would be an uncaught exception that kills the game server in the
      // middle of a session (round 2 finding n11, practically unreachable on loopback): log it and carry on
      server.on('error', (err) => {
        if (!opts.quiet) console.error(`[server] ${err && err.message ? err.message : err}`);
      });
      resolve({
        server,
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        // the bridge helper (if one was started) is stopped first, so it never outlives the server
        close: async () => {
          await handler.stopBridge().catch(() => {});
          await new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}

async function main() {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid PORT "${process.env.PORT}": use an integer from 1 to 65535.`);
    process.exit(1);
  }
  let running;
  try {
    running = await startServer({ port });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      if (await probeHealth(port)) {
        console.log(`Clay Rush is already running at http://localhost:${port}`);
        process.exit(0);
      }
      console.error(`Port ${port} is used by another program (it does not answer /__health as Clay Rush).`);
      console.error(`Close that program, or start on another port with:  PORT=8200 node server.js`);
      process.exit(1);
    }
    console.error(`Cannot start the server: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
  console.log(`Clay Rush is running at http://localhost:${running.port}`);
  console.log('Press Ctrl+C to stop.');
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, stopping.`);
    running.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3500).unref(); // the bridge helper gets up to about 1.4 s to stop first
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}
