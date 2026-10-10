/**
 * Undo before approve, the CLI's half. The guard's hooks take a checkpoint of
 * a git working tree before a call that deletes or overwrites files (see
 * lpCheckpoint in scripts/local-policy.mjs): a commit under
 * refs/immiscible/checkpoints/<id> holding every tracked and untracked file
 * that is not ignored and not a secret file, with the index file itself kept
 * as a blob named in its message. This reads them and puts one back.
 *
 * createCheckpoint here takes the same snapshot the hook does (a test checks
 * the two agree), so an undo can itself be undone.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync, unlinkSync, lstatSync, readdirSync, rmdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const REF_PREFIX = 'refs/immiscible/checkpoints/';
const IDENT = { GIT_AUTHOR_NAME: 'immiscible', GIT_AUTHOR_EMAIL: 'checkpoint@immiscible.invalid', GIT_COMMITTER_NAME: 'immiscible', GIT_COMMITTER_EMAIL: 'checkpoint@immiscible.invalid' };

/** The same list as LP_CHECKPOINT_SKIP in the hooks: never copied into a checkpoint, never removed by undo. */
export const CHECKPOINT_SKIP = Object.freeze(['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc', '.pgpass', '.git-credentials', 'credentials.json', 'service-account*.json']);
const SKIP_RX = new RegExp(`^(${CHECKPOINT_SKIP.map((g) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).join('|')})$`);
export const isSkipped = (rel) => SKIP_RX.test(path.posix.basename(rel));

export function gitIn(dir, env = process.env) {
  return (args, extra = {}, { raw = false, input = null } = {}) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, env: { ...env, ...IDENT, ...extra }, input: input ?? undefined, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (r.status !== 0) return null;
    return raw ? r.stdout : r.stdout.trim();
  };
}

export const repoRoot = (dir, env) => (dir && existsSync(dir) ? gitIn(dir, env)(['rev-parse', '--show-toplevel']) : null);

const indexPath = (git) => git(['rev-parse', '--path-format=absolute', '--git-path', 'index']);

