"""OpenAI Agents SDK (`openai-agents`).

    from agents import Agent, Runner, function_tool, set_default_openai_client, set_default_openai_api
    from immiscible import Immiscible
    from immiscible.integrations.openai_agents import guard_tools

    immiscible = Immiscible().run()
    set_default_openai_client(immiscible.gateway.openai_client(async_=True))   # model calls through the gateway
    set_default_openai_api("chat_completions")

    agent = Agent(name="Shopper", tools=guard_tools([buy, search], client=immiscible))

Each guarded tool asks Immiscible before it runs, waits for a person when one
is asked (in a worker thread, so the event loop keeps going), runs only if
allowed, and settles afterwards. A refusal goes back to the model as text.
"""

from __future__ import annotations

import copy
from typing import Any, List, Optional

from ..client import Immiscible
from .core import MapToAction, ToolCall, arun_gated, parse_args

__all__ = ["guard_function_tool", "guard_tools"]


def guard_function_tool(tool: Any, *, client: Optional[Immiscible] = None, map_to_action: Optional[MapToAction] = None, **opts) -> Any:
    """Guard one FunctionTool (anything with `name` and an async `on_invoke_tool(ctx, input_json)`). Returns a copy."""
    original = getattr(tool, "on_invoke_tool", None)
    if original is None or not callable(original):
        raise TypeError("guard_function_tool: expected a FunctionTool with on_invoke_tool(ctx, input)")
    name = getattr(tool, "name", "tool")

    async def on_invoke_tool(ctx: Any, input: str) -> Any:
        call = ToolCall(name, parse_args(input), getattr(ctx, "tool_call_id", None), ctx)

        async def go(_d):
            return await original(ctx, input)

        return await arun_gated(call, go, client=client, map_to_action=map_to_action, **opts)

    guarded = copy.copy(tool)
    object.__setattr__(guarded, "on_invoke_tool", on_invoke_tool)
    return guarded


def guard_tools(tools: List[Any], **kwargs) -> List[Any]:
    """Guard every function tool in a list. Hosted tools and handoffs pass through."""
    return [guard_function_tool(t, **kwargs) if callable(getattr(t, "on_invoke_tool", None)) else t for t in tools]
