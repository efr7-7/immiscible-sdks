#!/usr/bin/env node
/**
 * Immiscible for Claude Desktop: a stdio MCP server that forwards every
 * message to Immiscible's remote MCP server (Streamable HTTP) and returns
 * its answers. No dependencies; Node 18 or later.
 *
 *   IMMISCIBLE_URL        the server (default https://immiscible.ai)
 *   IMMISCIBLE_AGENT_KEY  the agent key (ask_...), sent as a bearer token
 *
 * It holds nothing but the session id the server issues. When the server
 * cannot be reached, a request gets a JSON-RPC error, never a made-up
 * answer: the model is told Immiscible could not decide, which is not an
 * allow.
 */

import { createInterface } from 'node:readline';

const base = (process.env.IMMISCIBLE_URL || 'https://immiscible.ai').replace(/\/+$/, '');
const endpoint = `${base}/mcp`;
const key = (process.env.IMMISCIBLE_AGENT_KEY || '').trim();
const TIMEOUT_MS = Math.min(Number(process.env.IMMISCIBLE_TIMEOUT_MS) || 30_000, 120_000);

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
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'immiscible-desktop/0.1.1' };
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

if (!key) process.stderr.write('immiscible-desktop: IMMISCIBLE_AGENT_KEY is not set; every call will be refused until it is.\n');

let chain = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  chain = chain.then(() => forward(msg)).catch((e) => fail(msg?.id, String(e?.message ?? e)));
});
rl.on('close', () => { chain.finally(() => process.exit(0)); });
