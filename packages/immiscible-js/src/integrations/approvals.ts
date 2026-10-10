/**
 * Framework approval adapters: when a framework stops a run to ask a person
 * about a tool call, Immiscible answers it. The framework's own pause stays
 * in charge of the run; Immiscible decides, routing to a named person on
 * Slack, Teams, email or the phone when its rules ask for one, and records
 * the decision.
 *
 *   OpenAI Agents SDK      resolveInterruptions(result)  -> approve or reject each RunToolApprovalItem,
 *                          then run(agent, result.state) to go on
 *   LangChain v1           hitlDecisions(interrupt)      -> { decisions } for the HumanInTheLoopMiddleware,
 *                          then new Command({ resume }) to go on
 *
 * Duck-typed against the shapes in the frameworks' documentation
 * (openai-agents-js guides/human-in-the-loop, docs.langchain.com
 * human-in-the-loop), so nothing is imported and any recent version works.
 */

import { isRefusal } from '../errors.js';
import type { Decision, WaitOptions } from '../types.js';
import { clientOf, defaultMapToAction, parseArgs, type MapToAction } from './core.js';
import type { Immiscible } from '../client.js';

export interface ApprovalAdapterOptions {
  client?: Immiscible;
  /** Default: every call is a `tool.call` action named after the tool. */
  mapToAction?: MapToAction;
  /** How long to wait for a person when Immiscible asks one. Default ten minutes. */
  wait?: WaitOptions;
}

/** One call a framework paused on, and what Immiscible decided about it. */
export interface ResolvedCall {
  name: string;
  args: unknown;
  decision: 'allow' | 'deny';
  /** The Immiscible decision, when one was asked for (null: the mapping said no check was needed). */
  immiscible: Decision | null;
  reason: string;
}

async function decideCall(name: string, args: unknown, callId: string | null, opts: ApprovalAdapterOptions): Promise<ResolvedCall> {
  const map = opts.mapToAction ?? defaultMapToAction;
  const action = await map({ name, args, callId });
  if (action == null) return { name, args, decision: 'allow', immiscible: null, reason: 'no check needed for this call' };
  const client = clientOf(opts);
  let d = await client.authorize(action, callId ? { idempotencyKey: action.idempotencyKey ?? `tool_${callId.slice(0, 120)}` } : {});
  if (d.decision === 'approval_required') {
    try {
      d = await client.waitForDecision(d.id, opts.wait ?? {});
    } catch (err) {
      if (!isRefusal(err)) throw err;
      return { name, args, decision: 'deny', immiscible: d, reason: `Immiscible: nobody approved this in time${d.approval?.url ? ` (${d.approval.url})` : ''}.` };
    }
  }
  const reasons = (d.reasons ?? []).map((r) => String(r).trim().replace(/[.\s]+$/, '')).filter(Boolean).join('; ');
  return d.decision === 'allow'
    ? { name, args, decision: 'allow', immiscible: d, reason: reasons || 'allowed' }
    : { name, args, decision: 'deny', immiscible: d, reason: `Immiscible refused this action: ${reasons || 'no reason given'}. Do not try it another way.` };
}

// ------------------------------------------------------- OpenAI Agents SDK

/** The part of a RunToolApprovalItem this needs. */
export interface ToolApprovalItemLike {
  type?: string;
  name?: string;
  toolName?: string;
  arguments?: string;
  rawItem?: { name?: string; arguments?: string; callId?: string; id?: string };
}
/** The part of a RunResult this needs. */
export interface InterruptedResultLike {
  interruptions?: ToolApprovalItemLike[];
  state: {
    approve: (item: any, options?: { alwaysApprove?: boolean }) => void;
    reject: (item: any, options?: { alwaysReject?: boolean; message?: string }) => void;
  };
}

/**
 * Answer every pending approval in an OpenAI Agents SDK run with
 * Immiscible's decision, on `result.state`. Resume with
 * `run(agent, result.state)`. Returns what was decided, call by call.
 *
 *   let result = await run(agent, 'Pay the invoice');
 *   while (result.interruptions?.length) {
 *     await resolveInterruptions(result, { client: immiscible });
 *     result = await run(agent, result.state);
 *   }
 */
export async function resolveInterruptions(result: InterruptedResultLike, opts: ApprovalAdapterOptions = {}): Promise<ResolvedCall[]> {
  if (!result || !result.state || typeof result.state.approve !== 'function') throw new TypeError('resolveInterruptions: expected a run result with interruptions and state');
  const out: ResolvedCall[] = [];
  for (const item of result.interruptions ?? []) {
    if (item?.type && item.type !== 'tool_approval_item') continue;
    const name = item.name ?? item.toolName ?? item.rawItem?.name ?? 'tool';
    const args = parseArgs(item.arguments ?? item.rawItem?.arguments ?? '{}');
    const r = await decideCall(name, args, item.rawItem?.callId ?? item.rawItem?.id ?? null, opts);
    if (r.decision === 'allow') result.state.approve(item);
    else result.state.reject(item, { message: r.reason });
    out.push(r);
  }
  return out;
}

// ------------------------------------------------------- LangChain v1

/** The HumanInTheLoopMiddleware's interrupt value (JS camelCase or Python snake_case). */
export interface HitlRequestLike {
  actionRequests?: { name: string; arguments?: unknown; args?: unknown }[];
  action_requests?: { name: string; arguments?: unknown; args?: unknown }[];
}

/**
 * The resume value for LangChain's HumanInTheLoopMiddleware, decided by
 * Immiscible: `{ decisions: [{ type: 'approve' } | { type: 'reject', message }] }`,
 * in the same order as the interrupt's action requests. Pass it as
 * `new Command({ resume })` with the same thread id. Accepts the interrupt
 * value itself, or an interrupt object carrying it in `value`.
 */
export async function hitlDecisions(interrupt: HitlRequestLike | { value: HitlRequestLike }, opts: ApprovalAdapterOptions = {}): Promise<{ decisions: ({ type: 'approve' } | { type: 'reject'; message: string })[] }> {
  const v = (interrupt as { value?: HitlRequestLike })?.value ?? (interrupt as HitlRequestLike);
  const requests = v?.actionRequests ?? v?.action_requests;
  if (!Array.isArray(requests)) throw new TypeError('hitlDecisions: expected the HumanInTheLoopMiddleware interrupt, with actionRequests');
  const decisions = [];
  for (const req of requests) {
    const r = await decideCall(req.name, parseArgs(req.arguments ?? req.args ?? {}), null, opts);
    decisions.push(r.decision === 'allow' ? { type: 'approve' as const } : { type: 'reject' as const, message: r.reason });
  }
  return { decisions };
}
