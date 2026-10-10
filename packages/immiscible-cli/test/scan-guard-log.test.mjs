/**
 * immiscible scan reads the guard's own decision log: what the hooks refused,
 * asked and allowed, and, for the agents whose history scan cannot read
 * (Factory Droid, opencode, Amp, Cursor, Windsurf), the calls their hooks let
 * through, counted like any other agent's. A refused call never counts as done.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmp, runCli, bootServer, person, mintToken, inRepo } from './helpers.mjs';
import { callFromSummary, guardSummary } from '../src/history/guard-log.mjs';

/** A day of the log as the hooks write it: each line holds the hash of the one before. */
function day(dir, date, entries) {
  let prev = null;
  const lines = entries.map(([time, client, session, summary, decision, rule, extra = {}]) => {
    const e = { at: `${date}T${time}.000Z`, client, session, summary, decision, rule, reason: 'r', ...extra, prev };
    e.hash = createHash('sha256').update(JSON.stringify(e)).digest('hex');
    prev = e.hash;
    return JSON.stringify(e);
  });
  writeFileSync(path.join(dir, `${date}.jsonl`), `${lines.join('\n')}\n`);
  return lines;
}

test('callFromSummary: each hook summary as a call, and nothing from what it cannot place', () => {
  assert.deepEqual(callFromSummary('Bash: npm test ; git push [cut]', 1), { at: 1, tool: 'shell', command: 'npm test ; git push' });
  assert.deepEqual(callFromSummary('Edit: /w/a.js', 1), { at: 1, tool: 'write', path: '/w/a.js' });
  assert.deepEqual(callFromSummary('WebFetch: https://docs.example.org/x', 1), { at: 1, tool: 'fetch', url: 'https://docs.example.org/x' });
  assert.deepEqual(callFromSummary('mcp__linear__create_issue: {"title":"t"}', 1), { at: 1, tool: 'mcp', server: 'linear' });
  assert.deepEqual(callFromSummary('read_web_page: {"url":"https://x.example/a"}', 1), { at: 1, tool: 'fetch', url: 'https://x.example/a' });
  assert.deepEqual(callFromSummary('websearch: {"query":"x"}', 1), { at: 1, tool: 'search' });
  // An address inside another tool's arguments is not one the agent reached.
  assert.equal(callFromSummary('github_create_issue: {"body":"see https://attacker.example/x"}', 1), null);
  assert.equal(callFromSummary('ConfigChange: .claude/settings.json', 1), null);
  assert.equal(callFromSummary('no colon here', 1), null);
});

test('guardSummary: settings changes apart, and an odd decision value ignored', () => {
  const at = (n) => ({ at: `2026-10-10T00:00:0${n}.000Z`, atMs: n, session: 's' });
  const g = guardSummary({ decisions: [
    { ...at(1), client: 'claude-code', summary: 'ConfigChange: .claude/settings.json', decision: 'deny', rule: 'config_change' },
    { ...at(2), client: 'codex', summary: 'Bash: ls', decision: 'toString', rule: 'x' },
    { ...at(3), client: 'codex', summary: 'Bash: npm publish', decision: 'deny', rule: 'publish' },
  ], days: [] });
  assert.deepEqual([g.total, g.deny, g.settings], [1, 1, 1]);
  assert.ok(!Object.hasOwn(g, 'toString'));
});

