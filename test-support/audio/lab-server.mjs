// Static server for the sound lab (a dev tool, never shipped): serves test-support/audio/lab/ at / and public/js/ at /js/ on loopback.
//   node test-support/audio/lab-server.mjs [port]      default port 8274, open http://127.0.0.1:8274/
// The lab page plays every sound live through the REAL engine (click a card) and renders it offline (OfflineAudioContext) to show the
// waveform, a spectrogram, the peak and RMS levels and the tail length. OWNER: audio engineer.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIME, resolveRequestPath } from '../../server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = path.join(HERE, 'lab');
const JS_ROOT = path.join(HERE, '..', '..', 'public', 'js');

export const LAB_PORT = 8274;

/** @returns {Promise<{url:string, port:number, close:()=>Promise<void>}>} */
export function startLabServer({ port = LAB_PORT } = {}) {
  const server = http.createServer((req, res) => {
    const raw = req.url ?? '/';
    const pathname = raw.split('?')[0];
    let root = LAB_ROOT;
    let target = pathname === '/' ? '/index.html' : pathname;
    if (target.startsWith('/js/')) {
      root = JS_ROOT;
      target = target.slice(3);
    } else if (target.startsWith('/lab/')) {
      target = target.slice(4);
    }
    const r = resolveRequestPath(target, root);
    if (!r.ok) {
      res.writeHead(r.status, { 'Content-Type': 'text/plain' });
      res.end(r.reason);
      return;
    }
    fs.readFile(r.file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(r.file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        url: `http://127.0.0.1:${p}`,
        port: p,
        close: () => new Promise((res) => { server.close(() => res()); server.closeAllConnections?.(); }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || LAB_PORT;
  startLabServer({ port }).then((s) => console.log(`sound lab on ${s.url}/`)).catch((e) => { console.error(e.message); process.exit(1); });
}
