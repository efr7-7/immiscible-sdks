/**
 * Carrying one agent run across calls: a W3C trace and an Immiscible session.
 *
 * A run is what an agent does for one task: some model calls, some tool
 * calls, some actions. Immiscible joins them two ways:
 *
 *   trace    every request carries `traceparent` with the run's trace id and
 *            a fresh span id, so the gateway's records, the gate's decisions
 *            and your own OpenTelemetry spans line up in one trace.
 *   session  the gateway watches what enters the model's context (a web page,
 *            an email, a third-party tool result). The gate compares that
 *            with the provenance the agent declares when it asks to act.
 *            The join is the session id.
 *
 * Sessions come in two kinds. Leave the id out and the gateway issues one
 * (`imss_...`, returned in `x-immiscible-session`), bound to your key so no
 * other key can join it; the run adopts it from the first gateway response
 * and sends it from then on. Or choose one yourself (a Claude Code
 * session_id, your own run id): it is sent as `x-immiscible-client-session` and lives in
 * your key owner's namespace.
 */

import type { SessionRef } from './types.js';

/** A session id you chose. */
export const SESSION_HEADER = 'x-immiscible-client-session';
/** A session id the gateway issued (imss_...). */
export const ISSUED_SESSION_HEADER = 'x-immiscible-session';
export const TRACEPARENT_HEADER = 'traceparent';

const SESSION_ID_RX = /^[\x21-\x7e]{1,128}$/;
const TRACEPARENT_RX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

export interface TraceParent {
  traceId: string;
  parentId: string;
  sampled: boolean;
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  const c = globalThis.crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export const newTraceId = (): string => {
  const id = randomHex(16);
  return id === ZERO_TRACE ? newTraceId() : id;
};

export const newSpanId = (): string => {
  const id = randomHex(8);
  return id === ZERO_SPAN ? newSpanId() : id;
};

/** Parse a W3C traceparent. Returns null for anything the spec says to ignore. */
export function parseTraceparent(header: unknown): TraceParent | null {
  if (typeof header !== 'string') return null;
  const s = header.trim();
  const m = TRACEPARENT_RX.exec(s);
  if (!m) return null;
  const [, version, traceId, parentId, flags, rest] = m;
  if (version === 'ff') return null;
  if (version === '00' && rest) return null;
  if (traceId === ZERO_TRACE || parentId === ZERO_SPAN) return null;
  return { traceId, parentId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RX.test(id);
}

export interface RunOptions {
  /** Adopt a session id: an `imss_...` the gateway issued, or one you chose. Omit to let the gateway issue one. */
  sessionId?: string;
  /** The client, for the record: a known client id such as `custom` (default), `claude-code`, `openai-sdk`, `anthropic-sdk`, `langchain`, `vercel-ai`. */
  client?: string;
  /** Continue your own trace (for example the active OpenTelemetry span). Omit to start a new one. */
  traceparent?: string;
}

type HeaderBag = { get(name: string): string | null } | Record<string, unknown> | null | undefined;

function headerOf(h: HeaderBag, name: string): string | null {
  if (!h) return null;
  if (typeof (h as { get?: unknown }).get === 'function') return (h as { get(n: string): string | null }).get(name);
  const v = (h as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : null;
}

/**
 * One agent run. Usually you get one from `immiscible.run()`, which also
 * binds it to a client; use it directly to carry the same trace and session
 * into code that does not hold the client.
 */
export class RunContext {
  readonly traceId: string;
  readonly sampled: boolean;
  /** The span this run continues, when it was given a traceparent. */
  readonly parentSpanId: string | null;
  /** The run's own root span: what `traceparent()` children hang off conceptually. */
  readonly spanId: string;
  client: string;
  #sessionId: string | null = null;
  #issued = false;
  /** The traceparent the server last answered with: its span, in our trace. */
  lastServerTraceparent: string | null = null;

  constructor(opts: RunOptions = {}) {
    const parent = opts.traceparent ? parseTraceparent(opts.traceparent) : null;
    if (opts.traceparent && !parent) throw new TypeError('run: traceparent is not a valid W3C traceparent (00-<32 hex>-<16 hex>-<2 hex>)');
    this.traceId = parent?.traceId ?? newTraceId();
    this.sampled = parent?.sampled ?? true;
    this.parentSpanId = parent?.parentId ?? null;
    this.spanId = newSpanId();
    this.client = String(opts.client ?? 'custom').trim().toLowerCase() || 'custom';
    if (opts.sessionId != null) this.adoptSession(opts.sessionId);
  }

  /** The session id, or null until the gateway issues one. */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** True when the session id was issued by the gateway (imss_...). */
  get sessionIssued(): boolean {
    return this.#issued;
  }

  /** Use this session id from now on. */
  adoptSession(id: string): void {
    if (!isValidSessionId(id)) throw new TypeError('session id must be 1 to 128 printable characters with no spaces');
    this.#sessionId = id;
    this.#issued = id.startsWith('imss_');
  }

  /** The `session` field an action request carries, or null. */
  sessionRef(): SessionRef | null {
    return this.#sessionId ? { client: this.client, id: this.#sessionId } : null;
  }

  /** A traceparent for one outgoing call: this run's trace, a fresh span. */
  traceparent(): string {
    return formatTraceparent(this.traceId, newSpanId(), this.sampled);
  }

  /** Headers for one outgoing call: traceparent, and the session header when there is a session. */
  headers(): Record<string, string> {
    const h: Record<string, string> = { [TRACEPARENT_HEADER]: this.traceparent() };
    if (this.#sessionId) h[this.#issued ? ISSUED_SESSION_HEADER : SESSION_HEADER] = this.#sessionId;
    return h;
  }

  /** Read a response: adopt a session the gateway issued, remember its traceparent. */
  observe(headers: HeaderBag): void {
    const issued = headerOf(headers, ISSUED_SESSION_HEADER);
    if (issued && isValidSessionId(issued) && (!this.#sessionId || this.#issued)) {
      this.#sessionId = issued;
      this.#issued = true;
    }
    const tp = headerOf(headers, TRACEPARENT_HEADER);
    if (tp && parseTraceparent(tp)) this.lastServerTraceparent = tp;
  }

  /**
   * A fetch that adds this run's headers to every request and reads the
   * session back from every response. Hand it to a model SDK (`fetch`
   * option) so its calls through the gateway join the run.
   */
  wrapFetch(fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)): typeof fetch {
    const run = this;
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
      for (const [k, v] of Object.entries(run.headers())) {
        // A caller's own traceparent (an OpenTelemetry instrumentation, say) wins.
        if (k === TRACEPARENT_HEADER && headers.has(k)) continue;
        headers.set(k, v);
      }
      // Never send both kinds of session header.
      if (run.#issued) headers.delete(SESSION_HEADER);
      else if (run.#sessionId) headers.delete(ISSUED_SESSION_HEADER);
      const res = await fetchImpl(input, { ...init, headers });
      run.observe(res.headers);
      return res;
    };
    return wrapped as typeof fetch;
  }

  toJSON(): { traceId: string; sessionId: string | null; sessionIssued: boolean; client: string } {
    return { traceId: this.traceId, sessionId: this.#sessionId, sessionIssued: this.#issued, client: this.client };
  }
}
