/**
 * immiscible policy replay against the real server: the draft is sent, the
 * replay comes back, a draft that does not validate is refused plainly, and
 * nothing needs an agent key. The replay itself is tested in the server's
 * test/policy-replay.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { bootServer, person, mintToken, tmp, runCli, inRepo } from './helpers.mjs';

const SKIP = inRepo ? false : 'not inside the Immiscible repository';

test('cli: policy replay sends the draft and reads the replay back', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const s = await bootServer();
  t.after(s.stop);
  const owner = await person(s.base);
  const token = await mintToken(s.base, owner);
  const home = tmp('imm-policy-');
  const cli = (args) => runCli(['--url', s.base, ...args], { home, cwd: home, env: { IMMISCIBLE_TOKEN: token } });
  const made = await cli(['init', '--name', 'Replay bot', '--purpose', 'other', '--yes', '--no-hook', '--no-test', '--json']);
  assert.equal(made.code, 0, made.stderr + made.stdout);

  writeFileSync(path.join(home, 'draft.json'), JSON.stringify({ template: 'coding_agent_baseline' }));
  const r = await cli(['policy', 'replay', '--file', 'draft.json', '--since', '7d', '--exclusive', '--json']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.json.exclusive, true);
  assert.equal(r.json.drafts[0].title, 'Coding agent baseline');
  assert.equal(typeof r.json.requests, 'number');
  assert.match(r.json.note, /Nothing is stored or signed/);

  const text = await cli(['policy', 'replay', '--file', 'draft.json']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Policy replay/);

  writeFileSync(path.join(home, 'bad.json'), JSON.stringify([{ kind: 'payment', title: 'x', currency: 'GBP', perTransaction: -1, perPeriod: 1, period: 'week' }]));
  const bad = await cli(['policy', 'replay', '--file', 'bad.json']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /mandates\[0\]: perTransaction/i);

  assert.equal((await cli(['policy', 'replay'])).code, 2, 'no --file');
  assert.equal((await cli(['policy', 'apply', '--file', 'draft.json'])).code, 2, 'unknown command');
});
