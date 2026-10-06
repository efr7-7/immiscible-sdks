/**
 * The code to paste, for the SDK init found. Each uses the Immiscible SDKs
 * in packages/immiscible-js and packages/immiscible-py exactly as their
 * READMEs and examples do; neither is on npm or PyPI yet, so the install
 * line says where they are.
 */

const JS_INSTALL = '// The SDK is not on npm yet: npm install <path to the Immiscible repository>/packages/immiscible-js';
const PY_INSTALL = '# The SDK is not on PyPI yet: pip install <path to the Immiscible repository>/packages/immiscible-py';
const JS_ENV = '// IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY come from .env: run with node --env-file=.env';
const PY_ENV = '# IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY come from the environment: load .env first (python-dotenv, or export them)';

const GUARD_JS = `// Before a tool runs, ask: allow, refuse, or wait for a person. Your function runs only on allow.
await immiscible.guard(toolAction('send_invoice', args, { domain: 'billing.example.com' }), () => sendInvoice(args));`;
const GUARD_PY = `# Before a tool runs, ask: allow, refuse, or wait for a person. The block runs only on allow.
with immiscible.guard(tool_action("send_invoice", args, domain="billing.example.com")):
    send_invoice(args)`;

const SNIPPETS = {
  'node:openai': () => `${JS_INSTALL}
import OpenAI from 'openai';
import { Immiscible, toolAction } from '@immiscible/sdk';

${JS_ENV}
const immiscible = new Immiscible().run();
const openai = new OpenAI(immiscible.gateway.openai()); // model calls through the gateway, metered and traced

${GUARD_JS}`,

  'node:anthropic': () => `${JS_INSTALL}
import Anthropic from '@anthropic-ai/sdk';
import { Immiscible, toolAction } from '@immiscible/sdk';

${JS_ENV}
const immiscible = new Immiscible().run();
const anthropic = new Anthropic(immiscible.gateway.anthropic()); // model calls through the gateway, metered and traced

${GUARD_JS}`,

  'node:openai-agents': () => `${JS_INSTALL}
import { setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents';
import OpenAI from 'openai';
import { Immiscible } from '@immiscible/sdk';
import { guardOpenAITools } from '@immiscible/sdk/openai-agents';

${JS_ENV}
const immiscible = new Immiscible().run();
setDefaultOpenAIClient(new OpenAI(immiscible.gateway.openai()));
setOpenAIAPI('chat_completions'); // the gateway speaks Chat Completions

// Every tool call asks Immiscible first; a refusal comes back to the model with the reasons.
const tools = guardOpenAITools([sendInvoice, searchOrders], { client: immiscible });`,

  'node:vercel-ai': () => `${JS_INSTALL}
import { generateText, wrapLanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { Immiscible } from '@immiscible/sdk';
import { guardAiTools, immiscibleMiddleware } from '@immiscible/sdk/ai';

${JS_ENV}
const immiscible = new Immiscible().run({ client: 'vercel-ai' });
const provider = createOpenAI(immiscible.gateway.aiSdkOpenAI());
const model = wrapLanguageModel({ model: provider.chat('gpt-5-mini'), middleware: immiscibleMiddleware({ client: immiscible }) }); // .chat(): the gateway speaks Chat Completions

// Every tool's execute asks Immiscible first.
const tools = guardAiTools({ sendInvoice, searchOrders }, { client: immiscible });
await generateText({ model, tools, prompt });`,

  'node:langchain': () => `${JS_INSTALL}
import { ChatOpenAI } from '@langchain/openai';
import { Immiscible } from '@immiscible/sdk';
import { guardLangChainTools } from '@immiscible/sdk/langchain';

${JS_ENV}
const immiscible = new Immiscible().run({ client: 'langchain' });
const llm = new ChatOpenAI({ model: 'gpt-5-mini', configuration: immiscible.gateway.openai() });

// Guarded tools for ToolNode, bindTools or createReactAgent: each call asks Immiscible first.
const tools = guardLangChainTools([sendInvoice, searchOrders], { client: immiscible });`,

  'node:generic': () => `${JS_INSTALL}
import { Immiscible, toolAction } from '@immiscible/sdk';

${JS_ENV}
const immiscible = new Immiscible().run();

${GUARD_JS}`,

  'python:openai': () => `${PY_INSTALL}
from immiscible import Immiscible, tool_action

${PY_ENV}
immiscible = Immiscible().run()
client = immiscible.gateway.openai_client()  # an OpenAI client through the gateway, metered and traced

${GUARD_PY}`,

  'python:anthropic': () => `${PY_INSTALL}
from immiscible import Immiscible, tool_action

${PY_ENV}
immiscible = Immiscible().run()
client = immiscible.gateway.anthropic_client()  # an Anthropic client through the gateway, metered and traced

${GUARD_PY}`,

  'python:openai-agents': () => `${PY_INSTALL}
from immiscible import Immiscible
from immiscible.integrations import guard_tools

${PY_ENV}
immiscible = Immiscible().run()

# Every function tool asks Immiscible first; a refusal comes back to the model with the reasons.
tools = guard_tools([send_invoice, search_orders], client=immiscible)`,

  'python:langchain': () => `${PY_INSTALL}
from immiscible import Immiscible
from immiscible.integrations import guard_langchain_tools

${PY_ENV}
immiscible = Immiscible().run(client="langchain")

# Guarded tools for ToolNode, bind_tools or create_react_agent: each call asks Immiscible first.
tools = guard_langchain_tools([send_invoice, search_orders], client=immiscible)`,

  'python:generic': () => `${PY_INSTALL}
from immiscible import Immiscible, tool_action

${PY_ENV}
immiscible = Immiscible().run()

${GUARD_PY}`,

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

/** { id, language, title, text } for the project, or null. */
export function snippetFor(project, { hookInstalled = false } = {}) {
  const p = project.primary;
  if (p) {
    const key = `${p.lang}:${p.id}`;
    const fn = SNIPPETS[key] ?? SNIPPETS[`${p.lang}:generic`];
    return { id: key, language: p.lang === 'python' ? 'python' : 'javascript', title: p.name, text: fn() };
  }
  if (hookInstalled || project.claudeCode.present) return { id: 'claude-code', language: 'shell', title: 'Claude Code', text: SNIPPETS['claude-code']() };
  if (project.wallets.length) return { id: 'wallet', language: 'javascript', title: 'Wallet', text: SNIPPETS.wallet() };
  if (project.languages.includes('python')) return { id: 'python:generic', language: 'python', title: 'Python', text: SNIPPETS['python:generic']() };
  if (project.languages.includes('node')) return { id: 'node:generic', language: 'javascript', title: 'JavaScript', text: SNIPPETS['node:generic']() };
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
