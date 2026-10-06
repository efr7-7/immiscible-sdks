/** Gateway helpers: the option shapes each model SDK expects. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Immiscible } from '../dist/esm/index.js';

const im = new Immiscible({ apiKey: 'ask_agent', baseUrl: 'https://immiscible.example/', sessionId: 'run-7' });

test('OpenAI and Anthropic SDK options: base URL, key, static headers and a run-carrying fetch', () => {
  const o = im.gateway.openai({ taskId: 'task-9', objective: 'weekly shop' });
  assert.equal(o.baseURL, 'https://immiscible.example/v1');
  assert.equal(o.apiKey, 'ask_agent');
  assert.deepEqual(o.defaultHeaders, { 'x-immiscible-task-id': 'task-9', 'x-immiscible-objective': 'weekly shop' });
  assert.equal(typeof o.fetch, 'function');
  const a = im.gateway.anthropic({ apiKey: 'sk_person_inference_key' });
  assert.equal(a.baseURL, 'https://immiscible.example/anthropic');
  assert.equal(a.apiKey, 'sk_person_inference_key');
});

test('Vercel AI SDK provider settings: OpenAI at /v1, Anthropic at /anthropic/v1', () => {
  assert.equal(im.gateway.aiSdkOpenAI().baseURL, 'https://immiscible.example/v1');
  assert.equal(im.gateway.aiSdkAnthropic().baseURL, 'https://immiscible.example/anthropic/v1');
  assert.deepEqual(im.gateway.aiSdkOpenAI({ taskClass: 'code.review' }).headers, { 'x-immiscible-task-class': 'code.review' });
});

test('env for a child process (Claude Code, CLIs)', () => {
  const e = im.gateway.env();
  assert.equal(e.ANTHROPIC_BASE_URL, 'https://immiscible.example/anthropic');
  assert.equal(e.OPENAI_BASE_URL, 'https://immiscible.example/v1');
  assert.equal(e.IMMISCIBLE_SESSION, 'run-7');
  assert.match(e.TRACEPARENT, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});
