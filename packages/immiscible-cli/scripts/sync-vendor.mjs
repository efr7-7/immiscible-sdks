#!/usr/bin/env node
/**
 * Copy two files from the TypeScript SDK's build into this package, so the
 * CLI keeps zero dependencies and `immiscible try` and `immiscible verify`
 * run the very code the SDK ships:
 *
 *   ../immiscible-js/dist/esm/testing.js  ->  src/vendor/fake.mjs    (the offline fake)
 *   ../immiscible-js/dist/esm/verify.js   ->  src/vendor/verify.mjs  (the receipt verifier)
 *
 * Runs before packing; test/vendor.test.mjs fails if a copy drifts from the
 * build. Both files import nothing but node: built-ins.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SDK_DIST = join(here, '..', '..', 'immiscible-js', 'dist', 'esm');
export const VENDOR = join(here, '..', 'src', 'vendor');
export const FILES = { 'fake.mjs': 'testing.js', 'verify.mjs': 'verify.js' };
export const HEADER = (from) => `// Copied from @immiscible/sdk (dist/esm/${from}) by scripts/sync-vendor.mjs. Do not edit here.\n`;

/** The vendored text for one SDK build file. */
export const vendored = (from, text) => HEADER(from) + text.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(SDK_DIST)) {
    if (Object.keys(FILES).every((f) => existsSync(join(VENDOR, f)))) {
      console.log(`sync-vendor: ${SDK_DIST} not found; packing the copies in src/vendor as they are`);
      process.exit(0);
    }
    console.error(`sync-vendor: ${SDK_DIST} not found; build packages/immiscible-js first`);
    process.exit(1);
  }
  for (const [to, from] of Object.entries(FILES)) {
    const text = readFileSync(join(SDK_DIST, from), 'utf8');
    if (/^\s*import .* from '(?!node:)/m.test(text)) {
      console.error(`sync-vendor: ${from} imports something other than node: built-ins`);
      process.exit(1);
    }
    writeFileSync(join(VENDOR, to), vendored(from, text));
    console.log(`sync-vendor: copied ${from} to src/vendor/${to}`);
  }
}
