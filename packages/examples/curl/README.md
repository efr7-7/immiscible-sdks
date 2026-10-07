# curl: the HTTP contract

Any language that can make an HTTP request can ask first. Every SDK, guard and plugin is a wrapper round this one call.

```bash
export IMMISCIBLE_URL=https://immiscible.fly.dev IMMISCIBLE_AGENT_KEY=ask_...   # npx immiscible init writes both to .env
sh authorize.sh
```

1. `POST /v1/actions/authorize` with the action: its `type` (`payment`, `data.release`, `tool.call` or your own dotted type), a one-sentence `summary` a person can read, and what influenced it (`provenance`). An `idempotency-key` header makes a retry the same request.
2. The answer's `decision` is `allow` (with a signed `receipt`), `approval_required` (with an `approval` link; ask `GET /v1/actions/<id>` until a person decides) or `deny` (with `reasons`). Act only on `allow`.
3. `POST /v1/actions/<id>/settle` with `completed`, `failed` or `cancelled` once the work is done.

A payment looks like this:

```json
{ "type": "payment", "summary": "Pay Acme Supplies invoice 0931",
  "payment": { "amount": 125000, "currency": "GBP", "merchant": { "name": "Acme Supplies", "domain": "acme-supplies.example" } } }
```

Amounts are in minor units (pence). The receipt is an Ed25519 compact JWS; check it offline with `npx immiscible verify` against `/.well-known/immiscible-keys.json`. The full reference is at https://immiscible.fly.dev/docs/api.
