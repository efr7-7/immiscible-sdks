/**
 * immiscible scan: what your coding agents did this week.
 *
 * Reads the session history Claude Code, Codex and Gemini CLI already keep
 * on this machine (src/history/readers.mjs), and their hooks and permission
 * settings (src/history/config.mjs), and reports sessions by agent and
 * repository, risky commands, secret files read, domains reached, a secret
 * read followed by the network in one session, cost at list prices, and the
 * modes and hooks in effect (src/history/analyse.mjs).
 *
 * Runs locally, needs no account, and sends nothing. No prompt text, file
 * contents or secret values are printed or written, in any format.
 *
 * Exit 0 when nothing high-risk was found, 11 when something was.
 */

import { homedir, hostname, userInfo, platform } from 'node:os';
import { createHash } from 'node:crypto';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readHistory } from '../history/readers.mjs';
import { readConfig } from '../history/config.mjs';
import { analyse } from '../history/analyse.mjs';
import { renderText, renderHtml } from '../history/render.mjs';
import { teamHint } from '../history/team.mjs';
import { readDecisions, logDir, dropRefused } from '../history/recorder.mjs';
import { guardSessions, guardSummary, LOGGED_ONLY } from '../history/guard-log.mjs';
import { AGENT_LABELS } from '../history/analyse.mjs';
import { detectAgents, guardedAgents, guardState } from './guard.mjs';
import { VERSION } from '../version.mjs';
import { readTeamRules, syncTeamRules } from '../team-rules.mjs';
import { EXIT, CliError, usage } from '../errors.mjs';
import { inventory, readAllowList, allowListFor, unapproved, describe, ALLOW_FILE, RISKS } from '../agent-config.mjs';

const DAY = 86400000;

/** --since: 7d, 24h, 2w, or a date (2026-10-01). Returns ms. */
export function parseSince(value, now = Date.now()) {
  if (value == null) return now - 7 * DAY;
  const m = /^(\d{1,4})([hdw])$/.exec(String(value).trim());
  if (m) return now - Number(m[1]) * { h: 3600000, d: DAY, w: 7 * DAY }[m[2]];
  const t = Date.parse(value);
  if (Number.isFinite(t) && t <= now) return t;
  throw usage(`--since ${value} is not a period or a past date`, 'Use a period such as 7d, 24h or 2w, or a date such as 2026-10-01.');
}

/** A path as a person reads it: relative paths against the session's directory, home as ~. */
export function shownPath(home) {
  return (p, cwd = null) => {
    let s = String(p ?? '');
    if (cwd && s && !path.isAbsolute(s) && !s.startsWith('~')) s = path.join(cwd, s);
    if (home && (s === home || s.startsWith(home + path.sep))) s = `~${s.slice(home.length)}`;
    return s;
  };
}

/** The repository's name for the report: GITHUB_REPOSITORY in Actions, else the origin remote without credentials, else the folder. */
export function repoName(dir, env = {}) {
  if (env.GITHUB_REPOSITORY && /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) return `github.com/${env.GITHUB_REPOSITORY}`;
  const r = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: dir, encoding: 'utf8' });
  const url = String(r.stdout ?? '').trim();
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(url);
  if (r.status === 0 && m) return `${m[1].toLowerCase()}/${m[2]}`.slice(0, 200);
  return path.basename(dir).slice(0, 200) || 'repository';
}

/**
 * scan --ci: the repository's own agent configuration against its allow list
 * (src/agent-config.mjs). No history is read. In GitHub Actions each finding
 * is also an annotation on the file. --approve writes the allow list for what
 * is there now, for a person to review in the pull request.
 */
