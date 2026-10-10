/**
 * Readers for the session history coding agents already keep on this
 * machine. Each turns its agent's files into the same shape, in memory only:
 *
 *   { agent, id, file, cwd, branch, startedAt, endedAt, modes: [..],
 *     calls: [{ at, tool, command?, path?, url?, query?, server?, write? }],
 *     usage: { <model>: { input, cacheRead, cacheWrite, output } } }
 *
 * No prompt text, model reply or file content is kept: only tool calls and
 * token counts. Command strings are kept in memory for analyse.mjs to
 * classify, which reduces them to command names, paths and domains; no
 * command string reaches any output.
 *
 * A source that is absent is reported as skipped, with a note; a file that
 * cannot be read or parsed is counted and passed over, never fatal.
 *
 * Where each format comes from (written from the agents' open-source code
 * and documentation; the formats are not versioned, so every field is read
 * defensively and an unknown line is ignored):
 *
 *   Claude Code   ~/.claude/projects/<project>/<session>.jsonl (or $CLAUDE_CONFIG_DIR/projects,
 *                 and ~/.config/claude/projects), one JSON object a line: type, sessionId, cwd,
 *                 gitBranch, timestamp, permissionMode, and message (model, usage, and content
 *                 blocks of type "tool_use" with name and input). The hooks reference documents
 *                 transcript_path pointing here: https://code.claude.com/docs/en/hooks
 *   Codex         ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (or $CODEX_HOME/sessions), one
 *                 RolloutLine a line: { timestamp, type, payload } with type session_meta (id,
 *                 cwd, git), turn_context (cwd, model, approval_policy, sandbox_policy),
 *                 response_item (function_call, local_shell_call, custom_tool_call,
 *                 web_search_call) and event_msg (token_count: info.total_token_usage).
 *                 https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
 *   Gemini CLI    ~/.gemini/tmp/<project hash>/chats/session-*.json, a ConversationRecord:
 *                 sessionId, projectHash (SHA-256 of the project root), startTime, lastUpdated,
 *                 messages[] with type, timestamp, model, tokens (input, output, cached) and
 *                 toolCalls[] (name, args). https://github.com/google-gemini/gemini-cli/blob/main/
 *                 packages/core/src/services/chatRecordingService.ts
 *   Cursor, Windsurf
 *                 Keep chat history in an undocumented SQLite database inside the editor's
 *                 storage (state.vscdb); neither format is documented or open, so they are
 *                 detected and noted, not read.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { secretsIn } from './secrets.mjs';
import path from 'node:path';

const MAX_FILE = 256 * 1024 * 1024;

/** Files under dir matching test, newer than since (ms), walking at most depth levels. */
function walk(dir, test, since, depth = 4, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) walk(p, test, since, depth - 1, out); continue; }
    if (!e.isFile() || !test(e.name)) continue;
    try {
      const st = statSync(p);
      if (st.mtimeMs >= since && st.size <= MAX_FILE) out.push(p);
    } catch { /* gone */ }
  }
  return out;
}

const isoMs = (t) => { const n = Date.parse(t); return Number.isFinite(n) ? n : null; };
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
function* lines(text) {
  let i = 0;
  while (i < text.length) {
    let j = text.indexOf('\n', i);
    if (j === -1) j = text.length;
    const line = text.slice(i, j).trim();
    i = j + 1;
    if (line) yield line;
  }
}

function newSession(agent, id, file) {
  return { agent, id, file, cwd: null, branch: null, startedAt: null, endedAt: null, modes: new Set(), calls: [], usage: {} };
}
function touch(s, at) {
  if (at == null) return;
  if (s.startedAt == null || at < s.startedAt) s.startedAt = at;
  if (s.endedAt == null || at > s.endedAt) s.endedAt = at;
}
function addUsage(s, model, u) {
  const m = model || 'unknown';
  const t = (s.usage[m] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  for (const k of Object.keys(t)) t[k] += Math.max(0, Number(u[k]) || 0);
}
/** A shell argv to the script it runs: ["bash", "-lc", "git push"] is "git push". */
export function argvToCommand(argv) {
  if (typeof argv === 'string') return argv;
  if (!Array.isArray(argv)) return null;
  const a = argv.map(String);
  if (a.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(a[0]) && /^-\w*c$/.test(a[1])) return a.slice(2).join(' ');
  return a.join(' ');
}

/* ---------------------------------------------------------------- Claude Code */

/** What Claude Code writes back when the person declines a call at its permission prompt. */
const CLAUDE_DECLINED = /doesn't want to proceed with this tool use|tool use was rejected/i;
const resultText = (b) => (typeof b?.content === 'string' ? b.content : Array.isArray(b?.content) ? b.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' ') : '');

