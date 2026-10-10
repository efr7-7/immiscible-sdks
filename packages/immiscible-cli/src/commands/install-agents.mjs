/**
 * immiscible install codex|cursor|windsurf|gemini|droid|opencode|amp: a fail-closed
 * hook (for opencode and Amp, a plugin) for a coding agent, for one person (--scope user) or for everyone on the
 * machine (--scope managed). What each writes, and why, is in
 * ../agent-hooks.mjs.
 *
 * It shows the change first and writes only on a yes (--yes when not a
 * terminal); --dry-run shows it and writes nothing. After copying the hook
 * it runs `node <hook> --agent <agent> --self-test`, and only then changes
 * the agent's configuration, so a hook that cannot run on this machine is
 * found before any tool call depends on it.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CliError, EXIT, usage } from '../errors.mjs';
import { diffLines, compactDiff } from '../claude.mjs';
import { AGENT_TARGETS, AGENT_LABELS, BUNDLED_AGENT_HOOK, TIMING, PLUGIN_AGENTS, NO_MANAGED, planAgent, planEnv } from '../agent-hooks.mjs';

export const SCOPES = Object.freeze(['user', 'managed']);
export { AGENT_TARGETS };

const writeError = (err, file, scope) => new CliError(`could not write ${file} (${err.code ?? err.message})`, {
  exit: EXIT.ERROR,
  code: 'write_failed',
  fix: scope === 'managed' && ['EACCES', 'EPERM'].includes(err.code)
    ? 'Managed files belong to the administrator: run it again with sudo (or as an administrator on Windows), or deploy the files with your device management tool (--dry-run shows them).'
    : 'Check the directory exists and you can write to it.',
});

export async function installAgents(ctx) {
  const { ui, flags, env } = ctx;
  const { c } = ui;
  const target = ctx.rest?.[0] ?? null;
  if (!target) throw usage(`install needs a target: immiscible install ${AGENT_TARGETS.join('|')}`, 'Run immiscible install --help.');
  if (target === 'claude-code') throw usage('install claude-code is not in this version; immiscible init installs the Claude Code hook in a project', 'Run immiscible init in the project.');
  if (!AGENT_TARGETS.includes(target)) throw usage(`there is no installer for "${target}"; the installers are ${AGENT_TARGETS.join(', ')}`);
  if (ctx.rest.length > 1) throw usage('install takes one target at a time');
  const scope = flags.scope ?? 'user';
  if (!SCOPES.includes(scope)) throw usage(`--scope must be ${SCOPES.join(' or ')}`);
  if (scope === 'managed' && PLUGIN_AGENTS.includes(target)) throw usage(`there is no managed scope for ${AGENT_LABELS[target]}`, NO_MANAGED[target]);
  const key = flags.key ?? null;
  if (key != null && !/^[!-~]{8,512}$/.test(key)) throw usage('--key does not look like an agent key');
  const dryRun = Boolean(flags['dry-run']);
  const label = AGENT_LABELS[target];

  const plan = planAgent(target, scope, { env });
  if (plan.error) throw new CliError(plan.error, { exit: EXIT.ERROR, code: 'settings_unreadable', fix: 'Fix the file, then run it again. Nothing was changed.' });
  const envPlan = planEnv(plan.envFile, { url: ctx.url, key });
  const fresh = readFileSync(BUNDLED_AGENT_HOOK);
  const hookState = !existsSync(plan.hookFile) ? 'added' : readFileSync(plan.hookFile).equals(fresh) ? 'unchanged' : 'updated';
  const nothingToDo = !plan.changed && !envPlan.changed && hookState === 'unchanged';
  // The diff never shows the key itself.
  const hide = (lines) => (key ? lines.map((l) => l.split(key).join('<agent key>')) : lines);
  const diff = plan.changed ? compactDiff(diffLines(plan.before, plan.after)) : [];
  const envDiff = envPlan.changed ? hide(compactDiff(diffLines(envPlan.before, envPlan.after))) : [];
  const warnings = [...plan.warnings];
  if (!envPlan.hasKey && !env.IMMISCIBLE_AGENT_KEY) warnings.push(`No agent key was given (--key), none is in ${plan.envFile}, and IMMISCIBLE_AGENT_KEY is not set here: until one is, the hook refuses every call it checks.`);
  if (key && scope === 'managed') warnings.push(`The agent key is in ${plan.envFile}, which every account on this machine can read: use a key for an agent that stands for this machine, or leave --key out and set IMMISCIBLE_AGENT_KEY for each person.`);
  if (target === 'codex' && scope === 'user') warnings.push('Codex runs a hook from your own settings only once you trust it: open Codex and approve it under /hooks. Hooks in the managed requirements.toml need no trust step.');
  if (TIMING[target].wait === 0 && !['cursor', 'droid'].includes(target)) warnings.push(`${label} cannot ask the person at the keyboard and documents no hook timeout, so a call that needs a person is refused with the approval link; run it again once they approve.`);

  const result = {
    ok: true, target, scope, dryRun,
    config: plan.config, configState: plan.state,
    hookFile: plan.hookFile, hookFileState: hookState,
    envFile: plan.envFile, envFileState: !envPlan.changed ? 'unchanged' : envPlan.before ? 'updated' : 'added',
    command: plan.command,
    diff, envDiff,
    ...(warnings.length ? { warnings } : {}),
  };

  if (!ui.json) {
    ui.out(`${c.bold('Immiscible')} ${c.dim(`install ${target}, ${scope} scope`)}`);
    ui.blank();
    const show = (file, lines, isNew) => {
      ui.out(`${c.bold(file)}${isNew ? c.dim(' (new file)') : ''}`);
      for (const l of lines) ui.out(l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : c.dim(l));
      ui.blank();
    };
    if (plan.changed) show(plan.config, diff, !plan.before);
    if (envPlan.changed) show(plan.envFile, envDiff, !envPlan.before);
    if (hookState !== 'unchanged') ui.out(`${c.bold(plan.hookFile)} ${c.dim(hookState === 'added' ? '(new file: the hook)' : '(the hook, updated)')}`);
  }
  if (dryRun) {
    if (ui.json) ui.writeJson({ ...result, changed: false, wouldChange: !nothingToDo });
    else ui.note(nothingToDo ? 'Already installed; nothing would change.' : 'Dry run: nothing was written.');
    return EXIT.OK;
  }
  if (nothingToDo) {
    const test = selfTest(plan.hookFile, target);
    if (!test.ok) throw selfTestError(test, plan.hookFile);
    if (ui.json) ui.writeJson({ ...result, changed: false, selfTest: test });
    else {
      ui.ok(`The ${label} hook is already installed`);
      for (const w of warnings) ui.warn(w);
    }
    return EXIT.OK;
  }
  if (!flags.yes) {
    if (!ui.interactive) throw new CliError('installing changes files and needs a yes', { exit: EXIT.INPUT, code: 'confirmation_required', fix: 'Pass --yes to install, or --dry-run to see the change without making it.' });
    const go = await ui.confirm(scope === 'managed'
      ? `Install the hook for everyone on this machine who uses ${label}?`
      : `Install the ${label} ${PLUGIN_AGENTS.includes(target) ? 'plugin' : 'hook'}? It asks Immiscible before each shell command, file write and MCP tool call.`, { default: true });
    if (!go) {
      ui.note('Nothing was changed.');
      return EXIT.OK;
    }
  }

  // The hook and its env file first, then the self-test, then the agent's configuration:
  // a configuration that points at a hook that cannot run would refuse every call.
  try {
    mkdirSync(plan.hookDir, { recursive: true });
    if (hookState !== 'unchanged') {
      copyFileSync(BUNDLED_AGENT_HOOK, plan.hookFile);
      if (process.platform !== 'win32') chmodSync(plan.hookFile, 0o644);
    }
  } catch (err) {
    throw writeError(err, plan.hookFile, scope);
  }
  if (envPlan.changed) {
    try {
      // A person's own file holds their key: theirs alone to read. A managed one is read by everyone's hook.
      writeFileSync(plan.envFile, envPlan.after, { mode: scope === 'user' ? 0o600 : 0o644 });
      if (process.platform !== 'win32') chmodSync(plan.envFile, scope === 'user' ? 0o600 : 0o644);
    } catch (err) {
      throw writeError(err, plan.envFile, scope);
    }
  }
  const test = selfTest(plan.hookFile, target);
  if (!test.ok) throw selfTestError(test, plan.hookFile);
  if (plan.changed) {
    try {
      mkdirSync(path.dirname(plan.config), { recursive: true });
      writeFileSync(plan.config, plan.after);
    } catch (err) {
      throw writeError(err, plan.config, scope);
    }
  }
  if (ui.json) ui.writeJson({ ...result, changed: true, selfTest: test });
  else {
    ui.ok(`Installed the ${label} hook ${c.dim('(fails closed)')}`);
    ui.ok(`The hook runs here ${c.dim(`(node ${test.node})`)}`);
    ui.note(`${label} reads hooks when it starts: restart it, or open a new session, to pick this up.`);
    for (const w of warnings) ui.warn(w);
  }
  return EXIT.OK;
}

/** node <hook> --agent <agent> --self-test: { ok, node } or { ok: false, error }. */
function selfTest(hookFile, agent) {
  const r = spawnSync(process.execPath, [hookFile, '--agent', agent, '--self-test'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().slice(0, 300) };
  try {
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    return { ok: Boolean(out.ok), node: out.node };
  } catch {
    return { ok: false, error: 'the hook did not answer its self-test' };
  }
}

const selfTestError = (test, hookFile) => new CliError(`the hook at ${hookFile} did not pass its self-test (${test.error ?? 'not ok'})`, {
  exit: EXIT.ERROR,
  code: 'hook_self_test_failed',
  fix: 'The hook needs Node 22.13 or later on the PATH the agent uses. The agent\'s configuration was not changed.',
});
