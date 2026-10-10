/**
 * immiscible guard: the fix after `immiscible scan`, in one command.
 *
 * It finds the coding agents on this machine (Claude Code, Codex, Cursor,
 * Windsurf, Gemini CLI) and puts one fail-closed hook in front of each,
 * using the same planners as `immiscible install`. By default the hooks run
 * the local rules (scripts/local-policy.mjs, IMMISCIBLE_MODE=local): no
 * account, nothing sent anywhere. Force pushes to protected branches, rm -r
 * of the root or home directory, secrets sent off the machine and disk wipes
 * are refused; publishing, infrastructure changes, curl | sh, sudo, history
 * rewrites, edits to agent and shell configuration, and the network after a
 * session read a secret file ask the person at the keyboard (Claude Code and
 * Cursor) or are refused with the way to go ahead (Codex, Windsurf, Gemini
 * CLI, which cannot ask from a hook).
 *
 *   --connect        the same hooks, asking your Immiscible server instead, so
 *                    a person can approve from Slack, Teams or the phone (needs
 *                    --key or IMMISCIBLE_AGENT_KEY)
 *   --off            put every file back exactly as it was before guard
 *   --agents a,b     only these agents (claude-code, codex, cursor, windsurf, gemini, droid, opencode, amp);
 *                    `all` guards every one, found or not: for a box or image built before any agent runs
 *   --scope managed  for everyone on this machine (run as an administrator)
 *   --dry-run        show every change and write nothing
 *
 * What guard changed is kept in ~/.immiscible/guard.json: each file's path,
 * whether it existed, its content before guard first touched it, and a hash of
 * what guard wrote. `--off` restores a file only when it still holds what
 * guard wrote; a file someone has changed since is left alone and named.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CliError, EXIT, usage } from '../errors.mjs';
import { diffLines, compactDiff, BUNDLED_HOOK } from '../claude.mjs';
import { fleetPaths, planFleet, homeOf } from '../fleet.mjs';
import { AGENT_TARGETS, AGENT_LABELS, BUNDLED_AGENT_HOOK, PLUGIN_AGENTS, NO_MANAGED, planAgent, planEnv } from '../agent-hooks.mjs';
import { syncTeamRules, removeTeamRules, readTeamRules } from '../team-rules.mjs';

export const GUARD_TARGETS = Object.freeze(['claude-code', ...AGENT_TARGETS]);
const LABELS = Object.freeze({ 'claude-code': 'Claude Code', ...AGENT_LABELS });
const STATE_VERSION = 1;

export const REFUSED = 'force pushes to main, master, release or production; rm -r of the root or home directory; secrets sent off the machine; disk wipes; network or shutdown lines added to shell start-up files; an agent switching off or pausing the guard';
export const ASKED = 'publishing a package or image; terraform, pulumi, kubectl and helm changes; curl | sh; sudo; history rewrites; dropping a database; edits to agent and shell configuration, and to Immiscible’s own records; the network after the session read a secret file';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** The agents installed for this person, judged by the folders each keeps in the home directory. */
export function detectAgents(env = process.env) {
  const home = homeOf(env);
  const xdg = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config');
  const where = {
    'claude-code': [path.join(home, '.claude'), path.join(home, '.claude.json')],
    codex: [env.CODEX_HOME || path.join(home, '.codex')],
    cursor: [path.join(home, '.cursor')],
    windsurf: [path.join(home, '.codeium', 'windsurf')],
    gemini: [path.join(home, '.gemini')],
    droid: [path.join(home, '.factory')],
    opencode: [path.join(xdg, 'opencode'), path.join(home, '.opencode')],
    amp: [path.join(xdg, 'amp')],
  };
  return GUARD_TARGETS.map((target) => {
    const hit = where[target].find((p) => existsSync(p)) ?? null;
    return { target, label: LABELS[target], found: Boolean(hit), where: hit };
  });
}

