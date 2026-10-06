/**
 * Crypto helpers, without a server: the authorize body, exact amounts, and
 * the check a wallet wrapper makes before it signs. The end-to-end paths
 * (decideThenSign, x402Fetch against a fake x402 server) are tested against
 * the real server in the repository's test/crypto-wallets.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cryptoAction, receiptCovers, fromAtomic, readPaymentRequired } from '../dist/esm/index.js';

const TO = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

test('cryptoAction: a payment with a crypto object; amounts are strings, never numbers', () => {
  const a = cryptoAction({ asset: 'USDC', network: 'base', amount: '12.50', recipient: TO, provenance: [{ source: 'user' }] });
  assert.equal(a.type, 'payment');
  assert.deepEqual(a.payment.crypto, { asset: 'USDC', network: 'base', amount: '12.50', recipient: TO });
  assert.equal(a.payment.amount, undefined, 'Immiscible prices it; the agent never sends a money value');
  assert.throws(() => cryptoAction({ asset: 'USDC', network: 'base', amount: 12.5, recipient: TO }), /decimal string/);
});

test('fromAtomic: exact conversion of x402 atomic amounts', () => {
  assert.equal(fromAtomic('10000', 6), '0.01');
  assert.equal(fromAtomic(1500000n, 6), '1.5');
  assert.equal(fromAtomic('1', 18), '0.000000000000000001');
});

test('receiptCovers: same asset, network and recipient, and no more than authorised', () => {
  const claims = { cry: { ast: 'USDC', net: 'base', amt: '5', to: TO } };
  assert.deepEqual(receiptCovers(claims, { asset: 'USDC', network: 'eip155:8453', amount: '5', recipient: TO.toLowerCase() }), []);
  assert.equal(receiptCovers(claims, { asset: 'USDC', network: 'base', amount: '4.99', recipient: TO }).length, 0);
  assert.match(receiptCovers(claims, { asset: 'USDC', network: 'base', amount: '5.01', recipient: TO })[0], /less than 5.01/);
  assert.match(receiptCovers(claims, { asset: 'USDT', network: 'base', amount: '5', recipient: TO })[0], /not USDT/);
  assert.match(receiptCovers(claims, { asset: 'USDC', network: 'polygon', amount: '5', recipient: TO })[0], /not polygon/);
  assert.equal(receiptCovers({}, { asset: 'USDC', network: 'base', amount: '5', recipient: TO }).length, 1);
});

test('readPaymentRequired: v2 in the PAYMENT-REQUIRED header, v1 in the body', async () => {
  const v2 = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: TO }] };
  const r2 = new Response('{}', { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(v2)).toString('base64') } });
  assert.equal((await readPaymentRequired(r2)).accepts[0].amount, '10000');
  const v1 = { x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: TO, resource: 'https://x.test/r' }] };
  const r1 = new Response(JSON.stringify(v1), { status: 402, headers: { 'content-type': 'application/json' } });
  assert.equal((await readPaymentRequired(r1)).accepts[0].maxAmountRequired, '10000');
});
