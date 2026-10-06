/** The MCP proxy client against the fake proxy. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Immiscible, ImmiscibleApprovalRequiredError, ImmiscibleDeniedError, approvalMeta, mcpProxyUrl, mcpServerUrl } from '../dist/esm/index.js';
import { startFakeImmiscible } from '../dist/esm/testing.js';

const fake = await startFakeImmiscible();
test.after(() => fake.close());
const im = new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url });

test('urls', () => {
  assert.equal(mcpProxyUrl('https://x.example/', 'ups 1'), 'https://x.example/mcp/proxy/ups%201');
  assert.equal(mcpServerUrl('https://x.example/'), 'https://x.example/mcp');
  assert.throws(() => approvalMeta('nope'), TypeError);
});

test('list, allowed call, approval dance forwarded exactly once, and a deny', async () => {
  const px = im.mcpProxy('fake-shop');
  const tools = await px.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name), ['search', 'buy']);
  assert.match(px.sessionId, /^mps_/);
  const ok = await px.call('search', { q: 'milk' });
  assert.match(ok.content[0].text, /did search/);

  const before = fake.upstreamCalls;
  const pending = await px.call('buy', { amount: 9500, merchant: 'ocado.com' }).catch((e) => e);
  assert.ok(pending instanceof ImmiscibleApprovalRequiredError);
  assert.equal(fake.upstreamCalls, before, 'nothing sent while waiting');
  fake.approve(pending.actionId);
  const done = await px.retryAfterApproval('buy', { amount: 9500, merchant: 'ocado.com' }, pending);
  assert.match(done.content[0].text, /did buy/);
  const again = await px.retryAfterApproval('buy', { amount: 9500, merchant: 'ocado.com' }, pending).catch((e) => e);
  assert.equal(again.code, -32006);
  assert.equal(fake.upstreamCalls, before + 1);

  const viaWait = await px.callWithApproval('buy', { amount: 9000, merchant: 'ocado.com' }, {
    initialDelayMs: 10,
    onApprovalRequired: (d) => setTimeout(() => fake.approve(d.id), 20),
  });
  assert.match(viaWait.content[0].text, /did buy/);

  const denied = await px.call('buy', { amount: 1000, merchant: '0cado.com' }).catch((e) => e);
  assert.ok(denied instanceof ImmiscibleDeniedError);
  assert.ok(denied.signals.some((s) => s.id === 'lookalike_domain'));
});
