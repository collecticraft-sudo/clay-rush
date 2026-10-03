// bridge/build.sh: idempotent, rebuilds only when a source is newer, clear English errors, never leaves a half-written or broken helper behind.
// The script is run from a COPY of the bridge folder (the repository's own bridge/build is never touched) and, for the error paths, with a
// fake compiler through JOYCON_BRIDGE_CLANG, so these tests do not depend on the Command Line Tools being installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = { timeout: 60000, skip: platform() === 'darwin' ? false : 'build.sh only runs on macOS' };

/** A private copy of bridge/ (script, source, plist), a build dir, and a log file for the compiler's arguments. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'joycon-bridge-build-'));
  const bridge = join(dir, 'bridge');
  mkdirSync(bridge);
  for (const f of ['build.sh', 'joycon-bridge.m', 'Info.plist']) copyFileSync(join(ROOT, 'bridge', f), join(bridge, f));
  chmodSync(join(bridge, 'build.sh'), 0o755);
  const out = join(dir, 'out');
  const argsLog = join(dir, 'clang-args.log');
  const fakeClang = (body) => {
    const file = join(dir, 'fake-clang');
    writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsLog}"\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  // a "compiler" that writes a helper answering --selftest like the real one
  const findOut = 'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then OUT="$2"; fi; shift; done';
  const goodBody = `${findOut}
cat > "$OUT" <<'SH'
#!/bin/bash
echo '{"type":"hello","version":1}'
if [ "$1" = "--selftest" ]; then echo '{"type":"selftest","ok":true,"checks":1,"failures":0}'; fi
SH`;
  const badBody = `${findOut}
cat > "$OUT" <<'SH'
#!/bin/bash
echo broken >&2
exit 1
SH`;
  const run = (args = [], env = {}) => spawnSync('bash', [join(bridge, 'build.sh'), ...args], {
    encoding: 'utf8', env: { ...process.env, JOYCON_BRIDGE_BUILD_DIR: out, ...env }, timeout: 60000,
  });
  return {
    dir, bridge, out, argsLog, fakeClang, goodBody, badBody, run,
    bin: join(out, 'joycon-bridge'),
    leftovers: () => (existsSync(out) ? readdirSync(out).filter((f) => f !== 'joycon-bridge') : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('build.sh with the real compiler: builds once, is a no-op the second time, rebuilds when the source is newer, --force always rebuilds', T, () => {
  const check = spawnSync('bash', [join(ROOT, 'bridge', 'build.sh'), '--check'], { encoding: 'utf8' });
  if (check.status !== 0) return; // no Command Line Tools on this machine: the fake-compiler tests below still run
  const w = workspace();
  try {
    let r = w.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /built /);
    assert.doesNotMatch(r.stdout + r.stderr, /warning:/i);
    const first = statSync(w.bin).mtimeMs;
    assert.deepEqual(w.leftovers(), [], 'no temporary files are left in the build folder');

    r = w.run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /up to date/);
    assert.equal(statSync(w.bin).mtimeMs, first, 'the binary was not touched');

    const later = new Date(Date.now() + 5000);
    utimesSync(join(w.bridge, 'joycon-bridge.m'), later, later);
    r = w.run();
    assert.match(r.stdout, /compiling/, 'a newer source triggers a rebuild');
    assert.ok(statSync(w.bin).mtimeMs > first);

    const second = statSync(w.bin).mtimeMs;
    utimesSync(join(w.bridge, 'Info.plist'), new Date(Date.now() + 10000), new Date(Date.now() + 10000));
    assert.match(w.run().stdout, /compiling/, 'a newer Info.plist triggers a rebuild too');
    assert.ok(statSync(w.bin).mtimeMs >= second);

    r = w.run(['--force']);
    assert.match(r.stdout, /compiling/);
    // and the result is a working helper
    const v = spawnSync(w.bin, ['--version'], { encoding: 'utf8' });
    assert.equal(v.stdout, '{"type":"hello","version":1}\n');
  } finally {
    w.cleanup();
  }
});

test('build.sh passes the documented compiler flags: ARC, -O2, warnings on, Foundation and CoreBluetooth, the embedded Info.plist, the source and a private output', T, () => {
  const w = workspace();
  try {
    const r = w.run([], { JOYCON_BRIDGE_CLANG: w.fakeClang(w.goodBody) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const args = readFileSync(w.argsLog, 'utf8').trim().split('\n');
    for (const flag of ['-fobjc-arc', '-O2', '-Wall', '-Wextra']) assert.ok(args.includes(flag), flag);
    assert.ok(args.join(' ').includes('-framework Foundation -framework CoreBluetooth'));
    const i = args.indexOf('-sectcreate');
    assert.deepEqual(args.slice(i, i + 4), ['-sectcreate', '__TEXT', '__info_plist', join(w.bridge, 'Info.plist')]);
    assert.ok(args.includes(join(w.bridge, 'joycon-bridge.m')));
    const o = args[args.indexOf('-o') + 1];
    assert.notEqual(o, w.bin, 'the compiler writes to a private temporary file, then the script moves it into place');
    assert.ok(existsSync(w.bin) && (statSync(w.bin).mode & 0o111) !== 0);
    assert.deepEqual(w.leftovers(), []);
  } finally {
    w.cleanup();
  }
});

test('build.sh without a compiler: exit 1, a clear English message with `xcode-select --install`, the game-still-works hint, and no binary', T, () => {
  const w = workspace();
  try {
    const r = w.run([], { JOYCON_BRIDGE_CLANG: join(w.dir, 'no-such-clang') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /clang was not found/);
    assert.match(r.stderr, /xcode-select --install/);
    assert.match(r.stderr, /mouse and the simulator/);
    assert.ok(!existsSync(w.bin));
    const c = w.run(['--check'], { JOYCON_BRIDGE_CLANG: join(w.dir, 'no-such-clang') });
    assert.equal(c.status, 1);
    assert.match(c.stdout, /^cannot-build: clang was not found/);
    const ok = w.run(['--check'], { JOYCON_BRIDGE_CLANG: w.fakeClang('exit 0') });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), 'can-build');
    assert.ok(!existsSync(w.bin), '--check builds nothing');
  } finally {
    w.cleanup();
  }
});

test('build.sh with a failing compiler: exit 2, the compiler output is shown, no binary and no temporary file is left', T, () => {
  const w = workspace();
  try {
    const r = w.run([], { JOYCON_BRIDGE_CLANG: w.fakeClang('echo "joycon-bridge.m:12:3: error: use of undeclared identifier FOO" >&2\nexit 1') });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the compiler failed/);
    assert.match(r.stderr, /undeclared identifier FOO/);
    assert.match(r.stderr, /mouse and the simulator/);
    assert.ok(!existsSync(w.bin));
    assert.deepEqual(w.leftovers(), []);
  } finally {
    w.cleanup();
  }
});

test('build.sh with a compiler whose output fails --selftest: exit 3, the broken helper is never put in place; a previous good one survives', T, () => {
  const w = workspace();
  try {
    // first a good build
    assert.equal(w.run([], { JOYCON_BRIDGE_CLANG: w.fakeClang(w.goodBody) }).status, 0);
    const good = readFileSync(w.bin, 'utf8');
    // then a build whose binary cannot pass its own selftest
    const r = w.run(['--force'], { JOYCON_BRIDGE_CLANG: w.fakeClang(w.badBody) });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /failed its --selftest/);
    assert.equal(readFileSync(w.bin, 'utf8'), good, 'the previous helper is untouched');
    assert.deepEqual(w.leftovers(), []);
  } finally {
    w.cleanup();
  }
});

test('build.sh: warnings of the compiler are shown but do not stop the build; an unknown argument is refused; the script never uses sudo or changes a setting', T, () => {
  const w = workspace();
  try {
    const warn = `echo "joycon-bridge.m:1:1: warning: something new in a future SDK" >&2\n${w.goodBody}`;
    const r = w.run([], { JOYCON_BRIDGE_CLANG: w.fakeClang(warn) });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /warning: something new/);
    const bad = w.run(['--nope']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /usage: bridge\/build\.sh/);
    const src = readFileSync(join(ROOT, 'bridge', 'build.sh'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(src, /\bsudo\b|defaults write|systemsetup|spctl|csrutil|xcode-select --switch/);
    assert.match(src, /xcode-select -p/, 'the compiler is looked up with `xcode-select -p`, never by running the /usr/bin/clang stub (it opens an install dialog)');
  } finally {
    w.cleanup();
  }
});

test('two builds at the same time end with one good helper (the output is moved into place atomically)', T, async () => {
  const w = workspace();
  try {
    const { spawn } = await import('node:child_process');
    const env = { ...process.env, JOYCON_BRIDGE_BUILD_DIR: w.out, JOYCON_BRIDGE_CLANG: w.fakeClang(w.goodBody) };
    const run = () => new Promise((res) => {
      const c = spawn('bash', [join(w.bridge, 'build.sh'), '--force'], { env });
      c.on('exit', (code) => res(code));
    });
    const codes = await Promise.all([run(), run(), run()]);
    assert.deepEqual(codes, [0, 0, 0]);
    assert.equal(spawnSync(w.bin, ['--version'], { encoding: 'utf8' }).status, 0);
    assert.deepEqual(w.leftovers(), []);
  } finally {
    w.cleanup();
  }
});
