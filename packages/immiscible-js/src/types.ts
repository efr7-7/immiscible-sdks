/**
 * The wire shapes of the agent API (POST /v1/actions/authorize and friends).
 * Field names are the server's; nothing here is renamed.
 */

export type ActionType = 'payment' | 'data.release' | 'email.send' | 'calendar.write' | 'account.change' | 'tool.call' | (string & {});

export type ProvenanceSource = 'user' | 'agent' | 'web' | 'email' | 'document' | 'tool' | (string & {});

export interface Provenance {
  source: ProvenanceSource;
  detail?: string;
  url?: string;
}

export interface Merchant {
  domain: string;
  name?: string;
  category?: string;
}

export interface SessionRef {
  /** Who chose the id: `custom`, `claude-code`, `openai`, ... */
  client?: string;
  /** 1 to 128 printable characters, no spaces. */
  id: string;
}

export interface Action {
  type: ActionType;
  /** One sentence a person can approve or refuse. */
  summary: string;
  payment?: { amount: number; currency: string; merchant: Merchant };
  data?: { fields: string[]; recipient: string; purpose?: string };
  target?: { domain?: string; recipient?: string; [k: string]: unknown };
  provenance?: Provenance[];
  /** Added for you when missing. Reuse one to make a retry safe. */
  idempotencyKey?: string;
  /** Sent for you from the run when there is one; `null` opts this request out. */
  session?: SessionRef | null;
  [extra: string]: unknown;
}

export interface RiskSignal {
  id: string;
  severity?: 'low' | 'medium' | 'high' | (string & {});
  detail?: string;
  effect?: string;
}

export type DecisionValue = 'allow' | 'deny' | 'approval_required';

export interface Decision {
  id: string;
  decision: DecisionValue;
  /** Server lifecycle: allowed, denied, pending_approval, expired, completed, failed, cancelled, ... */
  status?: string;
  reasons: string[];
  mandateId?: string | null;
  risk?: { score: number; signals: RiskSignal[] };
  /** Compact JWS, only when allowed. Hand it to the merchant or tool that asks for proof. */
  receipt?: string;
  /** True when a person approved this specific action. */
  human?: boolean;
  approval?: { id: string; url: string; expiresAt?: string };
  expiresAt?: string;
  /** data.release only, only when allowed. */
  released?: Record<string, unknown>;
  idempotentReplay?: boolean;
  settlement?: { status: string; amount?: number | null; at?: string; incident?: boolean };
  [extra: string]: unknown;
}

export type SettleStatus = 'completed' | 'failed' | 'cancelled';

export interface WaitOptions {
  /** Give up after this long. Default ten minutes. */
  timeoutMs?: number;
  /** First pause between polls. Default 500 ms. */
  initialDelayMs?: number;
  /** Longest pause between polls. Default 8 s. */
  maxDelayMs?: number;
  /** Each pause is the last one times this. Default 1.6. */
  factor?: number;
  /** Abort the wait (the approval stays open on the server). */
  signal?: AbortSignal;
  /** Called with the pending decision after each poll. */
  onPoll?: (d: Decision) => void | Promise<void>;
}

export interface GuardOptions<T> extends WaitOptions {
  /** Default true. `false` throws ImmiscibleApprovalRequiredError at once instead of waiting. */
  wait?: boolean;
  /** Show the person `decision.approval.url` while you wait. */
  onApprovalRequired?: (d: Decision) => void | Promise<void>;
  /** Default true: settle `completed` (or `failed` if `fn` threw) afterwards. */
  settle?: boolean;
  /** What was actually spent, from the result. Defaults to the authorised amount. */
  settleAmount?: (result: T, d: Decision) => number | null | undefined;
  /** Settlement failures never mask your result; they come here (default: console.warn). */
  onSettleError?: (err: unknown, actionId: string) => void;
  idempotencyKey?: string;
}
