/**
 * Agent config integrity for a repository (T16): every hook, plugin and MCP
 * server a coding agent would pick up from the repository's own files, each
 * with a fingerprint, checked against an allow list committed beside them.
 *
 * Why: a hook or an MCP server added to a repository runs on every machine
 * that opens it with that agent. The Mini Shai-Hulud worm (May 2026) spread
 * that way, through a SessionStart hook in .claude/settings.json. The allow
 * list (.immiscible/agent-config.json) turns adding one into a reviewed
 * change: `immiscible scan --ci` fails the build on anything not on it.
 *
 * Read (project files only; each agent's documentation, October 2026):
 *   Claude Code   .claude/settings.json, .claude/settings.local.json ("hooks"), .mcp.json
 *   Codex         .codex/hooks.json ("hooks"), .codex/config.toml ([mcp_servers.<name>] tables)
 *   Cursor        .cursor/hooks.json ("hooks": event to [{ command }]), .cursor/mcp.json
 *   Windsurf      .windsurf/hooks.json
 *   Gemini CLI    .gemini/settings.json ("hooks", "mcpServers")
 *   Droid         .factory/hooks.json (events at the top level), .factory/settings.json ("hooks")
 *   opencode      .opencode/plugins/* (each file), opencode.json and opencode.jsonc ("mcp")
 *   Amp           .amp/plugins/* (each file)
 *   VS Code       .vscode/mcp.json ("servers")
 *
 * A fingerprint covers everything that decides what runs: for a hook, the
 * agent, event, matcher and command, and the contents of any script in the
 * repository the command names; for an MCP server, its whole configuration
 * (command, arguments, environment, headers, URL); for a plugin, every file
 * in it. Changing any of them is a new entry to approve. Immiscible's own
 * hooks and plugins are fingerprinted and approved like any other: a name or
 * a comment that says "immiscible" proves nothing. Commands are never printed
 * whole: a person sees the program, and the fingerprint stands for the rest.
 */

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isOurs } from './claude.mjs';
import { programOf } from './history/config.mjs';
import { secretsIn } from './history/secrets.mjs';

