#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: ask Immiscible before a tool call runs.
 *
 * Claude Code runs this command before each matching tool call, with the
 * call as JSON on stdin. The script sends it to POST /v1/actions/authorize as
 * an action of type `tool.call`, with a one-line summary (the tool name and
 * its input), the target domain where there is one, and provenance taken
 * from the session itself, then prints the decision in the form Claude Code
 * understands:
 *
 *   allow              -> no output, exit 0 (Claude Code's own permission settings then
 *                         decide, exactly as if the hook were not there)
 *   deny               -> "deny"   (the call is refused, and the model sees why)
 *   approval_required  -> "ask"    (Claude Code asks you, with the reasons and the approval link)
 *
 * A read-only call (ls, git status, reading a file) is decided like any
 * other and recorded; the agent's rule says whether it needs a person
 * (readOnly in the rule; the default Claude Code rules let it go ahead).
 *
 * It sends the project the call runs in (CLAUDE_PROJECT_DIR, or the working
 * directory) and the working directory. The default rules let edits, test
 * runs and builds go ahead once the agent is past its intern stage, and only
 * inside that project; anything that names a path outside it asks a person.
 *
 * An MCP tool (mcp__<server>__<tool>) names its server as its destination,
 * mcp:<server>, so a rule decides which MCP servers the agent may use: list
 * mcp:<server> (or mcp:*) in the rule's domains. It is never treated as a
 * local call.
 *
 * Provenance comes from the client, not the model: if the session transcript
 * shows a web fetch, a web search or an MCP tool result earlier on, the
 * request says so, and Immiscible treats the session as carrying untrusted input.
 *
 * It also sends Claude Code's session id. When the same session's model
 * traffic goes through the Immiscible gateway (ANTHROPIC_BASE_URL), Immiscible has
 * seen every tool result that entered the context, and compares that with
 * the provenance declared here: the transcript scan can miss what fell out
 * of its last 2 MB, the gateway cannot.
 *
 * It fails closed. If Immiscible cannot be reached, answers with an error, or does
 * not answer inside the timeout, the call is refused. Claude Code blocks a
 * call only when a hook exits with code 2, so the command ends in
 * `|| exit 2`: a missing file, a missing node or a crash blocks the call
 * too. If you need to work offline, remove the hook; do not teach it to
 * allow on error.
 *
 * Environment:
 *   IMMISCIBLE_URL          your Immiscible base URL (default https://immiscible.fly.dev, the hosted service)
 *   IMMISCIBLE_AGENT_KEY    an agent key, from Agents in the console
 *   IMMISCIBLE_TIMEOUT_MS   how long to wait for a decision (default 10000, at most 50000,
 *                           so the hook answers before Claude Code's own 60 second limit)
 * Each is also read under its older ASSAY_ name when the new one is unset.
 *
 * ~/.claude/settings.json, or .claude/settings.json for one project:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__(?!immiscible__(check_action_status|explain_decision|spend_summary|find_waste|unwatched_keys)$).*",
 *           "hooks": [ { "type": "command", "command": "node ~/.immiscible/claude-code-hook.mjs || exit 2", "timeout": 60 } ]
 *         }
 *       ]
 *     }
 *   }
 *
 * One file, no dependencies, Node 22.
 */

import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

const env = (name) => process.env[`IMMISCIBLE_${name}`] || process.env[`ASSAY_${name}`] || '';
const BASE = (env('URL') || 'https://immiscible.fly.dev').replace(/\/$/, '');
const KEY = env('AGENT_KEY');
/** Below Claude Code's hook timeout (60 s in the settings below), so the refusal is ours, not a timeout. */
const MAX_TIMEOUT_MS = 50_000;
const TIMEOUT_MS = Math.min(Number(env('TIMEOUT_MS')) || 10_000, MAX_TIMEOUT_MS);
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

