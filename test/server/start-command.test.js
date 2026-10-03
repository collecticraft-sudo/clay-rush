// start.command: runs the launcher with a fake `open` on the PATH (so no browser window is opened) and checks that it starts the
// server, waits for /__health, asks macOS to open Chrome on the right URL, holds a keep-awake assertion while it runs, and stops
// everything it started on Ctrl+C (no orphaned background process, round 1 finding M3). macOS only (the script uses `open`);
// skipped elsewhere. Every test has its own timeout so that a stuck launcher fails the test instead of hanging `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeHealth, startServer } from '../../server.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skip = platform() !== 'darwin' ? 'start.command uses macOS `open`' : false;

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(pred, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// The shims turn the launcher's `sleep 3600` and the real caffeinate into sleeps with an argument that is unique to this test
// process, so that a process left behind can be found (and killed) by name, whatever its pid or parent.
const IDLE_SLEEP = `3600.${process.pid}`;
const CAFFEINATE_SLEEP = `7200.${process.pid}`;
/** Pids of every process of this test file that is still running (idle sleeps and keep-awake helpers). */
function leftovers() {
  const lines = execFileSync('/bin/ps', ['-axo', 'pid=,command=']).toString().split('\n');
  return lines.filter((l) => l.includes(`sleep ${IDLE_SLEEP}`) || l.includes(`sleep ${CAFFEINATE_SLEEP}`)).map((l) => Number(l.trim().split(/\s+/)[0]));
}

/**
 * A directory that goes first on the PATH of the launcher with four shims: `open` (logs its arguments instead of opening a
 * browser), `caffeinate` (logs its arguments and pid, then idles like the real one), and `sleep` (logs the pid of every
 * `sleep 3600`, the launcher's idle loop, then becomes the real sleep, so the recorded pid is the process itself).
 */
function shimDir() {
  const dir = mkdtempSync(join(tmpdir(), 'clay-rush-shim-'));
  const log = join(dir, 'open.log');
  const caffeinateLog = join(dir, 'caffeinate.log');
  const sleepPids = join(dir, 'sleep.pids');
  const write = (name, body) => {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  };
  write('open', `#!/bin/bash\necho "$@" >> "${log}"\n`);
  write('caffeinate', `#!/bin/bash\necho "$$ $*" >> "${caffeinateLog}"\nexec /bin/sleep ${CAFFEINATE_SLEEP}\n`);
  write('sleep', `#!/bin/bash\nif [ "$1" = 3600 ]; then echo $$ >> "${sleepPids}"; exec /bin/sleep ${IDLE_SLEEP}; fi\nexec /bin/sleep "$@"\n`);
  const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((l) => Number(l.trim().split(' ')[0])).filter(Boolean) : []);
  return {
    dir, log, caffeinateLog, sleepPids,
    caffeinateLines: () => (existsSync(caffeinateLog) ? readFileSync(caffeinateLog, 'utf8').trim().split('\n').filter(Boolean) : []),
    sleepPidList: () => pids(sleepPids),
    caffeinatePidList: () => pids(caffeinateLog),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const reap = (pids) => {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
};

function runLauncher(port, shim, extraEnv = {}) {
  const child = spawn('/bin/bash', [join(ROOT, 'start.command')], { env: { ...process.env, PORT: String(port), PATH: `${shim.dir}:${process.env.PATH}`, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  const out = { stdout: '', stderr: '', code: null };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((res) => child.on('exit', (code) => {
    out.code = code;
    // never wait for the pipes: a stray grandchild that still holds them must not keep this test process alive
    child.stdout.destroy();
    child.stderr.destroy();
    res(out);
  }));
  return { child, out, exited };
}

test('start.command starts the server, opens Chrome on the game URL and stops the server on Ctrl+C', { skip, timeout: 60000 }, async () => {
  const shim = shimDir();
  const port = await freePort();
  const l = runLauncher(port, shim);
  try {
    assert.ok(await waitFor(() => probeHealth(port)), `server did not start: ${l.out.stdout} ${l.out.stderr}`);
    assert.ok(await waitFor(() => existsSync(shim.log)), 'the launcher asked macOS to open a browser');
    const opened = readFileSync(shim.log, 'utf8').trim();
    assert.match(opened, new RegExp(`http://localhost:${port}$`));
    assert.match(opened, /Google Chrome|^http/);
    assert.match(l.out.stdout, /Press Ctrl\+C/);
    l.child.kill('SIGINT');
    const out = await l.exited;
    assert.equal(out.code, 0);
    assert.ok(await waitFor(async () => !(await probeHealth(port))), 'the server it started is gone');
  } finally {
    try { l.child.kill('SIGKILL'); } catch { /* already gone */ }
    shim.cleanup();
  }
});

test('start.command re-uses a server that is already running (does not start a second one and leaves it alone)', { skip, timeout: 60000 }, async () => {
  const shim = shimDir();
  const running = await startServer({ port: 0 });
  const l = runLauncher(running.port, shim);
  try {
    assert.ok(await waitFor(() => existsSync(shim.log)));
    assert.match(l.out.stdout, /already running/);
    l.child.kill('SIGINT');
    await l.exited;
    assert.equal(await probeHealth(running.port), true, 'the server that was there before is still up');
  } finally {
    try { l.child.kill('SIGKILL'); } catch { /* already gone */ }
    await running.close();
    shim.cleanup();
  }
});

test('start.command keeps the display awake with caffeinate while it runs and leaves nothing behind (M2, M3)', { skip, timeout: 60000 }, async () => {
  const shim = shimDir();
  const running = await startServer({ port: 0 });
  const l = runLauncher(running.port, shim);
  try {
    assert.ok(await waitFor(() => l.out.stdout.includes('Press Ctrl+C')), `launcher did not finish starting: ${l.out.stdout} ${l.out.stderr}`);
    assert.ok(await waitFor(() => shim.caffeinateLines().length === 1), 'caffeinate was started once');
    const line = shim.caffeinateLines()[0];
    assert.match(line, / -di -w \d+$/, 'display and idle assertions, tied to a pid so it ends with the launcher');
    assert.equal(Number(line.split(' ').pop()), l.child.pid, 'it waits for the launcher itself, so it also ends when the window is closed');
    assert.match(l.out.stdout, /will not dim or sleep the display/);
    const [cafPid] = shim.caffeinatePidList();
    assert.ok(alive(cafPid), 'caffeinate is running while the launcher is');
    l.child.kill('SIGINT');
    const out = await l.exited;
    assert.equal(out.code, 0);
    assert.ok(await waitFor(() => !alive(cafPid), 3000), 'caffeinate is stopped together with the launcher');
    assert.ok(await waitFor(() => leftovers().length === 0, 3000), 'the idle sleep is gone too');
  } finally {
    try { l.child.kill('SIGKILL'); } catch { /* already gone */ }
    reap([...shim.caffeinatePidList(), ...shim.sleepPidList(), ...leftovers()]);
    await running.close();
    shim.cleanup();
  }
});

test('start.command: JOYCON_NO_CAFFEINATE=1 opts out of the keep-awake helper', { skip, timeout: 60000 }, async () => {
  const shim = shimDir();
  const running = await startServer({ port: 0 });
  const l = runLauncher(running.port, shim, { JOYCON_NO_CAFFEINATE: '1' });
  try {
    assert.ok(await waitFor(() => l.out.stdout.includes('Press Ctrl+C')));
    assert.deepEqual(shim.caffeinateLines(), []);
    assert.doesNotMatch(l.out.stdout, /will not dim or sleep/);
    l.child.kill('SIGINT');
    await l.exited;
  } finally {
    try { l.child.kill('SIGKILL'); } catch { /* already gone */ }
    reap(shim.sleepPidList());
    await running.close();
    shim.cleanup();
  }
});

test('start.command: Ctrl+C in the instant after `sleep 3600 &` forks never leaves an orphaned sleep or caffeinate (M3 race)', { skip, timeout: 120000 }, async () => {
  // The old launcher stored the pid of `sleep 3600 &` in a variable one statement later: a Ctrl+C in between exited with an empty
  // variable and the sleep survived, holding the caller's stdout pipe open forever (a hung `npm test`, seen once in review; about
  // 2 % of random Ctrl+C timings). This test hits that instant on purpose and every time: a DEBUG trap loaded through BASH_ENV
  // fires right before the first command that runs after `sleep 3600` was forked and sends the launcher its own SIGINT there.
  // Against the old script the sleep is orphaned in every run; the job-table cleanup leaves nothing behind.
  const shim = shimDir();
  const bashEnv = join(shim.dir, 'race.env');
  writeFileSync(bashEnv, [
    '__armed=0',
    'trap \'if [ "$__armed" = 1 ]; then __armed=2; kill -INT $$; elif [ "$__armed" = 0 ]; then case "$BASH_COMMAND" in "sleep 3600"*) __armed=1;; esac; fi\' DEBUG',
    '',
  ].join('\n'));
  const running = await startServer({ port: 0 });
  const RUNS = 5;
  try {
    for (let i = 0; i < RUNS; i++) {
      const l = runLauncher(running.port, shim, { BASH_ENV: bashEnv });
      const guard = setTimeout(() => l.child.kill('SIGKILL'), 15000);
      await l.exited;
      clearTimeout(guard);
      assert.equal(l.out.code, 0, `launch ${i} exited cleanly (it was interrupted right after the fork): ${l.out.stdout} ${l.out.stderr}`);
    }
    await new Promise((r) => setTimeout(r, 300));
    const survivors = leftovers();
    reap(survivors); // never leave them behind, whatever the verdict
    assert.deepEqual(survivors, [], `${survivors.length} background process(es) survived their launcher`);
  } finally {
    reap(leftovers());
    await running.close();
    shim.cleanup();
  }
});
