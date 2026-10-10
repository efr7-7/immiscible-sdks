# Changelog: immiscible (Python)

## Unreleased

Added

- Every `ImmiscibleError` has `retryable`: whether the same request, sent again unchanged, can succeed. It is the server's `error.retryable` (new on every API error), or for an older server, True for a rate limit, an overload, an outage or no connection.
- Receipt version 2: `verify_receipt` checks `audience`, `cart` and `cart_digest` in `expect` against a receipt's `aud` and `crt` claims (reasons `audience_mismatch` and `cart_mismatch`), and `cart_digest(cart, currency)` gives a basket's digest. `verify_online` sends these checks, and the amount, currency and merchant, to the issuer, so a receipt for another basket is refused there and not used up. Version 1 receipts still verify.
- `resolve_interruptions` and `aresolve_interruptions` answer an OpenAI Agents SDK run's tool approvals, `hitl_decisions` gives LangChain's HumanInTheLoopMiddleware its resume value, and `adk_plugin()` is a Google ADK plugin whose `before_tool_callback` asks Immiscible. Standard library only.

## 0.1.1 (6 October 2026)

Added

- `python -m immiscible.demo`: the quickstart, shipped in the package, against a built-in fake (or `--live` against `IMMISCIBLE_URL` with `IMMISCIBLE_AGENT_KEY`).

Changed

- The MCP proxy reports the SDK's own version to the server.

## 0.1.0 (6 October 2026)

First release.
