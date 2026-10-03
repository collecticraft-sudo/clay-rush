// Finds and launches a headless Google Chrome for the e2e suite. OWNER: integrator. docs/architecture.md A-26.
// If Chrome is missing (or cannot start) the suite reports "skipped", never "passed".

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { CdpConnection } from './cdp.js';

const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  `${process.env.HOME ?? ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
];
const LINUX_PATHS = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

/** @returns {string|null} path of a Chrome or Chromium binary */
export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const list = platform() === 'darwin' ? MAC_PATHS : LINUX_PATHS;
  return list.find((p) => p && existsSync(p)) ?? null;
}

/**
 * @param {{headless?:boolean, extraArgs?:string[], width?:number, height?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<{conn:CdpConnection, process:any, userDataDir:string, version:string, close:()=>Promise<void>}>}
 */
export async function launchChrome(opts = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('Google Chrome not found (set CHROME_PATH to run the e2e suite)');
  const userDataDir = mkdtempSync(join(tmpdir(), 'clay-rush-chrome-'));
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const args = [
    ...(opts.headless === false ? [] : ['--headless=new']),
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--mute-audio',
    '--hide-scrollbars',
    ...(opts.extraArgs ?? []),
    'about:blank',
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const cleanup = () => {
    try { if (!exited) child.kill('SIGKILL'); } catch { /* ignore */ }
    // Chrome's helper processes inherit the stderr pipe and outlive the browser process for a while: without this the Node
    // process would wait for them (about 25 s) before it could exit.
    try { child.stderr.destroy(); } catch { /* ignore */ }
    try { child.unref(); } catch { /* ignore */ }
    // Chrome's helper processes may still be writing into the profile for a moment: retry instead of leaving the folder behind
    try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  };
  process.once('exit', cleanup);
  const waitExit = (ms) => new Promise((res) => {
    if (exited) { res(); return; }
    const timer = setTimeout(res, ms);
    child.once('exit', () => { clearTimeout(timer); res(); });
  });

  // Chrome writes DevToolsActivePort (port, then the browser websocket path) into the profile folder when it is ready.
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + (opts.timeoutMs ?? 20000);
  let wsUrl = null;
  while (Date.now() < deadline) {
    if (exited) break;
    if (existsSync(portFile)) {
      const lines = readFileSync(portFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length >= 2) {
        wsUrl = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!wsUrl) {
    cleanup();
    throw new Error(`Chrome did not expose the DevTools port (${exited ? 'it exited' : 'timeout'}). ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
  let conn;
  try {
    conn = await CdpConnection.connect(wsUrl);
  } catch (err) {
    cleanup();
    throw err;
  }
  const { product } = await conn.send('Browser.getVersion');
  return {
    conn,
    process: child,
    userDataDir,
    version: product,
    async close() {
      try { await conn.send('Browser.close', {}, undefined, 3000); } catch { /* it may already be closing */ }
      conn.close();
      await waitExit(4000); // a normal exit takes its helper processes with it; SIGKILL below is only the fallback
      cleanup();
      process.off('exit', cleanup);
    },
  };
}
