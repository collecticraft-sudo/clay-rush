// Naming guard (docs/architecture.md, table at the top): the game is "Clay Rush" everywhere a player or a reader sees it; the code name is
// `clay-shooter` (folder, package, health probe), the debug API `window.__clay`, the storage key `clayRush.v1`, the log prefix `[clay-rush]`.
// The game was forked from "3D Fruit Dojo" (code name joycon-ninja): only the documents under docs/legacy-fruit-dojo/ and lines that talk about
// the fork may name it. A few identifiers of the old game are kept ON PURPOSE because other programs depend on them: the bridge header
// `X-Joycon-Ninja` (the native helper's server checks it), the bundle id `local.joyconninja.bridge`, and the `joyconNinja.*` keys of the input
// module (the diagnostics page and the game share them). It never runs a server and never opens a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../../public/js/ui/strings.en.js';
import { CONFIG } from '../../public/js/game/index.js';
import { STORAGE_KEY } from '../../public/js/ui/storage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const NAME = 'Clay Rush';
const OLD_NAMES = /fruit\s+dojo|joy-?con\s+ninja|fruit\s+ninja/i;
const FORK_TALK = /(fork|legacy|renam|formerly|was called|old game|previous game)/i;
const codeLines = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*|#)/.test(l));

test('the entry page, the diagnostics page and the Bluetooth usage string show "Clay Rush", never an old title', () => {
  const html = read('public/index.html');
  assert.match(html, /<title>Clay Rush<\/title>/);
  assert.match(html, /aria-label="Clay Rush"/);
  assert.match(html, /<noscript>Clay Rush needs JavaScript\./);
  assert.doesNotMatch(html, OLD_NAMES);
  const diag = read('public/diagnostics.html');
  assert.ok(diag.includes(NAME), 'the diagnostics page says which game it belongs to');
  assert.match(diag, /<h1>Joy-Con Diagnostics<\/h1>/, 'the heading of the page is unchanged (the server test looks for it)');
  assert.doesNotMatch(diag, OLD_NAMES);
  const plist = read('bridge/Info.plist');
  const usage = plist.match(/<key>NSBluetoothAlwaysUsageDescription<\/key>\s*<string>([^<]+)<\/string>/);
  assert.ok(usage, 'the usage description exists');
  assert.ok(usage[1].startsWith(`${NAME} talks to your Joy-Con 2`), usage[1]);
  assert.match(plist, /<string>local\.joyconninja\.bridge<\/string>/, 'the bundle id is an identifier and stays');
});

test('the launcher banners and the server console lines say "Clay Rush"; the health probe answers as clay-shooter', () => {
  const launcher = read('start.command');
  assert.doesNotMatch(launcher, OLD_NAMES);
  const echoes = launcher.split('\n').filter((l) => /^\s*echo "/.test(l));
  assert.ok(echoes.some((l) => l.includes(`${NAME} is already running at \${URL}`)), 'banner: already running');
  assert.ok(echoes.some((l) => l.includes(`${NAME} is open at \${URL}`)), 'banner: open');
  assert.match(launcher, /PORT="\$\{PORT:-8141\}"/, 'the default port of Clay Rush');
  assert.ok(launcher.includes(`'"name":"clay-shooter"'`), 'the launcher probes the health body');
  const server = read('server.js');
  const code = codeLines(server).join('\n');
  assert.doesNotMatch(code, OLD_NAMES);
  assert.ok(code.includes(`console.log(\`${NAME} is already running at http://localhost:\${port}\`)`));
  assert.ok(code.includes(`console.log(\`${NAME} is running at http://localhost:\${running.port}\`)`));
  assert.ok(server.includes(`'{"ok":true,"name":"clay-shooter"}'`), 'the health body');
  assert.match(server, /DEFAULT_PORT = 8141/);
});

test('package.json describes Clay Rush under the code name clay-shooter', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'clay-shooter');
  assert.ok(pkg.description.startsWith(`${NAME}:`), pkg.description);
  assert.doesNotMatch(pkg.description, OLD_NAMES);
});

test('the strings: the title is "CLAY RUSH"; nothing a player reads names the old game, fruit or a sword', () => {
  assert.equal(STRINGS['menu.title'], 'CLAY RUSH');
  for (const [key, text] of Object.entries(STRINGS)) {
    assert.doesNotMatch(text, OLD_NAMES, key);
    assert.doesNotMatch(text, /\b(fruit|sword|slice|blade)s?\b/i, key);
  }
});

test('the identifiers of Clay Rush: storage key clayRush.v1, window.__clay, log prefix [clay-rush]; no __ninja and no joyconNinja.v1 left', () => {
  assert.equal(STORAGE_KEY, 'clayRush.v1');
  assert.equal(CONFIG.storage.key, 'clayRush.v1');
  const app = read('public/js/app.js');
  assert.match(app, /win\.__clay = clay\.api/);
  assert.match(app, /const LOG_PREFIX = '\[clay-rush\]'/);
  assert.equal(existsSync(join(ROOT, 'public/js/ninja-api.js')), false);
  assert.ok(read('public/js/clay-api.js').includes('window.__clay'));
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(js|mjs|html)$/.test(e.name) && !rel.startsWith('test/architecture/') && rel !== 'test/app/app.test.js') {
        const src = read(rel);
        if (/\b__ninja\b/.test(src)) offenders.push(`${rel}: __ninja`);
        if (/^(public|tools)\//.test(rel) && /joyconNinja\.v1\b/.test(src)) offenders.push(`${rel}: joyconNinja.v1`);
      }
    }
  };
  for (const d of ['public', 'test', 'test-support', 'tools']) walk(d);
  assert.deepEqual(offenders, []);
});

test('identifiers of the old game kept on purpose (other programs depend on them): the bridge header and the input module keys', () => {
  assert.ok(read('server.js').includes(`'X-Joycon-Ninja'`), 'the bridge header');
  assert.ok(read('public/js/input/native-link.js').includes(`'X-Joycon-Ninja'`));
  const input = read('public/js/input/input-config.js');
  for (const key of ['joyconNinja.ble.v1', 'joyconNinja.path.v1', 'joyconNinja.imu.v1']) assert.ok(input.includes(`'${key}'`), key);
});

test('the documents call the game "Clay Rush": the old name survives only on lines about the fork, and only docs/legacy-fruit-dojo/ describes the old game', () => {
  const offenders = [];
  for (const f of ['README.md', 'docs/GUIDE.md', 'docs/architecture.md', 'docs/game-design.md']) {
    read(f).split('\n').forEach((line, i) => {
      if (OLD_NAMES.test(line) && !FORK_TALK.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, []);
  for (const f of ['README.md', 'docs/GUIDE.md']) assert.match(read(f).split('\n')[0], /^# Clay Rush\b/, `${f}: the H1 carries the name`);
  assert.ok(statSync(join(ROOT, 'docs/legacy-fruit-dojo')).isDirectory());
});

test('README.md and the guide describe the optional art layer and the ?assets=0 switch', () => {
  for (const f of ['README.md', 'docs/GUIDE.md']) {
    const text = read(f);
    assert.match(text, /\?assets=0/, `${f}: the switch`);
    assert.match(text, /procedural/i, `${f}: the procedural fallback`);
  }
  assert.match(read('README.md'), /\| `assets` \|/, 'the flag table lists the assets flag');
});
