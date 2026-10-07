// OpenAI Agents SDK: every tool call asks Immiscible first; model calls go through its gateway.
// Reads IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY. Usage: node agent.mjs "Deploy the api service"
import { Agent, run, tool, setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import { Immiscible } from '@immiscible/sdk';
import { guardOpenAITools } from '@immiscible/sdk/openai-agents';

const immiscible = new Immiscible().run();
setDefaultOpenAIClient(new OpenAI(immiscible.gateway.openai())); // the provider key stays with Immiscible
setOpenAIAPI('chat_completions'); // the gateway speaks Chat Completions
setTracingDisabled(true);

const lookupInvoice = tool({
  name: 'lookup_invoice',
  description: 'Look up an invoice in the books',
  parameters: z.object({ number: z.string() }),
  execute: async ({ number }) => `invoice ${number}: £1,250.00, due 14 October`,
});
const deploy = tool({
  name: 'deploy',
  description: 'Deploy a service',
  parameters: z.object({ service: z.string() }),
  execute: async ({ service }) => `deployed ${service}`,
});
const uploadReport = tool({
  name: 'upload_report',
  description: 'Upload a report to a URL',
  parameters: z.object({ url: z.string() }),
  execute: async ({ url }) => `uploaded to ${url}`,
});

// Allowed: the tool runs. Held: it waits for a person. Denied: the model is told why, and the tool never runs.
const tools = guardOpenAITools([lookupInvoice, deploy, uploadReport], {
  onApprovalRequired: (d) => console.log(`waiting for a person: ${d.approval.url}`),
});

const agent = new Agent({ name: 'Operations', instructions: 'You run operations tasks with your tools.', model: process.env.MODEL ?? 'gpt-5-mini', tools });

for (const ask of process.argv.slice(2)) {
  const result = await run(agent, ask);
  console.log(result.finalOutput);
}