export async function scanRepository(ctx) {
  const { ui, flags, env } = ctx;
  const items = inventory(ctx.dir);
  if (flags.approve) {
    const file = path.join(ctx.dir, ALLOW_FILE);
    const body = `${JSON.stringify(allowListFor(items), null, 2)}\n`;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    } catch (e) {
      throw new CliError(`could not write ${ALLOW_FILE}: ${e.code ?? e.message}`, { exit: EXIT.ERROR, code: 'write_failed', fix: 'Run it in the repository, in a directory you can write to.' });
    }
    const n = allowListFor(items).allow.length;
    if (ui.json) ui.writeJson({ ok: true, approved: n, file: ALLOW_FILE });
    else {
      ui.ok(`${ALLOW_FILE} now allows ${n} ${n === 1 ? 'entry' : 'entries'}`);
      ui.note('Commit it in a pull request, so someone reviews what it lets your coding agents run.');
    }
    return EXIT.OK;
  }
  const list = readAllowList(ctx.dir);
  if (list.error) throw new CliError(list.error, { exit: EXIT.USAGE, code: 'allow_list_invalid', fix: 'Fix it, or write a fresh one with immiscible scan --ci --approve.' });
  // Signed in (IMMISCIBLE_TOKEN in CI): the workspace's own allow list counts too, and the result is
  // reported so it shows on the Agents page. Fingerprints and program names only, never a command.
  let workspace = null;
  const inRepo = new Set(list.allowed);
  if (ctx.tokenWithheld) {
    // A pull request can change the repository's .env, so it does not choose where a CI token goes (config.mjs).
    workspace = { reported: false, error: "the server address came from the repository's .env, which a pull request can change; set IMMISCIBLE_URL or --url" };
  } else if (ctx.token) {
    try {
      const client = ctx.api();
      const w = await client.get('/v1/cli/agent-config');
      for (const x of w.allow ?? []) if (typeof x?.fingerprint === 'string') list.allowed.add(x.fingerprint);
      const repo = repoName(ctx.dir, env);
      const sent = await client.post('/v1/cli/agent-config/report', {
        repo,
        items: items.map(({ kind, agent, file, event, matcher, name, program, fingerprint, immiscible, unapprovable, risks }) => ({ kind, agent, file, event: event ?? null, matcher: matcher ?? null, name: name ?? null, program, fingerprint, immiscible, risks: risks ?? [], allowedInRepo: !unapprovable && inRepo.has(fingerprint) })),
      });
      workspace = { reported: true, repo, url: sent.url ?? null, allowListed: (w.allow ?? []).length };
    } catch (err) {
      workspace = { reported: false, error: err.message };
    }
  }
  const bad = unapproved(items, list.allowed);
  const risky = items.filter((i) => i.risks?.length);
  // --strict: an entry with a risk fails the build even when it is on the allow list.
  const exit = bad.length || (flags.strict && risky.length) ? EXIT.FINDINGS : EXIT.OK;
  const out = items.map((i) => ({ ...i, allowed: !i.unapprovable && list.allowed.has(i.fingerprint), description: describe(i) }));
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(env.GITHUB_STEP_SUMMARY, stepSummary(out, bad.length, workspace)); } catch { /* the summary is a help, never a reason to fail */ }
  }
  if (ui.json) {
    ui.writeJson({ ok: true, exitCode: exit, allowList: list.exists ? ALLOW_FILE : null, items: out, unapproved: bad.length, risky: risky.length, ...(workspace ? { workspace } : {}) });
    return exit;
  }
  // GitHub Actions reads these lines as annotations on the file.
  // GitHub's workflow-command escaping: % and line breaks in the message; also : and , in properties.
  const data = (v) => String(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (v) => data(v).replace(/:/g, '%3A').replace(/,/g, '%2C');
  if (env.GITHUB_ACTIONS === 'true') for (const i of risky) ui.out(`::${flags.strict ? 'error' : 'warning'} file=${prop(i.file)},title=Agent configuration risk::${data(`${describe(i)}: ${i.risks.map((r) => RISKS[r] ?? r).join('; ')}.`)}`);
  if (env.GITHUB_ACTIONS === 'true') for (const i of bad) ui.out(`::error file=${prop(i.file)},title=Unapproved agent configuration::${data(`${describe(i)} is not in ${ALLOW_FILE} (${i.fingerprint}).`)}`);
  ui.out(`${ui.c.bold('Immiscible')} ${ui.c.dim('scan --ci: coding-agent hooks, plugins and MCP servers in this repository')}`);
  ui.blank();
  if (!items.length) ui.ok('None configured here');
  for (const i of out) {
    ui.out(`  ${i.allowed ? ui.c.green('allowed ') : ui.c.red('NOT ALLOWED')}  ${i.description}  ${ui.c.dim(i.fingerprint)}`);
    for (const r of i.risks ?? []) ui.out(`      ${ui.c.yellow('!')} ${RISKS[r] ?? r}`);
  }
  ui.blank();
  if (bad.length) {
    ui.warn(`${bad.length} not in ${ALLOW_FILE}. A hook or server added to a repository runs on every machine that opens it with that agent.`);
    if (bad.some((i) => i.unapprovable)) ui.note('A plugin too big to fingerprint whole can never be approved: make it smaller, or move what it bundles out of the plugin folder.');
    ui.note('If they are meant to be there, run immiscible scan --ci --approve and commit the change for review.');
  } else if (items.length) ui.ok(`Everything here is allowed`);
  if (risky.length) ui.note(`${risky.length} ${risky.length === 1 ? 'entry has' : 'entries have'} a risk worth fixing${flags.strict ? '' : ' (--strict fails the build on them)'}: pin package versions, move keys to the environment, use https.`);
  if (workspace?.reported) ui.note(`Reported to your workspace as ${workspace.repo}: ${workspace.url ?? ''}`);
  else if (workspace) ui.warn(`Could not reach your workspace (${workspace.error}); checked against ${ALLOW_FILE} alone.`);
  return exit;
}

