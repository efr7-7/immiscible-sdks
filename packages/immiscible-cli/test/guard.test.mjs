/**
 * immiscible guard: finds the coding agents in a home directory, installs the
 * hooks in local mode, the hooks then refuse and ask on this machine with no
 * server, and --off puts every file back byte for byte.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from './helpers.mjs';
import { detectAgents } from '../src/commands/guard.mjs';

function home() {
  const h = mkdtempSync(path.join(tmpdir(), 'imm-guard-'));
  mkdirSync(path.join(h, '.claude'), { recursive: true });
  writeFileSync(path.join(h, '.claude', 'settings.json'), '{\n  "model": "opus",\n  "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ] }\n}\n');
  mkdirSync(path.join(h, '.codex'), { recursive: true });
  writeFileSync(path.join(h, '.codex', 'config.toml'), 'model = "gpt-5"\n');
  return h;
}

/** Run an installed hook command on one event, as the agent would, with no network. */
function runHook(command, event, h, extra = {}) {
  const r = spawnSync('sh', ['-c', command], { input: JSON.stringify(event), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, IMMISCIBLE_URL: 'http://127.0.0.1:9', ...extra } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('guard: finds the agents in this home and nothing else', () => {
  const h = home();
  const found = detectAgents({ HOME: h }).filter((a) => a.found).map((a) => a.target);
  assert.deepEqual(found, ['claude-code', 'codex']);
  // Factory Droid, opencode and Amp by their configuration folders.
  mkdirSync(path.join(h, '.factory'));
  mkdirSync(path.join(h, '.config', 'opencode'), { recursive: true });
  mkdirSync(path.join(h, '.config', 'amp'), { recursive: true });
  assert.deepEqual(detectAgents({ HOME: h }).filter((a) => a.found).map((a) => a.target), ['claude-code', 'codex', 'droid', 'opencode', 'amp']);
});

test('guard --scope managed: opencode and Amp, which have no managed file, are left out and said so', async () => {
  const h = home();
  mkdirSync(path.join(h, '.config', 'opencode'), { recursive: true });
  const r = spawnSync(process.execPath, [new URL('../bin/immiscible.mjs', import.meta.url).pathname, 'guard', '--scope', 'managed', '--dry-run', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, IMMISCIBLE_MANAGED_ROOT: path.join(h, 'managed'), IMMISCIBLE_MANAGED_SETTINGS: path.join(h, 'managed', 'claude', 'managed-settings.json'), IMMISCIBLE_GUARD_STATE: path.join(h, 'state.json') } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.ok(!j.agents.some((a) => a.agent === 'opencode'));
  assert.deepEqual(j.skipped.map((x) => x.agent), ['opencode']);
});

test('guard: local rules on every agent found, the hooks decide with no server, and --off restores byte for byte', async () => {
  const h = home();
  const settings = path.join(h, '.claude', 'settings.json');
  const before = readFileSync(settings);

  const dry = await runCli(['guard', '--dry-run', '--json'], { cwd: h, home: h });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.json.wouldChange, true);
  assert.deepEqual(dry.json.agents.map((a) => a.agent), ['claude-code', 'codex']);
  assert.ok(readFileSync(settings).equals(before), 'a dry run writes nothing');

  const noYes = await runCli(['guard', '--json'], { cwd: h, home: h });
  assert.equal(noYes.code, 4, 'needs a yes when not at a terminal');

  const on = await runCli(['guard', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(on.code, 0, on.stdout + on.stderr);
  assert.equal(on.json.mode, 'local');
  assert.ok(on.json.selfTest.every((t) => t.ok));

  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'opus', 'other settings kept');
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done', 'other hooks kept');
  assert.equal(s.env.IMMISCIBLE_MODE, 'local');
  const pre = s.hooks.PreToolUse.find((e) => /Read\|/.test(e.matcher));
  assert.ok(pre, 'local mode also sees Read, for the secret-then-network rule');
  const claudeCmd = pre.hooks[0].command;
  // Claude Code gives its hooks the settings file's env.
  const claude = (event) => runHook(claudeCmd, event, h, s.env);

  const codexHooks = JSON.parse(readFileSync(path.join(h, '.codex', 'hooks.json'), 'utf8'));
  const codexCmd = codexHooks.hooks.PreToolUse.flatMap((e) => e.hooks).find((x) => /coding-agent-hook\.mjs/.test(x.command)).command;
  assert.match(readFileSync(path.join(h, '.immiscible', 'hook.env'), 'utf8'), /^IMMISCIBLE_MODE=local$/m);

  // Claude Code: a force push to main is refused, terraform asks, git status goes ahead.
  const deny = claude({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' }, session_id: 'a' });
  assert.equal(JSON.parse(deny.out).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(deny.out).hookSpecificOutput.permissionDecisionReason, /^Immiscible guard: a force push/, 'decided by the local rules, not by failing closed');
  const ask = claude({ tool_name: 'Bash', tool_input: { command: 'terraform apply' }, session_id: 'a' });
  assert.equal(JSON.parse(ask.out).hookSpecificOutput.permissionDecision, 'ask');
  const fine = claude({ tool_name: 'Bash', tool_input: { command: 'git status' }, session_id: 'a' });
  assert.equal(fine.code, 0);
  assert.equal(fine.out, '');
  // A secret read, then the network, in the same session: asked.
  claude({ tool_name: 'Read', tool_input: { file_path: path.join(h, 'app', '.env') }, session_id: 'b' });
  const after = claude({ tool_name: 'Bash', tool_input: { command: 'curl -s https://example.com' }, session_id: 'b' });
  assert.equal(JSON.parse(after.out).hookSpecificOutput.permissionDecision, 'ask');
  assert.match(JSON.parse(after.out).hookSpecificOutput.permissionDecisionReason, /read \.env earlier/);
  const state = readFileSync(path.join(h, '.immiscible', 'state', (await import('node:fs')).readdirSync(path.join(h, '.immiscible', 'state'))[0]), 'utf8');
  assert.ok(!state.includes(h), 'the session state holds the short name, not the path');

  // Codex: no ask from a hook, so a publish is refused with the way to go ahead.
  const pub = runHook(codexCmd, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm publish' }, session_id: 'c' }, h);
  assert.equal(pub.code, 2);
  assert.match(pub.err, /publishing.*run it yourself if you meant it/s);

  // A second run changes nothing.
  const again = await runCli(['guard', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(again.json.changed, false);

  // Off: every file as it was, the files guard made removed.
  const off = await runCli(['guard', '--off', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(off.code, 0, off.stderr);
  assert.ok(readFileSync(settings).equals(before), 'settings.json byte for byte');
  assert.ok(!existsSync(path.join(h, '.codex', 'hooks.json')), 'a file guard made is removed');
  assert.ok(!existsSync(path.join(h, '.immiscible', 'claude-code-hook.mjs')));
  assert.ok(!existsSync(path.join(h, '.immiscible', 'guard.json')));
  assert.equal(off.json.kept.length, 0);
});

test('guard --off leaves a file someone changed since, and says so', async () => {
  const h = home();
  assert.equal((await runCli(['guard', '--agents', 'claude-code', '--yes', '--json'], { cwd: h, home: h })).code, 0);
  const settings = path.join(h, '.claude', 'settings.json');
  writeFileSync(settings, readFileSync(settings, 'utf8').replace('"opus"', '"sonnet"'));
  const off = await runCli(['guard', '--off', '--yes', '--json'], { cwd: h, home: h });
  assert.deepEqual(off.json.kept.map((k) => k.path), [settings]);
  assert.match(readFileSync(settings, 'utf8'), /sonnet/, 'their change is kept');
});

test('guard --connect needs a key, and with one switches the hooks to the server', async () => {
  const h = home();
  const none = await runCli(['guard', '--connect', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(none.code, 4);
  assert.equal(none.json.error.code, 'key_required');
  const on = await runCli(['guard', '--agents', 'claude-code', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(on.json.mode, 'local');
  const connected = await runCli(['guard', '--agents', 'claude-code', '--connect', '--key', 'imm_agent_testkey123', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(connected.code, 0, connected.stderr);
  const s = JSON.parse(readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.env.IMMISCIBLE_MODE, undefined);
  assert.equal(s.env.IMMISCIBLE_AGENT_KEY, 'imm_agent_testkey123');
  assert.ok(!connected.stdout.includes('imm_agent_testkey123') || connected.json, 'the key is not printed in a diff');
  // Off goes back to before the first guard, not to the local version.
  await runCli(['guard', '--off', '--yes'], { cwd: h, home: h });
  assert.equal(JSON.parse(readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8')).env, undefined);
});

test('guard: no agents found is not an error, and an unknown agent is a usage error', async () => {
  const h = mkdtempSync(path.join(tmpdir(), 'imm-guard-empty-'));
  const r = await runCli(['guard', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.agents, []);
  const bad = await runCli(['guard', '--agents', 'copilot', '--json'], { cwd: h, home: h });
  assert.equal(bad.code, 2);
});

test('guard --agents all: a fresh box with no agent yet gets every hook, and --off takes them all away', async () => {
  const h = mkdtempSync(path.join(tmpdir(), 'imm-guard-box-'));
  const r = await runCli(['guard', '--agents', 'all', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.agents.map((a) => a.agent), ['claude-code', 'codex', 'cursor', 'windsurf', 'gemini', 'droid', 'opencode', 'amp']);
  assert.ok(existsSync(path.join(h, '.config', 'opencode', 'plugins', 'immiscible.js')));
  const off = await runCli(['guard', '--off', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(off.code, 0, off.stderr);
  assert.ok(!existsSync(path.join(h, '.config', 'opencode', 'plugins', 'immiscible.js')));
  assert.equal((await runCli(['guard', '--agents', 'all,codex', '--json'], { cwd: h, home: h })).code, 2, 'all stands alone');
  // Managed: every agent with a managed file; opencode and Amp named as left out.
  const m = spawnSync(process.execPath, [new URL('../bin/immiscible.mjs', import.meta.url).pathname, 'guard', '--agents', 'all', '--scope', 'managed', '--dry-run', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, IMMISCIBLE_MANAGED_ROOT: path.join(h, 'managed'), IMMISCIBLE_MANAGED_SETTINGS: path.join(h, 'managed', 'claude', 'managed-settings.json'), IMMISCIBLE_GUARD_STATE: path.join(h, 'managed-state.json') } });
  assert.equal(m.status, 0, m.stderr + m.stdout);
  const j = JSON.parse(m.stdout);
  assert.deepEqual(j.agents.map((a) => a.agent), ['claude-code', 'codex', 'cursor', 'windsurf', 'gemini', 'droid']);
  assert.deepEqual(j.skipped.map((x) => x.agent), ['opencode', 'amp']);
  // A trailing comma is still all.
  const m2 = spawnSync(process.execPath, [new URL('../bin/immiscible.mjs', import.meta.url).pathname, 'guard', '--agents', 'all,', '--scope', 'managed', '--dry-run', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, IMMISCIBLE_MANAGED_ROOT: path.join(h, 'managed'), IMMISCIBLE_MANAGED_SETTINGS: path.join(h, 'managed', 'claude', 'managed-settings.json'), IMMISCIBLE_GUARD_STATE: path.join(h, 'managed-state.json') } });
  assert.equal(m2.status, 0, m2.stderr + m2.stdout);
  assert.deepEqual(JSON.parse(m2.stdout).skipped.map((x) => x.agent), ['opencode', 'amp']);
});

test('guard protects itself; a person can pause it for a while, and status says so', async () => {
  const h = home();
  const g = await runCli(['guard', '--agents', 'codex', '--yes', '--json'], { cwd: h, home: h });
  assert.equal(g.code, 0, g.stderr);
  const hook = path.join(h, '.immiscible', 'coding-agent-hook.mjs');
  const run = (cmd) => spawnSync(process.execPath, [hook, '--agent', 'codex'], { input: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd: h }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, IMMISCIBLE_MODE: 'local' } });
  const said = (cmd) => { const r = run(cmd); return `${r.stdout}${r.stderr}`; };
  // An agent cannot switch it off or pause it.
  assert.match(said('npx immiscible guard --off --yes'), /cannot switch off, pause or redirect the guard/);
  assert.match(said('npx -y immiscible@0.3.0 guard --pause 2h'), /cannot switch off, pause or redirect the guard/);
  // A person pauses: an ask goes ahead, logged as paused; a refusal stays; agent config is still asked about.
  assert.match(said('npm publish'), /publishing a package/);
  const p = await runCli(['guard', '--pause', '30m', '--json'], { cwd: h, home: h });
  assert.equal(p.json.paused, true);
  const published = run('npm publish');
  assert.equal(published.status, 0);
  assert.ok(!/deny|block/i.test(published.stdout), published.stdout);
  assert.match(said('git push --force origin main'), /protected branch/);
  assert.match(said('echo x >> ~/.immiscible/pause.json'), /Immiscible's own records/);
  const st = await runCli(['guard', '--status', '--json'], { cwd: h, home: h });
  assert.deepEqual([st.json.on, st.json.agents, Boolean(st.json.pausedUntil), st.json.unguarded], [true, ['codex'], true, ['claude-code']]);
  const scan = await runCli(['scan', '--json'], { cwd: h, home: h });
  assert.equal(scan.json.guard.paused, 1);
  // From inside an agent's own shell the CLI refuses too.
  const inside = await runCli(['guard', '--pause', '10m', '--json'], { cwd: h, home: h, env: { CLAUDECODE: '1' } });
  assert.equal(inside.code, 6, inside.stdout);
  assert.equal(inside.json.error.code, 'agent_shell');
  // A pause file written by hand into the future, or rewritten after it was set, is not a pause.
  const pf = path.join(h, '.immiscible', 'pause.json');
  writeFileSync(pf, JSON.stringify({ at: '9999-01-01T00:00:00.000Z', until: '9999-01-01T01:00:00.000Z' }));
  assert.match(said('npm publish'), /publishing a package/);
  writeFileSync(pf, JSON.stringify({ at: new Date(Date.now() - 3_600_000).toISOString(), until: new Date(Date.now() + 3_000_000).toISOString() }));
  assert.match(said('npm publish'), /publishing a package/, 'written an hour after the time it claims');
  await runCli(['guard', '--pause', '30m'], { cwd: h, home: h });
  // Resume, and asks are asked again; a pause over two hours is refused.
  assert.equal((await runCli(['guard', '--resume', '--json'], { cwd: h, home: h })).json.wasPaused, true);
  assert.match(said('npm publish'), /publishing a package/);
  assert.equal((await runCli(['guard', '--pause', '5h'], { cwd: h, home: h })).code, 2);
});
