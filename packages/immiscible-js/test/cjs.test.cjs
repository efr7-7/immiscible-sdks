/** The CommonJS build: require() works, and the client behaves the same. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Immiscible, ImmiscibleDeniedError, verifyReceipt } = require('../dist/cjs/index.js');
const { guardLangChainTool } = require('../dist/cjs/integrations/langchain.js');
const { startFakeImmiscible } = require('../dist/cjs/testing.js');

test('CommonJS: authorize, guard, verify against the fake', async (t) => {
  const fake = await startFakeImmiscible();
  t.after(() => fake.close());
  const im = new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url });
  const d = await im.pay({ amount: 1500, currency: 'GBP', merchant: 'ocado.com', provenance: [{ source: 'user' }] });
  assert.equal(d.decision, 'allow');
  const v = await verifyReceipt(d.receipt, { issuer: fake.url, expect: { amount: 1500 } });
  assert.equal(v.valid, true, v.message);
  await assert.rejects(im.pay({ amount: 1500, currency: 'GBP', merchant: '0cado.com' }, () => 'never'), ImmiscibleDeniedError);
  const tool = guardLangChainTool({ name: 'lookup', invoke: async () => 'found' }, { client: im });
  assert.equal(await tool.invoke({ q: 'x' }), 'found');
});
