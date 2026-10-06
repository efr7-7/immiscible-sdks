/**
 * Test harness: the real Immiscible server, booted in-process from the
 * repository (an in-memory database, mock upstreams), people who sign up
 * and allow CLI sign-ins, and the CLI run as a child process with its own
 * HOME, exactly as a person or a CI job would run it.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = new URL('../../../src/server/app.js', import.meta.url);
const CONFIG = new URL('../../../src/platform/config.js', import.meta.url);
export const inRepo = existsSync(fileURLToPath(APP)) && existsSync(fileURLToPath(CONFIG));
export const BIN = fileURLToPath(new URL('../bin/immiscible.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const PW = 'correct horse battery staple';

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

export async function bootServer() {
  const { loadConfig } = await import(CONFIG);
  const { createApp } = await import(APP);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    DATABASE_FILE: ':memory:', IMMISCIBLE_MASTER_KEY: randomBytes(32).toString('base64'), IMMISCIBLE_SEED_DEMO: 'false',
    IMMISCIBLE_LOG: 'off', IMMISCIBLE_FORCE_MOCK: 'true', IMMISCIBLE_REQUIRE_EMAIL_VERIFICATION: 'false', IMMISCIBLE_AUTH_RPM: '1000',
    PORT: String(port), PUBLIC_URL: base,
  });
  const quiet = { info() {}, error() {}, warn() {}, request() {} };
  const app = createApp({ config, log: quiet, fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  return { app, base, stop: () => new Promise((r) => app.server.close(() => { app.close?.(); r(); })) };
}

/** A person with a browser session: signs up, and calls the console API. */
export async function person(base, email = `dev-${randomBytes(4).toString('hex')}@cli.test`) {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-immiscible-csrf': '1', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (/^(__Host-)?sid=/.test(c) && !/max-age=0/i.test(c)) cookie = c.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const su = await call('POST', '/api/auth/signup', { email, password: PW, name: 'Dev Person', company: 'Acme' });
  if (su.status !== 201) throw new Error(`signup failed: ${su.status} ${su.text}`);
  return { email, wid: su.json.workspace.id, user: su.json.user, call, cookie: () => cookie };
}

export const pkce = () => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export async function form(base, p, fields) {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The device flow over HTTP, allowed by `who`: returns the CLI token. */
export async function mintToken(base, who, wid = who.wid) {
  const { verifier, challenge } = pkce();
  const d = await form(base, '/oauth/device', { client_id: 'immiscible-cli', code_challenge: challenge, code_challenge_method: 'S256', client_name: 'test' });
  const ok = await who.call('POST', '/api/me/device', { code: d.json.user_code, workspaceId: wid, decision: 'approve' });
  if (ok.status !== 200) throw new Error(`approve failed: ${ok.status} ${ok.text}`);
  const t = await form(base, '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.json.device_code, client_id: 'immiscible-cli', code_verifier: verifier });
  if (!t.json?.access_token) throw new Error(`token failed: ${JSON.stringify(t.json)}`);
  return t.json.access_token;
}

export function tmp(prefix = 'imm-cli-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A copy of a fixture project in a fresh directory. dot-env becomes .env (the repository ignores .env). */
export function fixture(name) {
  const dir = path.join(tmp(), name);
  cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f === 'dot-env') renameSync(path.join(dir, f), path.join(dir, '.env'));
  return dir;
}

/**
 * Run the CLI as a child process. Never spawnSync: the server under test
 * runs in this process and must keep answering.
 */
export function runCli(args, { cwd, home, env = {}, input = null, onStdout = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: '', CI: '1', NO_COLOR: '1', ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; onStdout?.(stdout, child); });
    child.stderr.on('data', (d) => { stderr += d; });
    if (input != null) child.stdin.end(input); else child.stdin.end();
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout.trim().split('\n').at(-1)); } catch { /* not JSON */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}
