/**
 * Managed hook installers for the coding agents other than Claude Code:
 * Codex, Cursor, Windsurf, Gemini CLI, Factory Droid, opencode and Amp. Each writes one entry that runs
 * hook/coding-agent-hook.mjs (the repository's scripts/coding-agent-hook.mjs)
 * before a shell command, an MCP tool call and, where the agent has the
 * event, a file write. Pure planning here; commands/install-agents.mjs
 * shows and writes.
 *
 * Paths and formats, from each vendor's documentation as of October 2026:
 *
 *   Codex       https://developers.openai.com/codex/hooks
 *     user      $CODEX_HOME/hooks.json (~/.codex/hooks.json): { "hooks": { "PreToolUse": [ { "matcher",
 *               "hooks": [ { "type": "command", "command", "timeout" (seconds) } ] } ] } }
 *     managed   requirements.toml: allow_managed_hooks_only = true, [hooks] managed_dir, and
 *               [[hooks.PreToolUse]] / [[hooks.PreToolUse.hooks]] tables. The hooks page gives no
 *               file path; /etc/codex/requirements.toml (macOS and Linux) and
 *               %ProgramData%\OpenAI\Codex\requirements.toml (Windows) are from Codex's managed
 *               configuration docs (https://developers.openai.com/codex/enterprise/managed-configuration).
 *     Exit code 2 blocks, with standard error as the reason. Matchers are Rust regular
 *     expressions (no look-around), so Immiscible's own read-only tools are skipped by the hook.
 *
 *   Cursor      https://cursor.com/docs/hooks
 *     user      ~/.cursor/hooks.json
 *     managed   /Library/Application Support/Cursor/hooks.json, /etc/cursor/hooks.json,
 *               C:\ProgramData\Cursor\hooks.json (enterprise hooks take priority over all others)
 *     { "version": 1, "hooks": { "beforeShellExecution": [ { "command", "timeout", "failClosed": true } ],
 *       "beforeMCPExecution": [ ... ] } }. failClosed makes a crash, a timeout or no output block.
 *
 *   Windsurf    https://docs.windsurf.com/windsurf/cascade/hooks
 *     user      ~/.codeium/windsurf/hooks.json
 *     managed   /Library/Application Support/Windsurf/hooks.json, /etc/windsurf/hooks.json,
 *               C:\ProgramData\Windsurf\hooks.json; when the Devin Desktop file is already there
 *               (/Library/Application Support/Devin/hooks.json, /etc/devin/hooks.json,
 *               C:\ProgramData\Devin\hooks.json) it is used instead, because it hides the Windsurf one.
 *     { "hooks": { "pre_run_command": [ { "command", "show_output" } ], "pre_mcp_tool_use": [...],
 *       "pre_write_code": [...] } }. System hooks run first; exit code 2 blocks; any other exit
 *     lets the action go on, hence `|| exit 2`. No hook timeout is documented, so the hook
 *     does not wait for a person here.
 *
 *   Gemini CLI  https://geminicli.com/docs/hooks/reference/ and /docs/reference/configuration
 *     user      ~/.gemini/settings.json
 *     managed   the system settings file: /Library/Application Support/GeminiCli/settings.json,
 *               /etc/gemini-cli/settings.json, C:\ProgramData\gemini-cli\settings.json
 *               (GEMINI_CLI_SYSTEM_SETTINGS_PATH moves it). It overrides user and project settings.
 *     { "hooks": { "BeforeTool": [ { "matcher", "hooks": [ { "type": "command", "name", "command",
 *       "timeout" (milliseconds) } ] } ] }, "hooksConfig": { "enabled": true } }. Exit code 2 blocks;
 *     any other failure is a warning and the call goes on, hence `|| exit 2`.
 *
 *   Droid       https://docs.factory.ai/reference/hooks-reference and
 *               https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control
 *     user      ~/.factory/hooks.json: { "PreToolUse": [ { "matcher", "hooks": [ { "type": "command",
 *               "command", "timeout" (seconds) } ] } ] }, events at the top level. When there is no
 *               hooks.json but ~/.factory/settings.json has a "hooks" key, Droid reads that instead,
 *               so the entry goes there (a new hooks.json would hide the hooks already in it).
 *     managed   the system settings file: /Library/Application Support/Factory/settings.json,
 *               /etc/factory/settings.json, C:\Program Files\Factory\settings.json, with "hooks" and
 *               "allowManagedHooksOnly": true. Exit code 2 blocks; JSON permissionDecision "ask" asks.
 *
 *   opencode    https://opencode.ai/docs/plugins: no command hooks, so a plugin file,
 *     user      $XDG_CONFIG_HOME/opencode/plugins/immiscible.js (~/.config/opencode/plugins/), whose
 *               tool.execute.before runs the hook and throws, stopping the call, unless it exits 0.
 *     managed   none: opencode documents no machine-wide plugin folder.
 *
 *   Amp         https://ampcode.com/manual/plugin-api: a plugin file too,
 *     user      $XDG_CONFIG_HOME/amp/plugins/immiscible.js (~/.config/amp/plugins/), whose tool.call
 *               handler answers reject-and-continue unless the hook exits 0.
 *     managed   none from a file: workspace admins add the same file as a workspace plugin in
 *               Amp's Workspace Settings.
 *
 * Every command is `node --env-file-if-exists="<dir>/hook.env" "<dir>/coding-agent-hook.mjs"
 * --agent <agent> [--wait <s>] || exit 2`. hook.env carries IMMISCIBLE_URL (and the agent key
 * with --key), because Cursor and Windsurf start hooks from the app rather than a shell and
 * Gemini CLI gives hooks a reduced environment; a variable already set wins.
 *
 * IMMISCIBLE_MANAGED_ROOT puts every managed file under <root>/<agent>/ instead (a test, or a
 * device management tool that stages files before deploying them).
 *
 * Merging keeps every other setting and hook; an older Immiscible entry (found by its command)
 * is replaced in place; a second run changes nothing, byte for byte; a file that cannot be
 * parsed is never touched.
 */

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_TARGETS = Object.freeze(['codex', 'cursor', 'windsurf', 'gemini', 'droid', 'opencode', 'amp']);
export const AGENT_LABELS = Object.freeze({ codex: 'Codex', cursor: 'Cursor', windsurf: 'Windsurf', gemini: 'Gemini CLI', droid: 'Factory Droid', opencode: 'opencode', amp: 'Amp' });
/** Agents governed through a plugin file rather than a hook entry: per person only. */
export const PLUGIN_AGENTS = Object.freeze(['opencode', 'amp']);
/** Why a plugin agent has no managed scope, and what to do instead. */
export const NO_MANAGED = Object.freeze({
  opencode: 'opencode documents no machine-wide plugin folder, so its plugin is installed for each person: run it with --scope user for each account (or have your device management tool run it).',
  amp: 'Amp takes machine-wide plugins from its Workspace Settings, not a file: run it with --scope user --dry-run, and add the plugin file it shows as a workspace plugin.',
});
export const HOOK_SCRIPT = 'coding-agent-hook.mjs';
export const ENV_FILE = 'hook.env';
export const BUNDLED_AGENT_HOOK = fileURLToPath(new URL(`../hook/${HOOK_SCRIPT}`, import.meta.url));

