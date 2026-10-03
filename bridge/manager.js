// Helper manager of the native Bluetooth bridge (docs/native-bridge.md). Node built-ins only.
//
// server.js loads this module lazily (first /__bridge/ request), so a broken bridge can never stop the game server from starting.
// The manager owns ONE child process, the compiled helper bridge/build/joycon-bridge (or the binary named by the environment variable
// JOYCON_BRIDGE_BIN, which the tests point at a fake). It
//   * builds the helper on demand (bridge/build.sh) when it is missing or older than its source and clang exists,
//   * spawns it lazily on the first connect (an argument array, never a shell), waits for its hello line,
//   * parses its stdout (one JSON object per line), remembers the last status and fans every event out to any number of listeners,
//   * turns a helper crash into a status event (exit code 134 or SIGABRT, which is how macOS stops a process that uses Bluetooth
//     without permission, becomes code "bluetooth_permission"; any other crash becomes "helper_crashed"),
//   * disconnects the Joy-Con when the last page stops listening (a closed or crashed tab must not keep the controller connected),
//   * and kills the helper when the server stops (quit command, then SIGTERM, then SIGKILL; a helper that outlives the server
//     exits by itself anyway because its stdin closes).
//
// Nothing here talks to Bluetooth. Whether the real helper works is UNVERIFIED-ON-HARDWARE end to end (the native probe it derives from
// was verified by the owner on 2026-09-30).

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PROTOCOL_VERSION = 1;
/** Helper states in which a connect command is refused (a session is running). */
export const ACTIVE_STATES = Object.freeze(['scanning', 'connecting', 'discovering', 'initialising', 'streaming']);
/** Helper states that end a session ('idle' is only the startup status of a fresh helper and ends nothing). */
export const TERMINAL_STATES = Object.freeze(['disconnected', 'error']);
const FORWARDED_TYPES = new Set(['hello', 'status', 'advert', 'report', 'response']);
const MAX_LINE = 65536;

/**
 * What a helper exit means. macOS stops a process that uses Bluetooth without permission (or without a usage description) with
 * SIGABRT, which a shell reports as exit code 134 and Node as signal SIGABRT; everything else is a crash.
 * @returns {'bluetooth_permission'|'helper_crashed'}
 */
export function classifyHelperExit(code, signal) {
  return code === 134 || signal === 'SIGABRT' ? 'bluetooth_permission' : 'helper_crashed';
}

const fail = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra });
const problem = (code, message) => Object.assign(new Error(message), { code });

