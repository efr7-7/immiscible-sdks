/**
 * The HTTP client: fetch with a timeout, a User-Agent that names the CLI,
 * and every failure turned into a CliError with the right exit code and
 * the server's own fix where it gave one.
 */

import { hostname, platform } from 'node:os';
import { CliError, EXIT } from './errors.mjs';
import { VERSION } from './version.mjs';

export const USER_AGENT = `immiscible-cli/${VERSION} (node ${process.versions.node}; ${platform()})`;

export function clientName() {
  return `Immiscible CLI on ${hostname().replace(/\.local$/, '').slice(0, 60)}`;
}

/**
 * One request. `auth` is a bearer token. `form` sends
 * application/x-www-form-urlencoded (the OAuth endpoints); `body` sends
 * JSON. Returns { status, ok, json, headers, ms }; never throws for an
 * HTTP status, only for a network failure.
 */
export async function request(base, path, { method = 'GET', auth = null, body, form, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  let payload;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(Object.entries(form).filter(([, v]) => v != null)).toString();
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const t0 = Date.now();
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  } catch (err) {
    const why = err?.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)}s` : (err?.cause?.code ?? err?.message ?? 'connection failed');
    throw new CliError(`could not reach ${base} (${why})`, {
      exit: EXIT.NETWORK, code: 'unreachable',
      fix: 'Check the address (--url or IMMISCIBLE_URL) and your connection, then try again.',
    });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers, ms: Date.now() - t0 };
}

/** The error a non-2xx answer stands for. */
export function errorFrom(r, { what = 'the request' } = {}) {
  const e = r.json?.error;
  const message = (typeof e === 'object' && e?.message) || r.json?.error_description || (typeof e === 'string' ? e : null) || `${what} failed with HTTP ${r.status}`;
  const code = (typeof e === 'object' && e?.type) || (typeof e === 'string' ? e : null) || `http_${r.status}`;
  const fix = (typeof e === 'object' && e?.fix) || null;
  const docs = (typeof e === 'object' && e?.docs) || null;
  let exit = EXIT.REFUSED;
  if (r.status === 401) exit = EXIT.AUTH;
  else if (r.status >= 500) exit = EXIT.ERROR;
  else if (r.status === 404 && !r.json) exit = EXIT.ERROR;
  return new CliError(message, { exit, code, fix, docs, detail: { status: r.status } });
}

/** A client bound to one server and, optionally, one token. */
export function api(base, token = null, { fetchImpl = fetch } = {}) {
  const call = async (method, path, opts = {}) => {
    const r = await request(base, path, { method, auth: opts.auth === undefined ? token : opts.auth, body: opts.body, form: opts.form, timeoutMs: opts.timeoutMs, fetchImpl });
    if (!r.ok && !opts.raw) {
      const err = errorFrom(r, { what: `${method} ${path}` });
      if (r.status === 404 && path.startsWith('/v1/cli/') && !r.json?.error?.fix) {
        err.message = `${base} does not have the CLI API (${path} answered 404); it may run an older version of Immiscible`;
        err.exit = EXIT.ERROR;
        err.code = 'cli_api_missing';
      }
      throw err;
    }
    return opts.raw ? r : r.json;
  };
  return {
    base,
    token,
    get: (p, o) => call('GET', p, o),
    post: (p, b, o = {}) => call('POST', p, { ...o, body: b }),
    del: (p, o) => call('DELETE', p, o),
    form: (p, f, o = {}) => call('POST', p, { ...o, form: f }),
    raw: (method, p, o = {}) => call(method, p, { ...o, raw: true }),
  };
}
