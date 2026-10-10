#!/usr/bin/env node
/**
 * One hook for the coding agents other than Claude Code: Codex, Cursor,
 * Windsurf, Gemini CLI, Factory Droid, opencode and Amp. It asks Immiscible before a shell command, a file
 * write or an MCP tool call runs, and answers in the form each agent reads.
 *
 *   node coding-agent-hook.mjs --agent codex|cursor|windsurf|gemini|droid|opencode|amp [--wait <seconds>]
 *   node coding-agent-hook.mjs --agent <agent> --self-test     prints {"ok":true,...} and exits 0
 *
 * `immiscible install <agent>` copies this file and writes the agent's hook
 * configuration; the docs page is docs/site/guides/coding-agent-hooks.md.
 * It sends the same request the Claude Code hook sends (scripts/claude-code-hook.mjs),
 * so the same rules decide: a shell command is "Bash: <command>", a file
 * write is "Write: <path>" or "Edit: <path>", and an MCP tool is
 * "mcp__<server>__<tool>: {...}" with mcp:<server> as its destination.
 *
 * What each agent sends on stdin, and how it is answered (each read from the
 * vendor's hook documentation in October 2026):
 *
 *   codex     PreToolUse: tool_name (Bash, apply_patch, mcp__<server>__<tool>), tool_input,
 *             tool_use_id, session_id, cwd. https://developers.openai.com/codex/hooks
 *   cursor    beforeShellExecution: command, cwd, workspace_roots; beforeMCPExecution:
 *             tool_name, tool_input (a JSON string), mcp_server_name. Answered with
 *             {"permission": "allow" | "deny" | "ask", "user_message", "agent_message"}.
 *             https://cursor.com/docs/hooks
 *   windsurf  pre_run_command (tool_info.command_line, cwd), pre_mcp_tool_use
 *             (tool_info.mcp_server_name, mcp_tool_name, mcp_tool_arguments), pre_write_code
 *             (tool_info.file_path), with trajectory_id and execution_id.
 *             https://docs.windsurf.com/windsurf/cascade/hooks
 *   gemini    BeforeTool: tool_name (run_shell_command, write_file, replace, web_fetch,
 *             mcp_<server>_<tool>), tool_input, session_id, cwd; GEMINI_PROJECT_DIR in the
 *             environment. https://geminicli.com/docs/hooks/reference/
 *   droid     PreToolUse: tool_name (Execute, Edit, Create, ApplyPatch, FetchUrl,
 *             mcp__<server>__<tool>), tool_input, session_id, cwd; FACTORY_PROJECT_DIR in the
 *             environment. Answered like Claude Code: exit 2 refuses, and
 *             hookSpecificOutput.permissionDecision "ask" asks the person at the keyboard.
 *             https://docs.factory.ai/reference/hooks-reference
 *   opencode  opencode has plugins, not command hooks: the plugin `immiscible install opencode`
 *             writes runs this file from tool.execute.before with { tool, args, sessionID,
 *             callID, cwd } and throws (which stops the call) unless it exits 0. Tools: bash,
 *             edit, write, patch, webfetch; reads and searches are not sent. https://opencode.ai/docs/plugins
 *   amp       Amp has plugins too: the plugin runs this file on tool.call with { tool, input,
 *             toolUseID, threadID, cwd, shell } (shell from amp.helpers.shellCommandFromToolCall)
 *             and answers reject-and-continue unless it exits 0. Shell commands, edit_file,
 *             create_file, apply_patch and mcp__<server>__<tool> are checked.
 *             https://ampcode.com/manual/plugin-api
 *
 * Codex, Windsurf and Gemini CLI block a call when a hook exits with code 2
 * and show its standard error as the reason, so a refusal is exit 2 with
 * the reason on stderr. Cursor reads the JSON answer (exit 2 is a deny there
 * too). An allow is exit 0 with nothing printed (for Cursor, permission
 * "allow"), so the agent's own settings still decide, as if the hook were
 * not there.
 *
 * Only Cursor and Factory Droid can ask the person at the keyboard. For the others, a
 * decision that needs a person is held: the hook waits up to --wait seconds
 * (IMMISCIBLE_APPROVAL_WAIT_S overrides it) for someone to answer in Slack,
 * Teams, email or the console, then goes ahead if they approved and refuses
 * otherwise, naming the approval link. The installer sets a wait below the
 * agent's own hook timeout.
 *
 * It fails closed. If Immiscible cannot be reached, answers with an error,
 * or does not answer in time, the call is refused; the installed command
 * ends in `|| exit 2`, so a missing file, a missing node or a crash blocks
 * the call too. Cursor's entry also sets failClosed.
 *
 * Environment (the installed command also reads them from the hook.env file
 * beside this script, because Cursor and Windsurf run hooks from the app,
 * not a shell, and Gemini CLI gives hooks a reduced environment):
 *   IMMISCIBLE_URL              your Immiscible base URL (default https://immiscible.ai)
 *   IMMISCIBLE_AGENT_KEY        an agent key, from Agents in the console
 *   IMMISCIBLE_TIMEOUT_MS       how long to wait for a decision (default 10000, at most 50000)
 *   IMMISCIBLE_APPROVAL_WAIT_S  how long to wait for a person (default: --wait, else 0)
 * Each is also read under its older ASSAY_ name when the new one is unset.
 *
 * One file, no dependencies, Node 22.
 */

import { createHash } from 'node:crypto';

const AGENTS = Object.freeze(['codex', 'cursor', 'windsurf', 'gemini', 'droid', 'opencode', 'amp']);
/** The session client each agent's requests name (core/agents.js accepts these). */
const CLIENT = { codex: 'codex', cursor: 'cursor', windsurf: 'windsurf', gemini: 'gemini-cli', droid: 'factory-droid', opencode: 'opencode', amp: 'amp' };
const LABEL = { codex: 'Codex', cursor: 'Cursor', windsurf: 'Windsurf', gemini: 'Gemini CLI', droid: 'Factory Droid', opencode: 'opencode', amp: 'Amp' };
/** The agents that can ask the person at the keyboard from a hook. */
const CAN_ASK = new Set(['cursor', 'droid']);

const env = (name) => process.env[`IMMISCIBLE_${name}`] || process.env[`ASSAY_${name}`] || '';
const MAX_TIMEOUT_MS = 50_000;
/** Most files one apply_patch may change and still be checked one by one. */
const MAX_FILES = 20;
/** The longest command sent whole; a longer one is cut here and marked [cut], as the Claude Code hook does. */
const CUT_AT = 289;

