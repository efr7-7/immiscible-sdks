"""The agent side of Immiscible: ask before acting, wait for a person when asked, report what happened.

Standard library only. Fails closed: if Immiscible cannot be reached,
authorize raises and guard never runs your code.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
import os
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
from typing import Any, Callable, Dict, Iterable, List, Optional, Union

from .errors import (
    ImmiscibleApprovalRequiredError, ImmiscibleApprovalTimeoutError, ImmiscibleConnectionError, ImmiscibleDeniedError, ImmiscibleError,
    error_from_response,
)
from .trace import RunContext, is_valid_session_id

__all__ = ["Immiscible", "Decision", "normalise_domain", "new_idempotency_key", "tool_action", "DEFAULT_BASE_URL", "SDK_VERSION"]

SDK_VERSION = "0.1.1"
# The hosted service, the same default as the CLI. Set IMMISCIBLE_URL (or base_url) for your own server.
DEFAULT_BASE_URL = "https://immiscible.fly.dev"
SETTLE_STATUSES = ("completed", "failed", "cancelled")
OUTCOME_STATUSES = ("accepted", "partial", "rejected", "abandoned")
_RETRY_STATUS = {429, 500, 502, 503, 504}
_UNSET: Any = object()


def new_idempotency_key() -> str:
    return f"idk_{uuid.uuid4()}"


class Decision(dict):
    """The server's decision, as a dict, with attribute access for the common fields."""

    @property
    def raw(self) -> dict:
        return self

    @property
    def id(self) -> str:
        return self.get("id")

    @property
    def decision(self) -> str:
        return self.get("decision")

    @property
    def allowed(self) -> bool:
        return self.get("decision") == "allow"

    @property
    def denied(self) -> bool:
        return self.get("decision") == "deny"

    @property
    def needs_approval(self) -> bool:
        return self.get("decision") == "approval_required"

    @property
    def receipt(self) -> Optional[str]:
        return self.get("receipt")

    @property
    def reasons(self) -> List[str]:
        return list(self.get("reasons") or [])

    @property
    def signals(self) -> List[dict]:
        return list((self.get("risk") or {}).get("signals") or [])

    @property
    def released(self) -> Optional[Dict[str, Any]]:
        return self.get("released")

    @property
    def approval_url(self) -> Optional[str]:
        return (self.get("approval") or {}).get("url")

    @property
    def human(self) -> bool:
        return bool(self.get("human"))


def normalise_domain(v: Any) -> Optional[str]:
    """'https://www.Ocado.com/basket' -> 'ocado.com'."""
    if not isinstance(v, str) or not v.strip():
        return None
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", v.strip().lower())
    s = re.sub(r":\d+$", "", re.split(r"[/?#]", s)[0]).rstrip(".")
    return (s[4:] if s.startswith("www.") else s) or None


def _minor(amount: Any, what: str) -> int:
    if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
        raise TypeError(f"{what} is in minor units (pence, cents) as a whole number: pass 6420 for 64.20, not {amount!r}")
    return amount


def _clip(s: Any, n: int = 240) -> str:
    return re.sub(r"\s+", " ", str(s if s is not None else "")).strip()[:n]


def readable_args(args: Any) -> str:
    """Arguments as a person reads them: "amount 12, customer Acme". Never raw JSON."""
    if args is None:
        return ""
    if isinstance(args, str):
        return _clip(args, 160)
    if not isinstance(args, (dict, list, tuple)):
        return _clip(args, 160)

    def one(v: Any) -> str:
        if v is None:
            return "none"
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (str, int, float)):
            return _clip(v, 60)
        if isinstance(v, (list, tuple)):
            return f"{len(v)} item{'' if len(v) == 1 else 's'}"
        return "\u2026"

    entries = [(str(i + 1), v) for i, v in enumerate(args)] if isinstance(args, (list, tuple)) else [(str(k), v) for k, v in args.items()]
    shown = [f"{k.replace('_', ' ')} {one(v)}" for k, v in entries[:4]]
    if len(entries) > 4:
        shown.append(f"and {len(entries) - 4} more")
    return _clip(", ".join(shown), 200)


_warned_tools: set = set()


