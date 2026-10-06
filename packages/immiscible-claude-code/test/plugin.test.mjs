/**
 * The plugin: its MCP server reads the agent key and URL from the project's
 * .env as the hook does (the shell still wins), never prints the key, and
 * the hook leaves Immiscible's own read-only MCP tools alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = fileURLToPath(new URL('../mcp/immiscible-mcp.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function run(lines, { cwd, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => resolve({ out, err, messages: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
    child.stdin.end(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  });
}

test('the MCP server reads IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY from the project .env, and never prints the key', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'explain_decision' }] } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'immiscible-plugin-'));
  try {
    writeFileSync(join(dir, '.env'), `# written by npx immiscible init\nOTHER=1\nIMMISCIBLE_URL=${url}\nIMMISCIBLE_AGENT_KEY="ask_from_dotenv"\n`);
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    // From the directory Claude Code starts it in.
    const a = await run([list], { cwd: dir });
    assert.equal(a.messages[0].result.tools[0].name, 'explain_decision');
    // From CLAUDE_PROJECT_DIR, wherever it starts.
    const b = await run([list], { cwd: tmpdir(), env: { CLAUDE_PROJECT_DIR: dir } });
    assert.equal(b.messages[0].result.tools[0].name, 'explain_decision');
    // The shell wins over .env.
    await run([list], { cwd: dir, env: { IMMISCIBLE_AGENT_KEY: 'ask_from_shell' } });
    assert.deepEqual(seen.map((s) => s.auth), ['Bearer ask_from_dotenv', 'Bearer ask_from_dotenv', 'Bearer ask_from_shell']);
    assert.ok(seen.every((s) => s.url === '/mcp'));
    for (const r of [a, b]) assert.ok(!`${r.out}${r.err}`.includes('ask_from_dotenv'), 'the key is never printed');
    // No key anywhere: it says so, without a key to print, and the server refuses.
    const none = await run([list], { cwd: tmpdir(), env: { IMMISCIBLE_URL: url } });
    assert.match(none.err, /IMMISCIBLE_AGENT_KEY is not set in the environment or the project \.env/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plugin runs the hook and the MCP server with the project .env, and skips Immiscible\'s own read-only tools', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.PreToolUse[0];
  assert.match(entry.hooks[0].command, /--env-file-if-exists="\$CLAUDE_PROJECT_DIR\/\.env"/);
  const matches = (name) => new RegExp(`^(?:${entry.matcher})$`).test(name);
  for (const t of ['check_action_status', 'explain_decision', 'spend_summary', 'find_waste', 'unwatched_keys']) assert.ok(!matches(`mcp__plugin_immiscible_immiscible__${t}`), t);
  for (const t of ['authorize_action', 'request_payment', 'settle_action']) assert.ok(matches(`mcp__plugin_immiscible_immiscible__${t}`), t);
  assert.ok(matches('Bash') && matches('mcp__github__create_issue'));
  const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')).mcpServers.immiscible;
  assert.equal(mcp.command, 'node');
  assert.deepEqual(mcp.args, ['${CLAUDE_PLUGIN_ROOT}/mcp/immiscible-mcp.mjs']);
  assert.ok(!JSON.stringify(mcp).includes('IMMISCIBLE_AGENT_KEY'), 'no key in the config');
});
