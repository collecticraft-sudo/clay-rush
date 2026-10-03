// server.js: static files, MIME types, refusal of path traversal and of anything but GET/HEAD, health check, port handling.
// Real HTTP on the loopback interface with port 0 (no fixed port needed) and a temporary web root.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, resolveRequestPath, MIME, probeHealth } from '../../server.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_JS = join(ROOT, 'server.js');

/** Raw request: `path` is sent exactly as given (no normalisation by the client). */
function raw(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function makeWebRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'clay-rush-root-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'js'), { recursive: true });
  mkdirSync(join(web, 'css'), { recursive: true });
  mkdirSync(join(web, 'empty'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(web, 'js', 'a.js'), 'export const a = 1;');
  writeFileSync(join(web, 'js', 'b.mjs'), 'export const b = 2;');
  writeFileSync(join(web, 'css', 's.css'), 'body{}');
  writeFileSync(join(web, 'data.json'), '{"x":1}');
  writeFileSync(join(web, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(web, 'blob.bin'), 'zz');
  writeFileSync(join(web, '.secret'), 'nope');
  writeFileSync(join(dir, 'outside.txt'), 'OUTSIDE');
  symlinkSync(join(dir, 'outside.txt'), join(web, 'link.txt'));
  return { dir, web, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withServer(fn, root) {
  const s = await startServer({ port: 0, root });
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

test('serves the real public/ folder: index, module scripts, css and the diagnostics page with the right types', async () => {
  await withServer(async ({ port }) => {
    const index = await raw(port, { path: '/' });
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html; charset=utf-8$/);
    assert.match(index.body, /<canvas id="stage"/);
    assert.match(index.body, /js\/main\.js/);
    const main = await raw(port, { path: '/js/main.js' });
    assert.equal(main.status, 200);
    assert.match(main.headers['content-type'], /^text\/javascript; charset=utf-8$/);
    assert.match(main.body, /createApp/);
    const css = await raw(port, { path: '/css/game.css' });
    assert.match(css.headers['content-type'], /^text\/css/);
    const diag = await raw(port, { path: '/diagnostics.html' });
    assert.equal(diag.status, 200);
    assert.match(diag.body, /Joy-Con Diagnostics/);
    const withQuery = await raw(port, { path: '/index.html?input=sim&seed=1#x' });
    assert.equal(withQuery.status, 200, 'the query string is ignored for file lookup');
  });
});

test('every module the browser will import is served (the import graph of main.js resolves with no 404)', async () => {
  await withServer(async ({ port }) => {
    const seen = new Set();
    const queue = ['/js/main.js'];
    const bad = [];
    while (queue.length) {
      const p = queue.pop();
      if (seen.has(p)) continue;
      seen.add(p);
      const r = await raw(port, { path: p });
      if (r.status !== 200 || !/javascript/.test(r.headers['content-type'])) {
        bad.push(`${p} -> ${r.status}`);
        continue;
      }
      for (const m of r.body.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|^import\s+['"](\.[^'"]+)['"]/gm)) {
        const spec = m[1] ?? m[2] ?? m[3];
        queue.push(new URL(spec, `http://x${p}`).pathname);
      }
    }
    assert.deepEqual(bad, []);
    assert.ok(seen.size > 60, `walked ${seen.size} modules`);
  });
});

test('MIME map covers html, js, mjs, css, json, svg, png, ico, txt, webmanifest', async () => {
  const w = makeWebRoot();
  try {
    await withServer(async ({ port }) => {
      const expect = { '/index.html': /text\/html/, '/js/a.js': /text\/javascript; charset=utf-8/, '/js/b.mjs': /text\/javascript; charset=utf-8/, '/css/s.css': /text\/css/, '/data.json': /application\/json/, '/x.svg': /image\/svg\+xml/, '/blob.bin': /application\/octet-stream/ };
      for (const [path, re] of Object.entries(expect)) {
        const r = await raw(port, { path });
        assert.equal(r.status, 200, path);
        assert.match(r.headers['content-type'], re, path);
      }
    }, w.web);
    for (const ext of ['.html', '.js', '.mjs', '.css', '.json', '.svg', '.png', '.ico', '.txt', '.webmanifest']) assert.ok(MIME[ext], ext);
  } finally {
    w.cleanup();
  }
});

test('security headers on every response: no-store, nosniff, no referrer', async () => {
  await withServer(async ({ port }) => {
    for (const path of ['/', '/js/main.js', '/nope', '/__health']) {
      const r = await raw(port, { path });
      assert.equal(r.headers['cache-control'], 'no-store', path);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', path);
      assert.equal(r.headers['referrer-policy'], 'no-referrer', path);
    }
  });
});

test('HTML documents carry a Content-Security-Policy (same-origin only, no inline script); other files do not need one', async () => {
  await withServer(async ({ port }) => {
    for (const path of ['/', '/index.html', '/diagnostics.html']) {
      const r = await raw(port, { path });
      const csp = r.headers['content-security-policy'];
      assert.ok(csp, path);
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self'(?!.*'unsafe-inline'.*script)/);
      assert.doesNotMatch(csp.split(';').find((d) => d.trim().startsWith('script-src')), /unsafe-inline|unsafe-eval|https?:/);
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
    }
    assert.equal((await raw(port, { path: '/js/main.js' })).headers['content-security-policy'], undefined);
  });
});

test('/__health answers {"ok":true,"name":"clay-shooter"}', async () => {
  await withServer(async ({ port }) => {
    const r = await raw(port, { path: '/__health' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true, name: 'clay-shooter' });
    assert.equal(await probeHealth(port), true);
  });
});

test('path traversal is refused in every spelling; nothing outside the web root is ever served', async () => {
  const w = makeWebRoot();
  try {
    await withServer(async ({ port }) => {
      const attempts = [
        '/../outside.txt', '/..%2foutside.txt', '/%2e%2e/outside.txt', '/%2e%2e%2foutside.txt', '/js/../../outside.txt', '/js/..%2f..%2foutside.txt',
        '/..\\outside.txt', '/js\\..\\..\\outside.txt', '/%5c..%5coutside.txt', '/%00', '/index.html%00.txt', '/....//outside.txt', '//outside.txt',
        '/js/%2e%2e/%2e%2e/outside.txt', '/%252e%252e/outside.txt',
      ];
      for (const path of attempts) {
        const r = await raw(port, { path });
        assert.ok(r.status >= 400 && r.status < 500, `${path} -> ${r.status}`);
        assert.ok(!r.body.includes('OUTSIDE'), `${path} leaked the outside file`);
      }
      // absolute-form request targets are not a way out either
      const abs = await raw(port, { path: 'http://localhost/../outside.txt' });
      assert.ok(!abs.body.includes('OUTSIDE'));
    }, w.web);
  } finally {
    w.cleanup();
  }
});

test('a symlink that points outside the web root is not followed; dot files are not served', async () => {
  const w = makeWebRoot();
  try {
    await withServer(async ({ port }) => {
      const link = await raw(port, { path: '/link.txt' });
      assert.equal(link.status, 404);
      assert.ok(!link.body.includes('OUTSIDE'));
      const dot = await raw(port, { path: '/.secret' });
      assert.equal(dot.status, 404);
      assert.ok(!dot.body.includes('nope'));
    }, w.web);
  } finally {
    w.cleanup();
  }
});

test('no directory listing: a folder answers with its index.html or 404', async () => {
  const w = makeWebRoot();
  try {
    await withServer(async ({ port }) => {
      for (const path of ['/js', '/js/', '/empty/', '/css']) assert.equal((await raw(port, { path })).status, 404, path);
      assert.equal((await raw(port, { path: '/' })).status, 200);
    }, w.web);
  } finally {
    w.cleanup();
  }
});

test('GET and HEAD only: HEAD has the headers and no body, other methods get 405 with Allow', async () => {
  await withServer(async ({ port }) => {
    const head = await raw(port, { method: 'HEAD', path: '/js/main.js' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.ok(Number(head.headers['content-length']) > 100);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await raw(port, { method, path: '/' });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
    assert.equal((await raw(port, { path: '/does-not-exist.js' })).status, 404);
  });
});

test('DNS rebinding guard: a foreign Host header is refused, localhost, 127.0.0.1 and [::1] are accepted', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await raw(port, { path: '/', headers: { Host: 'evil.example.com' } })).status, 403);
    assert.equal((await raw(port, { path: '/', headers: { Host: `evil.example.com:${port}` } })).status, 403);
    assert.equal((await raw(port, { path: '/', headers: { Host: `localhost:${port + 1}` } })).status, 403, 'wrong port');
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost']) assert.equal((await raw(port, { path: '/', headers: { Host: host } })).status, 200, host);
  });
});

