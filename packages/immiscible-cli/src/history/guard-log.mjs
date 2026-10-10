/**
 * The guard's own decision log (~/.immiscible/decisions, written by the local
 * hooks; recorder.mjs reads and verifies it) as a source for `scan`:
 *
 *   guardSummary     what the hooks decided in the window: refused, asked and
 *                    allowed, by agent and by rule, and any day whose hash chain
 *                    does not verify
 *   guardSessions    sessions for the agents whose own history scan cannot read
 *                    (Factory Droid, opencode, Amp, Cursor, Windsurf), built from
 *                    the calls their hooks let through, so their commands, files
 *                    and domains are counted like everyone else's
 *
 * A refused call did not run, so it is never counted as something an agent
 * did. For the agents that ask at the keyboard (Cursor, Factory Droid), each
 * ask is logged as answerable and the after-call hook logs "ran" when the
 * person let it run, so an answerable ask with no "ran" was declined; an ask
 * logged before those hooks existed is counted as run. The others turn an ask into a
 * refusal, so it is not counted. The log holds no token counts, so these
 * sessions are not priced, and say so.
 */

/** The agents scan reads only through the guard's log, by the name their hook logs them under. */
export const LOGGED_ONLY = Object.freeze(['factory-droid', 'opencode', 'amp', 'cursor', 'windsurf']);
const ASKS_AT_KEYBOARD = new Set(['cursor', 'factory-droid', 'claude-code']);

const firstUrl = (s) => /\bhttps?:\/\/[^\s'"<>|;)]+/i.exec(String(s ?? ''))?.[0] ?? null;

/**
 * One logged summary ("Bash: git push", "Edit: src/a.ts", "WebFetch: https://...",
 * "mcp__github__create_issue: {...}") as the history readers' call shape, or null.
 */
export function callFromSummary(summary, at) {
  const m = /^([A-Za-z_][\w.-]*): ?([\s\S]*)$/.exec(String(summary ?? ''));
  if (!m) return null;
  const [, tool, raw] = m;
  const rest = raw.replace(/ \[cut\]$/, '');
  if (tool === 'Bash') return rest ? { at, tool: 'shell', command: rest } : null;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return { at, tool: 'write', path: rest || null };
  if (tool === 'Read') return { at, tool: 'read', path: rest || null };
  if (tool === 'WebFetch') return { at, tool: 'fetch', url: firstUrl(rest) };
  if (tool.startsWith('mcp__')) return { at, tool: 'mcp', server: tool.split('__')[1] || 'unknown' };
  if (FETCH_TOOLS.has(tool)) return { at, tool: 'fetch', url: firstUrl(rest) };
  if (SEARCH_TOOLS.has(tool)) return { at, tool: 'search' };
  // Anything else (a settings change, an agent's own tool, opencode's <server>_<tool> MCP calls) is not
  // counted: an address inside its arguments is not one the agent reached.
  return null;
}

/** The agents' own fetch and search tools, as their hooks log them by name. */
const FETCH_TOOLS = new Set(['read_web_page', 'webfetch', 'web_fetch', 'FetchUrl']);
const SEARCH_TOOLS = new Set(['web_search', 'websearch', 'codesearch', 'WebSearch', 'google_web_search']);

/** Sessions, in readers.mjs's shape, for agents scan only sees through the guard's log. */
export function guardSessions(decisions, { agents = LOGGED_ONLY } = {}) {
  const only = new Set(agents);
  const sessions = new Map();
  // An ask logged with after: true came from a hook whose after-call hook logs "ran" when the person let it
  // run (Cursor and Droid, from 0.3.0): with no "ran" it was declined. An ask without the mark is counted as run.
  const ranLeft = new Map();
  for (const d of decisions) if (d.decision === 'ran') { const k = `${d.client}|${d.session}|${d.summary}`; ranLeft.set(k, (ranLeft.get(k) ?? 0) + 1); }
  const answeredYes = (d) => {
    if (d.after !== true) return true;
    const k = `${d.client}|${d.session}|${d.summary}`;
    const n = ranLeft.get(k) ?? 0;
    if (!n) return false;
    ranLeft.set(k, n - 1);
    return true;
  };
  for (const d of decisions) {
    if (!only.has(d.client) || d.decision === 'ran') continue;
    const id = String(d.session ?? `${d.client}-${String(d.at).slice(0, 10)}`);
    const key = `${d.client}:${id}`;
    const s = sessions.get(key) ?? { agent: d.client, id, file: null, cwd: null, branch: null, startedAt: null, endedAt: null, modes: [], calls: [], usage: {}, source: 'guard', costUnknown: true };
    sessions.set(key, s);
    if (s.startedAt == null || d.atMs < s.startedAt) s.startedAt = d.atMs;
    if (s.endedAt == null || d.atMs > s.endedAt) s.endedAt = d.atMs;
    if (typeof d.dir === 'string' && d.dir) s.cwd ??= d.dir;
    else if (typeof d.repo === 'string' && d.repo) s.cwd ??= d.repo;
    const ran = d.decision === 'allow' || (d.decision === 'ask' && ASKS_AT_KEYBOARD.has(d.client) && answeredYes(d));
    if (!ran) continue;
    const c = callFromSummary(d.summary, d.atMs);
    if (c) s.calls.push(c);
  }
  return [...sessions.values()];
}

/**
 * What the guard decided in the window: { total, allow, ask, deny,
 * byAgent: [{ agent, allow, ask, deny }], rules: [{ rule, decision, count }],
 * settings, brokenDays: [{ day, line }] }, or null when the log holds nothing in it.
 * A settings change kept out of a session (Claude Code's ConfigChange) is
 * counted as `settings`, not as a refused call.
 */
export function guardSummary({ decisions = [], days = [] } = {}, since = 0) {
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  const brokenDays = days.filter((d) => !d.ok && d.file.slice(0, 10) >= sinceDay).map((d) => ({ day: d.file.slice(0, 10), line: d.brokenAt }));
  if (!decisions.length && !brokenDays.length) return null;
  const count = { allow: 0, ask: 0, deny: 0 };
  let settings = 0;
  let paused = 0;
  const byAgent = new Map();
  const rules = new Map();
  for (const d of decisions) {
    if (!Object.hasOwn(count, d.decision)) continue;
    if (/^(ConfigChange|SessionStart):/.test(String(d.summary ?? ''))) { if (d.decision !== 'allow') settings++; continue; }
    if (d.decision === 'allow' && String(d.rule ?? '').startsWith('paused:')) paused++;
    count[d.decision]++;
    const a = byAgent.get(d.client) ?? { agent: d.client, allow: 0, ask: 0, deny: 0 };
    a[d.decision]++;
    byAgent.set(d.client, a);
    if (d.decision !== 'allow' && typeof d.rule === 'string' && /^[\w:.-]{1,60}$/.test(d.rule)) {
      const k = `${d.decision}|${d.rule}`;
      rules.set(k, (rules.get(k) ?? 0) + 1);
    }
  }
  return {
    total: count.allow + count.ask + count.deny,
    ...count,
    byAgent: [...byAgent.values()].sort((a, b) => (b.deny + b.ask) - (a.deny + a.ask) || a.agent.localeCompare(b.agent)),
    settings,
    paused,
    rules: [...rules].map(([k, n]) => { const [decision, rule] = k.split('|'); return { rule, decision, count: n }; }).sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)).slice(0, 10),
    brokenDays,
  };
}
