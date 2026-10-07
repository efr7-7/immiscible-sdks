# Node: guard a tool call

```bash
npm install @immiscible/sdk
node index.mjs
```

`run.guard(action, fn)` asks Immiscible before `fn` runs. Allowed: `fn` runs. Held: it waits while a person decides in Slack, Teams, email or on a phone, then runs `fn` only if they approve. Denied: it throws `ImmiscibleDeniedError` with the reasons, and `fn` never runs. If Immiscible cannot be reached, it fails closed.

It reads `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` (`npx immiscible init` writes both to `.env`). Against the fake, with no account:

```bash
npx -p @immiscible/sdk immiscible-fake   # prints { url, agentKey }; approve with POST <url>/__fake/actions/<id>/approve
```

Expected, against the fake (a person approves the deploy):

```text
allowed: Look up invoice 0931 in the books
waiting for a person: http://127.0.0.1:.../app/approvals/apr_...
allowed by a person: Deploy the api service
denied: Upload the month-end report: no mandate lets this agent reach evil.example
```

For payments, use `Immiscible.paymentAction({ amount, currency, merchant })` in place of `toolAction`; amounts are in minor units (pence).
