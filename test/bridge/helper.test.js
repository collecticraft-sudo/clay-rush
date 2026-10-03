// The REAL native helper (bridge/joycon-bridge.m), compiled with clang, exercised on every path that does NOT touch Bluetooth. This session and
// the test runner have no Bluetooth permission, and macOS kills a process that uses Bluetooth without it, so a `connect` command is never sent
// here: the helper creates its CBCentralManager only on the first `connect`. What these tests prove: it compiles without warnings, `--version` and
// `--selftest` work without Bluetooth, the stdin/stdout protocol loop runs, it exits cleanly on quit, on stdin EOF and on SIGTERM/SIGINT, and
// malformed input never crashes it. Scanning, connecting, the init sequence and the error mapping are UNVERIFIED-ON-HARDWARE for this productised
// file (the probe it derives from was verified by the owner on 2026-09-30).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_SH = join(ROOT, 'bridge', 'build.sh');

const canBuild = platform() === 'darwin' && spawnSync('bash', [BUILD_SH, '--check'], { encoding: 'utf8' }).status === 0;
const skip = canBuild ? false : 'needs macOS with the Command Line Tools (clang)';
const T = { timeout: 60000, skip };

let dir;
let bin;
let buildOutput = '';

before(() => {
  if (!canBuild) return;
  dir = mkdtempSync(join(tmpdir(), 'joycon-bridge-helper-'));
  const r = spawnSync('bash', [BUILD_SH, '--force'], { encoding: 'utf8', env: { ...process.env, JOYCON_BRIDGE_BUILD_DIR: dir } });
  buildOutput = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, `build.sh failed:\n${buildOutput}`);
  bin = join(dir, 'joycon-bridge');
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Start the helper with pipes; resolves helpers to read lines and to wait for the exit. */
function run(args = []) {
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  const waitLines = async (n, ms = 4000) => {
    const t0 = Date.now();
    while (lines.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    return lines.length >= n;
  };
  const withTimeout = (p, ms = 4000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`the helper did not exit within ${ms} ms`)), ms))]);
  return { child, lines, exited, waitLines, withTimeout, stderr: () => stderr, send: (line) => child.stdin.write(`${line}\n`) };
}

test('the helper compiles with clang without a single warning (-Wall -Wextra, Objective-C, ARC)', T, () => {
  assert.doesNotMatch(buildOutput, /warning:/i, buildOutput);
  assert.doesNotMatch(buildOutput, /error:/i);
  const st = statSync(bin);
  assert.ok(st.isFile() && (st.mode & 0o111) !== 0, 'an executable was produced');
});

test('the binary embeds Info.plist with the Bluetooth usage description and the bundle id local.joyconninja.bridge, and links CoreBluetooth', T, () => {
  const bytes = readFileSync(bin).toString('latin1');
  assert.ok(bytes.includes('NSBluetoothAlwaysUsageDescription'));
  assert.ok(bytes.includes('local.joyconninja.bridge'));
  const otool = spawnSync('otool', ['-L', bin], { encoding: 'utf8' });
  if (otool.status === 0) assert.match(otool.stdout, /CoreBluetooth\.framework/);
});

test('--version prints exactly the hello line and exits 0 (no Bluetooth touched)', T, () => {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{"type":"hello","version":1}\n');
});

test('--selftest prints the hello line, then a passing self-test of the pure parts, and exits 0', T, () => {
  const r = spawnSync(bin, ['--selftest'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { type: 'hello', version: 1 });
  assert.equal(lines[1].type, 'selftest');
  assert.equal(lines[1].ok, true);
  assert.equal(lines[1].failures, 0);
  assert.ok(lines[1].checks >= 40, `${lines[1].checks} checks (the advert choice of 2026-09-30 adds fourteen)`);
  assert.equal(r.stderr, '');
});

test('an unknown command line argument is refused with exit code 2 and a usage line on stderr', T, () => {
  const r = spawnSync(bin, ['--connect-now'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: joycon-bridge/);
  assert.equal(r.stdout, '');
});

test('served mode: hello, then status idle; quit ends it with exit code 0', T, async () => {
  const h = run();
  assert.ok(await h.waitLines(2));
  assert.deepEqual(JSON.parse(h.lines[0]), { type: 'hello', version: 1 });
  assert.deepEqual(JSON.parse(h.lines[1]), { type: 'status', state: 'idle' });
  h.send('{"cmd":"quit"}');
  assert.deepEqual(await h.withTimeout(h.exited), { code: 0, signal: null });
  assert.equal(h.stderr(), '');
});

test('stdin EOF (the server died) ends the helper cleanly with exit code 0', T, async () => {
  const h = run();
  assert.ok(await h.waitLines(2));
  h.child.stdin.end();
  assert.deepEqual(await h.withTimeout(h.exited), { code: 0, signal: null });
});

test('SIGTERM and SIGINT end the helper cleanly with exit code 0', T, async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const h = run();
    assert.ok(await h.waitLines(2));
    h.child.kill(signal);
    assert.deepEqual(await h.withTimeout(h.exited), { code: 0, signal: null }, signal);
  }
});

