# Changelog: @immiscible/sdk

## 0.1.1 (not yet published)

Added

- `npx -p @immiscible/sdk immiscible-demo`: the quickstart, shipped in the package, against a built-in fake (or `--live` against `IMMISCIBLE_URL` with `IMMISCIBLE_AGENT_KEY`).
- Typed errors: `ImmiscibleAuthenticationError` (401), `ImmiscibleInvalidRequestError` (400 and 422, with `errors` naming each field), `ImmiscibleRateLimitError`, `ImmiscibleIdempotencyConflictError` and `ImmiscibleConnectionError`. Every error carries `requestId`, the server's `x-request-id`.
- `agentId` (or `IMMISCIBLE_AGENT_ID`), to act as one agent with an agent platform's workspace token.
- A tool action without a `summary` is described from its arguments in words ("amount 12, customer Acme"), never raw JSON, and the SDK warns once per tool, since a summary is what a person approving it reads. The framework integrations turn the warning off.

Changed

- The default address is the hosted service, `https://immiscible.fly.dev`, the same as the CLI. Set `IMMISCIBLE_URL` (or `baseUrl`) for your own server.
- A timeout is an `ImmiscibleConnectionError`.
- The MCP proxy reports the SDK's own version to the server.

## 0.1.0 (6 October 2026)

First release.
