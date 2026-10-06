#!/usr/bin/env node
/**
 * Five minutes from key to first governed tool call.
 *
 *   node examples/quickstart.mjs --demo         # against a built-in fake, no server needed
 *   IMMISCIBLE_AGENT_KEY=ask_... IMMISCIBLE_URL=http://localhost:8787 node examples/quickstart.mjs
 *
 * One task, one run: ask before a tool runs, wait for a person when asked,
 * run the tool only if allowed, settle, and check the receipt.
 */

import { Immiscible, ImmiscibleDeniedError, verifyReceipt, fetchJwks, toolAction } from '@immiscible/sdk';

const demo = process.argv.includes('--demo');
let fake = null;
if (demo) {
  const { startFakeImmiscible } = await import('@immiscible/sdk/testing');
  fake = await startFakeImmiscible();
}

const immiscible = demo ? new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url }) : new Immiscible();
const run = immiscible.run(); // one trace and one session for this task

// 1. A tool call inside the mandate: allowed, run, settled.
const page = await run.guard(toolAction('fetch_page', { url: 'https://github.com/acme/api' }), async (decision) => {
  console.log(`allowed (${decision.reasons.join('; ')})`);
  return '<html>...</html>'; // your tool runs here, and only here
});
console.log(`fetched ${page.length} bytes`);

// 2. A payment above the "ask me" threshold: a person approves it.
const decision = await run.pay(
  { amount: 9500, currency: 'GBP', merchant: 'ocado.com', provenance: [{ source: 'user', detail: 'weekly shop' }] },
  async (d) => {
    console.log(`approved by a person: ${d.human}`);
    return d;
  },
  {
    onApprovalRequired: (d) => {
      console.log(`waiting for a person: ${d.approval.url}`);
      if (demo) setTimeout(() => fake.approve(d.id), 300); // in real life, their phone buzzes
    },
  },
);

// 3. Whoever receives the order checks the receipt, offline against pinned keys.
const jwks = await fetchJwks(run.baseUrl); // fetch once, store with your config
const check = await verifyReceipt(decision.receipt, { jwks, issuer: run.baseUrl, expect: { amount: 9500, currency: 'GBP', merchant: 'ocado.com' } });
console.log(`receipt valid: ${check.valid}`);

// 4. A prompt-injected lookalike: refused, and the payment code never runs.
try {
  await run.pay({ amount: 4999, currency: 'GBP', merchant: '0cado.com', provenance: [{ source: 'web', url: 'https://0cado.com/deal' }] }, () => {
    throw new Error('this never runs');
  });
} catch (err) {
  if (!(err instanceof ImmiscibleDeniedError)) throw err;
  console.log(`refused: ${err.reasons.join('; ')}`);
}

await fake?.close();