const isExecutable = (file) => {
  try {
    const st = fs.statSync(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/**
 * @param {object} [opts]
 * @param {string} [opts.bin]             helper binary (default: env JOYCON_BRIDGE_BIN, else <bridgeDir>/build/joycon-bridge)
 * @param {string} [opts.bridgeDir]       folder with build.sh and joycon-bridge.m (default: this folder)
 * @param {object} [opts.env]             environment of the helper and of build.sh (default process.env)
 * @param {string} [opts.platform]        default process.platform
 * @param {number} [opts.helloTimeoutMs]  default 5000
 * @param {number} [opts.buildTimeoutMs]  default 120000
 * @param {number} [opts.stopGraceMs]     wait after quit, and again after SIGTERM, default 600
 * @param {number} [opts.idleDisconnectMs] disconnect this long after the last listener left, default 8000 (0 = never)
 * @param {(message:string)=>void} [opts.log]  server console log (default console.error with a [bridge] prefix)
 */
export function createBridgeManager(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const bridgeDir = opts.bridgeDir ?? HERE;
  const override = opts.bin ?? env.JOYCON_BRIDGE_BIN ?? null;
  const binPath = override ?? path.join(bridgeDir, 'build', 'joycon-bridge');
  const buildScript = path.join(bridgeDir, 'build.sh');
  const sourceFile = path.join(bridgeDir, 'joycon-bridge.m');
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const buildTimeoutMs = opts.buildTimeoutMs ?? 120000;
  const stopGraceMs = opts.stopGraceMs ?? 600;
  const idleDisconnectMs = opts.idleDisconnectMs ?? 8000;
  const log = opts.log ?? ((message) => console.error(`[bridge] ${message}`));

  const subscribers = new Set();
  let lastStatus = { type: 'status', state: 'idle' };
  let state = 'idle';
  let child = null; // {proc, buf, hello, expectedExit, stderrTail, exited, onHello, onFail}
  let helperPromise = null;
  let sessionActive = false; // a connect was accepted and no terminal status came yet
  let sessionGen = 0; // bumped by disconnect(): a connect still preparing the helper notices and stops
  let stopping = false;
  let idleTimer = null;
  let lastRumbleAt = 0;
  let invalidLines = 0;
  let canBuildCache = null; // {at, value}
  let seq = 0; // every event sent to listeners carries a sequence number: a page can tell which events belong to its own attempt

  // ------------------------------------------------------------------------------------------------ events

  function emit(event) {
    event.seq = ++seq;
    for (const fn of [...subscribers]) {
      try {
        fn(event);
      } catch {
        /* a broken listener must never stop the others */
      }
    }
  }

  function setStatus(status) {
    lastStatus = status;
    state = status.state;
    if (TERMINAL_STATES.includes(status.state)) {
      sessionActive = false;
      cancelIdleTimer();
    }
  }

  function cancelIdleTimer() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /** Nobody listens and a Joy-Con is connected: after a grace period, disconnect it. */
  function armIdleCheck() {
    cancelIdleTimer();
    if (!sessionActive || subscribers.size > 0 || idleDisconnectMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!sessionActive || subscribers.size > 0) return;
      log('no page is listening any more: disconnecting the Joy-Con');
      sessionGen++;
      if (child && child.hello) send({ cmd: 'disconnect' });
    }, idleDisconnectMs);
    idleTimer.unref?.();
  }

  /**
   * Listen to every event. The last status is replayed first (with "replay":true) so a page that opens the stream late knows where
   * things stand. Returns an unsubscribe function.
   */
  function subscribe(fn) {
    subscribers.add(fn);
    cancelIdleTimer();
    try {
      fn({ ...lastStatus, replay: true, seq });
    } catch {
      /* ignore */
    }
    return () => {
      if (subscribers.delete(fn)) armIdleCheck();
    };
  }

  // ------------------------------------------------------------------------------------------------ helper I/O

  function send(command) {
    if (!child || !child.proc.stdin.writable) return false;
    try {
      child.proc.stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function onLine(rec, line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      if (invalidLines++ < 3) log('the helper printed a line that is not JSON (ignored)');
      return;
    }
    if (obj === null || typeof obj !== 'object' || !FORWARDED_TYPES.has(obj.type)) {
      if (invalidLines++ < 3) log('the helper printed an object of an unknown type (ignored)');
      return;
    }
    if (obj.type === 'hello') {
      rec.hello = true;
      if (obj.version !== PROTOCOL_VERSION) {
        rec.onFail?.(problem('helper_failed', `the helper speaks protocol version ${String(obj.version)}, this server expects ${PROTOCOL_VERSION}`));
        return;
      }
      rec.onHello?.();
    } else if (obj.type === 'status') {
      if (typeof obj.state !== 'string') return;
      if (!obj.warning) setStatus(obj); // a warning is not a state change
    } else if (obj.type === 'report' && (typeof obj.hex !== 'string' || obj.hex.length > 512 || !/^[0-9a-fA-F]*$/.test(obj.hex))) {
      return;
    } else if (obj.type === 'response' && (typeof obj.hex !== 'string' || obj.hex.length > 512 || !/^[0-9a-fA-F]*$/.test(obj.hex))) {
      return;
    }
    emit(obj);
  }

  function onStdout(rec, chunk) {
    rec.buf += chunk;
    let i;
    while ((i = rec.buf.indexOf('\n')) >= 0) {
      const line = rec.buf.slice(0, i).trim();
      rec.buf = rec.buf.slice(i + 1);
      if (line) onLine(rec, line);
    }
    if (rec.buf.length > MAX_LINE) rec.buf = ''; // a runaway line: drop it
  }

  function onChildExit(rec, code, signal, err) {
    if (child === rec) child = null;
    sessionActive = false;
    cancelIdleTimer();
    rec.resolveExited();
    if (!rec.hello) {
      rec.onFail?.(problem('helper_failed', `the helper exited before saying hello (${code !== null ? `exit code ${code}` : `signal ${signal}`})`));
      return;
    }
    if (rec.expectedExit) return;
    const permission = classifyHelperExit(code, signal) === 'bluetooth_permission';
    const how = err ? `error ${err.code ?? err.message}` : code !== null ? `exit code ${code}` : `signal ${signal}`;
    const status = {
      type: 'status',
      state: 'error',
      code: permission ? 'bluetooth_permission' : 'helper_crashed',
      message: permission
        ? 'macOS stopped the Bluetooth helper because the app that started this server has no Bluetooth permission (start the game from Terminal and allow Terminal in System Settings > Privacy & Security > Bluetooth)'
        : `the Bluetooth helper stopped unexpectedly (${how})`,
      source: 'server',
    };
    setStatus(status);
    const tail = rec.stderrTail.trim().split('\n').slice(-2).join(' | ').slice(0, 300);
    log(`the helper stopped unexpectedly (${how})${tail ? `; its last stderr: ${tail}` : ''}`);
    emit(status);
  }

  function spawnHelper() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let proc;
      try {
        proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env }); // argument array, no shell
      } catch (err) {
        reject(problem('helper_failed', `cannot start the helper: ${err.code ?? err.message}`));
        return;
      }
      let resolveExited;
      const exited = new Promise((r) => { resolveExited = r; });
      const rec = { proc, buf: '', hello: false, expectedExit: false, stderrTail: '', exited, resolveExited };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        rec.expectedExit = true;
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
        settle(reject, problem('helper_failed', `the helper did not say hello within ${helloTimeoutMs} ms`));
      }, helloTimeoutMs);
      timer.unref?.();
      rec.onHello = () => {
        if (child === rec) settle(resolve, rec);
      };
      rec.onFail = (err) => {
        rec.expectedExit = true;
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
        settle(reject, err);
      };
      const killAtExit = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } };
      process.once('exit', killAtExit); // last resort if the server leaves without stop()
      child = rec;
      proc.stdin.on('error', () => {});
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => onStdout(rec, chunk));
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => { rec.stderrTail = (rec.stderrTail + chunk).slice(-2000); });
      proc.on('error', (err) => {
        // spawn failed (ENOENT, EACCES) or killing failed
        if (!settled) {
          if (child === rec) child = null;
          rec.resolveExited();
          process.off('exit', killAtExit);
          settle(reject, problem(err.code === 'ENOENT' ? 'helper_missing' : 'helper_failed', `cannot start the helper: ${err.code ?? err.message}`));
        } else onChildExit(rec, null, null, err);
      });
      proc.on('exit', (code, signal) => {
        process.off('exit', killAtExit);
        onChildExit(rec, code, signal);
      });
    });
  }

  // ------------------------------------------------------------------------------------------------ building

  function runScript(args, timeout) {
    return new Promise((resolve) => {
      execFile('/bin/bash', [buildScript, ...args], { timeout, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, output: `${stdout ?? ''}${stderr ?? ''}`.trim() });
      });
    });
  }

  /** Can this Mac compile the helper? (`bridge/build.sh --check`, cached for 15 s) */
  async function canBuild(fresh = false) {
    if (override || platform !== 'darwin' || !fs.existsSync(buildScript) || !fs.existsSync(sourceFile)) return false;
    if (!fresh && canBuildCache && Date.now() - canBuildCache.at < 15000) return canBuildCache.value;
    const res = await runScript(['--check'], 5000);
    canBuildCache = { at: Date.now(), value: res.ok };
    return res.ok;
  }

  function isStale() {
    try {
      return fs.statSync(sourceFile).mtimeMs > fs.statSync(binPath).mtimeMs;
    } catch {
      return false;
    }
  }

  async function ensureBinary() {
    if (override) {
      if (!isExecutable(override)) throw problem('helper_missing', 'the helper binary does not exist or is not executable');
      return;
    }
    if (platform !== 'darwin') throw problem('not_macos', 'the native Bluetooth bridge only works on macOS');
    const exists = isExecutable(binPath);
    if (exists && !isStale()) return;
    if (!(await canBuild(true))) {
      if (exists) return; // a stale helper is better than none
      throw problem('helper_missing', 'the helper is not built and this Mac has no compiler (install the Command Line Tools with: xcode-select --install)');
    }
    emit({ type: 'bridge', phase: 'building' });
    const res = await runScript([], buildTimeoutMs);
    emit({ type: 'bridge', phase: 'built', ok: res.ok });
    if (!res.ok) {
      log(`building the helper failed:\n${res.output}`);
      if (!isExecutable(binPath)) {
        throw problem('build_failed', `building the helper failed: ${res.output.split('\n').slice(-3).join(' | ').slice(0, 400)}`);
      }
    }
  }

  function ensureHelper() {
    if (child && child.hello) return Promise.resolve(child);
    if (helperPromise) return helperPromise;
    helperPromise = (async () => {
      await ensureBinary();
      if (stopping) throw problem('stopping', 'the server is stopping');
      emit({ type: 'bridge', phase: 'starting' });
      const rec = await spawnHelper();
      if (stopping) {
        await killChild(rec);
        throw problem('stopping', 'the server is stopping');
      }
      return rec;
    })().finally(() => { helperPromise = null; });
    return helperPromise;
  }

  // ------------------------------------------------------------------------------------------------ public API

  /** {available, reason, built, canBuild, state} for GET /__bridge/status. */
  async function getStatus() {
    const built = isExecutable(binPath);
    const can = await canBuild();
    let available;
    let reason = null;
    if (override) {
      available = built;
      if (!built) reason = 'helper_missing';
    } else if (platform !== 'darwin') {
      available = false;
      reason = 'not_macos';
    } else if (built || can) {
      available = true;
    } else {
      available = false;
      reason = 'no_compiler';
    }
    return { available, reason, built, canBuild: can, state };
  }

  /**
   * Start a connection attempt. `params` are already validated by the caller ({side, scanSeconds?, keepAliveHz?, mask?, pairingOnly?}).
   * `seq` of a successful result is the sequence number of the last event sent BEFORE this attempt began: every event with a higher
   * `seq` (building, starting, and all helper lines) belongs to this attempt, every event up to it is older. A page that opened its
   * event stream before posting uses this to ignore the tail of an earlier session.
   * @returns {Promise<{ok:true, seq:number}|{ok:false, status:number, code:string, message:string}>}
   */
  async function connect(params) {
    if (stopping) return fail(503, 'stopping', 'the server is stopping');
    if (sessionActive) return fail(409, 'busy', `a connection attempt is already running (${state})`, { state });
    sessionActive = true; // claimed before the first await: a second request at the same moment is refused
    const gen = ++sessionGen;
    const seqBefore = seq;
    let rec;
    try {
      rec = await ensureHelper();
    } catch (err) {
      if (gen === sessionGen) sessionActive = false;
      return fail(503, err.code ?? 'helper_failed', err.message);
    }
    if (stopping || child !== rec) {
      if (gen === sessionGen) sessionActive = false;
      return fail(503, 'helper_failed', 'the helper stopped before it could be used');
    }
    if (gen !== sessionGen) return fail(409, 'cancelled', 'the connection attempt was cancelled before it started');
    send({ cmd: 'connect', ...params });
    armIdleCheck();
    return { ok: true, seq: seqBefore };
  }

  /** Disconnect the Joy-Con (and cancel a connect that is still preparing the helper). Always succeeds. */
  function disconnect() {
    sessionGen++;
    if (child && child.hello) send({ cmd: 'disconnect' });
    else sessionActive = false;
    return { ok: true };
  }

  /** Vibration preset (rate limited to 10 per second, only while streaming). */
  function rumble(id) {
    if (!child || !child.hello || state !== 'streaming') return { ok: true, dropped: true };
    const now = Date.now();
    if (now - lastRumbleAt < 100) return { ok: true, dropped: true };
    lastRumbleAt = now;
    send({ cmd: 'rumble', id });
    return { ok: true };
  }

  /** quit command, then SIGTERM, then SIGKILL. Resolves when the process is gone. */
  async function killChild(rec) {
    rec.expectedExit = true;
    const wait = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
    try {
      rec.proc.stdin.write('{"cmd":"quit"}\n');
      rec.proc.stdin.end();
    } catch {
      /* the helper may be gone already */
    }
    await Promise.race([rec.exited, wait(stopGraceMs)]);
    if (child === rec) {
      try { rec.proc.kill('SIGTERM'); } catch { /* gone */ }
      await Promise.race([rec.exited, wait(stopGraceMs)]);
    }
    if (child === rec) {
      try { rec.proc.kill('SIGKILL'); } catch { /* gone */ }
      await Promise.race([rec.exited, wait(2000)]);
    }
  }

  /** Stop the helper and refuse every later connect. Resolves when the process is gone. */
  async function stop() {
    stopping = true;
    cancelIdleTimer();
    if (child) await killChild(child);
  }

  return {
    getStatus,
    connect,
    disconnect,
    rumble,
    subscribe,
    stop,
    /** For tests and diagnostics. */
    info: () => ({ state, sessionActive, subscribers: subscribers.size, pid: child ? child.proc.pid : null, hello: !!child?.hello, binPath, stopping }),
  };
}
