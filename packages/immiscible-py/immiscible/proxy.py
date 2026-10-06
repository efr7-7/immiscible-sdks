"""The MCP proxy, from the agent's side.

Immiscible can sit between an agent and a tool server and hold the tool's
credential. The agent speaks MCP (Streamable HTTP, JSON-RPC 2.0) to
`<base>/mcp/proxy/<upstream_id>` with its agent key:

* allowed: the upstream's result comes back as is;
* approval required: nothing was sent upstream, ImmiscibleApprovalRequiredError
  carries the action id and the approval link;
* denied: nothing was sent, ImmiscibleDeniedError carries the reasons.

`call_with_approval` does the whole dance: call, wait for the person, call
again naming the approval, which the proxy forwards exactly once.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional, Union

from .errors import ImmiscibleApprovalRequiredError, ImmiscibleDeniedError, ImmiscibleError

__all__ = ["McpProxy", "mcp_proxy_url", "mcp_server_url", "approval_from_result", "approval_meta", "MCP_PROTOCOL",
           "META_APPROVAL_ID", "META_IDEMPOTENCY_KEY"]

MCP_PROTOCOL = "2025-06-18"
# Wire names, kept from the protocol's first version.
META_APPROVAL_ID = "immiscible/approvalId"
META_IDEMPOTENCY_KEY = "immiscible/idempotencyKey"
_ERROR_TYPES = {-32001: "unauthorized", -32002: "upstream_error", -32004: "unknown_upstream", -32005: "rate_limited",
                -32006: "already_forwarded", -32602: "invalid_params"}


def mcp_proxy_url(base_url: str, upstream_id: str) -> str:
    """`<base>/mcp/proxy/<upstream_id>`."""
    if not upstream_id:
        raise TypeError("mcp_proxy_url: upstream_id is required (the id shown for the upstream in the console)")
    return f"{base_url.rstrip('/')}/mcp/proxy/{urllib.parse.quote(upstream_id, safe='')}"


def mcp_server_url(base_url: str) -> str:
    """`<base>/mcp`: Immiscible's own MCP server (authorize_action, request_payment, ...)."""
    return f"{base_url.rstrip('/')}/mcp"


def approval_from_result(result: Any) -> Optional[dict]:
    """Read an approval-required answer out of a tools/call result, from any MCP client. None otherwise."""
    sc = result.get("structuredContent") if isinstance(result, dict) else None
    if not isinstance(sc, dict) or sc.get("decision") != "approval_required" or not isinstance(sc.get("actionId"), str):
        return None
    return {"action_id": sc["actionId"], "approval": sc.get("approval"), "reasons": list(sc.get("reasons") or [])}


def approval_meta(approval: Union[str, dict, ImmiscibleApprovalRequiredError]) -> Dict[str, str]:
    """The `_meta` a retry needs, from an approval id, an approval dict, or an ImmiscibleApprovalRequiredError."""
    if isinstance(approval, str):
        aid = approval
    elif isinstance(approval, ImmiscibleApprovalRequiredError):
        aid = (approval.approval or {}).get("id")
    elif isinstance(approval, dict):
        aid = approval.get("id") or (approval.get("approval") or {}).get("id")
    else:
        aid = None
    if not isinstance(aid, str) or not aid.startswith("apr_"):
        raise TypeError("approval_meta: expected an approval id (apr_...), an approval, or an ImmiscibleApprovalRequiredError")
    return {META_APPROVAL_ID: aid}


def _parse(text: str, content_type: str) -> Optional[dict]:
    if "text/event-stream" in (content_type or ""):
        for line in reversed([ln[5:].strip() for ln in text.splitlines() if ln.startswith("data:")]):
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if isinstance(m, dict) and ("result" in m or "error" in m):
                return m
        return None
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


def _rpc_error(e: dict) -> ImmiscibleError:
    if e.get("code") == -32003:
        d = e.get("data") or {}
        return ImmiscibleDeniedError({"id": d.get("actionId"), "decision": "deny", "reasons": d.get("reasons") or [e.get("message")],
                                      "risk": {"score": 0, "signals": d.get("signals") or []}})
    err = ImmiscibleError(e.get("message") or "MCP proxy error", type=_ERROR_TYPES.get(e.get("code"), "mcp_error"), body=e)
    err.code = e.get("code")  # type: ignore[attr-defined]
    return err


