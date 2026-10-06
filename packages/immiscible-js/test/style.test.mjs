/** House style: no em or en dashes in anything this package or its docs say. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = fileURLToPath(new URL('../../../docs/sdk', import.meta.url));
const DASHES = /[\u2013\u2014]/;
const TEXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.md', '.json']);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (TEXT.has(extname(p))) yield p;
  }
}

test('no em or en dashes in the package or docs/sdk', () => {
  const offenders = [];
  for (const dir of [ROOT, ...(existsSync(DOCS) ? [DOCS] : [])]) {
    for (const f of files(dir)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (DASHES.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});
