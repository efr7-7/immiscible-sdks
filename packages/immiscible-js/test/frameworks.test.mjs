/**
 * The integrations with the real framework packages, end to end against the
 * fake (whose model calls a tool when asked to, then reports its result).
 *
 * The frameworks are not dependencies of this package. Point
 * IMMISCIBLE_FRAMEWORKS_DIR at a folder where they are installed:
 *
 *   npm i openai @anthropic-ai/sdk @openai/agents ai @ai-sdk/openai @langchain/core @langchain/langgraph zod
 *
 * Each case is skipped when its package is missing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Immiscible } from '../dist/esm/index.js';
import { guardOpenAITools } from '../dist/esm/integrations/openai-agents.js';
import { guardLangChainTools } from '../dist/esm/integrations/langchain.js';
import { guardAiTools, immiscibleMiddleware } from '../dist/esm/integrations/vercel-ai.js';
import { startFakeImmiscible } from '../dist/esm/testing.js';

const DIR = process.env.IMMISCIBLE_FRAMEWORKS_DIR ?? join(process.cwd(), 'node_modules', '..');
const SKIP_CONDITIONS = new Set(['types', 'require', 'browser', 'input', 'typedoc', 'react-native', 'worker', 'workerd', 'edge-light', 'deno', 'bun']);

/** The ES module entry of `spec` installed under DIR, from its package exports. */
function entry(spec) {
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const sub = `.${spec.slice(name.length)}` || '.';
  const root = join(DIR, 'node_modules', name);
  if (!existsSync(join(root, 'package.json'))) return null;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const pick = (v) => {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return null;
    for (const k of ['import', 'node', 'default', ...Object.keys(v)]) if (!SKIP_CONDITIONS.has(k) && k in v && !k.startsWith('.')) { const r = pick(v[k]); if (r) return r; }
    return null;
  };
  const target = pkg.exports ? pick(typeof pkg.exports === 'string' || !Object.keys(pkg.exports).some((k) => k.startsWith('.')) ? (sub === '.' ? pkg.exports : null) : pkg.exports[sub === '.' ? '.' : sub]) : pkg.module ?? pkg.main;
  return target ? pathToFileURL(join(root, target)).href : null;
}

async function load(spec) {
  const url = entry(spec);
  return url ? import(url) : null;
}

const fake = await startFakeImmiscible();
test.after(() => fake.close());
const base = new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url });
const buyAction = ({ args }) => Immiscible.paymentAction({ amount: args.pence, currency: 'GBP', merchant: args.domain, provenance: [{ source: 'user' }] });
const lastAction = () => [...fake.actions.values()].at(-1);

const OpenAI = (await load('openai'))?.default;
const Anthropic = (await load('@anthropic-ai/sdk'))?.default;
const agents = await load('@openai/agents');
const ai = await load('ai');
const aiOpenAI = await load('@ai-sdk/openai');
const lcTools = await load('@langchain/core/tools');
const lgPrebuilt = await load('@langchain/langgraph/prebuilt');
const lcMessages = await load('@langchain/core/messages');
const zod = await load('zod');

