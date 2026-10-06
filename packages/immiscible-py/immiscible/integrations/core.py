"""What every framework integration shares.

Turn a tool call into an action, run the tool only if Immiscible allows it,
settle afterwards, and hand the model a refusal it will not argue with.
None of the integrations imports its framework: they are duck-typed against
the objects those frameworks pass around, so they work with the version you
have installed.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional

from ..client import Decision, Immiscible, tool_action
from ..errors import ImmiscibleError, is_refusal

__all__ = ["ToolCall", "MapToAction", "default_map_to_action", "refusal_message", "parse_args", "client_of",
           "run_gated", "arun_gated", "guarded"]


@dataclass
class ToolCall:
    """One tool call, as the integrations see it."""

    name: str
    args: Any
    call_id: Optional[str] = None
    context: Any = field(default=None, repr=False)


MapToAction = Callable[[ToolCall], Optional[dict]]

_fallback: Optional[Immiscible] = None


def client_of(client: Optional[Immiscible]) -> Immiscible:
    """The client an integration uses: yours, or one from IMMISCIBLE_AGENT_KEY and IMMISCIBLE_URL."""
    global _fallback
    if client is not None:
        return client
    if _fallback is None:
        _fallback = Immiscible()
    return _fallback


def default_map_to_action(call: ToolCall) -> dict:
    """Every tool call is a `tool.call` action named after the tool."""
    return tool_action(call.name, call.args)


def parse_args(raw: Any) -> Any:
    """Parse a JSON argument string; leave anything else alone."""
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return raw


def refusal_message(err: BaseException) -> str:
    """What the model reads when Immiscible says no. Written to stop retries, not invite them."""
    if isinstance(err, ImmiscibleError) and err.type in ("approval_required", "approval_timeout"):
        approval = getattr(err, "approval", None) or {}
        url = approval.get("url") if isinstance(approval, dict) else None
        where = f" ({url})" if url else ""
        return (f"Immiscible: this action is waiting for the person to approve it{where}. "
                "Do not proceed and do not try it another way. Tell the person it needs their approval.")
    # Reasons arrive as sentences; the full stop is added once, here.
    reasons = "; ".join(r for r in (str(x).strip().rstrip(". ") for x in (getattr(err, "reasons", None) or [])) if r) or "no reason given"
    return (f"Immiscible refused this action: {reasons}. "
            "Do not proceed and do not try it another way. Tell the person what was refused and why.")


def _plan(call: ToolCall, map_to_action: Optional[MapToAction]) -> Optional[dict]:
    action = (map_to_action or default_map_to_action)(call)
    if action is None:
        return None
    action = dict(action)
    # The framework's call id makes a retried tool call the same action, whoever built the action.
    if call.call_id and not action.get("idempotencyKey"):
        action["idempotencyKey"] = f"tool_{str(call.call_id)[:120]}"
    return action


def _decide_kwargs(opts: Dict[str, Any]) -> Dict[str, Any]:
    keys = ("wait", "timeout", "initial_delay", "max_delay", "cancel", "on_approval_required")
    return {k: opts[k] for k in keys if k in opts}


def _settle_amount(action: dict, result: Any, d: Decision, opts: Dict[str, Any]) -> Optional[int]:
    fn = opts.get("settle_amount")
    if fn is not None:
        return fn(result)
    return (action.get("payment") or {}).get("amount")


def run_gated(call: ToolCall, run: Callable[[Optional[Decision]], Any], *, client: Optional[Immiscible] = None,
              map_to_action: Optional[MapToAction] = None, on_deny: str = "message",
              refusal: Optional[Callable[[BaseException], str]] = None, settle: bool = True, **opts) -> Any:
    """Authorize, wait, run, settle. Returns the tool's result, or a refusal message (on_deny="raise" to raise instead)."""
    action = _plan(call, map_to_action)
    if action is None:
        return run(None)
    c = client_of(client)
    try:
        d = c.decide(action, **_decide_kwargs(opts))
    except ImmiscibleError as err:
        if is_refusal(err) and on_deny != "raise":
            return refusal(err) if refusal else refusal_message(err)
        raise
    try:
        result = run(d)
    except BaseException:
        if settle:
            c.settle_quietly(d.id, "failed")
        raise
    if settle:
        c.settle_quietly(d.id, "completed", _settle_amount(action, result, d, opts))
    return result


async def arun_gated(call: ToolCall, run: Callable[[Optional[Decision]], Awaitable[Any]], *, client: Optional[Immiscible] = None,
                     map_to_action: Optional[MapToAction] = None, on_deny: str = "message",
                     refusal: Optional[Callable[[BaseException], str]] = None, settle: bool = True, **opts) -> Any:
    """run_gated for async tools. The HTTP calls run in a worker thread, so the event loop never blocks."""
    action = _plan(call, map_to_action)
    if action is None:
        return await run(None)
    c = client_of(client)
    try:
        d = await asyncio.to_thread(functools.partial(c.decide, action, **_decide_kwargs(opts)))
    except ImmiscibleError as err:
        if is_refusal(err) and on_deny != "raise":
            return refusal(err) if refusal else refusal_message(err)
        raise
    try:
        result = await run(d)
    except BaseException:
        if settle:
            await asyncio.to_thread(c.settle_quietly, d.id, "failed")
        raise
    if settle:
        await asyncio.to_thread(c.settle_quietly, d.id, "completed", _settle_amount(action, result, d, opts))
    return result


def guarded(map_to_action: Optional[MapToAction] = None, *, client: Optional[Immiscible] = None, name: Optional[str] = None, **opts):
    """Decorate a plain tool function (sync or async) so it asks Immiscible first.

    Works under any framework that builds tools from functions, because the
    signature, annotations and docstring are kept::

        @function_tool                    # OpenAI Agents SDK, or @tool for LangChain
        @guarded(lambda call: Immiscible.payment_action(call.args["pence"], "GBP", call.args["domain"]))
        def buy(pence: int, domain: str) -> str:
            ...

    `call.args` is the function's arguments by name.
    """
    def wrap(fn: Callable) -> Callable:
        tool_name = name or fn.__name__
        sig = inspect.signature(fn)

        def call_of(args, kwargs) -> ToolCall:
            try:
                bound = sig.bind_partial(*args, **kwargs)
                values = dict(bound.arguments)
            except TypeError:
                values = {"args": list(args), **kwargs}
            return ToolCall(tool_name, values)

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def awrapper(*args, **kwargs):
                async def go(_d):
                    return await fn(*args, **kwargs)
                return await arun_gated(call_of(args, kwargs), go, client=client, map_to_action=map_to_action, **opts)

            return awrapper

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            return run_gated(call_of(args, kwargs), lambda _d: fn(*args, **kwargs), client=client, map_to_action=map_to_action, **opts)

        return wrapper

    return wrap
