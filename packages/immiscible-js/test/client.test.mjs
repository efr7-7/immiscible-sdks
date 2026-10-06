/**
 * The client against the fake server: authorize, idempotency, retries,
 * waitForDecision with backoff and abort, settle, guard, and the helpers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Immiscible, ImmiscibleError, ImmiscibleDeniedError, ImmiscibleApprovalTimeoutError, ImmiscibleApprovalRequiredError,
  parseTraceparent, toolAction,
} from '../dist/esm/index.js';
import { startFakeImmiscible } from '../dist/esm/testing.js';

const fake = await startFakeImmiscible();
test.after(() => fake.close());

const client = () => new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url });
const groceries = (pence, domain = 'ocado.com', extra = {}) => Immiscible.paymentAction({ amount: pence, currency: 'GBP', merchant: domain, provenance: [{ source: 'user' }], ...extra });
const last = (pred) => [...fake.requests].reverse().find(pred);

test('a key is required, and IMMISCIBLE_AGENT_KEY is read from the environment', () => {
  const saved = { ...process.env };
  try {
    delete process.env.IMMISCIBLE_AGENT_KEY;
    delete process.env.ASSAY_AGENT_KEY;
    delete process.env.IMMISCIBLE_API_KEY;
    assert.throws(() => new Immiscible(), (e) => e instanceof ImmiscibleError && e.type === 'missing_api_key');
    process.env.IMMISCIBLE_AGENT_KEY = 'ask_env';
    process.env.IMMISCIBLE_URL = 'http://example.test/';
    const c = new Immiscible();
    assert.equal(c.apiKey, 'ask_env');
    assert.equal(c.baseUrl, 'http://example.test');
  } finally {
    process.env = saved;
  }
});

test('authorize: allow with a receipt; the idempotency key goes in the body and the header; traceparent continues the run', async () => {
  const im = client();
  const d = await im.authorize(groceries(2500));
  assert.equal(d.decision, 'allow');
  assert.match(d.receipt, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  const r = last((x) => x.path === '/v1/actions/authorize');
  assert.match(r.body.idempotencyKey, /^idk_/);
  assert.equal(r.headers['idempotency-key'], r.body.idempotencyKey);
  const sent = parseTraceparent(r.headers.traceparent);
  assert.equal(sent.traceId, im.context.traceId);
  assert.equal(parseTraceparent(im.context.lastServerTraceparent).traceId, im.context.traceId, 'the server continued our trace');
});

test('authorize: a caller-chosen idempotency key replays the same action', async () => {
  const im = client();
  const a = { ...groceries(300, 'tesco.com'), idempotencyKey: 'order-42' };
  const x = await im.authorize(a);
  const y = await im.authorize(a);
  assert.equal(x.id, y.id);
  assert.equal(y.idempotentReplay, true);
  const z = await im.authorize(groceries(300, 'tesco.com'), { idempotencyKey: 'order-42' });
  assert.equal(z.id, x.id);
});

test('authorize: retries 503s and dropped connections with the same idempotency key, so one action is created', async () => {
  const im = client();
  const before = fake.actions.size;
  fake.failNext('/v1/actions/authorize', 1, 503);
  const d1 = await im.authorize(groceries(400, 'tesco.com'));
  assert.equal(d1.decision, 'allow');
  fake.failNext('/v1/actions/authorize', 1, 0, { after: true }); // handled, then the answer is lost
  const d2 = await im.authorize(groceries(500, 'tesco.com'));
  assert.equal(d2.decision, 'allow');
  assert.equal(d2.idempotentReplay, true, 'the retry found the action the lost answer created');
  assert.equal(fake.actions.size, before + 2);
});

test('authorize: fails closed when the server cannot be reached', async () => {
  const im = new Immiscible({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9', maxRetries: 0, timeoutMs: 2000 });
  const err = await im.authorize(groceries(100)).catch((e) => e);
  assert.ok(err instanceof ImmiscibleError);
  assert.equal(err.type, 'network_error');
});

test('authorize: validates before sending, and a server 400 is a typed error', async () => {
  const im = client();
  await assert.rejects(im.authorize({ type: 'payment' }), TypeError);
  await assert.rejects(im.authorize({ summary: 'x' }), TypeError);
  const err = await im.authorize({ type: 'payment', summary: 'x', payment: { amount: 64.2, currency: 'GBP', merchant: { domain: 'ocado.com' } } }).catch((e) => e);
  assert.equal(err.status, 400);
  assert.equal(err.type, 'invalid_request');
  assert.ok(err.traceparent, 'the error carries the server trace');
  const bad = await new Immiscible({ apiKey: 'wrong', baseUrl: fake.url }).authorize(groceries(100)).catch((e) => e);
  assert.equal(bad.status, 401);
  assert.equal(bad.type, 'invalid_api_key');
});

test('a deny is a result from authorize, and an error from guard (which never runs the function)', async () => {
  const im = client();
  const d = await im.authorize(groceries(4999, '0cado.com'));
  assert.equal(d.decision, 'deny');
  let ran = false;
  const err = await im.guard(groceries(4999, '0cado.com'), () => { ran = true; }).catch((e) => e);
  assert.ok(err instanceof ImmiscibleDeniedError);
  assert.equal(ran, false);
  assert.ok(err.signals.some((s) => s.id === 'lookalike_domain'));
  assert.match(err.reasons[0], /looks like ocado\.com/);
});

test('waitForDecision: backs off between polls and returns the approved decision with a receipt', async () => {
  const im = client();
  const d = await im.authorize(groceries(9500));
  assert.equal(d.decision, 'approval_required');
  assert.match(d.approval.url, /\/app\/approvals\/apr_/);
  setTimeout(() => fake.approve(d.id), 400);
  const polls = [];
  const final = await im.waitForDecision(d.id, { initialDelayMs: 20, factor: 2, maxDelayMs: 1000, onPoll: () => polls.push(Date.now()) });
  assert.equal(final.decision, 'allow');
  assert.equal(final.human, true);
  assert.ok(final.receipt);
  // 20, 40, 80, 160, 320 ms (with jitter) reach 400 ms in about five polls; a fixed 20 ms poll would take twenty.
  assert.ok(polls.length >= 2 && polls.length <= 8, `polled ${polls.length} times`);
  const gaps = polls.slice(1).map((t, i) => t - polls[i]);
  assert.ok(gaps[gaps.length - 1] > gaps[0], `gaps grow: ${gaps.join(', ')}`);
});

test('waitForDecision: a person refusing ends the wait with a deny', async () => {
  const im = client();
  const d = await im.authorize(groceries(9000));
  setTimeout(() => fake.deny(d.id, 'not this week'), 50);
  const final = await im.waitForDecision(d.id, { initialDelayMs: 10 });
  assert.equal(final.decision, 'deny');
  assert.deepEqual(final.reasons, ['not this week']);
});

test('waitForDecision: times out with the approval link, and aborts on a signal', async () => {
  const im = client();
  const d = await im.authorize(groceries(9100));
  const err = await im.waitForDecision(d.id, { timeoutMs: 80, initialDelayMs: 10 }).catch((e) => e);
  assert.ok(err instanceof ImmiscibleApprovalTimeoutError);
  assert.equal(err.actionId, d.id);
  assert.match(err.message, /waiting at http/);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(new Error('the person closed the tab')), 60);
  const aborted = await im.waitForDecision(d.id, { initialDelayMs: 10_000, signal: ctl.signal }).catch((e) => e);
  assert.equal(aborted.message, 'the person closed the tab');
});

test('guard: waits for a person, runs, and settles completed with the authorised amount', async () => {
  const im = client();
  let seen;
  const out = await im.guard(groceries(9200), (d) => { seen = d; return 'shipped'; }, {
    initialDelayMs: 10,
    onApprovalRequired: (d) => setTimeout(() => fake.approve(d.id), 30),
  });
  assert.equal(out, 'shipped');
  assert.equal(seen.human, true);
  const s = fake.settlements.find((x) => x.actionId === seen.id);
  assert.deepEqual({ status: s.status, amount: s.amount }, { status: 'completed', amount: 9200 });
});

test('guard: wait false throws ImmiscibleApprovalRequiredError at once', async () => {
  const err = await client().guard(groceries(9300), () => 'never', { wait: false }).catch((e) => e);
  assert.ok(err instanceof ImmiscibleApprovalRequiredError);
  assert.match(err.approval.url, /apr_/);
});

test('guard: a throwing function settles failed and rethrows; settleAmount records what was spent', async () => {
  const im = client();
  let id;
  await assert.rejects(im.guard(groceries(1000, 'tesco.com'), (d) => { id = d.id; throw new Error('checkout broke'); }), /checkout broke/);
  assert.equal(fake.settlements.find((x) => x.actionId === id).status, 'failed');
  let id2;
  await im.guard(groceries(1000, 'tesco.com'), (d) => { id2 = d.id; return { charged: 950 }; }, { settleAmount: (r) => r.charged });
  assert.equal(fake.settlements.find((x) => x.actionId === id2).amount, 950);
});

test('settle: typed errors, and a retry after a lost answer returns the settled action', async () => {
  const im = client();
  const d = await im.authorize(groceries(700, 'tesco.com'));
  fake.failNext(`/v1/actions/${d.id}/settle`, 1, 0, { after: true });
  const s = await im.settle(d.id, { status: 'completed', amount: 700 });
  assert.equal(s.settlement.status, 'completed');
  const again = await im.settle(d.id).catch((e) => e);
  assert.equal(again.status, 409);
  assert.equal(again.type, 'already_settled');
  await assert.rejects(im.settle(d.id, { status: 'done' }), TypeError);
  await assert.rejects(im.settle(d.id, { amount: 1.5 }), TypeError);
});

test('pay and requestData: built, normalised, and guarded with a function', async () => {
  const im = client();
  const d = await im.pay({ amount: 6420, currency: 'gbp', merchant: 'https://www.Ocado.com/basket', provenance: [{ source: 'user' }] });
  assert.equal(d.decision, 'allow');
  const body = last((x) => x.path === '/v1/actions/authorize').body;
  assert.deepEqual(body.payment, { amount: 6420, currency: 'GBP', merchant: { domain: 'ocado.com' } });
  assert.match(body.summary, /£64\.20 to ocado\.com/);
  const out = await im.pay({ amount: 1200, currency: 'GBP', merchant: 'tesco.com', provenance: [{ source: 'user' }] }, (dd) => dd.receipt.length > 0);
  assert.equal(out, true);
  const data = await im.requestData({ fields: ['address'], recipient: 'ocado.com', purpose: 'delivery', provenance: [{ source: 'user' }] });
  assert.equal(data.released.address, '1 Example Street, London');
  assert.throws(() => Immiscible.paymentAction({ amount: 64.2, currency: 'GBP', merchant: 'x.com' }), /minor units/);
  assert.throws(() => Immiscible.paymentAction({ amount: 100, currency: 'pounds', merchant: 'x.com' }), /three-letter/);
});

test('toolAction: a tool.call with the target domain read from a url argument', () => {
  const a = toolAction('fetch_page', { url: 'https://www.Example.com/x' });
  assert.equal(a.type, 'tool.call');
  assert.deepEqual(a.target, { domain: 'example.com' });
  assert.match(a.summary, /^fetch_page: \{"url"/);
  assert.equal(toolAction('t', {}, { domain: null }).target, undefined);
});

test('outcome: TokenOps statuses are checked and sent', async () => {
  const im = client();
  await im.outcome('task-1', 'accepted', { value: 3 });
  assert.deepEqual(fake.outcomes.at(-1), { taskId: 'task-1', status: 'accepted', value: 3 });
  await assert.rejects(im.outcome('task-1', 'great'), TypeError);
});