test('openai SDK: chat through the gateway, inside the run', { skip: !OpenAI && 'openai not installed' }, async () => {
  const im = base.run();
  const openai = new OpenAI({ ...im.gateway.openai({ taskId: 'fw-1' }), maxRetries: 0 });
  const r = await openai.chat.completions.create({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.choices[0].message.content, 'ok');
  assert.match(im.context.sessionId, /^imss_/);
  const sent = fake.requests.filter((x) => x.path === '/v1/chat/completions').at(-1);
  assert.equal(sent.headers['x-immiscible-task-id'], 'fw-1');
  assert.match(sent.headers.traceparent, new RegExp(`^00-${im.context.traceId}-`));
  await openai.chat.completions.create({ model: 'gpt-test', messages: [{ role: 'user', content: 'again' }] });
  assert.equal(fake.requests.filter((x) => x.path === '/v1/chat/completions').at(-1).headers['x-immiscible-session'], im.context.sessionId);
});

test('Anthropic SDK: messages through the gateway, inside the run', { skip: !Anthropic && '@anthropic-ai/sdk not installed' }, async () => {
  const im = base.run();
  const anthropic = new Anthropic({ ...im.gateway.anthropic(), maxRetries: 0 });
  const r = await anthropic.messages.create({ model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.content[0].text, 'ok');
  assert.match(im.context.sessionId, /^imss_/);
  assert.equal(fake.requests.filter((x) => x.path === '/anthropic/v1/messages').at(-1).headers['x-api-key'], fake.agentKey);
});

test('OpenAI Agents SDK: an agent run calls a guarded tool through the gateway; a lookalike is refused in words', { skip: !(agents && OpenAI && zod) && '@openai/agents, openai or zod not installed' }, async () => {
  const im = base.run();
  agents.setTracingDisabled(true);
  agents.setDefaultOpenAIClient(new OpenAI({ ...im.gateway.openai(), maxRetries: 0 }));
  agents.setOpenAIAPI('chat_completions');
  const z = zod.z ?? zod.default ?? zod;
  let ran = 0;
  const buy = agents.tool({
    name: 'buy', description: 'buy groceries',
    parameters: z.object({ pence: z.number(), domain: z.string() }),
    execute: async ({ pence, domain }) => { ran++; return `bought ${pence} at ${domain}`; },
  });
  const agent = new agents.Agent({ name: 'Shopper', model: 'gpt-test', tools: guardOpenAITools([buy], { client: im, mapToAction: buyAction }) });
  const ok = await agents.run(agent, 'CALL buy {"pence":1200,"domain":"tesco.com"}');
  assert.match(String(ok.finalOutput), /done: bought 1200 at tesco\.com/);
  assert.equal(ran, 1);
  const act = lastAction();
  assert.equal(act.request.payment.amount, 1200);
  assert.ok(act.request.idempotencyKey.startsWith('tool_'), 'keyed on the model call id');
  assert.ok(fake.settlements.some((s) => s.actionId === act.id && s.status === 'completed'));
  assert.deepEqual(act.request.session, { client: 'custom', id: im.context.sessionId }, 'the action joined the model session');
  const refused = await agents.run(agent, 'CALL buy {"pence":1200,"domain":"0cado.com"}');
  assert.match(String(refused.finalOutput), /done: Immiscible refused this action/);
  assert.equal(ran, 1);
});

test('Vercel AI SDK: generateText through the gateway with middleware and guarded tools', { skip: !(ai && aiOpenAI && zod) && 'ai, @ai-sdk/openai or zod not installed' }, async () => {
  const im = base.run();
  const z = zod.z ?? zod.default ?? zod;
  const provider = aiOpenAI.createOpenAI(im.gateway.aiSdkOpenAI());
  const model = ai.wrapLanguageModel({ model: provider.chat('gpt-test'), middleware: immiscibleMiddleware({ client: im }) });
  let ran = 0;
  const tools = guardAiTools({
    buy: ai.tool({ description: 'buy groceries', inputSchema: z.object({ pence: z.number(), domain: z.string() }), execute: async ({ pence }) => { ran++; return `bought ${pence}`; } }),
  }, { client: im, mapToAction: buyAction });
  const r = await ai.generateText({ model, tools, prompt: 'CALL buy {"pence":1300,"domain":"ocado.com"}', stopWhen: ai.stepCountIs(3) });
  assert.match(r.text, /done: .*bought 1300/);
  assert.equal(ran, 1);
  assert.match(im.context.sessionId, /^imss_/);
  assert.equal(lastAction().request.payment.amount, 1300);
});

test('LangChain and LangGraph: a guarded tool inside ToolNode', { skip: !(lcTools && lgPrebuilt && lcMessages && zod) && '@langchain/core, @langchain/langgraph or zod not installed' }, async () => {
  const z = zod.z ?? zod.default ?? zod;
  let ran = 0;
  const buy = lcTools.tool(async ({ pence }) => { ran++; return `bought ${pence}`; }, { name: 'buy', description: 'buy groceries', schema: z.object({ pence: z.number(), domain: z.string() }) });
  const node = new lgPrebuilt.ToolNode(guardLangChainTools([buy], { client: base, mapToAction: buyAction }));
  const call = (id, args) => new lcMessages.AIMessage({ content: '', tool_calls: [{ id, name: 'buy', args, type: 'tool_call' }] });
  const out = await node.invoke({ messages: [call('lg_1', { pence: 1400, domain: 'ocado.com' })] });
  assert.equal(out.messages[0].content, 'bought 1400');
  assert.equal(out.messages[0].tool_call_id, 'lg_1');
  assert.equal(lastAction().request.idempotencyKey, 'tool_lg_1');
  const refused = await node.invoke({ messages: [call('lg_2', { pence: 1400, domain: '0cado.com' })] });
  assert.match(String(refused.messages[0].content), /Immiscible refused/);
  assert.equal(ran, 1);
});
