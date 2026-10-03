// Loader for the shared parser test vectors (docs/joycon2-test-vectors.json). Test helper of the input engineer.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToBytes } from '../../public/js/input/joycon2-parse.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const VECTORS = JSON.parse(readFileSync(join(ROOT, 'docs', 'joycon2-test-vectors.json'), 'utf8'));

/** @returns {{id:string, side:string, hex:string, bytes:Uint8Array, expected:object}} */
export function vector(idPrefix) {
  const v = VECTORS.vectors.find((x) => x.id.startsWith(idPrefix));
  if (!v) throw new Error(`no vector ${idPrefix}`);
  return { ...v, bytes: hexToBytes(v.hex) };
}
