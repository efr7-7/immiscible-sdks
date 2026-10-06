/** Receipts: offline against fetched or pinned keys, online for single use, and every way to forge one. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Immiscible, verifyReceipt, verifyOnline, fetchJwks, pinJwks, clearJwksCache, decodeReceiptUnverified } from '../dist/esm/index.js';
import { startFakeImmiscible } from '../dist/esm/testing.js';

const fake = await startFakeImmiscible();
test.after(() => fake.close());
const im = new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url });
const noNetwork = async () => { throw new Error('no network in this test'); };
const now = () => Math.floor(Date.now() / 1000);
const claims = (extra = {}) => ({ iss: fake.url, sub: fake.agentId, act: 'act_x', typ: 'payment', amt: 6420, cur: 'GBP', mer: 'ocado.com', mdt: 'mdt_fake_groceries', hum: false, iat: now(), exp: now() + 300, jti: 'j1', ...extra });

async function receipt(pence = 6420) {
  const d = await im.pay({ amount: pence, currency: 'GBP', merchant: 'ocado.com', provenance: [{ source: 'user' }] });
  assert.equal(d.decision, 'allow');
  return d.receipt;
}

test('offline with the issuer: keys fetched once and cached, bindings checked', async () => {
  clearJwksCache();
  const r = await verifyReceipt(await receipt(), { issuer: fake.url, expect: { amount: 6420, currency: 'gbp', merchant: 'https://www.ocado.com', type: 'payment', agent: fake.agentId } });
  assert.equal(r.valid, true, r.message);
  assert.equal(r.claims.amt, 6420);
  const fetches = fake.requests.filter((x) => x.path === '/.well-known/immiscible-keys.json').length;
  await verifyReceipt(await receipt(), { issuer: fake.url });
  assert.equal(fake.requests.filter((x) => x.path === '/.well-known/immiscible-keys.json').length, fetches, 'cached');
});

test('offline with a pinned key set: no network at all, object or JSON text', async () => {
  const pinned = await fetchJwks(fake.url);
  const tok = await receipt();
  const a = await verifyReceipt(tok, { jwks: pinned, fetch: noNetwork });
  assert.equal(a.valid, true, a.message);
  const b = await verifyReceipt(tok, { jwks: JSON.stringify(pinned), issuer: fake.url, fetch: noNetwork });
  assert.equal(b.valid, true, b.message);
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  const c = await verifyReceipt(tok, { jwks: { keys: [{ ...other, kid: 'someone-else' }] }, fetch: noNetwork });
  assert.equal(c.reason, 'unknown_kid');
  assert.throws(() => pinJwks({ keys: [] }), TypeError);
});

test('online: the first check passes and a second reports a replay; bindings are checked before the receipt is used', async () => {
  const tok = await receipt(7000);
  const wrong = await verifyReceipt(tok, { issuer: fake.url, online: true, expect: { amount: 6999 } });
  assert.equal(wrong.reason, 'amount_mismatch');
  const first = await verifyReceipt(tok, { issuer: fake.url, online: true, expect: { amount: 7000 } });
  assert.equal(first.valid, true, first.message);
  assert.equal(first.replayed, false);
  const second = await verifyOnline(tok, { baseUrl: fake.url });
  assert.equal(second.valid, false);
  assert.equal(second.reason, 'replayed');
  const pinnedOnline = await verifyReceipt(await receipt(7100), { jwks: fake.jwks, online: true, baseUrl: fake.url });
  assert.equal(pinnedOnline.valid, true, pinnedOnline.message);
});

test('online fails closed when the issuer cannot be reached', async () => {
  const r = await verifyOnline(await receipt(), { baseUrl: 'http://127.0.0.1:9' });
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'verify_unavailable');
});

test('forgeries and mistakes all fail with a stable reason, never a throw', async () => {
  const pinned = { jwks: fake.jwks, fetch: noNetwork };
  const evil = generateKeyPairSync('ed25519').privateKey;
  const cases = [
    ['not a token', 'malformed'],
    [fake.mint(claims(), { header: { alg: 'none' } }), 'unsupported_alg'],
    [fake.mint(claims(), { header: { alg: 'HS256' } }), 'unsupported_alg'],
    [fake.mint(claims(), { header: { typ: 'JWT' } }), 'wrong_typ'],
    [fake.mint(claims(), { header: { crit: ['exp'] } }), 'unsupported_crit'],
    [fake.mint(claims(), { header: { kid: undefined } }), 'missing_kid'],
    [fake.mint(claims(), { key: evil }), 'bad_signature'],
    [fake.mint(claims({ exp: now() - 3600 })), 'expired'],
    [fake.mint(claims({ iat: now() + 3600 })), 'issued_in_future'],
    [fake.mint(claims({ exp: undefined })), 'missing_claim'],
  ];
  for (const [tok, reason] of cases) {
    const r = await verifyReceipt(tok, pinned);
    assert.equal(r.valid, false, `${reason}: ${r.message}`);
    assert.equal(r.reason, reason);
    assert.equal(r.claims, null, 'never hands back unverified claims');
  }
  const good = fake.mint(claims());
  const [h, p, s] = good.split('.');
  const padded = `${h}.${Buffer.from(JSON.stringify(claims({ amt: 1 }))).toString('base64url')}.${s}`;
  assert.equal((await verifyReceipt(padded, pinned)).reason, 'bad_signature');
  assert.equal((await verifyReceipt(fake.mint(claims({ iss: 'https://elsewhere.example' })), { ...pinned, issuer: fake.url })).reason, 'wrong_issuer');
  assert.equal((await verifyReceipt(good, { ...pinned, expect: { merchant: 'tesco.com' } })).reason, 'merchant_mismatch');
  assert.equal((await verifyReceipt(good, { ...pinned, expect: { humanApproved: true } })).reason, 'human_required');
  assert.equal((await verifyReceipt(good, { ...pinned, maxAgeSec: 10, now: now() + 3600 })).reason, 'expired');
  assert.equal(decodeReceiptUnverified(p ? good : good).claims.amt, 6420);
  await assert.rejects(verifyReceipt(good, {}), TypeError, 'nothing to trust');
});

test('an unknown key id triggers one refetch (rotation), then fails closed', async () => {
  clearJwksCache();
  const tok = fake.mint(claims(), { header: { kid: 'rotated-away' } });
  const r = await verifyReceipt(tok, { issuer: fake.url });
  assert.equal(r.reason, 'unknown_kid');
});
