/**
 * immiscible attest: what the coding agents did on this branch, and under
 * which rules, as an in-toto Statement a reviewer can read and a machine can
 * check.
 *
 *   immiscible attest                 the statement for this branch, read on this machine
 *   immiscible attest --comment       also post it on the branch's pull request (needs gh), updated in place
 *   immiscible attest --sign          also have your workspace sign it (signed in); immiscible verify checks it
 *   immiscible attest --out file      also write the statement as JSON
 *   immiscible attest --base <ref>    the branch it is measured from (default: origin's default branch, main or master)
 *   immiscible attest --check         in CI: the pull request's signed attestation, checked (--strict: one must exist and be current)
 *
 * It reads the agents' own history and the guard's hash-chained decision log,
 * as scan does, and keeps only what belongs to this branch: sessions whose
 * branch is this one (or, for agents that do not record a branch, that ran in
 * this repository since the branch began), and the decisions made in them.
 *
 * The statement holds counts, agent and model names, rule names, the cost at
 * list prices, the commit and the hash at the end of each day's log: never a
 * command, path, prompt, domain or file. Nothing leaves the machine unless
 * --comment or --sign is given.
 */

import { homedir } from 'node:os';
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import path from 'node:path';
import { readHistory } from '../history/readers.mjs';
import { readDecisions, logDir } from '../history/recorder.mjs';
import { guardSessions, guardSummary } from '../history/guard-log.mjs';
import { AGENT_LABELS, usd } from '../history/analyse.mjs';
import { sessionCost } from './cost.mjs';
import { repoName } from './scan.mjs';
import { readTeamRules } from '../team-rules.mjs';
import { fetchJwks } from '../vendor/verify.mjs';
import { VERSION } from '../version.mjs';
import { CliError, EXIT, usage } from '../errors.mjs';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PREDICATE_TYPE = 'https://immiscible.ai/attestation/coding-agents/v1';
export const ATTEST_TYP = 'immiscible-attestation+jwt';
export const MARKER = '<!-- immiscible:attest -->';
const DAY = 86_400_000;

const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : null;
};

const inside = (dir, repo) => typeof dir === 'string' && (dir === repo || dir.startsWith(`${repo}${path.sep}`));