/** The agents guard has written hooks for on this machine, from its state files (user and managed). */
export function guardedAgents(env = process.env) {
  return new Set(guardState(env).agents);
}

/**
 * Guard on this machine, from its state files: { mode, scope, agents }. scope is managed when a
 * managed guard is on (it holds for everyone), mode is the managed one's when both are on.
 */
export function guardState(env = process.env) {
  const user = readState(statePath('user', env));
  const managed = readState(statePath('managed', env));
  const agents = new Set();
  for (const st of [user, managed]) for (const f of st?.files ?? []) if (typeof f.agent === 'string') agents.add(f.agent);
  const on = managed?.files?.length ? managed : user?.files?.length ? user : null;
  return { mode: on?.mode ?? null, scope: on ? (on === managed ? 'managed' : 'user') : null, agents: [...agents] };
}

export function statePath(scope, env = process.env) {
  if (env.IMMISCIBLE_GUARD_STATE) return path.resolve(env.IMMISCIBLE_GUARD_STATE);
  return path.join(homeOf(env), '.immiscible', scope === 'managed' ? 'guard-managed.json' : 'guard.json');
}

function readState(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && j.version === STATE_VERSION && Array.isArray(j.files) ? j : null;
  } catch {
    return null;
  }
}

/**
 * Every file one agent's guard would write: [{ path, after (Buffer), mode, kind }],
 * plus { label, config, warnings, error }. Built only from the install planners.
 */
export function planGuardAgent(target, { scope, mode, url, key, env }) {
  if (target === 'claude-code') {
    const paths = fleetPaths(scope, { env });
    const plan = planFleet(paths.settings, { scope, transport: 'command', url, hookFile: paths.hook, key, mode });
    if (plan.error) return { target, error: plan.error };
    return {
      target, label: LABELS[target], config: paths.settings, warnings: [],
      files: [
        { kind: 'hook', path: paths.hook, after: readFileSync(BUNDLED_HOOK), mode: 0o644 },
        { kind: 'config', path: paths.settings, after: Buffer.from(plan.after), before: plan.before, mode: key && scope === 'user' ? 0o600 : null },
      ],
      selfTest: [paths.hook],
    };
  }
  if (scope === 'managed' && PLUGIN_AGENTS.includes(target)) return { target, error: NO_MANAGED[target] };
  const plan = planAgent(target, scope, { env });
  if (plan.error) return { target, error: plan.error };
  const envPlan = planEnv(plan.envFile, { url, key, mode });
  const warnings = [...(plan.warnings ?? [])];
  if (target === 'codex' && scope === 'user') warnings.push('Codex runs a hook from your own settings once you trust it: open Codex and approve it under /hooks.');
  return {
    target, label: LABELS[target], config: plan.config, warnings,
    files: [
      { kind: 'hook', path: plan.hookFile, after: readFileSync(BUNDLED_AGENT_HOOK), mode: 0o644 },
      { kind: 'env', path: plan.envFile, after: Buffer.from(envPlan.after), before: envPlan.before, mode: scope === 'user' ? 0o600 : 0o644 },
      { kind: 'config', path: plan.config, after: Buffer.from(plan.after), before: plan.before, mode: null },
    ],
    selfTest: [plan.hookFile, target],
  };
}

function selfTest(file, agent = null) {
  const r = spawnSync(process.execPath, [file, ...(agent ? ['--agent', agent] : []), '--self-test'], { encoding: 'utf8', timeout: 15_000 });
  try {
    const j = JSON.parse(String(r.stdout).trim().split('\n').pop());
    return { ok: r.status === 0 && j.ok === true, node: j.node ?? null };
  } catch {
    return { ok: false, error: (r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 300) };
  }
}

