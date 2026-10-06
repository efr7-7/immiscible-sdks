/**
 * HTTP failures arrive as the error class for their status, each still an
 * ImmiscibleError, and the client defaults to the hosted service.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Immiscible, ImmiscibleError, ImmiscibleAuthenticationError, ImmiscibleInvalidRequestError, ImmiscibleRateLimitError,
  ImmiscibleIdempotencyConflictError, ImmiscibleConnectionError, DEFAULT_BASE_URL,
} from '../dist/esm/index.js';

const answering = (status, error, headers = {}) => async () => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req_1', ...headers } });
const client = (fetch) => new Immiscible({ apiKey: 'ask_test', baseUrl: 'http://example.invalid', fetch, maxRetries: 0 });
const action = { type: 'payment', summary: 'Pay for groceries' };

test('each status has its own class, and all are ImmiscibleError', async () => {
  const cases = [
    [401, { type: 'invalid_api_key', message: 'unknown key' }, ImmiscibleAuthenticationError],
    [400, { type: 'invalid_request', message: 'bad', errors: [{ field: 'type', message: 'required' }] }, ImmiscibleInvalidRequestError],
    [429, { type: 'rate_limited', message: 'slow down' }, ImmiscibleRateLimitError],
    [409, { type: 'idempotency_conflict', message: 'different body' }, ImmiscibleIdempotencyConflictError],
  ];
  for (const [status, error, Class] of cases) {
    const err = await client(answering(status, error, { 'retry-after': '7' })).authorize(action).catch((e) => e);
    assert.ok(err instanceof Class, `${status} is ${Class.name}`);
    assert.ok(err instanceof ImmiscibleError);
    assert.equal(err.requestId, 'req_1');
  }
  const bad = await client(answering(400, { type: 'invalid_request', message: 'bad', errors: [{ field: 'type' }] })).authorize(action).catch((e) => e);
  assert.deepEqual(bad.errors, [{ field: 'type' }]);
  const slow = await client(answering(429, { type: 'rate_limited', message: 'x' }, { 'retry-after': '7' })).authorize(action).catch((e) => e);
  assert.equal(slow.retryAfter, 7);
});

test('a network failure is a connection error', async () => {
  const err = await client(async () => { throw new TypeError('fetch failed'); }).authorize(action).catch((e) => e);
  assert.ok(err instanceof ImmiscibleConnectionError);
  assert.equal(err.type, 'network_error');
});

test('the default base URL is the hosted service', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://immiscible.fly.dev');
});
