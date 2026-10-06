/**
 * The local half of the AI check (`immiscible check`): what the agents on
 * this machine can touch, read from files only. Nothing is run, nothing is
 * sent, and no secret leaves this module: a key found anywhere becomes its
 * provider, where it was, a redacted form (its prefix and last four
 * characters, as the provider's own console shows it) and a fingerprint (the
 * first 12 hex characters of its SHA-256), never the value.
 *
 * Read, in the project:
 *   .env and every .env.* file           provider keys, and whether git ignores the file
 *   .mcp.json, mcp.json, .cursor/mcp.json, .vscode/mcp.json, claude_desktop_config.json
 *                                         MCP servers, and what each can do
 *   .claude/settings.json, .claude/settings.local.json
 *                                         Claude Code permissions
 *   package.json, pyproject.toml, requirements*.txt, Pipfile
 *                                         agent frameworks (detect.mjs)
 * And in the home directory:
 *   ~/.zshrc, ~/.zprofile, ~/.zshenv, ~/.bashrc, ~/.bash_profile, ~/.profile, ~/.config/fish/config.fish
 *                                         provider keys exported in shell config
 *   ~/.claude.json, ~/.claude/settings.json, ~/.cursor/mcp.json, Claude Desktop's config,
 *   ~/.codeium/windsurf/mcp_config.json, ~/.config/devin/mcp_config.json, ~/.gemini/settings.json
 *                                         MCP servers and Claude Code permissions for every project
 *
 * What it cannot see: whether a file is already committed (that needs git
 * itself), what a key may do at its provider, and agents configured
 * anywhere else.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseEnv } from './dotenv.mjs';
import { detectProject } from './detect.mjs';
import { inspectHook } from './claude.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CLAUDE_JSON = 8 * 1024 * 1024; // ~/.claude.json keeps history too

/** Provider keys by shape, most specific first (an Anthropic key also starts sk-). */
export const KEY_SHAPES = Object.freeze([
  { provider: 'anthropic', label: 'Anthropic', rx: /^(sk-ant-(?:admin\d*|api\d*|oat\d*)-)[A-Za-z0-9_-]{20,}$/ },
  { provider: 'openrouter', label: 'OpenRouter', rx: /^(sk-or-v\d-)[A-Za-z0-9_-]{20,}$/ },
  { provider: 'openai', label: 'OpenAI', rx: /^(sk-(?:proj-|svcacct-|admin-)?)[A-Za-z0-9_-]{20,}$/ },
  { provider: 'google', label: 'Google AI', rx: /^(AIza)[0-9A-Za-z_-]{35}$/ },
  { provider: 'xai', label: 'xAI', rx: /^(xai-)[A-Za-z0-9]{20,}$/ },
  { provider: 'groq', label: 'Groq', rx: /^(gsk_)[A-Za-z0-9]{20,}$/ },
  { provider: 'stripe', label: 'Stripe', rx: /^((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{16,}$/ },
]);

/** Variable names that hold a provider key even when the value has a shape we do not know. */
const KEY_NAMES = /^(OPENAI|ANTHROPIC|OPENROUTER|GEMINI|GOOGLE_API|GOOGLE_GENERATIVE_AI|XAI|GROQ|MISTRAL|COHERE|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|STRIPE_SECRET|STRIPE)_?(API_)?KEY$/;
const NAME_PROVIDER = [[/^OPENAI/, 'openai', 'OpenAI'], [/^ANTHROPIC/, 'anthropic', 'Anthropic'], [/^OPENROUTER/, 'openrouter', 'OpenRouter'], [/^(GEMINI|GOOGLE)/, 'google', 'Google AI'], [/^XAI/, 'xai', 'xAI'], [/^GROQ/, 'groq', 'Groq'], [/^MISTRAL/, 'mistral', 'Mistral'], [/^COHERE/, 'cohere', 'Cohere'], [/^DEEPSEEK/, 'deepseek', 'DeepSeek'], [/^TOGETHER/, 'together', 'Together'], [/^FIREWORKS/, 'fireworks', 'Fireworks'], [/^PERPLEXITY/, 'perplexity', 'Perplexity'], [/^STRIPE/, 'stripe', 'Stripe']];

/** A placeholder, a reference to another variable, or nothing: not a key. */
const placeholder = (v) => !v || v.length < 12 || /^\$|\$\{|^<|^your|^xxx|^changeme|^\*+$|example|placeholder|^sk-\.\.\.|\.\.\./i.test(v);

/** What a value is, if it is a key: { provider, label, redacted, fingerprint }. The value itself is not kept. */
export function classifyKey(value, name = null) {
  const v = String(value ?? '').trim();
  if (placeholder(v)) return null;
  for (const s of KEY_SHAPES) {
    const m = s.rx.exec(v);
    if (m) return { provider: s.provider, label: s.label, redacted: `${m[1]}...${v.slice(-4)}`, fingerprint: fingerprint(v), live: s.provider === 'stripe' ? /_live_/.test(m[1]) : null };
  }
  if (name && KEY_NAMES.test(name)) {
    const hit = NAME_PROVIDER.find(([rx]) => rx.test(name));
    if (hit) return { provider: hit[1], label: hit[2], redacted: `...${v.slice(-4)}`, fingerprint: fingerprint(v), live: null };
  }
  return null;
}

export const fingerprint = (v) => `sha256:${createHash('sha256').update(String(v)).digest('hex').slice(0, 12)}`;

const readText = (f, max = MAX_BYTES) => {
  try {
    const st = statSync(f);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(f, 'utf8');
  } catch { return null; }
};
const readJson = (f, max) => { const t = readText(f, max); if (t == null) return null; try { return JSON.parse(t); } catch { return undefined; } };

/** "~/.zshrc" for a file under home, "./.env" style for the project, else the path. */
export function shown(file, { dir, home }) {
  const rel = path.relative(dir, file);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  if (home) {
    const h = path.relative(home, file);
    if (!h.startsWith('..') && !path.isAbsolute(h)) return `~/${h}`;
  }
  return file;
}

// ---------------------------------------------------------------- git ignore

/** Whether .gitignore (null when there is none) keeps `name`, a file at the project's top level, out of git. */
export function gitIgnores(gitignoreText, name) {
  if (gitignoreText == null) return null;
  const toRx = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
  let ignored = false;
  for (const raw of gitignoreText.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const neg = l.startsWith('!');
    const p = (neg ? l.slice(1) : l).replace(/^\//, '').replace(/^\*\*\//, '');
    if (p.endsWith('/')) continue;
    if (toRx(p).test(name)) ignored = !neg;
  }
  return ignored;
}

// --------------------------------------------------------------------- keys

/** Lines of a shell config that set a variable: export NAME=value, NAME=value, fish's set -gx NAME value. */
function shellValues(text) {
  const out = { ...parseEnv(text) };
  for (const m of text.matchAll(/^\s*set\s+(?:-[a-zA-Z]+\s+)*([A-Za-z_][A-Za-z0-9_]*)\s+["']?([^"'\s]+)["']?/gm)) out[m[1]] = m[2];
  return out;
}

function keysIn(values, where) {
  const out = [];
  for (const [name, value] of Object.entries(values)) {
    const k = classifyKey(value, name);
    if (k) out.push({ ...k, name, ...where });
  }
  return out;
}

const SHELL_FILES = ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile', '.config/fish/config.fish'];

// ---------------------------------------------------------------------- MCP

/** What an MCP server can do, from its name, its package or command, and its URL. Riskiest match wins. */
const CAPABILITY_WORDS = [
  ['pay', /stripe|paypal|square|adyen|braintree|x402|coinbase|wallet|payment|checkout|mollie|wise|revolut|plaid|fireblocks|privy|turnkey|circle/],
  ['shell', /shell|terminal|desktop-commander|\bexec\b|command-runner|server-commands|ssh|bash|iterm/],
  ['db_write', /postgres|mysql|sqlite|supabase|mongo|redis|neon|planetscale|prisma|dynamodb|firebase|firestore|database|bigquery|snowflake|clickhouse/],
  ['email', /gmail|email|smtp|sendgrid|mailgun|resend|postmark|outlook|mailchimp/],
  ['write', /filesystem|github|gitlab|notion|linear|jira|slack|google-drive|gdrive|drive|sheets|airtable|asana|trello|confluence|hubspot|salesforce|\bgit\b/],
  ['network', /fetch|puppeteer|playwright|browser|brave|search|scrape|firecrawl/],
];
const CAPABILITY_LINE = { pay: 'can make payments', shell: 'can run shell commands', db_write: 'can write to a database', email: 'can send email', write: 'can change files or records', network: 'can reach the internet', other: 'is connected' };

export function classifyServer(name, cfg = {}) {
  const hay = [name, cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : []), cfg.url, cfg.serverUrl, cfg.httpUrl].filter((x) => typeof x === 'string').join(' ').toLowerCase();
  const hit = CAPABILITY_WORDS.find(([, rx]) => rx.test(hay));
  return hit ? hit[0] : 'other';
}

/** { name: config } from an MCP config file, whichever key it uses. */
function serversOf(j) {
  if (!j || typeof j !== 'object') return {};
  const s = j.mcpServers ?? j.servers ?? j.mcp?.servers ?? null;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/** Every string in a server's env and headers that is a key, without keeping it. */
function keysInServer(cfg) {
  const vals = { ...(cfg.env && typeof cfg.env === 'object' ? cfg.env : {}), ...(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}) };
  const out = [];
  for (const [k, v] of Object.entries(vals)) {
    if (typeof v !== 'string') continue;
    const bare = v.replace(/^Bearer\s+/i, '');
    const c = classifyKey(bare, k);
    if (c) out.push({ ...c, name: k });
  }
  for (const a of Array.isArray(cfg.args) ? cfg.args : []) {
    if (typeof a !== 'string') continue;
    const c = classifyKey(a.replace(/^--?[a-z-]+=/i, ''));
    if (c) out.push({ ...c, name: 'args' });
  }
  return out;
}

// -------------------------------------------------------------- Claude Code

/** What a Claude Code settings file lets the agent do without asking. */
export function claudePermissions(settings) {
  const p = settings?.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  const allow = Array.isArray(p.allow) ? p.allow.filter((x) => typeof x === 'string') : [];
  const out = [];
  const mode = typeof p.defaultMode === 'string' ? p.defaultMode : null;
  if (mode === 'bypassPermissions') out.push({ capability: 'shell', what: 'may run any command and change any file without asking (bypassPermissions)', unlimited: true });
  else if (mode === 'acceptEdits') out.push({ capability: 'write', what: 'may edit files without asking (acceptEdits)' });
  if (allow.some((a) => /^Bash(\((\*|:\*|\*:\*)?\))?$/.test(a))) out.push({ capability: 'shell', what: 'may run any shell command without asking (Bash(*) is allowed)', unlimited: true });
  for (const a of allow) {
    const m = /^mcp__([^_](?:[^_]|_(?!_))*)(?:__(.+))?$/.exec(a);
    if (!m || m[1] === 'immiscible' || m[1] === 'plugin_immiscible_immiscible') continue;
    const cap = classifyServer(m[1]);
    if (['pay', 'db_write', 'email', 'shell'].includes(cap)) out.push({ capability: cap, what: `may use ${m[2] ? `the ${m[1]} tool ${m[2]}` : `every ${m[1]} tool`} without asking, which ${CAPABILITY_LINE[cap]}` });
  }
  if (allow.includes('WebFetch')) out.push({ capability: 'network', what: 'may fetch any web page without asking' });
  return out;
}

// --------------------------------------------------------------------- scan

/**
 * Scan a project and, unless home is null, the home directory.
 * Returns { dir, project, agents, mcp, claude, keys, findings }, none of
 * which holds a secret.
 */
export function scan(dir, { home = null } = {}) {
  const at = { dir, home };
  const project = detectProject(dir);
  const gitignore = readText(path.join(dir, '.gitignore'));

  // Keys: the project's .env files, then shell config.
  const keys = [];
  let envFiles = [];
  try { envFiles = readdirSync(dir).filter((f) => /^\.env(\..+)?$/.test(f)).sort(); } catch { /* unreadable */ }
  const envInfo = [];
  for (const f of envFiles) {
    const text = readText(path.join(dir, f));
    if (text == null) continue;
    const ignored = gitIgnores(gitignore, f);
    const found = keysIn(parseEnv(text), { file: f, kind: 'env', ignored });
    keys.push(...found);
    envInfo.push({ file: f, keys: found.length, ignored });
  }
  if (home) {
    for (const f of SHELL_FILES) {
      const text = readText(path.join(home, f));
      if (text != null) keys.push(...keysIn(shellValues(text), { file: `~/${f}`, kind: 'shell', ignored: null }));
    }
  }

  // MCP servers: the project's files, then the user's.
  const servers = [];
  const addFile = (file, j, scope) => {
    for (const [name, cfg] of Object.entries(serversOf(j))) {
      if (!cfg || typeof cfg !== 'object') continue;
      const url = cfg.url ?? cfg.serverUrl ?? cfg.httpUrl ?? null;
      const governed = name === 'immiscible' || (typeof url === 'string' && /\/mcp\/proxy\//.test(url));
      const inline = keysInServer(cfg);
      servers.push({ name, file: shown(file, at), scope, capability: classifyServer(name, cfg), transport: url ? 'http' : 'stdio', governed, keysInline: inline.length });
      for (const k of inline) keys.push({ ...k, file: shown(file, at), kind: 'mcp', server: name, ignored: scope === 'project' ? gitIgnores(gitignore, path.relative(dir, file)) : null });
    }
  };
  for (const f of ['.mcp.json', 'mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', 'claude_desktop_config.json']) {
    const j = readJson(path.join(dir, f));
    if (j) addFile(path.join(dir, f), j, 'project');
  }
  if (home) {
    const cj = readJson(path.join(home, '.claude.json'), MAX_CLAUDE_JSON);
    if (cj) {
      addFile(path.join(home, '.claude.json'), cj, 'user');
      const proj = cj.projects?.[path.resolve(dir)];
      if (proj) addFile(path.join(home, '.claude.json'), proj, 'user');
    }
    for (const f of ['.cursor/mcp.json', 'Library/Application Support/Claude/claude_desktop_config.json', '.config/Claude/claude_desktop_config.json', '.codeium/windsurf/mcp_config.json', '.config/devin/mcp_config.json', '.gemini/settings.json']) {
      const j = readJson(path.join(home, f));
      if (j) addFile(path.join(home, f), j, 'user');
    }
  }

  // Claude Code: the project's settings, and the user's.
  const hook = inspectHook(dir);
  const hooked = hook.entries.length > 0;
  const claude = { present: project.claudeCode.present, hook: hooked, files: [], allows: [] };
  const settingsFiles = [path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json'), ...(home ? [path.join(home, '.claude', 'settings.json')] : [])];
  for (const f of settingsFiles) {
    const j = readJson(f);
    if (!j) continue;
    claude.files.push(shown(f, at));
    for (const p of claudePermissions(j)) claude.allows.push({ ...p, file: shown(f, at) });
  }

  // Findings, riskiest first, in the shape the AI check reads (core/check.js rankPermissions).
  const findings = [];
  for (const s of servers) {
    if (s.governed || s.capability === 'other') continue;
    findings.push({
      subject: `${s.name} (MCP)`, capability: s.capability, asksFirst: false, unlimited: s.capability === 'pay' ? keys.some((k) => k.server === s.name && k.live) : false,
      detail: `${s.name} (MCP, ${s.file}) ${CAPABILITY_LINE[s.capability]}${s.capability === 'pay' && keys.some((k) => k.server === s.name && k.live) ? ' with a live secret key, so with no limit but the account\'s' : ''}, and nothing asks a person first.`,
    });
  }
  for (const a of claude.allows) {
    findings.push({
      subject: 'Claude Code', capability: a.capability, asksFirst: hooked, unlimited: Boolean(a.unlimited),
      detail: `Claude Code ${a.what}, in ${a.file}${hooked ? '; the Immiscible hook still asks first' : ''}.`,
    });
  }
  const exposed = keys.filter((k) => k.kind !== 'shell' && k.ignored !== true);
  const byFile = new Map();
  for (const k of exposed) byFile.set(k.file, [...(byFile.get(k.file) ?? []), k]);
  for (const [file, ks] of byFile) {
    const why = ks[0].ignored === false ? 'which git does not ignore' : 'and there is no .gitignore';
    findings.push({ subject: file, capability: 'admin', asksFirst: false, detail: `${ks.length === 1 ? 'A provider key is' : `${ks.length} provider keys are`} in ${file}, ${why}: one commit and anyone with the repository can spend on your account.`, kind: 'key_exposed' });
  }
  const inShell = keys.filter((k) => k.kind === 'shell');
  if (inShell.length) {
    const files = [...new Set(inShell.map((k) => k.file))];
    findings.push({ subject: 'shell config', capability: 'read', asksFirst: false, detail: `${inShell.length === 1 ? 'A provider key is' : `${inShell.length} provider keys are`} exported in ${files.join(', ')}, so every program you run can read ${inShell.length === 1 ? 'it' : 'them'}.`, kind: 'key_shell' });
  }

  return {
    dir,
    name: project.name,
    agents: project.sdks.map((s) => s.name).filter((n, i, a) => a.indexOf(n) === i),
    wallets: project.wallets.map((w) => w.package),
    mcp: { servers },
    claude,
    env: envInfo,
    keys: keys.map(({ live, ...k }) => k),
    findings: rank(findings),
  };
}

/** The same ranking as the report (core/check.js CAPABILITY_RISK), plus exposed keys, which rank with shell access. */
const RISK = { pay: 100, shell: 90, db_write: 80, email: 70, write: 60, admin: 55, network: 40, read: 20, other: 10 };
export function rank(findings) {
  return findings
    .map((f) => {
      const base = f.kind === 'key_exposed' ? 92 : RISK[f.capability] ?? 10;
      const risk = base + (f.unlimited ? 8 : 0) + (f.asksFirst === false ? 5 : 0) - (f.asksFirst === true ? 15 : 0);
      return { ...f, risk, severity: risk >= 95 ? 'high' : risk >= 60 ? 'medium' : 'low' };
    })
    .sort((a, b) => b.risk - a.risk || a.subject.localeCompare(b.subject));
}

/**
 * What --upload sends: the findings as the AI check reads them
 * (`permissions` on POST /api/check/upload), and nothing else. No key,
 * redacted or fingerprinted, no file contents, no path outside the project
 * beyond "~/".
 */
export function uploadBody(result) {
  return {
    permissions: result.findings.map((f) => ({
      subject: f.subject,
      capability: f.kind === 'key_exposed' ? 'admin' : f.capability,
      detail: f.detail,
      unlimited: Boolean(f.unlimited),
      asksFirst: f.asksFirst ?? null,
    })),
  };
}