/** The working tree as a tree object (tracked and untracked, not ignored, no secret files), written without touching the real index. */
export function worktreeTree(root, env) {
  const git = gitIn(root, env);
  const indexFile = indexPath(git);
  const tmp = path.join(tmpdir(), `immiscible-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    if (indexFile && existsSync(indexFile)) copyFileSync(indexFile, tmp);
    if (git(['add', '-A', '--', ':/', ...CHECKPOINT_SKIP.map((g) => `:(exclude,glob)**/${g}`)], { GIT_INDEX_FILE: tmp }) == null) return null;
    return git(['write-tree'], { GIT_INDEX_FILE: tmp });
  } finally { rmSync(tmp, { force: true }); }
}

/** A checkpoint of the tree as it is now: { id, repo } or null. The same shape the hooks write. */
export function createCheckpoint(root, label, env) {
  const git = gitIn(root, env);
  const tree = worktreeTree(root, env);
  if (!tree) return null;
  const indexFile = indexPath(git);
  const indexBlob = indexFile && existsSync(indexFile) ? git(['hash-object', '-w', '--', indexFile]) : null;
  const head = git(['rev-parse', '-q', '--verify', 'HEAD']);
  const message = `immiscible checkpoint\n\ncommand: ${label}\nworktree: ${root}\n${indexBlob ? `index-file: ${indexBlob}\n` : ''}`;
  const commit = git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message]);
  if (!commit) return null;
  const id = commit.slice(0, 10);
  return git(['update-ref', `${REF_PREFIX}${id}`, commit]) == null ? null : { id, repo: root };
}

/**
 * The checkpoints taken in this working tree, newest first:
 * [{ id, repo, commit, at, parent, command, tree, indexFile, index }]. Linked
 * worktrees share refs, so each keeps only its own.
 */
export function listCheckpoints(root, env) {
  const git = gitIn(root, env);
  const out = git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)\u001f%(objectname)\u001f%(committerdate:unix)\u001f%(parent)', REF_PREFIX]);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => {
    const [ref, commit, at, parent] = l.split('\u001f');
    const body = git(['cat-file', 'commit', commit]) ?? '';
    return {
      id: ref.slice(REF_PREFIX.length), repo: root, commit, at: Number(at) * 1000, parent: parent || null,
      tree: /^tree ([0-9a-f]+)$/m.exec(body)?.[1] ?? null,
      command: /^command: (.*)$/m.exec(body)?.[1] ?? '',
      worktree: /^worktree: (.*)$/m.exec(body)?.[1] ?? null,
      indexFile: /^index-file: ([0-9a-f]+)$/m.exec(body)?.[1] ?? null,
      index: /^index: ([0-9a-f]+)$/m.exec(body)?.[1] ?? null,
    };
  }).filter((c) => !c.worktree || path.resolve(c.worktree) === path.resolve(root));
}

/** One checkpoint by its id or the start of it: the checkpoint, { ambiguous: [ids] }, or null. */
export function findCheckpoint(root, ref, env) {
  const all = listCheckpoints(root, env);
  const hits = all.filter((c) => c.id === ref || c.id.startsWith(ref) || c.commit.startsWith(ref));
  return hits.length === 1 ? hits[0] : hits.find((c) => c.id === ref) ?? (hits.length ? { ambiguous: hits.map((c) => c.id) } : null);
}

/** What putting a checkpoint back would change: [{ status: 'A'|'M'|'D'|'T', path }], relative to the repository; null when git could not say. */
export function changesTo(root, cp, env) {
  const now = worktreeTree(root, env);
  if (!now) return null;
  if (now === cp.tree) return [];
  const out = gitIn(root, env)(['diff-tree', '-r', '-z', '--no-renames', '--name-status', now, cp.tree], {}, { raw: true });
  if (out == null) return null;
  const parts = out.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i][0], path: parts[i + 1] });
  return changes;
}

/**
 * Put a checkpoint back: the files it holds are written as they were, files
 * made since are removed unless git ignores them (by the checkpoint's own
 * .gitignore) or they are secret files, and the index file is restored. HEAD
 * and branches are left where they are. Returns { removed, written, kept }.
 */
export function restoreCheckpoint(root, cp, env) {
  const git = gitIn(root, env);
  const base = path.resolve(root);
  const inside = (rel) => {
    const abs = path.resolve(base, rel);
    return abs.startsWith(`${base}${path.sep}`) ? abs : null;
  };
  const changes = changesTo(root, cp, env);
  if (changes == null) throw new Error('could not compare the working tree with the checkpoint');
  const writes = changes.filter((c) => c.status !== 'D').map((c) => c.path);

  // 1. Write back the checkpoint's version of each changed file, and only those (a sparse checkout stays sparse).
  if (writes.length) {
    const tmp = path.join(tmpdir(), `immiscible-restore-${process.pid}-${Date.now()}`);
    try {
      if (git(['read-tree', cp.tree], { GIT_INDEX_FILE: tmp }) == null) throw new Error('could not read the checkpoint');
      // A file where the checkpoint has a directory, or the reverse, is cleared first so checkout-index can write.
      for (const rel of writes) clearBlocking(inside(rel), base);
      if (git(['checkout-index', '-f', '-z', '--stdin'], { GIT_INDEX_FILE: tmp }, { input: `${writes.join('\0')}\0` }) == null) throw new Error('could not write the files back');
    } finally { rmSync(tmp, { force: true }); }
  }

  // 2. Remove what was made since, now that the checkpoint's .gitignore is back: never an ignored file, never a secret file.
  const made = changes.filter((c) => c.status === 'D').map((c) => c.path);
  const ignored = new Set(made.length ? (git(['check-ignore', '--no-index', '-z', '--stdin'], {}, { raw: true, input: `${made.join('\0')}\0` }) ?? '').split('\0').filter(Boolean) : []);
  let removed = 0;
  const kept = [];
  for (const rel of made) {
    const abs = inside(rel);
    if (!abs || ignored.has(rel) || isSkipped(rel)) { kept.push(rel); continue; }
    try { unlinkSync(abs); removed++; } catch { /* already gone */ }
    pruneEmpty(path.dirname(abs), base);
  }

  // 3. The index as it was: the saved index file when there is one (staged work, conflicts, sparse bits), else its tree.
  const indexFile = indexPath(git);
  if (cp.indexFile && indexFile) {
    const bytes = spawnSync('git', ['-C', root, 'cat-file', 'blob', cp.indexFile], { env, maxBuffer: 256 * 1024 * 1024 });
    if (bytes.status !== 0) throw new Error('the files are back, but the saved index could not be read');
    const lock = `${indexFile}.lock`;
    try { writeFileSync(lock, bytes.stdout, { flag: 'wx' }); } catch {
      throw new Error('the files are back, but git is busy (index.lock exists), so the index was left as it is');
    }
    renameSync(lock, indexFile);
  } else if (cp.index) {
    if (git(['read-tree', cp.index]) == null) throw new Error('the files are back, but the index could not be restored');
  }
  git(['update-index', '-q', '--refresh']);
  return { removed, written: writes.length, kept };
}

function pruneEmpty(dir, base) {
  while (dir.startsWith(`${base}${path.sep}`)) {
    try { if (readdirSync(dir).length) return; rmdirSync(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}

function clearBlocking(abs, base) {
  if (!abs) return;
  // Walk up: a file where the checkpoint has a directory blocks every path below it.
  for (let p = path.dirname(abs); p.startsWith(`${base}${path.sep}`); p = path.dirname(p)) {
    try { if (!lstatSync(p).isDirectory()) { unlinkSync(p); return; } } catch { /* missing is fine */ }
  }
  try { if (lstatSync(abs).isDirectory() && !readdirSync(abs).length) rmdirSync(abs); } catch { /* missing is fine */ }
}
