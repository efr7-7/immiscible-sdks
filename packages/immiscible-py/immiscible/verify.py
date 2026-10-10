"""Receipts: check that an agent's action was authorised, and within what limits.

Offline verification checks the compact JWS with the pure-Python Ed25519
verifier in `ed25519.py`, against the issuer's published key set (fetched and
cached) or against a key set you pinned (`jwks=`, nothing fetched at all). The header is
checked before any crypto runs: EdDSA only (so `alg: none` and HMAC
confusion fail there), type `assay-receipt+jwt`, and a key id the issuer
published. The key set is cached, and refetched when an unknown key id
appears (at most every 30 seconds), which is how rotation reaches you.

Offline checks cannot see replays. For payments, also call `verify_online`
(or pass online=True) once per order: the issuer marks a receipt seen, and a
second check reports it replayed.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Optional, Union

from . import ed25519

__all__ = ["verify_receipt", "verify_online", "fetch_jwks", "pin_jwks", "VerifyResult", "clear_jwks_cache", "decode_receipt_unverified",
           "cart_digest", "canonical_cart", "RECEIPT_TYP", "JWKS_PATH", "REASONS"]

RECEIPT_TYP = "assay-receipt+jwt"
JWKS_PATH = "/.well-known/immiscible-keys.json"
_ACCEPTED_ALGS = {"EdDSA", "Ed25519"}
_B64U = re.compile(r"^[A-Za-z0-9_-]+$")
_JWKS_TTL = 300.0
_JWKS_MIN_REFETCH = 30.0
_MAX_TOKEN = 8192

REASONS = {
    "malformed": "not a compact JWS (three base64url parts of JSON)",
    "unsupported_alg": "the algorithm is not EdDSA; Immiscible receipts are only ever EdDSA",
    "wrong_typ": f"the token type is not {RECEIPT_TYP}",
    "unsupported_crit": "the token carries a critical header this verifier does not understand",
    "missing_kid": "the token names no key id",
    "unknown_kid": "signed by a key the issuer does not publish",
    "jwks_unavailable": "the issuer's public keys could not be fetched, so nothing can be trusted",
    "bad_signature": "the signature does not match: the receipt was altered or not issued by Immiscible",
    "missing_claim": "a required claim is missing",
    "expired": "the receipt has expired",
    "issued_in_future": "the receipt claims to be issued in the future",
    "not_yet_valid": "the receipt is not valid yet",
    "too_old": "the receipt is older than you allow",
    "wrong_issuer": "issued by a different Immiscible deployment than the one you trust",
    "type_mismatch": "the receipt is for a different kind of action",
    "amount_mismatch": "the authorised amount does not match this order",
    "currency_mismatch": "the authorised currency does not match this order",
    "merchant_mismatch": "the receipt was authorised for a different merchant",
    "agent_mismatch": "the receipt was issued to a different agent",
    "mandate_mismatch": "the receipt was allowed under a different mandate",
    "human_required": "a person did not approve this specific action",
    "audience_mismatch": "the receipt was issued for a different party",
    "cart_mismatch": "the receipt was authorised for a different basket, or names none",
    "replayed": "this receipt has already been used; receipts are single use",
    "revoked": "the receipt was revoked by its owner",
    "rejected_by_issuer": "the issuer rejected this receipt",
    "verify_unavailable": "the online check could not be completed, so the receipt is not accepted",
}


@dataclass
class VerifyResult:
    valid: bool
    reason: Optional[str] = None
    message: Optional[str] = None
    claims: Optional[Dict[str, Any]] = None
    header: Optional[Dict[str, Any]] = None
    replayed: Optional[bool] = None

    def __bool__(self) -> bool:
        return self.valid


class _Fail(Exception):
    def __init__(self, reason: str, detail: Optional[str] = None):
        super().__init__(detail or REASONS.get(reason, reason))
        self.reason = reason


def _b64u(s: str) -> bytes:
    if not isinstance(s, str) or not _B64U.match(s):
        raise _Fail("malformed")
    try:
        raw = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except (binascii.Error, ValueError):
        raise _Fail("malformed") from None
    # Only the canonical spelling of these bytes, so one signature has one spelling.
    if base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") != s:
        raise _Fail("malformed")
    return raw


def _json_part(s: str) -> dict:
    try:
        v = json.loads(_b64u(s).decode("utf-8"))
    except _Fail:
        raise
    except (UnicodeDecodeError, ValueError):
        raise _Fail("malformed") from None
    if not isinstance(v, dict):
        raise _Fail("malformed")
    return v


def _domain(v: Any) -> Optional[str]:
    if not isinstance(v, str):
        return None
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", v.strip().lower())
    s = re.sub(r":\d+$", "", re.split(r"[/?#]", s)[0]).rstrip(".")
    return (s[4:] if s.startswith("www.") else s) or None


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# ------------------------------------------------------------------ JWKS

_cache: Dict[str, dict] = {}
_lock = threading.Lock()


def clear_jwks_cache() -> None:
    """Forget every cached key set."""
    with _lock:
        _cache.clear()


def _keys_from(jwks: Any) -> Dict[str, bytes]:
    out: Dict[str, bytes] = {}
    for k in (jwks or {}).get("keys", []) if isinstance(jwks, dict) else []:
        if not isinstance(k, dict) or k.get("kty") != "OKP" or k.get("crv") != "Ed25519":
            continue
        if not isinstance(k.get("x"), str) or not isinstance(k.get("kid"), str):
            continue
        if k.get("alg") and k["alg"] not in _ACCEPTED_ALGS:
            continue
        if k.get("use") and k["use"] != "sig":
            continue
        try:
            x = _b64u(k["x"])
        except _Fail:
            continue
        if len(x) == 32:
            out[k["kid"]] = x
    return out


def _default_fetch(url: str) -> Any:
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read().decode("utf-8"))


def pin_jwks(jwks: Union[dict, str]) -> dict:
    """Parse a pinned key set (a dict or its JSON text) and check it holds at least one Ed25519 signing key."""
    doc = json.loads(jwks) if isinstance(jwks, str) else jwks
    keys = [k for k in (doc or {}).get("keys", []) if isinstance(k, dict) and k.get("kty") == "OKP" and k.get("crv") == "Ed25519"
            and isinstance(k.get("x"), str) and isinstance(k.get("kid"), str)] if isinstance(doc, dict) else []
    if not keys:
        raise TypeError("pin_jwks: the key set holds no Ed25519 signing key (kty OKP, crv Ed25519, with x and kid)")
    return {"keys": keys}


def fetch_jwks(issuer: str, *, timeout: float = 10.0, opener: Optional[Callable] = None) -> dict:
    """Fetch an issuer's key set once, to pin: store it with your configuration and pass it as `jwks`."""
    req = urllib.request.Request(issuer.rstrip("/") + JWKS_PATH, headers={"accept": "application/json"})
    with (opener or urllib.request.urlopen)(req, timeout=timeout) as res:
        return pin_jwks(json.loads(res.read().decode("utf-8")))


