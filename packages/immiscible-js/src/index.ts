/**
 * @immiscible/sdk: the control layer for AI agents, from the agent's side.
 *
 *   import { Immiscible } from '@immiscible/sdk';
 *   const immiscible = new Immiscible();            // IMMISCIBLE_AGENT_KEY, IMMISCIBLE_URL
 *   const run = immiscible.run();                   // one trace and one session per task
 *   await run.guard(action, () => doTheThing());    // authorize, wait, run, settle
 */

export { Immiscible, SDK_VERSION, DEFAULT_BASE_URL, normaliseDomain, newIdempotencyKey, toolAction, sleep } from './client.js';
export type { ImmiscibleOptions, RequestOptions, PaymentRequest, DataRequest, ToolActionOptions } from './client.js';
export { RunContext, parseTraceparent, formatTraceparent, newTraceId, newSpanId, isValidSessionId, SESSION_HEADER, ISSUED_SESSION_HEADER, TRACEPARENT_HEADER } from './trace.js';
export type { RunOptions, TraceParent } from './trace.js';
export { Gateway } from './gateway.js';
export type { GatewayCallOptions, OpenAIClientOptions, AnthropicClientOptions, AiSdkProviderSettings } from './gateway.js';
export { McpProxy, mcpProxyUrl, mcpServerUrl, approvalFromResult, approvalMeta, MCP_PROTOCOL, META_APPROVAL_ID, META_IDEMPOTENCY_KEY } from './proxy.js';
export type { PendingApproval } from './proxy.js';
export {
  ImmiscibleError, ImmiscibleDeniedError, ImmiscibleApprovalTimeoutError, ImmiscibleApprovalRequiredError, isRefusal,
  ImmiscibleAuthenticationError, ImmiscibleInvalidRequestError, ImmiscibleRateLimitError, ImmiscibleIdempotencyConflictError, ImmiscibleConnectionError,
} from './errors.js';
export type { FieldError } from './errors.js';
export { verifyReceipt, verifyOnline, fetchJwks, pinJwks, decodeReceiptUnverified, clearJwksCache, RECEIPT_TYP, JWKS_PATH, REASONS } from './verify.js';
export type { Jwk, Jwks, ReceiptClaims, Expect, VerifyOptions, VerifyResult, VerifyReason } from './verify.js';
export { cryptoAction, decideThenSign, x402Fetch, readPaymentRequired, receiptCovers, fromAtomic, X402_ASSETS } from './crypto.js';
export type { CryptoPayment, DecideThenSignOptions, Signed, X402Options, X402Requirements, X402PaymentRequired } from './crypto.js';
export type * from './types.js';
