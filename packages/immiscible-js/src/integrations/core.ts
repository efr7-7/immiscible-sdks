/**
 * What every framework integration shares: turn a tool call into an action,
 * run the tool only if Immiscible allows it, settle afterwards, and give the
 * model a refusal it will not argue with.
 *
 * None of the integrations imports its framework. They are duck-typed
 * against the shapes those frameworks hand a tool, so they work with the
 * version you already have installed and add nothing to your bundle.
 */

import { Immiscible, toolAction } from '../client.js';
import { isRefusal } from '../errors.js';
import type { Action, Decision, GuardOptions } from '../types.js';

export interface ToolCallInfo {
  /** The tool's name. */
  name: string;
  /** Parsed arguments (JSON strings are parsed for you). */
  args: any;
  /** The framework's id for this call, when it has one. Used as the idempotency key. */
  callId?: string | null;
  /** Whatever the framework passed alongside (run context, config, options). */
  context?: unknown;
}

/** Turn a tool call into an action. Return null for calls that need no check (a read-only lookup). */
export type MapToAction = (call: ToolCallInfo) => Action | null | undefined | Promise<Action | null | undefined>;

export interface IntegrationOptions extends Omit<GuardOptions<unknown>, 'settleAmount'> {
  /** Default: a client built from IMMISCIBLE_AGENT_KEY and IMMISCIBLE_URL. */
  client?: Immiscible;
  /** Default: every call is a `tool.call` action named after the tool. */
  mapToAction?: MapToAction;
  /** `message` (default): a refusal goes back to the model as text. `throw`: the typed error propagates. */
  onDeny?: 'message' | 'throw';
  /** Your own refusal text. */
  refusal?: (err: unknown) => string;
  /** What was actually spent, from the tool's result. */
  settleAmount?: (result: unknown, d: Decision) => number | null | undefined;
}

let fallback: Immiscible | undefined;

/** The client an integration uses: yours, or one from the environment. */
export function clientOf(opts?: { client?: Immiscible }): Immiscible {
  if (opts?.client) return opts.client;
  fallback ??= new Immiscible();
  return fallback;
}

/** The default mapping: every tool call is a `tool.call` action. */
export const defaultMapToAction: MapToAction = ({ name, args, callId }) =>
  toolAction(name, args, callId ? { idempotencyKey: `tool_${String(callId).slice(0, 120)}` } : {});

/** What the model reads when Immiscible says no. Written to stop retries, not invite them. */
export function refusalMessage(err: unknown): string {
  const e = err as { type?: string; decision?: Decision; approval?: { url?: string } | null };
  if (e?.type === 'approval_required' || e?.type === 'approval_timeout') {
    const url = e.approval?.url ?? e.decision?.approval?.url;
    return `Immiscible: this action is waiting for the person to approve it${url ? ` (${url})` : ''}. Do not proceed and do not try it another way. Tell the person it needs their approval.`;
  }
  // Reasons arrive as sentences; the full stop is added once, here.
  const reasons = (e?.decision?.reasons ?? []).map((r) => String(r).trim().replace(/[.\s]+$/, '')).filter(Boolean).join('; ') || 'no reason given';
  return `Immiscible refused this action: ${reasons}. Do not proceed and do not try it another way. Tell the person what was refused and why.`;
}

/** Parse a JSON argument string; leave anything else alone. */
export function parseArgs(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return input ? JSON.parse(input) : {};
  } catch {
    return input;
  }
}

/** Run `run` behind the gate: authorize, wait, run, settle. Returns the tool's result or a refusal message. */
export async function gated<T>(call: ToolCallInfo, run: (d: Decision | null) => T | Promise<T>, opts: IntegrationOptions): Promise<T | string> {
  const map = opts.mapToAction ?? defaultMapToAction;
  const action = await map(call);
  if (action == null) return run(null);
  const client = clientOf(opts);
  // The framework's call id makes a retried tool call the same action, whoever built the action.
  const idempotencyKey = action.idempotencyKey ?? opts.idempotencyKey ?? (call.callId ? `tool_${String(call.callId).slice(0, 120)}` : undefined);
  try {
    return await client.guard(action, run, { ...(opts as GuardOptions<T>), idempotencyKey });
  } catch (err) {
    if (isRefusal(err) && opts.onDeny !== 'throw') return opts.refusal ? opts.refusal(err) : refusalMessage(err);
    throw err;
  }
}

/** A copy of `obj` with the same prototype and every own property (including symbols and getters). */
export function cloneWith<T extends object>(obj: T, overrides: Record<string, unknown>): T {
  const copy = Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));
  for (const [k, v] of Object.entries(overrides)) Object.defineProperty(copy, k, { value: v, writable: true, configurable: true, enumerable: true });
  return copy;
}