/**
 * How long the hook waits for a person (seconds), and the hook timeout the
 * agent is given (in the unit the agent reads), always comfortably above
 * the wait plus one decision. Cursor asks the person at the keyboard
 * instead; Windsurf documents no timeout, so it never waits.
 */
export const TIMING = Object.freeze({
  codex: { wait: 240, timeout: 300 },
  cursor: { wait: 0, timeout: 60 },
  windsurf: { wait: 0, timeout: null },
  gemini: { wait: 240, timeout: 300_000 },
  droid: { wait: 0, timeout: 60 },
  opencode: { wait: 240, timeout: null },
  amp: { wait: 240, timeout: null },
});

export const CODEX_MATCHER = '^(Bash|apply_patch|mcp__.*)$';
export const GEMINI_MATCHER = '^(run_shell_command|write_file|replace|web_fetch|mcp_.*)$';
export const DROID_MATCHER = '^(Execute|Edit|MultiEdit|Create|ApplyPatch|FetchUrl|mcp__.*)$';
const PLUGIN_FILE = 'immiscible.js';
/** Seconds an after-call hook may take; it only reads and writes a small local file. */
const AFTER_TIMEOUT = 10;
/** opencode's tools that only read or plan (the hook's own list matches). */
const OPENCODE_READS = ['read', 'glob', 'grep', 'list', 'ls', 'lsp', 'todoread', 'todowrite', 'task', 'skill', 'question', 'invalid'];
const STATUS = 'Asking Immiscible';