const writeError = (err, file, scope) => new CliError(`could not write ${file} (${err.code ?? err.message})`, {
  exit: EXIT.ERROR,
  code: 'write_failed',
  fix: scope === 'managed' && ['EACCES', 'EPERM'].includes(err.code)
    ? 'Managed files belong to the administrator: run it again with sudo (or as an administrator on Windows), or use --dry-run to see the files.'
    : 'Check the directory exists and you can write to it. Files already written are listed in ~/.immiscible/guard.json, and guard --off puts them back.',
});

/** --agents as { list, all }: null list when not given; all when it names every agent. */
function parseAgents(value) {
  if (value == null) return { list: null, all: false };
  const list = String(value).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.includes('all')) {
    if (list.length > 1) throw usage('--agents all stands alone');
    return { list: [...GUARD_TARGETS], all: true };
  }
  return { list: checkAgents(list.map((s) => (s === 'claude' ? 'claude-code' : s === 'gemini-cli' ? 'gemini' : s === 'factory' || s === 'factory-droid' ? 'droid' : s))), all: false };
}

function checkAgents(list) {
  const bad = list.filter((a) => !GUARD_TARGETS.includes(a));
  if (bad.length || !list.length) throw usage(`--agents takes all or ${GUARD_TARGETS.join(', ')}${bad.length ? `, not ${bad.join(', ')}` : ''}`);
  return [...new Set(list)];
}

