/**
 * OpenAI Agents SDK (`@openai/agents`).
 *
 *   import { Agent, run, tool, setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents';
 *   import OpenAI from 'openai';
 *   import { Immiscible } from '@immiscible/sdk';
 *   import { guardOpenAITools } from '@immiscible/sdk/openai-agents';
 *
 *   const immiscible = new Immiscible().run();
 *   setDefaultOpenAIClient(new OpenAI(immiscible.gateway.openai()));   // model calls through the gateway
 *   setOpenAIAPI('chat_completions');
 *
 *   const agent = new Agent({ name: 'Shopper', tools: guardOpenAITools([buy, search], { client: immiscible }) });
 *
 * Each guarded tool asks Immiscible before it runs, waits for a person when
 * one is asked, runs only if allowed, and settles afterwards. A refusal goes
 * back to the model as text telling it to stop.
 */

import { cloneWith, gated, parseArgs, clientOf, refusalMessage, defaultMapToAction, type IntegrationOptions } from './core.js';
import { ImmiscibleApprovalRequiredError, ImmiscibleDeniedError, isRefusal } from '../errors.js';

/** The part of an Agents SDK FunctionTool this needs. */
export interface OpenAIFunctionToolLike {
  name: string;
  invoke: (runContext: any, input: string, details?: any) => Promise<unknown>;
}

/**
 * Guard one function tool: the full lifecycle, including settlement after
 * the tool runs. Returns a copy; the original is untouched.
 */
export function guardOpenAITool<T extends OpenAIFunctionToolLike>(tool: T, opts: IntegrationOptions = {}): T {
  if (!tool || typeof tool.invoke !== 'function') throw new TypeError('guardOpenAITool: expected a function tool with invoke(runContext, input)');
  const invoke = tool.invoke;
  const guarded = async (runContext: any, input: string, details?: any) => {
    const callId = details?.toolCall?.callId ?? details?.toolCall?.id ?? null;
    return gated(
      { name: tool.name, args: parseArgs(input), callId, context: runContext },
      () => invoke.call(tool, runContext, input, details),
      { signal: details?.signal, ...opts },
    );
  };
  return cloneWith(tool, { invoke: guarded });
}

/** Guard a list of tools. Anything that is not a function tool (hosted tools, handoffs) passes through. */
export function guardOpenAITools<T>(tools: T[], opts: IntegrationOptions = {}): T[] {
  return tools.map((t) => {
    const x = t as unknown as Partial<OpenAIFunctionToolLike> & { type?: string };
    return x && x.type === 'function' && typeof x.invoke === 'function' ? (guardOpenAITool(x as OpenAIFunctionToolLike, opts) as unknown as T) : t;
  });
}

/**
 * A tool input guardrail (the `{ type, name, run }` shape
 * `defineToolInputGuardrail` produces); attach it to a tool's
 * `inputGuardrails`. It authorises and waits for a person, but cannot
 * settle, because a guardrail never sees the result: prefer
 * `guardOpenAITool` when you build the tool yourself.
 */
export function openaiToolGuardrail(opts: IntegrationOptions & { name?: string } = {}) {
  return {
    type: 'tool_input' as const,
    name: opts.name ?? 'immiscible',
    async run({ context, toolCall }: { context?: unknown; toolCall?: { name?: string; arguments?: string; callId?: string } } = {}) {
      const map = opts.mapToAction ?? defaultMapToAction;
      const action = await map({ name: toolCall?.name ?? 'tool', args: parseArgs(toolCall?.arguments), callId: toolCall?.callId ?? null, context });
      if (action == null) return { behavior: { type: 'allow' as const } };
      const client = clientOf(opts);
      try {
        const d = await client.decide(action, opts);
        return { outputInfo: { immiscible: { actionId: d.id, receipt: d.receipt ?? null } }, behavior: { type: 'allow' as const } };
      } catch (err) {
        if (!isRefusal(err)) throw err;
        const decision = (err as ImmiscibleDeniedError | ImmiscibleApprovalRequiredError).decision ?? null;
        if (opts.onDeny === 'throw') return { outputInfo: { immiscible: decision }, behavior: { type: 'throwException' as const } };
        return { outputInfo: { immiscible: decision }, behavior: { type: 'rejectContent' as const, message: opts.refusal ? opts.refusal(err) : refusalMessage(err) } };
      }
    },
  };
}

// Human in the loop: answer the SDK's own approval interruptions with Immiscible (approvals.ts).
export { resolveInterruptions } from './approvals.js';
export type { InterruptedResultLike, ToolApprovalItemLike, ApprovalAdapterOptions, ResolvedCall } from './approvals.js';
