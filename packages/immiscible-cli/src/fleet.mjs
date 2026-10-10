/**
 * The Claude Code fleet install: one machine-wide hook, for a person
 * (--scope user, ~/.claude/settings.json) or for every person on the
 * machine (--scope managed, Claude Code's managed settings file, which
 * people cannot override).
 *
 * Paths come from Claude Code's settings documentation
 * (https://code.claude.com/docs/en/settings, "Settings files", managed
 * settings), as of October 2026:
 *
 *   macOS          /Library/Application Support/ClaudeCode/managed-settings.json
 *   Linux and WSL  /etc/claude-code/managed-settings.json
 *   Windows        C:\Program Files\ClaudeCode\managed-settings.json
 *
 * IMMISCIBLE_MANAGED_SETTINGS names another file (a test, or a device
 * management tool that stages the file elsewhere first).
 *
 * Two transports for the hook:
 *
 *   command (the default)  node runs a copy of hook/claude-code-hook.mjs; `|| exit 2`
 *                          blocks the call when the hook, node or the server fails,
 *                          because Claude Code blocks on exit code 2. Fails closed.
 *   http                   Claude Code POSTs the event to <url>/v1/hooks/claude-code
 *                          (hooks of type "http", https://code.claude.com/docs/en/hooks).
 *                          The server answers every problem it can see with a refusal,
 *                          but when the server cannot be reached at all Claude Code treats
 *                          the failed http hook as no answer and the call goes on. Use it
 *                          where an outage must not stop work; use command to fail closed.
 *
 * Managed scope also sets allowManagedHooksOnly, so hooks from people's own
 * settings, projects and plugins do not run, and no one can switch this one
 * off. Merging keeps every other setting and hook; an older Immiscible
 * entry is replaced in place; a second run changes nothing, byte for byte.
 */

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MATCHER, DENY, HOOK_TIMEOUT, isOurs } from './claude.mjs';

export const HTTP_HOOK_PATH = '/v1/hooks/claude-code';
export const SCOPES = Object.freeze(['user', 'managed']);
export const TRANSPORTS = Object.freeze(['command', 'http']);
/** The environment variables the http hook's headers read (Claude Code resolves only those listed). */
export const HTTP_ENV_VARS = Object.freeze(['IMMISCIBLE_AGENT_KEY', 'CLAUDE_PROJECT_DIR']);

