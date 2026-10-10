/**
 * immiscible cost: what coding agents cost, per branch, pull request, ticket,
 * repository or agent, across Claude Code, Codex and Gemini CLI together.
 *
 *   immiscible cost                    per branch, last 30 days
 *   immiscible cost --by pr            per pull request (asks the GitHub CLI, gh, for each repository's PRs)
 *   immiscible cost --by ticket        per ticket id in the branch name or PR title (ABC-123)
 *   immiscible cost --by repo|agent
 *   immiscible cost --csv costs.csv
 *
 *   immiscible cost --share            also send each session's cost, branch and pull request to your workspace
 *   immiscible cost --team [--by ...]  the whole team's, from what everyone shared (owners, admins, analysts)
 *
 * Each vendor reports its own tool only; this adds them up from the history
 * they keep on this machine, at list prices. A session with no branch, ticket
 * or pull request to go on is shown as unattributed, never as zero. Nothing
 * leaves the machine except, with --by pr, gh's own request to GitHub.
 */

import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readHistory } from '../history/readers.mjs';
import { AGENT_LABELS, usd } from '../history/analyse.mjs';
import { costMicros } from '../history/prices.mjs';
import { parseSince, repoName } from './scan.mjs';
import { CliError, EXIT, usage } from '../errors.mjs';

const BY = ['branch', 'pr', 'ticket', 'repo', 'agent'];
const TICKET = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})(?=$|[^A-Za-z0-9])/;
/** Words that come before a number in branch names and are not ticket keys. */
const NOT_A_KEY = /^(release|hotfix|bugfix|feature|fix|version|v|rc|node|python|py|ubuntu|claude|gpt|sonnet|opus|phase|step|part|week|day|sprint|pr|issue|utf|iso|x86|arm|sha|q|h)$/i;

/** The ticket id in a branch name or a title (ENG-123, PROJ-4567), upper-cased, or null. */
export const ticketOf = (...texts) => {
  for (const t of texts) {
    for (const part of String(t ?? '').split(/\s+/)) {
      const m = TICKET.exec(part);
      if (m && !NOT_A_KEY.test(m[1].split('-')[0])) return m[1].toUpperCase();
    }
  }
  return null;
};

export function sessionCost(usage) {
  let micros = 0;
  let unpriced = false;
  for (const [model, u] of Object.entries(usage ?? {})) {
    const c = costMicros(model, u);
    if (c == null) unpriced = true; else micros += c;
  }
  return { micros, unpriced };
}

/** The repository a session ran in: its top level when git knows it, else the folder. */
function repoOf(cwd, cache) {
  if (!cwd) return null;
  if (!cache.has(cwd)) {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    cache.set(cwd, r.status === 0 ? r.stdout.trim() : cwd);
  }
  return cache.get(cwd);
}