def _resolve_key(kid: str, *, jwks, jwks_url: Optional[str], fetch: Callable[[str], Any], now: float) -> bytes:
    if jwks is not None:
        k = _keys_from(jwks).get(kid)
        if k is None:
            raise _Fail("unknown_kid")
        return k
    with _lock:
        entry = _cache.get(jwks_url)
        stale = entry is None or now - entry["at"] > _JWKS_TTL
        missing = entry is not None and kid not in entry["keys"] and now - entry["last"] > _JWKS_MIN_REFETCH
        if stale or missing:
            try:
                doc = fetch(jwks_url)
            except Exception as e:  # any transport failure fails closed
                if entry is not None:
                    entry["last"] = now
                if entry is None or kid not in entry["keys"]:
                    raise _Fail("jwks_unavailable", f"{REASONS['jwks_unavailable']} ({e})") from None
            else:
                entry = {"at": now, "last": now, "keys": _keys_from(doc)}
                _cache[jwks_url] = entry
        k = entry["keys"].get(kid) if entry else None
    if k is None:
        raise _Fail("unknown_kid")
    return k


# --------------------------------------------------------------- bindings

def _is_whole(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and -(2 ** 53) < v < 2 ** 53


# JavaScript's String.prototype.trim set, so a line trims to the same bytes here as on the server.
_JS_WS = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def canonical_cart(cart: Iterable[dict], currency: str) -> str:
    """The canonical bytes of a basket (as text): schema, currency, and each line's sku, url, quantity and unit price, in order.

    The same bytes as the server and the JavaScript SDK: sorted keys, no whitespace, non-ASCII kept as is.
    """
    items = []
    for i, line in enumerate(list(cart or [])):
        if not isinstance(line, dict):
            raise TypeError(f"canonical_cart: line {i} must be a dict")
        sku = line.get("sku").strip(_JS_WS) if isinstance(line.get("sku"), str) else None
        url = line.get("url").strip(_JS_WS) if isinstance(line.get("url"), str) else None
        if not sku and not url:
            raise TypeError(f"canonical_cart: line {i} needs a sku or a url")
        q, p = line.get("quantity"), line.get("unitPrice", line.get("unit_price"))
        if not _is_whole(q) or q < 1 or not _is_whole(p) or p < 0:
            raise TypeError(f"canonical_cart: line {i} needs a whole quantity of 1 or more and a whole unitPrice of 0 or more")
        item: Dict[str, Any] = {}
        if sku:
            item["sku"] = sku
        if url:
            item["url"] = url
        item["quantity"] = q
        item["unitPrice"] = p
        items.append(item)
    if not items:
        raise TypeError("canonical_cart: the cart must list at least one line")
    doc = {"schema": "assay.cart.v1", "currency": str(currency or "").upper(), "items": items}
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def cart_digest(cart: Iterable[dict], currency: str) -> str:
    """SHA-256 of canonical_cart, base64url: what a v2 receipt's crt claim holds for that basket."""
    raw = hashlib.sha256(canonical_cart(cart, currency).encode("utf-8")).digest()
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _check_expect(claims: dict, expect: Optional[dict]) -> None:
    if not expect:
        return
    if expect.get("type") is not None and claims.get("typ") != expect["type"]:
        raise _Fail("type_mismatch")
    if expect.get("amount") is not None and claims.get("amt") != expect["amount"]:
        raise _Fail("amount_mismatch", f"{REASONS['amount_mismatch']}: authorised {claims.get('amt')}, order is {expect['amount']}")
    if expect.get("currency") is not None and str(claims.get("cur") or "").upper() != str(expect["currency"]).upper():
        raise _Fail("currency_mismatch")
    if expect.get("merchant") is not None:
        want = expect["merchant"]
        wants = [want] if isinstance(want, str) else list(want)
        if _domain(claims.get("mer")) not in [_domain(w) for w in wants]:
            raise _Fail("merchant_mismatch", f"{REASONS['merchant_mismatch']}: {claims.get('mer')}")
    if expect.get("agent") is not None and claims.get("sub") != expect["agent"]:
        raise _Fail("agent_mismatch")
    if expect.get("mandate") is not None and claims.get("mdt") != expect["mandate"]:
        raise _Fail("mandate_mismatch")
    if (expect.get("human_approved") is True or expect.get("humanApproved") is True) and claims.get("hum") is not True:
        raise _Fail("human_required")
    if expect.get("audience") is not None:
        aud = claims.get("aud")
        if not isinstance(aud, str) or _domain(aud) != _domain(expect["audience"]):
            raise _Fail("audience_mismatch", f"{REASONS['audience_mismatch']}: {aud}")
    want_digest = expect.get("cart_digest", expect.get("cartDigest"))
    if expect.get("cart") is not None or want_digest is not None:
        if not isinstance(want_digest, str):
            try:
                want_digest = cart_digest(expect["cart"], str(claims.get("cur") or ""))
            except (TypeError, KeyError, ValueError):  # UnicodeError is a ValueError: a lone surrogate
                want_digest = None
        if not want_digest or not isinstance(claims.get("crt"), str) or want_digest != claims["crt"]:
            raise _Fail("cart_mismatch")


def decode_receipt_unverified(token: str) -> Dict[str, dict]:
    """Read header and claims WITHOUT checking anything. For logs only."""
    h, p, *_ = str(token).split(".")
    return {"header": _json_part(h), "claims": _json_part(p)}


def verify_receipt(token: str, issuer: Optional[str] = None, *, jwks: Union[dict, str, None] = None, jwks_url: Optional[str] = None,
                   expect: Optional[dict] = None, clock_skew: float = 60, max_age: Optional[float] = None,
                   check_issuer: bool = True, now: Optional[float] = None, online: bool = False,
                   fetch: Optional[Callable[[str], Any]] = None, base_url: Optional[str] = None) -> VerifyResult:
    """Verify an Immiscible receipt. Never raises for a bad receipt.

    `issuer` is the Immiscible URL you trust (keys come from its JWKS, and `iss`
    must match it); or pass `jwks` for a fully offline check. `expect` binds
    the receipt to your order: {"amount": 6420, "currency": "GBP",
    "merchant": "ocado.com", "type": "payment", "agent": ..., "human_approved": True}.
    """
    if not issuer and jwks is None and not jwks_url:
        raise TypeError("verify_receipt: pass issuer (the Immiscible URL you trust) or a pinned jwks. Never trust the iss inside the token to tell you where its keys are.")
    if jwks is not None:
        jwks = pin_jwks(jwks)
    t = time.time() if now is None else float(now)
    try:
        if not isinstance(token, str) or len(token) > _MAX_TOKEN:
            raise _Fail("malformed")
        parts = token.strip().split(".")
        if len(parts) != 3:
            raise _Fail("malformed")
        header = _json_part(parts[0])
        if header.get("alg") not in _ACCEPTED_ALGS:
            raise _Fail("unsupported_alg", f"{REASONS['unsupported_alg']} (got {str(header.get('alg'))[:20]})")
        typ = str(header.get("typ") or "").lower()
        if typ.startswith("application/"):
            typ = typ[len("application/"):]
        if typ != RECEIPT_TYP:
            raise _Fail("wrong_typ")
        if "crit" in header:
            raise _Fail("unsupported_crit")
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise _Fail("missing_kid")
        if not parts[2]:
            raise _Fail("bad_signature")
        sig = _b64u(parts[2])
        if len(sig) != 64:
            raise _Fail("bad_signature")
        url = jwks_url or (issuer.rstrip("/") + JWKS_PATH if issuer else None)
        key = _resolve_key(kid, jwks=jwks, jwks_url=url, fetch=fetch or _default_fetch, now=t)
        if not ed25519.verify(key, f"{parts[0]}.{parts[1]}".encode("ascii"), sig):
            raise _Fail("bad_signature")
        claims = _json_part(parts[1])
        exp, iat, nbf = claims.get("exp"), claims.get("iat"), claims.get("nbf")
        if not _num(exp):
            raise _Fail("missing_claim", f"{REASONS['missing_claim']}: exp")
        if t - clock_skew >= exp:
            raise _Fail("expired")
        if iat is not None:
            if not _num(iat):
                raise _Fail("missing_claim", f"{REASONS['missing_claim']}: iat")
            if iat > t + clock_skew:
                raise _Fail("issued_in_future")
            if max_age is not None and t - iat > max_age + clock_skew:
                raise _Fail("too_old")
        if _num(nbf) and nbf > t + clock_skew:
            raise _Fail("not_yet_valid")
        if issuer and check_issuer and str(claims.get("iss") or "").rstrip("/") != issuer.rstrip("/"):
            raise _Fail("wrong_issuer", f"{REASONS['wrong_issuer']} ({str(claims.get('iss'))[:80]})")
        _check_expect(claims, expect)
    except _Fail as f:
        return VerifyResult(False, f.reason, str(f))
    except ed25519.InvalidKey:
        return VerifyResult(False, "unknown_kid", REASONS["unknown_kid"])
    if online:
        if not (base_url or issuer):
            raise TypeError("verify_receipt: online=True needs issuer or base_url")
        on = verify_online(token, base_url or issuer, expect=expect)
        if not on.valid:
            return on
        return VerifyResult(True, claims=claims, header=header, replayed=False)
    return VerifyResult(True, claims=claims, header=header)


def verify_online(token: str, base_url: str, *, expect: Optional[dict] = None, timeout: float = 10.0,
                  opener: Optional[Callable] = None) -> VerifyResult:
    """Verify with the issuer, which also marks the receipt seen. The first check is the only one that passes.

    Fails closed: if the issuer cannot be reached, the receipt is not valid.
    """
    if not base_url:
        raise TypeError("verify_online: pass base_url (the Immiscible URL you trust)")
    # What the issuer can check before it marks the receipt used: a receipt for another
    # basket, party, merchant or a smaller amount is refused there and stays unused.
    # Everything is checked again here, exactly, afterwards.
    # Checked here first, on the claims as written: a receipt that cannot cover this order is refused without
    # asking the issuer, so it is not used up by a check the issuer does not make (type, agent, rule, person).
    if expect:
        try:
            pre = decode_receipt_unverified(token)["claims"]
        except Exception:
            pre = None
        if isinstance(pre, dict):
            try:
                _check_expect(pre, expect)
            except _Fail as f:
                return VerifyResult(False, f.reason, str(f), replayed=False)
    server_expect: Dict[str, Any] = {}
    e = expect or {}
    if e.get("amount") is not None:
        server_expect["amount"] = e["amount"]
    if e.get("currency") is not None:
        server_expect["currency"] = str(e["currency"]).upper()
    if isinstance(e.get("merchant"), str):
        server_expect["merchant"] = e["merchant"]
    if e.get("audience") is not None:
        server_expect["audience"] = e["audience"]
    if e.get("cart_digest", e.get("cartDigest")) is not None:
        server_expect["cartDigest"] = e.get("cart_digest", e.get("cartDigest"))
    elif e.get("cart") is not None:
        server_expect["cart"] = e["cart"]
    payload = {"receipt": token, "expect": server_expect} if server_expect else {"receipt": token}
    req = urllib.request.Request(
        base_url.rstrip("/") + "/v1/verify",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    try:
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as res:
            body = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except ValueError:
            body = None
    except Exception as e:  # transport failure: fail closed
        return VerifyResult(False, "verify_unavailable", f"{REASONS['verify_unavailable']} ({e})")
    if not isinstance(body, dict) or not isinstance(body.get("valid"), bool):
        return VerifyResult(False, "verify_unavailable", REASONS["verify_unavailable"])
    if body.get("replayed"):
        return VerifyResult(False, "replayed", body.get("reason") or REASONS["replayed"], claims=body.get("claims"), replayed=True)
    if not body["valid"]:
        codes = [c for c in (body.get("codes") or []) if c in REASONS]
        reason = "expired" if body.get("expired") else "revoked" if body.get("revoked") else codes[0] if codes else "rejected_by_issuer"
        return VerifyResult(False, reason, body.get("reason") or REASONS[reason])
    claims = body.get("claims") or {}
    try:
        _check_expect(claims, expect)
    except _Fail as f:
        return VerifyResult(False, f.reason, str(f), replayed=False)
    return VerifyResult(True, claims=claims, replayed=False)
