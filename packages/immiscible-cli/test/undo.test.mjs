/**
 * Undo before approve: the guard's hook takes a checkpoint before a call that
 * deletes or overwrites files, and immiscible undo puts the files back exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, tmp } from './helpers.mjs';
import { createCheckpoint, listCheckpoints, worktreeTree, REF_PREFIX } from '../src/history/checkpoint.mjs';

const HOOK = fileURLToPath(new URL('../hook/claude-code-hook.mjs', import.meta.url));
const AGENT_HOOK = fileURLToPath(new URL('../hook/coding-agent-hook.mjs', import.meta.url));
const ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' };

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...ENV, HOME: cwd, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Every file under root but .git, with its bytes and mode: "exactly" means this is equal. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = `${(statSync(p).mode & 0o777).toString(8)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}

function repo() {
  const home = tmp('imm-undo-');
  const root = path.join(home, 'work', 'app');
  mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(root, 'src', 'index.js'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'src', 'lib', 'util.js'), 'export const b = 2;\n');
  writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(path.join(root, 'run.sh'), 0o755);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  // Work not yet committed: one change staged, one not, one file git has never seen.
  writeFileSync(path.join(root, 'src', 'index.js'), 'export const a = 42;\n');
  git(root, 'add', 'src/index.js');
  writeFileSync(path.join(root, 'src', 'lib', 'util.js'), 'export const b = 3; // unstaged\n');
  writeFileSync(path.join(root, 'notes.md'), 'draft, never committed\n');
  mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'x', 'i.js'), 'ignored\n');
  return { home, root };
}

const hookEnv = (home, extra = {}) => ({ ...ENV, HOME: home, IMMISCIBLE_MODE: 'local', IMMISCIBLE_STATE_DIR: path.join(home, 'state'), ...extra });
function claude(home, cwd, command, tool = 'Bash', input = { command }) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-undo-1', tool_name: tool, tool_input: input, cwd }), encoding: 'utf8', env: hookEnv(home) });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : { permissionDecision: 'allow' };
}

test('undo: a checkpoint before rm -rf puts every file back exactly, the index too, and the undo can be undone', async () => {
  const { home, root } = repo();
  const before = snapshot(root);
  const status = git(root, 'status', '--porcelain');

  assert.equal(claude(home, root, 'rm -rf src notes.md').permissionDecision, 'allow');
  const [cp] = listCheckpoints(root, ENV);
  assert.ok(cp, 'a checkpoint was taken');
  assert.match(cp.command, /^Bash: rm -rf src notes\.md$/);
  const log = readFileSync(path.join(home, '.immiscible', 'decisions', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  assert.match(log, new RegExp(`"checkpoint":"${cp.id}"`));

  // The agent runs it, and goes on to make a file.
  rmSync(path.join(root, 'src'), { recursive: true });
  rmSync(path.join(root, 'notes.md'));
  writeFileSync(path.join(root, 'new.txt'), 'made after\n');

  const list = await runCli(['undo'], { cwd: root, home });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`${cp.id} +app .*Bash: rm -rf src notes\\.md`));

  const dry = await runCli(['undo', cp.id.slice(0, 6), '--dry-run', '--json'], { cwd: root, home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(dry.json.changes.map((c) => `${c.status} ${c.path}`).sort(), ['A notes.md', 'A src/index.js', 'A src/lib/util.js', 'D new.txt']);
  assert.ok(existsSync(path.join(root, 'new.txt')), 'a dry run writes nothing');

  const no = await runCli(['undo', cp.id], { cwd: root, home });
  assert.equal(no.code, 4, 'not a terminal: a yes is needed');

  const r = await runCli(['undo', cp.id, '--yes', '--json'], { cwd: root, home });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.restored, { written: 3, removed: 1, kept: [] });
  assert.deepEqual(snapshot(root), before, 'every file back, byte for byte and mode for mode; ignored files untouched');
  assert.equal(git(root, 'status', '--porcelain'), status, 'the index as it was: staged stays staged, unstaged stays unstaged');

  // And back again.
  const again = await runCli(['undo', r.json.undoWith, '--yes'], { cwd: root, home });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(existsSync(path.join(root, 'new.txt')) && !existsSync(path.join(root, 'src')));
});

test('undo: checkpoints never reach a remote, expire after 7 days, and the CLI takes the same snapshot as the hook', () => {
  const { home, root } = repo();
  const remote = path.join(home, 'remote.git');
  git(home, 'init', '-q', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  claude(home, root, 'git clean -fd');
  claude(home, root, 'git reset --hard');
  assert.equal(listCheckpoints(root, ENV).length, 2);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'push', '-q', '--tags', 'origin');
  git(root, 'push', '-q', '--all', 'origin');
  assert.equal(git(remote, 'for-each-ref', REF_PREFIX), '', 'nothing under refs/immiscible on the remote');

  // The hook's snapshot and the CLI's agree on the tree.
  const [hookCp] = listCheckpoints(root, ENV);
  assert.equal(worktreeTree(root, ENV), hookCp.tree);
  assert.equal(createCheckpoint(root, 'x', ENV).repo, root);

  // An old checkpoint is deleted when the next one is taken.
  const stale = spawnSync('git', ['commit-tree', hookCp.tree, '-m', 'immiscible checkpoint\n\ncommand: old\n'], { cwd: root, encoding: 'utf8', env: { ...ENV, GIT_AUTHOR_NAME: 'i', GIT_AUTHOR_EMAIL: 'i@i', GIT_COMMITTER_NAME: 'i', GIT_COMMITTER_EMAIL: 'i@i', GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) - 8 * 86400} +0000` } }).stdout.trim();
  git(root, 'update-ref', `${REF_PREFIX}stale00000`, stale);
  assert.ok(listCheckpoints(root, ENV).some((c) => c.id === 'stale00000'));
  claude(home, root, 'rm notes.md');
  assert.ok(!listCheckpoints(root, ENV).some((c) => c.id === 'stale00000'), 'expired');
});

test('undo before approve: the question names the checkpoint; a call past the machine says it cannot be undone', () => {
  const { home, root } = repo();
  const reset = claude(home, root, 'git reset --hard origin/main');
  assert.equal(reset.permissionDecision, 'ask');
  const id = listCheckpoints(root, ENV)[0]?.id;
  assert.ok(id);
  assert.match(reset.permissionDecisionReason, new RegExp(`If you approve, it can be undone: npx immiscible undo ${id}`));
  const publish = claude(home, root, 'npm publish --access public');
  assert.equal(publish.permissionDecision, 'ask');
  assert.match(publish.permissionDecisionReason, /This one cannot be undone from here\./);
  assert.equal(listCheckpoints(root, ENV).length, 1, 'no checkpoint for a publish');

  // An edit to agent configuration inside the repository is checkpointed in that repository.
  mkdirSync(path.join(root, '.claude'));
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{}\n');
  const edit = claude(home, home, null, 'Edit', { file_path: path.join(root, '.claude', 'settings.json'), old_string: '{}', new_string: '{"x":1}' });
  assert.equal(edit.permissionDecision, 'ask');
  assert.match(edit.permissionDecisionReason, /it can be undone: npx immiscible undo/);

  // Outside a repository there is nothing to checkpoint, and the hook says so.
  const loose = tmp('imm-undo-loose-');
  const outside = claude(home, loose, 'git clean -fdx');
  assert.equal(outside.permissionDecision, 'ask');
  assert.match(outside.permissionDecisionReason, /cannot be undone from here/);
});

test('undo: Codex cannot ask, so a refused call takes no checkpoint; an allowed rm does', () => {
  const { home, root } = repo();
  const codex = (command) => spawnSync(process.execPath, [AGENT_HOOK, '--agent', 'codex'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'cx-1', tool_name: 'Bash', tool_input: { command }, cwd: root }), encoding: 'utf8', env: hookEnv(home) });
  const refused = codex('git reset --hard origin/main');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /throwing away work/);
  assert.equal(listCheckpoints(root, ENV).length, 0);
  const rm = codex('rm -r src/lib');
  assert.equal(rm.status, 0, rm.stderr);
  assert.equal(listCheckpoints(root, ENV).length, 1);
});

test('undo: usage errors and an empty list', async () => {
  const { home, root } = repo();
  const none = await runCli(['undo'], { cwd: root, home });
  assert.equal(none.code, 0);
  assert.match(none.stdout, /None\. The guard takes one before rm/);
  assert.equal((await runCli(['undo', 'abc'], { cwd: root, home })).code, 2);
  const missing = await runCli(['undo', 'ffffffff'], { cwd: root, home });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no checkpoint ffffffff/i);
});

test('undo never removes a file git ignored when the checkpoint was taken, nor a secret file', async () => {
  const { home, root } = repo();
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.env\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-q', '-m', 'ignore .env');
  writeFileSync(path.join(root, '.env'), 'API=1\n');
  claude(home, root, 'rm .gitignore');
  const [cp] = listCheckpoints(root, ENV);
  rmSync(path.join(root, '.gitignore'));
  const r = await runCli(['undo', cp.id, '--yes', '--json'], { cwd: root, home });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(root, '.gitignore')), 'the deleted file is back');
  assert.ok(existsSync(path.join(root, '.env')), '.env is left alone');
  assert.ok(existsSync(path.join(root, 'node_modules', 'x', 'i.js')), 'ignored files are left alone');
});

test('a checkpoint never copies an untracked secret file, so no push, mirror or not, can carry one', () => {
  const { home, root } = repo();
  const secret = ['sk', 'live', 'NOTREAL', 'x'.repeat(24)].join('_');
  writeFileSync(path.join(root, '.env.production.local'), `STRIPE=${secret}\n`);
  claude(home, root, 'rm -rf src');
  const [cp] = listCheckpoints(root, ENV);
  assert.ok(cp);
  const files = git(root, 'ls-tree', '-r', '--name-only', cp.tree).split('\n');
  assert.ok(!files.includes('.env.production.local'));
  assert.ok(files.includes('notes.md'), 'other untracked files are kept');
  const remote = path.join(home, 'mirror.git');
  git(home, 'init', '-q', '--bare', remote);
  git(root, 'push', '-q', '--mirror', remote);
  assert.equal(spawnSync('git', ['-C', remote, 'grep', '-q', secret, ...git(remote, 'for-each-ref', '--format=%(objectname)').split('\n')], { encoding: 'utf8' }).status, 1, 'the secret is nowhere on the remote');
});

test('undo during a merge puts the conflicted index back as it was', async () => {
  const { home, root } = repo();
  git(root, 'stash', '-q', '-u');
  git(root, 'checkout', '-q', '-b', 'other');
  writeFileSync(path.join(root, 'src', 'index.js'), 'export const a = "other";\n');
  git(root, 'commit', '-q', '-am', 'other');
  git(root, 'checkout', '-q', 'main');
  writeFileSync(path.join(root, 'src', 'index.js'), 'export const a = "main";\n');
  git(root, 'commit', '-q', '-am', 'main');
  spawnSync('git', ['merge', 'other'], { cwd: root, env: { ...ENV, HOME: root, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  writeFileSync(path.join(root, 'scratch.txt'), 'untracked\n');
  const status = git(root, 'status', '--porcelain');
  assert.match(status, /^UU src\/index\.js$/m);
  claude(home, root, 'rm scratch.txt src/lib/util.js');
  const [cp] = listCheckpoints(root, ENV);
  rmSync(path.join(root, 'scratch.txt'));
  rmSync(path.join(root, 'src', 'lib', 'util.js'));
  const r = await runCli(['undo', cp.id, '--yes'], { cwd: root, home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(git(root, 'status', '--porcelain'), status, 'still conflicted, nothing untracked staged');
});

test('linked worktrees keep their own checkpoints', async () => {
  const { home, root } = repo();
  git(root, 'stash', '-q', '-u');
  const wt = path.join(home, 'work', 'app-wt');
  git(root, 'worktree', 'add', '-q', wt);
  writeFileSync(path.join(wt, 'wip.txt'), 'work in the other tree\n');
  claude(home, root, 'rm -rf src');
  assert.equal(listCheckpoints(root, ENV).length, 1);
  assert.equal(listCheckpoints(wt, ENV).length, 0, 'the main tree\'s checkpoint is not offered in the other');
  const list = await runCli(['undo', '--json'], { cwd: wt, home });
  assert.equal(list.json.checkpoints.filter((c) => c.repo === wt).length, 0);
  assert.equal(new Set(list.json.checkpoints.map((c) => c.id)).size, list.json.checkpoints.length, 'listed once');
});

test('the question says plainly when a checkpoint cannot cover the call', () => {
  const { home, root } = repo();
  assert.match(claude(home, root, 'git clean -fdx').permissionDecisionReason, /cannot be undone from here/, 'ignored files are never in a checkpoint');
  assert.match(claude(home, root, 'sudo rm -rf ../other').permissionDecisionReason, /cannot be undone from here/, 'outside the repository');
  assert.match(claude(home, root, 'sudo rm -rf build').permissionDecisionReason, /it can be undone: npx immiscible undo/, 'a destructive command that is also asked is checkpointed');
  assert.equal(claude(home, root, 'rm -rf ~/.immiscible').permissionDecision, 'ask', "the guard's own records are asked about");
});
