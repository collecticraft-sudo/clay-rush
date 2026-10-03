// Delivery checks of the native bridge: the files, the property list, package.json, the launcher, the document and the labels of the
// two real captures. This file encodes the decision "the native bridge IS built" (docs/native-bridge.md); stage B replaced the older guard of
// test/architecture/delivery.test.js that contradicted it (docs/native-bridge.md section 10, item 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeHealth } from '../../server.js';
import { NATIVE_ERRORS, NATIVE_PROGRESS_KEYS, NATIVE_STRING_KEYS } from '../../public/js/input/native-provider.js';
import { vector, VECTORS } from '../../test-support/input/vectors.js';
import { parseInputReport } from '../../public/js/input/joycon2-parse.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const codeOnly = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('bridge/ holds the helper source, its Info.plist, an executable build script, the manager and a .gitignore for the build folder', () => {
  for (const f of ['joycon-bridge.m', 'Info.plist', 'build.sh', 'manager.js', '.gitignore']) assert.ok(existsSync(join(ROOT, 'bridge', f)), `bridge/${f}`);
  assert.ok((statSync(join(ROOT, 'bridge', 'build.sh')).mode & 0o111) !== 0, 'build.sh is executable');
  assert.match(read('bridge/build.sh').split('\n')[0], /^#!\/bin\/bash/);
  assert.match(read('bridge/.gitignore'), /^build\/$/m);
});

test('Info.plist names the bundle local.joyconninja.bridge and explains the Bluetooth use', () => {
  const plist = read('bridge/Info.plist');
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>local\.joyconninja\.bridge<\/string>/);
  const usage = plist.match(/<key>NSBluetoothAlwaysUsageDescription<\/key>\s*<string>([^<]+)<\/string>/);
  assert.ok(usage && usage[1].length > 40, 'a real usage description, as macOS shows it in the permission prompt');
});

