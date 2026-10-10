/**
 * immiscible install claude-code: the machine-wide hook, for a person
 * (~/.claude/settings.json) or for everyone (Claude Code's managed settings,
 * here redirected with IMMISCIBLE_MANAGED_SETTINGS). Each run gets its own
 * HOME, as a person or a device management tool would run it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { runCli, tmp, inRepo, bootServer, person } from './helpers.mjs';
import { managedSettingsPath, fleetPaths, fleetCommand, planFleet } from '../src/fleet.mjs';
import { MATCHER } from '../src/claude.mjs';

const OTHER = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo audit' }] };

function homeWithSettings(settings) {
  const home = tmp('imm-install-');
  if (settings) {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  }
  return home;
}

test('paths: managed settings where Claude Code documents them, per platform', () => {
  assert.equal(managedSettingsPath({ platform: 'darwin', env: {} }), '/Library/Application Support/ClaudeCode/managed-settings.json');
  assert.equal(managedSettingsPath({ platform: 'linux', env: {} }), '/etc/claude-code/managed-settings.json');
  assert.equal(managedSettingsPath({ platform: 'win32', env: {} }), 'C:\\Program Files\\ClaudeCode\\managed-settings.json');
  assert.equal(fleetPaths('managed', { platform: 'win32', env: {} }).hook, 'C:\\Program Files\\ClaudeCode\\immiscible\\claude-code-hook.mjs');
  // Windows home directories, read through path and the environment, not hard-coded.
  const user = fleetPaths('user', { env: { HOME: '', USERPROFILE: path.join('C:', 'Users', 'dev') } });
  assert.equal(user.settings, path.join('C:', 'Users', 'dev', '.claude', 'settings.json'));
  assert.equal(fleetCommand('C:\\Program Files\\ClaudeCode\\immiscible\\claude-code-hook.mjs'), 'node "C:/Program Files/ClaudeCode/immiscible/claude-code-hook.mjs" || exit 2');
});

test('install --scope user: keeps another hook, runs the self-test, and a second run changes nothing, byte for byte', async () => {
  const home = homeWithSettings({ model: 'opus', hooks: { PreToolUse: [OTHER] } });
  const file = path.join(home, '.claude', 'settings.json');
  const r = await runCli(['install', 'claude-code', '--yes', '--json', '--url', 'https://imm.example.com'], { cwd: home, home });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.json.settingsState, 'added');
  assert.equal(r.json.selfTest.ok, true);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.hooks.PreToolUse[0], OTHER, 'the other hook is still there, first');
  assert.equal(s.hooks.PreToolUse[1].matcher, MATCHER);
  assert.equal(s.hooks.PreToolUse[1].hooks[0].command, fleetCommand(path.join(home, '.immiscible', 'claude-code-hook.mjs')));
  assert.equal(s.env.IMMISCIBLE_URL, 'https://imm.example.com');
  assert.equal(s.allowManagedHooksOnly, undefined, 'a person\'s own settings never turn off other hooks');
  assert.ok(existsSync(path.join(home, '.immiscible', 'claude-code-hook.mjs')));
  const bytes = readFileSync(file);
  const again = await runCli(['install', 'claude-code', '--yes', '--json', '--url', 'https://imm.example.com'], { cwd: home, home });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.changed, false);
  assert.ok(readFileSync(file).equals(bytes), 'byte-identical on the second run');
});

test('install --dry-run writes nothing; without --yes off a terminal it asks for one', async () => {
  const home = homeWithSettings({ hooks: { PreToolUse: [OTHER] } });
  const file = path.join(home, '.claude', 'settings.json');
  const before = readFileSync(file);
  const dry = await runCli(['install', 'claude-code', '--dry-run', '--json'], { cwd: home, home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.json.wouldChange, true);
  assert.ok(dry.json.diff.some((l) => l.startsWith('+') && l.includes('claude-code-hook.mjs')));
  assert.ok(readFileSync(file).equals(before));
  assert.equal(existsSync(path.join(home, '.immiscible')), false);
  const managed = path.join(home, 'managed', 'managed-settings.json');
  const dryManaged = await runCli(['install', 'claude-code', '--scope', 'managed', '--dry-run'], { cwd: home, home, env: { IMMISCIBLE_MANAGED_SETTINGS: managed } });
  assert.equal(dryManaged.code, 0, dryManaged.stderr);
  assert.equal(existsSync(managed), false);
  const ask = await runCli(['install', 'claude-code', '--json'], { cwd: home, home });
  assert.equal(ask.code, 4);
  assert.equal(ask.json.error.code, 'confirmation_required');
  assert.ok(readFileSync(file).equals(before));
});

test('install --scope managed: allowManagedHooksOnly, the key never shown, http transport, and switching transports leaves one entry', async () => {
  const home = homeWithSettings(null);
  const managed = path.join(home, 'etc', 'claude-code', 'managed-settings.json');
  mkdirSync(path.dirname(managed), { recursive: true });
  writeFileSync(managed, `${JSON.stringify({ permissions: { deny: ['WebFetch'] }, hooks: { PostToolUse: [OTHER] }, httpHookAllowedEnvVars: ['OTHER_VAR'] }, null, 2)}\n`);
  const env = { IMMISCIBLE_MANAGED_SETTINGS: managed };
  const key = 'ask_fleet_0123456789abcdef';
  const r = await runCli(['install', 'claude-code', '--scope', 'managed', '--key', key, '--gateway', 'https://imm.example.com/anthropic', '--url', 'https://imm.example.com', '--yes', '--json'], { cwd: home, home, env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.ok(!r.stdout.includes(key), 'the key is not printed');
  let s = JSON.parse(readFileSync(managed, 'utf8'));
  assert.equal(s.allowManagedHooksOnly, true);
  assert.deepEqual(s.hooks.PostToolUse, [OTHER]);
  assert.equal(s.permissions.deny[0], 'WebFetch', 'their deny rules first, ours after');
  assert.equal(s.env.IMMISCIBLE_AGENT_KEY, key);
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'https://imm.example.com/anthropic');
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /immiscible[\\/]claude-code-hook\.mjs" \|\| exit 2$/);
  assert.ok(existsSync(path.join(path.dirname(managed), 'immiscible', 'claude-code-hook.mjs')));

  const http = await runCli(['install', 'claude-code', '--scope', 'managed', '--transport', 'http', '--key', key, '--gateway', 'https://imm.example.com/anthropic', '--url', 'https://imm.example.com', '--yes', '--json'], { cwd: home, home, env });
  assert.equal(http.code, 0, http.stderr + http.stdout);
  assert.equal(http.json.settingsState, 'updated');
  s = JSON.parse(readFileSync(managed, 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 1, 'the command entry was replaced, not joined');
  for (const ev of ['PreToolUse', 'PermissionRequest']) {
    const h = s.hooks[ev][0].hooks[0];
    assert.equal(h.type, 'http', ev);
    assert.equal(h.url, 'https://imm.example.com/v1/hooks/claude-code');
    assert.equal(h.headers.Authorization, 'Bearer $IMMISCIBLE_AGENT_KEY');
    assert.deepEqual(h.allowedEnvVars, ['IMMISCIBLE_AGENT_KEY', 'CLAUDE_PROJECT_DIR']);
  }
  assert.deepEqual(s.httpHookAllowedEnvVars, ['OTHER_VAR', 'IMMISCIBLE_AGENT_KEY', 'CLAUDE_PROJECT_DIR'], 'an existing list is extended');
  assert.equal(s.allowedHttpHookUrls, undefined, 'a list the organisation does not keep is not started');
  const back = planFleet(managed, { scope: 'managed', transport: 'command', url: 'https://imm.example.com', hookFile: '/x/hook.mjs', key, gateway: 'https://imm.example.com/anthropic' });
  const after = JSON.parse(back.after);
  assert.equal(after.hooks.PermissionRequest, undefined, 'back to command: the http PermissionRequest entry goes');
  assert.equal(after.hooks.PreToolUse.length, 1);
});

test('install: an unreadable settings file is left alone and named', async () => {
  const home = homeWithSettings(null);
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
  const r = await runCli(['install', 'claude-code', '--yes', '--json'], { cwd: home, home });
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, 'settings_unreadable');
  assert.equal(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ not json');
  const bad = await runCli(['install', 'no-such-agent', '--json'], { cwd: home, home });
  assert.equal(bad.code, 2);
});

/** Run the installed hook command's node and file on one Claude Code event, with the settings' env. */
function runInstalledHook(settings, event) {
  const cmd = settings.hooks.PreToolUse.find((e) => e.matcher === MATCHER).hooks[0].command;
  const file = /^node "([^"]+)"/.exec(cmd)[1];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env: { PATH: process.env.PATH, ...settings.env, IMMISCIBLE_TIMEOUT_MS: '5000' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify(event));
    child.on('close', (code) => resolve({ code, json: out.trim() ? JSON.parse(out) : null }));
  });
}

