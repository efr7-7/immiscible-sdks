/**
 * .env files: read them the way dotenv and Node's --env-file do, and add
 * entries without touching anything already there. An existing value is
 * never replaced unless the caller names it in `replace`.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/;

function unquote(v) {
  const s = String(v ?? '').trim();
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end > 0) return s.slice(1, end);
  }
  return s.replace(/\s+#.*$/, '');
}

export function parseEnv(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m && !line.trim().startsWith('#')) values[m[1]] = unquote(m[2]);
  }
  return values;
}

export function readEnvFile(file) {
  if (!existsSync(file)) return { exists: false, text: '', values: {} };
  const text = readFileSync(file, 'utf8');
  return { exists: true, text, values: parseEnv(text) };
}

const quoteIfNeeded = (v) => (/[\s#"'$`\\]/.test(v) ? `"${v.replace(/(["\\$`])/g, '\\$1')}"` : v);

/**
 * Plan the change: { added, kept, conflicts, replaced, text }. `entries` is
 * { NAME: value }. A name already set to the same value is kept; to a
 * different value, it is a conflict and left alone, unless it is in
 * `replace`.
 */
export function planEnv(current, entries, { replace = [] } = {}) {
  const values = parseEnv(current);
  const added = [];
  const kept = [];
  const conflicts = [];
  const replaced = [];
  let lines = current ? current.replace(/\s*$/, '').split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(entries)) {
    if (!(k in values)) { added.push(k); continue; }
    if (values[k] === v) { kept.push(k); continue; }
    if (replace.includes(k)) {
      replaced.push(k);
      lines = lines.map((l) => {
        const m = LINE.exec(l);
        return m && m[1] === k && !l.trim().startsWith('#') ? `${k}=${quoteIfNeeded(v)}` : l;
      });
      continue;
    }
    conflicts.push({ name: k, current: values[k], wanted: v });
  }
  if (added.length) {
    if (lines.length && lines.at(-1).trim() !== '') lines.push('');
    lines.push('# Immiscible: decisions before this agent pays, shares data or acts (immiscible init)');
    for (const k of added) lines.push(`${k}=${quoteIfNeeded(entries[k])}`);
  }
  const text = lines.length ? `${lines.join('\n')}\n` : '';
  return { added, kept, conflicts, replaced, text, changed: added.length + replaced.length > 0 };
}

export function writeEnv(file, plan) {
  if (plan.changed) writeFileSync(file, plan.text, { mode: 0o600 });
}

/** Whether .gitignore (if there is one) keeps .env out of git. null when there is no .gitignore. */
export function envIgnored(gitignoreText) {
  if (gitignoreText == null) return null;
  const rules = gitignoreText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let ignored = false;
  for (const r of rules) {
    const neg = r.startsWith('!');
    const p = (neg ? r.slice(1) : r).replace(/^\//, '');
    if (['.env', '.env*', '*.env', '**/.env', '**/.env*'].includes(p)) ignored = !neg;
  }
  return ignored;
}