function claudeToolCall(block, at) {
  const name = String(block.name ?? '');
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  if (name === 'Bash' || name === 'BashOutput') return input.command ? { at, tool: 'shell', command: String(input.command) } : null;
  if (name === 'Read') return { at, tool: 'read', path: input.file_path ?? null };
  if (['Write', 'Edit', 'MultiEdit'].includes(name)) return { at, tool: 'write', path: input.file_path ?? null };
  if (name === 'NotebookEdit') return { at, tool: 'write', path: input.notebook_path ?? null };
  if (name === 'WebFetch') return { at, tool: 'fetch', url: input.url ?? null };
  if (name === 'WebSearch') return { at, tool: 'search' };
  if (name.startsWith('mcp__')) return { at, tool: 'mcp', server: name.split('__')[1] ?? 'unknown' };
  return null;
}

export function readClaudeFile(text, file, sessions) {
  const seen = new Map(); // message id to its usage, so a streamed message is counted once
  for (const line of lines(text)) {
    const o = parseJson(line);
    if (!o || typeof o !== 'object') continue;
    // Summary and snapshot lines carry no session id; they say nothing the scan reports.
    if (!o.sessionId && o.type !== 'user' && o.type !== 'assistant') continue;
    const id = o.sessionId ?? path.basename(file, '.jsonl');
    const s = sessions.get(`claude-code:${id}`) ?? newSession('claude-code', id, file);
    sessions.set(`claude-code:${id}`, s);
    const at = isoMs(o.timestamp);
    if (o.type === 'user' || o.type === 'assistant') touch(s, at);
    if (o.cwd && !o.isSidechain) s.cwd ??= o.cwd;
    else if (o.cwd) s.cwdSide ??= o.cwd;
    if (o.gitBranch && o.gitBranch !== 'HEAD') s.branch ??= o.gitBranch;
    if (typeof o.permissionMode === 'string') s.modes.add(o.permissionMode);
    const msg = o.message;
    // A call the person declined at the prompt is in the transcript, but did not run.
    if (o.type === 'user' && Array.isArray(msg?.content)) {
      for (const b of msg.content) {
        if (b?.type !== 'tool_result' || !b.is_error || !CLAUDE_DECLINED.test(resultText(b))) continue;
        const c = s.byUseId?.get(b.tool_use_id);
        if (c) c.declined = true;
      }
    }
    if (o.type === 'assistant' && msg && typeof msg === 'object') {
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) if (b?.type === 'tool_use') { const c = claudeToolCall(b, at); if (c) { if (typeof b.id === 'string') (s.byUseId ??= new Map()).set(b.id, c); s.calls.push(c); } }
      }
      const u = msg.usage;
      if (u && msg.model !== '<synthetic>') {
        const key = `${id}|${msg.id ?? o.uuid}|${o.requestId ?? ''}`;
        const usage = { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens };
        const prev = seen.get(key);
        if (prev) {
          // Streaming writes one line per content block with the same usage; keep the largest output.
          if ((usage.output ?? 0) > (prev.usage.output ?? 0)) prev.usage.output = usage.output;
        } else {
          seen.set(key, { session: s, model: msg.model, usage });
        }
      }
    }
  }
  for (const { session, model, usage } of seen.values()) addUsage(session, model, usage);
}

/* ---------------------------------------------------------------- Codex */

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function codexItem(p, at, s) {
  if (!p || typeof p !== 'object') return;
  if (p.type === 'function_call') {
    const args = typeof p.arguments === 'string' ? parseJson(p.arguments) ?? {} : p.arguments ?? {};
    const name = String(p.name ?? '');
    if (['shell', 'container.exec', 'local_shell', 'shell_command', 'exec_command'].includes(name)) {
      const command = argvToCommand(args.command ?? args.cmd);
      if (command) s.calls.push({ at, tool: 'shell', command });
    } else if (name === 'apply_patch') {
      for (const m of String(args.input ?? args.patch ?? '').matchAll(PATCH_FILE)) s.calls.push({ at, tool: 'write', path: m[1].trim() });
    } else if (name.includes('__') || name.startsWith('mcp')) {
      s.calls.push({ at, tool: 'mcp', server: name.split('__')[0].replace(/^mcp_?/, '') || 'unknown' });
    }
  } else if (p.type === 'local_shell_call') {
    const command = argvToCommand(p.action?.command);
    if (command) s.calls.push({ at, tool: 'shell', command });
  } else if (p.type === 'custom_tool_call') {
    if (p.name === 'apply_patch') for (const m of String(p.input ?? '').matchAll(PATCH_FILE)) s.calls.push({ at, tool: 'write', path: m[1].trim() });
  } else if (p.type === 'web_search_call') {
    s.calls.push({ at, tool: 'search' });
  }
}

function sandboxName(sp) {
  if (!sp) return null;
  if (typeof sp === 'string') return sp;
  return sp.mode ?? sp.type ?? null;
}

