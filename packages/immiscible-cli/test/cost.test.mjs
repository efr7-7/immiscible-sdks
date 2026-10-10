/**
 * immiscible cost: sessions from two vendors on one branch roll up to one
 * row, with both vendors listed; a session with nothing to attribute it to
 * is unattributed, not zero; pull requests come from gh.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { runCli, tmp, bootServer, person, mintToken, inRepo } from './helpers.mjs';
import { claudeSession, codexSession } from './history-fixtures.mjs';
import { ticketOf } from '../src/commands/cost.mjs';

const projectDirName = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function home() {
  const now = Date.now();
  const h = tmp('imm-cost-');
  const repo = path.join(h, 'work', 'payments-api');
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  const cdir = path.join(h, '.claude', 'projects', projectDirName(repo));
  mkdirSync(cdir, { recursive: true });
  const calls = [{ name: 'Bash', input: { command: 'npm test' } }];
  writeFileSync(path.join(cdir, 'c1.jsonl'), claudeSession({ id: 'c1', cwd: repo, branch: 'feature/refunds', at: now - 3600000, calls }));
  writeFileSync(path.join(cdir, 'c2.jsonl'), claudeSession({ id: 'c2', cwd: repo, branch: 'eng-42-ledger', at: now - 7200000, calls }));
  writeFileSync(path.join(cdir, 'c3.jsonl'), claudeSession({ id: 'c3', cwd: repo, branch: 'HEAD', at: now - 9000000, calls }));
  const d = new Date(now - 5400000);
  const xdir = path.join(h, '.codex', 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  mkdirSync(xdir, { recursive: true });
  writeFileSync(path.join(xdir, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-x1.jsonl`), codexSession({ id: 'x1', cwd: repo, at: now - 5400000, commands: [['npm', 'test']] }));
  // A stand-in for the GitHub CLI.
  const bin = path.join(h, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho '${JSON.stringify([{ number: 7, title: 'Refunds', headRefName: 'feature/refunds', state: 'MERGED', mergedAt: '2026-10-09T10:00:00Z', url: 'https://github.com/example/payments-api/pull/7' }])}'\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  return { h, repo, bin };
}

test('ticketOf: keys in branch names and titles, not version numbers or words', () => {
  assert.equal(ticketOf('eng-42-ledger'), 'ENG-42');
  assert.equal(ticketOf('feature/PROJ-1234-thing'), 'PROJ-1234');
  assert.equal(ticketOf('eoin/abc-9'), 'ABC-9');
  assert.equal(ticketOf('release-2026-10'), null);
  assert.equal(ticketOf('node-22-upgrade'), null);
  assert.equal(ticketOf('feature/refunds'), null);
  assert.equal(ticketOf(null, 'OPS-17: fix the thing'), 'OPS-17');
});

test('cost by branch: two vendors on one branch are one row with both listed; the rest is unattributed, not zero', async () => {
  const { h } = home();
  const r = await runCli(['cost', '--json'], { cwd: h, home: h });
  assert.equal(r.code, 0, r.stderr);
  const refunds = r.json.rows.find((x) => x.label === 'payments-api feature/refunds');
  assert.ok(refunds, JSON.stringify(r.json.rows));
  assert.deepEqual(refunds.agents, ['claude-code', 'codex']);
  assert.equal(refunds.sessions, 2);
  assert.ok(refunds.micros > 0);
  const un = r.json.rows.at(-1);
  assert.equal(un.attributed, false);
  assert.equal(un.label, 'unattributed');
  assert.ok(un.micros > 0, 'unattributed carries its cost');
  assert.equal(r.json.rows.reduce((a, x) => a + x.micros, 0), r.json.totalMicros);

  const text = await runCli(['cost', '--csv', 'costs.csv'], { cwd: h, home: h });
  assert.match(text.stdout, /payments-api feature\/refunds +\$\d+\.\d+ +2 sessions +Claude Code, Codex/);
  assert.match(text.stdout, /unattributed \(no branch recorded\)/);
  const csv = readFileSync(path.join(h, 'costs.csv'), 'utf8');
  assert.match(csv, /^group,repository,cost_usd,sessions,agents/);
  assert.match(csv, /payments-api feature\/refunds,payments-api,\d+\.\d{4},2,claude-code codex,no/);
});

test('cost by ticket, by pr (through gh), and the usage errors', async () => {
  const { h, bin } = home();
  const t = await runCli(['cost', '--by', 'ticket', '--json'], { cwd: h, home: h });
  assert.deepEqual(t.json.rows.map((x) => x.label), ['ENG-42', 'unattributed']);

  const pr = await runCli(['cost', '--by', 'pr', '--json'], { cwd: h, home: h, env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(pr.code, 0, pr.stderr);
  const row = pr.json.rows.find((x) => x.pr?.number === 7);
  assert.equal(row.label, 'payments-api #7 Refunds');
  assert.deepEqual(row.agents, ['claude-code', 'codex']);
  assert.equal(row.pr.mergedAt, '2026-10-09T10:00:00Z');

  const noGh = await runCli(['cost', '--by', 'pr'], { cwd: h, home: h, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(noGh.code, 0);
  assert.match(noGh.stdout, /gh\) is missing or not signed in/);

  assert.equal((await runCli(['cost', '--by', 'colour'], { cwd: h, home: h })).code, 2);
});

test('cost --share and --team: two people, two vendors, one pull request; isolated by workspace', { skip: inRepo ? false : 'not inside the Immiscible repository', timeout: 120_000 }, async (t) => {
  const s = await bootServer();
  t.after(s.stop);
  const owner = await person(s.base);
  const token = await mintToken(s.base, owner);
  const a = home();
  const b = home();
  spawnSync('git', ['-C', a.repo, 'remote', 'add', 'origin', 'git@github.com:example/payments-api.git']);
  spawnSync('git', ['-C', b.repo, 'remote', 'add', 'origin', 'https://token:x@github.com/example/payments-api.git']);
  const cli = (who, args) => runCli(['--url', s.base, ...args], { cwd: who.h, home: who.h, env: { IMMISCIBLE_TOKEN: token, PATH: `${who.bin}:${process.env.PATH}` } });

  const one = await cli(a, ['cost', '--share', '--json']);
  assert.equal(one.code, 0, one.stderr + one.stdout);
  assert.equal(one.json.shared.sessions, 4);
  assert.equal((await cli(a, ['cost', '--share', '--json'])).json.shared.sessions, 4, 'sharing again replaces, it does not add');
  // Someone else on the team (the same history shape, a different machine) shares too.
  const other = await mintToken(s.base, owner);
  const two = await runCli(['--url', s.base, 'cost', '--share', '--json'], { cwd: b.h, home: b.h, env: { IMMISCIBLE_TOKEN: other, PATH: `${b.bin}:${process.env.PATH}` } });
  assert.equal(two.code, 0, two.stderr);

  const team = await cli(a, ['cost', '--team', '--json']);
  assert.equal(team.code, 0, team.stderr);
  assert.equal(team.json.by, 'pr');
  const pr7 = team.json.rows.find((x) => x.pr?.number === 7);
  assert.equal(pr7.label, 'github.com/example/payments-api #7 Refunds', 'the repository by its remote, without credentials');
  assert.deepEqual(pr7.agents, ['claude-code', 'codex']);
  assert.equal(pr7.sessions, 2, 'a session shared twice, from either machine, counts once');
  assert.equal(team.json.merged.count, 1);
  assert.equal(team.json.rows.at(-1).attributed, false, 'what has no pull request is unattributed, not zero');
  assert.ok(team.json.rows.at(-1).micros > 0);
  const stored = JSON.stringify(s.app.db.all('SELECT * FROM coding_sessions'));
  assert.ok(!stored.includes('token:x') && !stored.includes('npm test'), 'no credential, command or prompt is stored');

  const ticket = await cli(a, ['cost', '--team', '--by', 'ticket', '--json']);
  assert.ok(ticket.json.rows.some((x) => x.label === 'ENG-42'));
  const csv = await owner.call('GET', `/api/w/${owner.wid}/coding-cost?format=csv`);
  assert.match(csv.text, /^group,repository,cost_usd,sessions,agents,people/);

  // Another workspace sees none of it.
  const stranger = await person(s.base);
  const st = await mintToken(s.base, stranger);
  const none = await runCli(['--url', s.base, 'cost', '--team', '--json'], { cwd: a.h, home: a.h, env: { IMMISCIBLE_TOKEN: st } });
  assert.deepEqual(none.json.rows, []);
  assert.equal((await stranger.call('GET', `/api/w/${owner.wid}/coding-cost`)).status, 404);

  // A read-only token reads the team's cost but cannot write to it, nor report a scan.
  const ro = await fetch(`${s.base}/v1/cli/tokens`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ci', readOnly: true, expiresInDays: 1 }) }).then((r) => r.json());
  const roPost = (p, body) => fetch(`${s.base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${ro.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await roPost('/v1/cli/coding-cost', { sessions: [] })).error.type, 'missing_scope');
  assert.equal((await roPost('/v1/cli/agent-config/report', { repo: 'github.com/example/x', items: [] })).error.type, 'missing_scope');
  assert.equal((await fetch(`${s.base}/v1/cli/coding-cost`, { headers: { authorization: `Bearer ${ro.token}` } })).status, 200);
});