class McpProxy:
    """A client for the MCP proxy in front of one upstream. Get one from `immiscible.mcp_proxy(upstream_id)`."""

    def __init__(self, client, upstream_id: str, *, auto_initialize: bool = True):
        self.client = client
        self.upstream_id = upstream_id
        self.url = mcp_proxy_url(client.base_url, upstream_id)
        self.session_id: Optional[str] = None
        self.server_info: Any = None
        self.auto_initialize = auto_initialize
        self._id = 0

    def rpc(self, method: str, params: Optional[dict] = None) -> dict:
        """One JSON-RPC request; returns the whole message ({"result": ...} or {"error": ...})."""
        self._id += 1
        headers = {
            "authorization": f"Bearer {self.client.api_key}",
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "mcp-protocol-version": MCP_PROTOCOL,
            "traceparent": self.client.context.traceparent(),
        }
        if self.session_id:
            headers["mcp-session-id"] = self.session_id
        data = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}).encode("utf-8")
        req = urllib.request.Request(self.url, data=data, method="POST", headers=headers)
        try:
            with self.client._open(req, timeout=self.client.timeout) as res:
                status, text, hdrs = res.status, res.read().decode("utf-8"), res.headers
        except urllib.error.HTTPError as e:
            status, text, hdrs = e.code, e.read().decode("utf-8", "replace"), e.headers
        except (urllib.error.URLError, OSError) as e:
            raise ImmiscibleError(f"could not reach the Immiscible MCP proxy at {self.url}: {getattr(e, 'reason', e)}", type="network_error") from e
        sid = hdrs.get("mcp-session-id") if hdrs else None
        if sid:
            self.session_id = sid
        self.client.context.observe(hdrs)
        msg = _parse(text, hdrs.get("content-type", "") if hdrs else "")
        if not isinstance(msg, dict):
            raise ImmiscibleError(f"the MCP proxy answered {status} with no JSON-RPC message", status=status, type="mcp_protocol_error", body=text[:500])
        return msg

    def initialize(self) -> dict:
        msg = self.rpc("initialize", {"protocolVersion": MCP_PROTOCOL, "capabilities": {}, "clientInfo": {"name": "immiscible-python", "version": "0.1.0"}})
        if "error" in msg:
            raise _rpc_error(msg["error"])
        self.server_info = (msg.get("result") or {}).get("serverInfo")
        return msg.get("result")

    def _ready(self) -> None:
        if self.auto_initialize and not self.session_id:
            self.initialize()

    def list_tools(self, cursor: Optional[str] = None) -> dict:
        self._ready()
        msg = self.rpc("tools/list", {"cursor": cursor} if cursor else {})
        if "error" in msg:
            raise _rpc_error(msg["error"])
        return msg["result"]

    def call(self, name: str, arguments: Optional[dict] = None, *, idempotency_key: Optional[str] = None,
             approval_id: Optional[str] = None) -> dict:
        """Call a tool through the gate. Returns the upstream's result when allowed."""
        self._ready()
        meta = {}
        if idempotency_key:
            meta[META_IDEMPOTENCY_KEY] = idempotency_key
        if approval_id:
            meta[META_APPROVAL_ID] = approval_id
        params: Dict[str, Any] = {"name": name, "arguments": arguments or {}}
        if meta:
            params["_meta"] = meta
        msg = self.rpc("tools/call", params)
        if "error" in msg:
            raise _rpc_error(msg["error"])
        pending = approval_from_result(msg.get("result"))
        if pending:
            raise ImmiscibleApprovalRequiredError({"id": pending["action_id"], "decision": "approval_required",
                                                   "reasons": pending["reasons"], "approval": pending["approval"]})
        return msg["result"]

    def retry_after_approval(self, name: str, arguments: dict, approval) -> dict:
        """Call again after a person approved: the proxy forwards the original call exactly once."""
        return self.call(name, arguments, approval_id=approval_meta(approval)[META_APPROVAL_ID])

    def call_with_approval(self, name: str, arguments: Optional[dict] = None, *, timeout: float = 600.0,
                           initial_delay: float = 0.5, idempotency_key: Optional[str] = None,
                           on_approval_required: Optional[Callable[[ImmiscibleApprovalRequiredError], None]] = None) -> dict:
        """Call; if a person must approve, wait for them, then call again. Raises ImmiscibleDeniedError if they refuse."""
        try:
            return self.call(name, arguments, idempotency_key=idempotency_key)
        except ImmiscibleApprovalRequiredError as pending:
            if on_approval_required:
                on_approval_required(pending)
            final = self.client.wait_for_decision(pending.action_id, timeout=timeout, initial_delay=initial_delay)
            if not final.allowed:
                raise ImmiscibleDeniedError(final) from None
            return self.retry_after_approval(name, arguments or {}, pending)
