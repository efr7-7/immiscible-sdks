"""Crypto: decide, then sign, and x402, against a stub decision and a fake x402 server.

The stub signs real Ed25519 receipts with a cry claim, as the server does, so the
receipt check is a real one. The x402 server follows the spec's v1 and v2 shapes:
https://github.com/coinbase/x402/blob/main/specs/x402-specification-v1.md
https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
The repository's server suite runs the same paths against the real server.
"""

import base64
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from immiscible import Decision, ImmiscibleDeniedError
from immiscible.crypto import crypto_action, decide_then_sign, from_atomic, receipt_covers, x402_request
from immiscible.testing import start_fake

TO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


class Stub:
    """Decides like Immiscible would for one rule: allow up to 5 USDC to TO on Base."""

    def __init__(self, fake):
        self.fake = fake
        self.base_url = fake.url
        self.asked = []
        self.settled = []

    def decide(self, action, wait=True, timeout=600.0):
        c = action["payment"]["crypto"]
        self.asked.append(c)
        if c["recipient"].lower() != TO.lower() or float(c["amount"]) > 5:
            raise ImmiscibleDeniedError(Decision({"id": "act_1", "decision": "deny", "reasons": ["not covered"]}))
        now = int(time.time())
        claims = {"iss": self.fake.url, "sub": "agt_1", "act": "act_1", "typ": "payment", "iat": now, "exp": now + 300, "jti": "j1",
                  "amt": 380, "cur": "GBP", "cry": {"ast": c["asset"], "net": "base", "amt": c["amount"], "to": TO}}
        return Decision({"id": "act_1", "decision": "allow", "reasons": [], "receipt": self.fake.mint(claims)})

    def request(self, method, path, body=None, retry=False):
        self.settled.append((path, body))


class Helpers(unittest.TestCase):
    def test_action_and_amounts(self):
        a = crypto_action("USDC", "base", "12.50", TO)
        self.assertEqual(a["payment"], {"crypto": {"asset": "USDC", "network": "base", "amount": "12.50", "recipient": TO}})
        with self.assertRaises(TypeError):
            crypto_action("USDC", "base", 12.5, TO)
        self.assertEqual(from_atomic("10000", 6), "0.01")

    def test_receipt_covers(self):
        c = {"cry": {"ast": "USDC", "net": "base", "amt": "5", "to": TO}}
        self.assertEqual(receipt_covers(c, "USDC", "eip155:8453", "5", TO.lower()), [])
        self.assertTrue(receipt_covers(c, "USDC", "base", "5.01", TO))
        self.assertTrue(receipt_covers(c, "USDC", "polygon", "5", TO))


class DecideThenSign(unittest.TestCase):
    def setUp(self):
        self.fake = start_fake()
        self.stub = Stub(self.fake)
        self.verify = {"jwks": self.fake.jwks, "check_issuer": False}

    def tearDown(self):
        self.fake.close()

    def test_signs_only_after_allow_and_reports_the_hash(self):
        out = decide_then_sign(self.stub, {"asset": "USDC", "network": "base", "amount": "5", "recipient": TO}, lambda d: {"txHash": "0xabc"}, verify=self.verify)
        self.assertEqual(out, {"txHash": "0xabc"})
        self.assertEqual(self.stub.settled[-1][1], {"status": "completed", "txHash": "0xabc"})
        ran = []
        with self.assertRaises(ImmiscibleDeniedError):
            decide_then_sign(self.stub, {"asset": "USDC", "network": "base", "amount": "50", "recipient": TO}, lambda d: ran.append(1), verify=self.verify)
        self.assertEqual(ran, [])


def x402_server(version):
    seen = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            paid = self.headers.get("X-PAYMENT" if version == 1 else "PAYMENT-SIGNATURE")
            seen.append(paid)
            if not paid:
                req = ({"scheme": "exact", "network": "base", "maxAmountRequired": "10000", "resource": "http://x/report", "payTo": TO, "asset": USDC_BASE, "maxTimeoutSeconds": 60}
                       if version == 1 else {"scheme": "exact", "network": "eip155:8453", "amount": "10000", "payTo": TO, "asset": USDC_BASE, "maxTimeoutSeconds": 60})
                body = {"x402Version": version, "error": "payment required", "accepts": [req]}
                self.send_response(402)
                self.send_header("content-type", "application/json")
                if version == 2:
                    self.send_header("PAYMENT-REQUIRED", base64.b64encode(json.dumps(body).encode()).decode())
                self.end_headers()
                self.wfile.write(json.dumps(body if version == 1 else {}).encode())
                return
            settle = base64.b64encode(json.dumps({"success": True, "transaction": "0xfeed", "network": "base"}).encode()).decode()
            self.send_response(200)
            self.send_header("X-PAYMENT-RESPONSE" if version == 1 else "PAYMENT-RESPONSE", settle)
            self.end_headers()
            self.wfile.write(b'{"report":"ok"}')

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, seen


class X402(unittest.TestCase):
    def test_v1_and_v2_pay_only_on_allow(self):
        for version in (1, 2):
            fake = start_fake()
            srv, seen = x402_server(version)
            try:
                stub = Stub(fake)
                calls = []

                def pay(info):
                    calls.append(info["requirements"])
                    return base64.b64encode(b'{"signed":"by the wallet"}').decode()

                status, _, body = x402_request(stub, f"http://127.0.0.1:{srv.server_address[1]}/report", pay, verify={"jwks": fake.jwks, "check_issuer": False})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), {"report": "ok"})
                self.assertEqual(len(calls), 1)
                self.assertEqual(stub.asked[0]["amount"], "0.01")
                self.assertEqual(stub.asked[0]["protocol"]["kind"], "x402")
                self.assertEqual(stub.settled[-1][1], {"status": "completed", "txHash": "0xfeed"})
                self.assertEqual(len(seen), 2)
            finally:
                srv.shutdown()
                fake.close()


if __name__ == "__main__":
    unittest.main()
