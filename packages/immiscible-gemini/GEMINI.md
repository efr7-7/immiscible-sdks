# Immiscible


Immiscible holds the rules the person you act for wrote about what you may spend, share and do. Before any consequential action, ask it, then do exactly what it says.

1. **Ask first.**
   - Paying: call `request_payment` with the amount in whole minor units (`42000` is £420.00), the currency, the merchant (name and domain) and a one-line summary a person can read.
   - Sharing personal data: call `request_personal_data` with the fields, the recipient and the purpose.
   - Anything else that reaches another system (email, calendar, account changes, tool calls): call `authorize_action`.
   - Say where the request came from in `provenance` (`user`, `email`, `web`, `tool`), honestly.
2. **Follow the decision.**
   - `allow`: do exactly what was asked, nothing more, and keep the receipt.
   - `approval_required`: do not act. Tell the person, with the approval link, and check back with `check_action_status`: every five seconds for a minute, then every thirty.
   - `deny`: do not act, and do not try another way. Tell the person the reasons.
3. **Report what happened.** After an allowed action, call `settle_action` once with `completed` or `failed`.
4. **Explain when asked.** `explain_decision` says in plain English why something was allowed, held or refused.

Retry with the same idempotency key, never a new one; a new key is a new request and a burst of them asks a person. If Immiscible cannot be reached or answers with an error, do not act: no decision is not an allow. Never ask for, repeat or store an agent key.
