"""Framework integrations. Each is duck-typed: importing this package imports no framework."""

from .core import ToolCall, arun_gated, default_map_to_action, guarded, parse_args, refusal_message, run_gated
from .langchain import guard_langchain_tool, guard_langchain_tools
from .openai_agents import guard_function_tool, guard_tools
from .approvals import ImmiscibleAdkPlugin, ResolvedCall, adk_plugin, aresolve_interruptions, decide_call, hitl_decisions, resolve_interruptions

__all__ = [
    "ToolCall", "guarded", "run_gated", "arun_gated", "default_map_to_action", "refusal_message", "parse_args",
    "guard_function_tool", "guard_tools", "guard_langchain_tool", "guard_langchain_tools",
    "resolve_interruptions", "aresolve_interruptions", "hitl_decisions", "adk_plugin", "ImmiscibleAdkPlugin", "decide_call", "ResolvedCall",
]
