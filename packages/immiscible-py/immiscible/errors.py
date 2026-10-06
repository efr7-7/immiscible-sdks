"""Typed errors. Everything the SDK raises on purpose is an ImmiscibleError."""

from __future__ import annotations

from typing import Any, Optional

__all__ = [
    "ImmiscibleError", "ImmiscibleDeniedError", "ImmiscibleApprovalTimeoutError", "ImmiscibleApprovalRequiredError", "is_refusal",
]


class ImmiscibleError(Exception):
    """Base class. `status` is the HTTP status when the server answered, `type` a machine code."""

    def __init__(self, message: str, *, status: Optional[int] = None, type: str = "immiscible_error", body: Any = None,
                 traceparent: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.type = type
        self.body = body
        self.traceparent = traceparent


def _raw(decision) -> dict:
    if decision is None:
        return {}
    return decision if isinstance(decision, dict) else getattr(decision, "raw", {}) or {}


class ImmiscibleDeniedError(ImmiscibleError):
    """Immiscible said no. `reasons` are plain English; `signals` are the risk signals that fired."""

    def __init__(self, decision):
        d = _raw(decision)
        self.decision = decision
        self.action_id = d.get("id")
        self.reasons = list(d.get("reasons") or [])
        self.signals = list((d.get("risk") or {}).get("signals") or [])
        super().__init__(f"Immiscible denied {self.action_id or 'the action'}: {'; '.join(self.reasons) or 'no reason given'}",
                         type="denied", body=d)


class ImmiscibleApprovalTimeoutError(ImmiscibleError):
    """A person was asked and did not answer in time on this side. The approval may still be open."""

    def __init__(self, action_id: str, timeout: float, decision=None):
        d = _raw(decision)
        self.action_id = action_id
        self.timeout = timeout
        self.decision = decision
        self.approval = d.get("approval")
        where = f"; it is waiting at {self.approval['url']}" if self.approval and self.approval.get("url") else ""
        super().__init__(f"no answer to the approval for {action_id} within {timeout:g}s{where}", type="approval_timeout", body=d)


class ImmiscibleApprovalRequiredError(ImmiscibleError):
    """A person has to approve first, and you asked not to wait (wait=False)."""

    def __init__(self, decision):
        d = _raw(decision)
        self.decision = decision
        self.action_id = d.get("id")
        self.approval = d.get("approval")
        where = f" at {self.approval['url']}" if self.approval and self.approval.get("url") else ""
        super().__init__(f"a person must approve {self.action_id or 'this action'}{where}", type="approval_required", body=d)


def is_refusal(err: BaseException) -> bool:
    """True for the three errors that mean "do not go ahead"."""
    return isinstance(err, (ImmiscibleDeniedError, ImmiscibleApprovalRequiredError, ImmiscibleApprovalTimeoutError))