test('the server listens on the loopback interface only', async () => {
  await withServer(async ({ server }) => {
    assert.equal(server.address().address, '127.0.0.1');
  });
});

test('resolveRequestPath: unit checks of the traversal filter', () => {
  const root = '/srv/web';
  assert.equal(resolveRequestPath('/js/a.js', root).file, '/srv/web/js/a.js');
  assert.equal(resolveRequestPath('/', root).file, '/srv/web');
  assert.equal(resolveRequestPath('/a/../b.js', root).file, '/srv/web/b.js', 'the URL parser normalises .. before we see it');
  assert.equal(resolveRequestPath('/%2e%2e/etc/passwd', root).file, '/srv/web/etc/passwd', 'so it cannot escape');
  assert.equal(resolveRequestPath('/js/%2e%2e%2f..%2fx', root).ok, false);
  assert.equal(resolveRequestPath('/x%00y', root).status, 400);
  assert.equal(resolveRequestPath('/x%zz', root).status, 400);
  assert.equal(resolveRequestPath('/a\\b', root).status, 400);
  assert.equal(resolveRequestPath('/.git/config', root).status, 404);
});

// --------------------------------------------------------------------------------------------------- the CLI (port handling)

function runServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_JS], { env: { ...process.env, PORT: String(port), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '', code: null };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((res) => child.on('exit', (code, signal) => { out.code = code; out.signal = signal; res(out); }));
  return { child, out, exited };
}

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function waitFor(pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('CLI: starts on PORT, prints the URL, stops cleanly on SIGTERM with exit code 0', async () => {
  const port = await freePort();
  const s = runServer(port);
  assert.ok(await waitFor(() => probeHealth(port)), `server did not start: ${s.out.stderr}`);
  assert.match(s.out.stdout, new RegExp(`http://localhost:${port}`));
  s.child.kill('SIGTERM');
  const out = await s.exited;
  assert.equal(out.code, 0);
});

test('CLI: when a Clay Rush server already runs on the port it says so and exits 0; when something else holds the port it exits 1 with a clear message', async () => {
  const port = await freePort();
  const first = runServer(port);
  assert.ok(await waitFor(() => probeHealth(port)));
  const second = runServer(port);
  const out2 = await second.exited;
  assert.equal(out2.code, 0);
  assert.match(out2.stdout, /already running/);
  first.child.kill('SIGTERM');
  await first.exited;

  const port2 = await freePort();
  const blocker = http.createServer((req, res) => { res.end('not us'); });
  await new Promise((r) => blocker.listen(port2, '127.0.0.1', r));
  try {
    const third = runServer(port2);
    const out3 = await third.exited;
    assert.equal(out3.code, 1);
    assert.match(out3.stderr, /used by another program/);
    assert.match(out3.stderr, /PORT=/);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('CLI: an invalid PORT exits 1 with a message', async () => {
  const s = runServer('abc');
  const out = await s.exited;
  assert.equal(out.code, 1);
  assert.match(out.stderr, /Invalid PORT/);
});

test('n11: after start the server object has an error handler, so a socket-level error cannot kill the process', async () => {
  const s = await startServer({ port: 0, quiet: true });
  try {
    assert.ok(s.server.listenerCount('error') >= 1, 'an error listener is attached after listen');
    assert.doesNotThrow(() => s.server.emit('error', new Error('simulated socket error')));
    const res = await fetch(`${s.url}/`);
    assert.equal(res.status, 200, 'the server still answers');
  } finally {
    await s.close();
  }
});
