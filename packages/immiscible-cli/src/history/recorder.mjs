/**
 * The flight recorder, on this machine: one timeline per coding-agent
 * session, from two sources that already exist and agree on the session id.
 *
 *   the agents' own history     every tool call, with its time (src/history/readers.mjs)
 *   the guard's decision log    every decision a local hook made, hash-chained
 *                               (~/.immiscible/decisions/*.jsonl, written by the hooks)
 *
 * Commands are shown, because a timeline of a session is what was asked for,
 * with credentials redacted by shape and cut to 300 characters. Prompt text
 * and file contents are never read into it.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { costMicros } from './prices.mjs';
import { redactSecrets } from './secrets.mjs';

/** The hooks name their client; the history readers name their agent. They are the same agents. */
const CLIENT_TO_AGENT = { 'claude-code': 'claude-code', codex: 'codex', 'gemini-cli': 'gemini-cli', cursor: 'cursor', windsurf: 'windsurf' };

export function logDir(home, env = {}) {
  return env.IMMISCIBLE_LOG_DIR ? path.resolve(env.IMMISCIBLE_LOG_DIR) : path.join(home, '.immiscible', 'decisions');
}

/**
 * Every decision logged since `since` (ms), and whether each day's chain
 * holds: { decisions: [...], days: [{ file, entries, ok, brokenAt }] }.
 */
export function readDecisions(dir, since = 0) {
  const out = { decisions: [], days: [] };
  if (!existsSync(dir)) return out;
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  for (const name of readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
    if (name.slice(0, 10) < sinceDay) continue;
    let text = '';
    try { text = readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    let prev = null;
    let brokenAt = null;
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      n++;
      let e;
      try { e = JSON.parse(line); } catch { brokenAt ??= n; continue; }
      if (!e || typeof e !== 'object' || Array.isArray(e)) { brokenAt ??= n; continue; }
      const { hash, ...rest } = e;
      const ok = rest.prev === prev && createHash('sha256').update(JSON.stringify(rest)).digest('hex') === hash;
      if (!ok) brokenAt ??= n;
      prev = hash;
      const at = Date.parse(e.at);
      if (Number.isFinite(at) && at >= since && typeof e.client === 'string') out.decisions.push({ ...e, atMs: at });
    }
    out.days.push({ file: name, entries: n, ok: brokenAt == null, brokenAt });
  }
  return out;
}

const describeCall = (c) => {
  if (c.tool === 'shell') return { kind: 'command', text: c.command ?? '' };
  if (c.tool === 'read') return { kind: 'read', text: c.path ?? '' };
  if (c.tool === 'write') return { kind: 'write', text: c.path ?? '' };
  if (c.tool === 'fetch') return { kind: 'fetch', text: c.url ?? '' };
  if (c.tool === 'search') return { kind: 'search', text: 'web search' };
  if (c.tool === 'mcp') return { kind: 'mcp', text: `MCP server ${c.server ?? 'unknown'}` };
  return { kind: c.tool ?? 'call', text: '' };
};

/**
 * What a decision and a call have in common: the command, path or address. A
 * hook logs "Bash: git push", "Edit: src/a.ts" and the like; the history keeps
 * the bare value. Long commands the hook cut end in " [cut]".
 */
const subjectOf = (c) => (c.tool === 'shell' ? c.command : c.tool === 'read' || c.tool === 'write' ? c.path : c.tool === 'fetch' ? c.url : null);
const subjectOfSummary = (summary) => String(summary ?? '').replace(/^[A-Za-z_][\w-]*: /, '').replace(/ \[cut\]$/, '');
const sameSubject = (call, decided) => {
  if (!call || !decided) return false;
  const a = clean(call).replace(/ ; /g, '; ');
  const b = clean(decided).replace(/ ; /g, '; ');
  return a === b || (b.length >= 40 && a.startsWith(b));
};

const clean = (s) => redactSecrets(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, 300);

const sessionCost = (usage) => {
  let micros = 0;
  let unpriced = false;
  for (const [model, u] of Object.entries(usage ?? {})) {
    const c = costMicros(model, u);
    if (c == null) unpriced = true; else micros += c;
  }
  return { micros, unpriced };
};

/**
 * Sessions with their timelines: [{ key, agent, id, repo, branch, startedAt,
 * endedAt, calls, decisions: { allow, ask, deny }, cost, events: [...] }], newest first.
 * events: { at, kind, text, decision?, rule?, reason? }, in time order. A
 * decision is attached to the call it decided when one matches; a decision
 * with no call in the history (the agent did not run it) stands on its own.
 */
