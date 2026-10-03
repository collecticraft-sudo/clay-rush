// Architecture guard tests (written by the architect, owned by the Integrator afterwards).
// They enforce the import rules and purity rules of docs/architecture.md sections 2 and 3 mechanically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = join(ROOT, 'public', 'js');

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function importsOf(src) {
  const code = stripComments(src);
  const specs = [];
  for (const re of [/\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g, /\bexport\s+(?:[\w*{}\s,]+\s+)?from\s+['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of code.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

const CONFIG_FILES = new Set(['game/config.js', 'motion/motion-config.js', 'input/input-config.js']);
const ALLOWED = {
  shared: ['shared'],
  input: ['shared', 'input'],
  motion: ['shared', 'motion'],
  game: ['shared', 'game'],
  render: ['shared', 'render', 'audio', 'ui'],
  audio: ['shared', 'render', 'audio', 'ui'],
  ui: ['shared', 'render', 'audio', 'ui'],
};

const files = walk(JS);

test('every import is relative, explicit (.js) and stays inside the allowed module set', () => {
  const problems = [];
  for (const file of files) {
    const rel = relative(JS, file).split(sep).join('/');
    const top = rel.includes('/') ? rel.split('/')[0] : '(root)';
    const src = readFileSync(file, 'utf8');
    for (const spec of importsOf(src)) {
      if (!spec.startsWith('.')) {
        problems.push(`${rel}: bare or absolute import "${spec}" (no npm, no node:, no CDN)`);
        continue;
      }
      if (!/\.js$/.test(spec)) problems.push(`${rel}: import "${spec}" must end with .js`);
      const target = relative(JS, resolve(dirname(file), spec)).split(sep).join('/');
      if (target.startsWith('..')) {
        problems.push(`${rel}: import "${spec}" leaves public/js`);
        continue;
      }
      const targetTop = target.split('/')[0];
      if (top === '(root)') continue; // main.js may import every module
      if (CONFIG_FILES.has(target)) continue; // data-only config modules are importable everywhere
      if (!ALLOWED[top]?.includes(targetTop)) problems.push(`${rel}: may not import ${target} (module "${top}" may import ${ALLOWED[top]?.join(', ')} and the *-config.js data modules)`);
    }
  }
  assert.deepEqual(problems, []);
});

test('game/, motion/ and shared/ never touch the DOM, storage, network or wall-clock time', () => {
  const banned = [/\bdocument\b/, /\bwindow\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bnavigator\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\brequestAnimationFrame\b/, /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /\bperformance\.now\b/, /\bDate\.now\b/];
  const problems = [];
  for (const file of files) {
    const rel = relative(JS, file).split(sep).join('/');
    if (!/^(game|motion|shared)\//.test(rel)) continue;
    if (rel === 'shared/clock.js') continue; // the one place allowed to read performance
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const re of banned) {
      // Motion may call Date.now() exactly once, to stamp Calibration.createdAt.
      if (re.source.startsWith('\\bDate') && rel.startsWith('motion/')) continue;
      if (re.test(code)) problems.push(`${rel}: forbidden ${re}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('game/ never uses Math.random (seeded RNG only)', () => {
  const problems = [];
  for (const file of files) {
    const rel = relative(JS, file).split(sep).join('/');
    if (!rel.startsWith('game/')) continue;
    if (/\bMath\.random\b/.test(stripComments(readFileSync(file, 'utf8')))) problems.push(rel);
  }
  assert.deepEqual(problems, []);
});

test('magic numbers: the projection focal length 1663 and the gravity 9.81 appear only in shared/world.js (the one camera of C-01)', () => {
  const problems = [];
  for (const file of files) {
    const rel = relative(JS, file).split(sep).join('/');
    if (rel === 'shared/world.js') continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    if (/(?<![\d.])(1663|9\.81)(?![\d])/.test(code)) problems.push(rel);
  }
  assert.deepEqual(problems, []);
});

test('the root files are the five of architecture 2 (app, main, clay-api, flags, wake-lock); ninja-api.js and __ninja are gone', () => {
  const root = readdirSync(JS).filter((n) => /\.js$/.test(n)).sort();
  assert.deepEqual(root, ['app.js', 'clay-api.js', 'flags.js', 'main.js', 'wake-lock.js']);
  const offenders = files.filter((f) => /\b__ninja\b|ninja-api/.test(stripComments(readFileSync(f, 'utf8')))).map((f) => relative(JS, f));
  assert.deepEqual(offenders, []);
  assert.match(readFileSync(join(JS, 'app.js'), 'utf8'), /win\.__clay = clay\.api/);
});

test('the module set of architecture 2: every top-level folder of public/js has its import rule', () => {
  const dirs = readdirSync(JS).filter((n) => statSync(join(JS, n)).isDirectory()).sort();
  assert.deepEqual(dirs, Object.keys(ALLOWED).sort());
});

test('ui/ never imports game/index.js (the best-score helpers are injected by app.js) and game/ never imports render/ or ui/', () => {
  const problems = [];
  for (const file of files) {
    const rel = relative(JS, file).split(sep).join('/');
    for (const spec of importsOf(readFileSync(file, 'utf8'))) {
      const target = relative(JS, resolve(dirname(file), spec)).split(sep).join('/');
      if (rel.startsWith('ui/') && target === 'game/index.js') problems.push(`${rel} -> ${target}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.match(readFileSync(join(JS, 'app.js'), 'utf8'), /bestHelpers: BEST_HELPERS/);
});

test('offline: no external URLs in shipped HTML, CSS or JS code', () => {
  const problems = [];
  const targets = [...files];
  const extra = [join(ROOT, 'public', 'index.html'), join(ROOT, 'public', 'diagnostics.html')].filter(existsSync);
  const cssDir = join(ROOT, 'public', 'css');
  const css = existsSync(cssDir) ? readdirSync(cssDir).filter((n) => n.endsWith('.css')).map((n) => join(cssDir, n)) : [];
  for (const file of [...targets, ...extra, ...css]) {
    const raw = readFileSync(file, 'utf8');
    const code = file.endsWith('.js') ? stripComments(raw) : raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/(src|href)\s*=\s*["']https?:\/\//i.test(code) || /url\(\s*["']?https?:\/\//i.test(code) || /@import\s+["']https?:/i.test(code) || /from\s+["']https?:\/\//.test(code)) {
      problems.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(problems, []);
});
