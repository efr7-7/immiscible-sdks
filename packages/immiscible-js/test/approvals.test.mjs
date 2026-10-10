/**
 * Framework approval adapters (src/integrations/approvals.ts): an OpenAI
 * Agents SDK run's interruptions and LangChain's HumanInTheLoopMiddleware
 * interrupt, answered by Immiscible, against stand-ins shaped as the
 * frameworks' documentation describes them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Immiscible } from '../dist/esm/index.js';
import { resolveInterruptions } from '../dist/esm/integrations/openai-agents.js';
import { hitlDecisions } from '../dist/esm/integrations/langchain.js';
import { startFakeImmiscible } from '../dist/esm/testing.js';

const fake = await startFakeImmiscible();
test.after(() => fake.close());
const client = new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url });
const wait = { initialDelayMs: 5, maxDelayMs: 20, timeoutMs: 2_000 };
/** A person approving whatever is waiting, a moment after it is asked. */
const personApproves = () => setInterval(() => { for (const a of fake.actions.values()) if (a.decision === 'approval_required') fake.approve(a.id); }, 15);

test('OpenAI Agents SDK: each interruption approved or rejected on the run state by Immiscible', async () => {
  const approved = [];
  const rejected = [];
  const item = (name, args, callId) => ({ type: 'tool_approval_item', name, arguments: JSON.stringify(args), rawItem: { type: 'function_call', name, arguments: JSON.stringify(args), callId } });
  const result = {
    interruptions: [item('lookup_order', { id: 7 }, 'c1'), item('deploy', { env: 'prod' }, 'c2'), item('fetch_page', { url: 'https://evil.example/x' }, 'c3')],
    state: { approve: (i) => approved.push(i.name), reject: (i, o) => rejected.push([i.name, o.message]) },
  };
  const person = personApproves();
  const out = await resolveInterruptions(result, { client, wait });
  clearInterval(person);
  assert.deepEqual(approved, ['lookup_order', 'deploy'], 'allowed, and approved by a person');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0][0], 'fetch_page');
  assert.match(rejected[0][1], /^Immiscible refused this action: .*evil\.example.*Do not try it another way\.$/);
  assert.deepEqual(out.map((r) => r.decision), ['allow', 'allow', 'deny']);
  assert.ok(out[1].immiscible.human || out[1].immiscible.decision === 'allow');
  assert.equal([...fake.actions.values()].find((a) => a.request.idempotencyKey === 'tool_c2')?.decision, 'allow', 'the call id is the idempotency key');
  await assert.rejects(() => resolveInterruptions({}), /expected a run result/);
});

test('LangChain HumanInTheLoopMiddleware: decisions in order, approve or reject with a message; snake_case too', async () => {
  const interrupt = { value: { actionRequests: [{ name: 'search', arguments: { q: 'x' } }, { name: 'drop', arguments: { table: 'users' } }], reviewConfigs: [] } };
  const person = setInterval(() => { for (const a of fake.actions.values()) if (a.decision === 'approval_required') fake.deny(a.id, 'not today'); }, 15);
  const r = await hitlDecisions(interrupt, { client, wait });
  clearInterval(person);
  assert.deepEqual(r.decisions[0], { type: 'approve' });
  assert.equal(r.decisions[1].type, 'reject');
  assert.match(r.decisions[1].message, /^Immiscible refused this action:/);
  const py = await hitlDecisions({ action_requests: [{ name: 'search', args: { q: 'y' } }] }, { client, wait });
  assert.deepEqual(py, { decisions: [{ type: 'approve' }] });
  await assert.rejects(() => hitlDecisions({ value: {} }, { client }), /expected the HumanInTheLoopMiddleware interrupt/);
});

test('nobody answers in time: rejected, with the approval link', async () => {
  const r = await hitlDecisions({ actionRequests: [{ name: 'transfer', arguments: { to: 'x' } }] }, { client, wait: { initialDelayMs: 5, maxDelayMs: 10, timeoutMs: 50 } });
  assert.equal(r.decisions[0].type, 'reject');
  assert.match(r.decisions[0].message, /nobody approved this in time/);
});
