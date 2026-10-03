// Minimal Chrome DevTools Protocol client, no dependencies (Node's built-in WebSocket and fetch). OWNER: integrator.
// docs/architecture.md A-26. Used by chrome-launcher.js and test/e2e. It implements only what the e2e suite needs: a browser
// connection, pages (targets) with evaluate / navigate / screenshot / mouse / console and network collection.

const DEFAULT_TIMEOUT_MS = 30000;

export class CdpError extends Error {
  constructor(method, error) {
    super(`CDP ${method} failed: ${error && error.message ? error.message : JSON.stringify(error)}`);
    this.name = 'CdpError';
    this.method = method;
    this.cdp = error;
  }
}

export class CdpConnection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map(); // "event" or "sessionId:event" -> Set<fn>
  closed = false;

  static connect(wsUrl, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`timeout connecting to ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to ${wsUrl}`));
      });
    });
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.#pending) p.reject(new Error('CDP connection closed'));
      this.#pending.clear();
    });
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
      const set = this.#listeners.get(key);
      if (set) for (const fn of [...set]) fn(msg.params ?? {});
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  on(event, fn, sessionId = undefined) {
    const key = sessionId ? `${sessionId}:${event}` : event;
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set());
    this.#listeners.get(key).add(fn);
    return () => this.#listeners.get(key)?.delete(fn);
  }

  close() {
    try { this.#ws.close(); } catch { /* ignore */ }
  }
}

/** A browser page (CDP target) with the helpers of the e2e suite. */
export class Page {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.console = []; // {type, text}
    this.exceptions = []; // {text, url, line}
    this.requests = []; // {url, method}
    this.failedRequests = []; // {url, error}
    this.badResponses = []; // {url, status}
    this._off = [];
  }

  static async create(conn, { width = 1920, height = 1080, deviceScaleFactor = 1 } = {}) {
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(conn, sessionId, targetId);
    page._wire();
    await Promise.all([
      page.send('Page.enable'), page.send('Runtime.enable'), page.send('Network.enable'), page.send('Log.enable'),
    ]);
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
    return page;
  }

  send(method, params = {}, timeoutMs) {
    return this.conn.send(method, params, this.sessionId, timeoutMs);
  }

  _wire() {
    const on = (ev, fn) => this._off.push(this.conn.on(ev, fn, this.sessionId));
    const fmt = (a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type);
    on('Runtime.consoleAPICalled', (p) => this.console.push({ type: p.type, text: (p.args ?? []).map(fmt).join(' ') }));
    on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails ?? {};
      this.exceptions.push({ text: d.exception?.description ?? d.text ?? 'exception', url: d.url, line: d.lineNumber });
    });
    on('Log.entryAdded', (p) => {
      const e = p.entry ?? {};
      if (e.level === 'error') this.console.push({ type: 'error', text: `[log] ${e.text}${e.url ? ` (${e.url})` : ''}` });
    });
    on('Network.requestWillBeSent', (p) => this.requests.push({ url: p.request.url, method: p.request.method }));
    on('Network.loadingFailed', (p) => {
      if (p.canceled) return;
      this.failedRequests.push({ url: p.requestId, error: p.errorText });
    });
    on('Network.responseReceived', (p) => {
      if (p.response.status >= 400) this.badResponses.push({ url: p.response.url, status: p.response.status });
    });
  }

  /** Runs `source` in every new document before its own scripts (storage failure injection, etc.). */
  addInitScript(source) {
    return this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async goto(url, { waitFor = 'load', timeoutMs = 30000 } = {}) {
    const loaded = new Promise((resolve, reject) => {
      const off = this.conn.on(waitFor === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired', () => { off(); clearTimeout(t); resolve(); }, this.sessionId);
      const t = setTimeout(() => { off(); reject(new Error(`timeout loading ${url}`)); }, timeoutMs);
    });
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`);
    await loaded;
  }

  /** Evaluate an expression (string) or a function with JSON-serialisable args. Awaits promises and returns the value. */
  async evaluate(fnOrSource, ...args) {
    const expression = typeof fnOrSource === 'function' ? `(${fnOrSource.toString()})(...${JSON.stringify(args)})` : fnOrSource;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page evaluation failed: ${d.exception?.description ?? d.text}`);
    }
    return r.result.value;
  }

  async waitFor(fn, { timeoutMs = 10000, pollMs = 50, message = 'condition' } = {}, ...args) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeoutMs) {
      last = await this.evaluate(fn, ...args);
      if (last) return last;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`timeout waiting for ${message} (last value: ${JSON.stringify(last)})`);
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    if (path) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, Buffer.from(data, 'base64'));
    }
    return data;
  }

  mouse = {
    move: (x, y) => this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' }),
    down: (x, y, button = 'left') => this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount: 1, pointerType: 'mouse' }),
    up: (x, y, button = 'left') => this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1, pointerType: 'mouse' }),
  };

  key(key, code = key) {
    const vk = { Enter: 13, Escape: 27, ' ': 32, p: 80 }[key] ?? 0;
    return (async () => {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key.length === 1 ? key : undefined });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    })();
  }

  consoleErrors() {
    return this.console.filter((c) => c.type === 'error' || c.type === 'assert').map((c) => c.text);
  }

  async close() {
    for (const off of this._off) off();
    this._off = [];
    try {
      await this.conn.send('Target.closeTarget', { targetId: this.targetId }, undefined, 5000);
    } catch { /* the browser may be gone already */ }
  }
}
