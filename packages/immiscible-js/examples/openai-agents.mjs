#!/usr/bin/env node
/**
 * OpenAI Agents SDK: every tool call asks Immiscible first, model calls go
 * through the gateway, and both share one run.
 *
 *   npm i @immiscible/sdk @openai/agents openai zod
 *   node openai-agents.mjs --demo              # against the built-in fake (its model calls the tool you name)
 *   IMMISCIBLE_AGENT_KEY=ask_... IMMISCIBLE_URL=https://... node openai-agents.mjs
 */

import { Agent, run, tool, setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import { Immiscible } from '@immiscible/sdk';
import { guardOpenAITools } from '@immiscible/sdk/openai-agents';

const demo = process.argv.includes('--demo');
const fake = demo ? await (await import('@immiscible/sdk/testing')).startFakeImmiscible() : null;
const immiscible = (fake ? new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url }) : new Immiscible()).run();

// Model calls through the gateway, carrying the run's trace and session.
setDefaultOpenAIClient(new OpenAI(immiscible.gateway.openai()));
setOpenAIAPI('chat_completions'); // the gateway speaks Chat Completions
if (demo) setTracingDisabled(true);

const buy = tool({
  name: 'buy',
  description: 'Buy groceries from a supermarket',
  parameters: z.object({ pence: z.number().int(), domain: z.string() }),
  execute: async ({ pence, domain }) => `ordered £${(pence / 100).toFixed(2)} from ${domain}`,
});
const search = tool({
  name: 'search',
  description: 'Search for products',
  parameters: z.object({ q: z.string() }),
  execute: async ({ q }) => `3 results for ${q}`,
});

const tools = guardOpenAITools([buy, search], {
  client: immiscible,
  // Payments are judged as payments; read-only search needs no check; anything else is a tool.call.
  mapToAction: ({ name, args }) => {
    if (name === 'search') return null;
    return Immiscible.paymentAction({ amount: args.pence, currency: 'GBP', merchant: args.domain, provenance: [{ source: 'user', detail: 'weekly shop' }] });
  },
  onApprovalRequired: (d) => console.log(`a person must approve: ${d.approval.url}`),
});

const agent = new Agent({ name: 'Shopper', instructions: 'You buy groceries for the person.', model: demo ? 'gpt-test' : 'gpt-5-mini', tools });

const ok = await run(agent, demo ? 'CALL buy {"pence":1200,"domain":"tesco.com"}' : 'Buy this week\'s milk and bread from tesco.com, about £12.');
console.log(ok.finalOutput);
const refused = await run(agent, demo ? 'CALL buy {"pence":1200,"domain":"0cado.com"}' : 'Pay the invoice at 0cado.com.');
console.log(refused.finalOutput);

await fake?.close();
