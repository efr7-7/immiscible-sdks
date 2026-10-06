/**
 * immiscible token create --name ci [--read-only] [--days 30]
 * immiscible token list
 * immiscible token revoke <id>
 *
 * A CI token is a CLI token made on purpose for a machine: it acts for you
 * in the workspace you are signed in to, with your CLI scopes or fewer
 * (--read-only drops adding agents), and expires within 90 days. It is
 * shown once; set it as IMMISCIBLE_TOKEN in the CI system's secrets.
 */

import { EXIT, usage } from '../errors.mjs';

export async function token(ctx) {
  const { ui, flags } = ctx;
  const sub = ctx.rest?.[0] ?? null;
  const client = ctx.api(ctx.requireToken());

  if (sub === 'create') {
    if (typeof flags.name !== 'string' || !flags.name.trim()) throw usage('token create needs --name', 'Run immiscible token create --name ci.');
    const days = flags.days == null ? undefined : Number(flags.days);
    if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= 90)) throw usage('--days is a whole number from 1 to 90');
    const r = await client.post('/v1/cli/tokens', { name: flags.name.trim(), readOnly: Boolean(flags['read-only']), ...(days ? { expiresInDays: days } : {}) });
    if (ui.json) {
      ui.writeJson({ ok: true, url: ctx.url, ...r });
      return EXIT.OK;
    }
    ui.ok(`Made the token ${ui.c.bold(r.name)} ${ui.c.dim(`(${r.id}, expires ${r.expiresAt.slice(0, 10)})`)}`);
    ui.blank();
    ui.out(`  ${r.token}`);
    ui.blank();
    ui.note('Shown once: only a hash is kept. Set it as IMMISCIBLE_TOKEN (and IMMISCIBLE_URL) in your CI secrets.');
    ui.note(`It can ${r.scopes.includes('agents:write') ? 'read agents and status and add agents' : 'read agents and status'}; it never approves. End it with immiscible token revoke ${r.id}.`);
    return EXIT.OK;
  }

  if (sub === 'list') {
    const r = await client.get('/v1/cli/tokens');
    if (ui.json) {
      ui.writeJson({ ok: true, url: ctx.url, data: r.data });
      return EXIT.OK;
    }
    if (!r.data.length) { ui.out('No tokens.'); return EXIT.OK; }
    for (const t of r.data) {
      ui.out(`${ui.c.bold(t.name)}${t.current ? ui.c.dim(' (this one)') : ''}  ${ui.c.dim(`${t.id}, expires ${t.expiresAt.slice(0, 10)}, last used ${t.lastUsedAt ? t.lastUsedAt.slice(0, 10) : 'never'}`)}`);
    }
    return EXIT.OK;
  }

  if (sub === 'revoke') {
    const id = ctx.rest?.[1];
    if (!id) throw usage('token revoke needs the token id', 'Run immiscible token list to see them.');
    const r = await client.del(`/v1/cli/tokens/${encodeURIComponent(id)}`);
    if (ui.json) ui.writeJson({ ok: true, url: ctx.url, ...r });
    else ui.ok(`Revoked ${id}. Calls with it now fail.`);
    return EXIT.OK;
  }

  throw usage(sub ? `unknown token command "${sub}"` : 'token needs a command', 'Use immiscible token create --name ci, token list, or token revoke <id>.');
}
