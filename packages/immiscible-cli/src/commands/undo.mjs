/**
 * immiscible undo: put files back to the checkpoint the guard took before a
 * coding agent deleted or overwrote them.
 *
 *   immiscible undo                  the checkpoints of the last 7 days, here and wherever the log names
 *   immiscible undo <id>             put one back (shows the change, asks first)
 *   immiscible undo <id> --dry-run   show what would change, write nothing
 *
 * Before it writes anything it takes a checkpoint of how things are now, so
 * the undo can be undone the same way. Only the working tree and the index
 * change: commits, branches and anything outside the repository (a deploy, a
 * publish, a message sent) are left as they are. Files git ignores are not in
 * a checkpoint and are never removed; nor are secret files (.env, keys),
 * which a checkpoint never copies. Nested repositories and submodules are
 * not in a checkpoint either.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { CliError, EXIT, usage } from '../errors.mjs';
import { readDecisions, logDir } from '../history/recorder.mjs';
import { repoRoot, listCheckpoints, findCheckpoint, changesTo, restoreCheckpoint, createCheckpoint, gitIn } from '../history/checkpoint.mjs';

const WEEK = 7 * 86_400_000;
const ago = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const STATUS = { A: 'back', M: 'restored', D: 'removed', T: 'restored' };

/** Every repository a checkpoint may be in: this one, and those the decision log names. */
function repositories(ctx, home) {
  const repos = new Set();
  const here = repoRoot(ctx.dir, ctx.env);
  if (here) repos.add(here);
  for (const d of readDecisions(logDir(home, ctx.env), Date.now() - WEEK).decisions) if (d.checkpoint && typeof d.repo === 'string') repos.add(d.repo);
  return [...repos].filter((r) => repoRoot(r, ctx.env) === r);
}