function out(decision, reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  })}\n`);
  process.exit(0);
}

const refuse = (reason) => out('deny', `Immiscible hook (failing closed): ${reason}`);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** The longest command sent whole; a longer one is cut here and marked [cut]. */
const CUT_AT = 289;

function hostOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** One line a person can read, plus where the call goes, if anywhere. */
function describe(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'Bash') {
    const url = /\bhttps?:\/\/[^\s'"<>|;)]+/i.exec(String(i.command ?? ''))?.[0];
    // A line break separates commands, as ; does. Shown as ; so the summary
    // never reads as one harmless command when it is two.
    const cmd = clip(String(i.command ?? '').replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ; '), Infinity);
    // A command too long to send whole is cut and marked, and Immiscible
    // never lets a cut command go ahead on its own: the end is what it cannot see.
    return { summary: `Bash: ${cmd.length > CUT_AT ? `${cmd.slice(0, CUT_AT)} [cut]` : cmd}`, domain: url ? hostOf(url) : null };
  }
  if (tool === 'WebFetch') return { summary: `WebFetch: ${clip(i.url, 250)}`, domain: hostOf(i.url) };
  if (tool === 'WebSearch') return { summary: `WebSearch: ${clip(i.query, 250)}`, domain: null };
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read'].includes(tool)) {
    return { summary: `${tool}: ${clip(i.file_path ?? i.notebook_path, 250)}`, domain: null };
  }
  // An MCP tool's destination is its server: mcp__github__create_issue goes to mcp:github.
  const mcp = /^mcp__([A-Za-z0-9_-]+?)__/.exec(tool);
  if (mcp) return { summary: `${tool}: ${clip(JSON.stringify(i), 250)}`, domain: null, recipient: `mcp:${mcp[1].toLowerCase()}` };
  const url = typeof i.url === 'string' ? i.url : null;
  return { summary: `${tool}: ${clip(JSON.stringify(i), 250)}`, domain: url ? hostOf(url) : null };
}

/**
 * What influenced this session, read from Claude Code's own transcript
 * (the last 2 MB of it). Web fetches and searches bring in web content; MCP
 * tools bring in third-party tool output.
 */
function sessionProvenance(transcriptPath, tool) {
  const prov = [{ source: 'agent', detail: `Claude Code ${tool} call` }];
  if (typeof transcriptPath !== 'string' || !transcriptPath) return prov;
  let text = '';
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return prov;
  }
  if (/"name"\s*:\s*"(WebFetch|WebSearch)"/.test(text)) prov.push({ source: 'web', detail: 'the session fetched or searched the web' });
  if (/"name"\s*:\s*"mcp__/.test(text)) prov.push({ source: 'tool', detail: 'the session used MCP tool output' });
  return prov;
}

/**
 * The project the call runs in: Claude Code's CLAUDE_PROJECT_DIR, or the
 * working directory it reports, and that working directory. Immiscible lets
 * an edit or a test run go ahead (when the rule says so) only inside it.
 */
function project(event) {
  const abs = (x) => (typeof x === 'string' && x.startsWith('/') ? x.slice(0, 1024) : null);
  const cwd = abs(event.cwd);
  const dir = abs(process.env.CLAUDE_PROJECT_DIR) ?? cwd;
  return dir ? { dir, cwd: cwd ?? dir } : null;
}

async function main() {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return refuse('could not read the tool call from Claude Code.');
  }
  if (!KEY) return refuse('IMMISCIBLE_AGENT_KEY is not set, so this tool call cannot be checked.');
  const tool = clip(event.tool_name ?? 'unknown', 120);
  const { summary, domain, recipient } = describe(tool, event.tool_input);
  const body = {
    type: 'tool.call',
    summary,
    ...(domain ? { target: { domain } } : recipient ? { target: { recipient } } : {}),
    provenance: sessionProvenance(event.transcript_path, tool),
    ...(project(event) ? { project: project(event) } : {}),
    ...(typeof event.session_id === 'string' && /^[!-~]{1,128}$/.test(event.session_id) ? { session: { client: 'claude-code', id: event.session_id } } : {}),
    ...(typeof event.tool_use_id === 'string' && event.tool_use_id ? { idempotencyKey: event.tool_use_id.slice(0, 128) } : {}),
  };
  let res;
  let json;
  try {
    res = await fetch(`${BASE}/v1/actions/authorize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = null; }
  } catch (err) {
    return refuse(err?.name === 'TimeoutError' ? `no answer from Immiscible within ${TIMEOUT_MS}ms.` : `Immiscible could not be reached (${err.message}).`);
  }
  if (!res.ok) return refuse(json?.error?.message ?? `Immiscible answered ${res.status}.`);
  if (!json) return refuse(`Immiscible answered ${res.status} with something that is not a decision.`);
  // Each reason is a clause without a full stop; joined with semicolons so the model reads them apart.
  const clauses = (json.reasons ?? []).map((r) => String(r).trim().replace(/\.$/, '')).filter(Boolean);
  const reasons = clauses.length ? `${clauses.join('; ')}.` : '';
  // Allow prints nothing: Claude Code's own permission settings still apply,
  // as if the hook were not there. (An explicit "allow" would skip them.)
  if (json.decision === 'allow') process.exit(0);
  if (json.decision === 'approval_required') {
    return out('ask', `Immiscible asks for a person: ${reasons}${json.approval?.url ? ` Approve or deny at ${json.approval.url}` : ''}`);
  }
  if (json.decision === 'deny') return out('deny', `Immiscible refused: ${reasons}`);
  return refuse('Immiscible returned no decision.');
}

main().catch((err) => refuse(err.message));
