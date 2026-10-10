"""Receipt v2 (decision binding): the basket digest and the audience and cart checks.

Against the fixture the server and the JavaScript SDK are tested with (a copy of
the repository's test/fixtures/receipt-v2.json), so all three agree byte for byte.
"""

import json
import pathlib
import unittest

from immiscible import canonical_cart, cart_digest, verify_receipt

FIXTURE = json.loads((pathlib.Path(__file__).parent / "fixtures" / "receipt-v2.json").read_text("utf-8"))
RECEIPT = FIXTURE["receipt"]


def _verify(expect):
    return verify_receipt(RECEIPT["token"], RECEIPT["issuer"], jwks=RECEIPT["jwks"], expect=expect, now=RECEIPT["claims"]["iat"] + 60)


class CartDigest(unittest.TestCase):
    def test_the_server_bytes_for_every_fixture_basket(self):
        for f in FIXTURE["carts"]:
            self.assertEqual(canonical_cart(f["cart"], f["currency"]), f["canonical"], f["name"])
            self.assertEqual(cart_digest(f["cart"], f["currency"]), f["digest"], f["name"])

    def test_unit_price_in_either_spelling(self):
        f = FIXTURE["carts"][2]
        line = dict(f["cart"][0])
        line["unit_price"] = line.pop("unitPrice")
        self.assertEqual(cart_digest([line], f["currency"]), f["digest"])

    def test_a_line_with_neither_sku_nor_url_is_refused(self):
        with self.assertRaises(TypeError):
            canonical_cart([{"quantity": 1, "unitPrice": 1}], "GBP")
        with self.assertRaises(TypeError):
            canonical_cart([{"sku": "x", "quantity": True, "unitPrice": 1}], "GBP")

    def test_trims_as_javascript_does(self):
        # A byte order mark is trimmed in JavaScript; NEL (U+0085) is not, though Python's own strip() would take it.
        doc = canonical_cart([{"sku": "\ufeffA\x85 ", "quantity": 1, "unitPrice": 1}], "GBP")
        self.assertIn('"sku":"A\x85"', doc)

    def test_a_cart_that_cannot_be_encoded_is_a_mismatch_not_a_crash(self):
        r = _verify({"cart": [{"sku": "\ud800", "quantity": 1, "unitPrice": 1}]})
        self.assertFalse(r.valid)
        self.assertEqual(r.reason, "cart_mismatch")


class Bindings(unittest.TestCase):
    def test_each_fixture_check(self):
        for check in RECEIPT["checks"]:
            r = _verify(check["expect"])
            self.assertEqual(r.valid, check["valid"], f"{check['expect']}: {r.message}")
            if not check["valid"]:
                self.assertEqual(r.reason, check["reason"])

    def test_the_v2_claims_are_read(self):
        r = _verify({})
        self.assertTrue(r.valid, r.message)
        self.assertEqual(r.claims["ver"], 2)
        self.assertEqual(r.claims["prv"], {"declared": ["user"], "observed": [], "mismatch": False})
        self.assertIs(r.claims["tnt"], False)

    def test_snake_case_cart_digest(self):
        self.assertTrue(_verify({"cart_digest": FIXTURE["carts"][0]["digest"]}).valid)


if __name__ == "__main__":
    unittest.main()
