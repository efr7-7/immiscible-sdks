/**
 * immiscible check: the local scan (src/scan.mjs) and the command. What is
 * proved: keys are recognised by shape and reported only as provider,
 * redacted form and fingerprint; MCP servers and Claude Code permissions
 * are ranked riskiest first; without --upload nothing touches the network
 * at all (fetch and every socket are intercepted); with --upload exactly one
 * request goes out, and no secret, redacted key, fingerprint or home path is
 * in it; and the server keeps a report from those findings alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { Writable } from 'node:stream';
import { classifyKey, gitIgnores, claudePermissions, classifyServer, scan, uploadBody } from '../src/scan.mjs';
import { main } from '../src/main.mjs';
import { tmp, bootServer, runCli, inRepo } from './helpers.mjs';

const hex = (n) => randomBytes(n).toString('hex');

/** A project and a home, with real-shaped keys made at run time so no file in the repository holds one. */
function world({ gitignore = '.env\n' } = {}) {
  const secrets = {
    openai: `sk-proj-${randomBytes(36).toString('base64url')}`,
    anthropic: `sk-ant-api03-${randomBytes(60).toString('base64url')}`,
    stripe: `sk_live_${hex(20)}`,
    groq: `gsk_${hex(24)}`,
    bearer: `sk-or-v1-${hex(32)}`,
  };
  const dir = path.join(tmp('imm-check-'), 'hollis-agents');
  const home = tmp('imm-check-home-');
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hollis-agents', dependencies: { '@openai/agents': '1', langchain: '1' } }));
  writeFileSync(path.join(dir, '.env'), `OPENAI_API_KEY=${secrets.openai}\nANTHROPIC_API_KEY="${secrets.anthropic}"\nPLACEHOLDER_KEY=sk-...\nOTHER=hello\n`);
  writeFileSync(path.join(dir, '.env.example'), 'OPENAI_API_KEY=your-key-here\n');
  if (gitignore != null) writeFileSync(path.join(dir, '.gitignore'), gitignore);
  writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {
    stripe: { command: 'npx', args: ['-y', '@stripe/mcp', '--tools=all'], env: { STRIPE_SECRET_KEY: secrets.stripe } },
    postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://localhost/app'] },
    immiscible: { type: 'http', url: 'https://immiscible.fly.dev/mcp', headers: { Authorization: 'Bearer ${IMMISCIBLE_AGENT_KEY}' } },
  } }, null, 2));
  writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)', 'Read', 'mcp__immiscible__spend_summary'] } }));
  writeFileSync(path.join(home, '.zshrc'), `export PATH=$PATH:/opt/bin\nexport GROQ_API_KEY=${secrets.groq}\n`);
  mkdirSync(path.join(home, '.cursor'), { recursive: true });
  writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { openrouter: { url: 'https://example.test/mcp', headers: { Authorization: `Bearer ${secrets.bearer}` } }, gmail: { command: 'npx', args: ['gmail-mcp'] } } }));
  return { dir, home, secrets };
}

/** Everything that must never leave: each key, its body, its redacted form and its fingerprint. */
function forbidden(secrets, result) {
  const out = [];
  for (const v of Object.values(secrets)) out.push(v, v.slice(-16), v.slice(8, 28));
  for (const k of result.keys) out.push(k.redacted, k.fingerprint);
  return out;
}

const sink = () => { let s = ''; return Object.assign(new Writable({ write(c, _e, cb) { s += c; cb(); } }), { text: () => s, isTTY: false }); };

/** Run the command in this process with fetch and every socket intercepted. */
async function runIntercepted(argv, { home, fetchImpl }) {
  const seen = [];
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  globalThis.fetch = async (...a) => { seen.push({ via: 'global fetch', url: String(a[0]) }); throw new Error('the network is off in this test'); };
  net.Socket.prototype.connect = function intercepted(...a) { seen.push({ via: 'socket', to: JSON.stringify(a[0]) }); throw new Error('the network is off in this test'); };
  const stdout = sink();
  const stderr = sink();
  try {
    const code = await main(argv, { env: { HOME: home, NO_COLOR: '1', CI: '1' }, cwd: home, stdout, stderr, stdin: { isTTY: false }, fetchImpl });
    return { code, stdout: stdout.text(), stderr: stderr.text(), seen };
  } finally {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
  }
}