export async function guard(ctx) {
  const { ui, flags, env } = ctx;
  const { c } = ui;
  const scope = flags.scope ?? 'user';
  if (!['user', 'managed'].includes(scope)) throw usage('--scope must be user or managed');
  const dryRun = Boolean(flags['dry-run']);
  const stateFile = statePath(scope, env);
  // Run from inside a coding agent's shell, a change that weakens the guard is refused here too, beside the hook.
  if ((flags.off || flags.pause != null || flags.connect) && !dryRun) {
    const inside = agentShell(env);
    if (inside) throw new CliError(`${flags.off ? 'guard --off' : flags.pause != null ? 'guard --pause' : 'guard --connect'} was run from inside ${inside}`, { exit: EXIT.REFUSED, code: 'agent_shell', fix: 'Run it yourself, in your own terminal: an agent cannot switch off, pause or redirect the guard that checks it.' });
  }
  if (flags.off) return guardOff(ctx, { scope, stateFile, dryRun });
  if (flags.pause != null || flags.resume) return guardPause(ctx);
  if (flags.status) return guardStatus(ctx);

  const connect = Boolean(flags.connect);
  const key = flags.key ?? (connect ? env.IMMISCIBLE_AGENT_KEY || env.ASSAY_AGENT_KEY || null : null);
  if (key != null && !/^[!-~]{8,512}$/.test(key)) throw usage('--key does not look like an agent key');
  if (connect && !key) {
    throw new CliError('--connect needs an agent key, so approvals can reach your phone', {
      exit: EXIT.INPUT, code: 'key_required',
      fix: 'Make one in the console (Agents, then Keys), or run npx immiscible init, then: npx immiscible guard --connect --key <agent key>. Without --connect, guard runs local rules and needs no account.',
    });
  }
  const mode = connect ? 'server' : 'local';
  // --team: the workspace's own rules, fetched signed and decided on this machine beside the built-in ones.
  if (flags.team && connect) throw usage('--team adds your team\'s rules to the local ones; with --connect your workspace decides every call already');
  const team = flags.team ? await syncTeamRules(ctx, { dryRun, scope }) : null;
  const { list: chosen, all } = parseAgents(flags.agents);
  const detected = detectAgents(env);
  // Found (or asked for with all) but with no managed scope (opencode, Amp): left out of a managed guard, and said so below.
  const unmanaged = scope === 'managed' && (all || !chosen) ? detected.filter((d) => (all || d.found) && PLUGIN_AGENTS.includes(d.target)) : [];
  const targets = all ? chosen.filter((t) => !unmanaged.some((d) => d.target === t)) : (chosen ?? detected.filter((d) => d.found && !unmanaged.includes(d)).map((d) => d.target));
  if (!targets.length) {
    if (ui.json) ui.writeJson({ ok: true, mode, scope, agents: [], detected, note: 'no coding agents found' });
    else {
      ui.warn('No coding agents found on this machine (Claude Code, Codex, Cursor, Windsurf, Gemini CLI, Factory Droid, opencode or Amp).');
      ui.note('Name one to guard it anyway: npx immiscible guard --agents claude-code');
    }
    return EXIT.OK;
  }

  const plans = targets.map((t) => planGuardAgent(t, { scope, mode, url: ctx.url, key, env }));
  const broken = plans.find((p) => p.error);
  if (broken) throw new CliError(broken.error, { exit: EXIT.ERROR, code: 'settings_unreadable', fix: 'Fix that file, then run it again. Nothing was changed.' });
  const hide = (lines) => (key ? lines.map((l) => l.split(key).join('<agent key>')) : lines);
  const changes = [];
  for (const p of plans) {
    for (const f of p.files) {
      const current = existsSync(f.path) ? readFileSync(f.path) : null;
      if (current && current.equals(f.after)) continue;
      changes.push({ agent: p.target, ...f, existed: Boolean(current), current });
    }
  }

  const summary = plans.map((p) => ({ agent: p.target, label: p.label, config: p.config, changed: changes.some((x) => x.agent === p.target), warnings: p.warnings }));
  const result = { ok: true, mode, scope, dryRun, state: stateFile, ...(team ? { team } : {}), agents: summary, ...(unmanaged.length ? { skipped: unmanaged.map((d) => ({ agent: d.target, reason: NO_MANAGED[d.target] })) } : {}), refused: REFUSED, asked: ASKED };

  if (!ui.json) {
    ui.out(`${c.bold('Immiscible guard')}  ${c.dim(mode === 'local' ? 'local rules, nothing leaves this machine' : `asking ${ctx.url}, approvals on your phone`)}`);
    ui.blank();
    if (dryRun) {
      for (const ch of changes.filter((x) => x.kind !== 'hook')) {
        ui.out(`${c.bold(ch.path)}${ch.existed ? '' : c.dim(' (new file)')}`);
        for (const l of hide(compactDiff(diffLines(ch.current ? ch.current.toString('utf8') : '', ch.after.toString('utf8'))))) ui.out(l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : c.dim(l));
        ui.blank();
      }
      for (const ch of changes.filter((x) => x.kind === 'hook')) ui.out(`${c.bold(ch.path)} ${c.dim(ch.existed ? '(the hook, updated)' : '(new file: the hook)')}`);
    }
  }
  if (dryRun) {
    if (ui.json) ui.writeJson({ ...result, changed: false, wouldChange: changes.length > 0, files: changes.map((x) => ({ agent: x.agent, kind: x.kind, path: x.path, existed: x.existed })) });
    else ui.note(changes.length ? 'Dry run: nothing was written.' : 'Already guarded; nothing would change.');
    return EXIT.OK;
  }

  if (changes.length && !flags.yes) {
    if (!ui.interactive) throw new CliError('guard changes files and needs a yes', { exit: EXIT.INPUT, code: 'confirmation_required', fix: 'Pass --yes to go ahead, or --dry-run to see every change first.' });
    const names = plans.map((p) => p.label).join(', ');
    if (!(await ui.confirm(`Guard ${names}? Each gets a hook that ${mode === 'local' ? 'checks every risky call on this machine' : 'asks Immiscible before risky calls'}. Undo any time with guard --off.`, { default: true }))) {
      ui.note('Nothing was changed.');
      return EXIT.OK;
    }
  }

  // Record what each file held before guard first touched it, before writing anything.
  const prior = readState(stateFile);
  const files = new Map((prior?.files ?? []).map((f) => [f.path, f]));
  for (const ch of changes) {
    if (!files.has(ch.path)) files.set(ch.path, { path: ch.path, agent: ch.agent, kind: ch.kind, existed: ch.existed, before: ch.current ? ch.current.toString('base64') : null, wrote: null });
  }
  const saveState = () => {
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      writeFileSync(stateFile, `${JSON.stringify({ version: STATE_VERSION, mode, scope, url: ctx.url, updatedAt: new Date().toISOString(), files: [...files.values()] }, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      throw writeError(err, stateFile, scope);
    }
  };
  saveState();

  // Hooks and env files first, then each hook's self-test, then the agents'
  // configuration: a configuration that names a hook that cannot run would refuse every call.
  const write = (ch) => {
    try {
      mkdirSync(path.dirname(ch.path), { recursive: true });
      writeFileSync(ch.path, ch.after, ch.mode ? { mode: ch.mode } : undefined);
      if (ch.mode && process.platform !== 'win32') chmodSync(ch.path, ch.mode);
    } catch (err) {
      throw writeError(err, ch.path, scope);
    }
    files.get(ch.path).wrote = sha(ch.after);
  };
  for (const ch of changes.filter((x) => x.kind !== 'config')) write(ch);
  const tests = [];
  for (const p of plans) {
    const t = selfTest(...p.selfTest);
    tests.push({ agent: p.target, ...t });
    if (!t.ok) {
      saveState();
      throw new CliError(`the ${p.label} hook does not run here (${t.error ?? 'its self-test failed'})`, { exit: EXIT.ERROR, code: 'self_test_failed', fix: 'Immiscible needs Node 22.13 or later on the PATH the agent uses. No agent configuration was changed; guard --off removes the copied files.' });
    }
  }
  for (const ch of changes.filter((x) => x.kind === 'config')) write(ch);
  saveState();

  if (ui.json) {
    ui.writeJson({ ...result, changed: changes.length > 0, selfTest: tests });
    return EXIT.OK;
  }
  const width = Math.max(...plans.map((p) => p.label.length));
  for (const d of detected) {
    const p = plans.find((x) => x.target === d.target);
    if (p) ui.ok(`${p.label.padEnd(width)}  ${c.dim(p.config)}`);
    else if (unmanaged.includes(d)) ui.out(`${c.dim('·')} ${d.label.padEnd(width)}  ${c.dim('no managed scope: run guard --agents ' + d.target + ' as each person')}`);
    else if (!chosen) ui.out(`${c.dim('·')} ${d.label.padEnd(width)}  ${c.dim('not on this machine')}`);
  }
  for (const p of plans) for (const w of p.warnings) ui.warn(w);
  ui.blank();
  ui.out(`  ${c.bold('Refused')}  ${c.dim(REFUSED)}`);
  ui.out(`  ${c.bold('Asked')}    ${c.dim(ASKED)}`);
  if (team) ui.out(`  ${c.bold('Team')}     ${c.dim(`your workspace's rules, version ${team.version}: ${team.counts.deny} refused, ${team.counts.ask} asked, ${team.counts.protectedBranches} protected branches, ${team.counts.blockedDomains} blocked domains`)}`);
  ui.blank();
  if (mode === 'local') {
    const first = plans[0];
    ui.out(`  ${c.dim('Try it:')} ask ${first.label} to run ${c.bold('git push --force origin main')}`);
    ui.out(`  ${c.dim('Approvals on your phone instead:')} npx immiscible guard --connect --key <agent key>`);
  }
  ui.out(`  ${c.dim('Turn it off, exactly as it was:')} npx immiscible guard --off`);
  if (ctx.token) ui.out(`  ${c.dim('Show your team this machine is guarded:')} npx immiscible scan --share`);
  ui.note('  Sessions already open pick up hooks when they next start.');
  return EXIT.OK;
}

/**
 * Whether this runs inside a coding agent's own shell, by the variables the agents set for the commands they
 * run (best effort; the hook's own refusal is the first line): the agent's name, or null.
 */
export function agentShell(env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'Claude Code';
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) return 'Codex';
  if (env.GEMINI_CLI) return 'Gemini CLI';
  if (env.CURSOR_AGENT) return 'Cursor';
  if (env.OPENCODE) return 'opencode';
  return null;
}

/** The pause file: the person's own, or (--scope managed) the machine's, the only one a managed guard reads. */
export function pausePath(env = process.env, scope = 'user', platform = process.platform) {
  if (scope === 'managed') return platform === 'win32' ? path.join(env.ProgramData || 'C:\\ProgramData', 'immiscible', 'pause.json') : '/etc/immiscible/pause.json';
  return path.join(homeOf(env), '.immiscible', 'pause.json');
}

/** --pause 15m: for a while, what the guard would ask about goes ahead, logged as paused; refusals stay. --resume ends it. */
async function guardPause(ctx) {
  const { ui, flags, env } = ctx;
  const scope = flags.scope === 'managed' ? 'managed' : 'user';
  const file = pausePath(env, scope);
  if (flags.resume) {
    const was = existsSync(file);
    rmSync(file, { force: true });
    if (ui.json) ui.writeJson({ ok: true, paused: false, wasPaused: was });
    else ui.ok(was ? 'Guard is back on: everything is checked again.' : 'Guard was not paused.');
    return EXIT.OK;
  }
  const m = /^(\d{1,3})(m|h)?$/.exec(String(flags.pause).trim());
  const ms = m ? Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000) : NaN;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 2 * 3_600_000) throw usage('--pause takes a time up to 2h, such as 15m or 1h');
  const at = new Date();
  const until = new Date(at.getTime() + ms);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: scope === 'managed' ? 0o755 : 0o700 });
    writeFileSync(file, `${JSON.stringify({ at: at.toISOString(), until: until.toISOString() })}\n`, { mode: scope === 'managed' ? 0o644 : 0o600 });
  } catch (err) {
    throw writeError(err, file, scope);
  }
  if (ui.json) ui.writeJson({ ok: true, paused: true, until: until.toISOString() });
  else {
    ui.ok(`Guard paused until ${until.toTimeString().slice(0, 5)}: what it would ask about goes ahead, and is logged as paused.`);
    ui.note('  Still refused: force pushes to protected branches, rm -rf of home, secrets leaving the machine. Still asked: changes to agent configuration and to the guard itself. npx immiscible guard --resume ends it now.');
  }
  return EXIT.OK;
}

/** --status: what is guarded here, how, the team's rules, and whether it is paused. */
async function guardStatus(ctx) {
  const { ui, env } = ctx;
  const { c } = ui;
  const g = guardState(env);
  let pausedUntil = null;
  // The same test the hooks apply (scripts/local-policy.mjs, lpPausedUntil): set now, at most two hours, not rewritten since.
  try {
    const f = pausePath(env, g.scope === 'managed' ? 'managed' : 'user');
    const p = JSON.parse(readFileSync(f, 'utf8'));
    const at = Date.parse(p.at);
    const u = Date.parse(p.until);
    const ok = Number.isFinite(at) && Number.isFinite(u) && at <= Date.now() + 60_000 && u - at <= 2 * 3_600_000 && statSync(f).mtimeMs <= at + 60_000;
    if (ok && u > Date.now()) pausedUntil = new Date(u).toISOString();
  } catch { /* not paused */ }
  const team = readTeamRules(env) ?? readTeamRules(env, 'managed');
  const found = detectAgents(env).filter((d) => d.found).map((d) => d.target);
  const unguarded = found.filter((a) => !g.agents.includes(a));
  const out = { ok: true, on: g.agents.length > 0, mode: g.mode, scope: g.scope, agents: g.agents, unguarded, team: team ? { version: team.version, workspace: team.workspace } : null, pausedUntil };
  if (ui.json) { ui.writeJson(out); return EXIT.OK; }
  if (!out.on) { ui.warn('Guard is not on here.'); ui.note('  npx immiscible guard'); return EXIT.OK; }
  ui.ok(`Guard is on for ${g.agents.map((a) => LABELS[a] ?? a).join(', ')} ${c.dim(`(${g.mode === 'server' ? 'asking your workspace' : 'local rules'}, ${g.scope === 'managed' ? 'managed settings' : 'your own settings'})`)}`);
  if (team) ui.out(`  ${c.dim('Team rules:')} version ${team.version}`);
  if (pausedUntil) ui.warn(`Paused until ${new Date(pausedUntil).toTimeString().slice(0, 5)}. npx immiscible guard --resume`);
  if (unguarded.length) ui.warn(`Not guarded: ${unguarded.map((a) => LABELS[a] ?? a).join(', ')}. npx immiscible guard`);
  return EXIT.OK;
}

async function guardOff(ctx, { scope, stateFile, dryRun }) {
  const { ui, flags } = ctx;
  const { c } = ui;
  const state = readState(stateFile);
  if (!state) {
    if (ui.json) ui.writeJson({ ok: true, off: true, restored: [], kept: [], note: 'guard was not on' });
    else ui.note('Guard is not on here: there is nothing to put back.');
    return EXIT.OK;
  }
  const restored = [];
  const kept = [];
  for (const f of state.files) {
    const now = existsSync(f.path) ? readFileSync(f.path) : null;
    const ours = f.wrote == null ? true : now != null && sha(now) === f.wrote;
    if (!ours) { kept.push({ path: f.path, why: now == null ? 'already removed' : 'changed since guard wrote it' }); continue; }
    restored.push({ path: f.path, to: f.existed ? 'as it was' : 'removed' });
  }
  if (!dryRun) {
    if (!flags.yes && ui.interactive && !(await ui.confirm(`Put ${restored.length} file${restored.length === 1 ? '' : 's'} back as they were before guard?`, { default: true }))) {
      ui.note('Nothing was changed.');
      return EXIT.OK;
    }
    if (!flags.yes && !ui.interactive) throw new CliError('guard --off changes files and needs a yes', { exit: EXIT.INPUT, code: 'confirmation_required', fix: 'Pass --yes, or --dry-run to see what would be put back.' });
    // Agent configuration first, so no agent is left pointing at a hook that is gone.
    const order = [...state.files.filter((f) => f.kind === 'config'), ...state.files.filter((f) => f.kind !== 'config')];
    for (const f of order) {
      if (!restored.some((r) => r.path === f.path)) continue;
      try {
        if (f.existed) writeFileSync(f.path, Buffer.from(f.before ?? '', 'base64'));
        else rmSync(f.path, { force: true });
      } catch (err) {
        throw writeError(err, f.path, scope);
      }
    }
    rmSync(stateFile, { force: true });
  }
  // The team's rules go with the hooks that read them.
  const teamRemoved = readTeamRules(ctx.env, scope) ? (dryRun ? true : removeTeamRules(ctx.env, scope)) : false;
  if (ui.json) ui.writeJson({ ok: true, off: true, dryRun, restored, kept, teamRulesRemoved: teamRemoved });
  else {
    for (const r of restored) ui.ok(`${r.path} ${c.dim(r.to === 'removed' ? '(removed: guard made it)' : '(put back as it was)')}`);
    for (const k of kept) ui.warn(`${k.path} ${c.dim(`left alone: ${k.why}; take the Immiscible entry out by hand`)}`);
    if (teamRemoved) ui.ok(`Your team's rules ${c.dim(dryRun ? '(would be removed)' : '(removed)')}`);
    ui.note(dryRun ? 'Dry run: nothing was changed.' : 'Guard is off.');
  }
  return EXIT.OK;
}