export function readCodexFile(text, file, sessions) {
  const s = newSession('codex', path.basename(file, '.jsonl').replace(/^rollout-/, ''), file);
  let model = null;
  let total = null;
  for (const line of lines(text)) {
    const o = parseJson(line);
    if (!o || typeof o !== 'object') continue;
    const at = isoMs(o.timestamp);
    // Rollouts before late 2025 wrote items bare, with no { type, payload } wrapper.
    const type = o.payload ? o.type : (o.type ?? (o.id && o.instructions !== undefined ? 'session_meta' : null));
    const p = o.payload ?? o;
    if (type === 'session_meta') {
      if (p.id) s.id = String(p.id);
      s.cwd ??= p.cwd ?? null;
      s.branch ??= p.git?.branch ?? null;
      touch(s, isoMs(p.timestamp) ?? at);
    } else if (type === 'turn_context') {
      s.cwd ??= p.cwd ?? null;
      model = p.model ?? model;
      if (p.approval_policy) s.modes.add(`approval:${p.approval_policy}`);
      const sb = sandboxName(p.sandbox_policy);
      if (sb) s.modes.add(`sandbox:${sb}`);
      touch(s, at);
    } else if (type === 'event_msg') {
      if (p.type === 'token_count' && p.info?.total_token_usage) total = p.info.total_token_usage;
      touch(s, at);
    } else if (type === 'response_item' || ['function_call', 'local_shell_call', 'custom_tool_call', 'web_search_call', 'message'].includes(p.type)) {
      codexItem(p, at, s);
      touch(s, at);
    }
  }
  if (total) {
    const cached = Number(total.cached_input_tokens) || 0;
    // OpenAI counts cached tokens inside input_tokens; reasoning inside output_tokens.
    addUsage(s, model, { input: Math.max(0, (Number(total.input_tokens) || 0) - cached), cacheRead: cached, output: total.output_tokens });
  }
  sessions.set(`codex:${s.id}`, s);
}

/* ---------------------------------------------------------------- Gemini CLI */