test('package.json: build:bridge runs the build script, test:unit includes test/bridge, the project rules still hold', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:bridge'], 'bash bridge/build.sh');
  assert.match(pkg.scripts['test:unit'], /\bbridge\b/);
  assert.match(pkg.scripts.test, /^node --test --test-timeout=\d{5,7} /);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('start.command runs bridge/build.sh before the server, never as a fatal step, never with sudo, and tells the player about the Terminal permission', () => {
  const src = codeOnly(read('start.command'));
  const build = src.indexOf('bash bridge/build.sh');
  assert.ok(build > 0, 'it builds the bridge');
  assert.ok(build < src.indexOf('node server.js'), 'before the server starts');
  assert.match(src, /if bash bridge\/build\.sh; then[\s\S]*?else[\s\S]*?fi/, 'the build is an if: a failure only prints a note');
  const block = src.slice(src.indexOf('if [ -z "${JOYCON_NO_BRIDGE'), src.indexOf('is_up() {'));
  assert.ok(block.includes('bash bridge/build.sh'));
  assert.doesNotMatch(block, /\bexit\b|pause_and_exit/, 'the bridge block can never end the launcher');
  assert.match(src, /JOYCON_NO_BRIDGE/);
  assert.match(src, /Terminal may use Bluetooth/);
  assert.doesNotMatch(src, /\bsudo\b/);
});

test('start.command keeps going when the bridge cannot be built (no compiler): it prints the note and still starts the server', { timeout: 60000, skip: platform() === 'darwin' ? false : 'macOS only' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joycon-bridge-launch-'));
  writeFileSync(join(dir, 'open'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(dir, 'open'), 0o755);
  const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn('/bin/bash', [join(ROOT, 'start.command')], {
    env: { ...process.env, PORT: String(port), PATH: `${dir}:${process.env.PATH}`, JOYCON_NO_CAFFEINATE: '1', JOYCON_BRIDGE_CLANG: join(dir, 'no-such-clang') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((res) => child.on('exit', (code) => { child.stdout.destroy(); child.stderr.destroy(); res(code); }));
  try {
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 15000 && !up) {
      up = await probeHealth(port);
      if (!up) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(up, `the server did not start: ${out}`);
    assert.match(out, /clang was not found/);
    assert.match(out, /xcode-select --install/);
    assert.match(out, /NOTE: the native Bluetooth bridge is not available/);
    assert.match(out, /Press Ctrl\+C/);
    child.kill('SIGINT');
    assert.equal(await exited, 0);
    assert.ok(!(await probeHealth(port)), 'the server it started is gone');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server.js: the endpoints are there, the security rules are in the code, only the manager is imported lazily, and Node built-ins are the only static imports', () => {
  const src = read('server.js');
  for (const route of ['/__bridge/status', '/__bridge/events', '/__bridge/connect', '/__bridge/disconnect', '/__bridge/rumble']) assert.ok(src.includes(route), route);
  assert.match(src, /X-Joycon-Ninja/);
  assert.match(src, /sec-fetch-site/);
  assert.match(src, /import\('\.\/bridge\/manager\.js'\)/, 'the manager is loaded lazily');
  const staticSpecs = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(staticSpecs.filter((s) => !s.startsWith('node:')), [], 'the static imports are Node built-ins only');
  const manager = read('bridge/manager.js');
  assert.deepEqual([...manager.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).filter((s) => !s.startsWith('node:')), []);
  assert.doesNotMatch(manager.replace(/\/\/.*$/gm, ''), /shell:\s*true|\bexec\(/, 'no shell: spawn and execFile with argument arrays only');
});

test('docs/native-bridge.md lists every new string key of the provider with its text, and has the sections the brief asks for', () => {
  const doc = read('docs/native-bridge.md');
  const rows = new Map();
  for (const line of doc.split('\n')) {
    const m = line.match(/^\| `([^`]+)` \| (.+) \|$/);
    if (m) rows.set(m[1], m[2]);
  }
  for (const key of NATIVE_STRING_KEYS) {
    assert.ok(rows.has(key), `${key} is missing from the table of docs/native-bridge.md`);
    assert.ok(rows.get(key).length > 15, `${key} needs a text`);
    assert.match(rows.get(key), /[a-z]{3,}/i);
  }
  for (const key of ['connect.native.button', 'connect.native.hint', 'connect.native.secondary']) assert.ok(rows.has(key), key);
  assert.equal(rows.get('connect.native.button'), 'Connect Joy-Con (native bridge)');
  for (const heading of ['## 2. Architecture', '## 3. Protocols', '## 5. Security model', '## 6. macOS Bluetooth permission', '## 9. New string keys', '## 10. Stage B: the work list', '## 11. UNVERIFIED-ON-HARDWARE']) {
    assert.ok(doc.includes(heading), heading);
  }
  assert.match(doc, /Terminal/);
  assert.match(doc, /exit code 134/);
  assert.match(doc, /Connect Joy-Con \(native bridge\)/);
  // every error and progress key the provider can produce is covered by the two tables
  for (const m of Object.values(NATIVE_ERRORS)) assert.ok(rows.has(m.key), m.key);
  for (const key of Object.values(NATIVE_PROGRESS_KEYS)) assert.ok(rows.has(key), key);
  // the stage B list names the files of the brief
  for (const item of ['strings.en.js', 'flags.js', 'diagnostics', 'README.md', 'docs/GUIDE.md', 'delivery.test.js', 'joycon2-protocol.md']) assert.ok(doc.includes(item), item);
});

test('the real captures REAL_R_1 and REAL_R_2 are in the shared vectors with honest labels (real capture, Right, no claim about the gyro scale)', () => {
  assert.equal(VECTORS.vectors.filter((v) => v.id.startsWith('REAL_R_')).length, 2);
  for (const id of ['REAL_R_1', 'REAL_R_2']) {
    const v = vector(id);
    assert.equal(v.side, 'R');
    assert.equal(v.bytes.length, 63);
    assert.match(v.description, /^Real capture, Right Joy-Con 2/);
    assert.match(v.provenance, /2026-09-30/);
    assert.match(v.provenance, /native CoreBluetooth probe/);
    assert.doesNotMatch(v.description, /synthetic/i);
    assert.match(v.description, /gyro scale/, 'the label says what the capture does NOT prove about the gyro');
    assert.doesNotMatch(v.description, /gyro scale (is|was|=|of) \d|confirms? the gyro/i);
  }
  const r1 = parseInputReport(vector('REAL_R_1').bytes, 'R');
  const r2 = parseInputReport(vector('REAL_R_2').bytes, 'R');
  assert.equal(r1.imuActive, false);
  assert.equal(r1.imuMarker, 1);
  assert.equal(r2.imuActive, true);
  assert.equal(r2.imuTimestampUs, 764777);
  assert.deepEqual(r2.accelRaw, { x: -607, y: -698, z: 3964 });
  assert.deepEqual(r2.gyroRaw, { x: 0, y: 16, z: -12 });
  assert.ok(Math.abs(Math.hypot(r2.accelG.x, r2.accelG.y, r2.accelG.z) - 0.99) < 0.01);
  // the exact hex of the brief (the owner's captures of 2026-09-30)
  const BRIEF_R1 = 'af 14 00 00 00 00 00 e0 ff 0f ff f7 7f bf 37 80 00 00 00 00 ff 11 11 0c 00 55 ff 72 fe ed fe 6b 0d 00 cd 07 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00';
  const BRIEF_R2 = 'cd 14 00 00 00 00 00 e0 ff 0f ff f7 7f bf 27 80 00 00 00 00 ff 11 11 0c 00 55 ff 71 fe ee fe 6b 0d 00 cd 07 00 00 00 00 00 01 69 ab 0b 00 01 00 a1 fd 46 fd 7c 0f 00 00 10 00 f4 ff 00 00 00';
  assert.equal(vector('REAL_R_1').hex, BRIEF_R1.replaceAll(' ', ''));
  assert.equal(vector('REAL_R_2').hex, BRIEF_R2.replaceAll(' ', ''));
});