def tool_action(name: str, args: Any, *, domain: Any = _UNSET, summary: Optional[str] = None,
                provenance: Optional[List[dict]] = None, idempotency_key: Optional[str] = None,
                warn_without_summary: bool = True) -> dict:
    """A `tool.call` action for a tool an agent is about to run. The default every integration uses.

    Give it a `summary`: it is the sentence a person reads when the call waits
    for them. Without one it says "Run send_invoice: amount 12" and warns once
    per tool.
    """
    a = args if isinstance(args, dict) else {}
    d = normalise_domain(a.get("url")) if domain is _UNSET else normalise_domain(domain)
    tool = _clip(name, 120)
    if not summary and warn_without_summary and tool not in _warned_tools:
        _warned_tools.add(tool)
        warnings.warn(
            f"immiscible: tool_action({tool!r}) has no summary, so a person approving it reads \"Run {tool}\". "
            "Pass summary=\"one sentence about this call\".",
            stacklevel=2,
        )
    said = readable_args(args)
    action: Dict[str, Any] = {
        "type": "tool.call",
        "summary": summary or (f"Run {tool}: {said}" if said else f"Run {tool}"),
        "provenance": provenance or [{"source": "agent", "detail": f"tool call: {tool}"}],
    }
    if d:
        action["target"] = {"domain": d}
    if idempotency_key:
        action["idempotencyKey"] = idempotency_key
    return action


def _sleep(seconds: float, cancel: Optional[threading.Event]) -> None:
    if cancel is None:
        time.sleep(seconds)
    elif cancel.wait(seconds):
        raise ImmiscibleError("the wait was cancelled", type="cancelled")


