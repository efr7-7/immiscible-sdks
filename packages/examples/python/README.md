# Python: guard a tool call

```bash
pip install immiscible   # Python 3.9 or later, standard library only
python main.py
```

`with run.guard(action) as decision:` asks Immiscible before the block runs. Allowed: the block runs. Held: it waits while a person decides, then runs the block only if they approve. Denied: it raises `ImmiscibleDeniedError` with the reasons, and the block never runs. If Immiscible cannot be reached, it fails closed.

It reads `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` (`npx immiscible init` writes both to `.env`). The package carries its own fake, so you can try it with no account: `python -m immiscible.demo`.

Expected, against the fake (a person approves the deploy):

```text
allowed: Look up invoice 0931 in the books
waiting for a person: http://127.0.0.1:.../app/approvals/apr_...
allowed by a person: Deploy the api service
denied: Upload the month-end report: no mandate lets this agent reach evil.example
```

For payments, use `Immiscible.payment_action(amount, currency, merchant)`; amounts are in minor units (pence). Guards for the OpenAI Agents SDK and LangChain are in `immiscible.integrations`.
