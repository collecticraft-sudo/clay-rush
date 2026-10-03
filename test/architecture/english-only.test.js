// English-only guard (owner decision, 2026-09-30: "the game must be all in English"). The first version of the game showed Italian text;
// this test scans everything a player or the owner can read, and everything the game ships, for Italian words and accented vowels:
//   public/ (HTML, CSS, every script: strings, renderer texts, diagnostics page, comments), bridge/ sources, server.js, start.command,
//   package.json, README.md, docs/ (the guides, the reports and the QA scripts of docs/qa; the pictures are not text) and the tests themselves.
// The detector and its word list are in test-support/ui/italian-leaks.js; test/ui/strings.test.js applies the same detector to STRINGS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findItalian } from '../../test-support/ui/italian-leaks.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXT_EXT = /\.(js|mjs|html|css|md|json|sh|command|m|plist)$/;
const SKIP_DIRS = new Set(['node_modules', 'build', 'img', '.git']); // pictures (img, the .jpg files under docs/qa) are not text; the QA scripts under docs/qa are

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...filesUnder(rel));
    else if (TEXT_EXT.test(name) || name === 'start.command') out.push(rel);
  }
  return out;
}

// the two files that hold Italian on purpose: the word list of the detector and the test that proves the detector still catches Italian
const ITALIAN_ON_PURPOSE = new Set(['test-support/ui/italian-leaks.js', 'test/ui/strings.test.js']);

const SCANNED = [
  ...filesUnder('public'),
  'bridge/manager.js', 'bridge/joycon-bridge.m', 'bridge/build.sh', 'bridge/Info.plist',
  'server.js', 'start.command', 'package.json', 'README.md',
  ...filesUnder('docs').filter((f) => /\.(md|mjs|js)$/.test(f)), // the guides, the reports and the QA scripts of docs/qa
  ...filesUnder('test').filter((f) => !ITALIAN_ON_PURPOSE.has(f)), // the tests too: their titles and expectations are English
  ...filesUnder('test-support').filter((f) => !ITALIAN_ON_PURPOSE.has(f)),
].filter((f) => existsSync(join(ROOT, f)));

test('the scan covers the game, the bridge, the launcher and the documents', () => {
  for (const f of ['public/index.html', 'public/diagnostics.html', 'public/js/ui/strings.en.js', 'public/js/input/diagnostics-page.js', 'public/js/render/world.js', 'public/js/render/hud.js', 'public/js/app.js', 'public/js/clay-api.js', 'server.js', 'start.command', 'README.md', 'docs/GUIDE.md', 'docs/game-design.md', 'docs/architecture.md']) {
    assert.ok(SCANNED.includes(f), `${f} is scanned`);
  }
  assert.ok(SCANNED.length >= 100, `${SCANNED.length} files`);
});

test('no Italian word and no accented vowel anywhere in public/, bridge/, server.js, start.command, package.json, README.md, docs/, test/ and test-support/', () => {
  const leaks = [];
  for (const f of SCANNED) {
    readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      const hits = findItalian(line);
      if (hits.length) leaks.push(`${f}:${i + 1}: ${hits.join(', ')}  |  ${line.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(leaks, []);
});

test('no leftover of the Italian locale: module name, page language, it-IT formatting, decimal comma, and the switches read ON and OFF, not Yes and No', () => {
  assert.equal(existsSync(join(ROOT, 'public/js/ui/strings.it.js')), false, 'the module is strings.en.js now');
  assert.equal(existsSync(join(ROOT, 'public/js/ui/strings.en.js')), true);
  for (const f of ['public/index.html', 'public/diagnostics.html']) assert.match(readFileSync(join(ROOT, f), 'utf8'), /<html lang="en">/, `${f} declares English`);
  // the switches read ON and OFF (display capitals: Bebas Neue has capitals only), not Yes and No
  const strings = readFileSync(join(ROOT, 'public/js/ui/strings.en.js'), 'utf8');
  assert.match(strings, /'settings\.on': 'ON',/);
  assert.match(strings, /'settings\.off': 'OFF',/);
  const offenders = [];
  for (const f of filesUnder('public').filter((x) => x.endsWith('.js') || x.endsWith('.html'))) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    if (/\bit-IT\b|lang="it"|formatDecimalIt/.test(src)) offenders.push(`${f}: Italian locale`);
    if (/\.replace\(\s*['"]\.['"]\s*,\s*['"],['"]\s*\)/.test(src)) offenders.push(`${f}: decimal comma`);
    if (/\btoLocale\w*\(\s*['"]it/.test(src)) offenders.push(`${f}: toLocale... with an Italian locale`);
  }
  assert.deepEqual(offenders, []);
});