/**
 * Markdown for the GitHub Actions job summary. What a repository configures is
 * untrusted (a planted hook names its own program), so every cell is escaped:
 * no link, image, mention, HTML or table break can come from it.
 */
export function mdCell(v) {
  // Punctuation first, then the entities, so an entity's own # is not escaped; addresses are broken so GitHub does not link them.
  return String(v ?? '').slice(0, 300).replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]()#!|~]/g, '\\$&').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '&#64;').replace(/:\/\//g, ':&#47;&#47;').replace(/www\./gi, (m) => `${m.slice(0, 3)}&#46;`);
}

export function stepSummary(out, unapprovedCount, workspace) {
  const lines = ['### Coding-agent configuration', ''];
  if (!out.length) lines.push('No hooks, plugins or MCP servers are configured for a coding agent in this repository.');
  else {
    lines.push('| | What | Fingerprint |', '|---|---|---|');
    for (const i of out) lines.push(`| ${i.allowed ? 'allowed' : '**not allowed**'} | ${mdCell(i.description)}${i.risks?.length ? `<br>${i.risks.map((r) => mdCell(RISKS[r] ?? r)).join('<br>')}` : ''} | ${mdCell(String(i.fingerprint).slice(0, 23))} |`);
  }
  lines.push('');
  if (unapprovedCount) lines.push(`${unapprovedCount} not in ${ALLOW_FILE}. If ${unapprovedCount === 1 ? 'it is' : 'they are'} meant to be there, run \`npx immiscible scan --ci --approve\` and commit the change for review.`);
  else if (out.length) lines.push(`Everything here is in ${ALLOW_FILE}.`);
  if (workspace?.reported) lines.push('', `Reported to your workspace as ${mdCell(workspace.repo)}.`);
  return `${lines.join('\n')}\n`;
}

/** The guard's hook names for the agents guard.mjs knows by another name. */
const GUARD_TARGET = { 'factory-droid': 'droid' };

/**
 * Sources for the agents scan sees only through the guard's log: read when the
 * log holds their sessions, otherwise found or not, with the way to start seeing them.
 */
