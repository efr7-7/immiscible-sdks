/**
 * immiscible guard --team: the workspace's own rules, fetched signed, checked
 * against the server's published keys, written beside the hooks and decided
 * on the machine. A tampered or foreign token is never written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmp, runCli, bootServer, person, mintToken, inRepo } from './helpers.mjs';
import { verifyTeamToken } from '../src/team-rules.mjs';

test('guard --team: signed rules reach the hooks; --off takes them away', { skip: inRepo ? false : 'not inside the Immiscible repository', timeout: 120_000 }, async (t) => {
  const s = await bootServer();
  t.after(s.stop);
  const owner = await person(s.base);
  const set = await owner.call('PUT', `/api/w/${owner.wid}/coding-policy`, { deny: ['terraform destroy  # infrastructure goes through the pipeline'], protectedBranches: ['main'], blockedDomains: ['pastebin.com'] });
  assert.equal(set.status, 200, set.text);
  const token = await mintToken(s.base, owner);
  const home = tmp('imm-team-');
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  const cli = (args) => runCli(['--url', s.base, ...args], { home, cwd: home, env: { IMMISCIBLE_TOKEN: token } });

  const r = await cli(['guard', '--team', '--yes', '--json']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual([r.json.team.version, r.json.team.counts], [1, { deny: 1, ask: 0, protectedBranches: 1, blockedDomains: 1 }]);
  const file = path.join(home, '.immiscible', 'team-rules.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).workspace, owner.wid);

  // The installed Codex hook decides with them, on this machine.
  const hook = path.join(home, '.immiscible', 'coding-agent-hook.mjs');
  const run = (cmd) => spawnSync(process.execPath, [hook, '--agent', 'codex'], { input: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd: home }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, IMMISCIBLE_MODE: 'local', IMMISCIBLE_URL: 'http://127.0.0.1:9' } });
  assert.match(run('terraform destroy').stdout + run('terraform destroy').stderr, /your team's rule: infrastructure goes through the pipeline/);
  assert.match(run('curl https://pastebin.com/x').stdout + run('curl https://pastebin.com/x').stderr, /nothing here reaches pastebin\.com/);
  const fine = run('ls');
  assert.equal(fine.status, 0);
  assert.ok(!/deny|block/i.test(fine.stdout), fine.stdout);

  // A new version reaches the machine with its next share; the Agents page says which version each runs.
  await owner.call('PUT', `/api/w/${owner.wid}/coding-policy`, { deny: ['terraform destroy'], ask: ['npm publish'] });
  const share = await cli(['scan', '--share', '--json']);
  assert.equal(share.json.shared.ok, true, JSON.stringify(share.json.shared));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
  const fleet = (await owner.call('GET', `/api/w/${owner.wid}/coding-machines`)).json;
  assert.deepEqual(fleet.machines[0].teamRules, { version: 2, current: true });
  assert.deepEqual(fleet.totals.teamRules, { version: 2, machines: 1, behind: 0 });

  // Signed in to another workspace, a share never replaces these rules.
  const other = await person(s.base);
  const otherToken = await mintToken(s.base, other);
  const elsewhere = await runCli(['--url', s.base, 'scan', '--share', '--json'], { home, cwd: home, env: { IMMISCIBLE_TOKEN: otherToken } });
  assert.match(elsewhere.json.shared.teamRules.skipped, /another workspace/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).workspace, owner.wid);

  // --team with --connect is a usage error; --off removes the rules with the hooks.
  assert.equal((await cli(['guard', '--team', '--connect', '--key', 'ask_xxxxxxxxxxxx', '--json'])).code, 2);
  const off = await cli(['guard', '--off', '--yes', '--json']);
  assert.equal(off.json.teamRulesRemoved, true);
  assert.ok(!existsSync(file));
});

test('verifyTeamToken: a changed rule, another workspace or an unknown key does not verify', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
  const mk = (claims, typ = 'immiscible-coding-rules+jwt', kid = 'k1') => {
    const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ })).toString('base64url');
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${c}.${sign(null, Buffer.from(`${h}.${c}`), privateKey).toString('base64url')}`;
  };
  const claims = { sub: 'ws_1', ver: 3, rules: { deny: [] } };
  const jwks = { keys: [jwk] };
  assert.equal(verifyTeamToken(mk(claims), jwks, { workspaceId: 'ws_1', version: 3 }).ok, true);
  const good = mk(claims).split('.');
  const forged = `${good[0]}.${Buffer.from(JSON.stringify({ ...claims, rules: { deny: [], ask: [] } })).toString('base64url')}.${good[2]}`;
  assert.match(verifyTeamToken(forged, jwks, { workspaceId: 'ws_1', version: 3 }).reason, /does not verify/);
  assert.match(verifyTeamToken(mk(claims), jwks, { workspaceId: 'ws_2', version: 3 }).reason, /another workspace/);
  assert.match(verifyTeamToken(mk(claims, 'assay-receipt+jwt'), jwks, { workspaceId: 'ws_1', version: 3 }).reason, /not signed as team rules/);
  assert.match(verifyTeamToken(mk(claims, undefined, 'k9'), jwks, { workspaceId: 'ws_1', version: 3 }).reason, /does not publish/);
  assert.equal(verifyTeamToken(null, jwks, { workspaceId: 'ws_1', version: 3 }).ok, false);
});