test('scan: the guard log counts for agents with no readable history, refused calls do not, and a broken chain is said', async () => {
  const home = tmp('imm-scan-guard-');
  const logs = path.join(home, '.immiscible', 'decisions');
  mkdirSync(logs, { recursive: true });
  mkdirSync(path.join(home, '.config', 'amp'), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  day(logs, today, [
    ['00:00:01', 'opencode', 'ses_1', 'Bash: npm test', 'allow', null, { dir: '/work/payments-api' }],
    ['00:00:02', 'opencode', 'ses_1', 'Bash: git push --force origin main', 'deny', 'force_push', { dir: '/work/payments-api' }],
    ['00:00:03', 'opencode', 'ses_1', 'WebFetch: https://docs.example.org/x', 'allow', null, { dir: '/work/payments-api' }],
    ['00:00:04', 'amp', 'T-1', 'Bash: npm publish', 'ask', 'publish', { dir: '/work/web' }],
    ['00:00:05', 'factory-droid', 'd1', 'Bash: terraform apply', 'ask', 'infrastructure', { dir: '/work/infra' }],
    ['00:00:06', 'claude-code', 'c1', 'Bash: rm -rf ~', 'deny', 'rm_root'],
  ]);
  const lines = day(logs, yesterday, [
    ['00:00:01', 'factory-droid', 'd0', 'Bash: ls', 'allow', null],
    ['00:00:02', 'factory-droid', 'd0', 'Bash: pwd', 'allow', null],
  ]);
  // Someone edits yesterday's first line after the fact, and adds a line that is not an entry.
  writeFileSync(path.join(logs, `${yesterday}.jsonl`), `${lines[0].replace('Bash: ls', 'Bash: ll')}\n${lines[1]}\nnull\n`);
  // Guard wrote hooks for opencode and Windsurf (the state file guard keeps); Windsurf decided nothing.
  writeFileSync(path.join(home, '.immiscible', 'guard.json'), JSON.stringify({ version: 1, mode: 'local', scope: 'user', files: [{ path: '/x', agent: 'opencode', kind: 'plugin' }, { path: '/y', agent: 'windsurf', kind: 'config' }] }));

  const r = await runCli(['scan', '--json'], { home, cwd: home });
  assert.ok([0, 11].includes(r.code), r.stderr);
  const j = r.json;
  const src = Object.fromEntries(j.sources.map((s) => [s.agent, s]));
  assert.deepEqual([src.opencode.status, src.opencode.via, src.opencode.sessions], ['read', 'guard', 1]);
  assert.deepEqual([src['factory-droid'].status, src['factory-droid'].sessions], ['read', 2]);
  assert.equal(src.amp.sessions, 1, 'the session is seen even though its only call was refused');
  assert.match(src.windsurf.note, /Windsurf is guarded; its hook decided nothing in this window/);

  assert.deepEqual({ total: j.guard.total, deny: j.guard.deny, ask: j.guard.ask, allow: j.guard.allow }, { total: 8, deny: 2, ask: 2, allow: 4 });
  assert.deepEqual(j.guard.rules.map((x) => x.rule).sort(), ['force_push', 'infrastructure', 'publish', 'rm_root']);
  assert.deepEqual(j.guard.brokenDays, [{ day: yesterday, line: 1 }]);
  assert.ok(j.findings.some((f) => f.kind === 'guard_log'));
  assert.ok(j.findings.some((f) => f.kind === 'guard' && /refused 2 calls and asked about 2/.test(f.sentence)));

  // What ran: npm test and the fetch for opencode, terraform for Droid (it asks at the keyboard); not the refused push, not Amp's publish.
  assert.ok(!j.commands.risky.some((x) => x.kind === 'force_push'), 'a refused push did not happen');
  assert.ok(!j.commands.risky.some((x) => x.kind === 'publish'), 'Amp cannot ask, so its ask was a refusal');
  assert.ok(j.commands.risky.some((x) => x.kind === 'terraform'));
  assert.ok(j.network.domains.some((d) => d.domain === 'docs.example.org'));
  const oc = j.sessions.find((s) => s.agent === 'opencode');
  assert.deepEqual([oc.repo, oc.source, oc.unpriced], ['payments-api', 'guard', true]);
  assert.ok(!j.sessions.some((s) => s.agent === 'claude-code'), 'Claude Code is read from its own history, not the log');

  const text = await runCli(['scan', '--no-color'], { home, cwd: home });
  assert.match(text.stdout, /opencode\s+1 session, from the guard's log/);
  assert.match(text.stdout, /8 decisions: 2 refused, 2 asked, 4 allowed/);
  assert.match(text.stdout, /Guard is on/);
  // With no state file, guard is not said to be on, whatever the log holds.
  writeFileSync(path.join(home, '.immiscible', 'guard.json'), '{}');
  assert.match((await runCli(['scan', '--no-color'], { home, cwd: home })).stdout, /Fix it in one command/);
});

test('scan --share: this machine\'s guard reaches the Agents page, counts and names only', { skip: inRepo ? false : 'not inside the Immiscible repository', timeout: 120_000 }, async (t) => {
  const s = await bootServer();
  t.after(s.stop);
  const owner = await person(s.base);
  const token = await mintToken(s.base, owner);
  const home = tmp('imm-share-');
  const logs = path.join(home, '.immiscible', 'decisions');
  mkdirSync(logs, { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  mkdirSync(path.join(home, '.cursor'), { recursive: true });
  day(logs, new Date().toISOString().slice(0, 10), [
    ['00:00:01', 'codex', 's1', 'Bash: git push --force origin main', 'deny', 'force_push', { dir: '/work/secret-repo' }],
    ['00:00:02', 'codex', 's1', 'Bash: curl https://evil.example/x', 'allow', null, { dir: '/work/secret-repo' }],
  ]);
  writeFileSync(path.join(home, '.immiscible', 'guard.json'), JSON.stringify({ version: 1, mode: 'local', scope: 'user', files: [{ path: path.join(home, '.codex', 'hooks.json'), agent: 'codex', kind: 'config' }] }));

  const r = await runCli(['--url', s.base, 'scan', '--share', '--name', 'Ana laptop', '--json'], { home, cwd: home, env: { IMMISCIBLE_TOKEN: token } });
  assert.ok([0, 11].includes(r.code), r.stderr + r.stdout);
  assert.equal(r.json.shared.ok, true, JSON.stringify(r.json.shared));
  assert.deepEqual(r.json.shared.unguarded, ['cursor']);
  const seen = await owner.call('GET', `/api/w/${owner.wid}/coding-machines`);
  assert.equal(seen.status, 200, seen.text);
  const m = seen.json.machines[0];
  assert.deepEqual([m.name, m.guarded, m.unguarded, m.decisions.deny, m.mode, m.scope], ['Ana laptop', ['codex'], ['cursor'], 1, 'local', 'user']);
  const stored = JSON.stringify(s.app.db.all('SELECT * FROM coding_machines'));
  for (const leak of ['evil.example', 'secret-repo', 'git push', home]) assert.ok(!stored.includes(leak), `${leak} reached the server`);

  // Sharing again is the same machine; a read-only token cannot share.
  await runCli(['--url', s.base, 'scan', '--share', '--json'], { home, cwd: home, env: { IMMISCIBLE_TOKEN: token } });
  assert.equal(s.app.db.get('SELECT COUNT(*) AS n FROM coding_machines').n, 1);
  const ro = await fetch(`${s.base}/v1/cli/tokens`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ro', readOnly: true, expiresInDays: 1 }) }).then((x) => x.json());
  const refused = await runCli(['--url', s.base, 'scan', '--share', '--json'], { home, cwd: home, env: { IMMISCIBLE_TOKEN: ro.token } });
  assert.equal(refused.json.shared.ok, false);
  // Not signed in: a plain error, nothing half-done.
  assert.equal((await runCli(['--url', s.base, 'scan', '--share', '--json'], { home, cwd: home })).code, 3);
});

test('scan: a call the guard refused, or the person declined, is in the transcript but is not counted as run', async () => {
  const home = tmp('imm-scan-refused-');
  const proj = path.join(home, '.claude', 'projects', '-work-app');
  mkdirSync(proj, { recursive: true });
  const at = Date.now() - 60_000;
  const t = (s) => new Date(at + s * 1000).toISOString();
  const use = (n, cmd) => ({ type: 'assistant', sessionId: 'cc1', cwd: '/work/app', timestamp: t(n), message: { id: `m${n}`, role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'tool_use', id: `tu${n}`, name: 'Bash', input: { command: cmd } }] } });
  const result = (n, text, isError) => ({ type: 'user', sessionId: 'cc1', cwd: '/work/app', timestamp: t(n + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${n}`, is_error: isError, content: text }] } });
  writeFileSync(path.join(proj, 'cc1.jsonl'), [
    use(1, 'git push --force origin main'), result(1, 'Immiscible guard: a force push to a protected branch', true),
    use(3, 'npm publish'), result(3, "The user doesn't want to proceed with this tool use. The tool use was rejected.", true),
    use(5, 'npm test'), result(5, 'ok', false),
    use(7, 'kubectl apply -f prod.yaml'), result(7, 'Exit code 1: error', true),
  ].map((x) => JSON.stringify(x)).join('\n'));
  const logs = path.join(home, '.immiscible', 'decisions');
  mkdirSync(logs, { recursive: true });
  let prev = null;
  const e = { at: t(1), client: 'claude-code', session: 'cc1', summary: 'Bash: git push --force origin main', decision: 'deny', rule: 'force_push_protected', reason: 'r', prev };
  e.hash = createHash('sha256').update(JSON.stringify(e)).digest('hex');
  writeFileSync(path.join(logs, `${t(1).slice(0, 10)}.jsonl`), `${JSON.stringify(e)}\n`);

  const r = await runCli(['scan', '--json'], { home, cwd: home });
  assert.ok([0, 11].includes(r.code), r.stderr);
  const kinds = r.json.commands.risky.map((x) => x.kind);
  assert.ok(!kinds.includes('force_push'), 'the guard refused it');
  assert.ok(!kinds.includes('publish'), 'the person declined it');
  assert.ok(kinds.includes('kubectl'), 'a command that ran and failed still ran');
  assert.equal(r.json.commands.total, 2);
});

test('after-call hooks: an ask the person let run is logged as run; one they declined is not counted', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = tmp('imm-ran-');
  const hook = new URL('../hook/coding-agent-hook.mjs', import.meta.url).pathname;
  const run = (agent, event) => spawnSync(process.execPath, [hook, '--agent', agent], { input: JSON.stringify(event), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, IMMISCIBLE_MODE: 'local' } });
  const droid = (name, cmd) => ({ session_id: 'd1', hook_event_name: name, tool_name: 'Execute', tool_input: { command: cmd }, cwd: home });
  // Asked, then let run: PostToolUse follows.
  const pre = run('droid', droid('PreToolUse', 'npm publish'));
  assert.match(pre.stdout, /"ask"/, pre.stdout + pre.stderr);
  const post = run('droid', droid('PostToolUse', 'npm publish'));
  assert.equal(post.status, 0);
  assert.equal(post.stdout, '', 'an after-call hook answers nothing');
  // Asked, then declined: no PostToolUse ever comes.
  run('droid', droid('PreToolUse', 'docker push acme/web'));
  // Cursor: asked about a publish, the person ran it.
  const cur = (name, cmd) => ({ conversation_id: 'c1', generation_id: 'g', hook_event_name: name, command: cmd, cwd: home });
  assert.match(run('cursor', cur('beforeShellExecution', 'cargo publish')).stdout, /"ask"/);
  assert.equal(run('cursor', cur('afterShellExecution', 'cargo publish')).status, 0);
  // A call that was never asked about logs nothing after it ran.
  run('droid', droid('PostToolUse', 'ls'));

  const logFile = path.join(home, '.immiscible', 'decisions', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const entries = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries.filter((e) => e.decision === 'ran').map((e) => [e.client, e.summary]), [['factory-droid', 'Bash: npm publish'], ['cursor', 'Bash: cargo publish']]);

  const r = await runCli(['scan', '--json'], { home, cwd: home });
  const risky = r.json.commands.risky.find((x) => x.kind === 'publish');
  assert.equal(risky?.count, 2, 'npm publish and cargo publish ran; docker push was declined');
  const rp = await runCli(['replay', '--json'], { home, cwd: home });
  assert.ok([0, 11, 12].includes(rp.code), rp.stderr);
});

test('review fixes: whole commands decided locally, answerable asks, the log keeps the working directory, --after never complains', async () => {
  const { spawnSync } = await import('node:child_process');
  const { guardSessions } = await import('../src/history/guard-log.mjs');
  const home = tmp('imm-fix-');
  const hook = new URL('../hook/coding-agent-hook.mjs', import.meta.url).pathname;
  const run = (agent, event, args = []) => spawnSync(process.execPath, [hook, '--agent', agent, ...args], { input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, IMMISCIBLE_MODE: 'local' } });
  // A force push past the 289 characters a summary keeps is still refused here.
  const long = `echo ${'x'.repeat(300)}; git push --force origin main`;
  const r = run('codex', { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: long }, cwd: home });
  assert.match(r.stdout + r.stderr, /protected branch/, r.stdout + r.stderr);
  // --after: unreadable input still exits 0 with nothing said.
  const bad = run('droid', 'not json', ['--after']);
  assert.deepEqual([bad.status, bad.stdout, bad.stderr], [0, '', '']);
  // The log keeps where the call ran, and Droid's ask is marked answerable.
  run('droid', { session_id: 'd9', hook_event_name: 'PreToolUse', tool_name: 'Execute', tool_input: { command: 'npm publish' }, cwd: home });
  const entries = readFileSync(path.join(home, '.immiscible', 'decisions', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ask = entries.find((e) => e.session === 'd9');
  assert.deepEqual([ask.decision, ask.after, ask.dir], ['ask', true, home]);
  // Per entry: an answerable ask with no "ran" was declined; an old, unmarked ask counts as run.
  const at = Date.now();
  const sessions = guardSessions([
    { client: 'cursor', session: 'a', summary: 'Bash: npm publish', decision: 'ask', after: true, atMs: at },
    { client: 'cursor', session: 'b', summary: 'Bash: cargo publish', decision: 'ask', atMs: at },
    { client: 'cursor', session: 'c', summary: 'Bash: gem push x', decision: 'ask', after: true, atMs: at },
    { client: 'cursor', session: 'c', summary: 'Bash: gem push x', decision: 'ran', atMs: at + 1 },
  ]);
  const calls = Object.fromEntries(sessions.map((s) => [s.id, s.calls.length]));
  assert.deepEqual(calls, { a: 0, b: 1, c: 1 });
});

test('pinned: only an exact version or a full commit counts', async () => {
  const { pinned, risksOf } = await import('../src/agent-config.mjs');
  for (const p of ['pkg@1.2.3', '@s/p@2025.4.8', 'x==0.6', 'x==0.6.1', './local', 'github:a/b#0123456789abcdef0123456789abcdef01234567']) assert.equal(pinned(p), true, p);
  for (const p of ['pkg', 'pkg@1', 'pkg@1.x', 'pkg@dev', 'pkg@latest', 'pkg@^1.2.3', 'npm:foo', 'github:a/b', 'x==0.*']) assert.equal(pinned(p), false, p);
  assert.deepEqual(risksOf({ command: 'pnpm exec tsc' }), [], 'pnpm exec runs a local binary');
});