/** Is this hook command ours? (Any Immiscible hook script, as claude.mjs's isOurs reads it.) */
export const isOurs = (cmd) => typeof cmd === 'string' && /immiscible[-_/\\.a-z]*hook/i.test(cmd);

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function homeOf(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/**
 * Where the configuration goes, and where the hook and its env file are
 * copied, for an agent and a scope: { config, hookDir, format }.
 */
export function agentPaths(agent, scope, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const home = homeOf(env);
  const win = platform === 'win32';
  const p = win && !env.IMMISCIBLE_MANAGED_ROOT ? path.win32 : path;
  const programData = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
  if (scope === 'user') {
    const hookDir = path.join(home, '.immiscible');
    if (agent === 'codex') return { config: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json'), hookDir, format: 'json' };
    if (agent === 'cursor') return { config: path.join(home, '.cursor', 'hooks.json'), hookDir, format: 'json' };
    if (agent === 'windsurf') return { config: path.join(home, '.codeium', 'windsurf', 'hooks.json'), hookDir, format: 'json' };
    if (agent === 'gemini') return { config: path.join(home, '.gemini', 'settings.json'), hookDir, format: 'json' };
    if (agent === 'droid') {
      const hooksFile = path.join(home, '.factory', 'hooks.json');
      const settingsFile = path.join(home, '.factory', 'settings.json');
      if (!exists(hooksFile) && settingsHasHooks(settingsFile)) return { config: settingsFile, hookDir, format: 'json' };
      return { config: hooksFile, hookDir, format: 'json' };
    }
    const xdg = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config');
    if (agent === 'opencode') return { config: path.join(xdg, 'opencode', 'plugins', PLUGIN_FILE), hookDir, format: 'plugin' };
    if (agent === 'amp') return { config: path.join(xdg, 'amp', 'plugins', PLUGIN_FILE), hookDir, format: 'plugin' };
  }
  if (PLUGIN_AGENTS.includes(agent)) throw new Error(NO_MANAGED[agent]);
  const name = { codex: 'requirements.toml', cursor: 'hooks.json', windsurf: 'hooks.json', gemini: 'settings.json', droid: 'settings.json' }[agent];
  let config;
  if (env.IMMISCIBLE_MANAGED_ROOT) config = path.join(path.resolve(env.IMMISCIBLE_MANAGED_ROOT), agent, name);
  else if (agent === 'codex') config = win ? p.join(programData, 'OpenAI', 'Codex', name) : '/etc/codex/requirements.toml';
  else if (agent === 'cursor') config = win ? p.join(programData, 'Cursor', name) : platform === 'darwin' ? '/Library/Application Support/Cursor/hooks.json' : '/etc/cursor/hooks.json';
  else if (agent === 'droid') config = win ? p.join(env.ProgramFiles || 'C:\\Program Files', 'Factory', name) : platform === 'darwin' ? '/Library/Application Support/Factory/settings.json' : '/etc/factory/settings.json';
  else if (agent === 'gemini') config = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ? path.resolve(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) : win ? p.join(programData, 'gemini-cli', name) : platform === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json' : '/etc/gemini-cli/settings.json';
  else if (agent === 'windsurf') {
    const devin = win ? p.join(programData, 'Devin', name) : platform === 'darwin' ? '/Library/Application Support/Devin/hooks.json' : '/etc/devin/hooks.json';
    const windsurf = win ? p.join(programData, 'Windsurf', name) : platform === 'darwin' ? '/Library/Application Support/Windsurf/hooks.json' : '/etc/windsurf/hooks.json';
    config = exists(devin) ? devin : windsurf;
  }
  if (!config) throw new Error(`unknown agent ${agent}`);
  return { config, hookDir: p.join(p.dirname(config), 'immiscible'), format: agent === 'codex' ? 'toml' : 'json' };
}

/** The command an agent runs (forward slashes: every one of them runs it in a POSIX shell, or cmd, which accepts them). */
export function hookCommand(agent, hookDir) {
  const dir = hookDir.replace(/\\/g, '/');
  const wait = TIMING[agent].wait;
  const run = `node --env-file-if-exists="${dir}/${ENV_FILE}" "${dir}/${HOOK_SCRIPT}" --agent ${agent}${wait ? ` --wait ${wait}` : ''}`;
  // A plugin runs it without a shell and refuses on anything but exit 0, so no `|| exit 2`.
  return PLUGIN_AGENTS.includes(agent) ? run : `${run} || exit 2`;
}

/** The after-call command (Cursor, Droid): --after, and no `|| exit 2`, since it must never block or complain. */
export function afterCommand(command) {
  return String(command).replace(/\s*\|\|\s*exit 2$/, '').concat(' --after');
}

/** Does a Droid settings.json carry hooks of its own? (Droid reads them only while there is no hooks.json.) */
function settingsHasHooks(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return isObject(j?.hooks) && Object.keys(j.hooks).length > 0;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ JSON configs

function indentOf(text) {
  const m = /^[ \t]+(?=")/m.exec(text ?? '');
  return m ? m[0] : '  ';
}

/** A flat list of hook entries ({ command, ... }): ours in place of the first of ours, later ones of ours dropped. */
function placeFlat(list, want) {
  const kept = [];
  let placed = false;
  for (const e of Array.isArray(list) ? list : []) {
    if (!isOurs(e?.command)) { kept.push(e); continue; }
    if (placed) continue;
    placed = true;
    kept.push(want);
  }
  if (!placed) kept.push(want);
  return kept;
}

/** A list of matcher groups ({ matcher, hooks: [...] }): as claude.mjs does for Claude Code's settings. */
function placeGrouped(list, want) {
  const kept = [];
  let placed = false;
  for (const e of Array.isArray(list) ? list : []) {
    const hooks = Array.isArray(e?.hooks) ? e.hooks : [];
    if (!hooks.some((h) => isOurs(h?.command))) { kept.push(e); continue; }
    const others = hooks.filter((h) => !isOurs(h?.command));
    if (placed) {
      if (others.length) kept.push({ ...e, hooks: others });
      continue;
    }
    placed = true;
    kept.push(others.length ? { ...want, hooks: [...want.hooks, ...others] } : want);
  }
  if (!placed) kept.push(want);
  return kept;
}

/** The wanted entries for a JSON-configured agent, applied to a parsed configuration (mutates next). */
function applyJson(agent, scope, next, command, file = '') {
  const t = TIMING[agent];
  if (agent === 'droid') {
    const want = { matcher: DROID_MATCHER, hooks: [{ type: 'command', command, timeout: t.timeout }] };
    // After the call: logs that a call the person was asked about ran (local mode); never blocks.
    const after = { matcher: DROID_MATCHER, hooks: [{ type: 'command', command: afterCommand(command), timeout: AFTER_TIMEOUT }] };
    // ~/.factory/hooks.json holds the events at the top level; a settings.json holds them under "hooks".
    if (scope === 'user' && path.basename(file) === 'hooks.json') {
      next.PreToolUse = placeGrouped(next.PreToolUse, want);
      next.PostToolUse = placeGrouped(next.PostToolUse, after);
      return next;
    }
    next.hooks = isObject(next.hooks) ? next.hooks : {};
    next.hooks.PreToolUse = placeGrouped(next.hooks.PreToolUse, want);
    next.hooks.PostToolUse = placeGrouped(next.hooks.PostToolUse, after);
    if (scope === 'managed') next.allowManagedHooksOnly = true;
    return next;
  }
  next.hooks = isObject(next.hooks) ? next.hooks : {};
  if (agent === 'codex') {
    next.hooks.PreToolUse = placeGrouped(next.hooks.PreToolUse, { matcher: CODEX_MATCHER, hooks: [{ type: 'command', command, timeout: t.timeout, statusMessage: STATUS }] });
  } else if (agent === 'cursor') {
    for (const event of ['beforeShellExecution', 'beforeMCPExecution']) next.hooks[event] = placeFlat(next.hooks[event], { command, timeout: t.timeout, failClosed: true });
    // After the call, never fail closed: it only logs that a call the person was asked about ran.
    for (const event of ['afterShellExecution', 'afterMCPExecution']) next.hooks[event] = placeFlat(next.hooks[event], { command: afterCommand(command), timeout: AFTER_TIMEOUT });
  } else if (agent === 'windsurf') {
    for (const event of ['pre_run_command', 'pre_mcp_tool_use', 'pre_write_code']) next.hooks[event] = placeFlat(next.hooks[event], { command, show_output: false });
  } else if (agent === 'gemini') {
    next.hooks.BeforeTool = placeGrouped(next.hooks.BeforeTool, {
      matcher: GEMINI_MATCHER,
      hooks: [{ type: 'command', name: 'immiscible', command, timeout: t.timeout, description: 'Asks Immiscible before a shell command, a file write or an MCP tool call; fails closed.' }],
    });
    // In the system settings this has the final say, so no one switches hooks off underneath it.
    if (scope === 'managed') next.hooksConfig = { ...(isObject(next.hooksConfig) ? next.hooksConfig : {}), enabled: true };
  }
  // Cursor requires a version; a new one leads the file, as Cursor's own examples write it.
  if (agent === 'cursor' && next.version == null) return { version: 1, ...next };
  return next;
}

/** Notes about a configuration that would stop the hook running, for the person installing it. */
function jsonWarnings(agent, scope, settings) {
  const out = [];
  if (agent === 'gemini' && scope === 'user' && settings?.hooksConfig?.enabled === false) out.push('hooksConfig.enabled is false in this file, so Gemini CLI runs no hooks until it is true.');
  if (agent === 'droid' && scope === 'managed' && settings?.allowManagedHooksOnly !== true) out.push('allowManagedHooksOnly is now true in this file: Droid runs only managed hooks (and those from plugins your organisation enables), so no one can switch this one off.');
  if (agent === 'gemini' && Array.isArray(settings?.hooksConfig?.disabled) && settings.hooksConfig.disabled.some((n) => n === 'immiscible' || isOurs(n))) out.push('hooksConfig.disabled lists the Immiscible hook, so Gemini CLI skips it.');
  return out;
}

function planJson(agent, scope, file, command) {
  const exists = existsSync(file);
  const before = exists ? readFileSync(file, 'utf8') : '';
  let settings = {};
  if (exists && before.trim()) {
    try {
      settings = JSON.parse(before);
    } catch (err) {
      return { before, after: before, changed: false, state: 'unparseable', error: `${file} is not valid JSON (${err.message}); fix it or add the entry by hand`, warnings: [] };
    }
    if (!isObject(settings)) return { before, after: before, changed: false, state: 'unparseable', error: `${file} is not a JSON object`, warnings: [] };
  }
  const had = JSON.stringify(agent === 'droid' ? settings : settings.hooks ?? {});
  const next = applyJson(agent, scope, structuredClone(settings), command, file);
  const warnings = jsonWarnings(agent, scope, settings);
  if (exists && JSON.stringify(next) === JSON.stringify(settings)) return { before, after: before, changed: false, state: 'unchanged', error: null, warnings };
  const after = `${JSON.stringify(next, null, indentOf(before))}\n`;
  return { before, after, changed: true, state: isOurs(had) ? 'updated' : 'added', error: null, warnings };
}

// ------------------------------------------------------------------ Codex requirements.toml

export const TOML_TOP_BEGIN = '# >>> immiscible: written by `immiscible install codex --scope managed`';
export const TOML_TOP_END = '# <<< immiscible top';
export const TOML_HOOKS_BEGIN = '# >>> immiscible hooks: written by `immiscible install codex --scope managed`';
export const TOML_HOOKS_END = '# <<< immiscible hooks';

/** A TOML string: a literal string when it can be one (no escapes to get wrong), else a basic string. */
export function tomlString(s) {
  return /['\n\r]/.test(s) ? JSON.stringify(s) : `'${s}'`;
}

/** The text with our marked blocks taken out (and the blank line each leaves behind). */
function stripBlocks(text) {
  let out = text;
  for (const [b, e] of [[TOML_TOP_BEGIN, TOML_TOP_END], [TOML_HOOKS_BEGIN, TOML_HOOKS_END]]) {
    for (let i = out.indexOf(b); i >= 0; i = out.indexOf(b)) {
      const j = out.indexOf(e, i + b.length);
      if (j < 0) return { text, error: `the block starting "${b.slice(2)}" has no "${e.slice(2)}" line; restore it or remove the block by hand` };
      let end = j + e.length;
      if (out[end] === '\n') end++;
      if (out[end] === '\n') end++;
      out = out.slice(0, i) + out.slice(end);
    }
  }
  return { text: out, error: null };
}

/** The TOML lines before the first table header: the top-level keys. */
const firstHeader = (text) => {
  const m = /^[ \t]*\[/m.exec(text);
  return m ? m.index : text.length;
};

function planToml(file, command, { platform = process.platform, hookDir }) {
  const exists = existsSync(file);
  const before = exists ? readFileSync(file, 'utf8') : '';
  const stripped = stripBlocks(before);
  if (stripped.error) return { before, after: before, changed: false, state: 'unparseable', error: `${file}: ${stripped.error}`, warnings: [] };
  let base = stripped.text;
  const warnings = [];
  // Hooks switched off for everyone ([features] hooks = false, or the older codex_hooks): refuse, it would do nothing.
  const features = /^[ \t]*\[features\][ \t]*(#.*)?$([\s\S]*?)(?=^[ \t]*\[|(?![\s\S]))/m.exec(base);
  if (features && /^[ \t]*(hooks|codex_hooks)[ \t]*=[ \t]*false\b/m.test(features[2])) {
    return { before, after: before, changed: false, state: 'disabled', error: `${file} turns hooks off for everyone ([features] hooks = false); change that first, or the hook would never run`, warnings };
  }
  // allow_managed_hooks_only: a top-level key, so before any table.
  const top = base.slice(0, firstHeader(base));
  const amho = /^([ \t]*allow_managed_hooks_only[ \t]*=[ \t]*)(true|false)\b.*$/m.exec(top);
  let head = '';
  if (!amho) head = `${TOML_TOP_BEGIN}\nallow_managed_hooks_only = true\n${TOML_TOP_END}\n\n`;
  else if (amho[2] === 'false') {
    base = base.slice(0, amho.index) + `${amho[1]}true` + base.slice(amho.index + amho[0].length);
    warnings.push('allow_managed_hooks_only was false; it is now true, so only managed hooks run.');
  }
  // [hooks] managed_dir: only when the file has no [hooks] table of its own (TOML allows a table once).
  const hooksTable = /^[ \t]*\[hooks\][ \t]*(#.*)?$([\s\S]*?)(?=^[ \t]*\[|(?![\s\S]))/m.exec(base);
  const dirKey = platform === 'win32' ? 'windows_managed_dir' : 'managed_dir';
  let withHooksTable = true;
  if (hooksTable) {
    withHooksTable = false;
    const existing = new RegExp(`^[ \\t]*${dirKey}[ \\t]*=[ \\t]*(["'])(.*?)\\1`, 'm').exec(hooksTable[2]);
    if (existing && path.resolve(existing[2]) !== path.resolve(hookDir)) warnings.push(`[hooks] ${dirKey} is ${existing[2]}; the hook is installed in ${hookDir}, so add it to what your device management deploys there, or move it.`);
  }
  const body = [
    TOML_HOOKS_BEGIN,
    ...(withHooksTable ? ['[hooks]', `${dirKey} = ${tomlString(hookDir)}`, ''] : []),
    '[[hooks.PreToolUse]]',
    `matcher = ${tomlString(CODEX_MATCHER)}`,
    '',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    `command = ${tomlString(command)}`,
    ...(platform === 'win32' ? [`command_windows = ${tomlString(command)}`] : []),
    `timeout = ${TIMING.codex.timeout}`,
    `statusMessage = ${tomlString(STATUS)}`,
    TOML_HOOKS_END,
  ];
  const rest = base.replace(/\s*$/, '');
  const after = `${head}${rest}${rest ? '\n\n' : ''}${body.join('\n')}\n`;
  if (after === before) return { before, after: before, changed: false, state: 'unchanged', error: null, warnings };
  return { before, after, changed: true, state: before.includes(TOML_HOOKS_BEGIN) ? 'updated' : 'added', error: null, warnings };
}

// ------------------------------------------------------------------ opencode and Amp plugins

const PLUGIN_MARK = (agent) => `// immiscible-hook plugin, written by \`immiscible install ${agent}\`. Running it again replaces this file.`;

/** The plugin source: run the hook with the call on stdin, go ahead only on exit 0. */
export function pluginSource(agent, hookDir) {
  const dir = hookDir.replace(/\\/g, '/');
  const wait = TIMING[agent].wait;
  const args = [`--env-file-if-exists=${dir}/${ENV_FILE}`, `${dir}/${HOOK_SCRIPT}`, '--agent', agent, ...(wait ? ['--wait', String(wait)] : [])];
  const ask = [
    PLUGIN_MARK(agent),
    '// It asks Immiscible before a shell command, a file write or another tool call that changes something, and fails closed:',
    '// if the hook cannot run, cannot reach Immiscible or does not answer, the call does not run.',
    '',
    "import { spawn } from 'node:child_process';",
    '',
    `const ARGS = ${JSON.stringify(args)};`,
    `const LIMIT_MS = ${(wait + 60) * 1000};`,
    '',
    'function askImmiscible(event) {',
    '  return new Promise((resolve) => {',
    "    const fail = (why) => resolve({ ok: false, reason: `Immiscible hook (failing closed): ${why}` });",
    '    let child;',
    '    try {',
    "      child = spawn('node', ARGS, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });",
    '    } catch (err) {',
    '      return fail(err.message);',
    '    }',
    "    let err = '';",
    '    const timer = setTimeout(() => child.kill(), LIMIT_MS);',
    "    child.stderr.on('data', (d) => { err += d; });",
    "    child.on('error', (e) => { clearTimeout(timer); fail(e.message); });",
    "    child.on('close', (code) => {",
    '      clearTimeout(timer);',
    "      resolve(code === 0 ? { ok: true } : { ok: false, reason: err.trim() || `Immiscible hook (failing closed): it ended with ${code ?? 'no exit code'}.` });",
    '    });',
    "    child.stdin.on('error', () => {});",
    '    child.stdin.end(JSON.stringify(event));',
    '  });',
    '}',
    '',
  ];
  if (agent === 'opencode') {
    return [...ask,
      '// Tools that only read or plan are never sent (the hook would let them through anyway).',
      `const READS = new Set(${JSON.stringify(OPENCODE_READS)});`,
      '',
      'export const ImmiscibleGuard = async ({ directory, worktree }) => ({',
      "  'tool.execute.before': async (input, output) => {",
      '    if (READS.has(input.tool)) return;',
      '    const r = await askImmiscible({ tool: input.tool, args: output.args, sessionID: input.sessionID, callID: input.callID, cwd: directory, worktree });',
      '    if (!r.ok) throw new Error(r.reason);',
      '  },',
      '});',
      ''].join('\n');
  }
  return [...ask,
    'export default function immiscible(amp) {',
    "  amp.on('tool.call', async (event) => {",
    '    let shell = null;',
    '    try {',
    '      shell = amp.helpers?.shellCommandFromToolCall?.(event) ?? null;',
    '    } catch {',
    '      shell = null;',
    '    }',
    '    const r = await askImmiscible({ tool: event.tool, input: event.input, toolUseID: event.toolUseID, threadID: event.thread?.id, cwd: process.cwd(), shell });',
    "    return r.ok ? { action: 'allow' } : { action: 'reject-and-continue', message: r.reason };",
    '  });',
    '}',
    ''].join('\n');
}

function planPlugin(agent, file, hookDir) {
  const exists = existsSync(file);
  const before = exists ? readFileSync(file, 'utf8') : '';
  if (exists && !before.includes(PLUGIN_MARK(agent))) {
    return { before, after: before, changed: false, state: 'unparseable', error: `${file} is there already and was not written by Immiscible; move it, then run this again`, warnings: [] };
  }
  const after = pluginSource(agent, hookDir);
  if (after === before) return { before, after: before, changed: false, state: 'unchanged', error: null, warnings: [] };
  return { before, after, changed: true, state: exists ? 'updated' : 'added', error: null, warnings: [] };
}

// ------------------------------------------------------------------ the plan

/**
 * Everything one install would change: { agent, scope, config, format,
 * hookDir, hookFile, envFile, command, before, after, changed, state,
 * error, warnings }.
 */
export function planAgent(agent, scope, { platform = process.platform, env = process.env } = {}) {
  const paths = agentPaths(agent, scope, { platform, env });
  const { hookDir } = paths;
  const command = hookCommand(agent, hookDir);
  const plan = paths.format === 'toml'
    ? planToml(paths.config, command, { platform, hookDir })
    : paths.format === 'plugin'
      ? planPlugin(agent, paths.config, hookDir)
      : planJson(agent, scope, paths.config, command);
  const p = platform === 'win32' && !env.IMMISCIBLE_MANAGED_ROOT && scope === 'managed' ? path.win32 : path;
  return { agent, scope, ...paths, hookFile: p.join(hookDir, HOOK_SCRIPT), envFile: p.join(hookDir, ENV_FILE), command, ...plan };
}

// ------------------------------------------------------------------ hook.env

/** hook.env with IMMISCIBLE_URL (and the key, when given) set, every other line kept. */
export function planEnv(file, { url, key = null, mode = 'server' }) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = before ? before.replace(/\n$/, '').split('\n') : ['# Read by the Immiscible hook (node --env-file-if-exists). A variable already in the environment wins.'];
  const set = (name, value) => {
    const i = lines.findIndex((l) => l.startsWith(`${name}=`));
    if (i >= 0) lines[i] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  };
  set('IMMISCIBLE_URL', url);
  if (key) set('IMMISCIBLE_AGENT_KEY', key);
  // immiscible guard: local decides on this machine; server (the default) asks Immiscible.
  if (mode === 'local') set('IMMISCIBLE_MODE', 'local');
  else { const i = lines.findIndex((l) => l.startsWith('IMMISCIBLE_MODE=')); if (i >= 0) lines.splice(i, 1); }
  const after = `${lines.join('\n')}\n`;
  return { before, after, changed: after !== before, hasKey: lines.some((l) => /^IMMISCIBLE_AGENT_KEY=./.test(l)) };
}
