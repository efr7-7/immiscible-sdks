"""Ed25519 signature verification in pure Python (RFC 8032, section 5.1).

Verification only: this module never holds a private key. It follows the
RFC's reference arithmetic with extended homogeneous coordinates, and is
strict where the RFC is strict:

* the public key and R must decode to points on the curve, with y < p;
* S must be below the group order L (no signature malleability);
* the check is the cofactorless equation [S]B == R + [k]A, as in the RFC's
  reference code and in OpenSSL, so it accepts exactly what Node's
  crypto.verify accepts for honestly generated signatures.

It is not constant time. That does not matter for verification, which only
touches public data (the key, the message and the signature).
"""

from __future__ import annotations

import hashlib

__all__ = ["verify", "InvalidKey"]

# Curve constants (RFC 8032, section 5.1).
P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, P - 2, P)) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


class InvalidKey(ValueError):
    """A public key that is not a valid Ed25519 point encoding."""


def _inv(x: int) -> int:
    return pow(x, P - 2, P)


def _recover_x(y: int, sign: int):
    if y >= P:
        return None
    x2 = (y * y - 1) * _inv(D * y * y + 1) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P != 0:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P != 0:
        return None
    if (x & 1) != sign:
        x = P - x
    return x


# Base point, in extended coordinates (X, Y, Z, T) with x = X/Z, y = Y/Z, xy = T/Z.
_GY = 4 * _inv(5) % P
_GX = _recover_x(_GY, 0)
G = (_GX, _GY, 1, _GX * _GY % P)
_IDENTITY = (0, 1, 1, 0)


def _add(p1, p2):
    a = (p1[1] - p1[0]) * (p2[1] - p2[0]) % P
    b = (p1[1] + p1[0]) * (p2[1] + p2[0]) % P
    c = 2 * p1[3] * p2[3] * D % P
    d = 2 * p1[2] * p2[2] % P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _mul(s: int, pt):
    q = _IDENTITY
    while s > 0:
        if s & 1:
            q = _add(q, pt)
        pt = _add(pt, pt)
        s >>= 1
    return q


def _equal(p1, p2) -> bool:
    if (p1[0] * p2[2] - p2[0] * p1[2]) % P != 0:
        return False
    return (p1[1] * p2[2] - p2[1] * p1[2]) % P == 0


def _decompress(s: bytes):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % P)


def verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """True if `signature` is a valid Ed25519 signature of `message` by `public_key`.

    Never raises for a bad signature; raises InvalidKey only for a public key
    of the wrong length, so a misconfigured key set is loud, not silently false.
    """
    if not isinstance(public_key, (bytes, bytearray)) or len(public_key) != 32:
        raise InvalidKey("an Ed25519 public key is 32 bytes")
    if not isinstance(signature, (bytes, bytearray)) or len(signature) != 64:
        return False
    a = _decompress(bytes(public_key))
    if a is None:
        return False
    r_bytes = bytes(signature[:32])
    r = _decompress(r_bytes)
    if r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= L:
        return False
    k = int.from_bytes(hashlib.sha512(r_bytes + bytes(public_key) + bytes(message)).digest(), "little") % L
    return _equal(_mul(s, G), _add(r, _mul(k, a)))
