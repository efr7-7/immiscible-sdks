#!/usr/bin/env node
/**
 * Copy the hooks from the repository into this package, so the published
 * package carries the same bytes: scripts/claude-code-hook.mjs (the file a
 * running server also serves at /downloads/claude-code-hook.mjs) and
 * scripts/coding-agent-hook.mjs (Codex, Cursor, Windsurf and Gemini CLI).
 * Runs before packing; the tests fail if the copies drift apart.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const name of ['claude-code-hook.mjs', 'coding-agent-hook.mjs']) {
  const source = join(here, '..', '..', '..', 'scripts', name);
  const target = join(here, '..', 'hook', name);
  if (!existsSync(source)) {
    // The public packages mirror carries packages/ only: pack the copy already here.
    if (existsSync(target)) {
      console.log(`sync-hook: ${source} not found; packing the copy in hook/ as it is`);
      continue;
    }
    console.error(`sync-hook: ${source} not found; run this inside the repository`);
    process.exit(1);
  }
  copyFileSync(source, target);
  console.log(`sync-hook: copied ${source} to ${target}`);
}
