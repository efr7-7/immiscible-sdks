/**
 * The CLI end to end against the real server: init in fixture projects
 * (node-openai, python-anthropic, claude-code), each in a temporary
 * directory with a fake HOME; doctor; JSON mode and exit codes; running
 * init twice; login, whoami and logout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { bootServer, person, mintToken, fixture, tmp, runCli, inRepo, form } from './helpers.mjs';
import { DENY } from '../src/claude.mjs';

const SKIP = inRepo ? false : 'not inside the Immiscible repository';
const SECOND_OWNER = 'Sent to another owner to confirm; payments start once they do.';
const read = (f) => readFileSync(f, 'utf8');
const envOf = (dir) => Object.fromEntries(read(path.join(dir, '.env')).split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

test('cli: end to end against the real server', { skip: SKIP, timeout: 180_000 }, async (t) => {
  const s = await bootServer();
  t.after(s.stop);
  const owner = await person(s.base);
  const token = await mintToken(s.base, owner);
  const home = tmp('imm-home-');
  const cli = (args, o = {}) => runCli(['--url', s.base, ...args], { home, env: { IMMISCIBLE_TOKEN: token, ...(o.env ?? {}) }, cwd: o.cwd ?? home, ...o });
  const pendingApprovals = () => s.app.db.get("SELECT COUNT(*) AS n FROM approvals WHERE workspace_id = ? AND status = 'pending'", owner.wid).n;

  await t.test('whoami and status, in JSON', async () => {
    const w = await cli(['whoami', '--json']);
    assert.equal(w.code, 0, w.stderr);
    assert.equal(w.json.user.email, owner.email);
    assert.equal(w.json.workspace.id, owner.wid);
    assert.equal(w.json.token.source, 'IMMISCIBLE_TOKEN');
    assert.equal(w.json.can.addAgents, true);
    const st = await cli(['status', '--json']);
    assert.equal(st.code, 0, st.stderr);
    assert.equal(st.json.waiting.count, 0);
    assert.equal(st.json.month.currency, 'GBP');
    assert.ok(st.json.month.payments.text.startsWith('£'));
    // JSON mode: one object on stdout, nothing else.
    assert.equal(st.stdout.trim().split('\n').length, 1);
  });

  await t.test('init: node-openai, non-interactive, with a payment purpose', async () => {
    const dir = fixture('node-openai');
    const r = await cli(['init', '--yes', '--json', '--name', 'Invoice runner', '--purpose', 'pays_invoices'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const j = r.json;
    assert.equal(j.ok, true);
    assert.equal(j.created, true);
    assert.equal(j.agent.name, 'Invoice runner');
    assert.equal(j.agent.vendor, 'openai');
    assert.equal(j.rules[0].kind, 'payment');
    assert.match(j.rules[0].description, /^Pays up to £/);
    assert.deepEqual(j.env.added, ['IMMISCIBLE_URL', 'IMMISCIBLE_AGENT_KEY']);
    assert.equal(j.env.gitignored, true);
    assert.equal(j.hook.state, 'skipped');
    assert.equal(j.snippet.id, 'node:openai');
    assert.match(j.snippet.text, /new OpenAI\(immiscible\.gateway\.openai\(\)\)/);
    // A payment rule never allows tool.call, so the code it prints asks to pay.
    assert.equal(j.snippet.guard, 'pay');
    assert.match(j.snippet.text, /immiscible\.pay\(/);
    assert.doesNotMatch(j.snippet.text, /toolAction/);
    assert.match(j.snippet.text, /npm install @immiscible\/sdk/);
    assert.equal(j.test.governed, true);
    assert.equal(j.test.kind, 'payment');
    // A new supplier asks a person; the test cancelled that question at once.
    assert.equal(j.test.decision, 'approval_required');
    assert.equal(pendingApprovals(), 0);
    const env = envOf(dir);
    assert.equal(env.IMMISCIBLE_URL, s.base);
    assert.match(env.IMMISCIBLE_AGENT_KEY, /^ask_/);
    assert.equal(statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
    // The agent key it wrote is a working agent key.
    const res = await fetch(`${s.base}/v1/cli/agent-key`, { headers: { authorization: `Bearer ${env.IMMISCIBLE_AGENT_KEY}` } });
    assert.equal((await res.json()).agent.id, j.agent.id);
  });

  await t.test('init: python-anthropic keeps the .env that is there', async () => {
    const dir = fixture('python-anthropic');
    const before = read(path.join(dir, '.env'));
    const r = await cli(['init', '--yes', '--json', '--name', 'Refund desk', '--purpose', 'Handles refunds'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.snippet.id, 'python:anthropic');
    assert.match(r.json.snippet.text, /immiscible\.gateway\.anthropic_client\(\)/);
    assert.equal(r.json.agent.vendor, 'anthropic');
    assert.deepEqual(r.json.detected.languages, ['python']);
    const after = read(path.join(dir, '.env'));
    assert.ok(after.startsWith(before.trimEnd()), 'the existing lines are untouched and first');
    const env = envOf(dir);
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-fixture');
    assert.equal(env.LOG_LEVEL, 'debug');
    assert.match(env.IMMISCIBLE_AGENT_KEY, /^ask_/);
  });

  let ccDir;
  await t.test('init: claude-code installs the hook beside the hooks already there', async () => {
    ccDir = fixture('claude-code');
    const r = await cli(['init', '--yes', '--json', '--name', 'Claude in the fixture', '--purpose', 'other'], { cwd: ccDir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.hook.state, 'added');
    assert.ok(r.json.hook.diff.some((l) => l.startsWith('+') && l.includes('immiscible-claude-code-hook.mjs')));
    assert.equal(r.json.snippet.id, 'claude-code');
    assert.equal(r.json.test.kind, 'action');
    const settings = JSON.parse(read(path.join(ccDir, '.claude', 'settings.json')));
    // Yours kept as they were; the deny rules added beside them, shown in the same diff.
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test:*)'], deny: [...DENY] });
    assert.ok(r.json.hook.diff.some((l) => l.startsWith('+') && l.includes('Bash(rm -rf:*)')));
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'echo after-edit');
    const pre = settings.hooks.PreToolUse;
    assert.equal(pre.length, 2);
    assert.equal(pre[0].hooks[0].command, 'echo formatting-check');
    assert.equal(pre[1].matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__(?!immiscible__(check_action_status|explain_decision|spend_summary|find_waste|unwatched_keys)$).*');
    // Immiscible's own read-only MCP tools are not sent back to it; its tools that act are.
    const matches = (name) => new RegExp(`^(?:${pre[1].matcher})$`).test(name);
    assert.ok(!matches('mcp__immiscible__check_action_status') && !matches('mcp__immiscible__explain_decision') && !matches('mcp__immiscible__spend_summary') && !matches('mcp__immiscible__find_waste') && !matches('mcp__immiscible__unwatched_keys'));
    assert.ok(matches('mcp__immiscible__authorize_action') && matches('mcp__immiscible__request_payment') && matches('mcp__github__create_issue') && matches('Bash'));
    assert.match(pre[1].hooks[0].command, /\|\| exit 2$/);
    assert.equal(pre[1].hooks[0].timeout, 60);
    const hookFile = path.join(ccDir, '.claude', 'hooks', 'immiscible-claude-code-hook.mjs');
    assert.equal(read(hookFile), read(new URL('../../../scripts/claude-code-hook.mjs', import.meta.url)));
    assert.equal(pendingApprovals(), 0);
  });

  await t.test('init twice changes nothing harmful', async () => {
    const files = ['.env', '.claude/settings.json', '.claude/hooks/immiscible-claude-code-hook.mjs'].map((f) => path.join(ccDir, f));
    const before = files.map(read);
    const agents = s.app.db.get('SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND deleted_at IS NULL', owner.wid).n;
    const actions = s.app.db.get('SELECT COUNT(*) AS n FROM agent_actions WHERE workspace_id = ?', owner.wid).n;
    const r = await cli(['init', '--yes', '--json'], { cwd: ccDir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.reused, 'env');
    assert.equal(r.json.created, false);
    assert.equal(r.json.hook.state, 'unchanged');
    assert.deepEqual(r.json.env.added, []);
    assert.equal(r.json.test.replay, true);
    assert.deepEqual(files.map(read), before, 'every file byte for byte');
    assert.equal(s.app.db.get('SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND deleted_at IS NULL', owner.wid).n, agents, 'no second agent');
    assert.equal(s.app.db.get('SELECT COUNT(*) AS n FROM agent_actions WHERE workspace_id = ?', owner.wid).n, actions, 'no second test record');
    assert.equal(pendingApprovals(), 0);
    // Without its .env, the same name gives the same agent a fresh key, not a twin.
    writeFileSync(path.join(ccDir, '.env'), '');
    const again = await cli(['init', '--yes', '--json', '--name', 'Claude in the fixture'], { cwd: ccDir });
    assert.equal(again.code, 0, again.stderr + again.stdout);
    assert.equal(again.json.reused, 'name');
    assert.equal(s.app.db.get('SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND deleted_at IS NULL', owner.wid).n, agents);
  });

  await t.test('doctor: all green in the claude-code project, and the hook fails closed', async () => {
    const r = await cli(['doctor', '--json'], { cwd: ccDir });
    assert.equal(r.code, 0, r.stdout);
    const by = Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
    for (const id of ['server', 'clock', 'auth', 'env', 'agent_key', 'hook', 'gitignore']) assert.equal(by[id].status, 'ok', `${id}: ${by[id].detail}`);
    assert.match(by.hook.detail, /fails closed \(checked\)/);
  });

  await t.test('doctor: a key in the shell wins over .env, as it does for the hook, and the difference is named', async () => {
    const r = await cli(['doctor', '--json'], { cwd: ccDir, env: { IMMISCIBLE_AGENT_KEY: 'ask_bogus' } });
    assert.equal(r.code, 7, r.stdout);
    const by = Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
    assert.equal(by.env.status, 'warn');
    assert.match(by.env.detail, /IMMISCIBLE_AGENT_KEY in this shell differs from \.env/);
    assert.equal(by.agent_key.status, 'fail');
    assert.match(by.agent_key.detail, /this shell's environment/);
  });

  await t.test('status: init\'s own connection tests are not counted in today', async () => {
    const st = await cli(['status', '--json']);
    assert.equal(st.code, 0, st.stderr);
    const tests = s.app.db.get("SELECT COUNT(*) AS n FROM agent_actions WHERE workspace_id = ? AND idempotency_key LIKE 'immiscible-cli-test:%'", owner.wid).n;
    assert.ok(tests > 0, 'init made connection tests');
    assert.equal(st.json.today.total, s.app.db.get("SELECT COUNT(*) AS n FROM agent_actions WHERE workspace_id = ? AND (idempotency_key IS NULL OR idempotency_key NOT LIKE 'immiscible-cli-test:%')", owner.wid).n);
  });

  await t.test('doctor: a weakened hook, a missing .env and a bad key fail, with fixes', async () => {
    const dir = fixture('claude-code');
    const settings = JSON.parse(read(path.join(dir, '.claude', 'settings.json')));
    settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.immiscible/claude-code-hook.mjs' }] });
    writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
    const r = await cli(['doctor', '--json'], { cwd: dir });
    assert.equal(r.code, 7);
    const by = Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
    assert.equal(by.hook.status, 'fail');
    assert.match(by.hook.detail, /not the full/);
    assert.match(by.hook.detail, /exit 2/);
    assert.equal(by.env.status, 'fail');
    assert.ok(by.env.fix && by.env.docs.endsWith('/docs/cli#init'));
    writeFileSync(path.join(dir, '.env'), `IMMISCIBLE_URL=${s.base}\nIMMISCIBLE_AGENT_KEY=ask_not_a_real_key_at_all_000000000000\n`);
    const r2 = await cli(['doctor', '--json'], { cwd: dir });
    assert.equal(Object.fromEntries(r2.json.checks.map((c) => [c.id, c])).agent_key.status, 'fail');
  });

  await t.test('doctor: an unreachable server fails, human output says how to fix it', async () => {
    const r = await runCli(['doctor', '--url', 'http://127.0.0.1:9'], { home, cwd: home });
    assert.equal(r.code, 7);
    assert.match(r.stdout, /✗ Server/);
    assert.match(r.stdout, /Fix:/);
    assert.ok(!/\u001b\[/.test(r.stdout), 'no colour when stdout is not a terminal');
  });

  await t.test('init adds .env to .gitignore in a git repository, and --no-gitignore leaves it alone', async () => {
    const dir = fixture('python-anthropic');
    mkdirSync(path.join(dir, '.git'));
    const r = await cli(['init', '--yes', '--json', '--no-test', '--name', 'Ignore check', '--purpose', 'other'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.env.gitignore, 'created');
    assert.equal(r.json.env.gitignored, true);
    assert.equal(read(path.join(dir, '.gitignore')), '.env\n');
    const again = await cli(['init', '--yes', '--json', '--no-test'], { cwd: dir });
    assert.equal(again.json.env.gitignore, 'unchanged');
    const off = fixture('python-anthropic');
    mkdirSync(path.join(off, '.git'));
    const o = await cli(['init', '--yes', '--json', '--no-test', '--no-gitignore', '--name', 'Ignore off', '--purpose', 'other'], { cwd: off });
    assert.equal(o.json.env.gitignore, 'declined');
    assert.ok(!existsSync(path.join(off, '.gitignore')));
  });

  await t.test('the rule waits for a second owner: exit 10 and the exact sentence', async () => {
    const other = s.app.accounts.createUser({ email: `second-${Date.now()}@cli.test`, password: 'correct horse battery staple', verified: true });
    s.app.accounts.addMember(owner.wid, other, 'owner');
    const dir = fixture('node-openai');
    const r = await cli(['init', '--yes', '--json', '--name', 'Supplier payer', '--purpose', 'pays_invoices'], { cwd: dir });
    assert.equal(r.code, 10, r.stderr + r.stdout);
    assert.equal(r.json.ok, false, 'a rule still waiting is not ok');
    assert.equal(r.json.message, SECOND_OWNER);
    assert.equal(r.json.pending.message, SECOND_OWNER);
    assert.equal(r.json.rules.length, 0);
    assert.match(envOf(dir).IMMISCIBLE_AGENT_KEY, /^ask_/);
    const human = await cli(['init', '--yes'], { cwd: dir });
    assert.equal(human.code, 10);
    assert.ok(human.stdout.includes(SECOND_OWNER));
    assert.ok(!human.stdout.includes('Governed by Immiscible'), 'no tick while the rule waits');
    assert.ok(human.stdout.includes('Waiting for another owner to confirm the rule'));
  });

  await t.test('exit codes for every refusal', async () => {
    const dir = fixture('node-openai');
    const noYes = await cli(['init', '--json', '--name', 'X', '--purpose', 'other'], { cwd: dir });
    assert.equal(noYes.code, 4);
    assert.equal(noYes.json.error.code, 'confirmation_required');
    assert.ok(!existsSync(path.join(dir, '.env')), 'nothing written');
    const badPurpose = await cli(['init', '--yes', '--json', '--name', 'X', '--purpose', 'juggling'], { cwd: dir });
    assert.equal(badPurpose.code, 2);
    assert.match(badPurpose.json.error.fix, /pays_invoices/);
    const signedOut = await runCli(['init', '--yes', '--json', '--url', s.base], { home: tmp(), cwd: dir });
    assert.equal(signedOut.code, 3);
    assert.equal(signedOut.json.error.code, 'not_signed_in');
    const badToken = await cli(['whoami', '--json'], { env: { IMMISCIBLE_TOKEN: 'imc_nottherealtokennottherealtokennottherealtok' } });
    assert.equal(badToken.code, 3);
    const unknown = await cli(['frobnicate']);
    assert.equal(unknown.code, 2);
    const flag = await cli(['status', '--frob']);
    assert.equal(flag.code, 2);
    const unreachable = await runCli(['whoami', '--json', '--url', 'http://127.0.0.1:9'], { home, cwd: home, env: { IMMISCIBLE_TOKEN: token } });
    assert.equal(unreachable.code, 5);
    // .env pointing at another server stops init before anything is made.
    writeFileSync(path.join(dir, '.env'), 'IMMISCIBLE_URL=https://elsewhere.example\n');
    const conflict = await cli(['init', '--yes', '--json', '--name', 'X', '--purpose', 'other'], { cwd: dir });
    assert.equal(conflict.code, 4);
    assert.equal(conflict.json.error.code, 'env_url_conflict');
    assert.equal(read(path.join(dir, '.env')), 'IMMISCIBLE_URL=https://elsewhere.example\n');
  });

  await t.test('login --token, whoami, logout: the file is 0600 and logout revokes', async () => {
    const h = tmp('imm-home-');
    const tok = await mintToken(s.base, owner);
    const li = await runCli(['login', '--url', s.base, '--token', tok, '--json'], { home: h, cwd: h });
    assert.equal(li.code, 0, li.stderr + li.stdout);
    const file = path.join(h, '.config', 'immiscible', 'credentials.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    const creds = JSON.parse(read(file));
    assert.equal(creds.current, s.base);
    assert.equal(creds.servers[s.base].token, tok);
    const who = await runCli(['whoami', '--json'], { home: h, cwd: h });
    assert.equal(who.code, 0, who.stderr);
    assert.equal(who.json.token.source, 'credentials');
    const out = await runCli(['logout', '--json'], { home: h, cwd: h });
    assert.equal(out.code, 0);
    assert.equal(out.json.revoked, true);
    assert.ok(!existsSync(file), 'forgotten');
    const after = await runCli(['whoami', '--json', '--url', s.base], { home: h, cwd: h, env: { IMMISCIBLE_TOKEN: tok } });
    assert.equal(after.code, 3, 'revoked on the server too');
  });

  await t.test('login: the device flow through the CLI, allowed in the browser', async () => {
    const h = tmp('imm-home-');
    let approved = false;
    const r = await runCli(['login', '--url', s.base, '--json'], {
      home: h, cwd: h,
      onStdout: (out) => {
        if (approved) return;
        const first = out.split('\n')[0];
        let ev;
        try { ev = JSON.parse(first); } catch { return; }
        approved = true;
        assert.equal(ev.event, 'device');
        assert.match(ev.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
        assert.equal(ev.verification_uri, `${s.base}/app/device`);
        owner.call('POST', '/api/me/device', { code: ev.user_code, workspaceId: owner.wid, decision: 'approve' });
      },
    });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.workspace.id, owner.wid);
    const creds = JSON.parse(read(path.join(h, '.config', 'immiscible', 'credentials.json')));
    assert.match(creds.servers[s.base].token, /^imc_/);
  });

  await t.test('login: denied in the browser exits 8', async () => {
    const h = tmp('imm-home-');
    let done = false;
    const r = await runCli(['login', '--url', s.base, '--json'], {
      home: h, cwd: h,
      onStdout: (out) => {
        if (done) return;
        let ev;
        try { ev = JSON.parse(out.split('\n')[0]); } catch { return; }
        done = true;
        owner.call('POST', '/api/me/device', { code: ev.user_code, decision: 'deny' });
      },
    });
    assert.equal(r.code, 8, r.stdout);
    assert.equal(r.json.error.code, 'access_denied');
  });

  await t.test('token create, list and revoke: a CI token shown once', async () => {
    const made = await cli(['token', 'create', '--name', 'ci', '--read-only', '--days', '7', '--json']);
    assert.equal(made.code, 0, made.stderr + made.stdout);
    assert.match(made.json.token, /^imc_/);
    assert.ok(!made.json.scopes.includes('agents:write'));
    const who = await runCli(['whoami', '--json', '--url', s.base], { home: tmp(), cwd: home, env: { IMMISCIBLE_TOKEN: made.json.token } });
    assert.equal(who.code, 0);
    assert.equal(who.json.token.name, 'ci');
    const list = await cli(['token', 'list', '--json']);
    assert.ok(list.json.data.some((x) => x.id === made.json.id));
    const human = await cli(['token', 'create', '--name', 'ci-2']);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /^ {2}imc_/m);
    assert.match(human.stdout, /Shown once/);
    const gone = await cli(['token', 'revoke', made.json.id, '--json']);
    assert.equal(gone.code, 0);
    const after = await runCli(['whoami', '--json', '--url', s.base], { home: tmp(), cwd: home, env: { IMMISCIBLE_TOKEN: made.json.token } });
    assert.equal(after.code, 3);
    assert.equal((await cli(['token', 'create'])).code, 2, '--name is required');
    assert.equal((await cli(['token', 'create', '--name', 'x', '--days', '200'])).code, 2);
  });

  await t.test('help and version need no server', async () => {
    const help = await runCli(['--help'], { home, cwd: home });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Exit codes/);
    const ih = await runCli(['init', '--help'], { home, cwd: home });
    assert.match(ih.stdout, /--purpose/);
    const v = await runCli(['--version'], { home, cwd: home });
    assert.match(v.stdout, /^immiscible \d+\.\d+\.\d+/);
  });

  // Keep form() in use for a direct check that the CLI's own client id is required.
  await t.test('the device endpoint names the CLI client', async () => {
    const r = await form(s.base, '/oauth/device', { client_id: 'someone-else' });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'invalid_client');
    mkdirSync(path.join(home, 'unused'), { recursive: true });
  });
});
