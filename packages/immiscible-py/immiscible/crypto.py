"""Crypto payments: decide, then sign. Standard library only.

Immiscible decides; it never holds funds, private keys or seed phrases, and
never signs or broadcasts a transaction. Your wallet does that, and these
helpers make sure it does so only after an allow:

    decide_then_sign(immiscible, payment, sign)
        asks POST /v1/actions/authorize, waits for a person if one is asked,
        checks the signed receipt covers exactly this transfer (asset,
        network, recipient, amount), and only then calls ``sign``.

    x402_request(immiscible, url, pay)
        fetches a resource; on HTTP 402 (x402, versions 1 and 2) asks
        Immiscible with the server's payment requirements and calls your x402
        signer ``pay`` only on allow.
        https://github.com/coinbase/x402/blob/main/specs/x402-specification-v1.md
        https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md

Amounts are decimal strings in the asset's own units ("12.50"), never floats.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
import warnings
from typing import Any, Callable, Dict, List, Optional

from .client import Decision
from .errors import ImmiscibleDeniedError, ImmiscibleError
from .verify import verify_receipt

__all__ = ["crypto_action", "receipt_covers", "from_atomic", "decide_then_sign", "x402_request", "X402_ASSETS"]

_DECIMALS = {"USDC": 6, "USDT": 6, "EURC": 6, "PYUSD": 6, "DAI": 18, "ETH": 18, "BTC": 8, "SOL": 9, "POL": 18, "AVAX": 18}
_NETWORKS = {
    "eip155:8453": "base", "eip155:84532": "base-sepolia", "eip155:1": "ethereum", "eip155:42161": "arbitrum",
    "eip155:10": "optimism", "eip155:137": "polygon", "eip155:43114": "avalanche",
}
_DEC = re.compile(r"^(\d+)(?:\.(\d+))?$")

#: Token contracts recognised in an x402 requirement, by network (USDC as Circle publishes it).
X402_ASSETS: Dict[str, Dict[str, Dict[str, Any]]] = {
    "base": {"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {"symbol": "USDC", "decimals": 6}},
    "base-sepolia": {"0x036cbd53842c5426634e7929541ec2318f3dcf7e": {"symbol": "USDC", "decimals": 6}},
    "ethereum": {"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {"symbol": "USDC", "decimals": 6}},
    "arbitrum": {"0xaf88d065e77c8cc2239327c5edb3a432268e5831": {"symbol": "USDC", "decimals": 6}},
    "optimism": {"0x0b2c639c533813f4aa9d7837caf62653d097ff85": {"symbol": "USDC", "decimals": 6}},
    "polygon": {"0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": {"symbol": "USDC", "decimals": 6}},
    "avalanche": {"0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": {"symbol": "USDC", "decimals": 6}},
}


def _net(n: str) -> str:
    return _NETWORKS.get(n, str(n).lower())


def _atomic(amount: str, decimals: int) -> Optional[int]:
    m = _DEC.match(str(amount).strip())
    if not m:
        return None
    frac = m.group(2) or ""
    if len(frac) > decimals:
        return None
    return int(m.group(1)) * 10 ** decimals + int(frac.ljust(decimals, "0") or "0")


def from_atomic(atomic: Any, decimals: int) -> str:
    """10000, 6 -> "0.01". Exact."""
    n = int(atomic)
    whole, frac = divmod(n, 10 ** decimals)
    f = str(frac).rjust(decimals, "0").rstrip("0")
    return f"{whole}.{f}" if f else str(whole)


def crypto_action(asset: str, network: str, amount: str, recipient: str, *, recipient_name: Optional[str] = None,
                  protocol: Optional[dict] = None, summary: Optional[str] = None, provenance: Optional[List[dict]] = None,
                  idempotency_key: Optional[str] = None) -> dict:
    """The authorize body for a crypto payment. Immiscible prices it; you never send a money value."""
    if not isinstance(amount, str) or not _DEC.match(amount):
        raise TypeError('crypto_action: amount must be a decimal string such as "12.50", never a number')
    crypto: Dict[str, Any] = {"asset": asset, "network": network, "amount": amount, "recipient": recipient}
    if recipient_name:
        crypto["recipientName"] = recipient_name
    if protocol:
        crypto["protocol"] = protocol
    action: Dict[str, Any] = {
        "type": "payment",
        "summary": summary or f"Pay {amount} {asset.upper()} to {recipient_name or recipient}",
        "payment": {"crypto": crypto},
    }
    if provenance:
        action["provenance"] = provenance
    if idempotency_key:
        action["idempotencyKey"] = idempotency_key
    return action


def receipt_covers(claims: dict, asset: str, network: str, amount: str, recipient: str) -> List[str]:
    """Does a receipt's ``cry`` claim cover this transfer? Returns the problems, if any."""
    c = (claims or {}).get("cry")
    if not c:
        return ["the receipt is not for a crypto payment"]
    bad = []
    if str(asset).upper() != c.get("ast"):
        bad.append(f"it is for {c.get('ast')}, not {asset}")
    if _net(network) != c.get("net"):
        bad.append(f"it is for {c.get('net')}, not {network}")
    to = str(c.get("to", ""))
    same = to.lower() == str(recipient).lower() if to.startswith("0x") else to == recipient
    if not same:
        bad.append(f"it pays {to}, not {recipient}")
    d = _DECIMALS.get(c.get("ast"), 18)
    want, have = _atomic(amount, d), _atomic(str(c.get("amt")), d)
    if want is None or have is None or want > have:
        bad.append(f"it authorises {c.get('amt')} {c.get('ast')}, less than {amount}")
    return bad


