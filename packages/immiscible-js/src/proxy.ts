/**
 * The MCP proxy, from the agent's side.
 *
 * Immiscible can sit between an agent and a tool server and hold the tool's
 * credential, so there is no path to the tool that skips the gate. The agent
 * speaks MCP (Streamable HTTP, JSON-RPC 2.0) to `<base>/mcp/proxy/<upstreamId>`
 * with its agent key:
 *
 *   allow              the upstream's result comes back as is
 *   approval_required  nothing was sent upstream: ImmiscibleApprovalRequiredError
 *   deny               nothing was sent: ImmiscibleDeniedError with the reasons
 *
 * `callWithApproval` does the whole dance: call, wait for the person, call
 * again naming the approval, which the proxy forwards exactly once.
 *
 * Using an MCP client library instead? Point it at `mcpProxyUrl(...)` and read
 * results with `approvalFromResult(result)`.
 */

import { ImmiscibleError, ImmiscibleDeniedError, ImmiscibleApprovalRequiredError } from './errors.js';
import type { Decision, WaitOptions } from './types.js';
import type { Immiscible } from './client.js';

export const MCP_PROTOCOL = '2025-06-18';
/** `_meta` keys the proxy reads. Wire names, kept from the protocol's first version. */
export const META_APPROVAL_ID = 'immiscible/approvalId';
export const META_IDEMPOTENCY_KEY = 'immiscible/idempotencyKey';

/** `<base>/mcp/proxy/<upstreamId>`, with the id encoded. */
export function mcpProxyUrl(baseUrl: string, upstreamId: string): string {
  if (typeof upstreamId !== 'string' || !upstreamId) throw new TypeError('mcpProxyUrl: upstreamId is required (the id shown for the upstream in the console)');
  return `${String(baseUrl).replace(/\/+$/, '')}/mcp/proxy/${encodeURIComponent(upstreamId)}`;
}

/** `<base>/mcp`: Immiscible's own MCP server (authorize_action, request_payment, ...). */
export function mcpServerUrl(baseUrl: string): string {
  return `${String(baseUrl).replace(/\/+$/, '')}/mcp`;
}

export interface PendingApproval {
  actionId: string;
  approval: { id: string; url: string; expiresAt?: string } | null;
  reasons: string[];
}

/** Read an approval-required answer out of a tools/call result, from any MCP client. Null for anything else. */
export function approvalFromResult(result: any): PendingApproval | null {
  const sc = result?.structuredContent;
  if (!sc || sc.decision !== 'approval_required' || typeof sc.actionId !== 'string') return null;
  return { actionId: sc.actionId, approval: sc.approval ?? null, reasons: Array.isArray(sc.reasons) ? sc.reasons : [] };
}

/** The `_meta` a retry needs, from an approval, an ImmiscibleApprovalRequiredError, or an approval id. */
export function approvalMeta(approvalOrId: string | { approval?: { id?: string } | null; id?: string } | null): Record<string, string> {
  const id = typeof approvalOrId === 'string' ? approvalOrId : approvalOrId?.approval?.id ?? approvalOrId?.id ?? null;
  if (typeof id !== 'string' || !id.startsWith('apr_')) throw new TypeError('approvalMeta: expected an approval id (apr_...), an approval, or an ImmiscibleApprovalRequiredError');
  return { [META_APPROVAL_ID]: id };
}

