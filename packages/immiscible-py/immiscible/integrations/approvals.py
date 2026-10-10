"""Framework approval adapters: when a framework stops a run to ask a person
about a tool call, Immiscible answers it.

The framework's own pause stays in charge of the run; Immiscible decides,
routing to a named person on Slack, Teams, email or the phone when its rules
ask for one, and records the decision.

    OpenAI Agents SDK   resolve_interruptions(result)  approve or reject each ToolApprovalItem on
                        result.to_state(), then Runner.run(agent, state) to go on
    LangChain v1        hitl_decisions(interrupt)      {"decisions": [...]} for HumanInTheLoopMiddleware,
                        then Command(resume=...) to go on
    Google ADK          adk_plugin()                   a plugin whose before_tool_callback asks Immiscible

Duck-typed against the shapes in each framework's documentation; nothing is
imported from them, and the standard library is all this needs.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..client import Decision, Immiscible
from ..errors import is_refusal
from .core import MapToAction, ToolCall, client_of, default_map_to_action, parse_args

__all__ = ["ResolvedCall", "decide_call", "resolve_interruptions", "aresolve_interruptions", "hitl_decisions", "ImmiscibleAdkPlugin", "adk_plugin"]


@dataclass
class ResolvedCall:
    """One call a framework paused on, and what Immiscible decided about it."""

    name: str
    args: Any
    decision: str  # "allow" or "deny"
    reason: str
    immiscible: Optional[Decision] = field(default=None, repr=False)


def _reasons(d: Decision) -> str:
    return "; ".join(r for r in (str(x).strip().rstrip(". ") for x in (d.get("reasons") or [])) if r)


def decide_call(name: str, args: Any, *, call_id: Optional[str] = None, client: Optional[Immiscible] = None,
                map_to_action: Optional[MapToAction] = None, timeout: float = 600.0,
                initial_delay: float = 0.5, max_delay: float = 8.0) -> ResolvedCall:
    """Ask Immiscible about one tool call, waiting for a person when one is asked."""
    action = (map_to_action or default_map_to_action)(ToolCall(name=name, args=args, call_id=call_id))
    if action is None:
        return ResolvedCall(name, args, "allow", "no check needed for this call")
    action = dict(action)
    if call_id and not action.get("idempotencyKey"):
        action["idempotencyKey"] = f"tool_{str(call_id)[:120]}"
    c = client_of(client)
    d = c.authorize(action)
    if d.decision == "approval_required":
        try:
            d = c.wait_for_decision(d.id, timeout=timeout, initial_delay=initial_delay, max_delay=max_delay)
        except Exception as err:  # noqa: BLE001 - a timeout or a cancel is a refusal here
            if not is_refusal(err) and getattr(err, "type", None) not in ("approval_timeout", "cancelled"):
                raise
            url = ((d.get("approval") or {}).get("url")) if isinstance(d.get("approval"), dict) else None
            return ResolvedCall(name, args, "deny", f"Immiscible: nobody approved this in time{f' ({url})' if url else ''}.", d)
    if d.decision == "allow":
        return ResolvedCall(name, args, "allow", _reasons(d) or "allowed", d)
    return ResolvedCall(name, args, "deny", f"Immiscible refused this action: {_reasons(d) or 'no reason given'}. Do not try it another way.", d)


# ------------------------------------------------------------ OpenAI Agents SDK

def resolve_interruptions(result: Any, state: Any = None, **opts: Any) -> List[ResolvedCall]:
    """Answer every pending approval in an OpenAI Agents SDK run with Immiscible's decision.

    ``state`` is the RunState to decide on (default ``result.to_state()``);
    pass your own so you can resume from it::

        result = await Runner.run(agent, "Pay the invoice")
        while result.interruptions:
            state = result.to_state()
            resolve_interruptions(result, state, client=immiscible)
            result = await Runner.run(agent, state)
    """
    if state is None:
        to_state = getattr(result, "to_state", None)
        if not callable(to_state):
            raise TypeError("resolve_interruptions: pass the run result and its state (result.to_state())")
        state = to_state()
    if not callable(getattr(state, "approve", None)) or not callable(getattr(state, "reject", None)):
        raise TypeError("resolve_interruptions: the state has no approve and reject")
    out: List[ResolvedCall] = []
    for item in list(getattr(result, "interruptions", None) or []):
        if getattr(item, "type", "tool_approval_item") != "tool_approval_item":
            continue
        raw = getattr(item, "raw_item", None)
        name = getattr(item, "name", None) or getattr(item, "tool_name", None) or getattr(raw, "name", None) or "tool"
        args = parse_args(getattr(item, "arguments", None) or getattr(raw, "arguments", None) or "{}")
        call_id = getattr(raw, "call_id", None) or getattr(raw, "id", None)
        r = decide_call(name, args, call_id=call_id, **opts)
        if r.decision == "allow":
            state.approve(item)
        else:
            state.reject(item, rejection_message=r.reason)
        out.append(r)
    return out


async def aresolve_interruptions(result: Any, state: Any = None, **opts: Any) -> List[ResolvedCall]:
    """resolve_interruptions, off the event loop."""
    return await asyncio.to_thread(resolve_interruptions, result, state, **opts)


# ------------------------------------------------------------ LangChain v1

def hitl_decisions(interrupt: Any, **opts: Any) -> Dict[str, List[Dict[str, str]]]:
    """The resume value for LangChain's HumanInTheLoopMiddleware, decided by Immiscible.

    ``{"decisions": [{"type": "approve"} | {"type": "reject", "message": ...}]}``,
    in the order of the interrupt's action requests. Pass the interrupt value,
    or an Interrupt object carrying it in ``.value``::

        decisions = hitl_decisions(result.interrupts[0], client=immiscible)
        agent.invoke(Command(resume=decisions), config=config)
    """
    value = getattr(interrupt, "value", None)
    if value is None and isinstance(interrupt, dict):
        value = interrupt.get("value", interrupt)
    if value is None:
        value = interrupt
    requests = (value.get("action_requests") or value.get("actionRequests")) if isinstance(value, dict) else None
    if not isinstance(requests, list):
        raise TypeError("hitl_decisions: expected the HumanInTheLoopMiddleware interrupt, with action_requests")
    decisions: List[Dict[str, str]] = []
    for req in requests:
        r = decide_call(req.get("name", "tool"), parse_args(req.get("arguments", req.get("args", {}))), **opts)
        decisions.append({"type": "approve"} if r.decision == "allow" else {"type": "reject", "message": r.reason})
    return {"decisions": decisions}


# ------------------------------------------------------------ Google ADK

class ImmiscibleAdkPlugin:
    """A Google ADK plugin: before every tool call, ask Immiscible.

    Make it with :func:`adk_plugin`, which subclasses ADK's ``BasePlugin`` when
    ADK is installed, and register it on the App (ADK deprecates
    ``Runner(plugins=...)``)::

        app = App(name="payments", root_agent=agent, plugins=[adk_plugin(client=immiscible)])
        runner = InMemoryRunner(app=app)

    Allowed: the tool runs. Refused, or not approved in time: the tool does
    not run, and the model reads the reason as the tool's result. A call that
    needs a person waits for them (``timeout`` seconds, default ten minutes).
    """

    def __init__(self, *, client: Optional[Immiscible] = None, map_to_action: Optional[MapToAction] = None,
                 timeout: float = 600.0, name: str = "immiscible", **wait: Any) -> None:
        try:
            super().__init__(name=name)  # ADK's BasePlugin, when adk_plugin made this
        except TypeError:
            self.name = name
        self._opts: Dict[str, Any] = {"client": client, "map_to_action": map_to_action, "timeout": timeout, **wait}

    async def before_tool_callback(self, *, tool: Any, tool_args: Dict[str, Any], tool_context: Any) -> Optional[Dict[str, Any]]:
        name = getattr(tool, "name", None) or "tool"
        call_id = getattr(tool_context, "function_call_id", None)
        r = await asyncio.to_thread(decide_call, name, dict(tool_args or {}), call_id=call_id, **self._opts)
        if r.decision == "allow":
            return None
        return {"status": "refused", "error": r.reason}


def adk_plugin(**opts: Any) -> ImmiscibleAdkPlugin:
    """An ImmiscibleAdkPlugin that is also an ADK ``BasePlugin`` when ADK is installed (imported only here)."""
    try:
        from google.adk.plugins.base_plugin import BasePlugin  # type: ignore
    except Exception:  # noqa: BLE001 - ADK not installed: the duck-typed plugin
        return ImmiscibleAdkPlugin(**opts)
    cls = type("ImmiscibleAdkPlugin", (ImmiscibleAdkPlugin, BasePlugin), {})
    return cls(**opts)
