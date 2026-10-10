/**
 * immiscible evidence ai-act against the real server: the zip and the JSON
 * are saved, a file is never replaced without --force, and a role that
 * cannot read evidence is refused with exit code 6.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { bootServer, person, mintToken, tmp, runCli, inRepo } from './helpers.mjs';

const SKIP = inRepo ? false : 'not inside the Immiscible repository';

test('cli: evidence ai-act saves the pack, refuses to overwrite, and refuses a member', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const s = await bootServer();
  t.after(s.stop);
  const owner = await person(s.base);
  const token = await mintToken(s.base, owner);
  const home = tmp('imm-home-');
  const cli = (args, tok = token) => runCli(['--url', s.base, ...args], { home, cwd: home, env: { IMMISCIBLE_TOKEN: tok } });

  const z = await cli(['evidence', 'ai-act', '--out', 'pack.zip', '--json']);
  assert.equal(z.code, 0, z.stderr + z.stdout);
  assert.equal(z.json.ok, true);
  assert.equal(z.json.chainVerified, true);
  assert.equal(z.json.format, 'zip');
  const bytes = readFileSync(path.join(home, 'pack.zip'));
  assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK');
  assert.ok(bytes.includes(Buffer.from('SUMMARY.md')) && bytes.includes(Buffer.from('immiscible.ai-act-deployer.v1')));

  // Never replaced without --force.
  const again = await cli(['evidence', 'ai-act', '--out', 'pack.zip']);
  assert.equal(again.code, 2, again.stderr);
  assert.match(again.stderr, /already exists/);
  assert.equal((await cli(['evidence', 'ai-act', '--out', 'pack.zip', '--force', '--json'])).code, 0);

  const j = await cli(['evidence', 'ai-act', '--out', 'pack.json']);
  assert.equal(j.code, 0, j.stderr);
  const pack = JSON.parse(readFileSync(path.join(home, 'pack.json'), 'utf8'));
  assert.equal(pack.schema, 'immiscible.ai-act-deployer.v1');
  assert.equal(pack.integrity.chainVerified, true);

  assert.equal((await cli(['evidence', 'nis2'])).code, 2);

  // A member of the same workspace cannot export evidence.
  const other = await person(s.base);
  s.app.accounts.addMember(owner.wid, { id: other.user.id, email: other.email }, 'member');
  const memberToken = await mintToken(s.base, other, owner.wid);
  const refused = await cli(['evidence', 'ai-act', '--out', 'member.zip', '--json'], memberToken);
  assert.equal(refused.code, 6, refused.stdout + refused.stderr);
  assert.equal(refused.json.error.code, 'forbidden');
  assert.equal(existsSync(path.join(home, 'member.zip')), false);
});
