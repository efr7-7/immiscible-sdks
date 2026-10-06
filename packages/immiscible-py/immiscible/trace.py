"""Carrying one agent run across calls: a W3C trace and an Immiscible session.

Every request a run makes carries `traceparent` with the run's trace id and a
fresh span id. The session joins what the gateway saw enter the model's
context with what the agent declares when it asks to act: leave the id out
and the gateway issues one (`imss_...`, returned in `x-immiscible-session`),
which the run adopts from the first gateway response; or choose one yourself,
sent as `x-immiscible-client-session`.
"""

from __future__ import annotations

import re
import secrets
import threading
from typing import Any, Callable, Dict, Mapping, Optional

__all__ = [
    "RunContext", "parse_traceparent", "format_traceparent", "new_trace_id", "new_span_id", "is_valid_session_id",
    "SESSION_HEADER", "ISSUED_SESSION_HEADER", "TRACEPARENT_HEADER",
]

SESSION_HEADER = "x-immiscible-client-session"
ISSUED_SESSION_HEADER = "x-immiscible-session"
TRACEPARENT_HEADER = "traceparent"

_SESSION_ID_RX = re.compile(r"^[\x21-\x7e]{1,128}$")
_TRACEPARENT_RX = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$")
_ZERO_TRACE = "0" * 32
_ZERO_SPAN = "0" * 16


def new_trace_id() -> str:
    while True:
        t = secrets.token_hex(16)
        if t != _ZERO_TRACE:
            return t


def new_span_id() -> str:
    while True:
        s = secrets.token_hex(8)
        if s != _ZERO_SPAN:
            return s


def parse_traceparent(header: Any) -> Optional[Dict[str, Any]]:
    """Parse a W3C traceparent: {"trace_id", "parent_id", "sampled"}, or None for anything the spec says to ignore."""
    if not isinstance(header, str):
        return None
    m = _TRACEPARENT_RX.match(header.strip())
    if not m:
        return None
    version, trace_id, parent_id, flags, rest = m.groups()
    if version == "ff" or (version == "00" and rest) or trace_id == _ZERO_TRACE or parent_id == _ZERO_SPAN:
        return None
    return {"trace_id": trace_id, "parent_id": parent_id, "sampled": bool(int(flags, 16) & 1)}


def format_traceparent(trace_id: str, span_id: str, sampled: bool = True) -> str:
    return f"00-{trace_id}-{span_id}-{'01' if sampled else '00'}"


def is_valid_session_id(v: Any) -> bool:
    return isinstance(v, str) and bool(_SESSION_ID_RX.match(v))


def _header(headers: Any, name: str) -> Optional[str]:
    if headers is None:
        return None
    try:
        v = headers.get(name)
    except AttributeError:
        return None
    if v is None and hasattr(headers, "items"):
        for k, val in headers.items():
            if str(k).lower() == name:
                v = val
                break
    return v if isinstance(v, str) else None


class RunContext:
    """One agent run: its trace and its session. Usually from `Immiscible.run()`."""

    def __init__(self, session_id: Optional[str] = None, *, client: str = "custom", traceparent: Optional[str] = None):
        parent = parse_traceparent(traceparent) if traceparent else None
        if traceparent and parent is None:
            raise TypeError("run: traceparent is not a valid W3C traceparent (00-<32 hex>-<16 hex>-<2 hex>)")
        self.trace_id: str = parent["trace_id"] if parent else new_trace_id()
        self.sampled: bool = parent["sampled"] if parent else True
        self.parent_span_id: Optional[str] = parent["parent_id"] if parent else None
        self.span_id: str = new_span_id()
        self.client: str = (client or "custom").strip().lower() or "custom"
        self.last_server_traceparent: Optional[str] = None
        self._session_id: Optional[str] = None
        self._issued = False
        self._lock = threading.Lock()
        if session_id is not None:
            self.adopt_session(session_id)

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    @property
    def session_issued(self) -> bool:
        return self._issued

    def adopt_session(self, session_id: str) -> None:
        if not is_valid_session_id(session_id):
            raise TypeError("session id must be 1 to 128 printable characters with no spaces")
        with self._lock:
            self._session_id = session_id
            self._issued = session_id.startswith("imss_")

    def session_ref(self) -> Optional[Dict[str, str]]:
        """The `session` field an action request carries, or None."""
        return {"client": self.client, "id": self._session_id} if self._session_id else None

    def traceparent(self) -> str:
        """A traceparent for one outgoing call: this run's trace, a fresh span."""
        return format_traceparent(self.trace_id, new_span_id(), self.sampled)

    def headers(self) -> Dict[str, str]:
        """Headers for one outgoing call: traceparent, plus the session header once there is a session."""
        h = {TRACEPARENT_HEADER: self.traceparent()}
        if self._session_id:
            h[ISSUED_SESSION_HEADER if self._issued else SESSION_HEADER] = self._session_id
        return h

    def observe(self, headers: Any) -> None:
        """Read a response: adopt a session the gateway issued, remember its traceparent."""
        issued = _header(headers, ISSUED_SESSION_HEADER)
        with self._lock:
            if issued and is_valid_session_id(issued) and (self._session_id is None or self._issued):
                self._session_id = issued
                self._issued = True
        tp = _header(headers, TRACEPARENT_HEADER)
        if tp and parse_traceparent(tp):
            self.last_server_traceparent = tp

    def apply(self, headers: Any) -> None:
        """Add this run's headers to a mutable header mapping, keeping a caller's own traceparent."""
        for k, v in self.headers().items():
            if k == TRACEPARENT_HEADER and _header(headers, k):
                continue
            headers[k] = v
        drop = SESSION_HEADER if self._issued else ISSUED_SESSION_HEADER
        if self._session_id and _header(headers, drop) is not None:
            try:
                del headers[drop]
            except KeyError:
                pass

    def httpx_event_hooks(self, *, async_: bool = False) -> Dict[str, list]:
        """Event hooks for an httpx client, so a model SDK's calls join the run.

            http_client = httpx.Client(event_hooks=run.context.httpx_event_hooks())
            OpenAI(**run.gateway.openai(), http_client=http_client)

        Pass async_=True for httpx.AsyncClient. No httpx import: the hooks only touch request.headers and response.headers.
        """
        def on_request(request) -> None:
            self.apply(request.headers)

        def on_response(response) -> None:
            self.observe(response.headers)

        if not async_:
            return {"request": [on_request], "response": [on_response]}

        async def a_request(request) -> None:
            on_request(request)

        async def a_response(response) -> None:
            on_response(response)

        return {"request": [a_request], "response": [a_response]}

    def __repr__(self) -> str:
        return f"RunContext(trace_id={self.trace_id!r}, session_id={self._session_id!r}, issued={self._issued})"
