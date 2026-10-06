/**
 * The code to paste, for the SDK init found and the rule the agent has.
 * Each uses the Immiscible SDKs (@immiscible/sdk on npm, immiscible on
 * PyPI) exactly as their READMEs and examples do.
 *
 * The guard matches the rule: a payment rule allows payments and nothing
 * else, so a payments agent gets immiscible.pay(); a customer-answering
 * rule covers email.send and message.send; only a rule that covers tool
 * calls gets the tool.call guard. Code a rule can never allow is not
 * printed.
 */

const JS_INSTALL = '// npm install @immiscible/sdk';
const PY_INSTALL = '# pip install immiscible';
const JS_ENV = '// IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY come from .env: run with node --env-file=.env';
const PY_ENV = '# IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY come from the environment: load .env first (python-dotenv, or export them)';

// The tool examples open a ticket: a tool call, which is what a tool rule
// covers. Paying and emailing have guards of their own below.
const TOOL_JS = `// Before a tool runs, ask: allow, refuse, or wait for a person. Your function runs only on allow.
const args = { title: 'Checkout times out', project: 'web' };
await immiscible.guard(
  toolAction('create_ticket', args, { summary: \`Open a ticket: \${args.title}\`, domain: 'tickets.example.com' }),
  () => createTicket(args),
);`;
const TOOL_PY = `# Before a tool runs, ask: allow, refuse, or wait for a person. The block runs only on allow.
args = {"title": "Checkout times out", "project": "web"}
with immiscible.guard(tool_action("create_ticket", args, summary=f"Open a ticket: {args['title']}", domain="tickets.example.com")):
    create_ticket(args)`;
const PAY_JS = `// Before the agent pays, ask: allow, refuse, or wait for a person. Your function runs only on allow.
// Amounts are in minor units: 125000 is £1,250.00.
await immiscible.pay(
  { amount: 125000, currency: 'GBP', merchant: { name: 'Acme Supplies', domain: 'acme.example' }, summary: 'Pay Acme Supplies invoice 0931' },
  () => payInvoice('0931'),
);`;
const PAY_PY = `# Before the agent pays, ask: allow, refuse, or wait for a person. The block runs only on allow.
# Amounts are in minor units: 125000 is £1,250.00.
with immiscible.guard(Immiscible.payment_action(125000, "GBP", {"name": "Acme Supplies", "domain": "acme.example"}, summary="Pay Acme Supplies invoice 0931")):
    pay_invoice("0931")`;
const EMAIL_JS = `// Before the agent writes to a customer, ask: allow, refuse, or wait for a person.
await immiscible.guard(
  { type: 'email.send', summary: 'Reply to the customer about order 1182' },
  () => sendReply('order-1182'),
);`;
const EMAIL_PY = `# Before the agent writes to a customer, ask: allow, refuse, or wait for a person.
with immiscible.guard({"type": "email.send", "summary": "Reply to the customer about order 1182"}):
    send_reply("order-1182")`;

/**
 * What the agent's rules cover, from the rules init made or found
 * ({ kind, actions }), or null when that is not known (an older server).
 */
export function coversFrom(rules) {
  const list = (rules ?? []).filter(Boolean);
  if (!list.length) return null;
  const acts = list.flatMap((r) => (r.kind === 'action' ? r.actions ?? [] : []));
  const known = list.every((r) => r.kind !== 'action' || Array.isArray(r.actions));
  return {
    payment: list.some((r) => r.kind === 'payment'),
    email: acts.some((a) => a === 'email.send' || a === 'message.send' || a === 'email.*' || a === 'message.*'),
    // An action rule from an older server, without its actions: assume tool calls, as before.
    tool: acts.some((a) => a === 'tool.call' || a === 'tool.*' || a === '*') || !known,
  };
}

/** The guard for what the rules cover: tool calls first, then payments, then email. */
function guardFor(lang, covers) {
  const js = lang !== 'python';
  if (!covers || covers.tool) return { id: 'tool', text: js ? TOOL_JS : TOOL_PY };
  if (covers.payment) return { id: 'pay', text: js ? PAY_JS : PAY_PY };
  if (covers.email) return { id: 'email', text: js ? EMAIL_JS : EMAIL_PY };
  return { id: 'tool', text: js ? TOOL_JS : TOOL_PY };
}
const jsImports = (g, extra = []) => [...extra, ...(g.id === 'tool' ? ['toolAction'] : [])];
const pyImports = (g) => (g.id === 'tool' ? 'Immiscible, tool_action' : 'Immiscible');