export const ALLOW_FILE = '.immiscible/agent-config.json';
/** A plugin bigger than this, in all its files, is reported and can never be approved: it cannot be fingerprinted whole. */
const MAX_PLUGIN_BYTES = 20_000_000;
const MAX_PLUGIN_FILES = 2000;

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
/** JSON with comments (opencode.jsonc): line and block comments dropped outside strings. */
function readJsonc(f) {
  try {
    const t = readFileSync(f, 'utf8');
    let out = '';
    for (let i = 0, inStr = false; i < t.length; i++) {
      const c = t[i];
      if (inStr) { out += c; if (c === '\\') { out += t[++i] ?? ''; } else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; out += c; continue; }
      if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; out += '\n'; continue; }
      if (c === '/' && t[i + 1] === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++; i++; continue; }
      out += c;
    }
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** sha256 over a canonical description, shortened: what the allow list holds. */
export function configFingerprint(parts) {
  const keys = Object.keys(parts).sort();
  return `sha256:${createHash('sha256').update(JSON.stringify(keys.map((k) => [k, parts[k] ?? null]))).digest('hex').slice(0, 16)}`;
}

/** Deterministic JSON (sorted keys): the bytes a configuration's fingerprint covers. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The scripts in the repository a hook command names (relative, or under a project-dir variable), each with its contents' hash. */
function scriptsOf(command, dir) {
  if (!dir) return [];
  let root;
  try { root = realpathSync(dir); } catch { return []; }
  const text = String(command ?? '').replace(/\$\{?(CLAUDE_PROJECT_DIR|FACTORY_PROJECT_DIR|GEMINI_PROJECT_DIR|CODEX_PROJECT_DIR|PWD)\}?/g, root);
  const out = [];
  for (const raw of text.split(/[\s;|&()<>]+/)) {
    const w = raw.replace(/^["']|["']$/g, '');
    if (!w || w.startsWith('-') || !/[./]/.test(w) || /^[a-z]+:\/\//i.test(w)) continue;
    const at = path.isAbsolute(w) ? w : path.join(root, w);
    let real;
    try { real = realpathSync(at); } catch { continue; }
    if (real !== root && !real.startsWith(root + path.sep)) continue;
    try { if (!statSync(real).isFile()) continue; } catch { continue; }
    try { out.push([path.relative(root, real), sha(readFileSync(real))]); } catch { /* unreadable */ }
  }
  return out.sort();
}

/**
 * What makes an entry worth a second look, beyond being new, as codes a reviewer reads (RISKS):
 *   unpinned_package  npx, bunx, pnpm dlx, yarn dlx, uvx or pipx run with no fixed version (or @latest): it runs
 *                     whatever was published last, so a hijacked release runs on every machine that opens the repository
 *   inline_secret     a key in the configuration itself (an MCP server's env or headers, a hook's command), committed
 *                     where everyone with the repository can read it
 *   network_at_start  a SessionStart hook that reaches the network: Mini Shai-Hulud spread through a SessionStart hook
 *   plain_http        a remote MCP server over http, not https, to anywhere but this machine
 */
export const RISKS = Object.freeze({
  unpinned_package: 'runs the newest published version of a package, so a hijacked release runs here',
  inline_secret: 'holds a key in the file itself, readable by everyone with the repository',
  network_at_start: 'reaches the network as every session starts',
  plain_http: 'talks to a remote server over plain http',
});

const RUNNER = /(?:^|[\s;&|(])(npx|bunx|pnpx|pnpm\s+dlx|yarn\s+dlx|uvx|pipx\s+run)(?=\s)/g;
/** Runner flags that take the next word as their value; the first four name the package itself. */
const PACKAGE_FLAGS = new Set(['--from', '-p', '--package', '--spec']);
const VALUE_FLAGS = new Set([...PACKAGE_FLAGS, '--python', '--with', '--index-url', '--registry', '--cache', '-c', '--call', '--userconfig']);

/** The package each runner in a command line runs: ["@scope/pkg@1.2.3", "mcp-server-fetch", ...]. */
export function packagesRun(command) {
  const out = [];
  const cmd = String(command ?? '');
  for (const m of cmd.matchAll(RUNNER)) {
    const words = cmd.slice(m.index + m[0].length).split(/[;&|)]/)[0].trim().split(/\s+/).filter(Boolean);
    let pkg = null;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.startsWith('-')) {
        const [flag, inline] = w.split('=', 2);
        const value = inline ?? (VALUE_FLAGS.has(flag) ? words[++i] : undefined);
        if (PACKAGE_FLAGS.has(flag) && value) { pkg = value; break; }
        continue;
      }
      pkg = w;
      break;
    }
    if (pkg) out.push(pkg.replace(/^["']|["']$/g, ''));
  }
  return out;
}

/** Is a package spec pinned to a version? "pkg@1.2.3", "@scope/pkg@1.2.3", "pkg==1.2" and a local path are. */
export function pinned(spec) {
  const s = String(spec ?? '').replace(/^["']|["']$/g, '');
  if (!s || /^[.~/]/.test(s) || /^file:/i.test(s)) return true;
  const exact = (v) => /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v) || /^[0-9a-f]{40}$/i.test(v);
  // npm:, github: and git URLs are pinned only by a full commit hash after #.
  if (/^[a-z][\w+.-]*:/i.test(s)) return /#[0-9a-f]{40}$/i.test(s);
  const eq = /==\s*([^\s,;]+)$/.exec(s);
  if (eq) return /^\d+(\.\d+)+$/.test(eq[1]);
  const at = s.startsWith('@') ? s.indexOf('@', 1) : s.indexOf('@');
  return at > 0 && exact(s.slice(at + 1));
}

/** Risk codes for a command line (and the configuration around it). */
export function risksOf({ command = '', config = null, event = null } = {}) {
  const out = new Set();
  const cmd = String(command ?? '');
  if (packagesRun(cmd).some((p) => !pinned(p))) out.add('unpinned_package');
  const blob = `${cmd} ${config ? JSON.stringify({ env: config.env ?? null, headers: config.headers ?? null, url: config.url ?? config.serverUrl ?? config.httpUrl ?? null }) : ''}`;
  if (secretsIn(blob).length) out.add('inline_secret');
  if (event === 'SessionStart' && /\b(curl|wget|nc|ncat|Invoke-WebRequest|iwr)\b|https?:\/\//i.test(cmd)) out.add('network_at_start');
  const url = config?.url ?? config?.serverUrl ?? config?.httpUrl ?? null;
  if (typeof url === 'string' && /^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(url)) out.add('plain_http');
  return [...out];
}

const hookItem = (agent, file, event, matcher, command, dir, kind = 'hook') => ({
  kind, agent, file, event, matcher: matcher ?? null, program: programOf(command), immiscible: isOurs(command),
  risks: risksOf({ command, event }),
  fingerprint: configFingerprint({ kind, agent, event, matcher: matcher ?? null, command: String(command ?? ''), scripts: scriptsOf(command, dir) }),
});

const serverItem = (agent, file, name, cfg, raw = null) => {
  const run = cfg?.url ?? cfg?.serverUrl ?? cfg?.httpUrl ?? [cfg?.command, ...(Array.isArray(cfg?.args) ? cfg.args : [])].filter(Boolean).join(' ');
  const remote = Boolean(cfg?.url ?? cfg?.serverUrl ?? cfg?.httpUrl);
  return {
    kind: 'mcp_server', agent, file, name, program: remote ? (() => { try { return new URL(run).host; } catch { return 'remote'; } })() : programOf(run), immiscible: false,
    risks: risksOf({ command: remote ? '' : run, config: raw != null ? { ...cfg, env: raw } : cfg }),
    // The whole configuration: command, arguments, environment, headers, URL and anything else the agent reads.
    fingerprint: configFingerprint({ kind: 'mcp_server', agent, name, config: raw ?? canonical(cfg ?? null) }),
  };
};

/** Hooks in Claude Code's grouped shape: { Event: [{ matcher, hooks: [{ command | url }] }] }. */
function grouped(agent, file, hooks) {
  const out = [];
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) out.push(hookItem(agent, file, event, g?.matcher, h?.command ?? h?.url ?? '', dirOf.current));
    }
  }
  return out;
}

/** Hooks in Cursor's and Windsurf's flat shape: { event: [{ command }] }. */
function flat(agent, file, hooks) {
  const out = [];
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const h of list) out.push(hookItem(agent, file, event, null, h?.command ?? '', dirOf.current));
  }
  return out;
}

const servers = (agent, file, map) => (map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map).map(([n, c]) => serverItem(agent, file, n, c)) : []);

/**
 * Codex's [mcp_servers.<name>] tables, with their sub-tables ([mcp_servers.<name>.env] and the rest): each
 * server's lines, comments and blank lines dropped, are what its fingerprint covers, so a change to any
 * key, an argument on another line or its environment is a new entry. The command and URL are read for display.
 */
function codexServers(file, text) {
  const servers = new Map();
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const head = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(t);
    if (head) {
      const m = /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([\w-]+))/.exec(head[1]);
      current = m ? (m[1] ?? m[2] ?? m[3]) : null;
      if (current && !servers.has(current)) servers.set(current, []);
      if (current) servers.get(current).push(t);
      continue;
    }
    if (current) servers.get(current).push(t);
  }
  return [...servers].map(([name, lines]) => {
    const body = lines.join('\n');
    const val = (k) => new RegExp(`^${k}\\s*=\\s*(["'])(.*?)\\1`, 'm').exec(body)?.[2] ?? null;
    const args = [...(/^args\s*=\s*\[([^\]]*)\]/m.exec(body)?.[1] ?? '').matchAll(/(["'])(.*?)\1/g)].map((m) => m[2]);
    return serverItem('codex', file, name, { command: val('command'), args, url: val('url') }, body);
  });
}

/** Every file under a plugin directory, sorted, with its contents' hash; null when it is too big to hash whole. */
function treeHash(root) {
  const files = [];
  let bytes = 0;
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const f = path.join(d, n);
      const st = statSync(f);
      if (st.isDirectory()) { walk(f); continue; }
      if (!st.isFile()) continue;
      bytes += st.size;
      if (bytes > MAX_PLUGIN_BYTES || files.length >= MAX_PLUGIN_FILES) throw new Error('too big');
      files.push([path.relative(root, f), sha(readFileSync(f))]);
    }
  };
  try { walk(root); } catch { return null; }
  return files;
}

