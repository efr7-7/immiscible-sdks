# @immiscible/sdk

Govern what your AI agents spend, share and do. Before a tool runs, the agent asks Immiscible; Immiscible checks the mandates a person wrote, asks that person when it should, and hands back a signed receipt.
Spend control, approvals and TokenOps for OpenAI, Anthropic, the Vercel AI SDK, LangChain and MCP.
Zero runtime dependencies. ESM and CommonJS, with type declarations. Node 18+, Deno, Bun, browsers and edge runtimes. Fails closed.

```shell
npm install @immiscible/sdk
```

```ts
import { Immiscible, toolAction } from '@immiscible/sdk';

const immiscible = new Immiscible();             // IMMISCIBLE_AGENT_KEY, IMMISCIBLE_URL
const run = immiscible.run();                    // one trace and one session per task

await run.guard(toolAction('deploy', { service: 'api' }, { domain: 'mycompany.com' }), () => deploy());
```

`guard` asks, waits for a person if one is asked, runs your function only if allowed, and settles `completed` (or `failed` if it threw). A refusal throws `ImmiscibleDeniedError` with plain-English `reasons`; your function never ran.

Set up a project in one command with `npx immiscible init` (it writes `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` to `.env`). Quickstart: [immiscible.fly.dev/docs/quickstart](https://immiscible.fly.dev/docs/quickstart). Answers to common questions: [immiscible.fly.dev/docs/answers](https://immiscible.fly.dev/docs/answers). SDKs: [immiscible.fly.dev/docs/sdks](https://immiscible.fly.dev/docs/sdks). API: [immiscible.fly.dev/docs/api](https://immiscible.fly.dev/docs/api). Python: [`immiscible` on PyPI](https://pypi.org/project/immiscible/). Claude Code: [`@immiscible/claude-code-hook`](https://www.npmjs.com/package/@immiscible/claude-code-hook). MIT licence.

## Entry points

| Import | |
|---|---|
| `@immiscible/sdk` | `Immiscible`, `RunContext`, errors, `verifyReceipt`, `fetchJwks`, MCP proxy client, helpers |
| `@immiscible/sdk/openai-agents` | `guardOpenAITool`, `guardOpenAITools`, `openaiToolGuardrail` |
| `@immiscible/sdk/langchain` | `guardLangChainTool`, `guardLangChainTools` |
| `@immiscible/sdk/ai` | `guardAiTool`, `guardAiTools`, `immiscibleMiddleware` (Vercel AI SDK) |
| `@immiscible/sdk/integrations` | all of the above |
| `@immiscible/sdk/verify` | receipt verification only, for merchants |
| `@immiscible/sdk/testing` | `startFakeImmiscible()`: a fake server for your tests (Node only) |

## The client

| Call | Does |
|---|---|
| `new Immiscible({ apiKey, baseUrl, timeoutMs, maxRetries, fetch, sessionId, traceparent })` | Defaults from `IMMISCIBLE_AGENT_KEY` and `IMMISCIBLE_URL` (or `ASSAY_AGENT_KEY`, `ASSAY_URL`), then `https://immiscible.fly.dev`, the hosted service (set `IMMISCIBLE_URL` for your own server). |
| `immiscible.run({ sessionId, traceparent, client })` | A client for a new run: a fresh trace (or yours continued) and a fresh session. |
| `authorize(action, { idempotencyKey, signal })` | Ask. A deny is a result, not an exception. The idempotency key goes in the body and the `Idempotency-Key` header and is reused on retries. |
| `waitForDecision(id, { timeoutMs, initialDelayMs, maxDelayMs, factor, signal, onPoll })` | Poll with backoff and jitter until a person answers. Throws `ImmiscibleApprovalTimeoutError`, or the signal's reason on abort. |
| `decide(action, opts)` | Authorize and wait; returns an allow or throws a refusal. |
| `settle(id, { status, amount })` | Record what happened. Retried; a retry that finds the action settled returns it. |
| `guard(action, fn, opts)` | All of it. Options: `wait`, `onApprovalRequired`, the wait options, `settle`, `settleAmount(result)`, `onSettleError`. |
| `pay(req, fn?)`, `requestData(req, fn?)` | Payment and data-release actions, built and checked; with a function, `guard`. |
| `Immiscible.paymentAction(req)`, `Immiscible.dataAction(req)`, `toolAction(name, args, opts)` | Build actions. |
| `outcome(taskId, status)` | TokenOps: how a task ended. |
| `mcpProxy(upstreamId)` | MCP proxy client: `listTools`, `call`, `callWithApproval`, `retryAfterApproval`. |
| `gateway.openai()`, `gateway.anthropic()`, `gateway.aiSdkOpenAI()`, `gateway.aiSdkAnthropic()`, `gateway.env()` | Point model SDKs at the gateway, inside the run. |
| `context` | The run: `traceId`, `sessionId`, `headers()`, `traceparent()`, `wrapFetch(fetch)`, `lastServerTraceparent`. |

## Errors

Everything the SDK throws on purpose is an `ImmiscibleError`, with `status`, `type`, `body` and `requestId` (quote it when asking for help). HTTP failures use a subclass by status: `ImmiscibleAuthenticationError` (401), `ImmiscibleInvalidRequestError` (400 or 422, with `errors[]` per field), `ImmiscibleRateLimitError` (429, with `retryAfter` in seconds), `ImmiscibleIdempotencyConflictError` (409, the same key with a different body) and `ImmiscibleConnectionError` (unreachable or timed out). Refusals are `ImmiscibleDeniedError`, `ImmiscibleApprovalRequiredError` and `ImmiscibleApprovalTimeoutError`.

## Receipts

```ts
import { verifyReceipt, fetchJwks } from '@immiscible/sdk/verify';

const jwks = await fetchJwks('https://immiscible.example');            // pin: fetch once, store with your config
const r = await verifyReceipt(token, { jwks, issuer: 'https://immiscible.example', online: true,
  expect: { amount: 6420, currency: 'GBP', merchant: 'ocado.com' } });
```

Offline checks use WebCrypto Ed25519 against pinned keys (nothing fetched) or the issuer's key set (fetched once, cached, refetched for an unknown key id). `alg` must be EdDSA, `typ` the receipt type, `kid` a published key; `exp`, `iat` and `nbf` are checked with 60 seconds of skew; `expect` binds the receipt to your order. `online: true` also calls `POST /v1/verify`, which marks the receipt used: a second check reports `replayed`. A bad receipt never throws: `valid: false` with a stable `reason` and a plain-English `message`.

## Building and testing

The source is TypeScript in `src/`; `dist/esm` and `dist/cjs` are built from it with declarations. TypeScript is a dev dependency only.

```shell
npm install          # typescript and @types/node, for the build
npm run build        # dist/esm and dist/cjs
npm test             # node --test: unit tests on the fake, the CommonJS build, and the real server
```

| Test | Covers |
|---|---|
| `test/client.test.mjs` | authorize, idempotency, retries (503 and lost answers), fail closed, waitForDecision backoff, timeout and abort, guard, settle, helpers |
| `test/trace.test.mjs` | traceparent, runs, issued and chosen sessions, wrapFetch, provenance mismatch across a run |
| `test/verify.test.mjs` | offline with fetched and pinned keys, online single use, forgeries |
| `test/gateway.test.mjs`, `test/proxy.test.mjs` | gateway option shapes; the MCP proxy approval dance |
| `test/integrations.test.mjs` | OpenAI Agents, LangChain and Vercel AI integrations on duck-typed tools |
| `test/cjs.test.cjs` | the CommonJS build |
| `test/integration.test.mjs` | the real server from `src/server/app.js`, in-process (inside the repository only) |
| `test/frameworks.test.mjs` | the real `openai`, `@anthropic-ai/sdk`, `@openai/agents`, `ai`, `@ai-sdk/openai`, `@langchain/*` packages, when `IMMISCIBLE_FRAMEWORKS_DIR` points at a folder where they are installed |

Examples in `examples/` run against the fake with `--demo`.

## Crypto payments: decide, then sign

Immiscible never holds keys or signs. `decideThenSign` asks first and calls your wallet only after an allow whose signed receipt covers the exact transfer; `x402Fetch` does the same for HTTP 402 (x402 v1 and v2) resources.

```ts
import { Immiscible, decideThenSign, x402Fetch } from '@immiscible/sdk';

await decideThenSign(new Immiscible(), { asset: 'USDC', network: 'base', amount: '12.50', recipient: '0x…' },
  async () => ({ txHash: await wallet.send() }));

const pay = x402Fetch(new Immiscible(), { pay: ({ requirements }) => myX402Signer(requirements) });
await pay('https://api.example.com/report');
```

Amounts are decimal strings, never numbers. See [crypto payments](https://immiscible.fly.dev/docs/guides/crypto-payments) and [x402](https://immiscible.fly.dev/docs/guides/x402).