test('the installed hook refuses a force push to main under the baseline rule, and fails closed when the server is gone', { skip: !inRepo && 'needs the repository server' }, async () => {
  const s = await bootServer();
  let up = true;
  try {
    const who = await person(s.base);
    const ag = await who.call('POST', `/api/w/${who.wid}/agents`, { name: 'Fleet', vendor: 'anthropic' });
    const key = (await who.call('POST', `/api/w/${who.wid}/agents/${ag.json.id}/keys`)).json.key;
    const rule = await who.call('POST', `/api/w/${who.wid}/mandates`, { agentId: ag.json.id, template: 'coding_agent_baseline' });
    assert.equal(rule.status, 201, rule.text);
    const home = homeWithSettings(null);
    const r = await runCli(['install', 'claude-code', '--key', key, '--url', s.base, '--yes', '--json'], { cwd: home, home });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const settings = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const event = { hook_event_name: 'PreToolUse', session_id: 'fleet-1', cwd: home, tool_name: 'Bash', tool_input: { command: 'git push --force origin main' }, tool_use_id: 'toolu_fleet_1' };
    const out = await runInstalledHook(settings, event);
    assert.equal(out.code, 0);
    assert.equal(out.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.json.hookSpecificOutput.permissionDecisionReason, /force push to main/);
    await s.stop();
    up = false;
    const gone = await runInstalledHook(settings, { ...event, tool_use_id: 'toolu_fleet_2' });
    assert.equal(gone.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(gone.json.hookSpecificOutput.permissionDecisionReason, /failing closed/);
  } finally {
    if (up) await s.stop();
  }
});
