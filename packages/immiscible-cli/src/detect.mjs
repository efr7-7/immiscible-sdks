/**
 * What kind of project this is, read from files only (nothing is run):
 * package.json dependencies, pyproject.toml and requirements files, a
 * .claude/ directory or Claude Code settings, MCP configs, and x402 or
 * wallet SDKs. The answer picks the snippet init prints and whether it
 * offers the Claude Code hook.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** npm package -> what it is. Order matters: the first SDK found is the one the snippet is for. */
const NODE_SDKS = [
  ['@openai/agents', { id: 'openai-agents', name: 'OpenAI Agents SDK', vendor: 'openai' }],
  ['ai', { id: 'vercel-ai', name: 'Vercel AI SDK', vendor: 'custom' }],
  ['@langchain/langgraph', { id: 'langchain', name: 'LangChain', vendor: 'custom' }],
  ['@langchain/core', { id: 'langchain', name: 'LangChain', vendor: 'custom' }],
  ['langchain', { id: 'langchain', name: 'LangChain', vendor: 'custom' }],
  ['@anthropic-ai/sdk', { id: 'anthropic', name: 'Anthropic SDK', vendor: 'anthropic' }],
  ['openai', { id: 'openai', name: 'OpenAI SDK', vendor: 'openai' }],
];
const NODE_WALLETS = ['x402', 'x402-fetch', 'x402-axios', 'x402-express', 'x402-hono', 'x402-next', '@coinbase/x402', '@coinbase/cdp-sdk', '@coinbase/coinbase-sdk', '@privy-io/server-auth', '@privy-io/node', '@turnkey/sdk-server', '@fireblocks/ts-sdk', 'fireblocks-sdk', '@circle-fin/developer-controlled-wallets', 'viem', 'ethers', '@solana/web3.js'];
const NODE_MCP = ['@modelcontextprotocol/sdk'];

const PY_SDKS = [
  ['openai-agents', { id: 'openai-agents', name: 'OpenAI Agents SDK', vendor: 'openai' }],
  ['langgraph', { id: 'langchain', name: 'LangChain', vendor: 'custom' }],
  ['langchain-core', { id: 'langchain', name: 'LangChain', vendor: 'custom' }],
  ['langchain', { id: 'langchain', name: 'LangChain', vendor: 'custom' }],
  ['anthropic', { id: 'anthropic', name: 'Anthropic SDK', vendor: 'anthropic' }],
  ['openai', { id: 'openai', name: 'OpenAI SDK', vendor: 'openai' }],
];
const PY_WALLETS = ['x402', 'cdp-sdk', 'coinbase-agentkit', 'web3', 'eth-account', 'fireblocks-sdk', 'circle-developer-controlled-wallets', 'solana', 'solders'];
const PY_MCP = ['mcp', 'fastmcp'];