export function noteLoggedSources(sources, logged, env, guarded = new Set()) {
  const found = new Map(detectAgents(env).map((d) => [d.target, d.found]));
  for (const agent of LOGGED_ONLY) {
    const n = logged.filter((s) => s.agent === agent).length;
    const label = AGENT_LABELS[agent] ?? agent;
    const target = GUARD_TARGET[agent] ?? agent;
    const i = sources.findIndex((s) => s.agent === agent);
    const present = Boolean(found.get(target)) || (i >= 0 && sources[i].status !== 'absent');
    const entry = n
      ? { agent, label, status: 'read', via: 'guard', files: 0, sessions: n, unreadable: 0, note: null }
      : { agent, label, status: present ? 'not_readable' : 'absent', files: 0, sessions: 0, unreadable: 0,
        note: guarded.has(target) ? `${label} is guarded; its hook decided nothing in this window` : present ? `${i >= 0 && sources[i].note && sources[i].status === 'not_readable' ? sources[i].note : `${label} is here, but scan does not read its own history`}; once guarded, its calls are counted from the guard's log (npx immiscible guard --agents ${target})` : `no ${label} here` };
    if (i >= 0) sources[i] = entry; else sources.push(entry);
  }
}

/**
 * This machine's key for scan --share: a hash of the host name, the user and the home directory,
 * so a machine is one row however often it shares, and its name is not sent.
 */
export function machineKey(home, env = {}) {
  let user = '';
  try { user = userInfo().username; } catch { user = env.USER ?? env.USERNAME ?? ''; }
  return createHash('sha256').update(`immiscible-machine\0${hostname()}\0${user}\0${home}`).digest('hex').slice(0, 32);
}

/**
 * What scan --share sends about this machine (platform/coding-fleet.js on the server): agent names,
 * the guard's mode and scope, decision counts by agent and rule, whether the log verifies, and the
 * kinds of finding. Never a command, a path, a domain, a repository or a session id.
 */
