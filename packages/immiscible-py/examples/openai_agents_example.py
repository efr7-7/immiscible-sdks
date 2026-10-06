"""OpenAI Agents SDK: every tool call asks Immiscible first; model calls go through the gateway in the same run.

    pip install immiscible openai-agents
    python examples/openai_agents_example.py --demo     # against the built-in fake (its model calls the tool you name)
"""

import asyncio
import sys

from agents import Agent, Runner, function_tool, set_default_openai_api, set_default_openai_client, set_tracing_disabled

from immiscible import Immiscible
from immiscible.integrations import guard_tools

demo = "--demo" in sys.argv
fake = None
if demo:
    from immiscible.testing import start_fake

    fake = start_fake()
    set_tracing_disabled(True)

immiscible = (Immiscible(fake.agent_key, fake.url) if demo else Immiscible()).run(client="openai-sdk")

# Model calls through the gateway, carrying the run's trace and session.
set_default_openai_client(immiscible.gateway.openai_client(async_=True))
set_default_openai_api("chat_completions")  # the gateway speaks Chat Completions


@function_tool
def buy(pence: int, domain: str) -> str:
    """Buy groceries from a supermarket."""
    return f"ordered £{pence / 100:.2f} from {domain}"


@function_tool
def search(q: str) -> str:
    """Search for products."""
    return f"3 results for {q}"


def to_action(call):
    if call.name == "search":
        return None  # read-only: no check
    return Immiscible.payment_action(call.args["pence"], "GBP", call.args["domain"], provenance=[{"source": "user", "detail": "weekly shop"}])


agent = Agent(
    name="Shopper",
    instructions="You buy groceries for the person.",
    model="gpt-test" if demo else "gpt-5-mini",
    tools=guard_tools([buy, search], client=immiscible, map_to_action=to_action,
                      on_approval_required=lambda d: print(f"a person must approve: {d.approval_url}")),
)


async def main():
    for prompt in (['CALL buy {"pence":1200,"domain":"tesco.com"}', 'CALL buy {"pence":1200,"domain":"0cado.com"}'] if demo
                   else ["Buy this week's milk and bread from tesco.com, about £12."]):
        result = await Runner.run(agent, prompt)
        print(result.final_output)


asyncio.run(main())
if fake:
    fake.close()
