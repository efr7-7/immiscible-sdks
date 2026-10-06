/**
 * LangChain and LangGraph (`@langchain/core`, `@langchain/langgraph`).
 *
 *   import { ToolNode } from '@langchain/langgraph/prebuilt';
 *   import { guardLangChainTools } from '@immiscible/sdk/langchain';
 *
 *   const tools = guardLangChainTools([buy, search], { client: immiscible });
 *   const node = new ToolNode(tools);          // or model.bindTools(tools), or createReactAgent({ tools })
 *
 * A guarded tool keeps its name, description and schema, so it drops into
 * `ToolNode`, `bindTools` and the prebuilt agents unchanged. For a LangGraph
 * human in the loop, pass `onApprovalRequired: (d) => interrupt({ approve: d.approval.url })`,
 * or `wait: false` to refuse at once and let the graph route the refusal.
 */

import { cloneWith, gated, type IntegrationOptions } from './core.js';

/** Anything with `invoke(input, config)`: a `tool()` result, a StructuredTool, a DynamicTool. */
export interface LangChainToolLike {
  name: string;
  invoke: (input: any, config?: any) => Promise<unknown>;
}

function isToolCall(input: any): input is { name: string; args: unknown; id?: string; type?: string } {
  return !!input && typeof input === 'object' && (input.type === 'tool_call' || ('args' in input && 'id' in input && 'name' in input));
}

/** Guard one tool. Returns a copy; the original is untouched. */
export function guardLangChainTool<T extends LangChainToolLike>(tool: T, opts: IntegrationOptions = {}): T {
  if (!tool || typeof tool.invoke !== 'function') throw new TypeError('guardLangChainTool: expected a tool with invoke(input, config)');
  const invoke = tool.invoke;
  const guarded = async (input: any, config?: any) => {
    // ToolNode passes a whole ToolCall ({ name, args, id, type: 'tool_call' }); a direct call passes the args.
    const call = isToolCall(input);
    const args = call ? input.args : input;
    const callId = call ? input.id ?? null : config?.toolCall?.id ?? null;
    return gated({ name: tool.name, args, callId, context: config }, () => invoke.call(tool, input, config), { signal: config?.signal, ...opts });
  };
  return cloneWith(tool, { invoke: guarded });
}

/** Guard a list of tools. */
export function guardLangChainTools<T extends LangChainToolLike>(tools: T[], opts: IntegrationOptions = {}): T[] {
  return tools.map((t) => guardLangChainTool(t, opts));
}
