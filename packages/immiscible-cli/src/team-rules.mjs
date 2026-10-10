/**
 * The team's rules for coding agents on this machine (immiscible guard --team):
 * fetched from the workspace, checked against the signature this deployment's
 * key made (its published key set), and written to ~/.immiscible/team-rules.json,
 * where the local hooks read them (scripts/local-policy.mjs, lpTeam).
 *
 * The rules only add to the built-in ones: a team rule can refuse or ask about
 * more, never allow what those stop. A file that does not verify is never
 * written, and the one already there is kept.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import path from 'node:path';
import { fetchJwks } from './vendor/verify.mjs';
import { CliError, EXIT } from './errors.mjs';
import { homeOf } from './agent-hooks.mjs';

export const TEAM_TYP = 'immiscible-coding-rules+jwt';

/** Where the rules go: the person's own file, or (--scope managed) the machine's, which the hooks read when there is no own file. */
export function teamRulesPath(env = process.env, scope = 'user', platform = process.platform) {
  if (env.IMMISCIBLE_TEAM_RULES) return path.resolve(env.IMMISCIBLE_TEAM_RULES);
  if (scope === 'managed') return platform === 'win32' ? path.join(env.ProgramData || 'C:\\ProgramData', 'immiscible', 'team-rules.json') : '/etc/immiscible/team-rules.json';
  return path.join(homeOf(env), '.immiscible', 'team-rules.json');
}

/** The rules on this machine: { version, workspace, fetchedAt, rules } or null. */
export function readTeamRules(env = process.env, scope = 'user') {
  try {
    const j = JSON.parse(readFileSync(teamRulesPath(env, scope), 'utf8'));
    return j && typeof j === 'object' && j.rules ? j : null;
  } catch { return null; }
}

export function removeTeamRules(env = process.env, scope = 'user') {
  const f = teamRulesPath(env, scope);
  if (!existsSync(f)) return false;
  rmSync(f, { force: true });
  return true;
}

const b64u = (s) => Buffer.from(s, 'base64url');

/** Check a compact JWS against a key set: the claims, or a reason it does not verify. */
export function verifyTeamToken(token, jwks, { workspaceId, version, issuer }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'the rules came unsigned' };
  let header;
  let claims;
  try { header = JSON.parse(b64u(parts[0]).toString('utf8')); claims = JSON.parse(b64u(parts[1]).toString('utf8')); } catch { return { ok: false, reason: 'the signed rules could not be read' }; }
  if (header.alg !== 'EdDSA' || header.typ !== TEAM_TYP) return { ok: false, reason: 'the rules are not signed as team rules' };
  const jwk = (jwks?.keys ?? []).find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'the rules were signed with a key the server does not publish' };
  let good = false;
  try { good = edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' }), b64u(parts[2])); } catch { good = false; }
  if (!good) return { ok: false, reason: 'the signature on the rules does not verify' };
  if (claims.sub !== workspaceId || claims.ver !== version) return { ok: false, reason: 'the signed rules are for another workspace or version' };
  if (issuer && String(claims.iss ?? '').replace(/\/$/, '') !== String(issuer).replace(/\/$/, '')) return { ok: false, reason: 'the rules were signed by another server' };
  return { ok: true, claims };
}

/** Fetch, verify and write the team's rules. Returns { version, counts, changed, file }. */
export async function syncTeamRules(ctx, { dryRun = false, scope = 'user', refreshOnly = false, fetchImpl = globalThis.fetch } = {}) {
  ctx.requireToken();
  const got = await ctx.api().get('/v1/cli/coding-policy');
  // A refresh (scan --share) only ever updates the rules of the workspace and server that set them.
  const was = readTeamRules(ctx.env, scope);
  if (refreshOnly && was && (was.workspace !== got.workspace?.id || String(was.server ?? '').replace(/\/$/, '') !== String(ctx.url).replace(/\/$/, ''))) {
    return { version: was.version, counts: null, changed: false, file: teamRulesPath(ctx.env, scope), skipped: 'signed in to another workspace or server than the one these rules came from' };
  }
  const jwks = await fetchJwks(ctx.url, { fetch: fetchImpl }).catch((err) => { throw new CliError(`could not read the server's published keys to check the rules (${err.message})`, { exit: EXIT.NETWORK, code: 'keys_unavailable', fix: 'Check the server address and try again.' }); });
  const v = verifyTeamToken(got.token, jwks, { workspaceId: got.workspace?.id, version: got.version, issuer: null });
  if (!v.ok) throw new CliError(`the team's rules were not written: ${v.reason}`, { exit: EXIT.INVALID, code: 'rules_not_verified', fix: 'Nothing on this machine changed. Check you are signed in to the right server.' });
  // What is written is what was signed, not what came beside it.
  const rules = v.claims.rules;
  const file = teamRulesPath(ctx.env, scope);
  const before = was;
  const next = { version: v.claims.ver, workspace: v.claims.sub, server: ctx.url, fetchedAt: new Date().toISOString(), rules };
  const changed = !before || before.version !== next.version || before.workspace !== next.workspace;
  if (!dryRun) {
    // The machine's file is read by every person's hooks, so everyone can read it; only an administrator writes it.
    const shared = scope === 'managed';
    mkdirSync(path.dirname(file), { recursive: true, mode: shared ? 0o755 : 0o700 });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: shared ? 0o644 : 0o600 });
    if (shared) { try { chmodSync(path.dirname(file), 0o755); chmodSync(file, 0o644); } catch { /* Windows: the folder's own permissions apply */ } }
  }
  const counts = { deny: rules.deny?.length ?? 0, ask: rules.ask?.length ?? 0, protectedBranches: rules.protectedBranches?.length ?? 0, blockedDomains: rules.blockedDomains?.length ?? 0 };
  return { version: next.version, counts, changed, file };
}