test('malformed input never crashes it: bad JSON, a non-object, a missing or unknown command, a huge line all get a warning (or are dropped) and it keeps serving', T, async () => {
  const h = run();
  assert.ok(await h.waitLines(2));
  h.send('this is not json');
  h.send('[1,2,3]');
  h.send('{"x":1}');
  h.send('{"cmd":"nope"}');
  h.send('{"cmd":42}');
  h.send('x'.repeat(40000)); // longer than any command
  h.send('{"cmd":"rumble","id":3}'); // not streaming: ignored, silently
  h.send('{"cmd":"disconnect"}'); // nothing to disconnect: silent
  assert.ok(await h.waitLines(2 + 5));
  await new Promise((r) => setTimeout(r, 150));
  const warnings = h.lines.slice(2).map((l) => JSON.parse(l));
  assert.equal(warnings.length, 5, `exactly the five bad commands warn: ${h.lines.slice(2).join(' | ')}`);
  for (const w of warnings) {
    assert.equal(w.type, 'status');
    assert.equal(w.state, 'idle');
    assert.match(w.warning, /^(bad_command|unknown_command)$/);
    assert.doesNotMatch(w.message, /this is not json|nope/, 'the offending input is never echoed back');
  }
  assert.equal(h.child.exitCode, null, 'still running');
  h.send('{"cmd":"quit"}');
  assert.deepEqual(await h.withTimeout(h.exited), { code: 0, signal: null });
});

test('the helper prints nothing but protocol lines: every stdout line is one JSON object of a known type', T, async () => {
  const h = run();
  assert.ok(await h.waitLines(2));
  h.send('garbage');
  h.send('{"cmd":"quit"}');
  await h.withTimeout(h.exited);
  for (const line of h.lines) {
    const o = JSON.parse(line);
    assert.ok(['hello', 'status', 'advert', 'report', 'response'].includes(o.type), line);
  }
});

test('the source keeps the hard rules: one connection attempt, no retry loop, only the command characteristic is written, no other device is printed', { timeout: 60000 }, () => {
  const src = readFileSync(join(ROOT, 'bridge', 'joycon-bridge.m'), 'utf8');
  assert.equal((src.match(/\bconnectPeripheral:/g) ?? []).length, 1, 'exactly one call site of connectPeripheral: (one attempt per connect command)');
  assert.equal((src.match(/writeValue:/g) ?? []).length, 1, 'exactly one write call site');
  assert.match(src, /writeValue:frame forCharacteristic:self\.cmdChar type:CBCharacteristicWriteWithoutResponse/);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /4147423d|ab7de9be-89fe-49ad-828f-118f09df7fdf/i, 'the firmware-update channel and the look-alike characteristic are never named in code');
  assert.doesNotMatch(code, /\bNSLog\b/, 'no NSLog: nothing is ever logged about other devices');
  // the central manager is created in exactly one place: the connect path (never at start-up, never for --version or --selftest)
  assert.equal((src.match(/alloc\] initWithDelegate/g) ?? []).length, 1);
  const main = src.slice(src.indexOf('int main('));
  assert.ok(main.indexOf('initWithDelegate') < 0, 'main() never creates the manager');
  assert.match(src, /usage: joycon-bridge/);
});

test('the connect preference of 2026-09-30: pairing-mode adverts are preferred, every other matching advert is a fallback, pairingOnly:true is an explicit option', { timeout: 60000 }, () => {
  const src = readFileSync(join(ROOT, 'bridge', 'joycon-bridge.m'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /_pairingOnly = NO;/, 'the default lets a bonded-host advert qualify');
  assert.match(code, /\[pairingOnly boolValue\] : NO;/, 'an absent pairingOnly means the preference, not the strict rule');
  assert.doesNotMatch(code, /_pairingOnly = YES|boolValue\] : YES/, 'nothing still defaults to the strict rule');
  assert.match(code, /BridgeAdvertQualifies\(a\.pairing, self\.pairingOnly\)/, 'the runtime uses the same pure function as the self-test');
  assert.match(code, /BridgeAdvertVisible\(&a, self\.wantSide, rssi\)/);
  assert.match(code, /NSInteger best = BridgeBestCandidate\(infos, all\.count\)/, 'pairing-mode first, then the strongest, in the one pure function');
  // the self-test names the cases of the decision
  for (const what of ['a lone bonded-host advert is connected to anyway', 'pairingOnly: a lone bonded-host advert is never chosen', 'the pairing-mode advert wins although the bonded one is stronger', 'with no pairing-mode advert the strongest bonded one wins']) {
    assert.ok(src.includes(what), `selftest case "${what}"`);
  }
});
