/**
 * Where the CLI's sign-in lives, and which server and token a command uses.
 *
 *   ~/.config/immiscible/credentials.json   (or $XDG_CONFIG_HOME/immiscible), mode 0600
 *
 *   { "version": 1, "current": "https://...", "servers": { "https://...": { token, tokenId, user, workspace, scopes, expiresAt, savedAt } } }
 *
 * The server: --url, then IMMISCIBLE_URL, then IMMISCIBLE_URL in the
 * project's .env, then the server you last signed in to, then DEFAULT_URL.
 * The token: --token, then IMMISCIBLE_TOKEN, then the file, for that server.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readEnvFile } from './dotenv.mjs';

export const DEFAULT_URL = 'https://immiscible.ai';

export function configDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(env.HOME || homedir(), '.config');
  return path.join(base, 'immiscible');
}

export const credentialsPath = (env = process.env) => path.join(configDir(env), 'credentials.json');

export function normaliseUrl(u) {
  const s = String(u ?? '').trim().replace(/\/+$/, '');
  if (!s) return null;
  try {
    const x = new URL(s);
    if (!/^https?:$/.test(x.protocol)) return null;
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function readCredentials(env = process.env) {
  const file = credentialsPath(env);
  if (!existsSync(file)) return { version: 1, current: null, servers: {} };
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return { version: 1, current: j.current ?? null, servers: j.servers && typeof j.servers === 'object' ? j.servers : {} };
  } catch {
    return { version: 1, current: null, servers: {} };
  }
}

/** Written to a temporary file with mode 0600, then renamed over the old one. */
export function writeCredentials(creds, env = process.env) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsPath(env);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return file;
}

export function saveLogin(url, entry, env = process.env) {
  const creds = readCredentials(env);
  creds.servers[url] = { ...entry, savedAt: new Date().toISOString() };
  creds.current = url;
  return writeCredentials(creds, env);
}

/** Forget one server's sign-in. Removes the file when nothing is left. */
export function forgetLogin(url, env = process.env) {
  const creds = readCredentials(env);
  if (!creds.servers[url]) return false;
  delete creds.servers[url];
  if (creds.current === url) creds.current = Object.keys(creds.servers)[0] ?? null;
  if (!Object.keys(creds.servers).length) rmSync(credentialsPath(env), { force: true });
  else writeCredentials(creds, env);
  return true;
}

/** { url, urlFrom, token, tokenFrom, saved } for a command run in `dir`. */
export function resolveContext({ flags = {}, env = process.env, dir = process.cwd() } = {}) {
  const creds = readCredentials(env);
  const dotenv = readEnvFile(path.join(dir, '.env')).values;
  const candidates = [
    [flags.url, '--url'],
    [env.IMMISCIBLE_URL, 'IMMISCIBLE_URL'],
    [dotenv.IMMISCIBLE_URL, '.env'],
    [creds.current, 'credentials'],
    [DEFAULT_URL, 'default'],
  ];
  let url = null;
  let urlFrom = null;
  for (const [v, from] of candidates) {
    if (v == null || v === '') continue;
    url = normaliseUrl(v);
    urlFrom = from;
    if (!url) return { url: null, urlFrom: from, badUrl: v, token: null, tokenFrom: null, saved: null, creds };
    break;
  }
  const saved = creds.servers[url] ?? null;
  let token = null;
  let tokenFrom = null;
  if (flags.token) { token = flags.token; tokenFrom = '--token'; }
  else if (env.IMMISCIBLE_TOKEN) { token = env.IMMISCIBLE_TOKEN; tokenFrom = 'IMMISCIBLE_TOKEN'; }
  else if (saved?.token) { token = saved.token; tokenFrom = 'credentials'; }
  // A token from the flag or the environment is not sent to a server only the project's .env names: a
  // repository you cloned, or a pull request in CI, could otherwise choose where your token goes. (A saved
  // sign-in is kept per server, so it only ever goes to the server it was made for.)
  let withheld = null;
  if (urlFrom === '.env' && (tokenFrom === '--token' || tokenFrom === 'IMMISCIBLE_TOKEN')) { withheld = tokenFrom; token = null; tokenFrom = null; }
  return { url, urlFrom, token, tokenFrom, withheld, saved, creds, dotenv };
}