const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function hostOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** A shell command as one line ("Bash: ..."), line breaks shown as ; so two commands never read as one. */
function bash(command) {
  const raw = Array.isArray(command) ? command.map(String).join(' ') : String(command ?? '');
  const url = /\bhttps?:\/\/[^\s'"<>|;)]+/i.exec(raw)?.[0];
  const cmd = clip(raw.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ; '), Infinity);
  // full: the whole command, for the local rules, which send nothing and so need not cut it.
  return { summary: `Bash: ${cmd.length > CUT_AT ? `${cmd.slice(0, CUT_AT)} [cut]` : cmd}`, full: `Bash: ${cmd}`, domain: url ? hostOf(url) : null };
}

/** Immiscible's own MCP tools that only read: never sent back to Immiscible (asking whether it may ask is a loop). */
const OWN_READ_TOOLS = new Set(['check_action_status', 'explain_decision', 'spend_summary', 'find_waste', 'unwatched_keys']);
const SKIP = Symbol('skip');

const mcpCall = (server, tool, input) => {
  const s = String(server ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);
  if (!s) return null;
  if (s === 'immiscible' && OWN_READ_TOOLS.has(String(tool))) return SKIP;
  const args = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  return { summary: `mcp__${s}__${clip(tool, 80)}: ${clip(args, 250)}`, domain: null, recipient: `mcp:${s}` };
};

const write = (tool, file) => ({ summary: `${tool}: ${clip(file, 250)}`, domain: null });

/** The files an apply_patch body adds, changes, deletes or moves to. */
function patchFiles(text) {
  const files = [];
  for (const m of String(text ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const f = (m[1] ?? m[2]).trim();
    if (f && !files.includes(f)) files.push(f);
  }
  return files;
}

/**
 * The calls to check for one event: [{ summary, domain?, recipient? }], an
 * empty list for an event that is not a tool call, or { error }.
 */
function callsOf(agent, event) {
  const e = event && typeof event === 'object' ? event : {};
  if (agent === 'codex' || agent === 'gemini') {
    const tool = String(e.tool_name ?? '');
    const input = e.tool_input && typeof e.tool_input === 'object' ? e.tool_input : {};
    if (!tool) return { error: 'the event names no tool' };
    if (tool === 'Bash' || tool === 'run_shell_command' || tool === 'shell' || tool === 'local_shell') return [bash(input.command)];
    if (tool === 'apply_patch') {
      const files = patchFiles(input.command ?? input.patch ?? input.input);
      if (!files.length) return { error: 'the patch names no file' };
      if (files.length > MAX_FILES) return { error: `the patch changes ${files.length} files, more than the ${MAX_FILES} the hook checks one by one` };
      return files.map((f) => write('Edit', f));
    }
    if (tool === 'write_file' || tool === 'Write') return [write('Write', input.file_path ?? input.path)];
    if (tool === 'replace' || tool === 'Edit') return [write('Edit', input.file_path ?? input.path)];
    if (tool === 'web_fetch' || tool === 'WebFetch') {
      const url = input.url ?? /\bhttps?:\/\/[^\s'"<>]+/i.exec(String(input.prompt ?? ''))?.[0] ?? '';
      return [{ summary: `WebFetch: ${clip(url || input.prompt, 250)}`, domain: hostOf(url) }];
    }
    const codexMcp = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(tool);
    if (codexMcp) return [mcpCall(codexMcp[1], codexMcp[2], input)];
    // Gemini CLI: mcp_<server>_<tool>, split on the first underscore after mcp_, as its policy engine does.
    const geminiMcp = /^mcp_([A-Za-z0-9-]+)_(.+)$/.exec(tool);
    if (agent === 'gemini' && geminiMcp) return [mcpCall(e.mcp_context?.server_name ?? geminiMcp[1], geminiMcp[2], input)];
    const url = typeof input.url === 'string' ? input.url : null;
    return [{ summary: `${clip(tool, 120)}: ${clip(JSON.stringify(input), 250)}`, domain: url ? hostOf(url) : null }];
  }
  if (agent === 'cursor') {
    if (e.hook_event_name === 'beforeShellExecution' || (typeof e.command === 'string' && !e.tool_name)) return [bash(e.command)];
    if (e.hook_event_name === 'beforeMCPExecution' || e.tool_name) {
      const call = mcpCall(e.mcp_server_name ?? e.server, e.tool_name, e.tool_input);
      return call ? [call] : { error: 'the MCP call names no server' };
    }
    return [];
  }
  if (agent === 'windsurf') {
    const i = e.tool_info && typeof e.tool_info === 'object' ? e.tool_info : {};
    if (e.agent_action_name === 'pre_run_command') return [bash(i.command_line)];
    if (e.agent_action_name === 'pre_mcp_tool_use') {
      const call = mcpCall(i.mcp_server_name, i.mcp_tool_name, i.mcp_tool_arguments);
      return call ? [call] : { error: 'the MCP call names no server' };
    }
    if (e.agent_action_name === 'pre_write_code') return [write('Write', i.file_path)];
    return [];
  }
  if (agent === 'droid') {
    const tool = String(e.tool_name ?? '');
    const input = e.tool_input && typeof e.tool_input === 'object' ? e.tool_input : {};
    if (!tool) return { error: 'the event names no tool' };
    if (tool === 'Execute') return [bash(input.command)];
    if (tool === 'Create') return [write('Write', input.file_path ?? input.path)];
    if (tool === 'Edit' || tool === 'MultiEdit') return [write('Edit', input.file_path ?? input.path)];
    if (tool === 'ApplyPatch') return patchCalls(input.patch ?? input.input ?? input.command);
    if (tool === 'FetchUrl') return [fetchCall(input.url)];
    const m = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(tool);
    if (m) return [mcpCall(m[1], m[2], input)];
    const url = typeof input.url === 'string' ? input.url : null;
    return [{ summary: `${clip(tool, 120)}: ${clip(JSON.stringify(input), 250)}`, domain: url ? hostOf(url) : null }];
  }
  if (agent === 'opencode') {
    const tool = String(e.tool ?? '');
    const args = e.args && typeof e.args === 'object' ? e.args : {};
    if (!tool) return { error: 'the event names no tool' };
    if (OPENCODE_READS.has(tool)) return [];
    if (tool === 'bash') return [bash(args.command)];
    if (tool === 'write') return [write('Write', args.filePath ?? args.file_path)];
    if (tool === 'edit' || tool === 'multiedit') return [write('Edit', args.filePath ?? args.file_path)];
    if (tool === 'patch' || tool === 'apply_patch') return patchCalls(args.patchText ?? args.patch ?? args.input);
    if (tool === 'webfetch') return [fetchCall(args.url)];
    // Everything else (MCP tools among them, named <server>_<tool>) is sent as it is.
    const url = typeof args.url === 'string' ? args.url : null;
    return [{ summary: `${clip(tool, 120)}: ${clip(JSON.stringify(args), 250)}`, domain: url ? hostOf(url) : null }];
  }
  if (agent === 'amp') {
    const tool = String(e.tool ?? '');
    const input = e.input && typeof e.input === 'object' ? e.input : {};
    if (!tool) return { error: 'the event names no tool' };
    if (e.shell && typeof e.shell.command === 'string') return [bash(e.shell.command)];
    if (tool === 'Bash' || tool === 'shell_command') return [bash(input.cmd ?? input.command)];
    if (tool === 'create_file') return [write('Write', input.path ?? input.file_path)];
    if (tool === 'edit_file') return [write('Edit', input.path ?? input.file_path)];
    if (tool === 'apply_patch') return patchCalls(input.patch ?? input.input);
    const m = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(tool);
    if (m) return [mcpCall(m[1], m[2], input)];
    if (AMP_READS.has(tool)) return [];
    // Any other tool (web search and fetch among them) is sent as it is.
    const url = typeof input.url === 'string' ? input.url : null;
    return [{ summary: `${clip(tool, 120)}: ${clip(JSON.stringify(input), 250)}`, domain: url ? hostOf(url) : null }];
  }
  return { error: `unknown agent ${agent}` };
}

/**
 * An event sent after a call ran, as the event the hook decides before it, or
 * null: Factory Droid's PostToolUse (the same fields as PreToolUse), and
 * Cursor's afterShellExecution and afterMCPExecution.
 */
function afterCall(agent, e) {
  if (!e || typeof e !== 'object') return null;
  if (agent === 'droid' && e.hook_event_name === 'PostToolUse') return { ...e, hook_event_name: 'PreToolUse' };
  if (agent === 'cursor' && e.hook_event_name === 'afterShellExecution') return { hook_event_name: 'beforeShellExecution', command: e.command };
  if (agent === 'cursor' && e.hook_event_name === 'afterMCPExecution') return { ...e, hook_event_name: 'beforeMCPExecution' };
  return null;
}

/** opencode's tools that only read or plan: not sent (the other agents' hooks never see them either). */
const OPENCODE_READS = new Set(['read', 'glob', 'grep', 'list', 'ls', 'lsp', 'todoread', 'todowrite', 'task', 'skill', 'question', 'invalid']);

/** Amp's tools that only read or plan locally: not sent. Anything Amp adds later is sent. */
const AMP_READS = new Set(['Read', 'read_file', 'Grep', 'grep', 'glob', 'list_directory', 'todo_read', 'todo_write']);

function patchCalls(text) {
  const files = patchFiles(text);
  if (!files.length) return { error: 'the patch names no file' };
  if (files.length > MAX_FILES) return { error: `the patch changes ${files.length} files, more than the ${MAX_FILES} the hook checks one by one` };
  return files.map((f) => write('Edit', f));
}

function fetchCall(url) {
  return { summary: `WebFetch: ${clip(url, 250)}`, domain: hostOf(url) };
}

/** The project the call runs in, and the working directory, as each agent reports them. */
function projectOf(agent, event, { cwd = process.cwd(), environ = process.env } = {}) {
  const abs = (x) => (typeof x === 'string' && (x.startsWith('/') || /^[A-Za-z]:[\\/]/.test(x)) ? x.slice(0, 1024) : null);
  const e = event && typeof event === 'object' ? event : {};
  let dir = null;
  let at = null;
  if (agent === 'codex') { at = abs(e.cwd); dir = at; }
  if (agent === 'gemini') { at = abs(e.cwd); dir = abs(environ.GEMINI_PROJECT_DIR) ?? at; }
  if (agent === 'cursor') { at = abs(e.cwd); dir = abs(Array.isArray(e.workspace_roots) ? e.workspace_roots[0] : null) ?? at; }
  // Windsurf runs a hook in the workspace root unless the entry names another directory.
  if (agent === 'windsurf') { at = abs(e.tool_info?.cwd); dir = abs(cwd); }
  if (agent === 'droid') { at = abs(e.cwd); dir = abs(environ.FACTORY_PROJECT_DIR) ?? at; }
  if (agent === 'opencode' || agent === 'amp') { at = abs(e.shell?.dir) ?? abs(e.cwd); dir = abs(e.worktree) ?? abs(e.cwd) ?? at; }
  dir = dir ?? at;
  return dir ? { dir, cwd: at ?? dir } : null;
}

const okId = (x) => typeof x === 'string' && /^[!-~]{1,128}$/.test(x);

/** The session and, where the agent gives one per tool call, an idempotency key. */
function sessionOf(agent, e) {
  const id = agent === 'cursor' ? e.conversation_id : agent === 'windsurf' ? e.trajectory_id : agent === 'opencode' ? e.sessionID : agent === 'amp' ? e.threadID : e.session_id;
  const call = agent === 'codex' ? e.tool_use_id : agent === 'windsurf' ? e.execution_id : agent === 'opencode' ? e.callID : agent === 'amp' ? e.toolUseID : null;
  return { session: okId(id) ? { client: CLIENT[agent], id } : null, call: typeof call === 'string' && call ? call.slice(0, 100) : null };
}

/** Parse --agent and --wait. */
function parseArgv(argv) {
  const out = { agent: null, wait: 0, selfTest: false, after: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--self-test') out.selfTest = true;
    else if (argv[i] === '--after') out.after = true;
    else if (argv[i] === '--agent') out.agent = argv[++i];
    else if (argv[i].startsWith('--agent=')) out.agent = argv[i].slice(8);
    else if (argv[i] === '--wait') out.wait = Number(argv[++i]);
    else if (argv[i].startsWith('--wait=')) out.wait = Number(argv[i].slice(7));
  }
  if (!Number.isFinite(out.wait) || out.wait < 0) out.wait = 0;
  return out;
}

// ------------------------------------------------------------------ answers

function answer(agent, decision, reason) {
  if (agent === 'cursor') {
    process.stdout.write(`${JSON.stringify(decision === 'allow' ? { permission: 'allow' } : { permission: decision, user_message: reason, agent_message: reason })}\n`);
    process.exit(0);
  }
  if (agent === 'droid' && decision === 'ask') {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } })}\n`);
    process.exit(0);
  }
  if (decision === 'allow') process.exit(0);
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, key, method, p, body, timeoutMs) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json };
}

const reasonsOf = (json) => {
  const clauses = (json?.reasons ?? []).map((r) => String(r).trim().replace(/\.$/, '')).filter(Boolean);
  return clauses.length ? `${clauses.join('; ')}.` : '';
};

// >>> immiscible local policy (generated from scripts/local-policy.mjs; edit it there and run node scripts/sync-local-policy.mjs)
const LP_SECRET = /(^|[\s"'=:/(@<])(\.env(\.[\w.-]+)?|[\w.-]*\.pem|[\w.-]*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|credentials\.json|service-account[\w.-]*\.json|\.aws\/credentials|\.aws\/config|\.ssh\/[\w.-]+|\.config\/gh\/hosts\.yml|\.docker\/config\.json|\.kube\/config)(?=$|[\s"'`;|&)>])/i;
const LP_PUBLIC_KEY = /\.pub(?=$|[\s"'`;|&)>])/i;
const LP_NETWORK = /(^|[\s;|&(`$])(curl|wget|nc|ncat|netcat|socat|scp|sftp|rsync|ftp|telnet|ssh|http|https|xh|aria2c|invoke-webrequest|invoke-restmethod|iwr|irm)(?=$|[\s;|&)])/i;
const LP_UPLOAD = /(^|[\s;|&(`$])(gh\s+(gist|repo|release|issue|pr)\s+(create|upload|comment|edit)|git\s+push)(?=$|[\s;|&)])/i;
const LP_CONFIG_FILE = /(^|[/\s])(\.claude\/settings(\.local)?\.json|\.claude\.json|\.codex\/(config|requirements)\.toml|\.codex\/hooks\.json|\.cursor\/(hooks|mcp)\.json|\.gemini\/settings\.json|\.codeium\/windsurf\/(hooks|mcp_config)\.json|\.factory\/(hooks|settings)\.json|\.?opencode\/plugins\/[^/\s]+|\.?opencode\.jsonc?|\.?amp\/plugins\/[^/\s]+|amp\/settings\.json|\.mcp\.json|\.vscode\/(tasks|settings|mcp)\.json|\.(bash|zsh)rc|\.(bash_)?profile|\.zprofile|\.github\/workflows\/[\w.-]+\.ya?ml)$/i;
/** Commands that delete or overwrite files in a working tree: the guard takes a checkpoint first, so they can be undone. */
const LP_DESTRUCTIVE = /(^|[;|&(]\s*)(sudo\s+)?(xargs\s+(-\S+\s+)*)?((\\|\/(usr\/)?bin\/)?rm\s|rmdir\s|unlink\s|shred\s|truncate\s|mv\s|sed\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*i|find\s[^;|&]*\s-delete\b|rsync\s[^;|&]*--delete|git\s+(clean\s|reset\s+--hard|checkout\s+(--\s|\.\s*($|[;|&]))|restore\s|stash\s+(drop|clear)\b|rm\s))/;
/** Paths a checkpoint never copies and undo never removes: secrets stay out of git objects. */
const LP_CHECKPOINT_SKIP = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc', '.pgpass', '.git-credentials', 'credentials.json', 'service-account*.json'];
const LP_RULES = [
  // Refused: almost never meant, and not undone by a person afterwards.
  { id: 'force_push_protected', decision: 'deny', test: (c) => /\bgit\b[^;|&]*\bpush\b(?=[^;|&]*(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+[\w./-]+))(?=[^;|&]*[\s:+](main|master|release\/[\w.-]+|production|prod)\b)/.test(c), reason: 'a force push to a protected branch (main, master, release or production) rewrites history other people have', suggest: (c) => c.replace(/\s(?:--force(?:-with-lease)?(?:=\S*)?|-[a-zA-Z]*f[a-zA-Z]*)(?=\s|$)|(?<=\s)\+(?=[\w./-])/g, (m) => (/^\s-[a-zA-Z]*f/.test(m) && m.trim() !== '-f' ? m.replace('f', '') : '')).replace(/\s{2,}/g, ' ').trim() },
  { id: 'rm_root_or_home', decision: 'deny', test: (c) => /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/|\$HOME\/\*|"\$HOME"|\.\.\/\.\.)(\s|$|;)/.test(c), reason: 'rm -r of the root, home or a parent directory deletes far more than a project' },
  { id: 'disk_wipe', decision: 'deny', test: (c) => /\b(mkfs(\.\w+)?|diskutil\s+(erase\w*|zeroDisk|secureErase))\b|\bdd\b[^;|&]*\bof=\/dev\//.test(c), reason: 'formatting or overwriting a disk' },
  { id: 'secret_off_machine', decision: 'deny', test: (c) => LP_SECRET.test(c) && !LP_PUBLIC_KEY.test(c) && (LP_NETWORK.test(c) || LP_UPLOAD.test(c)), reason: 'a secret file and a network or upload command in the same call: that is how keys leave a machine' },
  { id: 'shell_rc_backdoor', decision: 'deny', test: (c) => />>?\s*~?\/?[\w./]*\.(bash|zsh)rc\b/.test(c) && /\b(curl|wget|nc|base64|eval|shutdown|reboot)\b/.test(c), reason: 'adding a network, eval or shutdown command to a shell start-up file' },
  // Asked: fine when meant, and a person should be the one who means it.
  { id: 'pipe_to_shell', decision: 'ask', test: (c) => /\b(curl|wget|iwr|irm|invoke-webrequest)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(iex|invoke-expression)\b/i.test(c), reason: 'running a script straight from the internet' },
  { id: 'force_push', decision: 'ask', test: (c) => /\bgit\b[^;|&]*\bpush\b[^;|&]*(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+[\w./-]+)/.test(c), reason: 'a force push rewrites a branch' },
  { id: 'publish', decision: 'ask', test: (c) => /\b(npm|pnpm|bun)\s+publish\b|\byarn\s+(npm\s+)?publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgem\s+push\b|\bpoetry\s+publish\b|\bdocker\s+(push|buildx\s+build[^;|&]*--push)\b|\bgh\s+release\s+create\b/.test(c), reason: 'publishing a package or image other people will install' },
  { id: 'infrastructure', decision: 'ask', test: (c) => /\bterraform\s+(apply|destroy|import|state\s+(rm|mv))\b|\bpulumi\s+(up|destroy)\b|\bkubectl\s+(apply|delete|scale|rollout|drain|cordon|replace|patch|exec)\b|\bhelm\s+(install|upgrade|uninstall|rollback)\b|\b(aws|gcloud|az)\s+\S+\s+(delete|terminate|remove|destroy)[\w-]*\b|\bfly\s+(deploy|destroy|apps\s+destroy)\b|\bvercel\s+(--prod|deploy\s+--prod)\b/.test(c), reason: 'changing live infrastructure' },
  { id: 'database_destructive', decision: 'ask', test: (c) => /\b(drop\s+(table|database|schema)|truncate\s+table)\b|\bprisma\s+migrate\s+reset\b|\brails\s+db:(drop|reset)\b/i.test(c), reason: 'dropping or emptying a database' },
  { id: 'history_rewrite', decision: 'ask', test: (c) => /\bgit\s+(reset\s+--hard\s+\S*(origin|upstream)\/|clean\s+-[a-zA-Z]*f[a-zA-Z]*d|branch\s+-D\s+(main|master)\b|filter-(branch|repo)\b)/.test(c), reason: 'throwing away work git cannot give back' },
  { id: 'guard_records', decision: 'ask', test: (c) => /\.immiscible(\/|\b)/.test(c) && /(^|[;|&(]\s*)(sudo\s+)?(rm|mv|cp|truncate|unlink|shred|chmod|chown|sed|tee|ln|find)\s|>/.test(c), reason: "changing Immiscible's own records (~/.immiscible), which the guard reads to decide" },
  { id: 'sudo', decision: 'ask', test: (c) => /(^|[;|&(]\s*)sudo\s/.test(c), reason: 'a command as the administrator' },
  { id: 'world_writable', decision: 'ask', test: (c) => /\bchmod\s+(-R\s+)?(0?777|a\+w|o\+w)\b/.test(c), reason: 'making files writable by everyone' },
];

/**
 * Whether a checkpoint could put this call's harm back: 'files' when it deletes
 * or overwrites files in a working tree, 'none' when it was asked and reaches
 * past the machine (a publish, a deploy, the network), null otherwise.
 */
function lpUndoable(tool, body, decision, rule) {
  if (decision === 'deny') return null;
  // git clean -x deletes ignored files, which a checkpoint never holds.
  if (tool === 'Bash' && /\bgit\s+clean\s+-[a-zA-Z]*x/.test(body)) return decision === 'ask' ? 'none' : null;
  if (rule === 'agent_config' || rule === 'history_rewrite' || (tool === 'Bash' && LP_DESTRUCTIVE.test(body))) return 'files';
  return decision === 'ask' ? 'none' : null;
}

/**
 * Decide one tool call locally. summary: the hook's one-line summary.
 * state: { secretRead: string | null } for this session. Returns
 * { decision, rule, reason, secretRead } where secretRead is set when this
 * call read a secret file (the hook keeps it for the rest of the session).
 */
function localDecide(summary, state = {}, team = null) {
  // Longer than the rules read: a person decides, since the end is what they cannot see.
  if (/^Bash:/.test(String(summary ?? '')) && String(summary).length > 20000) return { decision: 'ask', rule: 'too_long', reason: 'Immiscible guard: this command is too long to check here, so a person should read it first.', secretRead: null, undoable: 'none' };
  const base = lpBuiltIn(summary, state);
  const t = team ? lpTeamDecide(team, summary) : null;
  // The team's rules only add: a team rule can refuse or ask about more, never allow what the built-in rules stop.
  const rank = { allow: 0, ask: 1, deny: 2 };
  if (t && rank[t.decision] > rank[base.decision]) {
    const m = /^([\w.-]+):\s?([\s\S]*)$/.exec(String(summary ?? ''));
    return { decision: t.decision, rule: t.rule, reason: t.reason, secretRead: base.secretRead, undoable: lpUndoable(m ? m[1] : '', m ? m[2] : '', t.decision, t.rule) };
  }
  return base;
}

/**
 * The team's own rules (immiscible guard --team), from ~/.immiscible/team-rules.json
 * (IMMISCIBLE_TEAM_RULES names another file): commands to refuse or ask about,
 * branches nobody pushes to straight, domains nothing reaches. Data, never
 * code: a command rule is its words, matched against each command in a call.
 * Read once per hook run; a missing or broken file is "no team rules".
 */
let lpTeamCache;
async function lpTeam() {
  if (lpTeamCache !== undefined) return lpTeamCache;
  lpTeamCache = null;
  try {
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    // The machine's file (guard --team --scope managed, for everyone) and the person's own. Both apply: each
    // can only add, so a person's file never switches the machine's rules off.
    const system = process.platform === 'win32' ? join(process.env.ProgramData || 'C:\\ProgramData', 'immiscible', 'team-rules.json') : '/etc/immiscible/team-rules.json';
    const own = process.env.IMMISCIBLE_TEAM_RULES || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.immiscible', 'team-rules.json');
    const words = (x) => (Array.isArray(x?.words) && x.words.length && x.words.every((w) => typeof w === 'string' && w && w.length <= 80) ? x.words : null);
    const list = (xs) => (Array.isArray(xs) ? xs.filter((x) => words(x) && typeof x.id === 'string').slice(0, 100) : []);
    const merged = { versions: [], deny: [], ask: [], protectedBranches: [], blockedDomains: [] };
    for (const file of [system, own]) {
      let j;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const r = j?.rules ?? {};
      if (Number.isSafeInteger(j?.version)) merged.versions.push(j.version);
      merged.deny.push(...list(r.deny));
      merged.ask.push(...list(r.ask));
      merged.protectedBranches.push(...(Array.isArray(r.protectedBranches) ? r.protectedBranches : []).filter((b) => typeof b === 'string' && /^[\w./*-]{1,100}$/.test(b)));
      merged.blockedDomains.push(...(Array.isArray(r.blockedDomains) ? r.blockedDomains : []).filter((d) => typeof d === 'string' && /^(\*\.)?[a-z0-9.-]+$/i.test(d)).map((d) => d.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')));
    }
    if (merged.versions.length || merged.deny.length || merged.ask.length || merged.protectedBranches.length || merged.blockedDomains.length) lpTeamCache = merged;
  } catch { lpTeamCache = null; }
  return lpTeamCache;
}

/** Words a shell would see in one command: quotes and backslashes taken out, quoted spaces kept. */
function lpWords(seg) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < seg.length) cur += seg[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') { q = ch; has = true; }
    else if (ch === '\\' && i + 1 < seg.length) { cur += seg[++i]; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else { cur += ch; has = true; }
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Shell keywords and wrappers that run the command after them, with how many value words their options take. */
const LP_WRAPPERS = { sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'], env: ['-u', '-C', '-S'], nice: ['-n'], ionice: ['-c', '-n'], stdbuf: ['-i', '-o', '-e'], timeout: ['-s', '-k'], xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a'], nohup: [], command: [], exec: [], builtin: [], time: [], eval: [], then: [], do: [], else: [], elif: [], if: [], while: [], until: [], '!': [] };

/** Every command a shell line runs, each as its words: through ;, &&, ||, pipes, $(...), backticks, groups, sh -c and wrappers. */
function lpCommands(body, depth = 0) {
  const text = String(body).slice(0, 20000);
  const out = [];
  const inner = [];
  // $(...) and backticks run their own commands: take them out and read them too.
  const flat = text.replace(/\$\(([^()]*)\)/g, (_, x) => { inner.push(x); return ' x '; }).replace(/`([^`]*)`/g, (_, x) => { inner.push(x); return ' x '; });
  for (const seg of flat.split(/;|&&|\|\||\||&|\n/)) {
    let w = lpWords(seg.replace(/[(){}]/g, ' '));
    for (let guard = 0; guard < 8 && w.length; guard++) {
      if (/^[A-Za-z_]\w*=/.test(w[0])) { w = w.slice(1); continue; }
      const name = w[0].replace(/^.*[\\/]/, '').toLowerCase();
      const opts = LP_WRAPPERS[name];
      if (!opts) break;
      let i = 1;
      while (i < w.length && (w[i].startsWith('-') || (name === 'env' && /^[A-Za-z_]\w*=/.test(w[i])))) i += opts.includes(w[i]) ? 2 : 1;
      // timeout's duration, then the command.
      if (name === 'timeout' && i < w.length && /^\d/.test(w[i])) i++;
      w = w.slice(i);
    }
    if (!w.length) continue;
    w[0] = w[0].replace(/^.*[\\/]/, '').toLowerCase();
    // sh -c '...', bash -lc "...": the string is the command.
    if (/^(ba|z|da|k|fi)?sh$/.test(w[0]) && depth < 3) {
      const c = w.findIndex((x) => /^-\w*c\w*$/.test(x));
      if (c >= 0 && w[c + 1] != null) { out.push(...lpCommands(w[c + 1], depth + 1)); continue; }
    }
    out.push(w);
  }
  if (depth < 3) for (const x of inner) out.push(...lpCommands(x, depth + 1));
  return out;
}

const lpGlob = (pattern, name) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name);

/** A host from a word: a URL, user@host:path, or a bare domain with or without a path. */
function lpHostOf(word) {
  const w = String(word);
  if (/^[a-z][\w+.-]*:\/\//i.test(w)) { try { return new URL(w).hostname.toLowerCase().replace(/\.$/, '') || null; } catch { return null; } }
  const m = /^(?:[^@/\s]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,63})\.?(?:[:/]|$)/i.exec(w);
  return m ? m[1].toLowerCase() : null;
}
const LP_NET_PROGRAMS = /^(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|ftp|http|https|xh|aria2c|git|ping|dig|nslookup|host)$/;

/** The team's decision on one call, or null. */
function lpTeamDecide(team, summary) {
  const s = String(summary ?? '');
  const m = /^([\w.-]+):\s?([\s\S]*)$/.exec(s);
  const tool = m ? m[1] : '';
  const body = m ? m[2] : s;
  const said = (decision, id, reason) => ({ decision, rule: `team:${id}`, reason: `Immiscible guard, your team's rule: ${reason}.` });
  const cmds = tool === 'Bash' ? lpCommands(body) : [];
  // Every address the call names: URLs anywhere, and hosts given to a program that reaches the network.
  const hosts = [...body.matchAll(/\b[a-z][\w+.-]*:\/\/[^\s'"<>`)]+/gi)].map((x) => lpHostOf(x[0])).filter(Boolean);
  for (const w of cmds) if (LP_NET_PROGRAMS.test(w[0])) for (const x of w.slice(1)) { const h = x.startsWith('-') ? null : lpHostOf(x); if (h) hosts.push(h); }
  const blocked = hosts.find((h) => team.blockedDomains.some((d) => h === d || h.endsWith(`.${d}`)));
  if (blocked) return said('deny', 'blocked_domain', `nothing here reaches ${blocked}`);
  if (tool !== 'Bash') return null;
  const hit = (rule) => cmds.some((w) => w[0] === rule.words[0].toLowerCase() && rule.words.slice(1).every((x) => w.includes(x)));
  for (const r of team.deny) if (hit(r)) return said('deny', r.id, r.reason || `${r.words.join(' ')} is refused here`);
  if (team.protectedBranches.length) {
    for (const w of cmds) {
      const at = w.indexOf('push');
      if (w[0] !== 'git' || at < 0) continue;
      const args = w.slice(at + 1);
      const flags = args.filter((x) => x.startsWith('-'));
      const forcedAll = flags.some((x) => /^(--force(-with-lease)?(=.*)?|-[a-zA-Z]*f[a-zA-Z]*)$/.test(x));
      if (flags.some((x) => x === '--mirror')) return said('deny', 'protected_branch', 'a mirror push can rewrite or delete protected branches');
      const deleting = flags.some((x) => x === '--delete' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(x));
      // Positional words: the remote, then refspecs. Options that take a value are skipped with it.
      const pos = [];
      for (let i = 0; i < args.length; i++) {
        if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(args[i])) { i++; continue; }
        if (!args[i].startsWith('-')) pos.push(args[i]);
      }
      const refspecs = pos.slice(1);
      const named = (b) => team.protectedBranches.find((p) => lpGlob(p, b.replace(/^refs\/heads\//, '')));
      if (flags.includes('--all') || flags.includes('--branches')) {
        const p = team.protectedBranches[0];
        if (forcedAll) return said('deny', 'protected_branch', `a forced push of every branch includes ${p}`);
        return said('ask', 'protected_branch', `pushing every branch includes ${p}, which is protected`);
      }
      if (!refspecs.length) {
        // No refspec: the current branch, when the hook could tell it.
        const cur = team.currentBranch ? named(team.currentBranch) : null;
        if (cur) return forcedAll ? said('deny', 'protected_branch', `${team.currentBranch} is protected, so it is never force pushed`) : said('ask', 'protected_branch', `${team.currentBranch} is protected: changes reach it through review, not a push`);
        continue;
      }
      for (const spec of refspecs) {
        const forced = forcedAll || spec.startsWith('+');
        const raw = spec.replace(/^\+/, '');
        const colon = raw.indexOf(':');
        const src = colon >= 0 ? raw.slice(0, colon) : raw;
        let dst = colon >= 0 ? raw.slice(colon + 1) : raw;
        if (colon < 0 && dst === 'HEAD') dst = team.currentBranch ?? 'HEAD';
        const b = named(dst);
        if (!b) continue;
        const branch = dst.replace(/^refs\/heads\//, '');
        if (deleting || (colon >= 0 && !src)) return said('deny', 'protected_branch', `${branch} is protected, so it is never deleted`);
        if (forced) return said('deny', 'protected_branch', `${branch} is protected, so it is never force pushed`);
        return said('ask', 'protected_branch', `${branch} is protected: changes reach it through review, not a push`);
      }
    }
  }
  for (const r of team.ask) if (hit(r)) return said('ask', r.id, r.reason || `${r.words.join(' ')} needs a person here`);
  return null;
}

/** The built-in rules alone. */
function lpBuiltIn(summary, state = {}) {
  const s = String(summary ?? '');
  const m = /^([\w.-]+):\s?([\s\S]*)$/.exec(s);
  const tool = m ? m[1] : '';
  const body = m ? m[2] : s;
  const said = (decision, rule, reason, secretRead = null) => ({ decision, rule, reason, secretRead, undoable: lpUndoable(tool, body, decision, rule) });
  if (tool === 'Bash') {
    for (const r of LP_RULES) {
      if (!r.test(body)) continue;
      // Redirect decisions: a refused command may have a safer form; it is suggested, never run for the agent.
      const safer = r.suggest ? r.suggest(body) : null;
      const offer = safer && safer !== body && !LP_RULES.some((x) => x.decision === 'deny' && x.test(safer)) ? ` Try instead: ${safer}` : '';
      return { ...said(r.decision, r.id, `Immiscible guard: ${r.reason}.${offer}`), ...(offer ? { suggestion: safer } : {}) };
    }
    const secret = LP_SECRET.exec(body);
    const readsSecret = secret && !LP_PUBLIC_KEY.test(body) ? secret[2] : null;
    if (state.secretRead && (LP_NETWORK.test(body) || LP_UPLOAD.test(body))) {
      return said('ask', 'secret_then_network', `Immiscible guard: this session read ${state.secretRead} earlier, and this command reaches the network. A person should check nothing secret leaves.`, readsSecret);
    }
    return said('allow', null, null, readsSecret);
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const file = body.trim();
    if (/(^|\/)\.immiscible\//.test(file)) return said('ask', 'guard_records', `Immiscible guard: ${file} is one of Immiscible's own records, which the guard reads to decide.`);
    if (LP_CONFIG_FILE.test(file)) return said('ask', 'agent_config', `Immiscible guard: ${file} decides what coding agents and shells run on their own; changes to it are how a hook or a backdoor gets in.`);
    return said('allow', null, null);
  }
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    const secret = LP_SECRET.exec(` ${body}`);
    return said('allow', null, null, secret && !LP_PUBLIC_KEY.test(body) ? secret[2] : null);
  }
  if (tool === 'WebFetch' || tool === 'WebSearch' || /^mcp__/.test(tool)) {
    if (state.secretRead && tool !== 'WebSearch') return said('ask', 'secret_then_network', `Immiscible guard: this session read ${state.secretRead} earlier, and this call reaches outside the machine. A person should check nothing secret leaves.`);
    return said('allow', null, null);
  }
  return said('allow', null, null);
}
/**
 * The session's local state: whether it has read a secret file. Kept in
 * ~/.immiscible/state (IMMISCIBLE_STATE_DIR in tests) under a hash of the
 * agent and session id, holding the path's short form only, never contents;
 * a secret read counts for a day, and files untouched for 7 days are swept.
 * Any failure is "no state", never a crash.
 */
async function lpState(client, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return { state: {}, save: async () => {} };
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const dir = process.env.IMMISCIBLE_STATE_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.immiscible', 'state');
  const file = join(dir, `${createHash('sha256').update(`${client}:${sessionId}`).digest('hex').slice(0, 24)}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { state = {}; }
  const save = async (next) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ ...next, at: Date.now() }), { mode: 0o600 });
      for (const f of fs.readdirSync(dir)) {
        const p = join(dir, f);
        if (f.endsWith('.json') && Date.now() - fs.statSync(p).mtimeMs > 7 * 86_400_000) fs.rmSync(p, { force: true });
      }
    } catch { /* state is a help, never a reason to fail */ }
  };
  return { state, save };
}

/**
 * Credentials replaced before anything is written to the decision log or a
 * checkpoint's message: by their published shapes, after a name that says
 * what they are (GITHUB_TOKEN=, PGPASSWORD=, --password, a URL's user:pass@,
 * Bearer), and any value that looks random (a long run of letters and digits
 * together). The CLI's redactSecrets is the same; a test keeps them equal.
 */
const LP_REDACT = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)|(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])|(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}|(?<![A-Za-z0-9])gh[pousr]_[0-9A-Za-z]{36,}|(?<![A-Za-z0-9])github_pat_[0-9A-Za-z_]{60,}|(?<![A-Za-z0-9])sk-[0-9A-Za-z_-]{20,}|(?<![A-Za-z0-9])xox[abprs]-[0-9A-Za-z-]{20,}|(?<![A-Za-z0-9])npm_[0-9A-Za-z]{36}|(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}|((?<![A-Za-z0-9])[A-Za-z0-9_]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_]*\s*[=:]\s*["']?)[^\s'"&]{6,}|((?:^|\s)--?(?:token|password|passwd|secret|api-key|key)(?:\s+|=)["']?)[^\s'"&-][^\s'"&]{5,}|(\bBearer\s+)[0-9A-Za-z._~+\/-]{16,}=*|(:\/\/[^\s:\/@]+:)[^\s@\/]+(?=@)/gi;
const LP_LOOSE = /[A-Za-z0-9_+.-]{16,}=*/g;
const lpLooksRandom = (t) => !/^[0-9a-f-]+$/i.test(t) && t.split(/[-_.]/).some((p) => p.length >= 16 && /[A-Za-z]/.test(p) && /\d/.test(p));
function lpRedact(s) {
  return String(s ?? '')
    .replace(LP_REDACT, (m, _end, kv, flag, bearer, url) => (kv ? `${kv}[redacted]` : flag ? `${flag}[redacted]` : bearer ? `${bearer}[redacted]` : url ? `${url}[redacted]` : '[redacted]'))
    .replace(LP_LOOSE, (t) => (lpLooksRandom(t) ? '[redacted]' : t));
}

/**
 * The flight recorder's local half: every decision a local hook makes is
 * appended to ~/.immiscible/decisions/<YYYY-MM-DD>.jsonl, each line holding the
 * hash of the one before, so a removed or edited line shows. Commands are
 * cut to 300 characters with credentials redacted, and the directory the call
 * ran in is kept; `immiscible replay` reads it beside the agents' own history,
 * and `immiscible scan` reads it for agents whose own history it cannot.
 * Never fails the call.
 */
async function lpLog(client, sessionId, summary, d, dir = null) {
  try {
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const { createHash } = await import('node:crypto');
    const logDir = process.env.IMMISCIBLE_LOG_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.immiscible', 'decisions');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const now = new Date();
    const file = join(logDir, `${now.toISOString().slice(0, 10)}.jsonl`);
    let prev = null;
    try {
      const text = fs.readFileSync(file, 'utf8').trimEnd();
      prev = JSON.parse(text.slice(text.lastIndexOf('\n') + 1)).hash ?? null;
    } catch { prev = null; }
    const entry = { at: now.toISOString(), client, session: typeof sessionId === 'string' ? sessionId.slice(0, 128) : null, summary: lpRedact(summary).slice(0, 300), decision: d.decision, rule: d.rule, reason: d.reason, ...(typeof dir === 'string' && dir ? { dir: dir.slice(0, 300) } : {}), ...(d.after ? { after: true } : {}), ...(d.checkpoint ? { checkpoint: d.checkpoint.id, repo: d.checkpoint.repo } : {}), prev };
    entry.hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch { /* the record is a help, never a reason to fail */ }
}

/**
 * Undo before approve: a checkpoint of a git working tree, taken before a call
 * that deletes or overwrites files. Tracked and untracked files (not ignored
 * ones, and never secret files such as .env or keys) are written as a commit
 * under refs/immiscible/checkpoints/<id>, with the index file itself kept as a
 * blob so staged work, conflicts and sparse checkouts come back as they were.
 * git push sends branches and tags, never this namespace (only --mirror
 * would, which is why secret files are left out); checkpoints older than 7
 * days are deleted as new ones are taken. `immiscible undo <id>` puts the
 * files back. Any failure, a large untracked tree or a directory outside a
 * repository is "no checkpoint", never a refusal.
 */
async function lpCheckpoint(dir, summary) {
  if (!dir) return null;
  try {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const ident = { GIT_AUTHOR_NAME: 'immiscible', GIT_AUTHOR_EMAIL: 'checkpoint@immiscible.invalid', GIT_COMMITTER_NAME: 'immiscible', GIT_COMMITTER_EMAIL: 'checkpoint@immiscible.invalid' };
    const git = (args, extra = {}) => {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...ident, ...extra }, stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    const root = git(['rev-parse', '--show-toplevel']);
    if (!root) return null;
    const untracked = git(['ls-files', '-o', '--exclude-standard', '-z', '--', ':/']);
    if (untracked == null || untracked.split('\0').length > 5000) return null;
    const indexFile = git(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const tmp = join(tmpdir(), `immiscible-index-${process.pid}-${Date.now()}`);
    let tree = null;
    try {
      if (indexFile && fs.existsSync(indexFile)) fs.copyFileSync(indexFile, tmp);
      if (git(['add', '-A', '--', ':/', ...LP_CHECKPOINT_SKIP.map((g) => `:(exclude,glob)**/${g}`)], { GIT_INDEX_FILE: tmp }) == null) return null;
      tree = git(['write-tree'], { GIT_INDEX_FILE: tmp });
    } finally { fs.rmSync(tmp, { force: true }); }
    if (!tree) return null;
    const indexBlob = indexFile && fs.existsSync(indexFile) ? git(['hash-object', '-w', '--', indexFile]) : null;
    const head = git(['rev-parse', '-q', '--verify', 'HEAD']);
    const message = `immiscible checkpoint\n\ncommand: ${lpRedact(summary).replace(/\s+/g, ' ').slice(0, 200)}\nworktree: ${root}\n${indexBlob ? `index-file: ${indexBlob}\n` : ''}`;
    const commit = git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message]);
    if (!commit) return null;
    const id = commit.slice(0, 10);
    if (git(['update-ref', `refs/immiscible/checkpoints/${id}`, commit]) == null) return null;
    const week = Math.floor(Date.now() / 1000) - 7 * 86400;
    for (const line of (git(['for-each-ref', '--format=%(refname) %(committerdate:unix)', 'refs/immiscible/checkpoints']) ?? '').split('\n')) {
      const [ref, at] = line.split(' ');
      if (ref && Number(at) < week) git(['update-ref', '-d', ref]);
    }
    return { id, repo: root };
  } catch { return null; }
}

/**
 * Decide one call locally, keep the session's state, take a checkpoint when
 * the call could be undone, and log the decision: the one entry point the
 * hooks use. where: { dir, canAsk }: the directory the call runs in, and
 * whether this agent can ask the person (Claude Code and Cursor can).
 */
async function localGuard(client, sessionId, summary, where = {}) {
  const { state, save } = await lpState(client, sessionId);
  const fresh = state.secretRead && Date.now() - (state.secretReadAt ?? state.at ?? 0) < 86_400_000;
  let team = await lpTeam();
  // A push with no branch named goes to the current one: ask git, only when a team rule could care.
  if (team?.protectedBranches.length && where.dir && /\bgit\b[\s\S]*\bpush\b/.test(String(summary))) {
    try {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('git', ['-C', where.dir, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.status === 0 && r.stdout.trim()) team = { ...team, currentBranch: r.stdout.trim() };
    } catch { /* no branch known: a push with no refspec is judged by its words alone */ }
  }
  const d = localDecide(summary, fresh ? state : { ...state, secretRead: null }, team);
  if (d.secretRead && !fresh) await save({ ...state, secretRead: d.secretRead, secretReadAt: Date.now() });
  // A call put to the person at the keyboard, by an agent whose after-call hook says when it ran: kept for a
  // day in a file of its own (so the two hooks never write over each other's state), and logged as answerable.
  if (d.decision === 'ask' && where.canAsk && where.after) {
    const q = await lpState(`${client}#asked`, sessionId);
    const asked = (Array.isArray(q.state.asked) ? q.state.asked : []).filter((x) => Date.now() - (x?.at ?? 0) < 86_400_000).slice(-49);
    asked.push({ summary: lpRedact(summary).slice(0, 300), rule: d.rule ?? null, at: Date.now() });
    await q.save({ asked });
    d.after = true;
  }
  const runs = d.decision === 'allow' || (d.decision === 'ask' && where.canAsk);
  if (runs && d.undoable === 'files' && process.env.IMMISCIBLE_CHECKPOINTS !== 'off') {
    // An edit is checkpointed in the repository that holds the file, wherever the agent runs.
    const file = /^(Write|Edit|MultiEdit|NotebookEdit): (\/.+)$/.exec(String(summary ?? ''))?.[2];
    d.checkpoint = await lpCheckpoint(file ? file.slice(0, file.lastIndexOf('/')) || '/' : where.dir, summary);
    // A command that reaches past the repository (../, ~, another absolute path, git -C) is not what the checkpoint holds.
    if (d.checkpoint && !file) {
      const body = String(summary).replace(/^[\w.-]+:\s?/, '');
      const root = d.checkpoint.repo;
      const outside = /(^|[\s=])(~|\$HOME)(\/|\s|$)|(^|[\s/=])\.\.(\/|\s|$)|\bgit\s+-C\s/.test(body)
        || [...body.matchAll(/(?:^|[\s=])(\/[^\s;|&'"]*)/g)].some((m) => m[1] !== root && !m[1].startsWith(`${root}/`) && !/^\/dev\/null$/.test(m[1]));
      if (outside) d.checkpoint = { ...d.checkpoint, partial: true };
    }
  }
  if (d.decision === 'ask' && where.canAsk) {
    d.reason += d.checkpoint && !d.checkpoint.partial ? ` If you approve, it can be undone: npx immiscible undo ${d.checkpoint.id}` : ' This one cannot be undone from here.';
  }
  if (process.env.IMMISCIBLE_LOCAL_LOG !== 'off') await lpLog(client, sessionId, summary, d, where.dir);
  return d;
}
/**
 * After a call ran (Factory Droid's PostToolUse, Cursor's afterShellExecution
 * and afterMCPExecution): when the person had been asked about it, log that
 * they let it run, so scan and replay know an ask was answered yes. Anything
 * else is not logged; the log keeps decisions, not every call.
 */
async function localRan(client, sessionId, summary) {
  const { state, save } = await lpState(`${client}#asked`, sessionId);
  const asked = Array.isArray(state.asked) ? state.asked : [];
  const want = lpRedact(summary).slice(0, 300);
  const i = asked.findIndex((x) => x?.summary === want);
  if (i < 0) return false;
  const [hit] = asked.splice(i, 1);
  await save({ asked });
  if (process.env.IMMISCIBLE_LOCAL_LOG !== 'off') await lpLog(client, sessionId, summary, { decision: 'ran', rule: hit.rule ?? null, reason: 'the person let it run' });
  return true;
}

/**
 * Agent configuration integrity (Claude Code). Claude Code reloads its
 * settings files when they change mid-session and runs the ConfigChange hook
 * for each change it detects; exit 2 or {"decision":"block"} keeps the change
 * from taking effect, except for managed (policy) settings.
 * https://code.claude.com/docs/en/hooks#configchange
 *
 * At SessionStart the hook notes what the session started with: the hooks,
 * the broad permission rules, bypass mode and the MCP switches of the user,
 * project and local settings files. A change during the session that adds a
 * hook, widens permissions, turns on bypass mode or every project MCP server,
 * adds an MCP server or an apiKeyHelper, or turns hooks off is blocked: that
 * is how a planted hook (the Shai-Hulud worm's SessionStart hook) or a
 * script run by the agent gets in. Anything else goes through. A person who
 * made the change restarts Claude Code to load it.
 */
/** Immiscible's own hook, exactly as guard and init install it: a command naming one of its hook files, or the server's hook URL. */
const LP_OUR_HOOK = /^(node (--env-file-if-exists="[^"]*" )?"[^"]*(\/\.immiscible\/claude-code-hook\.mjs|\/immiscible\/claude-code-hook\.mjs|\/\.claude\/hooks\/immiscible-claude-code-hook\.mjs)" \|\| exit 2|https?:\/\/\S+\/v1\/hooks\/claude-code)$/;
/** Settings keys that hold a command Claude Code runs, and environment variables that change what runs or where traffic goes. */
const LP_HELPERS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'statusLine', 'fileSuggestion'];
const LP_RISKY_ENV = ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'PATH', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'IMMISCIBLE_MODE', 'IMMISCIBLE_URL', 'IMMISCIBLE_LOCAL_LOG', 'IMMISCIBLE_CHECKPOINTS'];
/**
 * The facts of one settings file that matter here. Hook commands are kept as
 * a hash beside the event and the program's name, never their arguments, and
 * helper commands and risky environment values only as hashes, so a token on
 * a command line is not copied into the state or the log.
 */
async function lpConfigFacts(settings) {
  const { createHash } = await import('node:crypto');
  const o = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const hooks = [];
  let ours = false;
  for (const [event, list] of Object.entries(o.hooks && typeof o.hooks === 'object' ? o.hooks : {})) {
    for (const e of Array.isArray(list) ? list : []) {
      for (const h of Array.isArray(e?.hooks) ? e.hooks : []) {
        const what = String(typeof h?.command === 'string' ? h.command : typeof h?.url === 'string' ? h.url : JSON.stringify(h ?? null));
        if (LP_OUR_HOOK.test(what)) { ours = true; continue; }
        const program = typeof h?.command === 'string' ? (what.trim().split(/\s+/)[0] ?? '').replace(/^.*\//, '').slice(0, 40) : h?.type === 'http' ? 'an http hook' : (h?.type ?? 'a hook');
        hooks.push(`${event} ${program} ${createHash('sha256').update(`${event}\n${what}`).digest('hex').slice(0, 16)}`);
      }
    }
  }
  const p = o.permissions && typeof o.permissions === 'object' ? o.permissions : {};
  // An allow rule that lets anything run or be written: an interpreter, a shell, network tools, any file.
  const broad = (r) => typeof r === 'string' && /^(\*|Bash|Write|Edit|MultiEdit|WebFetch|mcp__.*|Bash\((\*|:\*|(sudo|bash|sh|zsh|fish|dash|node|python\d*(\.\d+)?|ruby|perl|php|deno|bun|npx|pnpx|bunx|eval|exec|env|xargs|curl|wget|nc|ssh|scp|rm|git push|chmod|dd)\b[^)]*)\)|(Write|Edit|MultiEdit|Read)\((\*|\*\*|\/\*\*|~\/\*\*|\/\/\*\*)\))$/.test(r.trim());
  const hash = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
  const helpers = {};
  for (const k of LP_HELPERS) if (o[k] != null) helpers[k] = hash(o[k]);
  const env = {};
  const e = o.env && typeof o.env === 'object' ? o.env : {};
  for (const k of LP_RISKY_ENV) if (e[k] != null) env[k] = hash(e[k]);
  const plugins = Object.entries(o.enabledPlugins && typeof o.enabledPlugins === 'object' ? o.enabledPlugins : {}).filter(([, on]) => on).map(([k]) => k.slice(0, 120));
  const markets = Object.keys(o.extraKnownMarketplaces && typeof o.extraKnownMarketplaces === 'object' ? o.extraKnownMarketplaces : {}).map((k) => k.slice(0, 120));
  return {
    hooks,
    ours,
    allow: (Array.isArray(p.allow) ? p.allow : []).filter(broad).map((r) => r.trim().slice(0, 80)),
    bypass: p.defaultMode === 'bypassPermissions' || o.defaultMode === 'bypassPermissions',
    hooksOff: o.disableAllHooks === true,
    allMcp: o.enableAllProjectMcpServers === true,
    mcp: Array.isArray(o.enabledMcpjsonServers) ? o.enabledMcpjsonServers.filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)) : [],
    helpers,
    env,
    plugins,
    markets,
  };
}

/** What a change adds that a session should not pick up mid-way: plain phrases, empty when nothing. */
function lpConfigRisks(before, after) {
  const out = [];
  const added = (k) => after[k].filter((x) => !before[k].includes(x));
  for (const h of added('hooks')) {
    const [event, program] = h.split(' ');
    out.push(`adds a ${event} hook that runs ${program}`);
  }
  if (before.ours && !after.ours) out.push("removes Immiscible's hook");
  if (after.hooksOff && !before.hooksOff) out.push('turns every hook off');
  for (const r of added('allow')) out.push(`allows ${r} without asking`);
  if (after.bypass && !before.bypass) out.push('turns on bypass permissions');
  if (after.allMcp && !before.allMcp) out.push("turns on every project's MCP servers");
  for (const m of added('mcp')) out.push(`turns on the MCP server ${m}`);
  for (const [k, v] of Object.entries(after.helpers ?? {})) if ((before.helpers ?? {})[k] !== v) out.push(`sets the ${k} command`);
  for (const [k, v] of Object.entries(after.env ?? {})) if ((before.env ?? {})[k] !== v) out.push(`changes ${k}`);
  for (const k of Object.keys(before.env ?? {})) if (/^IMMISCIBLE_/.test(k) && !(k in (after.env ?? {}))) out.push(`removes ${k}`);
  for (const x of after.plugins ?? []) if (!(before.plugins ?? []).includes(x)) out.push(`turns on the plugin ${x}`);
  for (const x of after.markets ?? []) if (!(before.markets ?? []).includes(x)) out.push(`adds the plugin marketplace ${x}`);
  return out;
}

/** The settings files a source names, as Claude Code lays them out. */
function lpSettingsFiles(cwd, home) {
  return {
    user_settings: `${home}/.claude/settings.json`,
    project_settings: cwd ? `${cwd}/.claude/settings.json` : null,
    local_settings: cwd ? `${cwd}/.claude/settings.local.json` : null,
  };
}

/**
 * SessionStart and ConfigChange for Claude Code in local mode. Returns
 * { block: reason } to keep a change out, or {} to let it through; never
 * throws. The session's starting point is kept in its local state.
 */
async function localConfigGuard(event) {
  try {
    const fs = await import('node:fs');
    const { homedir } = await import('node:os');
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    const cwd = typeof event.cwd === 'string' && event.cwd.startsWith('/') ? event.cwd : null;
    const files = lpSettingsFiles(process.env.CLAUDE_PROJECT_DIR || cwd, home);
    const factsOf = async (file) => {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? lpConfigFacts({}) : null; }
      try { return lpConfigFacts(JSON.parse(text)); } catch { return null; }
    };
    const { state, save } = await lpState('claude-code', event.session_id);
    if (event.hook_event_name === 'SessionStart') {
      const config = {};
      for (const [source, file] of Object.entries(files)) if (file) config[source] = { file, facts: (await factsOf(file)) ?? (await lpConfigFacts({})) };
      await save({ ...state, config });
      // A project hook seen for the first time is named once: SessionStart cannot stop it, but a person can look.
      const project = config.project_settings?.facts?.hooks ?? [];
      const local = config.local_settings?.facts?.hooks ?? [];
      const knownFile = `${home}/.immiscible/known-hooks.json`;
      let known = [];
      try { known = JSON.parse(fs.readFileSync(knownFile, 'utf8')); } catch { known = []; }
      const fresh = [...project, ...local].filter((h) => !known.includes(h));
      if (!fresh.length) return {};
      try {
        fs.mkdirSync(`${home}/.immiscible`, { recursive: true, mode: 0o700 });
        fs.writeFileSync(knownFile, JSON.stringify([...known, ...fresh].slice(-2000)), { mode: 0o600 });
      } catch { /* a warning repeated next time is fine */ }
      const [event0, program0] = fresh[0].split(' ');
      return { warn: `Immiscible guard: this project's .claude settings run ${fresh.length === 1 ? `a ${event0} hook (${program0})` : `${fresh.length} hooks, among them a ${event0} hook (${program0})`} that ${fresh.length === 1 ? 'is' : 'are'} not Immiscible's and new to this machine. Planted hooks spread this way; check .claude/settings.json, or run npx immiscible scan.` };
    }
    const source = typeof event.source === 'string' ? event.source : null;
    if (source === 'policy_settings' || source === 'skills') return {};
    const file = typeof event.file_path === 'string' && event.file_path ? event.file_path : files[source] ?? null;
    if (!file) return {};
    const key = Object.keys(files).find((k) => files[k] === file) ?? source ?? file;
    const now = await factsOf(file);
    if (!now) return {}; // not JSON: Claude Code cannot load it either
    const start = state.config?.[key]?.facts ?? null;
    // No starting point (the guard arrived mid-session, or the records were removed): judge the file as it stands.
    const risks = lpConfigRisks(start ?? (await lpConfigFacts({})), now);
    const short = file.startsWith(home) ? `~${file.slice(home.length)}` : file;
    const d = risks.length
      ? { decision: 'deny', rule: 'config_change', reason: `Immiscible guard: ${short} changed during this session, and the change ${risks.slice(0, 3).join('; ')}. It is kept out of this session: that is how a planted hook gets in. If you made the change, restart Claude Code to load it.` }
      : { decision: 'allow', rule: null, reason: null };
    if (!risks.length) await save({ ...state, config: { ...state.config, [key]: { file, facts: now } } });
    if (process.env.IMMISCIBLE_LOCAL_LOG !== 'off') await lpLog('claude-code', event.session_id, `ConfigChange: ${short}`, d);
    return risks.length ? { block: d.reason } : {};
  } catch { return {}; }
}
// <<< immiscible local policy

/**
 * Where this hook file is installed, for the coverage report: managed (beside
 * the agent's managed configuration, in an immiscible folder) or user
 * (~/.immiscible, from immiscible install or guard). Read from its own path.
 */
function installScope() {
  const at = decodeURIComponent(new URL(import.meta.url).pathname).replace(/\\/g, '/');
  if (/\/\.immiscible\/coding-agent-hook\.mjs$/.test(at)) return 'user';
  if (/\/immiscible\/coding-agent-hook\.mjs$/.test(at)) return 'managed';
  return 'unknown';
}

async function main() {
  const { agent, wait: waitArg, selfTest, after } = parseArgv(process.argv.slice(2));
  // Installed after the call (--after): it has nothing to decide, so whatever happens it never blocks or complains.
  if (after) {
    try {
      const event = JSON.parse(await readStdin());
      const post = afterCall(agent, event) ?? (agent === 'droid' ? { ...event, hook_event_name: 'PreToolUse' } : null);
      if (post && env('MODE') === 'local') {
        const done = callsOf(agent, post);
        const { session: ses } = sessionOf(agent, event);
        if (Array.isArray(done)) for (const c of done.filter((x) => x !== SKIP)) await localRan(CLIENT[agent], ses?.id ?? null, c.full ?? c.summary);
      }
    } catch { /* a record, never a reason to fail */ }
    process.exit(0);
  }
  // The installer runs this once after copying the file: proof that this node can run it.
  if (selfTest) {
    process.stdout.write(`${JSON.stringify({ ok: AGENTS.includes(agent), node: process.versions.node, agent })}\n`);
    process.exit(AGENTS.includes(agent) ? 0 : 1);
  }
  if (!AGENTS.includes(agent)) {
    process.stderr.write(`Immiscible hook (failing closed): --agent must be one of ${AGENTS.join(', ')}.\n`);
    process.exit(2);
  }
  const refuse = (why) => answer(agent, 'deny', `Immiscible hook (failing closed): ${why}`);
  const base = (env('URL') || 'https://immiscible.ai').replace(/\/$/, '');
  const key = env('AGENT_KEY');
  const timeoutMs = Math.min(Number(env('TIMEOUT_MS')) || 10_000, MAX_TIMEOUT_MS);
  const waitS = env('APPROVAL_WAIT_S') !== '' && Number.isFinite(Number(env('APPROVAL_WAIT_S'))) ? Math.max(0, Number(env('APPROVAL_WAIT_S'))) : waitArg;

  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return refuse(`could not read the tool call from ${LABEL[agent]}.`);
  }
  // After a call ran (Droid's PostToolUse, Cursor's after hooks): nothing to decide. In local mode, a call
  // the person was asked about is logged as run; it never fails or holds anything up.
  const post = afterCall(agent, event);
  if (post) {
    try {
      if (env('MODE') === 'local') {
        const done = callsOf(agent, post);
        const { session: ses } = sessionOf(agent, event);
        if (Array.isArray(done)) for (const c of done.filter((x) => x !== SKIP)) await localRan(CLIENT[agent], ses?.id ?? null, c.full ?? c.summary);
      }
    } catch { /* a record, never a reason to fail */ }
    process.exit(0);
  }
  const found = callsOf(agent, event);
  if (found.error) return refuse(`${found.error}, so this tool call cannot be checked.`);
  const calls = found.filter((c) => c !== SKIP);
  // An event that is not a tool call (a hook wired to the wrong event) is not ours to judge.
  if (!calls.length) return answer(agent, 'allow');
  const { session, call: callId } = sessionOf(agent, event);
  if (env('MODE') === 'local') {
    // immiscible guard: decided here, with nothing sent anywhere. Only Cursor can
    // ask the person at the keyboard; the others refuse with the way to go ahead.
    for (const [n, c] of calls.entries()) {
      const d = await localGuard(CLIENT[agent], session?.id ?? null, c.full ?? c.summary, { dir: projectOf(agent, event)?.cwd ?? null, canAsk: CAN_ASK.has(agent), after: CAN_ASK.has(agent) });
      const of = calls.length > 1 ? ` (file ${n + 1} of ${calls.length})` : '';
      if (d.decision === 'deny') return answer(agent, 'deny', `${d.reason}${of} Refused on this machine; to allow it, run it yourself.`);
      if (d.decision === 'ask') {
        if (CAN_ASK.has(agent)) return answer(agent, 'ask', `${d.reason}${of}`);
        return answer(agent, 'deny', `${d.reason}${of} ${LABEL[agent]} cannot ask you from a hook, so it did not run: run it yourself if you meant it, or connect a phone for approvals with npx immiscible guard --connect.`);
      }
    }
    return answer(agent, 'allow');
  }
  if (!key) return refuse('IMMISCIBLE_AGENT_KEY is not set, so this tool call cannot be checked.');
  const project = projectOf(agent, event);
  const provenance = [{ source: 'agent', detail: `${LABEL[agent]} tool call` }];

  for (const [n, c] of calls.entries()) {
    const body = {
      type: 'tool.call',
      summary: c.summary,
      ...(c.domain ? { target: { domain: c.domain } } : c.recipient ? { target: { recipient: c.recipient } } : {}),
      provenance,
      ...(project ? { project } : {}),
      ...(session ? { session } : {}),
      // One key per file of a patch, so a retry of the same call is the same request.
      ...(callId ? { idempotencyKey: calls.length > 1 ? `${callId}:${createHash('sha256').update(c.summary).digest('hex').slice(0, 16)}` : callId } : {}),
      hook: { transport: 'command', scope: installScope() },
    };
    let r;
    try {
      r = await call(base, key, 'POST', '/v1/actions/authorize', body, timeoutMs);
    } catch (err) {
      return refuse(err?.name === 'TimeoutError' ? `no answer from Immiscible within ${timeoutMs}ms.` : `Immiscible could not be reached (${err.message}).`);
    }
    if (!r.res.ok) return refuse(r.json?.error?.message ?? `Immiscible answered ${r.res.status}.`);
    if (!r.json) return refuse(`Immiscible answered ${r.res.status} with something that is not a decision.`);
    let d = r.json;
    const of = calls.length > 1 ? ` (file ${n + 1} of ${calls.length})` : '';
    if (d.decision === 'approval_required' && CAN_ASK.has(agent)) {
      return answer(agent, 'ask', `Immiscible asks for a person${of}: ${reasonsOf(d)}${d.approval?.url ? ` Approve or deny at ${d.approval.url}` : ''}`);
    }
    if (d.decision === 'approval_required') {
      // No "ask" in this agent: wait for the person's answer, then decide.
      const until = Date.now() + waitS * 1000;
      while (d.decision === 'approval_required' && d.id && Date.now() < until) {
        await sleep(Math.min(2000, Math.max(0, until - Date.now())));
        try {
          const p = await call(base, key, 'GET', `/v1/actions/${encodeURIComponent(d.id)}`, null, timeoutMs);
          if (p.res.ok && p.json?.decision) d = { ...d, ...p.json };
          else if (!p.res.ok && p.res.status !== 429) return refuse(p.json?.error?.message ?? `Immiscible answered ${p.res.status} while waiting for a person.`);
        } catch (err) {
          return refuse(`Immiscible could not be reached while waiting for a person (${err.message}).`);
        }
      }
      if (d.decision === 'approval_required') {
        const waited = waitS > 0 ? `No one answered within ${waitS} seconds, so it did not run. ` : '';
        return answer(agent, 'deny', `Immiscible needs a person to approve this${of}: ${reasonsOf(d)} ${waited}${d.approval?.url ? `Approve or deny at ${d.approval.url}` : 'See Approvals in the console.'}`.replace(/\s+/g, ' ').trim());
      }
    }
    if (d.decision === 'deny') return answer(agent, 'deny', `Immiscible refused${of}: ${reasonsOf(d) || 'a person or a rule said no.'}`);
    if (d.decision !== 'allow') return refuse('Immiscible returned no decision.');
  }
  return answer(agent, 'allow');
}

main().catch((err) => answer(parseArgv(process.argv.slice(2)).agent, 'deny', `Immiscible hook (failing closed): ${err.message}`));
