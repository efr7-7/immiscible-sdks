/**
 * The permission modes and hooks in effect for the coding agents on this
 * machine, read from their settings files. The minimum the scan needs (the
 * full agent config fingerprinting is task T16): which hooks run, whether
 * each is Immiscible's, and whether a setting turns approvals off.
 *
 * Read (paths from each agent's documentation):
 *   Claude Code   ~/.claude/settings.json, and <project>/.claude/settings.json and
 *                 settings.local.json for each project a session ran in: "hooks"
 *                 (event to [{ matcher, hooks: [{ type, command }] }]) and
 *                 permissions.defaultMode. https://code.claude.com/docs/en/settings
 *   Codex         ~/.codex/config.toml: approval_policy and sandbox_mode, top level only.
 *                 https://github.com/openai/codex/blob/main/docs/config.md
 *   Gemini CLI    ~/.gemini/settings.json and <project>/.gemini/settings.json: "hooks" in
 *                 the same shape as Claude Code's, and tools.autoAccept / "yolo" approval.
 *                 https://geminicli.com/docs/cli/settings/
 *
 * A hook is reported by its event, where it is configured and the program
 * it runs (the first word of its command), never the whole command line.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Is this hook command Immiscible's own (the CLI's, the package's or the curl-installed script)? */
export const isImmiscibleHook = (cmd) => typeof cmd === 'string' && /immiscible[-_/\\.a-z]*hook/i.test(cmd);

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** The program a command runs: "node", "bash", "curl", or a script's file name. */
export function programOf(command) {
  const words = String(command ?? '').trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const clean = (w) => path.basename(String(w ?? '').replace(/^["']|["']$/g, ''));
  const first = clean(words[0]);
  if (!first) return 'unknown';
  // An interpreter names the script it runs: "node guard.mjs", "bash setup.sh".
  if (/^(node|python3?|bash|sh|zsh|npx|bunx?|deno|ruby|perl|pwsh|powershell)$/.test(first)) {
    const script = words.slice(1).find((w) => !w.startsWith('-') && !/^(run|exec)$/.test(w));
    if (script) return `${first} ${clean(script)}`;
  }
  return first;
}

function hooksFrom(settings, agent, where) {
  const out = [];
  const h = settings?.hooks;
  if (!h || typeof h !== 'object') return out;
  for (const [event, entries] of Object.entries(h)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      for (const hk of Array.isArray(e?.hooks) ? e.hooks : []) {
        const command = hk?.command ?? hk?.url ?? '';
        out.push({ agent, event, where, program: hk?.type === 'http' ? 'http' : programOf(command), immiscible: isImmiscibleHook(command) });
      }
    }
  }
  return out;
}

/** Top-level `key = "value"` pairs from a TOML file, before the first table. Enough for two settings. */
export function tomlTop(text) {
  const out = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line.startsWith('[')) break;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * { hooks: [..], modes: [{ agent, where, setting, value }] } for home and
 * the given project directories. `shown` makes a path printable (~ for home).
 */
export function readConfig({ home, env = {}, projects = [], shown = (p) => p } = {}) {
  const hooks = [];
  const modes = [];
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const claudeFiles = [path.join(claudeDir, 'settings.json')];
  const geminiFiles = [path.join(home, '.gemini', 'settings.json')];
  for (const p of projects) {
    claudeFiles.push(path.join(p, '.claude', 'settings.json'), path.join(p, '.claude', 'settings.local.json'));
    geminiFiles.push(path.join(p, '.gemini', 'settings.json'));
  }
  for (const f of [...new Set(claudeFiles)]) {
    if (!existsSync(f)) continue;
    const s = readJson(f);
    if (!s) continue;
    hooks.push(...hooksFrom(s, 'claude-code', shown(f)));
    const dm = s.permissions?.defaultMode;
    if (dm) modes.push({ agent: 'claude-code', where: shown(f), setting: 'permissions.defaultMode', value: String(dm) });
  }
  for (const f of [...new Set(geminiFiles)]) {
    if (!existsSync(f)) continue;
    const s = readJson(f);
    if (!s) continue;
    hooks.push(...hooksFrom(s, 'gemini-cli', shown(f)));
    const auto = s.tools?.autoAccept ?? s.autoAccept;
    if (auto === true) modes.push({ agent: 'gemini-cli', where: shown(f), setting: 'tools.autoAccept', value: 'true' });
    const am = s.general?.defaultApprovalMode ?? s.defaultApprovalMode;
    if (am) modes.push({ agent: 'gemini-cli', where: shown(f), setting: 'defaultApprovalMode', value: String(am) });
  }
  const codexToml = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  if (existsSync(codexToml)) {
    try {
      const t = tomlTop(readFileSync(codexToml, 'utf8'));
      for (const k of ['approval_policy', 'sandbox_mode']) if (t[k]) modes.push({ agent: 'codex', where: shown(codexToml), setting: k, value: t[k] });
    } catch { /* unreadable */ }
  }
  return { hooks, modes };
}
