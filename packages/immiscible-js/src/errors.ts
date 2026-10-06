/**
 * Typed errors. Everything the SDK throws on purpose is an ImmiscibleError,
 * so one `instanceof` check catches them all; the subclasses carry what you
 * need to explain a refusal to a person.
 */

import type { Decision } from './types.js';

export interface ImmiscibleErrorInfo {
  status?: number | null;
  type?: string;
  body?: unknown;
  cause?: unknown;
  traceparent?: string | null;
}

export class ImmiscibleError extends Error {
  /** HTTP status, when the error came from the server. */
  status: number | null;
  /** Machine-readable type, for example `invalid_api_key`, `network_error` or `denied`. */
  type: string;
  /** The parsed response body, when there was one. */
  body: unknown;
  /** The server's traceparent for the failed call, to find it in the evidence ledger. */
  traceparent: string | null;

  constructor(message: string, info: ImmiscibleErrorInfo = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'ImmiscibleError';
    this.status = info.status ?? null;
    this.type = info.type ?? 'immiscible_error';
    this.body = info.body ?? null;
    this.traceparent = info.traceparent ?? null;
  }
}

/** Immiscible said no. `reasons` are plain English; `signals` are the risk signals that fired. */
export class ImmiscibleDeniedError extends ImmiscibleError {
  decision: Decision;
  actionId: string | null;
  reasons: string[];
  signals: Array<{ id: string; severity?: string; detail?: string }>;

  constructor(decision: Decision) {
    const reasons = Array.isArray(decision?.reasons) ? decision.reasons : [];
    super(`Immiscible denied ${decision?.id ?? 'the action'}: ${reasons.join('; ') || 'no reason given'}`, { type: 'denied', body: decision });
    this.name = 'ImmiscibleDeniedError';
    this.decision = decision;
    this.actionId = decision?.id ?? null;
    this.reasons = reasons;
    this.signals = decision?.risk?.signals ?? [];
  }
}

/** A person was asked and did not answer in time on this side. The approval may still be open. */
export class ImmiscibleApprovalTimeoutError extends ImmiscibleError {
  actionId: string;
  timeoutMs: number;
  decision: Decision | null;
  approval: Decision['approval'] | null;

  constructor(actionId: string, info: { timeoutMs: number; decision?: Decision | null }) {
    const url = info.decision?.approval?.url;
    super(`no answer to the approval for ${actionId} within ${Math.round(info.timeoutMs / 1000)}s${url ? `; it is waiting at ${url}` : ''}`, {
      type: 'approval_timeout',
      body: info.decision ?? null,
    });
    this.name = 'ImmiscibleApprovalTimeoutError';
    this.actionId = actionId;
    this.timeoutMs = info.timeoutMs;
    this.decision = info.decision ?? null;
    this.approval = info.decision?.approval ?? null;
  }
}

/** Thrown when a person has to approve first and you asked not to wait (`wait: false`). */
export class ImmiscibleApprovalRequiredError extends ImmiscibleError {
  decision: Decision;
  actionId: string | null;
  approval: Decision['approval'] | null;

  constructor(decision: Decision) {
    super(`a person must approve ${decision?.id ?? 'this action'}${decision?.approval?.url ? ` at ${decision.approval.url}` : ''}`, {
      type: 'approval_required',
      body: decision,
    });
    this.name = 'ImmiscibleApprovalRequiredError';
    this.decision = decision;
    this.actionId = decision?.id ?? null;
    this.approval = decision?.approval ?? null;
  }
}

/** True for the three errors that mean "do not go ahead": denied, still waiting, or timed out. */
export function isRefusal(err: unknown): err is ImmiscibleDeniedError | ImmiscibleApprovalRequiredError | ImmiscibleApprovalTimeoutError {
  return err instanceof ImmiscibleDeniedError || err instanceof ImmiscibleApprovalRequiredError || err instanceof ImmiscibleApprovalTimeoutError;
}
