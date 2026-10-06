/**
 * The agent side of Immiscible: ask before acting, wait for a person when
 * asked to, and report what happened.
 *
 * Zero dependencies. Needs `fetch` (Node 18+, Deno, Bun, browsers, edge
 * runtimes). Fails closed: if Immiscible cannot be reached, `authorize`
 * throws and `guard` never runs your function.
 */

import {
  ImmiscibleError,
  ImmiscibleDeniedError,
  ImmiscibleApprovalTimeoutError,
  ImmiscibleApprovalRequiredError,
} from './errors.js';
import { RunContext, type RunOptions, isValidSessionId } from './trace.js';
import { Gateway } from './gateway.js';
import { McpProxy } from './proxy.js';
import type { Action, Decision, GuardOptions, Merchant, Provenance, SettleStatus, WaitOptions } from './types.js';

export const SDK_VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'http://localhost:8787';
const SETTLE_STATUSES: readonly SettleStatus[] = ['completed', 'failed', 'cancelled'];
const OUTCOME_STATUSES = ['accepted', 'partial', 'rejected', 'abandoned'] as const;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export interface ImmiscibleOptions {
  /** An agent key (from Agents in the console). Default: IMMISCIBLE_AGENT_KEY, then ASSAY_AGENT_KEY. */
  apiKey?: string;
  /** Default: IMMISCIBLE_URL, then ASSAY_URL, then http://localhost:8787. */
  baseUrl?: string;
  /** Per request. Default 30 s. */
  timeoutMs?: number;
  /** Retries for idempotent calls on network errors, 429 and 5xx. Default 2. */
  maxRetries?: number;
  /** Your own fetch (a proxy agent, a test double). */
  fetch?: typeof fetch;
  /** Adopt a session id for this client's run. Omit to let the gateway issue one. */
  sessionId?: string;
  /** Who chose the session id: `custom` (default), `claude-code`, ... */
  sessionClient?: string;
  /** Continue your own trace. Omit to start a new one. */
  traceparent?: string;
  /** Use this run instead of creating one. */
  run?: RunContext;
}

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** Retry on network errors, 429 and 5xx. Only for calls that are safe to repeat. */
  retry?: boolean;
  /** Send the agent key. Default true. */
  auth?: boolean;
  headers?: Record<string, string>;
}

export interface PaymentRequest {
  /** Minor units: 6420 is 64.20. */
  amount: number;
  currency: string;
  merchant: string | (Partial<Merchant> & { url?: string });
  summary?: string;
  provenance?: Provenance[];
  category?: string;
  idempotencyKey?: string;
  session?: Action['session'];
}

export interface DataRequest {
  fields: string | string[];
  recipient: string;
  purpose?: string;
  summary?: string;
  provenance?: Provenance[];
  idempotencyKey?: string;
  session?: Action['session'];
}

export interface ToolActionOptions {
  /** Where the call goes, if anywhere (a domain). Read from a `url` argument when omitted. */
  domain?: string | null;
  summary?: string;
  provenance?: Provenance[];
  idempotencyKey?: string;
}

/** Read an environment variable in Node, Bun or Deno; undefined elsewhere. */
function env(name: string): string | undefined {
  try {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> }; Deno?: { env: { get(n: string): string | undefined } } };
    if (g.process?.env) return g.process.env[name] || undefined;
    if (g.Deno?.env) return g.Deno.env.get(name) || undefined;
  } catch {
    // Deno without --allow-env, or a sandbox: behave as if unset.
  }
  return undefined;
}

/** A fresh idempotency key. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return `idk_${c.randomUUID()}`;
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return `idk_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Resolve after `ms`, or reject when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** A signal that aborts on the caller's signal or after `ms`, whichever comes first. */
function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal?.aborted) ctl.abort(signal.reason);
  else signal?.addEventListener?.('abort', onAbort, { once: true });
  const t = ms > 0 ? setTimeout(() => ctl.abort(new ImmiscibleError(`Immiscible did not answer within ${ms}ms`, { type: 'timeout' })), ms) : null;
  return {
    signal: ctl.signal,
    done() {
      if (t) clearTimeout(t);
      signal?.removeEventListener?.('abort', onAbort);
    },
  };
}