/** A repository's pull requests by head branch, from gh: Map(branch -> [{ number, title, state, mergedAt, url }]), or null without gh. */
export function pullRequests(repo, env = process.env) {
  const r = spawnSync('gh', ['pr', 'list', '--state', 'all', '--limit', '300', '--json', 'number,title,headRefName,state,mergedAt,url'], { cwd: repo, encoding: 'utf8', timeout: 20_000, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return null;
  let list;
  try { list = JSON.parse(r.stdout); } catch { return null; }
  const out = new Map();
  for (const p of Array.isArray(list) ? list : []) {
    if (!p?.headRefName) continue;
    if (!out.has(p.headRefName)) out.set(p.headRefName, []);
    out.get(p.headRefName).push({ number: p.number, title: String(p.title ?? '').slice(0, 120), state: p.state, mergedAt: p.mergedAt ?? null, url: p.url ?? null });
  }
  return out;
}

/**
 * Rows for a grouping: [{ key, label, repo, micros, unpriced, sessions, agents: [..], attributed, pr? }],
 * most expensive first, the unattributed row last.
 */
export function group(sessions, by, { prs = new Map() } = {}) {
  const rows = new Map();
  const cache = new Map();
  for (const s of sessions) {
    const repo = repoOf(s.cwd, cache);
    const repoName = repo ? path.basename(repo) : null;
    const branch = s.branch && s.branch !== 'HEAD' ? s.branch : null;
    const pr = (by === 'pr' || by === 'ticket') && repo && branch ? (prs.get(repo)?.get(branch) ?? []).sort((a, b) => b.number - a.number)[0] ?? null : null;
    let key = null;
    let label = null;
    if (by === 'agent') { key = s.agent; label = AGENT_LABELS[s.agent] ?? s.agent; }
    else if (by === 'repo') { key = repo; label = repoName; }
    else if (by === 'branch') { key = repo && branch ? `${repo}#${branch}` : null; label = branch ? `${repoName} ${branch}` : null; }
    else if (by === 'ticket') { const t = ticketOf(branch, pr?.title); key = t; label = t; }
    else if (by === 'pr') { key = pr ? `${repo}#${pr.number}` : null; label = pr ? `${repoName} #${pr.number} ${pr.title}` : null; }
    const k = key ?? '\0unattributed';
    if (!rows.has(k)) rows.set(k, { key: key ?? null, label: label ?? 'unattributed', repo: key ? repoName : null, micros: 0, unpriced: false, sessions: 0, agents: new Set(), attributed: Boolean(key), ...(pr ? { pr } : {}) });
    const row = rows.get(k);
    const c = sessionCost(s.usage);
    row.micros += c.micros;
    row.unpriced ||= c.unpriced;
    row.sessions += 1;
    row.agents.add(s.agent);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, agents: [...r.agents].sort() }))
    .sort((a, b) => (a.attributed === b.attributed ? b.micros - a.micros : a.attributed ? -1 : 1));
}