class Immiscible:
    """An Immiscible client for one agent, and one run.

    >>> immiscible = Immiscible()            # IMMISCIBLE_AGENT_KEY and IMMISCIBLE_URL from the environment
    >>> run = immiscible.run()               # one trace and one session per task
    >>> with run.guard(action) as decision:
    ...     do_the_thing(decision.receipt)
    """

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, *, timeout: float = 30.0,
                 max_retries: int = 2, opener: Optional[Callable] = None, session_id: Optional[str] = None,
                 session_client: str = "custom", traceparent: Optional[str] = None, run: Optional[RunContext] = None):
        self.api_key = api_key or os.environ.get("IMMISCIBLE_AGENT_KEY") or os.environ.get("ASSAY_AGENT_KEY") or os.environ.get("IMMISCIBLE_API_KEY")
        if not self.api_key:
            raise ImmiscibleError("no agent key: pass api_key or set IMMISCIBLE_AGENT_KEY (issue one under Agents in the console)", type="missing_api_key")
        self.base_url = (base_url or os.environ.get("IMMISCIBLE_URL") or os.environ.get("ASSAY_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self._open = opener or urllib.request.urlopen
        self.context = run or RunContext(session_id, client=session_client, traceparent=traceparent)
        from .gateway import Gateway
        self.gateway = Gateway(self)

    def run(self, session_id: Optional[str] = None, *, client: str = "custom", traceparent: Optional[str] = None) -> "Immiscible":
        """A client for a new run: same key and server, a fresh trace and a fresh session."""
        return Immiscible(self.api_key, self.base_url, timeout=self.timeout, max_retries=self.max_retries, opener=self._open,
                          run=RunContext(session_id, client=client, traceparent=traceparent))

    def mcp_proxy(self, upstream_id: str, *, auto_initialize: bool = True):
        """A client for the MCP proxy in front of one upstream tool server."""
        from .proxy import McpProxy
        return McpProxy(self, upstream_id, auto_initialize=auto_initialize)

    # ------------------------------------------------------------ transport

    def request(self, method: str, path: str, body: Any = None, *, retry: bool = False, auth: bool = True,
                headers: Optional[Dict[str, str]] = None, attempts: Optional[list] = None) -> Any:
        """One HTTP call to Immiscible, carrying the run's traceparent. Raises ImmiscibleError for anything but a 2xx."""
        h = {"accept": "application/json", "user-agent": f"immiscible-python/{SDK_VERSION}", **(headers or {})}
        if auth:
            h["authorization"] = f"Bearer {self.api_key}"
        data = None
        if body is not None:
            h["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        attempt = 0
        while True:
            if attempts is not None:
                attempts.append(attempt)
            h["traceparent"] = self.context.traceparent()
            req = urllib.request.Request(self.base_url + path, data=data, method=method, headers=h)
            try:
                with self._open(req, timeout=self.timeout) as res:
                    self.context.observe(res.headers)
                    text = res.read().decode("utf-8")
                    return json.loads(text) if text else None
            except urllib.error.HTTPError as e:
                self.context.observe(e.headers)
                text = e.read().decode("utf-8", "replace")
                try:
                    payload = json.loads(text) if text else None
                except ValueError:
                    payload = None
                if retry and e.code in _RETRY_STATUS and attempt < self.max_retries:
                    ra = e.headers.get("retry-after") if e.headers else None
                    time.sleep(min(float(ra), 10.0) if ra and ra.replace(".", "", 1).isdigit() else 0.25 * 2 ** attempt)
                    attempt += 1
                    continue
                err = ((payload or {}).get("error") or {}) if isinstance(payload, dict) else {}
                ra = e.headers.get("retry-after") if e.headers else None
                raise error_from_response(err.get("message") or f"Immiscible answered {e.code}", status=e.code,
                                          type=err.get("type") or "http_error", body=payload,
                                          traceparent=e.headers.get("traceparent") if e.headers else None,
                                          request_id=e.headers.get("x-request-id") if e.headers else None,
                                          retry_after=float(ra) if ra and ra.replace(".", "", 1).isdigit() else None) from None
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                if retry and attempt < self.max_retries:
                    time.sleep(0.25 * 2 ** attempt)
                    attempt += 1
                    continue
                raise ImmiscibleConnectionError(f"could not reach Immiscible at {self.base_url}: {getattr(e, 'reason', e)}", type="network_error") from e

    # ------------------------------------------------------------ the gate

    def authorize(self, action: dict, *, idempotency_key: Optional[str] = None) -> Decision:
        """Ask before acting. Returns the decision; a deny is a result, not an exception.

        An idempotency key is added if you did not send one, and reused on every retry.
        """
        if not isinstance(action, dict):
            raise TypeError("authorize(action): action must be a dict")
        if not action.get("type"):
            raise TypeError('authorize(action): action["type"] is required, for example "payment" or "tool.call"')
        if not action.get("summary"):
            raise TypeError('authorize(action): action["summary"] is required: one sentence a person can approve or refuse')
        body = dict(action)
        key = idempotency_key or body.get("idempotencyKey") or new_idempotency_key()
        body["idempotencyKey"] = key
        if "session" not in body:
            ref = self.context.session_ref()
            if ref:
                body["session"] = ref
        elif body["session"] is None:
            del body["session"]
        elif not isinstance(body["session"], dict) or not is_valid_session_id(body["session"].get("id")):
            raise TypeError("authorize: session must be {'client': ..., 'id': <1 to 128 printable characters>}")
        return Decision(self.request("POST", "/v1/actions/authorize", body, retry=True, headers={"idempotency-key": key}))

    def get_action(self, action_id: str) -> Decision:
        if not action_id:
            raise TypeError("get_action(action_id): action_id is required")
        return Decision(self.request("GET", f"/v1/actions/{urllib.parse.quote(action_id, safe='')}", retry=True))

    def wait_for_decision(self, action_id: str, *, timeout: float = 600.0, initial_delay: float = 0.5, max_delay: float = 8.0,
                          factor: float = 1.6, cancel: Optional[threading.Event] = None,
                          on_poll: Optional[Callable[[Decision], None]] = None) -> Decision:
        """Poll until the decision is final, backing off from `initial_delay` to `max_delay` with jitter.

        Returns the final decision (allow with a receipt, or deny). Raises
        ImmiscibleApprovalTimeoutError after `timeout` seconds, and an
        ImmiscibleError of type `cancelled` when `cancel` is set.
        """
        deadline = time.monotonic() + timeout
        delay = max(0.001, initial_delay)
        while True:
            if cancel is not None and cancel.is_set():
                raise ImmiscibleError("the wait was cancelled", type="cancelled")
            d = self.get_action(action_id)
            if d.decision != "approval_required":
                return d
            if on_poll:
                on_poll(d)
            left = deadline - time.monotonic()
            if left <= 0:
                raise ImmiscibleApprovalTimeoutError(action_id, timeout, d)
            _sleep(min(delay * (0.8 + random.random() * 0.4), left), cancel)
            delay = min(max_delay, delay * factor)

    def wait_for_approval(self, action_id: str, **kwargs) -> Decision:
        """Alias of wait_for_decision."""
        return self.wait_for_decision(action_id, **kwargs)

    def settle(self, action_id: str, status: str = "completed", amount: Optional[int] = None) -> Decision:
        """Record what happened. Settling above the authorised amount is an incident.

        Retried on network errors; if a retry finds the action already settled
        (the first attempt landed), the action is returned rather than an error.
        """
        if status not in SETTLE_STATUSES:
            raise TypeError(f"settle: status must be one of {', '.join(SETTLE_STATUSES)}")
        body: Dict[str, Any] = {"status": status}
        if amount is not None:
            body["amount"] = _minor(amount, "settle: amount")
        attempts: list = []
        try:
            return Decision(self.request("POST", f"/v1/actions/{urllib.parse.quote(action_id, safe='')}/settle", body, retry=True, attempts=attempts))
        except ImmiscibleError as e:
            if len(attempts) > 1 and e.type == "already_settled":
                return self.get_action(action_id)
            raise

    def decide(self, action: dict, *, wait: bool = True, timeout: float = 600.0, initial_delay: float = 0.5, max_delay: float = 8.0,
               cancel: Optional[threading.Event] = None, on_approval_required: Optional[Callable[[Decision], None]] = None,
               idempotency_key: Optional[str] = None) -> Decision:
        """Authorize and, when a person is asked, wait. Returns an allow, or raises a refusal."""
        d = self.authorize(action, idempotency_key=idempotency_key)
        if d.needs_approval:
            if not wait:
                raise ImmiscibleApprovalRequiredError(d)
            if on_approval_required:
                on_approval_required(d)
            d = self.wait_for_decision(d.id, timeout=timeout, initial_delay=initial_delay, max_delay=max_delay, cancel=cancel)
        if not d.allowed:
            raise ImmiscibleDeniedError(d)
        return d

    def settle_quietly(self, action_id: str, status: str = "completed", amount: Optional[int] = None) -> None:
        """Settle without raising: the action's own result must never be masked by a failed settlement."""
        try:
            self.settle(action_id, status, amount)
        except ImmiscibleError as e:
            warnings.warn(f"[immiscible] could not settle {action_id}: {e}", RuntimeWarning, stacklevel=3)

    def guard(self, action: Union[dict, Callable[..., Optional[dict]]], *, wait: bool = True, timeout: float = 600.0,
              initial_delay: float = 0.5, max_delay: float = 8.0, cancel: Optional[threading.Event] = None,
              on_approval_required: Optional[Callable[[Decision], None]] = None, settle: bool = True,
              settle_amount: Optional[Callable[[Any], Optional[int]]] = None) -> "_Guard":
        """Authorize, wait for a person if asked, run your code only if allowed, then settle.

        As a context manager::

            with immiscible.guard(action) as decision:
                charge(decision.receipt)
                decision["settle_amount"] = 6100     # optional: what was actually spent

        As a decorator, with a function that maps the call to an action (sync or async)::

            @immiscible.guard(lambda item, pence: Immiscible.payment_action(pence, "GBP", "ocado.com"))
            def buy(item, pence): ...
        """
        return _Guard(self, action, dict(wait=wait, timeout=timeout, initial_delay=initial_delay, max_delay=max_delay,
                                         cancel=cancel, on_approval_required=on_approval_required, settle=settle,
                                         settle_amount=settle_amount))

    # ------------------------------------------------------------ helpers

    @staticmethod
    def payment_action(amount: int, currency: str, merchant: Union[str, dict], *, summary: Optional[str] = None,
                       provenance: Optional[List[dict]] = None, category: Optional[str] = None,
                       idempotency_key: Optional[str] = None) -> dict:
        """A payment action, built and checked. `amount` is in minor units: 6420 is 64.20."""
        _minor(amount, "pay: amount")
        if amount == 0:
            raise TypeError("pay: amount must be above zero")
        if not isinstance(currency, str) or not re.fullmatch(r"[A-Za-z]{3}", currency):
            raise TypeError('pay: currency must be a three-letter ISO code such as "GBP"')
        m = {"domain": merchant} if isinstance(merchant, str) else dict(merchant or {})
        m["domain"] = normalise_domain(m.get("domain") or m.get("url"))
        m.pop("url", None)
        if not m["domain"]:
            raise TypeError('pay: merchant needs a domain, for example "ocado.com"')
        if category and not m.get("category"):
            m["category"] = category
        cur = currency.upper()
        sym = {"GBP": "£", "EUR": "€", "USD": "$"}.get(cur)
        shown = f"{sym}{amount / 100:.2f}" if sym else f"{amount / 100:.2f} {cur}"
        action: Dict[str, Any] = {
            "type": "payment",
            "summary": summary or f"Pay {shown} to {m.get('name') or m['domain']}",
            "payment": {"amount": amount, "currency": cur, "merchant": m},
            "target": {"domain": m["domain"]},
        }
        if provenance:
            action["provenance"] = provenance
        if idempotency_key:
            action["idempotencyKey"] = idempotency_key
        return action

    @staticmethod
    def data_action(fields: Union[str, Iterable[str]], recipient: str, purpose: Optional[str] = None, *,
                    summary: Optional[str] = None, provenance: Optional[List[dict]] = None,
                    idempotency_key: Optional[str] = None) -> dict:
        """A data.release action, built and checked."""
        lst = [fields] if isinstance(fields, str) else list(fields or [])
        if not lst:
            raise TypeError('request_data: fields must list vault fields, for example ["address"]')
        to = normalise_domain(recipient)
        if not to:
            raise TypeError('request_data: recipient must be a domain, for example "ocado.com"')
        data: Dict[str, Any] = {"fields": lst, "recipient": to}
        if purpose:
            data["purpose"] = purpose
        action: Dict[str, Any] = {
            "type": "data.release",
            "summary": summary or f"Share {', '.join(lst)} with {to}{f' for {purpose}' if purpose else ''}",
            "data": data,
            "target": {"recipient": to},
        }
        if provenance:
            action["provenance"] = provenance
        if idempotency_key:
            action["idempotencyKey"] = idempotency_key
        return action

    def pay(self, amount: int, currency: str, merchant: Union[str, dict], **kwargs) -> Decision:
        """Ask to pay a merchant. Keyword arguments as payment_action, plus session=None to send none."""
        session = kwargs.pop("session", _UNSET)
        action = self.payment_action(amount, currency, merchant, **kwargs)
        if session is not _UNSET:
            action["session"] = session
        return self.authorize(action)

    def request_data(self, fields: Union[str, Iterable[str]], recipient: str, purpose: Optional[str] = None, **kwargs) -> Decision:
        """Ask for named vault fields for one recipient. Values arrive in `decision.released`."""
        session = kwargs.pop("session", _UNSET)
        action = self.data_action(fields, recipient, purpose, **kwargs)
        if session is not _UNSET:
            action["session"] = session
        return self.authorize(action)

    def outcome(self, task_id: str, status: str, *, value: Optional[float] = None, evidence: Optional[dict] = None,
                accepted_call_ids: Optional[List[str]] = None) -> Any:
        """TokenOps: how a task ended, so its token spend has a denominator."""
        if not task_id:
            raise TypeError("outcome: task_id is required (the x-immiscible-task-id of the calls)")
        if status not in OUTCOME_STATUSES:
            raise TypeError(f"outcome: status must be one of {', '.join(OUTCOME_STATUSES)}")
        body: Dict[str, Any] = {"taskId": task_id, "status": status}
        if value is not None:
            body["value"] = value
        if evidence is not None:
            body["evidence"] = evidence
        if accepted_call_ids is not None:
            body["acceptedCallIds"] = accepted_call_ids
        return self.request("POST", "/v1/outcomes", body)


class _Guard:
    """Both a context manager and a decorator. See Immiscible.guard."""

    def __init__(self, client: Immiscible, action, opts: dict):
        self._client = client
        self._action = action
        self._opts = opts
        self._decision: Optional[Decision] = None

    def _open(self, action: dict) -> Decision:
        o = self._opts
        return self._client.decide(action, wait=o["wait"], timeout=o["timeout"], initial_delay=o["initial_delay"],
                                   max_delay=o["max_delay"], cancel=o["cancel"], on_approval_required=o["on_approval_required"])

    def _close(self, action: dict, d: Decision, failed: bool, amount: Optional[int]) -> None:
        if not self._opts["settle"]:
            return
        if failed:
            self._client.settle_quietly(d.id, "failed")
        else:
            amt = amount if amount is not None else (action.get("payment") or {}).get("amount")
            self._client.settle_quietly(d.id, "completed", amt)

    def __enter__(self) -> Decision:
        if callable(self._action):
            raise TypeError("guard(fn) with a mapping function is a decorator; pass a dict to use it with `with`")
        self._decision = self._open(self._action)
        return self._decision

    def __exit__(self, exc_type, exc, tb) -> bool:
        d = self._decision
        if d is not None:
            self._close(self._action, d, exc_type is not None, d.get("settle_amount"))
        return False

    def __call__(self, fn: Callable) -> Callable:
        sa = self._opts["settle_amount"]

        def action_for(args, kwargs):
            return self._action(*args, **kwargs) if callable(self._action) else self._action

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def awrapper(*args, **kwargs):
                action = action_for(args, kwargs)
                if action is None:
                    return await fn(*args, **kwargs)
                d = await asyncio.to_thread(self._open, action)
                try:
                    result = await fn(*args, **kwargs)
                except BaseException:
                    await asyncio.to_thread(self._close, action, d, True, None)
                    raise
                await asyncio.to_thread(self._close, action, d, False, sa(result) if sa else None)
                return result

            return awrapper

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            action = action_for(args, kwargs)
            if action is None:
                return fn(*args, **kwargs)
            d = self._open(action)
            try:
                result = fn(*args, **kwargs)
            except BaseException:
                self._close(action, d, True, None)
                raise
            self._close(action, d, False, sa(result) if sa else None)
            return result

        return wrapper
