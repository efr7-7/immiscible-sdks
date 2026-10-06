/**
 * immiscible login: the OAuth 2.0 Device Authorization Grant (RFC 8628),
 * with PKCE. The browser shows the same code as the terminal; the person
 * allows it and picks a workspace; the CLI stores the token it polled for
 * in ~/.config/immiscible/credentials.json (mode 0600).
 *
 * immiscible login --token imc_... stores a token you already have (CI),
 * after checking the server accepts it.
 */

import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { saveLogin, credentialsPath } from '../config.mjs';
import { request, errorFrom, clientName } from '../api.mjs';
import { CliError, EXIT } from '../errors.mjs';

export const CLIENT_ID = 'immiscible-cli';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const SCOPE = 'agents:read agents:write approvals:read status:read';

function openBrowser(url) {
  try {
    const os = platform();
    const [cmd, args] = os === 'darwin' ? ['open', [url]] : os === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function storeToken(ctx, token, { quiet = false } = {}) {
  const who = await ctx.api(token).get('/v1/cli/whoami');
  const file = saveLogin(ctx.url, {
    token, tokenId: who.token.id, scopes: who.token.scopes, expiresAt: who.token.expiresAt,
    user: { id: who.user.id, email: who.user.email }, workspace: { id: who.workspace.id, name: who.workspace.name },
  }, ctx.env);
  if (!quiet) ctx.ui.ok(`Signed in as ${ctx.ui.c.bold(who.user.email)} to ${ctx.ui.c.bold(who.workspace.name)}`);
  return { who, file };
}

export async function login(ctx) {
  const { ui, flags } = ctx;
  if (flags.token) {
    const { who, file } = await storeToken(ctx, flags.token);
    ui.note(`Saved to ${file}`);
    if (ui.json) ui.writeJson({ ok: true, url: ctx.url, user: who.user, workspace: who.workspace, token: { id: who.token.id, expiresAt: who.token.expiresAt }, credentials: file });
    return EXIT.OK;
  }

  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const start = await request(ctx.url, '/oauth/device', {
    method: 'POST', fetchImpl: ctx.fetchImpl,
    form: { client_id: CLIENT_ID, scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', client_name: clientName() },
  });
  if (!start.ok || !start.json?.device_code) {
    if (start.status === 404) throw new CliError(`${ctx.url} does not offer device sign-in (POST /oauth/device answered 404); it may run an older version of Immiscible`, { exit: EXIT.ERROR, code: 'device_flow_missing', fix: 'Create a CLI token in the console and run immiscible login --token <token>.' });
    throw errorFrom(start, { what: 'starting sign-in' });
  }
  const d = start.json;
  if (ui.json) {
    // JSON mode prints two lines: this one now, so a person can be shown the code, and the result.
    ui.writeJson({ event: 'device', user_code: d.user_code, verification_uri: d.verification_uri, verification_uri_complete: d.verification_uri_complete, expires_in: d.expires_in });
  } else {
    ui.out(`Your one-time code: ${ui.c.bold(d.user_code)}`);
    ui.out(`Open ${ui.c.cyan(d.verification_uri_complete)} and allow it.`);
    if (ui.interactive && !flags['no-browser'] && openBrowser(d.verification_uri_complete)) ui.note('Opened your browser. Check the code matches before you allow it.');
  }

  let interval = Math.max(1, Number(d.interval) || 5);
  const deadline = Date.now() + (Number(d.expires_in) || 600) * 1000;
  const token = await ui.spin('Waiting for you to allow it in the browser', async () => {
    for (;;) {
      await sleep(interval * 1000);
      if (Date.now() > deadline) throw new CliError('the code expired before anyone allowed it', { exit: EXIT.DENIED, code: 'expired_token', fix: 'Run immiscible login again.' });
      const r = await request(ctx.url, '/oauth/token', {
        method: 'POST', fetchImpl: ctx.fetchImpl,
        form: { grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: CLIENT_ID, code_verifier: verifier },
      });
      if (r.ok && r.json?.access_token) return r.json;
      const e = r.json?.error;
      if (e === 'authorization_pending') continue;
      if (e === 'slow_down') { interval = Math.max(interval + 5, Number(r.json?.interval) || 0); continue; }
      if (e === 'access_denied') throw new CliError('the sign-in was denied in the browser', { exit: EXIT.DENIED, code: 'access_denied', fix: 'Run immiscible login again if that was a mistake.' });
      if (e === 'expired_token') throw new CliError('the code expired before anyone allowed it', { exit: EXIT.DENIED, code: 'expired_token', fix: 'Run immiscible login again.' });
      throw errorFrom(r, { what: 'signing in' });
    }
  });

  const file = saveLogin(ctx.url, {
    token: token.access_token, tokenId: token.token_id ?? null, scopes: String(token.scope ?? '').split(' ').filter(Boolean),
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
    user: token.user ?? null, workspace: token.workspace ?? null,
  }, ctx.env);
  if (ui.json) {
    ui.writeJson({ ok: true, url: ctx.url, user: token.user, workspace: token.workspace, token: { id: token.token_id ?? null, expiresIn: token.expires_in }, credentials: file });
  } else {
    ui.ok(`Signed in as ${ui.c.bold(token.user?.email ?? 'you')} to ${ui.c.bold(token.workspace?.name ?? 'your workspace')}`);
    ui.note(`Token saved to ${file}. End it any time with immiscible logout, or from your sessions in the console.`);
  }
  return EXIT.OK;
}

export { storeToken, credentialsPath };