/** One row per session for --share: a hashed key, the agent, the repository by its remote, branch, pull request, ticket and cost. */
export function shareRows(sessions, { prs = new Map(), env = {} } = {}) {
  const cache = new Map();
  const names = new Map();
  return sessions.map((s) => {
    const repo = repoOf(s.cwd, cache);
    if (repo && !names.has(repo)) names.set(repo, repoName(repo, {}));
    const branch = s.branch && s.branch !== 'HEAD' ? s.branch : null;
    const pr = repo && branch ? (prs.get(repo)?.get(branch) ?? []).sort((a, b) => b.number - a.number)[0] ?? null : null;
    const c = sessionCost(s.usage);
    return {
      sessionKey: createHash('sha256').update(`${s.agent}:${s.id}`).digest('hex').slice(0, 32),
      agent: s.agent,
      repo: repo ? names.get(repo) : null,
      branch,
      pr: pr ? { number: pr.number, title: pr.title, state: pr.state, mergedAt: pr.mergedAt } : null,
      ticket: ticketOf(branch, pr?.title),
      costMicros: Math.round(c.micros),
      unpriced: c.unpriced,
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    };
  });
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export async function cost(ctx) {
  const { ui, flags } = ctx;
  const { c } = ui;
  const by = flags.by ?? 'branch';
  if (!BY.includes(by) && !(flags.team && by === 'person')) throw usage(`--by takes ${BY.join(', ')}${flags.team ? ', person' : ''}`);
  if (flags.share && flags.team) throw usage('--share sends your sessions; --team reads everyone\'s: run one, then the other');
  if ((ctx.rest ?? []).length) throw usage('cost takes no arguments; choose a grouping with --by');
  const home = ctx.env.HOME || homedir();
  const now = Date.now();
  const since = parseSince(flags.since ?? '30d', now);
  if (flags.team) return teamCost(ctx, { by: by === 'branch' && !flags.by ? 'pr' : by, since });
  const { sessions: all } = readHistory({ home, env: ctx.env, since, projectDirs: [ctx.dir] });
  const sessions = all.filter((s) => (s.endedAt ?? s.startedAt ?? since) >= since);

  const prs = new Map();
  let ghMissing = false;
  if (by === 'pr' || (by === 'ticket' && flags.prs) || flags.share) {
    const cache = new Map();
    for (const s of sessions) {
      const repo = repoOf(s.cwd, cache);
      if (!repo || prs.has(repo) || ghMissing) continue;
      const list = pullRequests(repo, ctx.env);
      if (list == null) ghMissing = true; else prs.set(repo, list);
    }
  }
  const rows = group(sessions, by, { prs });
  let shared = null;
  if (flags.share) {
    const token = ctx.requireToken();
    const list = shareRows(sessions, { prs, env: ctx.env });
    const client = ctx.api(token);
    let n = 0;
    let url = null;
    for (let i = 0; i < list.length; i += 2000) {
      const r = await client.post('/v1/cli/coding-cost', { sessions: list.slice(i, i + 2000) });
      n += r.shared;
      url = r.url ?? url;
    }
    shared = { sessions: n, url };
  }
  const total = rows.reduce((a, r) => a + r.micros, 0);
  const unattributed = rows.find((r) => !r.attributed) ?? null;

  if (flags.csv) {
    const file = path.resolve(ctx.dir, flags.csv);
    const lines = [['group', 'repository', 'cost_usd', 'sessions', 'agents', 'unpriced_models', 'pull_request', 'merged_at'].join(',')];
    for (const r of rows) lines.push([r.label, r.repo ?? '', (r.micros / 1e6).toFixed(4), r.sessions, r.agents.join(' '), r.unpriced ? 'yes' : 'no', r.pr?.url ?? '', r.pr?.mergedAt ?? ''].map(csvCell).join(','));
    try { writeFileSync(file, `${lines.join('\n')}\n`); } catch (e) {
      throw new CliError(`could not write ${flags.csv}: ${e.code ?? e.message}`, { exit: EXIT.ERROR, code: 'write_failed', fix: 'Choose a path in a directory you can write to.' });
    }
  }
  if (ui.json) {
    ui.writeJson({ ok: true, local: !shared, ...(shared ? { shared } : {}), by, since: new Date(since).toISOString(), totalMicros: total, sessions: sessions.length, ...(by === 'pr' && ghMissing ? { note: 'gh is not installed or not signed in, so pull requests could not be read' } : {}), rows });
    return EXIT.OK;
  }
  ui.blank();
  ui.out(`  ${c.bold(`Cost by ${by === 'pr' ? 'pull request' : by}`)} ${c.dim(`since ${new Date(since).toISOString().slice(0, 10)}, at list prices, read on this machine`)}`);
  ui.blank();
  if (!sessions.length) { ui.note('  No coding agent sessions in this window. Widen it: immiscible cost --since 90d'); return EXIT.OK; }
  const width = Math.min(56, Math.max(12, ...rows.map((r) => r.label.length)));
  for (const r of rows.slice(0, 25)) {
    const label = r.label.length > width ? `${r.label.slice(0, width - 1)}…` : r.label.padEnd(width);
    const agents = by === 'agent' ? '' : r.agents.map((a) => AGENT_LABELS[a] ?? a).join(', ');
    const merged = r.pr ? (r.pr.mergedAt ? c.green(' merged') : c.dim(` ${String(r.pr.state ?? '').toLowerCase()}`)) : '';
    ui.out(`  ${r.attributed ? label : c.dim(label)}  ${usd(r.micros).padStart(9)}${r.unpriced ? c.dim('+') : ' '} ${c.dim(`${String(r.sessions).padStart(3)} session${r.sessions === 1 ? ' ' : 's'}  ${agents}`)}${merged}`);
  }
  if (rows.length > 25) ui.note(`  and ${rows.length - 25} more (--json or --csv for all)`);
  ui.blank();
  ui.note(`  ${usd(total)} across ${sessions.length} session${sessions.length === 1 ? '' : 's'}${unattributed ? `; ${usd(unattributed.micros)} unattributed (${by === 'pr' ? 'no pull request for the branch' : by === 'ticket' ? 'no ticket id in the branch' : 'no branch recorded'})` : ''}.${rows.some((r) => r.unpriced) ? ' + a model with no list price is left out.' : ''}`);
  if (by === 'pr' && ghMissing) ui.note('  The GitHub CLI (gh) is missing or not signed in, so no pull requests were read: gh auth login');
  if (flags.csv) ui.ok(`Written to ${path.resolve(ctx.dir, flags.csv)}`);
  if (shared) ui.ok(`Shared ${shared.sessions} session${shared.sessions === 1 ? '' : 's'} with your workspace ${c.dim('(cost, branch and pull request only)')}${shared.url ? `: ${shared.url}` : ''}`);
  else ui.note('  Add your team\'s: immiscible cost --share, and everyone\'s together with immiscible cost --team');
  return EXIT.OK;
}

/** --team: the workspace's report, from what everyone shared. */
async function teamCost(ctx, { by, since }) {
  const { ui } = ctx;
  const { c } = ui;
  const token = ctx.requireToken();
  const q = new URLSearchParams({ by, since: new Date(since).toISOString() });
  const r = await ctx.api(token).get(`/v1/cli/coding-cost?${q}`);
  if (ctx.flags.csv) {
    const file = path.resolve(ctx.dir, ctx.flags.csv);
    const lines = [['group', 'repository', 'cost_usd', 'sessions', 'agents', 'people', 'pull_request_state', 'merged_at'].join(',')];
    for (const x of r.rows) lines.push([x.label, x.repo ?? '', (x.micros / 1e6).toFixed(4), x.sessions, x.agents.join(' '), x.people, x.pr?.state ?? '', x.pr?.mergedAt ?? ''].map(csvCell).join(','));
    try { writeFileSync(file, `${lines.join('\n')}\n`); } catch (e) {
      throw new CliError(`could not write ${ctx.flags.csv}: ${e.code ?? e.message}`, { exit: EXIT.ERROR, code: 'write_failed', fix: 'Choose a path in a directory you can write to.' });
    }
  }
  if (ui.json) { ui.writeJson({ ok: true, team: true, ...r }); return EXIT.OK; }
  ui.blank();
  ui.out(`  ${c.bold(`Your team's coding-agent cost by ${by === 'pr' ? 'pull request' : by}`)} ${c.dim(`since ${r.since.slice(0, 10)}, from ${r.people} ${r.people === 1 ? 'person' : 'people'} who shared`)}`);
  ui.blank();
  if (!r.rows.length) { ui.note('  Nothing shared yet. Each developer runs: immiscible cost --share'); return EXIT.OK; }
  const width = Math.min(56, Math.max(12, ...r.rows.map((x) => x.label.length)));
  for (const x of r.rows.slice(0, 25)) {
    const label = x.label.length > width ? `${x.label.slice(0, width - 1)}…` : x.label.padEnd(width);
    const merged = x.pr ? (x.pr.mergedAt ? c.green(' merged') : c.dim(` ${String(x.pr.state ?? '').toLowerCase()}`)) : '';
    ui.out(`  ${x.attributed ? label : c.dim(label)}  ${usd(x.micros).padStart(9)}${x.unpriced ? c.dim('+') : ' '} ${c.dim(`${String(x.sessions).padStart(3)} session${x.sessions === 1 ? ' ' : 's'}  ${x.agents.map((a) => AGENT_LABELS[a] ?? a).join(', ')}  ${x.people} ${x.people === 1 ? 'person' : 'people'}`)}${merged}`);
  }
  ui.blank();
  ui.note(`  ${usd(r.totalMicros)} across ${r.sessions} session${r.sessions === 1 ? '' : 's'}${r.merged?.count ? `; ${usd(r.merged.averageMicros)} per merged pull request on average (${r.merged.count})` : ''}.`);
  return EXIT.OK;
}