const MCP_FILES = ['.mcp.json', 'mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', 'claude_desktop_config.json'];

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Python requirement names from pyproject.toml (PEP 621 and Poetry), requirements*.txt and Pipfile. Lower case, - for _. */
export function pythonDeps(dir) {
  const names = new Set();
  const add = (raw) => {
    const m = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(raw);
    if (m) names.add(m[1].toLowerCase().replace(/[._]/g, '-'));
  };
  const py = readText(path.join(dir, 'pyproject.toml'));
  if (py) {
    // dependencies = [ "openai>=1", ... ] and optional-dependencies tables
    for (const block of py.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g)) for (const s of block[1].matchAll(/["']([^"']+)["']/g)) add(s[1]);
    // [tool.poetry.dependencies] name = "^1"
    for (const sec of py.matchAll(/\[tool\.poetry\.(?:dev-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g)) for (const l of sec[1].split('\n')) if (/^\s*[A-Za-z0-9]/.test(l) && l.includes('=')) add(l);
  }
  let files = [];
  try { files = readdirSync(dir).filter((f) => /^requirements.*\.txt$/.test(f)); } catch { /* none */ }
  for (const f of files) for (const l of (readText(path.join(dir, f)) ?? '').split('\n')) if (l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('-')) add(l);
  const pip = readText(path.join(dir, 'Pipfile'));
  if (pip) for (const sec of pip.matchAll(/\[(?:dev-)?packages\]([\s\S]*?)(?=\n\[|$)/g)) for (const l of sec[1].split('\n')) if (/^\s*[A-Za-z0-9]/.test(l)) add(l);
  return { names, found: Boolean(py || files.length || pip) };
}

export function detectProject(dir) {
  const out = {
    dir,
    name: path.basename(path.resolve(dir)),
    languages: [],
    sdks: [],
    primary: null,
    claudeCode: { present: false, dir: false, settings: null, localSettings: null, claudeMd: false },
    mcp: [],
    wallets: [],
    evidence: [],
  };
  const seen = new Set();
  const addSdk = (s, from) => {
    if (seen.has(`${s.lang}:${s.id}`)) return;
    seen.add(`${s.lang}:${s.id}`);
    out.sdks.push({ ...s, from });
  };

  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    out.languages.push('node');
    if (typeof pkg.name === 'string' && pkg.name) out.name = pkg.name.replace(/^@[^/]+\//, '');
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
    for (const [n, s] of NODE_SDKS) if (n in deps) addSdk({ ...s, lang: 'node' }, `package.json: ${n}`);
    for (const n of NODE_WALLETS) if (n in deps) out.wallets.push({ lang: 'node', package: n });
    for (const n of NODE_MCP) if (n in deps) out.mcp.push({ kind: 'sdk', lang: 'node', package: n });
  }

  const py = pythonDeps(dir);
  if (py.found) {
    out.languages.push('python');
    for (const [n, s] of PY_SDKS) if (py.names.has(n)) addSdk({ ...s, lang: 'python' }, `python: ${n}`);
    for (const n of PY_WALLETS) if (py.names.has(n)) out.wallets.push({ lang: 'python', package: n });
    for (const n of PY_MCP) if (py.names.has(n)) out.mcp.push({ kind: 'sdk', lang: 'python', package: n });
  }

  const claudeDir = path.join(dir, '.claude');
  out.claudeCode.dir = isDir(claudeDir);
  out.claudeCode.settings = existsSync(path.join(claudeDir, 'settings.json')) ? path.join(claudeDir, 'settings.json') : null;
  out.claudeCode.localSettings = existsSync(path.join(claudeDir, 'settings.local.json')) ? path.join(claudeDir, 'settings.local.json') : null;
  out.claudeCode.claudeMd = existsSync(path.join(dir, 'CLAUDE.md'));
  out.claudeCode.present = out.claudeCode.dir || out.claudeCode.claudeMd;

  for (const f of MCP_FILES) if (existsSync(path.join(dir, f))) out.mcp.push({ kind: 'config', file: f });

  // The snippet is for the first SDK found in the project's main language.
  out.primary = out.sdks[0] ?? null;
  out.evidence = [
    ...out.sdks.map((s) => s.from),
    ...(out.claudeCode.present ? [out.claudeCode.dir ? '.claude/' : 'CLAUDE.md'] : []),
    ...out.mcp.map((m) => (m.kind === 'config' ? m.file : `${m.lang}: ${m.package}`)),
    ...out.wallets.map((w) => `${w.lang}: ${w.package}`),
  ];
  return out;
}

/** The vendor to register the agent under: what it mostly talks to. */
export function vendorFor(project) {
  if (project.primary?.vendor && project.primary.vendor !== 'custom') return project.primary.vendor;
  if (project.claudeCode.present) return 'anthropic';
  return 'custom';
}

/** A name a person will recognise on their phone. */
export function defaultAgentName(project) {
  const base = String(project.name || 'project').replace(/[-_]+/g, ' ').trim();
  if (project.claudeCode.present && !project.primary) return `Claude Code in ${base}`;
  return /\bagent$/i.test(base) ? base[0].toUpperCase() + base.slice(1) : `${base[0].toUpperCase()}${base.slice(1)} agent`;
}

/** The purpose to suggest: payments where there is a wallet, otherwise general tasks. */
export function defaultPurpose(project) {
  return project.wallets.length ? 'buys_software' : 'other';
}