function plugins(agent, dir, rel) {
  const at = path.join(dir, rel);
  if (!existsSync(at)) return [];
  const out = [];
  let names = [];
  try { names = readdirSync(at); } catch { return []; }
  for (const n of names.sort()) {
    const f = path.join(at, n);
    let content = null;
    let ours = false;
    try {
      const st = statSync(f);
      if (st.isDirectory()) content = treeHash(f);
      else if (/\.(m?js|cjs|ts)$/.test(n)) {
        if (st.size <= MAX_PLUGIN_BYTES) {
          const body = readFileSync(f);
          content = [[n, sha(body)]];
          ours = /immiscible-hook plugin/.test(body.toString('utf8', 0, 300));
        }
      } else continue;
    } catch { continue; }
    out.push({
      kind: 'plugin', agent, file: path.join(rel, n), name: n, program: n, immiscible: ours,
      // Too big to hash whole: reported, and never approvable.
      ...(content ? {} : { unapprovable: true }),
      fingerprint: configFingerprint({ kind: 'plugin', agent, name: n, files: content ?? `unhashable:${Date.now()}:${Math.random()}` }),
    });
  }
  return out;
}

/** The repository being read, for hookItem's script hashing (set by inventory). */
const dirOf = { current: null };

/** Every hook, plugin and MCP server the repository at dir configures for a coding agent. */
export function inventory(dir) {
  dirOf.current = dir;
  const items = [];
  const json = (rel) => (existsSync(path.join(dir, rel)) ? readJson(path.join(dir, rel)) : null);
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) items.push(...grouped('claude-code', rel, json(rel)?.hooks));
  items.push(...servers('claude-code', '.mcp.json', json('.mcp.json')?.mcpServers));
  items.push(...grouped('codex', '.codex/hooks.json', json('.codex/hooks.json')?.hooks));
  if (existsSync(path.join(dir, '.codex/config.toml'))) {
    try { items.push(...codexServers('.codex/config.toml', readFileSync(path.join(dir, '.codex/config.toml'), 'utf8'))); } catch { /* unreadable */ }
  }
  items.push(...flat('cursor', '.cursor/hooks.json', json('.cursor/hooks.json')?.hooks));
  items.push(...servers('cursor', '.cursor/mcp.json', json('.cursor/mcp.json')?.mcpServers));
  items.push(...flat('windsurf', '.windsurf/hooks.json', json('.windsurf/hooks.json')?.hooks));
  const gem = json('.gemini/settings.json');
  items.push(...grouped('gemini', '.gemini/settings.json', gem?.hooks), ...servers('gemini', '.gemini/settings.json', gem?.mcpServers));
  const droid = json('.factory/hooks.json');
  if (droid) items.push(...grouped('droid', '.factory/hooks.json', droid.hooks ?? droid));
  items.push(...grouped('droid', '.factory/settings.json', json('.factory/settings.json')?.hooks));
  items.push(...plugins('opencode', dir, '.opencode/plugins'), ...plugins('opencode', dir, '.opencode/plugin'));
  for (const rel of ['opencode.json', 'opencode.jsonc']) {
    const f = path.join(dir, rel);
    if (existsSync(f)) items.push(...servers('opencode', rel, readJsonc(f)?.mcp));
  }
  items.push(...plugins('amp', dir, '.amp/plugins'));
  items.push(...servers('vscode', '.vscode/mcp.json', json('.vscode/mcp.json')?.servers));
  return items;
}

