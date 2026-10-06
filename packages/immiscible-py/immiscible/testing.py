"""A fake Immiscible for tests and demos. Standard library only.

    from immiscible.testing import start_fake
    fake = start_fake()
    immiscible = Immiscible(fake.agent_key, fake.url)
    ...
    fake.close()

It speaks the same HTTP contract as the real server and signs real Ed25519
receipts (pure Python, below), so verifiers are tested against real
signatures. Its policy is a small imitation of a groceries mandate and a
tools mandate: it is NOT the real policy engine, and passing against it
proves your integration, not your mandate.

Also imitated, in miniature: the gateway (/v1/chat/completions and
/anthropic/v1/messages, with server-issued sessions and observed
provenance; the fake model answers "ok", or calls the tool named by
`CALL <tool> <json args>` in the last user message and then reports its
result), W3C trace context, the MCP proxy at /mcp/proxy/fake-shop, and a
person's approvals at POST /__fake/actions/<id>/approve|deny.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Set, Tuple

from . import ed25519 as _ed

__all__ = ["start_fake", "FakeImmiscible", "Ed25519Signer", "DEFAULT_MANDATE"]


# ------------------------------------------------------------- signing

def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _compress(pt) -> bytes:
    x, y, z, _ = pt
    zi = pow(z, _ed.P - 2, _ed.P)
    x, y = x * zi % _ed.P, y * zi % _ed.P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


class Ed25519Signer:
    """RFC 8032 signing, for the fake only. Not constant time; never use it for a real key."""

    def __init__(self, seed: Optional[bytes] = None):
        self.seed = seed or secrets.token_bytes(32)
        h = hashlib.sha512(self.seed).digest()
        a = int.from_bytes(h[:32], "little")
        a &= (1 << 254) - 8
        a |= 1 << 254
        self._a = a
        self._prefix = h[32:]
        self.public_key = _compress(_ed._mul(a, _ed.G))

    def sign(self, message: bytes) -> bytes:
        r = int.from_bytes(hashlib.sha512(self._prefix + message).digest(), "little") % _ed.L
        rb = _compress(_ed._mul(r, _ed.G))
        k = int.from_bytes(hashlib.sha512(rb + self.public_key + message).digest(), "little") % _ed.L
        s = (r + k * self._a) % _ed.L
        return rb + s.to_bytes(32, "little")

    def jwk(self, kid: str) -> dict:
        return {"kty": "OKP", "crv": "Ed25519", "x": _b64u(self.public_key), "kid": kid, "alg": "EdDSA", "use": "sig"}


# --------------------------------------------------------------- policy

DEFAULT_MANDATE = {
    "id": "mdt_fake_groceries", "title": "Weekly groceries", "currency": "GBP",
    "per_transaction": 15000, "approve_above": 8000,
    "merchants": ["tesco.com", "ocado.com", "sainsburys.co.uk"],
    "fields": ["address", "email"], "recipients": ["tesco.com", "ocado.com"],
    "blocked_domains": ["evil.example"], "approve_tools": r"\b(delete|drop|transfer|deploy)\b",
}
_VAULT = {"address": "1 Example Street, London", "email": "person@example.com", "name": "A. Person"}
_KNOWN = ["amazon.com", "amazon.co.uk", "paypal.com", "apple.com", "google.com", "ebay.com"]
_KNOWN_CLIENTS = {"custom", "mcp", "claude-code", "cursor", "openai-sdk", "anthropic-sdk", "langchain", "vercel-ai", "cline", "aider", "copilot", "devin", "zed"}
_TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")


def _edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return prev[-1]


def _host(d: Any) -> str:
    if not isinstance(d, str):
        return ""
    s = re.sub(r"^https?://", "", d.strip().lower()).split("/")[0]
    return s[4:] if s.startswith("www.") else s


def _money(pence: int) -> str:
    return f"£{pence / 100:,.2f}"


def _rid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class FakeImmiscible:
    url: str
    agent_key: str
    agent_id: str
    kid: str
    jwks: dict
    signer: Ed25519Signer
    actions: Dict[str, dict] = field(default_factory=dict)
    settlements: List[dict] = field(default_factory=list)
    outcomes: List[dict] = field(default_factory=list)
    requests: List[dict] = field(default_factory=list)
    issued_sessions: Set[str] = field(default_factory=set)
    tainted: Dict[str, Set[str]] = field(default_factory=dict)
    upstream_calls: int = 0
    _server: Any = None
    _failures: Dict[str, Tuple[int, int]] = field(default_factory=dict)
    _lock: Any = field(default_factory=threading.RLock)

    def approve(self, action_id: str) -> bool:
        return self._decide(action_id, True)

    def deny(self, action_id: str, reason: Optional[str] = None) -> bool:
        return self._decide(action_id, False, reason)

    def fail_next(self, path: str, n: int, status: int = 503) -> None:
        """Fail the next `n` requests to `path` with `status` (0 drops the connection)."""
        self._failures[path] = (n, status)

    def mint(self, claims: dict, header: Optional[dict] = None, signer: Optional[Ed25519Signer] = None) -> str:
        """Sign any claims with any header: for building bad receipts in tests."""
        h = {"alg": "EdDSA", "kid": self.kid, "typ": "assay-receipt+jwt", **(header or {})}
        h = {k: v for k, v in h.items() if v is not None}
        signing_input = f"{_b64u(json.dumps(h, separators=(',', ':')).encode())}.{_b64u(json.dumps(claims, separators=(',', ':')).encode())}"
        return f"{signing_input}.{_b64u((signer or self.signer).sign(signing_input.encode('ascii')))}"

    def close(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()

    # The rest is the server's own logic.
    _mandate: dict = field(default_factory=lambda: dict(DEFAULT_MANDATE))
    _by_idem: Dict[str, str] = field(default_factory=dict)
    _seen: Set[str] = field(default_factory=set)
    _issued: Set[str] = field(default_factory=set)
    _proxy_calls: Dict[str, dict] = field(default_factory=dict)

    def _issue_receipt(self, a: dict, human: bool) -> None:
        iat = int(time.time())
        req = a["request"]
        claims: Dict[str, Any] = {"iss": self.url, "sub": self.agent_id, "act": a["id"], "typ": a["type"]}
        p = req.get("payment")
        if p:
            claims.update(amt=p["amount"], cur=p["currency"], mer=_host((p.get("merchant") or {}).get("domain")))
        if a["type"] == "tool.call" and (req.get("target") or {}).get("domain"):
            claims["mer"] = _host(req["target"]["domain"])
        claims.update(mdt=self._mandate["id"], hum=human, iat=iat, exp=iat + 300, jti=_b64u(secrets.token_bytes(18)))
        self._issued.add(claims["jti"])
        a.update(receipt=self.mint(claims), expiresAt=_iso(iat + 300), human=human)

    def _evaluate(self, req: dict) -> dict:
        m = self._mandate
        signals: List[dict] = []
        reasons: List[str] = []
        declared = req.get("provenance") if isinstance(req.get("provenance"), list) else []
        seen_in = sorted(self.tainted.get((req.get("session") or {}).get("id") or "", set()))
        declared_trusted = bool(declared) and all((p or {}).get("source") in ("user", "agent") for p in declared)
        prov = declared + [{"source": s, "detail": "seen by the gateway"} for s in seen_in]
        untrusted = not prov or any((p or {}).get("source") not in ("user", "agent") for p in prov)
        mismatch = ({"id": "provenance_mismatch", "severity": "high", "effect": "approval",
                     "detail": f"the agent declared only trusted sources, but the gateway saw {', '.join(seen_in)} content enter this session"}
                    if seen_in and declared_trusted else None)

        def deny(sig: str, detail: str, reason: str) -> dict:
            signals.append({"id": sig, "severity": "high", "detail": detail})
            return {"decision": "deny", "reasons": [reason], "signals": signals}

        t = req.get("type")
        if t == "payment":
            p = req.get("payment") or {}
            d = _host((p.get("merchant") or {}).get("domain"))
            if d not in m["merchants"]:
                near = next((k for k in m["merchants"] + _KNOWN if _edit_distance(k, d) <= 2), None)
                if near:
                    return deny("lookalike_domain", f"{d} looks like {near}", f"{d} looks like {near}; lookalike domains are refused")
            if p.get("currency") != m["currency"]:
                return deny("currency_mismatch", f"{p.get('currency')} is not {m['currency']}", f"the mandate is in {m['currency']}")
            if p["amount"] > m["per_transaction"]:
                return deny("over_transaction", "above the per-transaction limit",
                            f"{_money(p['amount'])} is above {_money(m['per_transaction'])} per transaction in {m['title']}")
            reasons.append(f"within {m['title']}: {_money(p['amount'])} of {_money(m['per_transaction'])} per transaction")
            if mismatch:
                signals.append(mismatch)
            if untrusted:
                signals.append({"id": "rule_of_two", "severity": "high", "detail": "untrusted input, money, and an external effect in one request"})
            if p["amount"] > m["approve_above"]:
                signals.append({"id": "approve_above", "severity": "medium", "detail": "above the approval threshold"})
                reasons = [f"{_money(p['amount'])} is above the {_money(m['approve_above'])} you asked to approve in {m['title']}"]
            if d not in m["merchants"]:
                signals.append({"id": "new_merchant", "severity": "medium", "detail": f"{d} is new"})
            return {"decision": "approval_required" if signals else "allow", "reasons": reasons, "signals": signals}
        if t == "tool.call":
            d = _host((req.get("target") or {}).get("domain"))
            if d and d in m["blocked_domains"]:
                return deny("recipient_not_allowed", f"{d} is blocked", f"no mandate lets this agent reach {d}")
            if mismatch:
                signals.append(mismatch)
            if re.search(m["approve_tools"], str(req.get("summary") or ""), re.I):
                signals.append({"id": "sensitive_tool", "severity": "medium", "detail": "this tool call changes something that matters"})
            reasons.append("a person must approve this tool call" if signals else f"{d or 'the tool'} is covered by the fake tools mandate")
            return {"decision": "approval_required" if signals else "allow", "reasons": reasons, "signals": signals}
        if t == "data.release":
            dd = req.get("data") or {}
            r = _host(dd.get("recipient"))
            if r not in m["recipients"]:
                return deny("recipient_not_allowed", f"{r} is not covered", f"no mandate lets this agent share data with {r}")
            extra = [f for f in dd.get("fields") or [] if f not in m["fields"]]
            if extra:
                return deny("no_mandate", f"fields {', '.join(extra)}", f"no mandate covers {', '.join(extra)}")
            return {"decision": "allow", "reasons": [f"{', '.join(dd.get('fields') or [])} may go to {r}"], "signals": [], "grant": dd.get("fields")}
        return deny("no_mandate", "nothing authorises this action type", f"no mandate lets this agent do {t}")

    def _out(self, a: dict, **extra) -> dict:
        o: Dict[str, Any] = {"id": a["id"], "decision": a["decision"], "status": a["status"], "reasons": a["reasons"],
                             "mandateId": None if a["decision"] == "deny" else self._mandate["id"],
                             "risk": {"score": min(100, len(a["signals"]) * 30), "signals": a["signals"]}}
        if a["decision"] == "allow" and a.get("receipt"):
            o.update(receipt=a["receipt"], expiresAt=a["expiresAt"], human=a["human"])
        if a["decision"] == "approval_required":
            o["approval"] = {"id": a["approval_id"], "url": f"{self.url}/app/approvals/{a['approval_id']}", "expiresAt": a["approval_expires"]}
            o["expiresAt"] = a["approval_expires"]
        if a.get("settled_at"):
            o["settlement"] = {"status": a["status"], "amount": a.get("settled_amount"), "at": a["settled_at"], "incident": a.get("incident", False)}
        o.update(extra)
        return o

    def _authorize(self, body: dict) -> Tuple[int, dict]:
        if not body.get("type") or not body.get("summary"):
            return 400, {"error": {"type": "invalid_request", "message": "type and summary are required"}}
        if body["type"] == "payment":
            amt = (body.get("payment") or {}).get("amount")
            if not isinstance(amt, int) or isinstance(amt, bool):
                return 400, {"error": {"type": "invalid_request", "message": "payment.amount must be a whole number of minor units"}}
        s = body.get("session")
        if s is not None:
            if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not re.match(r"^[\x21-\x7e]{1,128}$", s["id"]):
                return 400, {"error": {"type": "invalid_request", "message": "session.id must be 1 to 128 printable characters with no spaces"}}
            if s.get("client") is not None and s["client"] not in _KNOWN_CLIENTS:
                return 400, {"error": {"type": "invalid_request", "message": "session.client must be a known client id such as claude-code, openai-sdk or custom"}}
        key = body.get("idempotencyKey")
        if key and key in self._by_idem:
            return 200, self._out(self.actions[self._by_idem[key]], idempotentReplay=True)
        r = self._evaluate(body)
        a = {"id": _rid("act"), "type": body["type"], "request": body, "decision": r["decision"], "reasons": r["reasons"],
             "signals": r["signals"], "grant": r.get("grant"),
             "status": {"allow": "allowed", "deny": "denied"}.get(r["decision"], "pending_approval")}
        if a["decision"] == "allow":
            self._issue_receipt(a, False)
        if a["decision"] == "approval_required":
            a["approval_id"] = _rid("apr")
            a["approval_expires"] = _iso(time.time() + 1800)
        self.actions[a["id"]] = a
        if key:
            self._by_idem[key] = a["id"]
        extra = {}
        if a["decision"] == "allow" and a.get("grant"):
            extra["released"] = {f: _VAULT.get(f) for f in a["grant"]}
        return 200, self._out(a, **extra)

    def _decide(self, action_id: str, approve: bool, reason: Optional[str] = None) -> bool:
        with self._lock:
            a = self.actions.get(action_id)
            if not a or a["decision"] != "approval_required":
                return False
            if approve:
                a.update(decision="allow", status="allowed", reasons=a["reasons"] + ["approved by a person"])
                self._issue_receipt(a, True)
            else:
                a.update(decision="deny", status="denied", reasons=[reason or "refused by a person"])
            return True

    def _verify(self, token: str) -> dict:
        parts = str(token).split(".")
        if len(parts) != 3:
            return {"valid": False, "reason": "malformed"}
        try:
            pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
            header = json.loads(base64.urlsafe_b64decode(pad(parts[0])))
            claims = json.loads(base64.urlsafe_b64decode(pad(parts[1])))
            sig = base64.urlsafe_b64decode(pad(parts[2]))
        except ValueError:
            return {"valid": False, "reason": "malformed"}
        if header.get("alg") != "EdDSA" or header.get("typ") != "assay-receipt+jwt" or header.get("kid") != self.kid:
            return {"valid": False, "reason": "bad header or unknown key"}
        if not _ed.verify(self.signer.public_key, f"{parts[0]}.{parts[1]}".encode("ascii"), sig):
            return {"valid": False, "reason": "signature does not match: the receipt was altered or not issued by Immiscible"}
        if time.time() > claims.get("exp", 0) + 30:
            return {"valid": False, "reason": "expired", "expired": True}
        if claims.get("jti") not in self._issued:
            return {"valid": False, "reason": "not a receipt this deployment issued"}
        if claims["jti"] in self._seen:
            return {"valid": False, "replayed": True, "claims": claims, "reason": "this receipt has already been verified once; receipts are single use"}
        self._seen.add(claims["jti"])
        return {"valid": True, "claims": claims}

    def _observe(self, body: dict, sid: Optional[str]) -> None:
        if not sid:
            return
        names: Dict[str, str] = {}
        msgs = body.get("messages") if isinstance(body.get("messages"), list) else []
        for m in msgs:
            for b in m.get("content") if isinstance(m.get("content"), list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    names[b.get("id")] = b.get("name")
            for c in m.get("tool_calls") or []:
                names[c.get("id")] = (c.get("function") or {}).get("name")
        web = lambda n: bool(re.search(r"fetch|search|web|browse", n or "unknown", re.I))  # noqa: E731
        dirty = False
        for m in msgs:
            for b in m.get("content") if isinstance(m.get("content"), list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_result" and web(names.get(b.get("tool_use_id"))):
                    dirty = True
            if m.get("role") == "tool" and web(names.get(m.get("tool_call_id"))):
                dirty = True
        self.tainted.setdefault(sid, set())
        if dirty:
            self.tainted[sid].add("web")

    def _model(self, protocol: str, body: dict) -> dict:
        msgs = body.get("messages") if isinstance(body.get("messages"), list) else []
        last = msgs[-1] if msgs else {}

        def text_of(m: Any) -> str:
            c = m.get("content") if isinstance(m, dict) else None
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return " ".join(str(b.get("text") or (b.get("content") if isinstance(b.get("content"), str) else "")) for b in c if isinstance(b, dict))
            return ""

        if protocol == "openai":
            tool_result = text_of(last) if last.get("role") == "tool" else None
        else:
            blocks = [b for b in (last.get("content") if isinstance(last.get("content"), list) else []) if isinstance(b, dict) and b.get("type") == "tool_result"]
            tool_result = " ".join(b["content"] if isinstance(b.get("content"), str) else text_of({"content": b.get("content")}) for b in blocks) if blocks else None
        ask = re.search(r"CALL\s+([A-Za-z0-9_-]+)\s+(\{.*\})", text_of(last), re.S) if last.get("role") == "user" and tool_result is None else None
        if protocol == "openai":
            base = {"id": _rid("chatcmpl"), "object": "chat.completion", "created": int(time.time()), "model": body.get("model", "fake"),
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
            if ask:
                return {**base, "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None,
                        "tool_calls": [{"id": _rid("call"), "type": "function", "function": {"name": ask.group(1), "arguments": ask.group(2)}}]}}]}
            return {**base, "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": f"done: {tool_result}" if tool_result is not None else "ok"}}]}
        base = {"id": _rid("msg"), "type": "message", "role": "assistant", "model": body.get("model", "fake"), "usage": {"input_tokens": 10, "output_tokens": 5}, "stop_sequence": None}
        if ask:
            return {**base, "content": [{"type": "tool_use", "id": _rid("toolu"), "name": ask.group(1), "input": json.loads(ask.group(2))}], "stop_reason": "tool_use"}
        return {**base, "content": [{"type": "text", "text": f"done: {tool_result}" if tool_result is not None else "ok"}], "stop_reason": "end_turn"}

    def _proxy(self, msg: dict, session_header: Optional[str]) -> Tuple[int, dict, Dict[str, str]]:
        mid = msg.get("id")
        ok = lambda result, headers=None: (200, {"jsonrpc": "2.0", "id": mid, "result": result}, headers or {})  # noqa: E731
        err = lambda code, message, data=None: (200, {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message, **({"data": data} if data else {})}}, {})  # noqa: E731
        method = msg.get("method")
        if method == "initialize":
            return ok({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "immiscible-proxy-fake-shop", "version": "1"}},
                      {"mcp-session-id": f"mps_{secrets.token_hex(16)}"})
        if method == "tools/list":
            return ok({"tools": [{"name": "search", "description": "search the shop", "inputSchema": {"type": "object"}},
                                 {"name": "buy", "description": "buy", "inputSchema": {"type": "object"}}]})
        if method != "tools/call":
            return err(-32601, "method not found")
        params = msg.get("params") or {}
        name, args, meta = params.get("name"), params.get("arguments") or {}, params.get("_meta") or {}
        digest = hashlib.sha256(f"{name}\n{json.dumps(args, sort_keys=True)}".encode()).hexdigest()
        a = None
        if meta.get("immiscible/approvalId"):
            a = next((x for x in self.actions.values() if x.get("approval_id") == meta["immiscible/approvalId"]), None)
            if not a or self._proxy_calls.get(a["id"], {}).get("digest") != digest:
                return err(-32602, "that approval was for a different tool call")
        elif meta.get("immiscible/idempotencyKey") in self._by_idem:
            a = self.actions[self._by_idem[meta["immiscible/idempotencyKey"]]]
        if a is None:
            if name == "buy":
                request = {"type": "payment", "summary": f"buy through the proxy: {args.get('amount')} at {args.get('merchant')}",
                           "payment": {"amount": args.get("amount"), "currency": "GBP", "merchant": {"domain": args.get("merchant")}}}
            else:
                request = {"type": "tool.call", "summary": f"{name} through the proxy", "target": {"domain": "shop.example"}}
            request["provenance"] = [{"source": "agent", "detail": "tool call through the fake proxy"}]
            if meta.get("immiscible/idempotencyKey"):
                request["idempotencyKey"] = meta["immiscible/idempotencyKey"]
            status, out = self._authorize(request)
            if status != 200:
                return err(-32602, out["error"]["message"])
            a = self.actions[out["id"]]
            self._proxy_calls[a["id"]] = {"digest": digest, "forwarded": False}
        if a["decision"] == "deny":
            return err(-32003, f"Immiscible refused this call to fake-shop: {' '.join(a['reasons'])}",
                       {"decision": "deny", "actionId": a["id"], "reasons": a["reasons"], "signals": [{"id": s["id"]} for s in a["signals"]]})
        if a["decision"] == "approval_required":
            d = self._out(a)
            return ok({"content": [{"type": "text", "text": f"A person must approve this call to fake-shop before it runs. Approval: {d['approval']['url']}."}],
                       "structuredContent": {"decision": "approval_required", "actionId": a["id"], "approval": d["approval"], "reasons": a["reasons"]}, "isError": True})
        pc = self._proxy_calls[a["id"]]
        if pc["forwarded"]:
            return err(-32006, f"This call was already made (action {a['id']})")
        pc["forwarded"] = True
        self.upstream_calls += 1
        a.update(settled_at=_iso(time.time()), status="completed", settled_amount=(a["request"].get("payment") or {}).get("amount"))
        return ok({"content": [{"type": "text", "text": f"fake-shop did {name} with {json.dumps(args)}"}], "isError": False, "_meta": {"immiscible/actionId": a["id"]}})

    def _route(self, method: str, path: str, headers: Dict[str, str], body: Any) -> Tuple[int, Any, Dict[str, str]]:
        n_status = self._failures.get(path)
        if n_status and n_status[0] > 0:
            self._failures[path] = (n_status[0] - 1, n_status[1])
            if n_status[1] == 0:
                return -1, None, {}
            return n_status[1], {"error": {"type": "fake_failure", "message": f"injected {n_status[1]}"}}, {}
        auth = headers.get("authorization", "")
        bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else headers.get("x-api-key")
        authed = bearer == self.agent_key
        no_key = (401, {"error": {"type": "invalid_api_key", "message": "unknown or revoked key"}}, {})
        body = body if isinstance(body, dict) else {}
        if method == "GET" and path == "/.well-known/immiscible-keys.json":
            return 200, self.jwks, {}
        if method == "POST" and path == "/v1/verify":
            if not isinstance(body.get("receipt"), str):
                return 400, {"valid": False, "reason": 'send { "receipt": "<compact JWS>" }'}, {}
            return 200, self._verify(body["receipt"]), {}
        m = re.match(r"^/__fake/actions/([^/]+)/(approve|deny)$", path)
        if method == "POST" and m:
            return (200, self._out(self.actions[m.group(1)]), {}) if self._decide(m.group(1), m.group(2) == "approve") else (409, {"error": {"type": "not_pending"}}, {})
        if method == "POST" and path == "/v1/actions/authorize":
            if not authed:
                return no_key
            b = dict(body)
            if b.get("idempotencyKey") is None and headers.get("idempotency-key"):
                b["idempotencyKey"] = headers["idempotency-key"]
            s, out = self._authorize(b)
            return s, out, {}
        if method == "POST" and path in ("/v1/chat/completions", "/anthropic/v1/messages"):
            if not authed:
                return no_key
            protocol = "anthropic" if path.startswith("/anthropic") else "openai"
            presented = headers.get("x-immiscible-session")
            issue = None
            if presented is not None:
                if presented not in self.issued_sessions:
                    return 400, {"error": {"type": "invalid_session", "message": "x-immiscible-session was not issued to this key; drop it to be given a new one"}}, {}
                sid = issue = presented
            elif headers.get("x-immiscible-client-session") is not None:
                sid = headers["x-immiscible-client-session"]
            elif not (body.get("user") if protocol == "openai" else (body.get("metadata") or {}).get("user_id")):
                sid = issue = f"imss_{_b64u(secrets.token_bytes(12))}_{_b64u(secrets.token_bytes(8))}"
                self.issued_sessions.add(sid)
            else:
                sid = None
            self._observe(body, sid)
            return 200, self._model(protocol, body), ({"x-immiscible-session": issue} if issue else {})
        if method == "POST" and path == "/mcp/proxy/fake-shop":
            if not authed:
                return 401, {"jsonrpc": "2.0", "id": body.get("id"), "error": {"code": -32001, "message": "unknown or revoked key"}}, {}
            if "id" not in body:
                return 202, {}, {}
            return self._proxy(body, headers.get("mcp-session-id"))
        m = re.match(r"^/v1/actions/([^/]+)$", path)
        if method == "GET" and m:
            if not authed:
                return no_key
            a = self.actions.get(m.group(1))
            return (200, self._out(a), {}) if a else (404, {"error": {"type": "not_found", "message": "no such action for this agent"}}, {})
        m = re.match(r"^/v1/actions/([^/]+)/settle$", path)
        if method == "POST" and m:
            if not authed:
                return no_key
            a = self.actions.get(m.group(1))
            if not a:
                return 404, {"error": {"type": "not_found", "message": "no such action for this agent"}}, {}
            if body.get("status") not in ("completed", "failed", "cancelled"):
                return 400, {"error": {"type": "invalid_status", "message": "status must be completed, failed or cancelled"}}, {}
            if a["decision"] != "allow":
                return 409, {"error": {"type": "not_allowed", "message": "only an allowed action can be settled"}}, {}
            if a.get("settled_at"):
                return 409, {"error": {"type": "already_settled", "message": "this action was already settled"}}, {}
            authorised = (a["request"].get("payment") or {}).get("amount")
            amount = body.get("amount", authorised if body["status"] == "completed" else None)
            a.update(settled_amount=amount, incident=authorised is not None and body["status"] == "completed" and (amount or 0) > authorised,
                     settled_at=_iso(time.time()), status=body["status"])
            self.settlements.append({"actionId": a["id"], **body, "incident": a["incident"]})
            return 200, self._out(a), {}
        if method == "POST" and path == "/v1/outcomes":
            if not authed:
                return no_key
            self.outcomes.append(body)
            return 200, {"taskId": body.get("taskId"), "status": body.get("status")}, {}
        return 404, {"error": {"type": "not_found", "message": path}}, {}


def start_fake(*, port: int = 0, agent_key: str = "ask_fake_agent_key", agent_id: str = "agt_fake") -> FakeImmiscible:
    """Start the fake on 127.0.0.1 in a background thread. Call `.close()` when done."""
    signer = Ed25519Signer()
    jwk = signer.jwk("pending")
    kid = _b64u(hashlib.sha256(json.dumps({"crv": "Ed25519", "kty": "OKP", "x": jwk["x"]}, separators=(",", ":")).encode()).digest())[:22]
    fake = FakeImmiscible(url="", agent_key=agent_key, agent_id=agent_id, kid=kid, jwks={"keys": [signer.jwk(kid)]}, signer=signer)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:  # quiet
            pass

        def _handle(self) -> None:
            n = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(n) if n else b""
            try:
                body = json.loads(raw) if raw else None
            except ValueError:
                body = None
            path = self.path.split("?")[0]
            headers = {k.lower(): v for k, v in self.headers.items()}
            with fake._lock:
                fake.requests.append({"method": self.command, "path": path, "headers": headers, "body": body})
                status, out, extra = fake._route(self.command, path, headers, body)
            if status == -1:
                self.close_connection = True
                self.connection.shutdown(2)
                return
            m = _TRACEPARENT.match(headers.get("traceparent", ""))
            tp = f"00-{m.group(1) if m else secrets.token_hex(16)}-{secrets.token_hex(8)}-{m.group(3) if m else '01'}"
            data = json.dumps(out if out is not None else {}).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.send_header("traceparent", tp)
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        do_GET = _handle
        do_POST = _handle

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    fake._server = server
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return fake