/** "ocado.com", "https://www.ocado.com/basket" and "Ocado.com." all become "ocado.com". */
export function normaliseDomain(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (s.startsWith('www.')) s = s.slice(4);
  return s || null;
}

function assertMinor(amount: unknown, what: string): asserts amount is number {
  if (!Number.isSafeInteger(amount) || (amount as number) < 0) {
    throw new TypeError(`${what} is in minor units (pence, cents) as a whole number: pass 6420 for 64.20, not ${JSON.stringify(amount)}`);
  }
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

const clip = (s: unknown, n = 240): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * A `tool.call` action for a tool an agent is about to run. The default
 * mapping every framework integration uses; write your own for payments and
 * data releases so the gate can apply money and data rules.
 */
export function toolAction(name: string, args: unknown, opts: ToolActionOptions = {}): Action {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const domain = opts.domain === undefined ? normaliseDomain(typeof a.url === 'string' ? a.url : null) : normaliseDomain(opts.domain);
  let shown: string;
  try {
    shown = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  } catch {
    shown = '[arguments not serialisable]';
  }
  return {
    type: 'tool.call',
    summary: opts.summary ?? `${clip(name, 120)}: ${clip(shown)}`,
    ...(domain ? { target: { domain } } : {}),
    provenance: opts.provenance ?? [{ source: 'agent', detail: `tool call: ${clip(name, 120)}` }],
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  };
}

export class Immiscible {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** This client's run: its trace and its session. `run()` gives you a client with a new one. */
  readonly context: RunContext;
  /** Point OpenAI, Anthropic and Vercel AI SDK clients at the gateway, inside this run. */
  readonly gateway: Gateway;
  readonly #fetch: typeof fetch;

  constructor(options: ImmiscibleOptions = {}) {
    const key = options.apiKey ?? env('IMMISCIBLE_AGENT_KEY') ?? env('ASSAY_AGENT_KEY') ?? env('IMMISCIBLE_API_KEY') ?? null;
    if (!key) {
      throw new ImmiscibleError('no agent key: pass { apiKey } or set IMMISCIBLE_AGENT_KEY (issue one under Agents in the console)', { type: 'missing_api_key' });
    }
    this.apiKey = key;
    this.baseUrl = String(options.baseUrl ?? env('IMMISCIBLE_URL') ?? env('ASSAY_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    const f = options.fetch;
    this.#fetch = f ? (input, init) => f(input, init) : (input, init) => globalThis.fetch(input, init);
    this.context = options.run ?? new RunContext({ sessionId: options.sessionId, client: options.sessionClient, traceparent: options.traceparent });
    this.gateway = new Gateway(this);
  }

  /**
   * A client for a new run: same key and server, a fresh trace, and a fresh
   * session (issued by the gateway on the first model call unless you name
   * one). One run per task keeps one task's web pages from tainting the next.
   */
  run(opts: RunOptions = {}): Immiscible {
    return new Immiscible({ apiKey: this.apiKey, baseUrl: this.baseUrl, timeoutMs: this.timeoutMs, maxRetries: this.maxRetries, fetch: this.#fetch, run: new RunContext(opts) });
  }

  /** The fetch this client uses, without run headers. For the SDK's own modules. */
  rawFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.#fetch(input, init);
  }

  /** A fetch that carries this run's trace and session, for your own calls through the gateway. */
  get fetch(): typeof fetch {
    return this.context.wrapFetch(this.#fetch);
  }

  /** A client for the MCP proxy in front of one upstream tool server. */
  mcpProxy(upstreamId: string, opts?: { autoInitialize?: boolean }): McpProxy {
    return new McpProxy(this, upstreamId, opts);
  }

  /**
   * One HTTP call to Immiscible, carrying the run's traceparent. Throws
   * ImmiscibleError for anything but a 2xx.
   */
  async request<T = any>(method: string, path: string, opts: RequestOptions & { attempts?: { n: number } } = {}): Promise<T> {
    const { body, signal, retry = false, auth = true } = opts;
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (auth) headers.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    for (let attempt = 0; ; attempt++) {
      if (opts.attempts) opts.attempts.n = attempt + 1;
      headers.traceparent = this.context.traceparent();
      const t = withTimeout(signal, this.timeoutMs);
      let res: Response;
      let text: string;
      try {
        res = await this.#fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: t.signal,
        });
        text = await res.text();
      } catch (err) {
        t.done();
        if (signal?.aborted) throw signal.reason ?? err;
        if (retry && attempt < this.maxRetries) {
          await sleep(250 * 2 ** attempt, signal);
          continue;
        }
        if (err instanceof ImmiscibleError) throw err;
        throw new ImmiscibleError(`could not reach Immiscible at ${this.baseUrl}: ${(err as Error)?.message ?? err}`, { type: 'network_error', cause: err });
      }
      t.done();
      this.context.observe(res.headers);
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.ok) return json as T;
      if (retry && RETRY_STATUS.has(res.status) && attempt < this.maxRetries) {
        const ra = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 250 * 2 ** attempt, signal);
        continue;
      }
      const e = json?.error ?? {};
      throw new ImmiscibleError(e.message ?? `Immiscible answered ${res.status}`, {
        status: res.status,
        type: e.type ?? 'http_error',
        body: json,
        traceparent: res.headers?.get?.('traceparent') ?? null,
      });
    }
  }

  /**
   * Ask before acting. Returns the decision; a deny is a result, not an
   * exception. An idempotency key is added if you did not send one, and
   * reused on every retry, so a retry never authorises twice.
   */
  async authorize(action: Action, opts: { signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<Decision> {
    if (!action || typeof action !== 'object') throw new TypeError('authorize(action): action must be an object');
    if (!action.type) throw new TypeError('authorize(action): action.type is required, for example "payment" or "tool.call"');
    if (!action.summary) throw new TypeError('authorize(action): action.summary is required: one sentence a person can approve or refuse');
    const idempotencyKey = opts.idempotencyKey ?? action.idempotencyKey ?? newIdempotencyKey();
    const body: Action = { ...action, idempotencyKey };
    if (body.session === undefined) {
      const ref = this.context.sessionRef();
      if (ref) body.session = ref;
      else delete body.session;
    } else if (body.session === null) {
      delete body.session;
    } else if (!isValidSessionId(body.session.id)) {
      throw new TypeError('authorize: session.id must be 1 to 128 printable characters with no spaces');
    }
    return this.request<Decision>('POST', '/v1/actions/authorize', {
      body,
      signal: opts.signal,
      retry: true,
      headers: { 'idempotency-key': idempotencyKey },
    });
  }

  /** The current state of an action. */
  async getAction(actionId: string, opts: { signal?: AbortSignal } = {}): Promise<Decision> {
    if (typeof actionId !== 'string' || !actionId) throw new TypeError('getAction(actionId): actionId is required');
    return this.request<Decision>('GET', `/v1/actions/${encodeURIComponent(actionId)}`, { signal: opts.signal, retry: true });
  }

  /**
   * Poll until the decision is final: a person approved (`allow`, with a
   * receipt) or refused, or the approval expired (`deny`). Backs off from
   * `initialDelayMs` to `maxDelayMs` with jitter. Returns the final
   * decision; throws ImmiscibleApprovalTimeoutError after `timeoutMs`, and
   * the signal's reason if you abort.
   */
  async waitForDecision(actionId: string, opts: WaitOptions = {}): Promise<Decision> {
    const { timeoutMs = 10 * 60_000, initialDelayMs = 500, maxDelayMs = 8_000, factor = 1.6, signal, onPoll } = opts;
    const deadline = Date.now() + timeoutMs;
    let delay = Math.max(1, initialDelayMs);
    for (;;) {
      const d = await this.getAction(actionId, { signal });
      if (d?.decision !== 'approval_required') return d;
      await onPoll?.(d);
      const left = deadline - Date.now();
      if (left <= 0) throw new ImmiscibleApprovalTimeoutError(actionId, { timeoutMs, decision: d });
      const jittered = delay * (0.8 + Math.random() * 0.4);
      await sleep(Math.min(jittered, left), signal);
      delay = Math.min(maxDelayMs, delay * factor);
    }
  }

  /** Alias of waitForDecision, for code written against the earlier SDK. */
  waitForApproval(actionId: string, opts: WaitOptions = {}): Promise<Decision> {
    return this.waitForDecision(actionId, opts);
  }

  /**
   * Record what actually happened. Settling above the authorised amount is
   * recorded as an incident and alerts the owner. Retried on network errors;
   * if a retry finds the action already settled (the first attempt landed),
   * the action is returned rather than an error.
   */
  async settle(actionId: string, opts: { status?: SettleStatus; amount?: number | null; signal?: AbortSignal } = {}): Promise<Decision> {
    const status = opts.status ?? 'completed';
    if (!SETTLE_STATUSES.includes(status)) throw new TypeError(`settle: status must be one of ${SETTLE_STATUSES.join(', ')}`);
    if (opts.amount != null) assertMinor(opts.amount, 'settle: amount');
    const body = opts.amount == null ? { status } : { status, amount: opts.amount };
    const attempts = { n: 0 };
    try {
      return await this.request<Decision>('POST', `/v1/actions/${encodeURIComponent(actionId)}/settle`, { body, signal: opts.signal, retry: true, attempts });
    } catch (err) {
      if (attempts.n > 1 && err instanceof ImmiscibleError && err.type === 'already_settled') return this.getAction(actionId, { signal: opts.signal });
      throw err;
    }
  }

  /**
   * The whole lifecycle in one call: authorize, wait for a person if asked,
   * run `fn` only if allowed, then settle with what happened.
   */
  async guard<T>(action: Action, fn: (d: Decision) => T | Promise<T>, opts: GuardOptions<T> = {}): Promise<T> {
    if (typeof fn !== 'function') throw new TypeError('guard(action, fn): fn must be a function');
    const d = await this.decide(action, opts);
    let result: T;
    try {
      result = await fn(d);
    } catch (err) {
      if (opts.settle !== false) await this.#quietSettle(d.id, { status: 'failed' }, opts);
      throw err;
    }
    if (opts.settle !== false) {
      const amount = opts.settleAmount ? opts.settleAmount(result, d) : action.payment?.amount;
      await this.#quietSettle(d.id, amount == null ? { status: 'completed' } : { status: 'completed', amount }, opts);
    }
    return result;
  }

  /**
   * Authorize and, when a person is asked, wait. Returns an `allow`
   * decision or throws: ImmiscibleDeniedError, ImmiscibleApprovalRequiredError
   * (with `wait: false`) or ImmiscibleApprovalTimeoutError. What `guard`
   * does before running your code, for frameworks that run the tool themselves.
   */
  async decide(action: Action, opts: GuardOptions<any> = {}): Promise<Decision> {
    let d = await this.authorize(action, { signal: opts.signal, idempotencyKey: opts.idempotencyKey });
    if (d?.decision === 'approval_required') {
      if (opts.wait === false) throw new ImmiscibleApprovalRequiredError(d);
      await opts.onApprovalRequired?.(d);
      d = await this.waitForDecision(d.id, opts);
    }
    if (d?.decision !== 'allow') throw new ImmiscibleDeniedError(d);
    return d;
  }

  /** Settlement failures are reported, never allowed to mask the action's own result. */
  async #quietSettle(actionId: string, body: { status: SettleStatus; amount?: number }, opts: GuardOptions<any>): Promise<void> {
    try {
      await this.settle(actionId, { ...body, signal: opts.signal });
    } catch (err) {
      if (opts.onSettleError) opts.onSettleError(err, actionId);
      else globalThis.console?.warn?.(`[immiscible] could not settle ${actionId}: ${(err as Error).message}`);
    }
  }

  /** Settle without throwing: for integrations, where the tool's own result must win. */
  async settleQuietly(actionId: string, body: { status: SettleStatus; amount?: number }, opts: GuardOptions<any> = {}): Promise<void> {
    return this.#quietSettle(actionId, body, opts);
  }

  /** A payment action, built and checked. `amount` is in minor units (6420 is 64.20). */
  static paymentAction(req: PaymentRequest): Action {
    const { amount, currency, merchant, summary, provenance, category, idempotencyKey, session } = req ?? ({} as PaymentRequest);
    assertMinor(amount, 'pay: amount');
    if (amount === 0) throw new TypeError('pay: amount must be above zero');
    if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) throw new TypeError('pay: currency must be a three-letter ISO code such as "GBP"');
    const m: Record<string, unknown> = typeof merchant === 'string' ? { domain: merchant } : { ...(merchant ?? {}) };
    m.domain = normaliseDomain(m.domain ?? m.url);
    delete m.url;
    if (!m.domain) throw new TypeError('pay: merchant needs a domain, for example "ocado.com" or { name: "Ocado", domain: "ocado.com" }');
    if (category && !m.category) m.category = category;
    const cur = currency.toUpperCase();
    return {
      type: 'payment',
      summary: summary ?? `Pay ${money(amount, cur)} to ${(m.name as string) ?? m.domain}`,
      payment: { amount, currency: cur, merchant: m as unknown as Merchant },
      target: { domain: m.domain as string },
      ...(provenance ? { provenance } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(session !== undefined ? { session } : {}),
    };
  }

  /** A data.release action, built and checked. */
  static dataAction(req: DataRequest): Action {
    const { fields, recipient, purpose, summary, provenance, idempotencyKey, session } = req ?? ({} as DataRequest);
    const list = typeof fields === 'string' ? [fields] : fields;
    if (!Array.isArray(list) || !list.length) throw new TypeError('requestData: fields must list vault fields, for example ["address"]');
    const to = normaliseDomain(recipient);
    if (!to) throw new TypeError('requestData: recipient must be a domain, for example "ocado.com"');
    return {
      type: 'data.release',
      summary: summary ?? `Share ${list.join(', ')} with ${to}${purpose ? ` for ${purpose}` : ''}`,
      data: { fields: list, recipient: to, ...(purpose ? { purpose } : {}) },
      target: { recipient: to },
      ...(provenance ? { provenance } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(session !== undefined ? { session } : {}),
    };
  }

  /** Ask to pay a merchant. With a function as the second argument this is `guard`. */
  pay(req: PaymentRequest): Promise<Decision>;
  pay<T>(req: PaymentRequest, fn: (d: Decision) => T | Promise<T>, opts?: GuardOptions<T>): Promise<T>;
  pay<T>(req: PaymentRequest, fn?: (d: Decision) => T | Promise<T>, opts?: GuardOptions<T>): Promise<T | Decision> {
    const action = Immiscible.paymentAction(req);
    return fn ? this.guard(action, fn, opts) : this.authorize(action);
  }

  /** Ask for named fields from the person's vault, for one recipient. Values arrive in `decision.released`. */
  requestData(req: DataRequest): Promise<Decision>;
  requestData<T>(req: DataRequest, fn: (d: Decision) => T | Promise<T>, opts?: GuardOptions<T>): Promise<T>;
  requestData<T>(req: DataRequest, fn?: (d: Decision) => T | Promise<T>, opts?: GuardOptions<T>): Promise<T | Decision> {
    const action = Immiscible.dataAction(req);
    return fn ? this.guard(action, fn, opts) : this.authorize(action);
  }

  /** TokenOps: how a task ended, so its token spend has a denominator. */
  async outcome(taskId: string, status: (typeof OUTCOME_STATUSES)[number], extra: { value?: number; evidence?: object; acceptedCallIds?: string[]; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!taskId) throw new TypeError('outcome(taskId, status): taskId is required (the x-immiscible-task-id of the calls)');
    if (!OUTCOME_STATUSES.includes(status)) throw new TypeError(`outcome: status must be one of ${OUTCOME_STATUSES.join(', ')}`);
    const { signal, ...rest } = extra;
    return this.request('POST', '/v1/outcomes', { body: { taskId, status, ...rest }, signal });
  }
}
