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
  requestId?: string | null;
}

/** One problem with one field of a request, as the server reports it in `error.errors[]`. */
export interface FieldError {
  field?: string;
  message?: string;
  [key: string]: unknown;
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
  /** The server's x-request-id: quote it when asking for help with a request. */
  requestId: string | null;

  constructor(message: string, info: ImmiscibleErrorInfo = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'ImmiscibleError';
    this.status = info.status ?? null;
    this.type = info.type ?? 'immiscible_error';
    this.body = info.body ?? null;
    this.traceparent = info.traceparent ?? null;
    this.requestId = info.requestId ?? null;
  }
}

/** 401: the key is missing, unknown or revoked. */
export class ImmiscibleAuthenticationError extends ImmiscibleError {
  constructor(message: string, info: ImmiscibleErrorInfo = {}) {
    super(message, info);
    this.name = 'ImmiscibleAuthenticationError';
  }
}

/** 400 or 422: the request was malformed. `errors` names each field that was wrong. */
export class ImmiscibleInvalidRequestError extends ImmiscibleError {
  errors: FieldError[];
  constructor(message: string, info: ImmiscibleErrorInfo = {}) {
    super(message, info);
    this.name = 'ImmiscibleInvalidRequestError';
    const list = (info.body as any)?.error?.errors;
    this.errors = Array.isArray(list) ? list : [];
  }
}

/** 429: too many requests. `retryAfter` is in seconds, when the server said. */
export class ImmiscibleRateLimitError extends ImmiscibleError {
  retryAfter: number | null;
  constructor(message: string, info: ImmiscibleErrorInfo & { retryAfter?: number | null } = {}) {
    super(message, info);
    this.name = 'ImmiscibleRateLimitError';
    this.retryAfter = info.retryAfter ?? null;
  }
}

/** 409 idempotency_conflict: the same idempotency key was sent with a different body. */
export class ImmiscibleIdempotencyConflictError extends ImmiscibleError {
  constructor(message: string, info: ImmiscibleErrorInfo = {}) {
    super(message, info);
    this.name = 'ImmiscibleIdempotencyConflictError';
  }
}

/** The server could not be reached, or did not answer in time. */
export class ImmiscibleConnectionError extends ImmiscibleError {
  constructor(message: string, info: ImmiscibleErrorInfo = {}) {
    super(message, info);
    this.name = 'ImmiscibleConnectionError';
  }
}

/** The error class for an HTTP failure, chosen by status and the server's error type. */
export function errorFromResponse(message: string, info: ImmiscibleErrorInfo & { retryAfter?: number | null }): ImmiscibleError {
  const { status, type } = info;
  if (status === 401) return new ImmiscibleAuthenticationError(message, info);
  if (status === 429) return new ImmiscibleRateLimitError(message, info);
  if (status === 409 && type === 'idempotency_conflict') return new ImmiscibleIdempotencyConflictError(message, info);
  if (status === 400 || status === 422) return new ImmiscibleInvalidRequestError(message, info);
  return new ImmiscibleError(message, info);
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