/** The person's home directory, from the environment the CLI was given (tests pass their own). */
export function homeOf(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Claude Code's managed settings file on this platform. */
export function managedSettingsPath({ platform = process.platform, env = process.env } = {}) {
  if (env.IMMISCIBLE_MANAGED_SETTINGS) return path.resolve(env.IMMISCIBLE_MANAGED_SETTINGS);
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
  return '/etc/claude-code/managed-settings.json';
}

/** Where the settings go, and where the hook file is copied, for a scope. */
export function fleetPaths(scope, { platform = process.platform, env = process.env } = {}) {
  if (scope === 'managed') {
    const settings = managedSettingsPath({ platform, env });
    const p = platform === 'win32' && !env.IMMISCIBLE_MANAGED_SETTINGS ? path.win32 : path;
    return { settings, hook: p.join(p.dirname(settings), 'immiscible', 'claude-code-hook.mjs') };
  }
  const home = homeOf(env);
  return { settings: path.join(home, '.claude', 'settings.json'), hook: path.join(home, '.immiscible', 'claude-code-hook.mjs') };
}

/** The hook command for a hook file at an absolute path (forward slashes: Claude Code runs it in a POSIX shell). */
export function fleetCommand(hookFile) {
  return `node "${hookFile.replace(/\\/g, '/')}" || exit 2`;
}

const isOurHttp = (h) => h?.type === 'http' && typeof h?.url === 'string' && h.url.replace(/\/+$/, '').endsWith(HTTP_HOOK_PATH);
const isOurHook = (h) => isOurs(h?.command) || isOurHttp(h);

/** The hook entries for a transport: { PreToolUse: [entry], PermissionRequest?: [entry] }. */
/** In local mode the hook also sees Read, so a session that read a secret file is known when it later reaches the network. */
export const LOCAL_MATCHER = `Read|${MATCHER}`;
/** The ConfigChange sources a hook can block (Claude Code cannot block policy_settings). */
export const CONFIG_MATCHER = 'user_settings|project_settings|local_settings';

export function fleetEntries({ transport, url, hookFile, mode = 'server' }) {
  if (transport === 'http') {
    const hook = {
      type: 'http',
      url: `${url.replace(/\/+$/, '')}${HTTP_HOOK_PATH}`,
      timeout: HOOK_TIMEOUT,
      headers: { Authorization: 'Bearer $IMMISCIBLE_AGENT_KEY', 'X-Immiscible-Project-Dir': '$CLAUDE_PROJECT_DIR' },
      allowedEnvVars: [...HTTP_ENV_VARS],
    };
    return { PreToolUse: { matcher: MATCHER, hooks: [hook] }, PermissionRequest: { matcher: MATCHER, hooks: [structuredClone(hook)] } };
  }
  const hook = () => ({ type: 'command', command: fleetCommand(hookFile), timeout: HOOK_TIMEOUT });
  if (mode !== 'local') return { PreToolUse: { matcher: MATCHER, hooks: [hook()] } };
  // Local mode also keeps the session's settings honest: SessionStart notes them, ConfigChange
  // keeps out a mid-session change that adds a hook or widens permissions.
  return {
    PreToolUse: { matcher: LOCAL_MATCHER, hooks: [hook()] },
    SessionStart: { hooks: [hook()] },
    ConfigChange: { matcher: CONFIG_MATCHER, hooks: [hook()] },
  };
}

function indentOf(text) {
  const m = /^[ \t]+(?=")/m.exec(text ?? '');
  return m ? m[0] : '  ';
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** One event's list with our entry in place (or taken out when want is null), keeping everything else. */
function placeEntry(list, want) {
  const kept = [];
  let placed = false;
  for (const e of Array.isArray(list) ? list : []) {
    const hooks = Array.isArray(e?.hooks) ? e.hooks : [];
    if (!hooks.some(isOurHook)) { kept.push(e); continue; }
    const others = hooks.filter((h) => !isOurHook(h));
    if (placed || !want) {
      if (others.length) kept.push({ ...e, hooks: others });
      continue;
    }
    placed = true;
    kept.push(others.length ? { ...want, hooks: [...want.hooks, ...others] } : want);
  }
  if (want && !placed) kept.push(want);
  return kept;
}

/**
 * The settings with the fleet hook in place. Returns { before, after,
 * changed, state: 'added' | 'updated' | 'unchanged' | 'unparseable', error }.
 * Never throws for a file it cannot parse: error says why, nothing changes.
 *
 *   scope      'user' or 'managed'
 *   transport  'command' or 'http'
 *   url        the Immiscible server
 *   hookFile   where the command hook is copied (command transport)
 *   key        an agent key to write into the settings' env, or null to leave it to the environment
 *   gateway    a gateway URL for ANTHROPIC_BASE_URL, or null
 *   mode       'server' (the default) or 'local', where the hook decides on this machine (immiscible guard)
 */
export function planFleet(file, { scope, transport, url, hookFile, key = null, gateway = null, mode = 'server' }) {
  const exists = existsSync(file);
  const before = exists ? readFileSync(file, 'utf8') : '';
  let settings = {};
  if (exists && before.trim()) {
    try {
      settings = JSON.parse(before);
    } catch (err) {
      return { before, after: before, changed: false, state: 'unparseable', error: `${file} is not valid JSON (${err.message}); fix it or add the entry by hand` };
    }
    if (!isObject(settings)) return { before, after: before, changed: false, state: 'unparseable', error: `${file} is not a JSON object` };
  }
  const next = structuredClone(settings);
  const had = JSON.stringify(settings.hooks ?? null);
  next.hooks = isObject(next.hooks) ? next.hooks : {};
  const want = fleetEntries({ transport, url, hookFile, mode });
  for (const event of ['PreToolUse', 'PermissionRequest', 'SessionStart', 'ConfigChange']) {
    const list = placeEntry(next.hooks[event], want[event] ?? null);
    if (list.length) next.hooks[event] = list;
    else delete next.hooks[event];
  }
  // The hook reads these from the environment; Claude Code sets a settings
  // file's env for the session and the hooks it runs. The key is written
  // only when given: otherwise each person's environment supplies it.
  next.env = isObject(next.env) ? next.env : {};
  next.env.IMMISCIBLE_URL = url;
  if (key) next.env.IMMISCIBLE_AGENT_KEY = key;
  if (gateway) next.env.ANTHROPIC_BASE_URL = gateway;
  // immiscible guard: decide on this machine (local), or ask the server (the default, and what --connect sets).
  if (mode === 'local') next.env.IMMISCIBLE_MODE = 'local';
  else delete next.env.IMMISCIBLE_MODE;
  // A second lock that holds without the network: Claude Code's own deny rules.
  next.permissions = isObject(next.permissions) ? next.permissions : {};
  const deny = Array.isArray(next.permissions.deny) ? next.permissions.deny : [];
  const missing = DENY.filter((d) => !deny.includes(d));
  if (missing.length || !Array.isArray(next.permissions.deny)) next.permissions.deny = [...deny, ...missing];
  if (scope === 'managed') {
    next.allowManagedHooksOnly = true;
    // Only extended when the organisation already keeps these lists; left
    // out, Claude Code applies no such limit.
    if (transport === 'http') {
      if (Array.isArray(next.allowedHttpHookUrls) && !next.allowedHttpHookUrls.includes(want.PreToolUse.hooks[0].url)) next.allowedHttpHookUrls = [...next.allowedHttpHookUrls, want.PreToolUse.hooks[0].url];
      if (Array.isArray(next.httpHookAllowedEnvVars)) next.httpHookAllowedEnvVars = [...next.httpHookAllowedEnvVars, ...HTTP_ENV_VARS.filter((v) => !next.httpHookAllowedEnvVars.includes(v))];
    }
  }
  if (exists && JSON.stringify(next) === JSON.stringify(settings)) return { before, after: before, changed: false, state: 'unchanged', error: null };
  const after = `${JSON.stringify(next, null, indentOf(before))}\n`;
  const ours = (h) => Object.values(isObject(h) ? h : {}).flat().some((e) => (e?.hooks ?? []).some(isOurHook));
  return { before, after, changed: true, state: had !== 'null' && ours(settings.hooks) ? 'updated' : 'added', error: null };
}
