// Keeps docs/architecture.md, contracts.js and package.json in sync (architect, owned by the Integrator afterwards).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findItalian } from '../../test-support/ui/italian-leaks.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('contracts.js keeps its <typedefs> block, and architecture.md points at contracts.js as the canonical source', () => {
  // (architecture.md v1.0 has no embedded copy of the typedefs any more: it names contracts.js as the contract, see its header table)
  const src = read('public/js/shared/contracts.js');
  const m = src.match(/\/\/ <typedefs>\n([\s\S]*?)\/\/ <\/typedefs>/);
  assert.ok(m, 'contracts.js must contain the <typedefs> markers');
  for (const name of ['Shot', 'GameSnapshot', 'RoundResult', 'Game']) assert.match(m[1], new RegExp(`@typedef \\{Object\\} ${name}\\b`), name);
  assert.match(read('docs/architecture.md'), /public\/js\/shared\/contracts\.js/);
});

test('package.json follows the project constraints', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.scripts.start && pkg.scripts.test, 'scripts start and test are required');
  assert.match(pkg.scripts.test, /^node --test\b/);
  assert.equal(pkg.dependencies, undefined, 'zero runtime dependencies');
  assert.equal(pkg.devDependencies, undefined, 'zero dev dependencies');
});

test('required project documents exist', () => {
  for (const f of ['README.md', 'docs/architecture.md', 'docs/contract-notes.md', 'docs/joycon2-protocol.md', 'docs/game-design.md', 'docs/joycon2-test-vectors.json', 'docs/GUIDE.md', 'docs/hardware-findings.md', 'docs/native-bridge.md', 'docs/legacy-fruit-dojo/protocol-audit.md']) {
    assert.ok(existsSync(join(ROOT, f)), `${f} is missing`);
  }
});

test('every section reference in architecture.md points at an existing heading', () => {
  const doc = read('docs/architecture.md');
  const headings = new Set([...doc.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\b/gm)].map((m) => m[1]));
  const own = doc.replace(/`([^`]*)`/g, (_m, inner) => (/docs\//.test(inner) ? inner : '')); // keep file names of the other documents
  const bad = [];
  for (const m of own.matchAll(/(?<![\w./-])(?:section|sections|see) (\d+(?:\.\d+)?)(?![\d.]*\s*(?:of the design|of the protocol))/gi)) {
    const ref = m[1];
    const context = own.slice(Math.max(0, m.index - 45), m.index + m[0].length + 30);
    if (/design|protocol/i.test(context)) continue; // references into the other two documents (they are named in the same sentence)
    if (!headings.has(ref)) bad.push(`${ref} (in "${context.replace(/\s+/g, ' ')}")`);
  }
  assert.deepEqual(bad, []);
});

// ---- documentation checks added by the Integrator: the owner asked for the documents in English, and the links must work

const DOCS = ['README.md', 'docs/architecture.md', 'docs/contract-notes.md', 'docs/game-design.md', 'docs/joycon2-protocol.md', 'docs/GUIDE.md'];

test('documents are written in English, and so is every text of the game (no Italian word, no accented vowel)', () => {
  const EN = /\b(the|and|is|of|to|with|that|for|this|are|you|when|if|it|in|on|by|not)\b/g;
  const problems = [];
  for (const f of DOCS) {
    const text = read(f);
    const en = (text.toLowerCase().match(EN) ?? []).length;
    const min = f === 'README.md' ? 100 : 200; // the README is the short version on purpose
    if (en < min) problems.push(`${f}: only ${en} English markers`);
    // the UI language changed to English on 2026-09-30: the documents quote English labels, so no Italian may be left at all
    text.split('\n').forEach((line, i) => {
      const hits = findItalian(line);
      if (hits.length) problems.push(`${f}:${i + 1}: ${hits.join(', ')}`);
    });
  }
  assert.deepEqual(problems, []);
});

test('relative links in README.md and the guide point at files and headings that exist', () => {
  const slug = (h) => h.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9_\- ]/g, '').trim().replace(/ /g, '-');
  const headings = (file) => new Set([...read(file).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
  const problems = [];
  for (const f of ['README.md', 'docs/GUIDE.md']) {
    for (const m of read(f).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split('#');
      const file = path === '' ? f : join(dirname(f), path).replace(/\\/g, '/');
      if (!existsSync(join(ROOT, file))) {
        problems.push(`${f}: ${target} -> missing file ${file}`);
        continue;
      }
      if (anchor && file.endsWith('.md') && !headings(file).has(anchor)) problems.push(`${f}: ${target} -> no heading "${anchor}" in ${file}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('README.md never claims verified hardware behaviour and points at the guide\'s HARDWARE CHECKLIST and its UNVERIFIED-ON-HARDWARE section', () => {
  const readme = read('README.md');
  assert.match(readme, /UNVERIFIED-ON-HARDWARE/);
  assert.match(readme, /\]\(docs\/GUIDE\.md#\d+-hardware-checklist\)/, 'the README must link to the HARDWARE CHECKLIST of the guide');
  const guide = read('docs/GUIDE.md');
  assert.match(guide, /^## \d+\. UNVERIFIED-ON-HARDWARE$/m);
  assert.match(guide, /nothing about shooting was tried on a real Joy-Con 2/i);
  for (const f of ['README.md', 'docs/GUIDE.md']) assert.doesNotMatch(read(f), /works on the Joy-Con/i, `${f}: never "works on the Joy-Con" (architecture, hardware honesty)`);
});

test('docs/GUIDE.md has a HARDWARE CHECKLIST that lists every UNVERIFIED-ON-HARDWARE item of the code, the protocol document, the audit and the design', () => {
  const guide = read('docs/GUIDE.md');
  const start = guide.search(/^## \d+\. HARDWARE CHECKLIST$/m);
  assert.ok(start >= 0, 'the guide needs a "## N. HARDWARE CHECKLIST" section');
  const rest = guide.slice(start + 10);
  const next = rest.search(/^## /m);
  const checklist = next < 0 ? rest : rest.slice(0, next);
  // ids used anywhere in the code (public/, server.js, start.command) or in the three research documents
  const ids = new Set();
  const addIds = (text) => { for (const m of text.matchAll(/\b(UOH-\d+|HW-\d+)\b/g)) ids.add(m[1]); };
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(js|html|css)$/.test(e.name)) addIds(read(rel));
    }
  };
  walk('public');
  for (const f of ['server.js', 'start.command', 'docs/joycon2-protocol.md', 'docs/game-design.md', 'docs/native-bridge.md']) addIds(read(f));
  for (const m of read('docs/legacy-fruit-dojo/protocol-audit.md').matchAll(/^### (F\d+) /gm)) ids.add(m[1]);
  assert.ok(ids.size >= 30, `found only ${ids.size} ids: the scan is broken`);
  const missing = [...ids].filter((id) => !new RegExp(`\\b${id}\\b`).test(checklist));
  assert.deepEqual(missing, [], 'these items are tagged UNVERIFIED-ON-HARDWARE but missing from the HARDWARE CHECKLIST of docs/GUIDE.md');
  assert.ok(/UNVERIFIED-ON-HARDWARE/.test(checklist));
});