/** The ref the branch is measured from: --base, else origin's default branch, else main, else master. */
function baseRef(repo, flag) {
  if (flag) {
    if (!git(repo, ['rev-parse', '--verify', '--quiet', `${flag}^{commit}`])) throw usage(`--base ${flag} is not a commit here`, 'Name a branch or commit, such as --base origin/main.');
    return flag;
  }
  const head = git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  for (const r of [head, 'origin/main', 'origin/master', 'main', 'master']) {
    if (r && git(repo, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`])) return r;
  }
  return null;
}

/**
 * When the branch began: the oldest of its reflog's first entry and its first
 * commit, and never before the commit it was branched from. In ms.
 */
function branchStart(repo, branch, mergeBase) {
  const times = [];
  const reflog = git(repo, ['reflog', 'show', '--date=unix', '--format=%gd', `refs/heads/${branch}`]);
  const last = reflog?.split('\n').filter(Boolean).pop();
  const m = last && /@\{(\d+)\}$/.exec(last);
  if (m) times.push(Number(m[1]) * 1000);
  const first = git(repo, ['log', '--reverse', '--format=%at', `${mergeBase}..HEAD`])?.split('\n').filter(Boolean)[0];
  if (first) times.push(Number(first) * 1000);
  const floor = Number(git(repo, ['log', '-1', '--format=%ct', mergeBase]) ?? 0) * 1000;
  const t = times.length ? Math.min(...times) : floor;
  return Math.max(t, floor);
}

/**
 * Build the statement for the branch checked out in `dir`. Returns
 * { statement, sessions, summary } or throws a usage error that says why not.
 */
export function buildStatement({ dir, home, env = {}, base: baseFlag = null, now = Date.now() }) {
  const repo = git(dir, ['rev-parse', '--show-toplevel']);
  if (!repo) throw usage('attest describes a branch, and this is not a git repository', 'Run it inside the repository, on the branch the agents worked on.');
  const branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) throw usage('HEAD is detached, so there is no branch to describe', 'Check out the branch first: git switch <branch>');
  const head = git(repo, ['rev-parse', 'HEAD']);
  if (!head) throw usage('the branch has no commits yet', 'Commit first, then attest.');
  const base = baseRef(repo, baseFlag);
  if (!base) throw usage('could not find the branch this one starts from', 'Name it: immiscible attest --base origin/main');
  const short = base.replace(/^origin\//, '');
  if (!baseFlag && (branch === short || branch === base)) throw usage(`you are on ${branch}, the branch others are measured from`, 'Run attest on a feature branch, or name another base with --base.');
  const mergeBase = git(repo, ['merge-base', base, 'HEAD']);
  if (!mergeBase) throw usage(`${branch} and ${base} share no history`, 'Name the right base with --base.');
  const commits = Number(git(repo, ['rev-list', '--count', `${mergeBase}..HEAD`]) ?? 0);
  const from = Math.min(branchStart(repo, branch, mergeBase), now);

  // The agents' own history, and the agents seen only through the guard's log.
  // A session on this branch counts whenever it ran (an agent often starts before it makes the branch).
  const { sessions: history } = readHistory({ home, env, since: from - 30 * DAY, projectDirs: [repo] });
  const otherBranch = new Set();
  const mine = [];
  for (const s of history) {
    if (!inside(s.cwd, repo)) continue;
    const b = s.branch && s.branch !== 'HEAD' ? s.branch : null;
    const overlaps = (s.endedAt ?? s.startedAt ?? 0) >= from;
    if (b === branch || (!b && overlaps)) mine.push(s);
    else otherBranch.add(`${s.agent}:${s.id}`);
  }
  const mineIds = new Set(mine.map((s) => `${s.agent}:${s.id}`));
  const earliest = Math.min(from, ...mine.map((s) => s.startedAt ?? from));
  const log = readDecisions(logDir(home, env), earliest);
  const decisions = log.decisions.filter((d) => {
    const key = `${d.client}:${d.session}`;
    if (mineIds.has(key)) return true;
    return inside(d.dir, repo) && d.atMs >= from && !otherBranch.has(key);
  });
  const known = new Set(mine.map((s) => s.agent));
  for (const s of guardSessions(decisions)) if (!known.has(s.agent) && s.calls.length) mine.push(s);

  // Per agent: sessions, models, cost, and how many of its calls the guard decided.
  const agents = new Map();
  for (const s of mine) {
    const a = agents.get(s.agent) ?? { agent: s.agent, sessions: 0, models: new Set(), costMicros: 0, unpriced: false, decisions: 0 };
    a.sessions += 1;
    for (const m of Object.keys(s.usage ?? {})) if (/^[\w.:@/-]{1,80}$/.test(m)) a.models.add(m);
    if (s.costUnknown) a.unpriced = true;
    else { const c = sessionCost(s.usage); a.costMicros += Math.round(c.micros); a.unpriced ||= c.unpriced; }
    agents.set(s.agent, a);
  }
  const g = guardSummary({ decisions, days: [] }, earliest) ?? { total: 0, allow: 0, ask: 0, deny: 0, settings: 0, paused: 0, rules: [], byAgent: [] };
  for (const b of g.byAgent ?? []) {
    const a = agents.get(b.agent) ?? { agent: b.agent, sessions: 0, models: new Set(), costMicros: 0, unpriced: false, decisions: 0 };
    a.decisions = b.allow + b.ask + b.deny;
    agents.set(b.agent, a);
  }
  const list = [...agents.values()]
    .filter((a) => /^[a-z][a-z0-9-]{0,39}$/.test(a.agent))
    .map((a) => ({ agent: a.agent, sessions: a.sessions, models: [...a.models].sort().slice(0, 5), costMicros: a.costMicros, unpriced: a.unpriced, decisions: a.decisions }))
    .sort((x, y) => y.sessions - x.sessions || x.agent.localeCompare(y.agent))
    .slice(0, 20);

  const fromDay = new Date(earliest).toISOString().slice(0, 10);
  const days = log.days.filter((d) => d.file.slice(0, 10) >= fromDay);
  const team = ['user', 'managed'].map((scope) => ({ scope, r: readTeamRules(env, scope) })).filter((x) => x.r?.version).map((x) => ({ scope: x.scope, version: x.r.version }));
  const total = list.reduce((n, a) => n + a.costMicros, 0);

  const statement = {
    _type: STATEMENT_TYPE,
    subject: [{ name: `${repoName(repo, env)}@${branch}`.replace(/[^\w.@:/+-]/g, '-').slice(0, 200), digest: { gitCommit: head } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      generator: { name: 'immiscible', version: VERSION },
      base: { ref: short.slice(0, 120), commit: mergeBase },
      commits,
      window: { from: new Date(earliest).toISOString(), to: new Date(now).toISOString() },
      agents: list,
      guard: {
        decisions: g.total,
        allowed: g.allow,
        asked: g.ask,
        refused: g.deny,
        paused: g.paused ?? 0,
        settingsKept: g.settings ?? 0,
        rules: (g.rules ?? []).map((r) => ({ rule: r.rule, decision: r.decision, count: r.count })),
        unguarded: list.filter((a) => a.sessions && !a.decisions).map((a) => a.agent),
        teamRules: team,
      },
      log: {
        verifies: days.every((d) => d.ok),
        days: days.slice(-14).map((d) => ({ day: d.file.slice(0, 10), entries: d.entries, ok: d.ok, head: d.head })),
      },
      cost: { micros: total, unpriced: list.some((a) => a.unpriced), basis: 'list prices' },
    },
  };
  return { statement, repo, branch };
}

const cell = (s) => String(s).replace(/[|\\`*_<>[\]]/g, (ch) => `\\${ch}`);
/** Inside a code span nothing is escaped, so only what cannot end it is kept. */
const code = (s) => String(s).replace(/[`\n\r|]/g, '');
const label = (a) => AGENT_LABELS[a] ?? a;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The pull request comment: a table a reviewer reads, the statement beneath. */
export function markdown(statement, { token = null } = {}) {
  const p = statement.predicate;
  const g = p.guard;
  const lines = [MARKER, '### Coding agents on this branch', ''];
  if (!p.agents.length) lines.push('No coding agent sessions or guard decisions were found for this branch on the machine that wrote this.', '');
  else {
    lines.push('| Agent | Sessions | Guard decisions | Cost |', '|---|---:|---:|---:|');
    for (const a of p.agents) lines.push(`| ${cell(label(a.agent))} | ${a.sessions} | ${a.decisions || 'none logged'} | ${a.unpriced && !a.costMicros ? 'not priced' : `${usd(a.costMicros)}${a.unpriced ? '+' : ''}`} |`);
    lines.push('');
  }
  const refusedBy = g.rules.filter((r) => r.decision === 'deny').map((r) => `\`${code(r.rule)}\` ${r.count}`);
  const askedBy = g.rules.filter((r) => r.decision === 'ask').map((r) => `\`${code(r.rule)}\` ${r.count}`);
  lines.push(`**Guard:** ${plural(g.decisions, 'call')} decided: ${g.allowed} allowed, ${g.asked} asked about${askedBy.length ? ` (${askedBy.join(', ')})` : ''}, ${g.refused} refused${refusedBy.length ? ` (${refusedBy.join(', ')})` : ''}.${g.paused ? ` ${g.paused} let through while the guard was paused.` : ''}`);
  if (g.unguarded.length) lines.push('', `**Not guarded:** ${g.unguarded.map(label).join(', ')} (sessions here, no guard decisions logged).`);
  const team = g.teamRules.length ? `Team rules version ${g.teamRules.map((t) => t.version).join(' and ')}.` : 'Built-in rules only.';
  const days = p.log.days.length;
  lines.push('', `${team} ${days ? (p.log.verifies ? `The decision log verifies (${plural(days, 'day')}).` : '**The decision log does not verify** for a day in this window.') : 'No decision log in this window.'} ${p.commits} ${p.commits === 1 ? 'commit' : 'commits'} since \`${code(p.base.ref)}\`; ${usd(p.cost.micros)}${p.cost.unpriced ? '+' : ''} at list prices.`);
  lines.push('', '<details><summary>Statement (in-toto)</summary>', '', '```json', JSON.stringify(statement, null, 2), '```', '', '</details>');
  if (token) lines.push('', `Signed by the workspace. Check it with \`immiscible verify\` and this token:`, '', '```', token, '```', `<!-- immiscible:token ${token} -->`);
  lines.push('', `<sub>Read on the developer's machine by immiscible ${cell(p.generator.version)}: counts only, never a command, path or prompt. A signature says when the workspace received it, not that the counts are right.</sub>`);
  return `${lines.join('\n')}\n`;
}

/** Post or update the comment on the branch's pull request, with gh. Returns its URL. */
function comment(repo, branch, body, env) {
  const gh = (args, input = null) => {
    const r = spawnSync('gh', args, { cwd: repo, encoding: 'utf8', timeout: 30_000, env, input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (r.error) throw new CliError('the GitHub CLI (gh) is not installed', { exit: EXIT.ERROR, code: 'gh_missing', fix: 'Install gh and run gh auth login, or use --out and post it yourself.' });
    return r;
  };
  const pr = gh(['pr', 'view', branch, '--json', 'number,url']);
  let info = null;
  try { info = JSON.parse(pr.stdout); } catch { info = null; }
  if (pr.status !== 0 || !Number.isInteger(info?.number)) throw new CliError(`no pull request for ${branch}`, { exit: EXIT.ERROR, code: 'no_pull_request', fix: 'Open one first (gh pr create), or use --out and attach the statement yourself.' });
  const me = gh(['api', 'user', '--jq', '.login']).stdout.trim();
  const list = gh(['api', '--paginate', `repos/{owner}/{repo}/issues/${info.number}/comments`, '--jq', '.[] | {id, login: .user.login, mine: ((.body // "") | startswith("<!-- immiscible:attest -->"))}']);
  let existing = null;
  for (const line of String(list.stdout ?? '').split('\n')) {
    try { const c = JSON.parse(line); if (c.mine && c.login === me) existing = c.id; } catch { /* not a line of ours */ }
  }
  const r = existing
    ? gh(['api', '--method', 'PATCH', `repos/{owner}/{repo}/issues/comments/${existing}`, '--input', '-'], JSON.stringify({ body }))
    : gh(['pr', 'comment', String(info.number), '--body-file', '-'], body);
  if (r.status !== 0) throw new CliError(`gh could not post the comment: ${String(r.stderr ?? '').trim().slice(0, 200) || 'no reason given'}`, { exit: EXIT.ERROR, code: 'comment_failed', fix: 'Check gh auth status, or use --out and post it yourself.' });
  return { url: info.url, updated: Boolean(existing) };
}

const b64u = (s) => Buffer.from(String(s), 'base64url');

/**
 * Check a signed attestation against the issuer's published keys. Returns
 * { valid, reason?, claims? }; never throws on a bad token.
 */
export function verifyAttestation(token, jwks, { issuer = null } = {}) {
  const parts = String(token ?? '').trim().split('.');
  if (parts.length !== 3 || String(token).length > 16_384) return { valid: false, reason: 'malformed', message: 'an attestation is three base64url parts' };
  let header;
  let claims;
  try { header = JSON.parse(b64u(parts[0]).toString('utf8')); claims = JSON.parse(b64u(parts[1]).toString('utf8')); } catch { return { valid: false, reason: 'malformed', message: 'the attestation could not be read' }; }
  if (header?.alg !== 'EdDSA' || header?.typ !== ATTEST_TYP) return { valid: false, reason: 'wrong_type', message: 'this is not an Immiscible attestation' };
  const jwk = (jwks?.keys ?? []).find((k) => k.kid === header.kid);
  if (!jwk) return { valid: false, reason: 'unknown_key', message: 'signed with a key the issuer does not publish' };
  let good = false;
  try { good = edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' }), b64u(parts[2])); } catch { good = false; }
  if (!good) return { valid: false, reason: 'bad_signature', message: 'the signature does not verify: it was changed, or another key signed it' };
  if (issuer && String(claims.iss ?? '').replace(/\/$/, '') !== String(issuer).replace(/\/$/, '')) return { valid: false, reason: 'wrong_issuer', message: `issued by ${claims.iss}, not ${issuer}` };
  if (claims?.stm?._type !== STATEMENT_TYPE || claims?.stm?.predicateType !== PREDICATE_TYPE) return { valid: false, reason: 'wrong_type', message: 'the signed content is not a coding-agent statement' };
  return { valid: true, kid: header.kid, claims };
}

/** Is this token an attestation (by its header), rather than a receipt? */
export function isAttestation(token) {
  try { return JSON.parse(b64u(String(token).split('.')[0]).toString('utf8'))?.typ === ATTEST_TYP; } catch { return false; }
}

/** immiscible verify, for an attestation: print what it says and whether it holds. */
export async function verifyAttestationAndReport({ ui, token, jwks, from, issuer }) {
  const r = verifyAttestation(token, jwks, { issuer });
  if (ui.json) return { valid: r.valid, reason: r.reason ?? null, message: r.message ?? null, kind: 'attestation', keys: from, claims: r.claims ?? null };
  const { c } = ui;
  if (!r.valid) {
    ui.fail(`Not valid: ${r.message}`);
    ui.out(`  ${c.dim(`reason ${r.reason}, keys from ${from}`)}`);
    return r;
  }
  const s = r.claims.stm;
  const p = s.predicate;
  ui.ok(`Verified: an attestation signed by key ${r.kid} from ${from}, and not changed since`);
  ui.table([
    ['branch', s.subject[0].name],
    ['commit', s.subject[0].digest.gitCommit],
    ['agents', p.agents.map((a) => `${label(a.agent)} (${plural(a.sessions, 'session')})`).join(', ') || 'none'],
    ['guard', `${p.guard.allowed} allowed, ${p.guard.asked} asked, ${p.guard.refused} refused${p.guard.unguarded.length ? `; not guarded: ${p.guard.unguarded.map(label).join(', ')}` : ''}`],
    ['log', p.log.verifies ? 'verified on the machine that wrote it' : 'did not verify on the machine that wrote it'],
    ['signed', `${new Date(r.claims.iat * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC by workspace ${r.claims.sub}`],
    ['issuer', r.claims.iss],
  ], { indent: '  ' });
  ui.note('  The signature says when the workspace received it; the counts are what that machine read.');
  return r;
}

/**
 * What a pull request's attestation comment says, judged: { state, findings, claims? }.
 * state: none | unsigned | invalid | stale | current. Findings are what a
 * reviewer should not wave through: an agent that ran unguarded, a decision
 * log that did not verify, a signature that does not hold.
 */
export function judgeAttestation({ bodies, jwks, issuer, headSha, workspaceId = null }) {
  const ours = bodies.filter((b) => String(b ?? '').startsWith(MARKER));
  if (!ours.length) return { state: 'none', findings: [] };
  const tokens = ours.map((b) => /<!-- immiscible:token ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+) -->/.exec(b)?.[1]).filter(Boolean);
  if (!tokens.length) return { state: 'unsigned', findings: [] };
  // The newest signed one that verifies and is for this head wins; otherwise the newest that verifies.
  const checked = tokens.map((t) => verifyAttestation(t, jwks, { issuer })).reverse();
  const valid = checked.filter((v) => v.valid && (!workspaceId || v.claims.sub === workspaceId));
  if (!valid.length) {
    const v = checked[0];
    return { state: 'invalid', findings: [v.valid ? 'the attestation was signed for another workspace' : `the attestation does not verify: ${v.message}`] };
  }
  const best = valid.find((v) => v.claims.stm.subject[0].digest.gitCommit === headSha) ?? valid[0];
  const p = best.claims.stm.predicate;
  const findings = [];
  if (p.guard.unguarded.length) findings.push(`${p.guard.unguarded.map(label).join(', ')} ran on this branch with no guard`);
  if (!p.log.verifies) findings.push('the decision log did not verify on the machine that wrote the attestation');
  const current = !headSha || best.claims.stm.subject[0].digest.gitCommit === headSha;
  return { state: current ? 'current' : 'stale', findings, claims: best.claims };
}

/** The pull request in CI: its number and head commit, from the event file or gh. */
function pullRequestInCi(env, cwd) {
  try {
    const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const pr = ev.pull_request ?? null;
    if (pr && Number.isInteger(pr.number)) return { number: pr.number, head: pr.head?.sha ?? null };
  } catch { /* not in GitHub Actions, or not a pull request event */ }
  const r = spawnSync('gh', ['pr', 'view', '--json', 'number,headRefOid'], { cwd, encoding: 'utf8', timeout: 30_000, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try { const j = JSON.parse(r.stdout); if (Number.isInteger(j.number)) return { number: j.number, head: j.headRefOid ?? null }; } catch { /* no pull request */ }
  return null;
}

async function attestCheck(ctx) {
  const { ui, flags, env } = ctx;
  const pr = pullRequestInCi(env, ctx.dir);
  if (!pr) throw usage('no pull request to check', 'Run attest --check on a pull_request event, or on a branch with a pull request (gh).');
  const r = spawnSync('gh', ['api', '--paginate', `repos/{owner}/{repo}/issues/${pr.number}/comments`, '--jq', '.[].body | @json'], { cwd: ctx.dir, encoding: 'utf8', timeout: 30_000, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) throw new CliError(`gh could not read the pull request's comments${r.error ? ': gh is not installed' : ''}`, { exit: EXIT.ERROR, code: 'gh_failed', fix: 'In GitHub Actions, set GH_TOKEN: ${{ github.token }}.' });
  const bodies = String(r.stdout).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return ''; } });
  let jwks = null;
  try { jwks = await fetchJwks(ctx.url, { fetch: ctx.fetchImpl ?? globalThis.fetch }); } catch (err) {
    throw new CliError(`could not read the server's published keys (${err.message})`, { exit: EXIT.NETWORK, code: 'keys_unavailable', fix: 'Check the server address.' });
  }
  let workspaceId = null;
  if (ctx.token) { try { workspaceId = (await ctx.api().get('/v1/cli/whoami')).workspace?.id ?? null; } catch { workspaceId = null; } }
  const j = judgeAttestation({ bodies, jwks, issuer: ctx.url, headSha: pr.head, workspaceId });
  const strictFail = flags.strict && ['none', 'unsigned', 'stale'].includes(j.state);
  const code = j.state === 'invalid' ? EXIT.INVALID : j.findings.length || strictFail ? EXIT.FINDINGS : EXIT.OK;
  const say = {
    none: 'No attestation on this pull request. If coding agents worked on it, run immiscible attest --comment --sign on the branch.',
    unsigned: 'The attestation on this pull request is not signed, so it is not checked. Run immiscible attest --comment --sign.',
    invalid: 'The attestation on this pull request does not hold.',
    stale: 'The signed attestation is for an earlier commit. Run immiscible attest --comment --sign again after pushing.',
    current: 'The signed attestation is for this commit and verifies.',
  }[j.state];
  if (env.GITHUB_ACTIONS === 'true') {
    const data = (x) => String(x).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    for (const f of j.findings) ui.out(`::error title=Coding agents::${data(f)}`);
    if (strictFail) ui.out(`::error title=Coding agents::${data(say)}`);
    else if (j.state !== 'current' && j.state !== 'invalid') ui.out(`::warning title=Coding agents::${data(say)}`);
    if (env.GITHUB_STEP_SUMMARY) {
      try { appendFileSync(env.GITHUB_STEP_SUMMARY, `### Coding agents\n\n${say}\n${j.findings.map((f) => `\n- ${f}`).join('')}\n`); } catch { /* a help, never a reason to fail */ }
    }
  }
  if (ui.json) {
    ui.writeJson({ ok: code === EXIT.OK, state: j.state, findings: j.findings, pullRequest: pr.number, head: pr.head, ...(j.claims ? { workspace: j.claims.sub, commit: j.claims.stm.subject[0].digest.gitCommit, agents: j.claims.stm.predicate.agents.map((a) => a.agent) } : {}) });
    return code;
  }
  (code === EXIT.OK ? ui.ok : ui.fail)(say);
  for (const f of j.findings) ui.out(`  ${f}`);
  return code;
}

export async function attest(ctx) {
  const { ui, flags } = ctx;
  const { c } = ui;
  if ((ctx.rest ?? []).length) throw usage('attest takes no arguments; it describes the branch checked out here');
  if (flags.check) return attestCheck(ctx);
  const home = ctx.env.HOME || homedir();
  const { statement, repo, branch } = buildStatement({ dir: ctx.dir, home, env: ctx.env, base: flags.base ?? null });

  let signed = null;
  if (flags.sign) {
    const token = ctx.requireToken();
    const r = await ctx.api(token).post('/v1/cli/attest', { statement });
    const jwks = await fetchJwks(ctx.url, { fetch: ctx.fetchImpl ?? globalThis.fetch }).catch(() => null);
    const v = jwks ? verifyAttestation(r.token, jwks, { issuer: null }) : { valid: false, message: 'the server\'s keys could not be read' };
    if (!v.valid) throw new CliError(`the server's signature did not check out: ${v.message}`, { exit: EXIT.INVALID, code: 'attestation_not_verified', fix: 'Check you are signed in to the right server.' });
    if (JSON.stringify(v.claims.stm) !== JSON.stringify(statement)) throw new CliError('the server signed something other than this statement', { exit: EXIT.INVALID, code: 'attestation_not_verified' });
    signed = { token: r.token, workspace: r.workspace?.id ?? v.claims.sub, issuer: r.issuer ?? v.claims.iss };
  }
  if (flags.out) {
    const file = path.resolve(ctx.dir, flags.out);
    try { writeFileSync(file, `${JSON.stringify(statement, null, 2)}\n`); } catch (e) {
      throw new CliError(`could not write ${flags.out}: ${e.code ?? e.message}`, { exit: EXIT.ERROR, code: 'write_failed', fix: 'Choose a path in a directory you can write to.' });
    }
  }
  const body = markdown(statement, { token: signed?.token });
  const posted = flags.comment ? comment(repo, branch, body, ctx.env) : null;

  if (ui.json) {
    ui.writeJson({ ok: true, statement, ...(signed ? { signed } : {}), ...(posted ? { comment: posted } : {}), markdown: body });
    return EXIT.OK;
  }
  const p = statement.predicate;
  ui.blank();
  ui.out(`  ${c.bold(`Coding agents on ${branch}`)} ${c.dim(`${plural(p.commits, 'commit')} since ${p.base.ref}, read on this machine`)}`);
  ui.blank();
  if (!p.agents.length) ui.note('  No coding agent sessions or guard decisions found for this branch.');
  for (const a of p.agents) ui.out(`  ${label(a.agent).padEnd(14)} ${plural(a.sessions, 'session').padEnd(12)} ${c.dim(a.decisions ? `${plural(a.decisions, 'guard decision')}` : 'no guard decisions logged')}  ${usd(a.costMicros)}${a.unpriced ? c.dim('+') : ''}`);
  ui.blank();
  ui.out(`  Guard  ${p.guard.allowed} allowed, ${p.guard.asked} asked, ${p.guard.refused} refused${p.guard.teamRules.length ? `; team rules v${p.guard.teamRules.map((t) => t.version).join(' and v')}` : ''}`);
  ui.out(`  Log    ${p.log.days.length ? (p.log.verifies ? c.green('verifies') : c.red('does not verify')) : c.dim('nothing logged in this window')}`);
  if (p.guard.unguarded.length) ui.note(`  Not guarded: ${p.guard.unguarded.map(label).join(', ')}. Fix it: immiscible guard`);
  ui.blank();
  if (flags.out) ui.ok(`Statement written to ${path.resolve(ctx.dir, flags.out)}`);
  if (signed) ui.ok(`Signed by your workspace; anyone can check it with: immiscible verify <token>  ${c.dim('(--json prints the token)')}`);
  if (posted) ui.ok(`${posted.updated ? 'Updated' : 'Posted'} on the pull request: ${posted.url}`);
  if (!flags.comment && !flags.out && !signed) ui.note('  Post it on the pull request: immiscible attest --comment   (add --sign to have your workspace sign it)');
  return EXIT.OK;
}