const SNIPPETS = {
  'node:openai': (g = guardFor('node')) => `${JS_INSTALL}
import OpenAI from 'openai';
import { ${jsImports(g, ['Immiscible']).join(', ')} } from '@immiscible/sdk';

${JS_ENV}
const immiscible = new Immiscible().run();
const openai = new OpenAI(immiscible.gateway.openai()); // model calls through the gateway, metered and traced

${g.text}`,

  'node:anthropic': (g = guardFor('node')) => `${JS_INSTALL}
import Anthropic from '@anthropic-ai/sdk';
import { ${jsImports(g, ['Immiscible']).join(', ')} } from '@immiscible/sdk';

${JS_ENV}
const immiscible = new Immiscible().run();
const anthropic = new Anthropic(immiscible.gateway.anthropic()); // model calls through the gateway, metered and traced

${g.text}`,

  'node:openai-agents': (g = guardFor('node')) => (g.id !== 'tool' ? `${JS_INSTALL}
import { setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents';
import OpenAI from 'openai';
import { Immiscible } from '@immiscible/sdk';

${JS_ENV}
const immiscible = new Immiscible().run();
setDefaultOpenAIClient(new OpenAI(immiscible.gateway.openai()));
setOpenAIAPI('chat_completions'); // the gateway speaks Chat Completions

// Inside the tool that acts:
${g.text}` : `${JS_INSTALL}
import { setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents';
import OpenAI from 'openai';
import { Immiscible } from '@immiscible/sdk';
import { guardOpenAITools } from '@immiscible/sdk/openai-agents';

${JS_ENV}
const immiscible = new Immiscible().run();
setDefaultOpenAIClient(new OpenAI(immiscible.gateway.openai()));
setOpenAIAPI('chat_completions'); // the gateway speaks Chat Completions

// Every tool call asks Immiscible first; a refusal comes back to the model with the reasons.
const tools = guardOpenAITools([createTicket, searchOrders], { client: immiscible });`),

  'node:vercel-ai': (g = guardFor('node')) => (g.id !== 'tool' ? `${JS_INSTALL}
import { createOpenAI } from '@ai-sdk/openai';
import { Immiscible } from '@immiscible/sdk';

${JS_ENV}
const immiscible = new Immiscible().run({ client: 'vercel-ai' });
const provider = createOpenAI(immiscible.gateway.aiSdkOpenAI()); // use provider.chat(...): the gateway speaks Chat Completions

// Inside the tool's execute:
${g.text}` : `${JS_INSTALL}
import { generateText, wrapLanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { Immiscible } from '@immiscible/sdk';
import { guardAiTools, immiscibleMiddleware } from '@immiscible/sdk/ai';

${JS_ENV}
const immiscible = new Immiscible().run({ client: 'vercel-ai' });
const provider = createOpenAI(immiscible.gateway.aiSdkOpenAI());
const model = wrapLanguageModel({ model: provider.chat('gpt-5-mini'), middleware: immiscibleMiddleware({ client: immiscible }) }); // .chat(): the gateway speaks Chat Completions

// Every tool's execute asks Immiscible first.
const tools = guardAiTools({ createTicket, searchOrders }, { client: immiscible });
await generateText({ model, tools, prompt });`),

  'node:langchain': (g = guardFor('node')) => (g.id !== 'tool' ? `${JS_INSTALL}
import { ChatOpenAI } from '@langchain/openai';
import { Immiscible } from '@immiscible/sdk';

${JS_ENV}
const immiscible = new Immiscible().run({ client: 'langchain' });
const llm = new ChatOpenAI({ model: 'gpt-5-mini', configuration: immiscible.gateway.openai() });

// Inside the tool that acts:
${g.text}` : `${JS_INSTALL}
import { ChatOpenAI } from '@langchain/openai';
import { Immiscible } from '@immiscible/sdk';
import { guardLangChainTools } from '@immiscible/sdk/langchain';

${JS_ENV}
const immiscible = new Immiscible().run({ client: 'langchain' });
const llm = new ChatOpenAI({ model: 'gpt-5-mini', configuration: immiscible.gateway.openai() });

// Guarded tools for ToolNode, bindTools or createReactAgent: each call asks Immiscible first.
const tools = guardLangChainTools([createTicket, searchOrders], { client: immiscible });`),

  'node:generic': (g = guardFor('node')) => `${JS_INSTALL}
import { ${jsImports(g, ['Immiscible']).join(', ')} } from '@immiscible/sdk';

${JS_ENV}
const immiscible = new Immiscible().run();

${g.text}`,

  'python:openai': (g = guardFor('python')) => `${PY_INSTALL}
from immiscible import ${pyImports(g)}

${PY_ENV}
immiscible = Immiscible().run()
client = immiscible.gateway.openai_client()  # an OpenAI client through the gateway, metered and traced

${g.text}`,

  'python:anthropic': (g = guardFor('python')) => `${PY_INSTALL}
from immiscible import ${pyImports(g)}

${PY_ENV}
immiscible = Immiscible().run()
client = immiscible.gateway.anthropic_client()  # an Anthropic client through the gateway, metered and traced

${g.text}`,

  'python:openai-agents': (g = guardFor('python')) => (g.id !== 'tool' ? `${PY_INSTALL}
from immiscible import Immiscible

${PY_ENV}
immiscible = Immiscible().run()

# Inside the function tool that acts:
${g.text}` : `${PY_INSTALL}
from immiscible import Immiscible
from immiscible.integrations import guard_tools

${PY_ENV}
immiscible = Immiscible().run()

# Every function tool asks Immiscible first; a refusal comes back to the model with the reasons.
tools = guard_tools([create_ticket, search_orders], client=immiscible)`),

  'python:langchain': (g = guardFor('python')) => (g.id !== 'tool' ? `${PY_INSTALL}
from immiscible import Immiscible

${PY_ENV}
immiscible = Immiscible().run(client="langchain")

# Inside the tool that acts:
${g.text}` : `${PY_INSTALL}
from immiscible import Immiscible
from immiscible.integrations import guard_langchain_tools

${PY_ENV}
immiscible = Immiscible().run(client="langchain")

# Guarded tools for ToolNode, bind_tools or create_react_agent: each call asks Immiscible first.
tools = guard_langchain_tools([create_ticket, search_orders], client=immiscible)`),

  'python:generic': (g = guardFor('python')) => `${PY_INSTALL}
from immiscible import ${pyImports(g)}

${PY_ENV}
immiscible = Immiscible().run()

${g.text}`,

  'claude-code': () => `# Installed: .claude/hooks/immiscible-claude-code-hook.mjs and a PreToolUse entry in .claude/settings.json.
# Start Claude Code in this project: Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch and MCP tool calls
# now ask Immiscible first. A refusal blocks the call; a question waits for a person.
claude`,

  wallet: () => `${JS_INSTALL}
import { Immiscible, decideThenSign, x402Fetch } from '@immiscible/sdk';

// Ask before signing: your wallet is called only after an allow whose receipt covers the exact transfer.
await decideThenSign(new Immiscible(), { asset: 'USDC', network: 'base', amount: '12.50', recipient: '0x...' },
  async () => ({ txHash: await wallet.send() }));

// Or for HTTP 402 (x402) resources:
const pay = x402Fetch(new Immiscible(), { pay: ({ requirements }) => mySigner(requirements) });`,
};

