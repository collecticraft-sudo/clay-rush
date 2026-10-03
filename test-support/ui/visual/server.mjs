// Tiny static server for the UI visual harness (test-support only). Serves this folder at /, public/js at /js, public/assets at /assets and
// public/css at /css, so the harness page resolves URLs exactly like public/index.html. Usage: node test-support/ui/visual/server.mjs 8331
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const port = Number(process.argv[2] ?? 8331);
const outDir = process.argv[3] ?? null; // POST /save?name=x (body: a PNG data URL) writes <outDir>/<x>.png
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.css': 'text/css' };

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (req.method === 'POST' && url === '/save' && outDir) {
    const name = (new URL(req.url, 'http://x').searchParams.get('name') ?? 'shot').replace(/[^\w-]/g, '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const dataUrl = Buffer.concat(chunks).toString('utf8');
      fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
      res.writeHead(204);
      res.end();
    });
    return;
  }
  let file;
  if (url.startsWith('/js/') || url.startsWith('/assets/') || url.startsWith('/css/')) file = path.join(root, 'public', url);
  else file = path.join(here, url === '/' ? 'visual.html' : url);
  if (!file.startsWith(root)) { res.writeHead(400); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`visual harness on http://127.0.0.1:${port}/`));
