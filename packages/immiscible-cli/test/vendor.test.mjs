/**
 * The CLI carries two files from the TypeScript SDK's build, so it keeps
 * zero dependencies: the offline fake (`try`) and the receipt verifier
 * (`verify`). They must be the SDK's bytes, not a fork. In the public
 * mirror, where the SDK's build is not committed, the copies are checked
 * for their header and their imports only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SDK_DIST, VENDOR, FILES, vendored } from '../scripts/sync-vendor.mjs';

for (const [to, from] of Object.entries(FILES)) {
  test(`src/vendor/${to} is the SDK's dist/esm/${from}`, () => {
    const copy = readFileSync(join(VENDOR, to), 'utf8');
    assert.ok(copy.startsWith(`// Copied from @immiscible/sdk (dist/esm/${from})`));
    for (const m of copy.matchAll(/^\s*import .* from '([^']+)'/gm)) assert.match(m[1], /^node:/, `${to} imports ${m[1]}`);
    const source = join(SDK_DIST, from);
    if (!existsSync(source)) return;
    assert.equal(copy, vendored(from, readFileSync(source, 'utf8')), `run npm run sync in packages/immiscible-cli`);
  });
}
