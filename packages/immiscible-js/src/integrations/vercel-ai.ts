/**
 * Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`).
 *
 *   import { generateText, wrapLanguageModel } from 'ai';
 *   import { createOpenAI } from '@ai-sdk/openai';
 *   import { guardAiTools, immiscibleMiddleware } from '@immiscible/sdk/ai';
 *
 *   const immiscible = new Immiscible().run();
 *   const provider = createOpenAI(immiscible.gateway.aiSdkOpenAI());     // model routing through the gateway
 *   const model = wrapLanguageModel({ model: provider.chat('gpt-5-mini'), middleware: immiscibleMiddleware({ client: immiscible }) });
 *
 *   await generateText({ model, tools: guardAiTools({ buy, search }, { client: immiscible }), prompt });
 *
 * Two parts. The middleware puts every model call inside the run (trace and
 * session headers), whichever provider it goes through, so the gateway's
 * record of the model's context joins the gate's record of the agent's
 * actions. The tool guard asks before each tool's `execute` runs and settles
 * afterwards.
 */

import type { Immiscible } from '../client.js';
import { clientOf, gated, type IntegrationOptions } from './core.js';

/** The part of an AI SDK tool definition this needs. */
export interface AiToolLike {
  execute?: (input: any, options?: any) => unknown;
  [k: string]: unknown;
}

/** Guard one tool definition (the object `tool({...})` returns). Tools without `execute` pass through. */
export function guardAiTool<T extends AiToolLike>(name: string, def: T, opts: IntegrationOptions = {}): T {
  if (!def || typeof def.execute !== 'function') return def;
  const execute = def.execute;
  return {
    ...def,
    async execute(input: any, options?: any) {
      return gated(
        { name, args: input, callId: options?.toolCallId ?? null, context: options },
        () => execute.call(def, input, options),
        { signal: options?.abortSignal, ...opts },
      );
    },
  };
}

/** Guard every tool in a tool set: `generateText({ tools: guardAiTools(tools, opts) })`. */
export function guardAiTools<T extends Record<string, AiToolLike>>(tools: T, opts: IntegrationOptions = {}): T {
  const out: Record<string, AiToolLike> = {};
  for (const [name, def] of Object.entries(tools)) out[name] = guardAiTool(name, def, opts);
  return out as T;
}

export interface MiddlewareOptions {
  client?: Immiscible;
  /** Static headers for every model call: `x-immiscible-task-id`, `x-immiscible-task-class`, ... */
  headers?: Record<string, string>;
}

/**
 * Language model middleware for `wrapLanguageModel`. Adds the run's
 * traceparent (a fresh span per call) and session header to every model
 * call. Use it with any provider pointed at the gateway; with
 * `gateway.aiSdkOpenAI()` the provider's fetch already does this, and the
 * middleware is harmless alongside it.
 *
 * `specificationVersion` follows the AI SDK you run (`v2` for ai 5, `v3`
 * for ai 6, `v4` for ai 7); the SDK does not check it at runtime.
 */
export function immiscibleMiddleware(opts: MiddlewareOptions & { specificationVersion?: string } = {}) {
  const client = clientOf(opts);
  return {
    specificationVersion: (opts.specificationVersion ?? 'v4') as any,
    middlewareVersion: 'v2' as any,
    async transformParams({ params }: { type: 'generate' | 'stream'; params: any; model?: unknown }) {
      const run = client.context.headers();
      return { ...params, headers: { ...(opts.headers ?? {}), ...(params?.headers ?? {}), ...run } };
    },
    // Read the session the gateway issued back off the response, so the next call and the next action carry it.
    async wrapGenerate({ doGenerate }: { doGenerate: () => PromiseLike<any> }) {
      const result = await doGenerate();
      client.context.observe(result?.response?.headers);
      return result;
    },
    async wrapStream({ doStream }: { doStream: () => PromiseLike<any> }) {
      const result = await doStream();
      client.context.observe(result?.response?.headers);
      return result;
    },
  };
}