export function buildTimelines(sessions, decisions) {
  const byKey = new Map();
  for (const s of sessions) {
    byKey.set(`${s.agent}:${s.id}`, {
      key: `${s.agent}:${s.id}`, agent: s.agent, id: String(s.id), repo: s.cwd ? path.basename(s.cwd) : 'unknown', branch: s.branch ?? null,
      startedAt: s.startedAt, endedAt: s.endedAt, cost: sessionCost(s.usage),
      events: s.calls.map((c) => ({ at: c.at, ...describeCall(c), text: clean(describeCall(c).text), match: subjectOf(c) })),
    });
  }
  for (const d of decisions) {
    const agent = CLIENT_TO_AGENT[d.client] ?? d.client;
    const key = `${agent}:${d.session}`;
    if (d.decision === 'ran') {
      // The person let an asked call run (an after-call hook said so): mark the ask, add nothing.
      const asked = byKey.get(key)?.events.filter((e) => e.decision === 'ask' && e.ran !== true && sameSubject(e.match ?? subjectOfSummary(e.text), subjectOfSummary(d.summary))).at(-1);
      if (asked) asked.ran = true;
      continue;
    }
    const t = byKey.get(key) ?? { key, agent, id: String(d.session ?? 'unknown'), repo: 'unknown', branch: null, startedAt: d.atMs, endedAt: d.atMs, cost: { micros: 0, unpriced: false }, events: [] };
    byKey.set(key, t);
    // The call this decided: the first undecided call on the same command, path or address, within a minute.
    const hit = t.events.find((e) => !e.decision && sameSubject(e.match, subjectOfSummary(d.summary)) && Math.abs((e.at ?? d.atMs) - d.atMs) < 60_000);
    if (hit) Object.assign(hit, { decision: d.decision, rule: d.rule, reason: d.reason }, d.decision === 'deny' ? { ran: false } : {});
    else t.events.push({ at: d.atMs, kind: 'decision', text: clean(d.summary), decision: d.decision, rule: d.rule, reason: d.reason, ran: false });
    t.startedAt = Math.min(t.startedAt ?? d.atMs, d.atMs);
    t.endedAt = Math.max(t.endedAt ?? d.atMs, d.atMs);
  }
  const out = [...byKey.values()].map((t) => {
    const events = t.events.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map(({ match, ...e }) => e);
    const count = (k) => events.filter((e) => e.decision === k).length;
    return { ...t, events, calls: events.filter((e) => e.kind !== 'decision').length, decisions: { allow: count('allow'), ask: count('ask'), deny: count('deny') } };
  });
  return out.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

/**
 * Take out of the agents' own history the calls the guard refused: an agent
 * writes a tool call to its history before the hook decides, so a refused
 * force push is in the transcript though it never ran. Matched as replay
 * matches (same session, same command, path or address, within a minute).
 * Changes the sessions in place; returns how many calls it took out.
 */
export function dropRefused(sessions, decisions) {
  const byKey = new Map(sessions.map((s) => [`${s.agent}:${s.id}`, s]));
  let n = 0;
  for (const d of decisions) {
    if (d.decision !== 'deny') continue;
    const s = byKey.get(`${CLIENT_TO_AGENT[d.client] ?? d.client}:${d.session}`);
    if (!s || s.source === 'guard') continue;
    const want = subjectOfSummary(d.summary);
    const i = s.calls.findIndex((c) => sameSubject(subjectOf(c), want) && Math.abs((c.at ?? d.atMs) - d.atMs) < 60_000);
    if (i >= 0) { s.calls.splice(i, 1); n++; }
  }
  return n;
}

/** One session by its id or the start of it (at least 4 characters), or by agent:id. */
export function findTimeline(timelines, ref) {
  const r = String(ref ?? '').trim();
  if (r.length < 4) return { error: 'give at least the first 4 characters of the session id' };
  const hits = timelines.filter((t) => t.key === r || t.id === r || t.id.startsWith(r) || t.key.startsWith(r));
  if (!hits.length) return { error: `no session starting ${r} in this window` };
  if (hits.length > 1 && !hits.some((t) => t.id === r)) return { error: `${hits.length} sessions start ${r}; give more of the id`, candidates: hits.slice(0, 5).map((t) => t.key) };
  return { timeline: hits.find((t) => t.id === r) ?? hits[0] };
}
