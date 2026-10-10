/**
 * Receipt v2 (decision binding): the basket digest and the audience and cart
 * checks, against the fixture the server and the Python SDK are tested with
 * (a copy of the repository's test/fixtures/receipt-v2.json).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyReceipt, cartDigest, canonicalCart } from '../dist/esm/index.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/receipt-v2.json', import.meta.url), 'utf8'));
const { receipt } = FIXTURE;
const opts = (expect) => ({ issuer: receipt.issuer, jwks: receipt.jwks, expect, now: receipt.claims.iat + 60 });

test('cartDigest and canonicalCart give the server\'s bytes for every fixture basket', async () => {
  for (const f of FIXTURE.carts) {
    assert.equal(canonicalCart(f.cart, f.currency), f.canonical, f.name);
    assert.equal(await cartDigest(f.cart, f.currency), f.digest, f.name);
  }
  assert.throws(() => canonicalCart([{ quantity: 1, unitPrice: 1 }], 'GBP'), /sku or a url/);
});

test('a v2 receipt: the bindings verify offline, and each mismatch has its own reason', async () => {
  for (const check of receipt.checks) {
    const r = await verifyReceipt(receipt.token, opts(check.expect));
    assert.equal(r.valid, check.valid, `${JSON.stringify(check.expect)}: ${r.message}`);
    if (!check.valid) assert.equal(r.reason, check.reason);
  }
  const r = await verifyReceipt(receipt.token, opts({}));
  assert.equal(r.claims.ver, 2);
  assert.deepEqual(r.claims.prv, { declared: ['user'], observed: [], mismatch: false });
  assert.equal(r.claims.tnt, false);
});

test('only the canonical spelling verifies, and an order the receipt cannot cover never reaches the issuer', async () => {
  const { verifyOnline } = await import('../dist/esm/index.js');
  const [h, c, sig] = receipt.token.split('.');
  // The last character of a 64-byte signature carries unused bits: any other spelling of the same bytes is refused.
  const last = sig.at(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const i = alphabet.indexOf(last);
  const twin = `${sig.slice(0, -1)}${alphabet[(i & ~3) + ((i & 3) ^ 1)]}`;
  const r = await verifyReceipt(`${h}.${c}.${twin}`, opts({}));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'malformed');
  let called = 0;
  const on = await verifyOnline(receipt.token, { baseUrl: 'https://issuer.test', fetch: async () => { called++; throw new Error('should not be called'); }, expect: { agent: 'agt_someone_else' } });
  assert.deepEqual([on.valid, on.reason, called], [false, 'agent_mismatch', 0]);
});
