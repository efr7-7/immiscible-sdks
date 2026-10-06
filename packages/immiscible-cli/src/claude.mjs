/**
 * The Claude Code hook, installed into a project:
 *
 *   .claude/hooks/immiscible-claude-code-hook.mjs   a copy of hook/claude-code-hook.mjs (the repository's
 *                                                    scripts/claude-code-hook.mjs; the same bytes a server
 *                                                    serves at /downloads/claude-code-hook.mjs)
 *   .claude/settings.json                            one PreToolUse entry:
 *
 *     { "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__.*",
 *       "hooks": [ { "type": "command", "timeout": 60,
 *                    "command": "node --env-file-if-exists=\"$CLAUDE_PROJECT_DIR/.env\" \"$CLAUDE_PROJECT_DIR/.claude/hooks/immiscible-claude-code-hook.mjs\" || exit 2" } ] }
 *
 * The hook reads IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY from the project's
 * .env (Node's --env-file-if-exists; a variable already in the environment
 * wins). It fails closed, and `|| exit 2` makes a missing file, a missing
 * node or a crash block the call too: Claude Code blocks only on exit 2.
 *
 * Merging never removes anything of yours: other hooks, other PreToolUse
 * entries and every other setting stay as they are. An older Immiscible
 * entry (found by its command) is replaced in place, so running init twice
 * leaves exactly one.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__.*';
export const HOOK_FILE = 'immiscible-claude-code-hook.mjs';
export const HOOK_TIMEOUT = 60;
export const BUNDLED_HOOK = fileURLToPath(new URL('../hook/claude-code-hook.mjs', import.meta.url));
export const HOOK_COMMAND = `node --env-file-if-exists="$CLAUDE_PROJECT_DIR/.env" "$CLAUDE_PROJECT_DIR/.claude/hooks/${HOOK_FILE}" || exit 2`;

/** Is this hook command one of ours (this CLI's, the package's, or the curl-installed script)? */
export const isOurs = (cmd) => typeof cmd === 'string' && /immiscible[-_/\\.a-z]*hook/i.test(cmd);

export function entry() {
  return { matcher: MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT }] };
}

function indentOf(text) {
  const m = /^[ \t]+(?=")/m.exec(text ?? '');
  return m ? m[0] : '  ';
}

/**
 * The settings with our entry in place. Returns { before, after, changed,
 * state: 'added' | 'updated' | 'unchanged', error }. Never throws for a
 * file it cannot parse: error says why, and nothing is changed.
 */
export function planSettings(file) {
  const exists = existsSync(file);
  const before = exists ? readFileSync(file, 'utf8') : '';
  let settings = {};
  if (exists && before.trim()) {
    try {
      settings = JSON.parse(before);
    } catch (err) {
      return { before, after: before, changed: false, state: 'unparseable', error: `${path.basename(file)} is not valid JSON (${err.message}); add the entry by hand` };
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { before, after: before, changed: false, state: 'unparseable', error: `${path.basename(file)} is not a JSON object` };
  }
  const next = structuredClone(settings);
  next.hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks) ? next.hooks : {};
  const list = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];
  const want = entry();
  let state = 'added';
  let placed = false;
  const kept = [];
  for (const e of list) {
    const hooks = Array.isArray(e?.hooks) ? e.hooks : [];
    if (!hooks.some((h) => isOurs(h?.command))) { kept.push(e); continue; }
    // An entry of ours: the first becomes exactly the wanted entry, keeping
    // any other hooks the person added beside it; later duplicates go.
    const others = hooks.filter((h) => !isOurs(h?.command));
    if (placed) {
      if (others.length) kept.push({ ...e, hooks: others });
      continue;
    }
    placed = true;
    const replacement = others.length ? { ...want, hooks: [...want.hooks, ...others] } : want;
    state = JSON.stringify(e) === JSON.stringify(replacement) ? 'unchanged' : 'updated';
    kept.push(replacement);
  }
  if (!placed) kept.push(want);
  next.hooks.PreToolUse = kept;
  // Semantically the same file is left byte for byte as it is.
  if (exists && JSON.stringify(next) === JSON.stringify(settings)) return { before, after: before, changed: false, state: 'unchanged', error: null };
  const after = `${JSON.stringify(next, null, indentOf(before))}\n`;
  return { before, after, changed: true, state: state === 'unchanged' ? 'updated' : state, error: null };
}

/** Write the hook file (when missing or different) and the settings. */
export function installHook(dir, plan) {
  const hooksDir = path.join(dir, '.claude', 'hooks');
  const target = path.join(hooksDir, HOOK_FILE);
  mkdirSync(hooksDir, { recursive: true });
  const fresh = readFileSync(BUNDLED_HOOK);
  let fileState = 'unchanged';
  if (!existsSync(target)) fileState = 'added';
  else if (!readFileSync(target).equals(fresh)) fileState = 'updated';
  if (fileState !== 'unchanged') copyFileSync(BUNDLED_HOOK, target);
  if (plan.changed) writeFileSync(path.join(dir, '.claude', 'settings.json'), plan.after);
  return { hookFile: target, fileState };
}

/** What a hook installed in this project looks like now, for doctor. */
export function inspectHook(dir) {
  const file = path.join(dir, '.claude', 'settings.json');
  const local = path.join(dir, '.claude', 'settings.local.json');
  const found = [];
  for (const f of [file, local]) {
    if (!existsSync(f)) continue;
    let s;
    try { s = JSON.parse(readFileSync(f, 'utf8')); } catch { found.push({ file: f, error: 'not valid JSON' }); continue; }
    for (const e of s?.hooks?.PreToolUse ?? []) {
      for (const h of e?.hooks ?? []) if (isOurs(h?.command)) found.push({ file: f, matcher: e.matcher ?? '', command: h.command, timeout: h.timeout ?? null });
    }
  }
  const hookFile = path.join(dir, '.claude', 'hooks', HOOK_FILE);
  const hookExists = existsSync(hookFile);
  const current = hookExists ? readFileSync(hookFile).equals(readFileSync(BUNDLED_HOOK)) : null;
  return { entries: found, hookFile, hookExists, current };
}

// ------------------------------------------------------------------ diff

/** A line diff (LCS), as unified-style lines: "  same", "- gone", "+ new". */
export function diffLines(a, b) {
  const x = a ? a.replace(/\n$/, '').split('\n') : [];
  const y = b.replace(/\n$/, '').split('\n');
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < n) out.push(`- ${x[i++]}`);
  while (j < m) out.push(`+ ${y[j++]}`);
  return out;
}

/** Only the changed lines and three lines of context around them. */
export function compactDiff(lines, context = 3) {
  const keep = new Set();
  lines.forEach((l, i) => {
    if (!l.startsWith('  ')) for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep.add(k);
  });
  const out = [];
  let last = -1;
  for (const i of [...keep].sort((p, q) => p - q)) {
    if (i > last + 1) out.push('  ...');
    out.push(lines[i]);
    last = i;
  }
  if (last !== -1 && last < lines.length - 1) out.push('  ...');
  return out;
}