test('scan: keys by shape, placeholders ignored, and only a redacted form and a fingerprint kept', () => {
  const k = `sk-ant-admin01-${hex(30)}`;
  const c = classifyKey(k);
  assert.equal(c.provider, 'anthropic');
  assert.equal(c.redacted, `sk-ant-admin01-...${k.slice(-4)}`);
  assert.match(c.fingerprint, /^sha256:[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(c).includes(k.slice(15, 30)));
  assert.equal(classifyKey(`sk-proj-${hex(30)}`).provider, 'openai');
  assert.equal(classifyKey(`sk-or-v1-${hex(30)}`).provider, 'openrouter');
  assert.equal(classifyKey(`AIza${'a'.repeat(35)}`).provider, 'google');
  assert.equal(classifyKey('sk-...'), null);
  assert.equal(classifyKey('${OPENAI_API_KEY}'), null);
  assert.equal(classifyKey('your-key-here', 'OPENAI_API_KEY'), null);
  assert.equal(classifyKey(hex(20), 'MISTRAL_API_KEY').provider, 'mistral', 'a named variable with an unknown shape still counts');
  assert.equal(classifyKey(hex(20), 'SOMETHING_ELSE'), null);
});

test('scan: git ignore rules, Claude Code permissions and MCP capabilities', () => {
  assert.equal(gitIgnores(null, '.env'), null);
  assert.equal(gitIgnores('.env\n', '.env'), true);
  assert.equal(gitIgnores('.env*\n!.env.example\n', '.env.example'), false);
  assert.equal(gitIgnores('.env*\n', '.env.local'), true);
  assert.equal(gitIgnores('node_modules/\n', '.env'), false);
  assert.deepEqual(claudePermissions({ permissions: { allow: ['Bash(*)'] } }).map((p) => p.capability), ['shell']);
  assert.deepEqual(claudePermissions({ permissions: { allow: ['Bash(npm test:*)'] } }), [], 'a narrow command is not "any command"');
  assert.deepEqual(claudePermissions({ permissions: { defaultMode: 'bypassPermissions' } }).map((p) => p.unlimited), [true]);
  assert.deepEqual(claudePermissions({ permissions: { allow: ['mcp__immiscible__spend_summary'] } }), [], 'Immiscible\'s own tools are not a risk');
  assert.equal(classifyServer('stripe', { command: 'npx', args: ['@stripe/mcp'] }), 'pay');
  assert.equal(classifyServer('db', { args: ['@modelcontextprotocol/server-postgres'] }), 'db_write');
  assert.equal(classifyServer('notes', { url: 'https://notes.example/mcp' }), 'other');
});

test('scan: a project and a home, riskiest first, and the upload body holds no secret', () => {
  const w = world({ gitignore: null });
  const r = scan(w.dir, { home: w.home });
  assert.deepEqual(r.agents, ['OpenAI Agents SDK', 'LangChain']);
  assert.deepEqual(r.mcp.servers.map((s) => `${s.name}:${s.capability}:${s.scope}`).sort(), ['gmail:email:user', 'immiscible:other:project', 'openrouter:other:user', 'postgres:db_write:project', 'stripe:pay:project']);
  assert.equal(r.mcp.servers.find((s) => s.name === 'immiscible').governed, true);
  assert.deepEqual(r.keys.map((k) => `${k.provider}@${k.file}`).sort(), ['anthropic@.env', 'groq@~/.zshrc', 'openai@.env', 'openrouter@~/.cursor/mcp.json', 'stripe@.mcp.json']);
  assert.equal(r.findings[0].subject, 'stripe (MCP)');
  assert.equal(r.findings[0].severity, 'high');
  assert.match(r.findings[0].detail, /live secret key/);
  assert.ok(r.findings.some((f) => f.subject === 'Claude Code' && f.capability === 'shell' && f.severity === 'high'));
  assert.ok(r.findings.some((f) => f.subject === '.env' && /there is no \.gitignore/.test(f.detail)));
  assert.ok(!r.findings.some((f) => /immiscible \(MCP\)/.test(f.subject)), 'the governed server is not a finding');

  const body = JSON.stringify(uploadBody(r));
  for (const s of forbidden(w.secrets, r)) assert.ok(!body.includes(s), `the upload would carry ${s.slice(0, 12)}...`);
  assert.ok(!body.includes(w.home), 'no home path');
  assert.ok(!body.includes(w.dir), 'no project path');
  // Nothing in the scan result itself holds a whole key either.
  const all = JSON.stringify(r);
  for (const v of Object.values(w.secrets)) assert.ok(!all.includes(v));
});

test('check: without --upload nothing touches the network; JSON, exit 11 for a high risk', async () => {
  const w = world();
  const calls = [];
  const r = await runIntercepted(['check', '--json', '--dir', w.dir, '--url', 'https://immiscible.test'], { home: w.home, fetchImpl: async (...a) => { calls.push(a); throw new Error('no'); } });
  assert.equal(r.code, 11, r.stderr + r.stdout);
  assert.deepEqual(calls, [], 'the CLI client was never called');
  assert.deepEqual(r.seen, [], 'no fetch and no socket');
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.ok, true);
  assert.equal(j.local, true);
  assert.equal(j.uploaded, null);
  assert.equal(j.findings[0].rank, 1);
  assert.ok(j.keys.every((k) => /^sha256:[0-9a-f]{12}$/.test(k.fingerprint) && k.redacted.includes('...')));
  assert.equal(j.keys.find((k) => k.file === '.env').ignoredByGit, true);
  for (const v of Object.values(w.secrets)) assert.ok(!r.stdout.includes(v), 'no key in the output');

  // The same as a person reads it.
  const t = await runIntercepted(['check', '--dir', w.dir, '--url', 'https://immiscible.test'], { home: w.home, fetchImpl: async () => { throw new Error('no'); } });
  assert.match(t.stdout, /nothing left this machine/);
  assert.match(t.stdout, /Riskiest first/);
  assert.match(t.stdout, /1 {2}stripe \(MCP, \.mcp\.json\) can make payments/);
  assert.deepEqual(t.seen, []);
  for (const v of Object.values(w.secrets)) assert.ok(!t.stdout.includes(v));

  // A quiet project exits 0.
  const quiet = tmp('imm-quiet-');
  const q = await runIntercepted(['check', '--json', '--dir', quiet, '--url', 'https://immiscible.test'], { home: tmp('imm-quiet-home-'), fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(q.code, 0);
  assert.deepEqual(JSON.parse(q.stdout).findings, []);
});

test('check --upload: one request, the findings only, never a key', async () => {
  const w = world();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), method: init.method, body: init.body, headers: init.headers });
    return new Response(JSON.stringify({ share: { page: '/check/r/chk_x', expiresAt: '2026-10-13T00:00:00.000Z' } }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const r = await runIntercepted(['check', '--upload', '--json', '--dir', w.dir, '--url', 'https://immiscible.test'], { home: w.home, fetchImpl });
  assert.equal(r.code, 11, r.stderr);
  assert.deepEqual(r.seen, [], 'only the CLI\'s own client was used');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://immiscible.test/api/check/upload');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].headers.authorization, undefined, 'no token is needed or sent');
  const body = JSON.parse(sent[0].body);
  assert.deepEqual(Object.keys(body), ['permissions']);
  assert.ok(body.permissions.length >= 4);
  for (const p of body.permissions) assert.deepEqual(Object.keys(p).sort(), ['asksFirst', 'capability', 'detail', 'subject', 'unlimited']);
  const scanned = scan(w.dir, { home: w.home });
  for (const s of forbidden(w.secrets, scanned)) assert.ok(!sent[0].body.includes(s), `sent ${s.slice(0, 12)}...`);
  assert.ok(!sent[0].body.includes(w.home) && !sent[0].body.includes(w.dir));
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.uploaded.url, 'https://immiscible.test/check/r/chk_x');
  assert.equal(j.uploaded.sent, body.permissions.length);
});

test('check --upload against the real server: a kept report from the findings alone, and no secret stored', { skip: inRepo ? false : 'not inside the Immiscible repository', timeout: 120_000 }, async (t) => {
  const s = await bootServer();
  t.after(s.stop);
  const w = world();
  const r = await runCli(['check', '--upload', '--json', '--dir', w.dir, '--url', s.base], { cwd: w.dir, home: w.home });
  assert.equal(r.code, 11, r.stderr + r.stdout);
  assert.match(r.json.uploaded.url, new RegExp(`^${s.base}/check/r/chk_`));
  const token = r.json.uploaded.url.split('/').pop();
  const got = await fetch(`${s.base}/api/check/${token}`).then((x) => x.json());
  assert.equal(got.report.doors.local_scan, true);
  assert.equal(got.report.spend.totalMicros, 0, 'no spend was sent, and none is invented');
  assert.equal(got.report.permissions.items[0].capability, 'pay');
  const tables = s.app.db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((x) => x.name);
  const everything = tables.map((n) => JSON.stringify(s.app.db.all(`SELECT * FROM "${n}"`))).join('\n');
  for (const v of Object.values(w.secrets)) assert.ok(!everything.includes(v) && !everything.includes(v.slice(-16)), 'no key is stored');
});