export function sharePayload(report, { home, env = {}, name = null } = {}) {
  const g = guardState({ ...env, HOME: home });
  const found = detectAgents({ ...env, HOME: home }).filter((d) => d.found).map((d) => d.target);
  const kinds = new Map();
  for (const f of report.findings ?? []) {
    const k = `${f.kind}|${f.severity}`;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const d = report.guard;
  return {
    machine: machineKey(home, env),
    ...(name ? { name } : {}),
    os: platform(),
    cli: VERSION,
    guard: { mode: g.mode, scope: g.scope, agents: g.agents },
    found,
    used: (report.byAgent ?? []).map((a) => a.agent),
    sessions: report.totals?.sessions ?? 0,
    window: report.window,
    decisions: d ? { allow: d.allow, ask: d.ask, deny: d.deny, settings: d.settings ?? 0, byAgent: d.byAgent, rules: d.rules } : null,
    log: { ok: !(d?.brokenDays?.length), brokenDays: d?.brokenDays?.length ?? 0 },
    teamRules: (() => { const e = { ...env, HOME: home }; const t = readTeamRules(e) ?? readTeamRules(e, 'managed'); return t ? { version: t.version } : null; })(),
    findings: [...kinds].map(([k, count]) => { const [kind, severity] = k.split('|'); return { kind, severity, count }; }),
  };
}

export async function scanHistory(ctx) {
  const { ui, flags } = ctx;
  if (flags.ci || flags.approve) {
    if (flags.approve && !flags.ci) throw usage('--approve goes with --ci: immiscible scan --ci --approve');
    return scanRepository(ctx);
  }
  const home = ctx.env.HOME || homedir();
  const now = Date.now();
  const since = parseSince(flags.since, now);
  const shown = shownPath(home);

  const { sessions, sources, transcriptSecrets } = readHistory({ home, env: ctx.env, since, projectDirs: [ctx.dir] });
  // The guard's own log: what its hooks decided, and the only record of the agents whose history scan cannot read.
  const log = readDecisions(logDir(home, ctx.env), since);
  // A call the guard refused is in the agent's own history (written before the hook decided), but never ran.
  dropRefused(sessions, log.decisions);
  const logged = guardSessions(log.decisions);
  sessions.push(...logged);
  const guarded = guardedAgents({ ...ctx.env, HOME: home });
  noteLoggedSources(sources, logged, { ...ctx.env, HOME: home }, guarded);
  const guard = guardSummary(log, since);
  const projects = [...new Set([ctx.dir, ...sessions.map((s) => s.cwd).filter(Boolean)])].filter((d) => existsSync(d)).slice(0, 200);
  const config = readConfig({ home, env: ctx.env, projects, shown });
  const report = analyse({ sessions, sources, config, since, until: now, shown, transcriptSecrets, guard });
  // Counted on this machine from git; only the domain and a number are kept.
  report.team = flags['no-team'] ? null : teamHint(projects, { cwd: ctx.dir });

  // --share: this machine's guard, for the team's Agents page. Counts and names only (sharePayload).
  let shared = null;
  if (flags.share) {
    if (flags.name != null && (typeof flags.name !== 'string' || !/^[\p{L}\p{N} ._'()-]{1,60}$/u.test(flags.name.trim()))) throw usage('--name must be 1 to 60 letters, digits, spaces or . _ \' ( ) -');
    ctx.requireToken();
    // A machine on the team's rules picks up the latest with each share.
    let rulesRefreshed = null;
    if (readTeamRules({ ...ctx.env, HOME: home })) {
      try { rulesRefreshed = await syncTeamRules({ ...ctx, env: { ...ctx.env, HOME: home } }, { refreshOnly: true }); } catch (err) { rulesRefreshed = { error: err.message }; }
    }
    const body = sharePayload(report, { home, env: ctx.env, name: flags.name?.trim() ?? null });
    try {
      const out = await ctx.api().post('/v1/cli/guard-report', body);
      shared = { ok: true, machine: out.machine, guarded: out.guarded, unguarded: out.unguarded, url: out.url ?? null, ...(rulesRefreshed ? { teamRules: rulesRefreshed } : {}) };
    } catch (err) {
      shared = { ok: false, error: err.message };
    }
  }

  let html = null;
  if (flags.html) {
    const file = path.resolve(ctx.dir, flags.html);
    try { writeFileSync(file, renderHtml(report)); } catch (e) {
      throw new CliError(`could not write ${flags.html}: ${e.code ?? e.message}`, { exit: EXIT.ERROR, code: 'write_failed', fix: 'Choose a path in a directory you can write to.' });
    }
    html = file;
  }

  const exit = report.findings.some((f) => f.severity === 'high') ? EXIT.FINDINGS : EXIT.OK;
  if (ui.json) {
    ui.writeJson({ ok: true, exitCode: exit, local: !shared, ...report, ...(html ? { html } : {}), ...(shared ? { shared } : {}) });
    return exit;
  }
  renderText(report, ui);
  if (html) ui.ok(`Report written to ${shown(html)}`);
  if (shared?.ok) {
    ui.ok(`Shared this machine's guard with your workspace${shared.url ? `: ${shared.url}` : ''}`);
    ui.note('  Sent: agent names, how they are guarded, decision counts by rule and finding kinds. Never a command, path, domain or repository.');
    if (shared.unguarded?.length) ui.warn(`Not guarded here: ${shared.unguarded.map((a) => AGENT_LABELS[a === 'gemini' ? 'gemini-cli' : a === 'droid' ? 'factory-droid' : a] ?? a).join(', ')}. npx immiscible guard`);
  } else if (shared) ui.warn(`Could not share with your workspace: ${shared.error}`);
  if (guarded.size) ui.out(`  ${ui.c.dim('Guard is on. Any session as a timeline, with every decision:')}  npx immiscible replay`);
  else if (report.totals.sessions) ui.out(`  ${ui.c.dim('Fix it in one command, no account needed:')}  npx immiscible guard`);
  if (report.team?.colleagues >= 2) ui.out(`  ${ui.c.dim(`${report.team.colleagues} others at ${report.team.domain} commit to these repositories. One set of rules for all of you:`)}  immiscible.ai/pricing`);
  return exit;
}
