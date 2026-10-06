#!/usr/bin/env node
/**
 * Copy the hook from the repository (scripts/claude-code-hook.mjs, the file a
 * running server also serves at /downloads/claude-code-hook.mjs) into this
 * package, so the published package carries the same bytes. Runs before
 * packing; test/hook.test.mjs fails if the two drift apart.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', '..', 'scripts', 'claude-code-hook.mjs');
const target = join(here, '..', 'hook', 'claude-code-hook.mjs');
if (!existsSync(source)) {
  // The public packages mirror carries packages/ only: pack the copy already here.
  if (existsSync(target)) {
    console.log(`sync-hook: ${source} not found; packing the copy in hook/ as it is`);
    process.exit(0);
  }
  console.error(`sync-hook: ${source} not found; run this inside the repository`);
  process.exit(1);
}
copyFileSync(source, target);
console.log(`sync-hook: copied ${source} to ${target}`);
