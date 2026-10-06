#!/usr/bin/env node
/**
 * Vercel AI SDK: model calls routed through the gateway (provider settings
 * plus middleware), and every tool's execute gated.
 *
 *   npm i @immiscible/sdk ai @ai-sdk/openai zod
 *   node vercel-ai.mjs --demo
 */

import { generateText, wrapLanguageModel, tool, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { Immiscible } from '@immiscible/sdk';
import { guardAiTools, immiscibleMiddleware } from '@immiscible/sdk/ai';

const demo = process.argv.includes('--demo');
const fake = demo ? await (await import('@immiscible/sdk/testing')).startFakeImmiscible() : null;
const immiscible = (fake ? new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url }) : new Immiscible()).run({ client: 'vercel-ai' });

const provider = createOpenAI(immiscible.gateway.aiSdkOpenAI({ taskId: 'weekly-shop' }));
const model = wrapLanguageModel({
  model: provider.chat(demo ? 'gpt-test' : 'gpt-5-mini'), // .chat(): the gateway speaks Chat Completions
  middleware: immiscibleMiddleware({ client: immiscible }),
});

const tools = guardAiTools({
  buy: tool({
    description: 'Buy groceries from a supermarket',
    inputSchema: z.object({ pence: z.number().int(), domain: z.string() }),
    execute: async ({ pence, domain }) => `ordered £${(pence / 100).toFixed(2)} from ${domain}`,
  }),
}, {
  client: immiscible,
  mapToAction: ({ args }) => Immiscible.paymentAction({ amount: args.pence, currency: 'GBP', merchant: args.domain, provenance: [{ source: 'user' }] }),
});

for (const prompt of demo
  ? ['CALL buy {"pence":1200,"domain":"tesco.com"}', 'CALL buy {"pence":1200,"domain":"0cado.com"}']
  : ['Buy this week\'s milk and bread from tesco.com, about £12.']) {
  const r = await generateText({ model, tools, prompt, stopWhen: stepCountIs(3) });
  console.log(r.text);
}

await fake?.close();