export async function undo(ctx) {
  const { ui, flags } = ctx;
  const { c } = ui;
  const home = ctx.env.HOME || homedir();
  if ((ctx.rest ?? []).length > 1) throw usage('undo takes one checkpoint at a time');
  const ref = ctx.rest?.[0] ?? null;
  const repos = repositories(ctx, home);

  if (!ref) {
    const seen = new Set();
    const all = repos.flatMap((r) => listCheckpoints(r, ctx.env)).filter((x) => x.at >= Date.now() - WEEK && !seen.has(x.commit) && seen.add(x.commit)).sort((a, b) => b.at - a.at);
    if (ui.json) { ui.writeJson({ ok: true, local: true, checkpoints: all.map(({ id, repo, at, command, parent }) => ({ id, repo, at: new Date(at).toISOString(), command, head: parent })) }); return EXIT.OK; }
    ui.blank();
    ui.out(`  ${c.bold('Checkpoints')} ${c.dim('taken by the guard before a call deleted or overwrote files, kept 7 days')}`);
    ui.blank();
    if (!all.length) {
      ui.note(`  None${repos.length ? '' : ' (this is not a git repository, and the decision log names none)'}. The guard takes one before rm, git clean, git reset --hard and the like: npx immiscible guard`);
      return EXIT.OK;
    }
    for (const x of all.slice(0, 30)) ui.out(`  ${c.bold(x.id)}  ${path.basename(x.repo).padEnd(20).slice(0, 20)} ${c.dim(ago(x.at).padStart(12))}  ${x.command}`);
    ui.blank();
    ui.note(`  Put one back: immiscible undo ${all[0].id}`);
    return EXIT.OK;
  }

  if (ref.length < 4) throw usage('give at least the first 4 characters of the checkpoint id');
  const hits = repos.map((r) => findCheckpoint(r, ref, ctx.env)).filter(Boolean);
  const ambiguous = hits.flatMap((h) => h.ambiguous ?? []);
  const found = hits.filter((h, i) => !h.ambiguous && hits.findIndex((x) => x.commit === h.commit) === i);
  if (ambiguous.length || found.length > 1) throw new CliError(`more than one checkpoint starts ${ref}`, { exit: EXIT.USAGE, code: 'ambiguous', fix: `One of: ${[...ambiguous, ...found.map((h) => h.id)].join(', ')}` });
  if (!found.length) throw new CliError(`no checkpoint ${ref}${repos.length ? '' : ': this is not a git repository and the decision log names none'}`, { exit: EXIT.USAGE, code: 'no_such_checkpoint', fix: 'Run immiscible undo to list them, or run it inside the repository.' });
  const cp = found[0];
  const changes = changesTo(cp.repo, cp, ctx.env);
  if (changes == null) throw new CliError('could not read the working tree', { exit: EXIT.ERROR, code: 'git_failed', fix: `Check that git works in ${cp.repo}.` });
  const head = gitIn(cp.repo, ctx.env)(['rev-parse', '-q', '--verify', 'HEAD']);
  const moved = cp.parent && head && head !== cp.parent ? { from: cp.parent.slice(0, 10), to: head.slice(0, 10) } : null;
  const summary = { id: cp.id, repo: cp.repo, at: new Date(cp.at).toISOString(), command: cp.command, changes, headMoved: moved };

  const show = () => {
    ui.blank();
    ui.out(`  ${c.bold(`Checkpoint ${cp.id}`)} ${c.dim(`in ${cp.repo}, ${ago(cp.at)}, before:`)}`);
    ui.out(`  ${cp.command}`);
    ui.blank();
    if (!changes.length) { ui.note('  The files already match it: nothing to put back.'); return; }
    for (const ch of changes.slice(0, 40)) ui.out(`  ${ch.status === 'D' ? c.red('removed ') : ch.status === 'A' ? c.green('back    ') : c.yellow('restored')} ${ch.path}`);
    if (changes.length > 40) ui.note(`  and ${changes.length - 40} more`);
    if (moved) ui.note(`  Commits made since (${moved.from} to ${moved.to}) are kept; only files and the index change.`);
  };

  if (flags['dry-run'] || !changes.length) {
    if (ui.json) { ui.writeJson({ ok: true, dryRun: Boolean(flags['dry-run']), ...summary }); return EXIT.OK; }
    show();
    return EXIT.OK;
  }
  if (!ui.json) show();
  if (!flags.yes) {
    if (!ui.interactive) throw new CliError('undo changes files and needs a yes', { exit: EXIT.INPUT, code: 'confirmation_required', fix: `Pass --yes to go ahead, or --dry-run to see the change: immiscible undo ${cp.id} --yes` });
    ui.blank();
    if (!(await ui.confirm(`Put ${changes.length} file${changes.length === 1 ? '' : 's'} back as they were?`, { default: true }))) { ui.note('Nothing changed.'); return EXIT.OK; }
  }
  const before = createCheckpoint(cp.repo, `immiscible undo ${cp.id}`, ctx.env);
  if (!before) throw new CliError('could not take a checkpoint of how things are now, so nothing was changed', { exit: EXIT.ERROR, code: 'checkpoint_failed', fix: 'Check that git works here and the disk has room.' });
  let done;
  try { done = restoreCheckpoint(cp.repo, cp, ctx.env); } catch (e) {
    throw new CliError(e.message, { exit: EXIT.ERROR, code: 'restore_failed', fix: `How things were just before is kept: immiscible undo ${before.id}` });
  }
  if (ui.json) { ui.writeJson({ ok: true, ...summary, restored: done, undoWith: before.id }); return EXIT.OK; }
  ui.blank();
  ui.ok(`Put back: ${done.written} written, ${done.removed} removed.`);
  if (done.kept.length) ui.note(`  Left in place, as ignored or secret files: ${done.kept.slice(0, 5).join(', ')}${done.kept.length > 5 ? ` and ${done.kept.length - 5} more` : ''}`);
  ui.note(`  Changed your mind? immiscible undo ${before.id}`);
  return EXIT.OK;
}