/** The allow list committed in the repository: { hooks: [{ fingerprint, note }] }, or an empty one. */
export function readAllowList(dir) {
  const f = path.join(dir, ALLOW_FILE);
  if (!existsSync(f)) return { file: ALLOW_FILE, exists: false, allowed: new Set(), error: null };
  const j = readJson(f);
  if (!j || !Array.isArray(j.allow)) return { file: ALLOW_FILE, exists: true, allowed: new Set(), error: `${ALLOW_FILE} is not valid: it needs { "allow": [{ "fingerprint": "sha256:..." }] }` };
  return { file: ALLOW_FILE, exists: true, allowed: new Set(j.allow.map((x) => (typeof x === 'string' ? x : x?.fingerprint)).filter(Boolean)), error: null };
}

/** What the allow list file would hold to approve these items (one entry each, with a note a reviewer reads). */
export function allowListFor(items) {
  const seen = new Set();
  const allow = [];
  for (const i of items) {
    if (i.unapprovable || seen.has(i.fingerprint)) continue;
    seen.add(i.fingerprint);
    allow.push({ fingerprint: i.fingerprint, note: describe(i) });
  }
  return { $comment: 'Hooks, plugins and MCP servers this repository may configure for coding agents. Checked by immiscible scan --ci; change it in a reviewed pull request.', allow };
}

export function describe(i) {
  if (i.kind === 'mcp_server') return `${i.agent} MCP server ${i.name} (${i.program}) in ${i.file}`;
  if (i.kind === 'plugin') return `${i.agent} plugin ${i.name} in ${i.file}${i.unapprovable ? ', too big to fingerprint' : ''}`;
  return `${i.agent} ${i.event}${i.matcher ? ` (${i.matcher})` : ''} hook running ${i.program}, in ${i.file}`;
}

/** Items not allowed. Immiscible's own are approved like any other: claiming the name proves nothing. */
export function unapproved(items, allowed) {
  return items.filter((i) => i.unapprovable || !allowed.has(i.fingerprint));
}
