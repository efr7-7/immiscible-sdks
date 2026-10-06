/**
 * The framework integrations, against tool objects shaped exactly as each
 * framework hands them over (no framework installed). test/frameworks.test.mjs
 * repeats the important cases with the real packages when they are present.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Immiscible, ImmiscibleDeniedError } from '../dist/esm/index.js';
import { guardOpenAITool, guardOpenAITools, openaiToolGuardrail } from '../dist/esm/integrations/openai-agents.js';
import { guardLangChainTool, guardLangChainTools } from '../dist/esm/integrations/langchain.js';
import { guardAiTools, immiscibleMiddleware } from '../dist/esm/integrations/vercel-ai.js';
import { startFakeImmiscible } from '../dist/esm/testing.js';

const fake = await startFakeImmiscible();
test.after(() => fake.close());
const client = new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url });

const buyAction = ({ args }) => Immiscible.paymentAction({ amount: args.pence, currency: 'GBP', merchant: args.domain, provenance: [{ source: 'user' }] });
const settlementOf = (id) => fake.settlements.find((s) => s.actionId === id);
const lastAction = () => [...fake.actions.values()].at(-1);

test('OpenAI Agents SDK: a guarded function tool runs only when allowed, settles, and refuses in words', async () => {
  const calls = [];
  const sym = Symbol('internal');
  const tool = { type: 'function', name: 'buy', description: 'buy groceries', parameters: {}, strict: true, needsApproval: async () => false, [sym]: 'kept', invoke: async (ctx, input) => { calls.push(JSON.parse(input)); return 'bought'; } };
  const guarded = guardOpenAITool(tool, { client, mapToAction: buyAction });
  assert.equal(guarded.name, 'buy');
  assert.equal(guarded[sym], 'kept', 'own symbol properties survive');
  assert.notEqual(guarded.invoke, tool.invoke, 'the original is untouched');

  const out = await guarded.invoke({}, JSON.stringify({ pence: 1200, domain: 'tesco.com' }), { toolCall: { callId: 'call_1' } });
  assert.equal(out, 'bought');
  const a = lastAction();
  assert.equal(a.request.idempotencyKey, 'tool_call_1', 'the framework call id makes retries safe');
  assert.equal(settlementOf(a.id).status, 'completed');

  const refused = await guarded.invoke({}, JSON.stringify({ pence: 1200, domain: '0cado.com' }), {});
  assert.match(refused, /^Immiscible refused this action: .*looks like ocado\.com.*Do not proceed/);
  assert.equal(calls.length, 1, 'the refused call never ran');

  const throwing = guardOpenAITool(tool, { client, mapToAction: buyAction, onDeny: 'throw' });
  await assert.rejects(throwing.invoke({}, JSON.stringify({ pence: 1200, domain: '0cado.com' })), ImmiscibleDeniedError);

  const list = guardOpenAITools([tool, { type: 'hosted_tool', name: 'web_search' }], { client });
  assert.equal(list[1].type, 'hosted_tool', 'hosted tools pass through');
  assert.notEqual(list[0].invoke, tool.invoke);
});

test('OpenAI Agents SDK: the default mapping is a tool.call, and the input guardrail allows or rejects', async () => {
  const tool = { type: 'function', name: 'deploy', invoke: async () => 'deployed' };
  const guarded = guardOpenAITool(tool, { client, wait: false });
  const out = await guarded.invoke({}, JSON.stringify({ branch: 'main' }));
  assert.match(out, /waiting for the person to approve/);
  assert.equal(lastAction().type, 'tool.call');
  assert.equal(lastAction().request.summary, 'Run deploy: branch main');

  const g = openaiToolGuardrail({ client, mapToAction: buyAction });
  const allow = await g.run({ toolCall: { name: 'buy', arguments: JSON.stringify({ pence: 500, domain: 'tesco.com' }), callId: 'c9' } });
  assert.equal(allow.behavior.type, 'allow');
  assert.match(allow.outputInfo.immiscible.actionId, /^act_/);
  const reject = await g.run({ toolCall: { name: 'buy', arguments: JSON.stringify({ pence: 500, domain: '0cado.com' }) } });
  assert.equal(reject.behavior.type, 'rejectContent');
  assert.match(reject.behavior.message, /refused/);
});

test('LangChain: a guarded tool keeps its class and schema, and handles ToolNode tool calls and direct args', async () => {
  class FakeStructuredTool {
    constructor() { this.name = 'buy'; this.description = 'buy groceries'; this.schema = { type: 'object' }; this.ran = 0; }
    async invoke(input) {
      this.ran++;
      const args = input?.type === 'tool_call' ? input.args : input;
      return input?.type === 'tool_call' ? { type: 'tool_message', tool_call_id: input.id, content: `bought ${args.pence}` } : `bought ${args.pence}`;
    }
  }
  const tool = new FakeStructuredTool();
  const [guarded] = guardLangChainTools([tool], { client, mapToAction: buyAction });
  assert.ok(guarded instanceof FakeStructuredTool);
  assert.equal(guarded.schema.type, 'object');
  const msg = await guarded.invoke({ type: 'tool_call', name: 'buy', id: 'lc_1', args: { pence: 800, domain: 'ocado.com' } });
  assert.equal(msg.tool_call_id, 'lc_1');
  assert.equal(lastAction().request.idempotencyKey, 'tool_lc_1');
  assert.equal(await guarded.invoke({ pence: 300, domain: 'tesco.com' }), 'bought 300');
  const refused = await guarded.invoke({ pence: 300, domain: 'tesc0.com' });
  assert.match(refused, /refused/);
  assert.equal(tool.ran, 2);
  const waiting = guardLangChainTool(tool, { client, mapToAction: buyAction, initialDelayMs: 10, onApprovalRequired: (d) => setTimeout(() => fake.approve(d.id), 20) });
  assert.equal(await waiting.invoke({ pence: 9900, domain: 'ocado.com' }), 'bought 9900');
});

test('Vercel AI SDK: guarded execute, mapToAction null skips the gate, and tools without execute pass through', async () => {
  let ran = 0;
  const tools = guardAiTools({
    buy: { description: 'buy', inputSchema: {}, execute: async (input) => { ran++; return { ok: true, pence: input.pence }; } },
    search: { description: 'search', execute: async () => 'results' },
    clientSide: { description: 'rendered by the browser' },
  }, { client, mapToAction: (call) => (call.name === 'search' ? null : buyAction(call)) });
  const before = fake.actions.size;
  assert.equal(await tools.search.execute({ q: 'milk' }, { toolCallId: 's1' }), 'results');
  assert.equal(fake.actions.size, before, 'read-only search was not gated');
  assert.deepEqual(await tools.buy.execute({ pence: 1500, domain: 'ocado.com' }, { toolCallId: 'ai_1', messages: [] }), { ok: true, pence: 1500 });
  assert.equal(settlementOf(lastAction().id).amount, 1500);
  assert.match(await tools.buy.execute({ pence: 1500, domain: '0cado.com' }, { toolCallId: 'ai_2' }), /refused/);
  assert.equal(tools.clientSide.execute, undefined);
  assert.equal(ran, 1);
});

test('Vercel AI SDK middleware: run headers on every model call, the issued session read back', async () => {
  const run = client.run();
  const mw = immiscibleMiddleware({ client: run, headers: { 'x-immiscible-task-id': 't-1' } });
  const p1 = await mw.transformParams({ type: 'generate', params: { prompt: [], headers: { 'x-mine': '1' } } });
  assert.equal(p1.headers['x-mine'], '1');
  assert.equal(p1.headers['x-immiscible-task-id'], 't-1');
  assert.match(p1.headers.traceparent, new RegExp(`^00-${run.context.traceId}-`));
  await mw.wrapGenerate({ doGenerate: async () => ({ content: [], response: { headers: { 'x-immiscible-session': 'imss_mw_1' } } }) });
  assert.equal(run.context.sessionId, 'imss_mw_1');
  const p2 = await mw.transformParams({ type: 'stream', params: {} });
  assert.equal(p2.headers['x-immiscible-session'], 'imss_mw_1');
});

test('refusal: reasons that end in a full stop are not stopped twice', async () => {
  const { refusalMessage } = await import('../dist/esm/integrations/core.js');
  const one = refusalMessage(new ImmiscibleDeniedError({ id: 'act_1', decision: 'deny', reasons: ['Denied by jules@amethyst.example.'] }));
  assert.match(one, /^Immiscible refused this action: Denied by jules@amethyst\.example\. Do not proceed/);
  assert.doesNotMatch(one, /\.\./);
  const two = refusalMessage(new ImmiscibleDeniedError({ id: 'act_2', decision: 'deny', reasons: ['First reason.', 'Second reason'] }));
  assert.match(two, /: First reason; Second reason\. Do not proceed/);
  assert.match(refusalMessage(new ImmiscibleDeniedError({ id: 'act_3', decision: 'deny', reasons: [] })), /: no reason given\. /);
});

test('refusal: a reason ending in "s." keeps its last letter', async () => {
  const { refusalMessage } = await import('../dist/esm/integrations/core.js');
  assert.match(refusalMessage(new ImmiscibleDeniedError({ id: 'act_4', decision: 'deny', reasons: ['Outside the mandate categories.'] })), /: Outside the mandate categories\. Do not proceed/);
});
