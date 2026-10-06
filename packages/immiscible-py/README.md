# immiscible

Govern what your AI agents spend, share and do, from Python. Before a tool runs, the agent asks Immiscible; Immiscible checks the mandates a person wrote, asks that person when it should, and hands back a signed receipt.
Spend control, approvals and TokenOps for the OpenAI Agents SDK, LangChain, LangGraph and MCP.
Standard library only: urllib, json, hashlib and a pure-Python Ed25519 verifier. Python 3.9+. Type hints throughout (`py.typed`). Fails closed.

```shell
pip install immiscible
```

```python
from immiscible import Immiscible, tool_action

immiscible = Immiscible()                        # IMMISCIBLE_AGENT_KEY, IMMISCIBLE_URL
run = immiscible.run()                           # one trace and one session per task

with run.guard(tool_action("deploy", {"service": "api"}, domain="mycompany.com")):
    deploy()
```

`guard` asks, waits for a person if one is asked, runs your block only if allowed, and settles `completed` (or `failed` if it raised). A refusal raises `ImmiscibleDeniedError` with plain-English `reasons`; your block never ran. As a decorator it takes a function that maps the call to an action, and works on `async def` too.

Set up a project in one command with `npx immiscible init` (it writes `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` to `.env`). Quickstart: [immiscible.fly.dev/docs/quickstart](https://immiscible.fly.dev/docs/quickstart). Answers to common questions: [immiscible.fly.dev/docs/answers](https://immiscible.fly.dev/docs/answers). SDKs: [immiscible.fly.dev/docs/sdks](https://immiscible.fly.dev/docs/sdks). API: [immiscible.fly.dev/docs/api](https://immiscible.fly.dev/docs/api). JavaScript: [`@immiscible/sdk` on npm](https://www.npmjs.com/package/@immiscible/sdk). MIT licence.

## The client

| Call | Does |
|---|---|
| `Immiscible(api_key, base_url, timeout=30, max_retries=2, session_id=, traceparent=)` | Defaults from `IMMISCIBLE_AGENT_KEY` and `IMMISCIBLE_URL` (or `ASSAY_AGENT_KEY`, `ASSAY_URL`), then `https://immiscible.fly.dev`, the hosted service (set `IMMISCIBLE_URL` for your own server). |
| `immiscible.run(session_id=None, client="custom", traceparent=None)` | A client for a new run. |
| `authorize(action, idempotency_key=None)` | Ask. Returns a `Decision` (a dict with `.allowed`, `.receipt`, `.reasons`, `.approval_url`, ...). |
| `wait_for_decision(id, timeout=600, initial_delay=0.5, max_delay=8, factor=1.6, cancel=None, on_poll=None)` | Poll with backoff and jitter. `cancel` is a `threading.Event`. |
| `decide(action, ...)` | Authorize and wait; returns an allow or raises a refusal. |
| `settle(id, status="completed", amount=None)` | Record what happened. |
| `guard(action_or_mapper, wait=True, on_approval_required=None, settle=True, settle_amount=None, ...)` | All of it: `with` block or decorator. |
| `pay(...)`, `request_data(...)`, `Immiscible.payment_action(...)`, `Immiscible.data_action(...)`, `tool_action(...)` | Build and send actions. |
| `outcome(task_id, status)` | TokenOps. |
| `mcp_proxy(upstream_id)` | MCP proxy client: `list_tools`, `call`, `call_with_approval`, `retry_after_approval`. |
| `gateway.openai()`, `gateway.anthropic()`, `gateway.openai_client()`, `gateway.anthropic_client()`, `gateway.env()` | Model SDKs through the gateway, inside the run. |
| `context` | The run: `trace_id`, `session_id`, `headers()`, `traceparent()`, `httpx_event_hooks()`, `last_server_traceparent`. |

## Errors

Everything the SDK raises on purpose is an `ImmiscibleError`, with `status`, `type`, `body` and `request_id` (quote it when asking for help). HTTP failures use a subclass by status: `ImmiscibleAuthenticationError` (401), `ImmiscibleInvalidRequestError` (400 or 422, with `errors` per field), `ImmiscibleRateLimitError` (429, with `retry_after` in seconds), `ImmiscibleIdempotencyConflictError` (409, the same key with a different body) and `ImmiscibleConnectionError` (unreachable or timed out). Refusals are `ImmiscibleDeniedError`, `ImmiscibleApprovalRequiredError` and `ImmiscibleApprovalTimeoutError`.

## Integrations

```python
from immiscible.integrations import guard_tools, guard_langchain_tools, guarded
```

| | |
|---|---|
| `guard_tools(tools, client=, map_to_action=)` | OpenAI Agents SDK function tools |
| `guard_langchain_tools(tools, client=, map_to_action=)` | LangChain tools, for `ToolNode`, `bind_tools`, `create_react_agent` |
| `@guarded(map_to_action, client=)` | any function a framework turns into a tool; signature and docstring kept |

Setups for each framework: [immiscible.fly.dev/docs/sdks](https://immiscible.fly.dev/docs/sdks).

## Receipts

```python
from immiscible import fetch_jwks, verify_receipt

jwks = fetch_jwks("https://immiscible.example")                  # pin: fetch once, store with your config
r = verify_receipt(token, "https://immiscible.example", jwks=jwks, online=True,
                   expect={"amount": 6420, "currency": "GBP", "merchant": "ocado.com"})
```

The same checks as the TypeScript SDK, with a pure-Python Ed25519 verifier checked against RFC 8032 and against Node's signatures.

## Testing

```shell
python3 -m unittest discover -s tests -t .
```

`immiscible.testing.start_fake()` is a stdlib fake server (real Ed25519 receipts, a fake gateway and model, the MCP proxy, a person's approvals) for your own tests. `tests/test_frameworks.py` runs against the real `openai`, `openai-agents`, `langchain-core` and `langgraph` when they are installed; `tests/test_cross_language.py` runs against the TypeScript SDK's fake when Node is available.

## Crypto payments: decide, then sign

Immiscible never holds keys or signs. `decide_then_sign` asks first and calls your wallet only after an allow whose signed receipt covers the exact transfer; `x402_request` does the same for HTTP 402 (x402 v1 and v2) resources.

```python
from immiscible import Immiscible
from immiscible.crypto import decide_then_sign, x402_request

decide_then_sign(Immiscible(), {"asset": "USDC", "network": "base", "amount": "12.50", "recipient": "0x..."},
                 lambda decision: {"txHash": wallet.send()})
status, headers, body = x402_request(Immiscible(), "https://api.example.com/report", pay=my_x402_signer)
```

Amounts are decimal strings, never floats. See [crypto payments](https://immiscible.fly.dev/docs/guides/crypto-payments) and [x402](https://immiscible.fly.dev/docs/guides/x402).
