#!/usr/bin/env node
/**
 * LangChain / LangGraph: guarded tools inside a ToolNode.
 *
 *   npm i @immiscible/sdk @langchain/core @langchain/langgraph zod
 *   node langchain.mjs --demo
 *
 * With a real model, bind the same guarded tools (`model.bindTools(tools)`)
 * or hand them to `createReactAgent({ llm, tools })`; point the model at the
 * gateway with `new ChatOpenAI({ configuration: immiscible.gateway.openai() })`.
 */

import { tool } from '@langchain/core/tools';
import { AIMessage } from '@langchain/core/messages';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { Immiscible } from '@immiscible/sdk';
import { guardLangChainTools } from '@immiscible/sdk/langchain';

const demo = process.argv.includes('--demo');
const fake = demo ? await (await import('@immiscible/sdk/testing')).startFakeImmiscible() : null;
const immiscible = (fake ? new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url }) : new Immiscible()).run({ client: 'langchain' });

const buy = tool(async ({ pence, domain }) => `ordered £${(pence / 100).toFixed(2)} from ${domain}`, {
  name: 'buy',
  description: 'Buy groceries from a supermarket',
  schema: z.object({ pence: z.number().int(), domain: z.string() }),
});

const tools = guardLangChainTools([buy], {
  client: immiscible,
  mapToAction: ({ args }) => Immiscible.paymentAction({ amount: args.pence, currency: 'GBP', merchant: args.domain, provenance: [{ source: 'user' }] }),
  // In a graph with a checkpointer, call LangGraph's interrupt() here instead, and resume when the person answers.
  onApprovalRequired: (d) => console.log(`a person must approve: ${d.approval.url}`),
});
const node = new ToolNode(tools);

const call = (id, args) => new AIMessage({ content: '', tool_calls: [{ id, name: 'buy', args, type: 'tool_call' }] });
for (const [id, args] of [['c1', { pence: 1200, domain: 'tesco.com' }], ['c2', { pence: 1200, domain: '0cado.com' }]]) {
  const out = await node.invoke({ messages: [call(id, args)] });
  console.log(`${id}: ${out.messages[0].content}`);
}

await fake?.close();