/** A JSON-RPC message from a JSON or single-event SSE response. */
function parseRpc(text: string, contentType: string | null): any {
  if (/text\/event-stream/i.test(contentType ?? '')) {
    const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (let i = data.length - 1; i >= 0; i--) {
      try {
        const m = JSON.parse(data[i]);
        if (m && (m.result !== undefined || m.error !== undefined)) return m;
      } catch {
        // keep looking
      }
    }
    return null;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** JSON-RPC errors from the proxy, as typed SDK errors. */
function rpcError(e: any): ImmiscibleError {
  if (e?.code === -32003) {
    const d = e.data ?? {};
    return new ImmiscibleDeniedError({
      id: d.actionId ?? null,
      decision: 'deny',
      reasons: Array.isArray(d.reasons) && d.reasons.length ? d.reasons : [e.message],
      risk: { score: 0, signals: Array.isArray(d.signals) ? d.signals : [] },
      mandateId: null,
    } as Decision);
  }
  const types: Record<number, string> = { [-32001]: 'unauthorized', [-32002]: 'upstream_error', [-32004]: 'unknown_upstream', [-32005]: 'rate_limited', [-32006]: 'already_forwarded', [-32602]: 'invalid_params' };
  const err = new ImmiscibleError(e?.message ?? 'MCP proxy error', { type: types[e?.code] ?? 'mcp_error', body: e ?? null }) as ImmiscibleError & { code: number | null };
  err.code = e?.code ?? null;
  return err;
}

export class McpProxy {
  readonly client: Immiscible;
  readonly upstreamId: string;
  readonly url: string;
  /** The proxy's own session (Mcp-Session-Id). Tool output seen in it counts as observed provenance. */
  sessionId: string | null = null;
  serverInfo: unknown = null;
  autoInitialize: boolean;
  #id = 0;

  constructor(client: Immiscible, upstreamId: string, opts: { autoInitialize?: boolean } = {}) {
    this.client = client;
    this.upstreamId = upstreamId;
    this.url = mcpProxyUrl(client.baseUrl, upstreamId);
    this.autoInitialize = opts.autoInitialize ?? true;
  }

  /** One JSON-RPC request. Returns the whole message ({ result } or { error }). */
  async rpc(method: string, params: object = {}, opts: { signal?: AbortSignal } = {}): Promise<any> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.client.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL,
      traceparent: this.client.context.traceparent(),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
    let res: Response;
    let text: string;
    try {
      res = await this.client.rawFetch(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }), signal: opts.signal });
      text = await res.text();
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      throw new ImmiscibleError(`could not reach the Immiscible MCP proxy at ${this.url}: ${(err as Error)?.message ?? err}`, { type: 'network_error', cause: err });
    }
    const sid = res.headers?.get?.('mcp-session-id');
    if (sid) this.sessionId = sid;
    this.client.context.observe(res.headers);
    const msg = parseRpc(text, res.headers?.get?.('content-type') ?? null);
    if (!msg) throw new ImmiscibleError(`the MCP proxy answered ${res.status} with no JSON-RPC message`, { status: res.status, type: 'mcp_protocol_error', body: text.slice(0, 500) });
    return msg;
  }

  /** Open a proxy session. Called for you before the first tools call. */
  async initialize(opts: { signal?: AbortSignal } = {}): Promise<any> {
    const msg = await this.rpc('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: '@immiscible/sdk', version: '0.1.0' } }, opts);
    if (msg.error) throw rpcError(msg.error);
    this.serverInfo = msg.result?.serverInfo ?? null;
    return msg.result;
  }

  async #ready(signal?: AbortSignal): Promise<void> {
    if (this.autoInitialize && !this.sessionId) await this.initialize({ signal });
  }

  /** The tools this agent may see: allowed for the workspace and coverable by its mandates. */
  async listTools(opts: { cursor?: string; signal?: AbortSignal } = {}): Promise<any> {
    await this.#ready(opts.signal);
    const msg = await this.rpc('tools/list', opts.cursor ? { cursor: opts.cursor } : {}, opts);
    if (msg.error) throw rpcError(msg.error);
    return msg.result;
  }

  /** Call a tool through the gate. Returns the upstream's result when allowed. */
  async call(name: string, args: object = {}, opts: { idempotencyKey?: string; approvalId?: string; signal?: AbortSignal } = {}): Promise<any> {
    await this.#ready(opts.signal);
    const meta: Record<string, string> = {
      ...(opts.idempotencyKey ? { [META_IDEMPOTENCY_KEY]: opts.idempotencyKey } : {}),
      ...(opts.approvalId ? { [META_APPROVAL_ID]: opts.approvalId } : {}),
    };
    const msg = await this.rpc('tools/call', { name, arguments: args, ...(Object.keys(meta).length ? { _meta: meta } : {}) }, opts);
    if (msg.error) throw rpcError(msg.error);
    const pending = approvalFromResult(msg.result);
    if (pending) {
      throw new ImmiscibleApprovalRequiredError({ id: pending.actionId, decision: 'approval_required', reasons: pending.reasons, approval: pending.approval ?? undefined, risk: { score: 0, signals: [] } } as Decision);
    }
    return msg.result;
  }

  /** Call again after a person approved: the proxy forwards the original call exactly once. */
  async retryAfterApproval(name: string, args: object, approval: Parameters<typeof approvalMeta>[0], opts: { signal?: AbortSignal } = {}): Promise<any> {
    return this.call(name, args, { approvalId: approvalMeta(approval)[META_APPROVAL_ID], signal: opts.signal });
  }

  /** Call; if a person must approve, wait for them and call again. */
  async callWithApproval(name: string, args: object = {}, opts: WaitOptions & { idempotencyKey?: string; onApprovalRequired?: (d: Decision) => void | Promise<void> } = {}): Promise<any> {
    try {
      return await this.call(name, args, opts);
    } catch (err) {
      if (!(err instanceof ImmiscibleApprovalRequiredError)) throw err;
      await opts.onApprovalRequired?.(err.decision);
      const final = await this.client.waitForDecision(err.actionId as string, opts);
      if (final.decision !== 'allow') throw new ImmiscibleDeniedError(final);
      return this.retryAfterApproval(name, args, err, opts);
    }
  }
}
