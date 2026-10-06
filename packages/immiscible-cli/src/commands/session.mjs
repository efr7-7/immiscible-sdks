/**
 * immiscible whoami and immiscible logout.
 */

import { forgetLogin, credentialsPath } from '../config.mjs';
import { request } from '../api.mjs';
import { EXIT } from '../errors.mjs';

const SOURCE = { '--token': 'the --token flag', IMMISCIBLE_TOKEN: 'IMMISCIBLE_TOKEN', credentials: credentialsPath() };

export async function whoami(ctx) {
  const { ui } = ctx;
  const who = await ctx.api(ctx.requireToken()).get('/v1/cli/whoami');
  if (ui.json) {
    ui.writeJson({ ok: true, url: ctx.url, user: who.user, workspace: who.workspace, token: { ...who.token, source: ctx.tokenFrom }, can: who.can, server: who.server });
    return EXIT.OK;
  }
  ui.table([
    ['Signed in as', ui.c.bold(who.user.email)],
    ['Workspace', `${who.workspace.name} ${ui.c.dim(`(${who.workspace.role}, ${who.workspace.id})`)}`],
    ['Server', `${ctx.url}${who.server?.version ? ui.c.dim(` (version ${who.server.version})`) : ''}`],
    ['Token', `${who.token.name} ${ui.c.dim(`(${who.token.id}, expires ${who.token.expiresAt.slice(0, 10)})`)}`],
    ['Token from', ctx.tokenFrom === 'credentials' ? credentialsPath(ctx.env) : SOURCE[ctx.tokenFrom] ?? ctx.tokenFrom],
    ['Can add agents', who.can?.addAgents ? 'yes' : 'no, your role cannot'],
  ]);
  return EXIT.OK;
}

export async function logout(ctx) {
  const { ui } = ctx;
  if (!ctx.saved?.token) {
    const envToken = ctx.tokenFrom === 'IMMISCIBLE_TOKEN';
    if (ui.json) ui.writeJson({ ok: true, url: ctx.url, signedOut: false, reason: 'not_signed_in', ...(envToken ? { note: 'IMMISCIBLE_TOKEN is set; unset it to stop using it' } : {}) });
    else {
      ui.out(`Not signed in to ${ctx.url}.`);
      if (envToken) ui.note('IMMISCIBLE_TOKEN is set in your environment; unset it to stop using it. Revoke it in the console.');
    }
    return EXIT.OK;
  }
  // Revoke on the server first; forget it locally whatever the server says.
  let revoked = false;
  let note = null;
  try {
    const r = await request(ctx.url, '/v1/cli/token', { method: 'DELETE', auth: ctx.saved.token, fetchImpl: ctx.fetchImpl, timeoutMs: 10_000 });
    revoked = r.ok;
    if (!r.ok && r.status !== 401) note = `the server answered ${r.status}; the token may still be live until it expires or you end it in the console`;
  } catch (err) {
    note = `${err.message}; the token was forgotten here, end it in the console under your sessions`;
  }
  forgetLogin(ctx.url, ctx.env);
  if (ui.json) {
    ui.writeJson({ ok: true, url: ctx.url, signedOut: true, revoked, ...(note ? { note } : {}) });
  } else {
    ui.ok(`Signed out of ${ctx.url}`);
    if (note) ui.warn(note);
  }
  return EXIT.OK;
}