def _refuse(d: Decision, why: str) -> ImmiscibleDeniedError:
    return ImmiscibleDeniedError(Decision({**dict(d), "decision": "deny", "reasons": [why]}))


def decide_then_sign(immiscible: Any, payment: dict, sign: Callable[[Decision], Any], *, verify: Optional[dict] = None,
                     wait: bool = True, timeout: float = 600.0) -> Any:
    """Ask, then sign. ``sign`` runs only after an allow whose signed receipt covers exactly this transfer.

    ``payment`` is the keyword arguments of :func:`crypto_action`. ``sign`` may return
    ``{"txHash": "0x..."}``, which is reported back when the action is settled.
    Anything else raises ImmiscibleDeniedError and nothing is signed.
    """
    d = immiscible.decide(crypto_action(**payment), wait=wait, timeout=timeout)
    if not d.receipt:
        raise _refuse(d, "Allowed, but no receipt came back, so nothing is signed.")
    opts = {"issuer": immiscible.base_url, **(verify or {})}
    v = verify_receipt(d.receipt, **opts)
    if not v.valid:
        raise _refuse(d, f"The receipt did not verify ({v.reason}), so nothing is signed.")
    problems = receipt_covers(v.claims or {}, payment["asset"], payment["network"], payment["amount"], payment["recipient"])
    if problems:
        raise _refuse(d, f"The receipt does not cover this transfer: {'; '.join(problems)}.")
    try:
        out = sign(d)
    except BaseException:
        _settle(immiscible, d.id, "failed")
        raise
    tx = out.get("txHash") if isinstance(out, dict) else None
    _settle(immiscible, d.id, "completed", tx)
    return out


def _settle(immiscible: Any, action_id: str, status: str, tx: Optional[str] = None) -> None:
    try:
        body = {"status": status, **({"txHash": tx} if tx else {})}
        immiscible.request("POST", f"/v1/actions/{action_id}/settle", body, retry=True)
    except Exception as e:  # noqa: BLE001  a settlement never masks the payment's own result, but it is said
        warnings.warn(f"[immiscible] could not settle {action_id}: {e}", RuntimeWarning, stacklevel=3)


def _b64json(s: str) -> Any:
    return json.loads(base64.b64decode(s).decode("utf-8"))


def _fetch(url: str, headers: Dict[str, str]):
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310  the caller's own URL
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def x402_request(immiscible: Any, url: str, pay: Callable[[dict], str], *, provenance: Optional[List[dict]] = None,
                 headers: Optional[Dict[str, str]] = None, assets: Optional[dict] = None, verify: Optional[dict] = None,
                 wait: bool = True, fetch: Callable = _fetch):
    """GET an x402 resource, paying only when Immiscible allows it.

    ``pay(info)`` is your x402 signer: given ``{"requirements", "payment_required", "decision"}``
    it returns the payment header value (base64 JSON). It is called only on allow.
    Returns ``(status, headers, body)`` of the paid response. A refusal raises
    ImmiscibleDeniedError and ``pay`` is never called.
    """
    h = dict(headers or {})
    status, rh, body = fetch(url, h)
    if status != 402:
        return status, rh, body
    low = {k.lower(): v for k, v in rh.items()}
    try:
        pr = _b64json(low["payment-required"]) if "payment-required" in low else json.loads(body or b"null")
    except (ValueError, KeyError):
        pr = None
    if not isinstance(pr, dict) or not pr.get("accepts"):
        raise ImmiscibleError("the 402 response carried no payment requirements Immiscible could read", type="x402_unreadable")

    def token(r: dict):
        net = _net(r.get("network", ""))
        table = {**X402_ASSETS.get(net, {}), **{k.lower(): v for k, v in ((assets or {}).get(net) or {}).items()}}
        return table.get(str(r.get("asset", "")).lower())

    pick = next((r for r in pr["accepts"] if r.get("scheme") == "exact" and token(r)), None)
    if not pick:
        raise ImmiscibleError("none of the 402 payment options is in a token this helper recognises; add it with assets", type="x402_unknown_asset")
    t = token(pick)
    atomic = pick.get("amount") or pick.get("maxAmountRequired")
    if not isinstance(atomic, str) or not atomic.isdigit():
        raise ImmiscibleError("the 402 amount is not an atomic integer string", type="x402_unreadable")
    amount = from_atomic(atomic, t["decimals"])
    resource = (pr.get("resource") or {}).get("url") or pick.get("resource") or url
    result = {}

    def sign(decision: Decision):
        header = pay({"requirements": pick, "payment_required": pr, "decision": decision})
        name = "PAYMENT-SIGNATURE" if int(pr.get("x402Version", 1)) >= 2 else "X-PAYMENT"
        s2, h2, b2 = fetch(url, {**h, name: header})
        result["response"] = (s2, h2, b2)
        if s2 >= 400:
            raise ImmiscibleError(f"the resource answered {s2} after payment", type="x402_failed")
        l2 = {k.lower(): v for k, v in h2.items()}
        raw = l2.get("payment-response") or l2.get("x-payment-response")
        try:
            tx = _b64json(raw).get("transaction") if raw else None
        except ValueError:
            tx = None
        return {"txHash": tx} if tx else {}

    decide_then_sign(immiscible, {
        "asset": t["symbol"], "network": pick["network"], "amount": amount, "recipient": pick["payTo"],
        "summary": f"Pay {amount} {t['symbol']} for {resource}",
        "protocol": {"kind": "x402", "resource": resource, "x402Version": int(pr.get("x402Version", 1))},
        "provenance": provenance,
    }, sign, verify=verify, wait=wait)
    return result["response"]