/**
 * { id, language, title, guard, text } for the project, or null. `covers`
 * (from coversFrom) picks the guard; without it, the tool.call guard.
 */
export function snippetFor(project, { hookInstalled = false, covers = null } = {}) {
  const p = project.primary;
  const out = (id, lang, title, fn) => {
    const g = guardFor(lang, covers);
    return { id, language: lang === 'python' ? 'python' : lang === 'shell' ? 'shell' : 'javascript', title, guard: g.id, text: fn(g) };
  };
  if (p) {
    const key = `${p.lang}:${p.id}`;
    const fn = SNIPPETS[key] ?? SNIPPETS[`${p.lang}:generic`];
    return out(key, p.lang, p.name, fn);
  }
  if (hookInstalled || project.claudeCode.present) return { id: 'claude-code', language: 'shell', title: 'Claude Code', guard: 'hook', text: SNIPPETS['claude-code']() };
  if (project.wallets.length) return { id: 'wallet', language: 'javascript', title: 'Wallet', guard: 'wallet', text: SNIPPETS.wallet() };
  if (project.languages.includes('python')) return out('python:generic', 'python', 'Python', SNIPPETS['python:generic']);
  if (project.languages.includes('node')) return out('node:generic', 'node', 'JavaScript', SNIPPETS['node:generic']);
  return null;
}

/** The test call any language can make: the same body init sends. */
export function curlSnippet(base) {
  return `curl ${base}/v1/actions/authorize \\
  -H "authorization: Bearer $IMMISCIBLE_AGENT_KEY" \\
  -H "content-type: application/json" \\
  -d '{"type":"tool.call","summary":"Test: check the connection","provenance":[{"source":"user","detail":"setup test"}]}'`;
}

export { SNIPPETS };
