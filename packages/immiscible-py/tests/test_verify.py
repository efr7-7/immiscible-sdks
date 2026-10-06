"""Receipts: offline against fetched or pinned keys, online once, and every way to forge one."""

import json
import time
import unittest

from immiscible import Immiscible, clear_jwks_cache, fetch_jwks, pin_jwks, verify_online, verify_receipt
from immiscible.testing import Ed25519Signer, start_fake


def no_network(url):
    raise AssertionError(f"pinned keys must not fetch {url}")


class Verify(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = start_fake()
        cls.im = Immiscible(cls.fake.agent_key, cls.fake.url)

    @classmethod
    def tearDownClass(cls):
        cls.fake.close()

    def setUp(self):
        clear_jwks_cache()

    def receipt(self, pence=6420):
        d = self.im.pay(pence, "GBP", "ocado.com", provenance=[{"source": "user"}])
        self.assertTrue(d.allowed, d)
        return d.receipt

    def claims(self, **extra):
        now = int(time.time())
        c = {"iss": self.fake.url, "sub": self.fake.agent_id, "act": "act_x", "typ": "payment", "amt": 6420, "cur": "GBP",
             "mer": "ocado.com", "mdt": "mdt_fake_groceries", "hum": False, "iat": now, "exp": now + 300, "jti": "j1"}
        c.update(extra)
        return {k: v for k, v in c.items() if v is not None}

    def test_offline_with_the_issuer_and_bindings(self):
        r = verify_receipt(self.receipt(), self.fake.url, expect={"amount": 6420, "currency": "gbp", "merchant": "https://www.ocado.com",
                                                                 "type": "payment", "agent": self.fake.agent_id})
        self.assertTrue(r.valid, r.message)
        n = len([x for x in self.fake.requests if x["path"] == "/.well-known/immiscible-keys.json"])
        verify_receipt(self.receipt(), self.fake.url)
        self.assertEqual(len([x for x in self.fake.requests if x["path"] == "/.well-known/immiscible-keys.json"]), n, "cached")

    def test_pinned_keys_dict_or_json_no_network(self):
        pinned = fetch_jwks(self.fake.url)
        tok = self.receipt()
        self.assertTrue(verify_receipt(tok, jwks=pinned, fetch=no_network).valid)
        self.assertTrue(verify_receipt(tok, self.fake.url, jwks=json.dumps(pinned), fetch=no_network).valid)
        other = {"keys": [Ed25519Signer().jwk("someone-else")]}
        self.assertEqual(verify_receipt(tok, jwks=other, fetch=no_network).reason, "unknown_kid")
        with self.assertRaises(TypeError):
            pin_jwks({"keys": []})

    def test_online_single_use_and_bindings_first(self):
        tok = self.receipt(7000)
        self.assertEqual(verify_receipt(tok, self.fake.url, online=True, expect={"amount": 6999}).reason, "amount_mismatch")
        first = verify_receipt(tok, self.fake.url, online=True, expect={"amount": 7000})
        self.assertTrue(first.valid, first.message)
        second = verify_online(tok, self.fake.url)
        self.assertEqual((second.valid, second.reason), (False, "replayed"))
        self.assertTrue(verify_receipt(self.receipt(7100), jwks=self.fake.jwks, online=True, base_url=self.fake.url).valid)

    def test_online_fails_closed(self):
        r = verify_online(self.receipt(), "http://127.0.0.1:9")
        self.assertEqual((r.valid, r.reason), (False, "verify_unavailable"))

    def test_forgeries_fail_with_stable_reasons(self):
        pinned = dict(jwks=self.fake.jwks, fetch=no_network)
        evil = Ed25519Signer()
        now = int(time.time())
        cases = [
            ("not a token", "malformed"),
            (self.fake.mint(self.claims(), {"alg": "none"}), "unsupported_alg"),
            (self.fake.mint(self.claims(), {"alg": "HS256"}), "unsupported_alg"),
            (self.fake.mint(self.claims(), {"typ": "JWT"}), "wrong_typ"),
            (self.fake.mint(self.claims(), {"crit": ["exp"]}), "unsupported_crit"),
            (self.fake.mint(self.claims(), {"kid": None}), "missing_kid"),
            (self.fake.mint(self.claims(), signer=evil), "bad_signature"),
            (self.fake.mint(self.claims(exp=now - 3600)), "expired"),
            (self.fake.mint(self.claims(iat=now + 3600)), "issued_in_future"),
            (self.fake.mint(self.claims(exp=None)), "missing_claim"),
        ]
        for tok, reason in cases:
            with self.subTest(reason=reason):
                r = verify_receipt(tok, **pinned)
                self.assertFalse(r.valid)
                self.assertEqual(r.reason, reason)
                self.assertIsNone(r.claims)
        good = self.fake.mint(self.claims())
        self.assertEqual(verify_receipt(self.fake.mint(self.claims(iss="https://elsewhere.example")), self.fake.url, **pinned).reason, "wrong_issuer")
        self.assertEqual(verify_receipt(good, **pinned, expect={"merchant": "tesco.com"}).reason, "merchant_mismatch")
        self.assertEqual(verify_receipt(good, **pinned, expect={"humanApproved": True}).reason, "human_required")
        with self.assertRaises(TypeError):
            verify_receipt(good)


if __name__ == "__main__":
    unittest.main()
