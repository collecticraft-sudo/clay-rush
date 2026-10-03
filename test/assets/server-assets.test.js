// server.js and the art (docs/assets-integration.md 1.9, 8.2): MIME types of the image files, the no-cache + weak ETag + 304 rules under /assets/,
// `no-store` everywhere else, HEAD, the CSP that lets same-origin images load and nothing else, and path traversal under /assets/.
// Real HTTP on the loopback interface with port 0; a temporary web root for the edge cases and the real public/ folder for the shipped files.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, MIME, CSP, etagMatches, ASSETS_CACHE_CONTROL, HEALTH_BODY, probeHealth } from '../../server.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSETS = join(ROOT, 'public', 'assets');

function raw(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);

function makeWebRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'fruit-dojo-assets-root-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'assets', 'sprites'), { recursive: true });
  mkdirSync(join(web, 'assets', 'backgrounds'), { recursive: true });
  mkdirSync(join(web, 'js'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(web, 'js', 'a.js'), 'export const a = 1;');
  writeFileSync(join(web, 'assets', 'manifest.json'), '{"version":1,"assets":[]}');
  writeFileSync(join(web, 'assets', 'PROVENANCE.csv'), 'id,file\nx,y\n');
  writeFileSync(join(web, 'assets', 'sprites', 'a.png'), PNG_BYTES);
  writeFileSync(join(web, 'assets', 'backgrounds', 'b.jpg'), JPG_BYTES);
  writeFileSync(join(web, 'assets', 'backgrounds', 'c.jpeg'), JPG_BYTES);
  writeFileSync(join(web, 'assets', '.hidden.png'), PNG_BYTES);
  writeFileSync(join(web, 'assets', 'notes.xyz'), 'zz');
  writeFileSync(join(dir, 'outside.txt'), 'OUTSIDE');
  writeFileSync(join(web, 'secret.txt'), 'SECRET');
  symlinkSync(join(dir, 'outside.txt'), join(web, 'assets', 'link.png'));
  return { dir, web, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withServer(root, fn) {
  const s = await startServer({ port: 0, root, quiet: true });
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const expectSecurity = (r, label) => {
  for (const [k, v] of Object.entries(SECURITY)) assert.equal(r.headers[k], v, `${label}: ${k}`);
};

test('MIME map: .jpg and .jpeg are image/jpeg, .csv is text/csv, .png and .json are unchanged', () => {
  assert.equal(MIME['.jpg'], 'image/jpeg');
  assert.equal(MIME['.jpeg'], 'image/jpeg');
  assert.equal(MIME['.csv'], 'text/csv; charset=utf-8');
  assert.equal(MIME['.png'], 'image/png');
  assert.equal(MIME['.json'], 'application/json; charset=utf-8');
});

test('under /assets/: png, jpg, jpeg, json and csv are served with the right Content-Type, no-cache and a weak ETag of size and mtime', async () => {
  const w = makeWebRoot();
  try {
    await withServer(w.web, async ({ port }) => {
      const expect = {
        '/assets/sprites/a.png': ['image/png', PNG_BYTES],
        '/assets/backgrounds/b.jpg': ['image/jpeg', JPG_BYTES],
        '/assets/backgrounds/c.jpeg': ['image/jpeg', JPG_BYTES],
        '/assets/manifest.json': ['application/json; charset=utf-8', readFileSync(join(w.web, 'assets', 'manifest.json'))],
        '/assets/PROVENANCE.csv': ['text/csv; charset=utf-8', readFileSync(join(w.web, 'assets', 'PROVENANCE.csv'))],
        '/assets/notes.xyz': ['application/octet-stream', Buffer.from('zz')],
      };
      for (const [path, [type, bytes]] of Object.entries(expect)) {
        const r = await raw(port, { path });
        assert.equal(r.status, 200, path);
        assert.equal(r.headers['content-type'], type, path);
        assert.equal(r.headers['content-length'], String(bytes.length), path);
        assert.deepEqual(r.body, bytes, path);
        assert.equal(r.headers['cache-control'], 'no-cache', path);
        const st = statSync(join(w.web, path));
        assert.equal(r.headers.etag, `W/"${st.size}-${st.mtimeMs}"`, `${path}: ETag is W/"<size>-<mtimeMs>"`);
        expectSecurity(r, path);
        assert.equal(r.headers['content-security-policy'], undefined, `${path}: only HTML documents carry a CSP`);
      }
      assert.equal(ASSETS_CACHE_CONTROL, 'no-cache');
    });
  } finally {
    w.cleanup();
  }
});

test('If-None-Match: a matching ETag answers 304 with the same security headers, the ETag and no body; other values answer 200', async () => {
  const w = makeWebRoot();
  try {
    await withServer(w.web, async ({ port }) => {
      const path = '/assets/sprites/a.png';
      const first = await raw(port, { path });
      const etag = first.headers.etag;
      const strong = etag.replace(/^W\//, '');
      for (const header of [etag, strong, `"nope", ${etag}`, `W/"1-2" , ${etag} , W/"3-4"`, '*']) {
        const r = await raw(port, { path, headers: { 'If-None-Match': header } });
        assert.equal(r.status, 304, header);
        assert.equal(r.body.length, 0, `${header}: no body`);
        assert.equal(r.headers.etag, etag, `${header}: ETag repeated`);
        assert.equal(r.headers['cache-control'], 'no-cache');
        assert.equal(r.headers['content-length'], undefined, '304 carries no Content-Length of a body');
        expectSecurity(r, header);
      }
      for (const header of ['W/"1-2"', '"other"', '', 'W/', 'garbage']) {
        const r = await raw(port, { path, headers: { 'If-None-Match': header } });
        assert.equal(r.status, 200, `"${header}" does not match`);
        assert.deepEqual(r.body, PNG_BYTES);
      }
      // a rebuilt file (new mtime) gets a new ETag, so the old one no longer matches
      const later = new Date(Date.now() + 5000);
      utimesSync(join(w.web, 'assets', 'sprites', 'a.png'), later, later);
      const changed = await raw(port, { path, headers: { 'If-None-Match': etag } });
      assert.equal(changed.status, 200, 'the file changed on disk');
      assert.notEqual(changed.headers.etag, etag);
    });
  } finally {
    w.cleanup();
  }
});

test('HEAD behaves like GET without a body: headers and ETag, and 304 for a matching If-None-Match', async () => {
  const w = makeWebRoot();
  try {
    await withServer(w.web, async ({ port }) => {
      const path = '/assets/backgrounds/b.jpg';
      const get = await raw(port, { path });
      const head = await raw(port, { method: 'HEAD', path });
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(head.headers['content-type'], 'image/jpeg');
      assert.equal(head.headers['content-length'], String(JPG_BYTES.length));
      assert.equal(head.headers.etag, get.headers.etag);
      assert.equal(head.headers['cache-control'], 'no-cache');
      expectSecurity(head, 'HEAD');
      const head304 = await raw(port, { method: 'HEAD', path, headers: { 'If-None-Match': get.headers.etag } });
      assert.equal(head304.status, 304);
      assert.equal(head304.body.length, 0);
    });
  } finally {
    w.cleanup();
  }
});

test('every other path keeps Cache-Control: no-store and has no ETag: pages, scripts, health, 404s (also under /assets/), and 405s', async () => {
  const w = makeWebRoot();
  try {
    await withServer(w.web, async ({ port }) => {
      for (const path of ['/', '/index.html', '/js/a.js', '/__health', '/nope.js', '/assets/missing.png', '/assets/', '/assets', '/assets/sprites/', '/secret.txt']) {
        const r = await raw(port, { path });
        assert.equal(r.headers['cache-control'], 'no-store', path);
        assert.equal(r.headers.etag, undefined, path);
        expectSecurity(r, path);
      }
      const post = await raw(port, { method: 'POST', path: '/assets/manifest.json' });
      assert.equal(post.status, 405);
      assert.equal(post.headers['cache-control'], 'no-store');
      assert.equal(post.headers.allow, 'GET, HEAD');
      // a page is never conditional: If-None-Match is ignored outside /assets/
      const index = await raw(port, { path: '/index.html', headers: { 'If-None-Match': '*' } });
      assert.equal(index.status, 200);
    });
  } finally {
    w.cleanup();
  }
});

test('path traversal under /assets/ is refused in every spelling; symlinks out of the root, dot files and folder listings are not served', async () => {
  const w = makeWebRoot();
  try {
    await withServer(w.web, async ({ port }) => {
      const attempts = [
        '/assets/../secret.txt', '/assets/..%2fsecret.txt', '/assets/%2e%2e/secret.txt', '/assets/%2e%2e%2fsecret.txt', '/assets/sprites/../../secret.txt',
        '/assets/sprites/..%2f..%2f..%2foutside.txt', '/assets/..\\secret.txt', '/assets/%5c..%5csecret.txt', '/assets/sprites/%2e%2e/%2e%2e/%2e%2e/outside.txt',
        '/assets/%00', '/assets/sprites/a.png%00.txt', '/assets/....//secret.txt', '//assets/sprites/a.png', '/assets/%252e%252e/secret.txt',
      ];
      for (const path of attempts) {
        const r = await raw(port, { path });
        // the URL parser folds "/assets/../secret.txt" into "/secret.txt", which is inside the root and may be answered; nothing outside may leak
        assert.ok(r.status < 500, `${path} -> ${r.status}`);
        assert.ok(!r.body.toString('latin1').includes('OUTSIDE'), `${path} leaked the file outside the root`);
        if (path.includes('outside')) assert.ok(r.status >= 400, `${path} -> ${r.status}`);
        if (r.status === 200) assert.equal(r.headers['cache-control'], path.includes('/assets/') && r.headers.etag ? 'no-cache' : 'no-store', path);
      }
      const link = await raw(port, { path: '/assets/link.png' });
      assert.equal(link.status, 404, 'a symlink under /assets/ that points outside the root');
      assert.ok(!link.body.toString().includes('OUTSIDE'));
      assert.equal(link.headers['cache-control'], 'no-store');
      assert.equal((await raw(port, { path: '/assets/.hidden.png' })).status, 404, 'dot files are never served');
      for (const path of ['/assets/', '/assets', '/assets/sprites', '/assets/sprites/', '/assets/backgrounds/']) assert.equal((await raw(port, { path })).status, 404, `${path}: no directory listing`);
    });
  } finally {
    w.cleanup();
  }
});

test('a symlink INSIDE the web root that points to a file in /assets/ still gets the assets rules (the real path decides)', async () => {
  const w = makeWebRoot();
  try {
    symlinkSync(join(w.web, 'assets', 'sprites', 'a.png'), join(w.web, 'alias.png'));
    await withServer(w.web, async ({ port }) => {
      const r = await raw(port, { path: '/alias.png' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['cache-control'], 'no-cache');
      assert.ok(r.headers.etag);
    });
  } finally {
    w.cleanup();
  }
});

test('etagMatches: weak comparison, lists, star, and junk', () => {
  const e = 'W/"12-345.5"';
  assert.equal(etagMatches(e, e), true);
  assert.equal(etagMatches('"12-345.5"', e), true, 'weak comparison ignores the W/ prefix');
  assert.equal(etagMatches('"a", W/"12-345.5"', e), true);
  assert.equal(etagMatches('*', e), true);
  assert.equal(etagMatches('"12-345.6"', e), false);
  assert.equal(etagMatches(undefined, e), false);
  assert.equal(etagMatches('', e), false);
  assert.equal(etagMatches(['W/"12-345.5"'], e), false, 'a non-string header value never matches');
});

test('the real public/assets: every shipped file is served with the right type, the exact bytes, no-cache and an ETag; a repeat request is a 304', async () => {
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));
  await withServer(undefined, async ({ port }) => {
    const files = ['manifest.json', 'PROVENANCE.csv', ...manifest.assets.map((a) => a.file)];
    for (const rel of files) {
      const path = `/assets/${rel}`;
      const r = await raw(port, { path });
      const ext = rel.split('.').pop();
      assert.equal(r.status, 200, path);
      assert.equal(r.headers['content-type'], { png: 'image/png', jpg: 'image/jpeg', json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8' }[ext], path);
      assert.deepEqual(r.body, readFileSync(join(ASSETS, rel)), `${path}: exact bytes`);
      assert.equal(r.headers['cache-control'], 'no-cache', path);
      const again = await raw(port, { path, headers: { 'If-None-Match': r.headers.etag } });
      assert.equal(again.status, 304, path);
    }
    assert.equal(files.length, 2 + manifest.assets.length);
    // the three web fonts are served with their exact bytes (their media type is the server's business: see docs/contract-notes.md)
    for (const f of manifest.fonts) {
      const r = await raw(port, { path: `/assets/${f.file}` });
      assert.equal(r.status, 200, f.file);
      assert.deepEqual(r.body, readFileSync(join(ASSETS, f.file)), `${f.file}: exact bytes`);
    }
  });
});

test('CSP: HTML documents may load images from this server (and data: and blob: URLs) and connect only to it; nothing external is opened', async () => {
  await withServer(undefined, async ({ port }) => {
    for (const path of ['/', '/index.html', '/diagnostics.html']) {
      const r = await raw(port, { path });
      const csp = r.headers['content-security-policy'];
      assert.equal(csp, CSP, path);
      const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
      assert.match(directive('img-src'), /^img-src 'self'( data:)?( blob:)?$/, 'images: same origin only, plus data: and blob: for a canvas-derived image');
      assert.equal(directive('connect-src'), "connect-src 'self'", 'the manifest is fetched from this server');
      assert.equal(directive('default-src'), "default-src 'self'");
      assert.equal(directive('script-src'), "script-src 'self'");
      assert.equal(directive('object-src'), "object-src 'none'");
      assert.doesNotMatch(csp, /https?:|\*|unsafe-eval/, 'no external host, no wildcard, no eval');
      assert.doesNotMatch(directive('script-src'), /unsafe-inline/);
    }
  });
});

// ------------------------------------------------------------------------------------------------ console text and the unchanged health contract

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

function runServer(port) {
  const child = spawn(process.execPath, [join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '', code: null };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((res) => child.on('exit', (code) => { out.code = code; res(out); }));
  return { child, out, exited };
}

async function waitFor(pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('the console says "Clay Rush" (start and "already running"), and /__health answers {"ok":true,"name":"clay-shooter"} for start.command and the tests', async () => {
  const port = await freePort();
  const first = runServer(port);
  try {
    assert.ok(await waitFor(() => probeHealth(port)), `server did not start: ${first.out.stderr}`);
    assert.match(first.out.stdout, new RegExp(`Clay Rush is running at http://localhost:${port}`));
    assert.doesNotMatch(first.out.stdout, /Joy-Con Ninja/);
    const health = await raw(port, { path: '/__health' });
    assert.equal(health.body.toString(), HEALTH_BODY);
    assert.deepEqual(JSON.parse(health.body.toString()), { ok: true, name: 'clay-shooter' });
    const second = runServer(port);
    const out2 = await second.exited;
    assert.equal(out2.code, 0);
    assert.match(out2.stdout, new RegExp(`Clay Rush is already running at http://localhost:${port}`));
  } finally {
    first.child.kill('SIGTERM');
    await first.exited;
  }
});
