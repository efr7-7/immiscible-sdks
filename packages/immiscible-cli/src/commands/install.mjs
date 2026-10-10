/**
 * immiscible install claude-code: the Claude Code hook for a whole machine,
 * for one person (--scope user) or for everyone on it (--scope managed).
 * What it writes, and why, is in ../fleet.mjs.
 *
 * It shows the change first and writes only on a yes (--yes when not a
 * terminal); --dry-run shows it and writes nothing. After copying the hook
 * it runs `node <hook> --self-test`, so a hook that cannot run on this
 * machine is found now, not on the first tool call.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CliError, EXIT, usage } from '../errors.mjs';
import { BUNDLED_HOOK, diffLines, compactDiff } from '../claude.mjs';
import { planFleet, fleetPaths, SCOPES, TRANSPORTS } from '../fleet.mjs';

export const INSTALL_TARGETS = Object.freeze(['claude-code']);

const writeError = (err, file, scope) => new CliError(`could not write ${file} (${err.code ?? err.message})`, {
  exit: EXIT.ERROR,
  code: 'write_failed',
  fix: scope === 'managed' && ['EACCES', 'EPERM'].includes(err.code)
    ? 'Managed settings belong to the administrator: run it again with sudo (or as an administrator on Windows), or deploy the file with your device management tool.'
    : 'Check the directory exists and you can write to it.',
});

export async function install(ctx) {
  const { ui, flags, env } = ctx;
  const { c } = ui;
  const target = ctx.rest?.[0] ?? null;
  if (!target) throw usage('install needs a target: immiscible install claude-code', 'Run immiscible install claude-code --help.');
  if (!INSTALL_TARGETS.includes(target)) throw usage(`there is no installer for "${target}"; the installers are ${INSTALL_TARGETS.join(', ')}`);
  const scope = flags.scope ?? 'user';
  if (!SCOPES.includes(scope)) throw usage(`--scope must be ${SCOPES.join(' or ')}`);
  const transport = flags.transport ?? 'command';
  if (!TRANSPORTS.includes(transport)) throw usage(`--transport must be ${TRANSPORTS.join(' or ')}`);
  let gateway = null;
  if (flags.gateway) {
    try { gateway = new URL(flags.gateway).toString().replace(/\/$/, ''); } catch { throw usage(`--gateway is not a URL: ${flags.gateway}`); }
  }
  const key = flags.key ?? null;
  if (key != null && !/^[!-~]{8,512}$/.test(key)) throw usage('--key does not look like an agent key');
  const dryRun = Boolean(flags['dry-run']);

  const paths = fleetPaths(scope, { env });
  const plan = planFleet(paths.settings, { scope, transport, url: ctx.url, hookFile: paths.hook, key, gateway });
  if (plan.error) throw new CliError(plan.error, { exit: EXIT.ERROR, code: 'settings_unreadable', fix: 'Fix the JSON, then run it again. Nothing was changed.' });
  const diff = plan.changed ? compactDiff(diffLines(plan.before, plan.after)) : [];
  // The diff never shows the key itself.
  const shown = key ? diff.map((l) => l.split(key).join('<agent key>')) : diff;
  const fresh = transport === 'command' ? readFileSync(BUNDLED_HOOK) : null;
  const hookState = transport !== 'command' ? 'none' : !existsSync(paths.hook) ? 'added' : readFileSync(paths.hook).equals(fresh) ? 'unchanged' : 'updated';
  const nothingToDo = !plan.changed && (hookState === 'unchanged' || hookState === 'none');
  const keyNote = key ? null : env.IMMISCIBLE_AGENT_KEY ? null : 'No agent key was given (--key) and IMMISCIBLE_AGENT_KEY is not set here: until each person\'s environment sets it, the hook refuses every tool call it checks.';

  const result = {
    ok: true, target, scope, transport, dryRun,
    settings: paths.settings, settingsState: plan.state,
    hookFile: transport === 'command' ? paths.hook : null, hookFileState: hookState,
    diff: shown,
  };

  if (!ui.json) {
    ui.out(`${c.bold('Immiscible')} ${c.dim(`install claude-code, ${scope} scope, ${transport} hook`)}`);
    ui.blank();
    if (plan.changed) {
      ui.out(`${c.bold(paths.settings)}${plan.before ? '' : c.dim(' (new file)')}`);
      for (const l of shown) ui.out(l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : c.dim(l));
      ui.blank();
    }
    if (hookState === 'added' || hookState === 'updated') ui.out(`${c.bold(paths.hook)} ${c.dim(hookState === 'added' ? '(new file: the hook)' : '(the hook, updated)')}`);
  }
  if (dryRun) {
    if (!ui.json) ui.note(nothingToDo ? 'Already installed; nothing would change.' : 'Dry run: nothing was written.');
    if (ui.json) ui.writeJson({ ...result, changed: false, wouldChange: !nothingToDo });
    return EXIT.OK;
  }
  if (nothingToDo) {
    const test = transport === 'command' ? selfTest(paths.hook) : null;
    if (test && !test.ok) throw selfTestError(test, paths.hook);
    if (ui.json) ui.writeJson({ ...result, changed: false, selfTest: test, ...(keyNote ? { warning: keyNote } : {}) });
    else {
      ui.ok('The Claude Code hook is already installed');
      if (keyNote) ui.warn(keyNote);
    }
    return EXIT.OK;
  }
  if (!flags.yes) {
    if (!ui.interactive) throw new CliError('installing changes files and needs a yes', { exit: EXIT.INPUT, code: 'confirmation_required', fix: 'Pass --yes to install, or --dry-run to see the change without making it.' });
    const go = await ui.confirm(scope === 'managed'
      ? 'Install the hook for everyone on this machine? Hooks from other settings, projects and plugins will no longer run.'
      : 'Install the Claude Code hook for every project? It asks Immiscible before each tool call.', { default: true });
    if (!go) {
      ui.note('Nothing was changed.');
      return EXIT.OK;
    }
  }

  if (transport === 'command' && hookState !== 'unchanged') {
    try {
      mkdirSync(path.dirname(paths.hook), { recursive: true });
      copyFileSync(BUNDLED_HOOK, paths.hook);
      if (process.platform !== 'win32') chmodSync(paths.hook, 0o644);
    } catch (err) {
      throw writeError(err, paths.hook, scope);
    }
  }
  const test = transport === 'command' ? selfTest(paths.hook) : null;
  if (test && !test.ok) throw selfTestError(test, paths.hook);
  if (plan.changed) {
    try {
      mkdirSync(path.dirname(paths.settings), { recursive: true });
      // A key in a person's own settings is theirs alone to read.
      writeFileSync(paths.settings, plan.after, key && scope === 'user' ? { mode: 0o600 } : undefined);
    } catch (err) {
      throw writeError(err, paths.settings, scope);
    }
  }
  if (ui.json) ui.writeJson({ ...result, changed: true, selfTest: test, ...(keyNote ? { warning: keyNote } : {}) });
  else {
    ui.ok(`Installed the Claude Code hook ${c.dim(`(${transport === 'command' ? 'fails closed' : 'http; the server refuses what it cannot check'})`)}`);
    if (test) ui.ok(`The hook runs here ${c.dim(`(node ${test.node})`)}`);
    if (scope === 'managed') ui.note('Claude Code reads hooks when a session starts: sessions already open keep their old hooks until restarted.');
    if (keyNote) ui.warn(keyNote);
  }
  return EXIT.OK;
}

/** node <hook> --self-test: { ok, node, ... } or { ok: false, error }. */
function selfTest(hookFile) {
  const r = spawnSync(process.execPath, [hookFile, '--self-test'], { encoding: 'utf8', timeout: 15_000 });
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
  fix: 'The hook needs Node 22 or later on the PATH Claude Code uses. The settings were not changed.',
});
