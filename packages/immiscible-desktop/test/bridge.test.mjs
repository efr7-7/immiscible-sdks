/**
 * The bridge against a fake Streamable HTTP server: messages go through in
 * order with the key and the session, JSON and event-stream answers come
 * back, notifications get nothing, and an unreachable server is an error,
 * never an answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BRIDGE = fileURLToPath(new URL('../server/index.mjs', import.meta.url));

function run(lines, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    child.stdin.end(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  });
}

test('forwards with the key and session, reads JSON and SSE, and fails closed', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, session: req.headers['mcp-session-id'] ?? null, protocol: req.headers['mcp-protocol-version'] ?? null, method: msg.method });
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'explain_decision' }] } })}\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const out = await run([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ], { IMMISCIBLE_URL: url, IMMISCIBLE_AGENT_KEY: 'ask_test' });
    assert.deepEqual(out.map((m) => m.id), [1, 2]);
    assert.equal(out[1].result.tools[0].name, 'explain_decision');
    assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list']);
    assert.ok(seen.every((s) => s.auth === 'Bearer ask_test'));
    assert.deepEqual(seen.map((s) => s.session), [null, 'sess-1', 'sess-1']);
    assert.equal(seen[2].protocol, '2025-06-18');
  } finally {
    server.close();
  }

  const down = await run([{ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'request_payment', arguments: {} } }], { IMMISCIBLE_URL: 'http://127.0.0.1:1', IMMISCIBLE_AGENT_KEY: 'ask_test' });
  assert.equal(down[0].id, 7);
  assert.match(down[0].error.message, /could not be reached.*not an allow/);
});

test('the manifest names the bridge, keeps the key secret and lists the server\'s tools', () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.manifest_version, '0.3');
  assert.equal(m.server.entry_point, 'server/index.mjs');
  assert.equal(m.user_config.agent_key.sensitive, true);
  assert.equal(m.server.mcp_config.env.IMMISCIBLE_AGENT_KEY, '${user_config.agent_key}');
  assert.ok(m.description.length <= 100);
  assert.deepEqual(m.tools.map((t) => t.name).sort(), ['authorize_action', 'check_action_status', 'explain_decision', 'find_waste', 'request_payment', 'request_personal_data', 'revoke_key', 'set_budget', 'settle_action', 'spend_summary', 'unwatched_keys']);
});