function geminiToolCall(tc, at) {
  const name = String(tc?.name ?? '');
  const a = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  if (name === 'run_shell_command') return a.command ? { at, tool: 'shell', command: String(a.command) } : null;
  if (name === 'read_file' || name === 'read_many_files') return { at, tool: 'read', path: a.absolute_path ?? a.file_path ?? a.path ?? (Array.isArray(a.paths) ? a.paths[0] : null) };
  if (name === 'write_file' || name === 'replace' || name === 'edit') return { at, tool: 'write', path: a.file_path ?? a.absolute_path ?? null };
  if (name === 'web_fetch') { const m = /https?:\/\/[^\s"'<>]+/.exec(String(a.url ?? a.prompt ?? '')); return { at, tool: 'fetch', url: m ? m[0] : null }; }
  if (name === 'google_web_search') return { at, tool: 'search' };
  if (name.includes('__')) return { at, tool: 'mcp', server: name.split('__')[0] };
  return null;
}

export function readGeminiFile(text, file, sessions, projects = new Map()) {
  let rec = parseJson(text);
  if (!rec) {
    // A JSONL variant: a header line, then one message a line.
    rec = { messages: [] };
    for (const line of lines(text)) {
      const o = parseJson(line);
      if (!o) continue;
      if (Array.isArray(o.messages)) Object.assign(rec, o);
      else if (o.type) rec.messages.push(o); else Object.assign(rec, o);
    }
  }
  if (!rec || typeof rec !== 'object') return;
  const id = String(rec.sessionId ?? path.basename(file).replace(/\.jsonl?$/, ''));
  const s = newSession('gemini-cli', id, file);
  const hash = rec.projectHash ?? path.basename(path.dirname(path.dirname(file)));
  s.cwd = projects.get(hash) ?? null;
  s.project = hash ? `project ${String(hash).slice(0, 8)}` : null;
  touch(s, isoMs(rec.startTime));
  touch(s, isoMs(rec.lastUpdated));
  for (const m of Array.isArray(rec.messages) ? rec.messages : []) {
    const at = isoMs(m?.timestamp);
    touch(s, at);
    for (const tc of Array.isArray(m?.toolCalls) ? m.toolCalls : []) { const c = geminiToolCall(tc, isoMs(tc?.timestamp) ?? at); if (c) s.calls.push(c); }
    const t = m?.tokens;
    if (t && typeof t === 'object') {
      const cached = Number(t.cached) || 0;
      addUsage(s, m.model ?? null, { input: Math.max(0, (Number(t.input) || 0) - cached), cacheRead: cached, output: (Number(t.output) || 0) + (Number(t.thoughts) || 0) });
    }
  }
  sessions.set(`gemini-cli:${id}`, s);
}

/* ---------------------------------------------------------------- discovery */

export const SOURCES = Object.freeze([
  { agent: 'claude-code', label: 'Claude Code' },
  { agent: 'codex', label: 'Codex' },
  { agent: 'gemini-cli', label: 'Gemini CLI' },
  { agent: 'cursor', label: 'Cursor' },
  { agent: 'windsurf', label: 'Windsurf' },
]);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Read every source under home. Returns { sessions, sources, transcriptSecrets }, sources one
 * per agent: { agent, label, status: 'read' | 'absent' | 'not_readable', files, sessions, unreadable, note }.
 */
export function readHistory({ home, env = {}, since = 0, projectDirs = [] } = {}) {
  const sessions = new Map();
  const sources = [];
  // Secrets the transcripts hold in plain text: per file, kind and fingerprint only.
  const transcriptSecrets = [];
  let agentOf = null;
  const tryRead = (file, fn) => {
    try {
      const text = readFileSync(file, 'utf8');
      fn(text);
      const found = secretsIn(text);
      if (found.length) transcriptSecrets.push({ agent: agentOf, file, secrets: found });
      return true;
    } catch { return false; }
  };

  // Claude Code
  agentOf = 'claude-code';
  {
    const roots = [...new Set([env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'projects') : null, path.join(home, '.claude', 'projects'), path.join(home, '.config', 'claude', 'projects')].filter(Boolean))].filter((d) => existsSync(d));
    const files = roots.flatMap((r) => walk(r, (n) => n.endsWith('.jsonl'), since, 4));
    let bad = 0;
    for (const f of files) if (!tryRead(f, (t) => readClaudeFile(t, f, sessions))) bad++;
    const n = [...sessions.values()].filter((s) => s.agent === 'claude-code').length;
    sources.push({ agent: 'claude-code', label: 'Claude Code', status: roots.length ? 'read' : 'absent', files: files.length, sessions: n, unreadable: bad, note: roots.length ? null : 'no ~/.claude/projects here' });
  }

  // Codex
  agentOf = 'codex';
  {
    const root = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
    const present = existsSync(root);
    const files = present ? walk(root, (n) => /^rollout-.*\.jsonl$/.test(n), since, 4) : [];
    let bad = 0;
    for (const f of files) if (!tryRead(f, (t) => readCodexFile(t, f, sessions))) bad++;
    const n = [...sessions.values()].filter((s) => s.agent === 'codex').length;
    sources.push({ agent: 'codex', label: 'Codex', status: present ? 'read' : 'absent', files: files.length, sessions: n, unreadable: bad, note: present ? null : 'no ~/.codex/sessions here' });
  }

  agentOf = 'gemini-cli';
  // Gemini CLI: its project hash is the SHA-256 of the project root, so the
  // directories other agents worked in (and this one) name its projects.
  {
    const root = path.join(home, '.gemini', 'tmp');
    const present = existsSync(root);
    const known = new Set(projectDirs);
    for (const s of sessions.values()) if (s.cwd) known.add(s.cwd);
    const projects = new Map([...known].map((d) => [sha256(d), d]));
    const files = present ? walk(root, (n) => /^session-.*\.jsonl?$/.test(n), since, 3) : [];
    let bad = 0;
    for (const f of files) if (!tryRead(f, (t) => readGeminiFile(t, f, sessions, projects))) bad++;
    const n = [...sessions.values()].filter((s) => s.agent === 'gemini-cli').length;
    sources.push({ agent: 'gemini-cli', label: 'Gemini CLI', status: present ? 'read' : 'absent', files: files.length, sessions: n, unreadable: bad, note: present ? null : 'no ~/.gemini/tmp here' });
  }

  // Cursor and Windsurf: detected, not read.
  for (const [agent, label, dirs] of [
    ['cursor', 'Cursor', ['.cursor', 'Library/Application Support/Cursor', '.config/Cursor', 'AppData/Roaming/Cursor']],
    ['windsurf', 'Windsurf', ['.codeium/windsurf', 'Library/Application Support/Windsurf', '.config/Windsurf', 'AppData/Roaming/Windsurf']],
  ]) {
    const present = dirs.some((d) => existsSync(path.join(home, d)));
    sources.push({ agent, label, status: present ? 'not_readable' : 'absent', files: 0, sessions: 0, unreadable: 0, note: present ? `${label} is here, but keeps its history in an undocumented database, so scan does not read it` : `no ${label} here` });
  }

  const list = [...sessions.values()].filter((s) => s.startedAt != null || s.calls.length).map((s) => ({ ...s, modes: [...s.modes], cwd: s.cwd ?? s.cwdSide ?? null, calls: s.calls.filter((c) => !c.declined) }));
  for (const s of list) { delete s.cwdSide; delete s.byUseId; }
  return { sessions: list, sources, transcriptSecrets };
}
