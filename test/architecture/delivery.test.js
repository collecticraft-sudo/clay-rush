// Delivery checks (integrator): the entry page, the launcher and the native Bluetooth bridge decision (docs/architecture.md 9.2, 9.6, 5.11; docs/native-bridge.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInputProvider } from '../../public/js/input/index.js';
import { createManualClock } from '../../public/js/shared/clock.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('index.html: one canvas, one module script, one stylesheet, no inline script, no external URL, English page language', () => {
  const html = read('public/index.html');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Clay Rush<\/title>/, 'the player-visible name is Clay Rush');
  assert.match(html, /<canvas id="stage"[^>]*aria-label="Clay Rush"/, 'the canvas is announced by the new name');
  assert.equal((html.match(/<canvas\b/g) ?? []).length, 1);
  assert.match(html, /<canvas id="stage"/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'exactly one script element');
  assert.match(scripts[0][1], /type="module"/);
  assert.match(scripts[0][1], /src="js\/main\.js"/);
  assert.equal(scripts[0][2].trim(), '', 'no inline script');
  assert.match(html, /<link rel="stylesheet" href="css\/game\.css">/);
  assert.equal((html.match(/rel="stylesheet"/g) ?? []).length, 1, 'one stylesheet');
  for (const m of html.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g)) {
    assert.ok(existsSync(join(ROOT, 'public', m[1])), `the preloaded font ${m[1]} exists`);
  }
  assert.match(html, /<noscript>[^<]*JavaScript[^<]*<\/noscript>/, 'the noscript note is English');
  assert.match(html, /<noscript>Clay Rush needs JavaScript\./, 'the noscript note names the game');
  assert.doesNotMatch(html, /https?:\/\//, 'no external URL anywhere in the entry page');
});

test('package.json: start runs the server, test runs node --test, module type, zero dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.start, 'node server.js');
  assert.match(pkg.scripts.test, /^node --test /);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('package.json: every test script has a per-test timeout, so a stuck test fails instead of hanging the run forever (M3)', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['test', 'test:unit', 'test:e2e']) {
    assert.match(pkg.scripts[name], /^node --test --test-timeout=\d{5,7} /, `${name} has --test-timeout`);
  }
});

test('start.command: cleans up by job table (no pid variable race) and keeps the display awake with caffeinate tied to its own pid (M2, M3)', () => {
  const src = read('start.command').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(src, /kill \$\(jobs -p\)/);
  assert.doesNotMatch(src, /SLEEP_PID/, 'the pid variable of the idle sleep is gone');
  assert.match(src, /caffeinate -di -w "\$\$"/);
  assert.match(src, /JOYCON_NO_CAFFEINATE/);
  assert.doesNotMatch(src, /caffeinate[^\n]* -s\b/, 'no -s: it would need AC power and change behaviour on battery');
});

test('start.command: executable bash script that starts the server, opens Chrome and never uses sudo', () => {
  const p = join(ROOT, 'start.command');
  assert.ok(existsSync(p));
  assert.ok((statSync(p).mode & 0o111) !== 0, 'the executable bit is set (double-clickable in Finder)');
  const raw = read('start.command');
  assert.match(raw.split('\n')[0], /^#!\/bin\/bash/);
  const src = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'); // code only: the header comment says "never uses sudo"
  assert.match(src, /cd "\$\(dirname "\$0"\)"/);
  assert.match(src, /brew install node/);
  assert.match(src, /node server\.js/);
  assert.match(src, /open -a "Google Chrome"/);
  assert.match(src, /__health/);
  assert.match(src, /trap /);
  assert.doesNotMatch(src, /\bsudo\b/);
  assert.doesNotMatch(src, /defaults write|systemsetup|networksetup|spctl|csrutil/, 'no system settings are touched');
});

test('the native Bluetooth bridge IS built (it replaced the "plan B is not built" decision): bridge/ holds the helper, its plist, the build script and the manager; server.js has the /__bridge/ endpoints', () => {
  for (const f of ['joycon-bridge.m', 'Info.plist', 'build.sh', 'manager.js']) assert.ok(existsSync(join(ROOT, 'bridge', f)), `bridge/${f}`);
  const code = read('server.js').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const route of ['/__bridge/status', '/__bridge/events', '/__bridge/connect', '/__bridge/disconnect', '/__bridge/rumble']) assert.ok(code.includes(route), route);
  assert.match(code, /text\/event-stream/);
});

test('createInputProvider: "native" makes the bridge provider; the old reserved name "bridge" is an unknown kind and throws a TypeError, it no longer says "plan B not built"', () => {
  const clock = createManualClock(0);
  const native = createInputProvider('native', { clock });
  assert.equal(native.transport, 'native');
  native.dispose();
  assert.throws(() => createInputProvider('bridge', { clock }), (e) => e instanceof TypeError && !/plan B/.test(e.message) && /unknown provider kind "bridge"/.test(e.message));
});

test('no document or comment of the project still says the native bridge "is not built" or that its name is reserved (the decision was reversed on 2026-09-30; dated history may say "was")', () => {
  // present-tense claims only: "plan B is not built", "plan B not built", the old tree line "NOT CREATED", "reserved for plan B", "`bridge` is reserved", "name reserved"
  const STALE = /(plan B[^.\n]{0,80}\b(?:is|are) (?:NOT|not) (?:built|implemented)|plan B not built|NOT CREATED|reserved for plan B|`bridge` (?:is a |is )?reserved|name reserved)/g;
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (/^(node_modules|\.git|img|qa|build)$/.test(e.name)) continue;
        walk(rel);
      } else if (/\.(js|mjs|md|html|sh|command)$/.test(e.name) && !/^(code-review|qa-report)-round/.test(e.name)) {
        if (rel === 'test/architecture/delivery.test.js') continue; // this file quotes the old wording to forbid it
        for (const m of read(rel).matchAll(STALE)) offenders.push(`${rel}: "${m[0]}"`);
      }
    }
  };
  for (const d of ['public', 'bridge', 'docs', 'test', 'test-support']) walk(d);
  for (const f of ['README.md', 'server.js', 'start.command']) for (const m of read(f).matchAll(STALE)) offenders.push(`${f}: "${m[0]}"`);
  assert.deepEqual(offenders, []);
});

test('server.js serves the web fonts as font/woff2 (C-10)', () => {
  assert.match(read('server.js'), /'\.woff2': 'font\/woff2'/);
});

test('the fruit-era tools and helpers are gone; the asset build is tools/build-clay-assets.mjs', () => {
  for (const f of ['tools/build-assets.mjs', 'tools/asset-spec.mjs', 'tools/replay-integrated.mjs', 'public/js/ninja-api.js', 'test-support/app/replay-rig.js', 'test-support/app/replay-metrics.js', 'test-support/e2e/replay-browser.mjs', 'test-support/e2e/guide-screens.mjs']) {
    assert.equal(existsSync(join(ROOT, f)), false, f);
  }
  assert.ok(existsSync(join(ROOT, 'tools/build-clay-assets.mjs')));
  assert.equal(JSON.parse(read('package.json')).scripts['build:assets'], 'node tools/build-clay-assets.mjs');
});

test('server.js uses Node built-ins only', () => {
  const src = read('server.js');
  const specs = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), []);
});
