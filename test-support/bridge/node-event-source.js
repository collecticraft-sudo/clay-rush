// A minimal EventSource for Node (the global one is still experimental): just enough of the browser API for native-link.js.
// Test helper of the input engineer. Plain `data:` messages only, no reconnection (native-link.js never wants the browser's own).

import http from 'node:http';

/**
 * @param {{headers?:object}} [defaults]  extra request headers (for example an Origin, as a browser sends one)
 */
export function createNodeEventSource(defaults = {}) {
  return class NodeEventSource {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      const u = new URL(this.url);
      this.req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Accept: 'text/event-stream', ...(defaults.headers ?? {}) } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.#fail();
          return;
        }
        this.readyState = 1;
        this.onopen?.({});
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk;
          let i;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (data) this.onmessage?.({ data });
          }
        });
        res.on('close', () => this.#fail());
      });
      this.req.on('error', () => this.#fail());
    }

    #fail() {
      if (this.readyState === 2) return;
      this.readyState = 2;
      this.onerror?.({});
    }

    close() {
      this.readyState = 2;
      this.req.destroy();
    }
  };
}
