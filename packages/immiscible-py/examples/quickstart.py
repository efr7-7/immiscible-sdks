"""Five minutes from key to first governed tool call.

    python examples/quickstart.py --demo        # against the built-in fake, no server needed
    IMMISCIBLE_AGENT_KEY=ask_... IMMISCIBLE_URL=http://localhost:8787 python examples/quickstart.py

One task, one run: ask before a tool runs, wait for a person when asked, run
the tool only if allowed, settle, and check the receipt.
"""

import sys
import threading

from immiscible import Immiscible, ImmiscibleDeniedError, fetch_jwks, tool_action, verify_receipt

demo = "--demo" in sys.argv
fake = None
if demo:
    from immiscible.testing import start_fake

    fake = start_fake()

immiscible = Immiscible(fake.agent_key, fake.url) if demo else Immiscible()
run = immiscible.run()  # one trace and one session for this task

# 1. A tool call inside the mandate: allowed, run, settled.
with run.guard(tool_action("fetch_page", {"url": "https://github.com/acme/api"})) as decision:
    print(f"allowed ({'; '.join(decision.reasons)})")
    page = "<html>...</html>"  # your tool runs here, and only here
print(f"fetched {len(page)} bytes")


# 2. A payment above the "ask me" threshold: a person approves it.
def ask_the_person(d):
    print(f"waiting for a person: {d.approval_url}")
    if demo:  # in real life, their phone buzzes
        threading.Timer(0.3, fake.approve, (d.id,)).start()


payment = Immiscible.payment_action(9500, "GBP", "ocado.com", provenance=[{"source": "user", "detail": "weekly shop"}])
with run.guard(payment, on_approval_required=ask_the_person) as decision:
    print(f"approved by a person: {decision.human}")
    receipt = decision.receipt

# 3. Whoever receives the order checks the receipt, offline against pinned keys.
jwks = fetch_jwks(run.base_url)  # fetch once, store with your config
check = verify_receipt(receipt, run.base_url, jwks=jwks, expect={"amount": 9500, "currency": "GBP", "merchant": "ocado.com"})
print(f"receipt valid: {check.valid}")

# 4. A prompt-injected lookalike: refused, and the payment code never runs.
try:
    with run.guard(Immiscible.payment_action(4999, "GBP", "0cado.com", provenance=[{"source": "web", "url": "https://0cado.com/deal"}])):
        raise RuntimeError("this never runs")
except ImmiscibleDeniedError as err:
    print(f"refused: {'; '.join(err.reasons)}")

if fake:
    fake.close()
