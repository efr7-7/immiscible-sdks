/**
 * Point model SDKs at the Immiscible gateway. Adoption is a base URL and a
 * key; these helpers also hand the SDK a fetch that carries the run's trace
 * and session, so the gateway's view of the model's context joins the gate's
 * view of the agent's actions.
 *
 *   import OpenAI from 'openai';
 *   import Anthropic from '@anthropic-ai/sdk';
 *
 *   const run = immiscible.run();
 *   const openai = new OpenAI(run.gateway.openai());
 *   const anthropic = new Anthropic(run.gateway.anthropic());
 *
 * The gateway speaks OpenAI Chat Completions at `<base>/v1/chat/completions`
 * and Anthropic Messages at `<base>/anthropic/v1/messages`.
 */

import type { Immiscible } from './client.js';

export interface GatewayCallOptions {
  /** The key the gateway meters. Default: the client's agent key. A person's inference key works too. */
  apiKey?: string;
  /** Groups calls into one task for TokenOps (`x-immiscible-task-id`). */
  taskId?: string;
  /** A task class id, for routing (`x-immiscible-task-class`). */
  taskClass?: string;
  /** What the task is for (`x-immiscible-objective`). */
  objective?: string;
  /** Any further static headers. */
  headers?: Record<string, string>;
}

/** Options for `new OpenAI(...)` (the `openai` package, v4 and later). */
export interface OpenAIClientOptions {
  baseURL: string;
  apiKey: string;
  defaultHeaders: Record<string, string>;
  fetch: typeof fetch;
}

/** Options for `new Anthropic(...)` (the `@anthropic-ai/sdk` package). */
export interface AnthropicClientOptions {
  baseURL: string;
  apiKey: string;
  defaultHeaders: Record<string, string>;
  fetch: typeof fetch;
}

/** Settings for `createOpenAI(...)` / `createAnthropic(...)` from the Vercel AI SDK providers. */
export interface AiSdkProviderSettings {
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
}

export class Gateway {
  readonly #client: Immiscible;

  constructor(client: Immiscible) {
    this.#client = client;
  }

  /** The gateway's base URL (the same server as the gate). */
  get baseUrl(): string {
    return this.#client.baseUrl;
  }

  #static(opts: GatewayCallOptions): Record<string, string> {
    const h: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.taskId) h['x-immiscible-task-id'] = opts.taskId;
    if (opts.taskClass) h['x-immiscible-task-class'] = opts.taskClass;
    if (opts.objective) h['x-immiscible-objective'] = opts.objective;
    return h;
  }

  /** `new OpenAI(immiscible.gateway.openai())`: Chat Completions through the gateway. */
  openai(opts: GatewayCallOptions = {}): OpenAIClientOptions {
    return {
      baseURL: `${this.baseUrl}/v1`,
      apiKey: opts.apiKey ?? this.#client.apiKey,
      defaultHeaders: this.#static(opts),
      fetch: this.#client.fetch,
    };
  }

  /** `new Anthropic(immiscible.gateway.anthropic())`: Messages through the gateway. */
  anthropic(opts: GatewayCallOptions = {}): AnthropicClientOptions {
    return {
      baseURL: `${this.baseUrl}/anthropic`,
      apiKey: opts.apiKey ?? this.#client.apiKey,
      defaultHeaders: this.#static(opts),
      fetch: this.#client.fetch,
    };
  }

  /**
   * `createOpenAI(immiscible.gateway.aiSdkOpenAI())` for the Vercel AI SDK.
   * Use `provider.chat(modelId)`: the gateway speaks Chat Completions, not
   * the Responses API.
   */
  aiSdkOpenAI(opts: GatewayCallOptions = {}): AiSdkProviderSettings {
    return { baseURL: `${this.baseUrl}/v1`, apiKey: opts.apiKey ?? this.#client.apiKey, headers: this.#static(opts), fetch: this.#client.fetch };
  }

  /** `createAnthropic(immiscible.gateway.aiSdkAnthropic())` for the Vercel AI SDK. */
  aiSdkAnthropic(opts: GatewayCallOptions = {}): AiSdkProviderSettings {
    return { baseURL: `${this.baseUrl}/anthropic/v1`, apiKey: opts.apiKey ?? this.#client.apiKey, headers: this.#static(opts), fetch: this.#client.fetch };
  }

  /**
   * Environment for a child process that reads the standard variables
   * (Claude Code, the OpenAI and Anthropic CLIs). Static: a child process
   * cannot carry a fresh span per call, so only the session travels, and
   * only once the run has one.
   */
  env(opts: GatewayCallOptions = {}): Record<string, string> {
    const key = opts.apiKey ?? this.#client.apiKey;
    return {
      OPENAI_BASE_URL: `${this.baseUrl}/v1`,
      OPENAI_API_KEY: key,
      ANTHROPIC_BASE_URL: `${this.baseUrl}/anthropic`,
      ANTHROPIC_API_KEY: key,
      IMMISCIBLE_URL: this.baseUrl,
      ...(this.#client.context.sessionId ? { IMMISCIBLE_SESSION: this.#client.context.sessionId } : {}),
      TRACEPARENT: this.#client.context.traceparent(),
    };
  }
}
