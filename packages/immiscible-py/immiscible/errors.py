"""Typed errors. Everything the SDK raises on purpose is an ImmiscibleError."""

from __future__ import annotations

from typing import Any, Optional

__all__ = [
    "ImmiscibleError", "ImmiscibleDeniedError", "ImmiscibleApprovalTimeoutError", "ImmiscibleApprovalRequiredError", "is_refusal",
    "ImmiscibleAuthenticationError", "ImmiscibleInvalidRequestError", "ImmiscibleRateLimitError",
    "ImmiscibleIdempotencyConflictError", "ImmiscibleConnectionError", "error_from_response",
]


class ImmiscibleError(Exception):
    """Base class. `status` is the HTTP status when the server answered, `type` a machine code."""

    def __init__(self, message: str, *, status: Optional[int] = None, type: str = "immiscible_error", body: Any = None,
                 traceparent: Optional[str] = None, request_id: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.type = type
        self.body = body
        self.traceparent = traceparent
        self.request_id = request_id  # the server's x-request-id: quote it when asking for help
        # Whether the same request, sent again unchanged, can succeed: the server's error.retryable, or for an
        # answer without it, True for a rate limit, an overload, an outage or no connection.
        err = body.get("error") if isinstance(body, dict) else None
        said = err.get("retryable") if isinstance(err, dict) else None
        if isinstance(said, bool):
            self.retryable = said
        elif status is not None:
            self.retryable = status in (429, 502, 503, 504)
        else:
            self.retryable = type in ("network_error", "connection_error")


class ImmiscibleAuthenticationError(ImmiscibleError):
    """401: the key is missing, unknown or revoked."""


class ImmiscibleInvalidRequestError(ImmiscibleError):
    """400 or 422: the request was malformed. `errors` names each field that was wrong."""

    def __init__(self, message: str, **kw):
        super().__init__(message, **kw)
        err = (self.body or {}).get("error") if isinstance(self.body, dict) else None
        found = (err or {}).get("errors") if isinstance(err, dict) else None
        self.errors = list(found) if isinstance(found, list) else []


class ImmiscibleRateLimitError(ImmiscibleError):
    """429: too many requests. `retry_after` is in seconds, when the server said."""

    def __init__(self, message: str, *, retry_after: Optional[float] = None, **kw):
        super().__init__(message, **kw)
        self.retry_after = retry_after


class ImmiscibleIdempotencyConflictError(ImmiscibleError):
    """409 idempotency_conflict: the same idempotency key was sent with a different body."""


class ImmiscibleConnectionError(ImmiscibleError):
    """The server could not be reached, or did not answer in time."""


def error_from_response(message: str, *, status: int, type: str, retry_after: Optional[float] = None, **kw) -> ImmiscibleError:
    """The error class for an HTTP failure, chosen by status and the server's error type."""
    if status == 401:
        return ImmiscibleAuthenticationError(message, status=status, type=type, **kw)
    if status == 429:
        return ImmiscibleRateLimitError(message, status=status, type=type, retry_after=retry_after, **kw)
    if status == 409 and type == "idempotency_conflict":
        return ImmiscibleIdempotencyConflictError(message, status=status, type=type, **kw)
    if status in (400, 422):
        return ImmiscibleInvalidRequestError(message, status=status, type=type, **kw)
    return ImmiscibleError(message, status=status, type=type, **kw)


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
