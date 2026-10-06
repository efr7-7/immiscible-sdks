#!/usr/bin/env node
/**
 * The plugin's MCP server: a stdio bridge to Immiscible's remote MCP server
 * (Streamable HTTP). Claude Code fills ${VAR} in an MCP entry from the shell
 * only, so a plugin entry of type http never saw the key `npx immiscible init`
 * writes to the project's .env. This bridge reads it there, as the hook does.
 *
 *   IMMISCIBLE_URL        the server (default https://immiscible.fly.dev)
 *   IMMISCIBLE_AGENT_KEY  the agent key, sent as a bearer token
 *
 * Each is read from the environment first, then from .env in the project
 * (CLAUDE_PROJECT_DIR, or the directory Claude Code starts the server in);
 * a variable already in the environment wins, as with Node's --env-file.
 * Each is also read under its older ASSAY_ name. The key is never printed.
 *
 * When Immiscible cannot be reached, a request gets a JSON-RPC error, never a
 * made-up answer: no decision is not an allow. No dependencies.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import * as util from 'node:util';

/** KEY=value lines; # comments, `export `, and single or double quotes. */
function parseEnv(text) {
  if (typeof util.parseEnv === 'function') return util.parseEnv(text);
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = /^(['"])([\s\S]*)\1$/.exec(v);
    v = q ? q[2] : v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function fromDotenv() {
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    return parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
  } catch {
    return {};
  }
}

// Only IMMISCIBLE_URL, IMMISCIBLE_AGENT_KEY and IMMISCIBLE_TIMEOUT_MS (and their
// ASSAY_ names) are read from .env; nothing else in it is touched.
const file = fromDotenv();
const env = (name) => process.env[`IMMISCIBLE_${name}`] || process.env[`ASSAY_${name}`] || file[`IMMISCIBLE_${name}`] || file[`ASSAY_${name}`] || '';

const endpoint = `${(env('URL') || 'https://immiscible.fly.dev').replace(/\/+$/, '')}/mcp`;
const key = env('AGENT_KEY').trim();
const TIMEOUT_MS = Math.min(Number(env('TIMEOUT_MS')) || 30_000, 120_000);

let session = null;
let protocol = null;

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const fail = (id, message) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };

function messagesFrom(text, type) {
  if (!text.trim()) return [];
  if (/text\/event-stream/.test(type)) {
    const out = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) out.push(JSON.parse(data));
    }
    return out;
  }
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : [j];
}

async function forward(msg) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'immiscible-claude-code-plugin' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (session) headers['mcp-session-id'] = session;
  if (protocol) headers['mcp-protocol-version'] = protocol;
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return fail(msg.id, `Immiscible could not be reached at ${endpoint} (${e?.name === 'TimeoutError' ? 'timed out' : e?.message ?? e}). Do not act: no decision is not an allow.`);
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  const text = await res.text();
  if (res.status === 202 || res.status === 204) return;
  let out;
  try {
    out = messagesFrom(text, res.headers.get('content-type') || '');
  } catch {
    return fail(msg.id, `Immiscible answered HTTP ${res.status} with something that is not JSON-RPC.`);
  }
  if (!out.length) return fail(msg.id, `Immiscible answered HTTP ${res.status} with no message.`);
  for (const m of out) {
    if (msg.method === 'initialize' && m?.result?.protocolVersion) protocol = m.result.protocolVersion;
    write(m);
  }
}

if (!key) process.stderr.write('immiscible: IMMISCIBLE_AGENT_KEY is not set in the environment or the project .env (npx immiscible init writes it); every call will be refused until it is.\n');

let chain = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  chain = chain.then(() => forward(msg)).catch((e) => fail(msg?.id, String(e?.message ?? e)));
});
rl.on('close', () => { chain.finally(() => process.exit(0)); });
