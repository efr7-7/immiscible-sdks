"""LangChain and LangGraph (`langchain-core`, `langgraph`).

    from langgraph.prebuilt import ToolNode
    from immiscible.integrations.langchain import guard_langchain_tools

    tools = guard_langchain_tools([buy, search], client=immiscible)
    node = ToolNode(tools)               # or model.bind_tools(tools), or create_react_agent(model, tools)

A guarded tool is a copy of yours with the same name, description and
schema; only `invoke` and `ainvoke` ask Immiscible first. For a LangGraph
human in the loop, call `interrupt(...)` from `on_approval_required`, or pass
`wait=False` to refuse at once and let the graph route the refusal.
"""

from __future__ import annotations

import copy
from typing import Any, List, Optional

from ..client import Immiscible
from .core import MapToAction, ToolCall, arun_gated, parse_args, refusal_message, run_gated

__all__ = ["guard_langchain_tool", "guard_langchain_tools"]


def _is_tool_call(x: Any) -> bool:
    return isinstance(x, dict) and (x.get("type") == "tool_call" or {"name", "args", "id"} <= set(x))


def _call_of(tool: Any, input: Any, config: Any) -> ToolCall:
    if _is_tool_call(input):
        return ToolCall(getattr(tool, "name", "tool"), input.get("args"), input.get("id"), config)
    return ToolCall(getattr(tool, "name", "tool"), parse_args(input), None, config)


def _with_refusal(input: Any, opts: dict) -> dict:
    """ToolNode hands over a ToolCall and expects a ToolMessage back, refusals included."""
    base = opts.get("refusal") or refusal_message
    if not _is_tool_call(input):
        return opts

    def make(err: BaseException) -> Any:
        text = base(err)
        try:
            from langchain_core.messages import ToolMessage
        except ImportError:  # not running under LangChain after all
            return text
        return ToolMessage(content=text, tool_call_id=input.get("id"), name=input.get("name"), status="error")

    return {**opts, "refusal": make}


def _copy(tool: Any) -> Any:
    for m in ("model_copy", "copy"):
        f = getattr(tool, m, None)
        if callable(f):
            try:
                return f()
            except TypeError:
                continue
    return copy.copy(tool)


def guard_langchain_tool(tool: Any, *, client: Optional[Immiscible] = None, map_to_action: Optional[MapToAction] = None, **opts) -> Any:
    """Guard one tool (a `@tool` function, StructuredTool, BaseTool subclass). Returns a copy."""
    invoke = getattr(tool, "invoke", None)
    if not callable(invoke):
        raise TypeError("guard_langchain_tool: expected a tool with invoke(input, config)")
    ainvoke = getattr(tool, "ainvoke", None)

    def g_invoke(input: Any, config: Any = None, **kwargs: Any) -> Any:
        return run_gated(_call_of(tool, input, config), lambda _d: invoke(input, config, **kwargs), client=client, map_to_action=map_to_action,
                         **_with_refusal(input, opts))

    async def g_ainvoke(input: Any, config: Any = None, **kwargs: Any) -> Any:
        async def go(_d):
            if callable(ainvoke):
                return await ainvoke(input, config, **kwargs)
            return invoke(input, config, **kwargs)

        return await arun_gated(_call_of(tool, input, config), go, client=client, map_to_action=map_to_action, **_with_refusal(input, opts))

    guarded = _copy(tool)
    # Pydantic models refuse unknown attributes through __setattr__; the instance dict still takes them.
    object.__setattr__(guarded, "invoke", g_invoke)
    object.__setattr__(guarded, "ainvoke", g_ainvoke)
    return guarded


def guard_langchain_tools(tools: List[Any], **kwargs) -> List[Any]:
    """Guard a list of tools."""
    return [guard_langchain_tool(t, **kwargs) for t in tools]
