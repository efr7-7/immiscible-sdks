#!/usr/bin/env node
/**
 * A merchant checkout that accepts agent purchases only with a valid Immiscible
 * receipt, bound to this order: this shop, this amount, this currency, and
 * never twice.
 *
 * The whole integration is the `acceptAgentOrder` function below: one
 * verifyReceipt call. Offline (signature, expiry, bindings) and online
 * (single use) in one go.
 *
 * Run the full story against the built-in fake Immiscible (an agent pays, then
 * someone replays the receipt, tampers with it, and tries it at another shop):
 *
 *   node examples/merchant-checkout.mjs --demo
 *
 * Or verify a real receipt from your Immiscible:
 *
 *   IMMISCIBLE_URL=http://localhost:8787 node examples/merchant-checkout.mjs <receipt> <amount-in-pence> [merchant-domain]
 */

import { verifyReceipt } from '@immiscible/sdk/verify';

const MY_DOMAIN = 'ocado.com';

/**
 * The integration. Call it before you capture payment for an order an agent placed.
 * @returns {Promise<{ ok: true, claims: object } | { ok: false, why: string, reason: string }>}
 */
export async function acceptAgentOrder({ receipt, totalPence, currency = 'GBP', issuer, merchant = MY_DOMAIN }) {
  const r = await verifyReceipt(receipt, {
    issuer,                      // the Immiscible deployment you trust; its keys are fetched and cached
    online: true,                // plus single use: the first check of a receipt is the only one that passes
    expect: { type: 'payment', amount: totalPence, currency, merchant },
  });
  if (!r.valid) return { ok: false, reason: r.reason, why: r.message };
  return { ok: true, claims: r.claims };
}

const show = (label, r) => console.log(`${label.padEnd(34)} ${r.ok ? `ACCEPT  (agent ${r.claims.sub}, ${r.claims.hum ? 'a person approved this order' : 'within their mandate'})` : `REFUSE  ${r.reason}: ${r.why}`}`);

if (process.argv.includes('--demo')) {
  const { startFakeImmiscible } = await import('@immiscible/sdk/testing');
  const { Immiscible } = await import('@immiscible/sdk');
  const fake = await startFakeImmiscible();
  const agent = new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url });

  // The agent side: ask Immiscible, get a receipt, send it with the order.
  const d = await agent.pay({ amount: 6420, currency: 'GBP', merchant: { name: 'Ocado', domain: 'ocado.com' }, provenance: [{ source: 'user' }] });
  console.log(`Agent was ${d.decision}ed and sends its order with a receipt.\n`);
  const issuer = fake.url;

  show('1. the real order', await acceptAgentOrder({ receipt: d.receipt, totalPence: 6420, issuer }));
  show('2. the same receipt again', await acceptAgentOrder({ receipt: d.receipt, totalPence: 6420, issuer }));

  const fresh = (await agent.pay({ amount: 6420, currency: 'GBP', merchant: 'ocado.com', provenance: [{ source: 'user' }] })).receipt;
  show('3. basket padded to £99.00', await acceptAgentOrder({ receipt: fresh, totalPence: 9900, issuer }));
  show('4. presented at another shop', await acceptAgentOrder({ receipt: fresh, totalPence: 6420, issuer, merchant: 'tesco.com' }));
  const [h, p, s] = fresh.split('.');
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), amt: 9900 })).toString('base64url');
  show('5. amount edited inside the token', await acceptAgentOrder({ receipt: `${h}.${edited}.${s}`, totalPence: 9900, issuer }));
  show('6. and the untouched one, finally', await acceptAgentOrder({ receipt: fresh, totalPence: 6420, issuer }));
  await fake.close();
} else {
  const [receipt, pence, merchant = MY_DOMAIN] = process.argv.slice(2);
  if (!receipt || !pence) {
    console.log('usage: node examples/merchant-checkout.mjs <receipt> <amount-in-pence> [merchant-domain]   (or --demo)');
    process.exit(2);
  }
  const issuer = process.env.IMMISCIBLE_URL ?? 'http://localhost:8787';
  show('receipt', await acceptAgentOrder({ receipt, totalPence: Number(pence), issuer, merchant }));
}
