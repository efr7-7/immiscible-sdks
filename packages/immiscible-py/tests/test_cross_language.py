"""The Python SDK against the JavaScript SDK's fake (Node's Ed25519 signatures), so both SDKs speak one contract.

Skipped unless node is on PATH and packages/immiscible-js has been built.
"""

import json
import pathlib
import shutil
import subprocess
import unittest

from immiscible import Immiscible, clear_jwks_cache, verify_online, verify_receipt

FAKE = pathlib.Path(__file__).resolve().parents[2] / "immiscible-js" / "bin" / "immiscible-fake.mjs"
BUILT = FAKE.parent.parent / "dist" / "esm" / "testing.js"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and FAKE.exists() and BUILT.exists(), "needs node and a built packages/immiscible-js")
class AgainstTheJavaScriptFake(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.Popen([NODE, str(FAKE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        info = json.loads(cls.proc.stdout.readline())
        cls.url, cls.key, cls.jwks = info["url"], info["agentKey"], info["jwks"]

    @classmethod
    def tearDownClass(cls):
        cls.proc.stdin.close()
        try:
            cls.proc.wait(5)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        cls.proc.stdout.close()

    def test_authorize_trace_session_and_node_signed_receipts(self):
        clear_jwks_cache()
        im = Immiscible(self.key, self.url).run()
        d = im.pay(6420, "GBP", "ocado.com", provenance=[{"source": "user"}])
        self.assertTrue(d.allowed, d)
        self.assertIn(im.context.trace_id, im.context.last_server_traceparent)
        pinned = verify_receipt(d.receipt, jwks=self.jwks, expect={"amount": 6420, "merchant": "ocado.com"})
        self.assertTrue(pinned.valid, pinned.message)
        fetched = verify_receipt(d.receipt, self.url)
        self.assertTrue(fetched.valid, fetched.message)
        self.assertTrue(verify_online(d.receipt, self.url).valid)
        self.assertEqual(verify_online(d.receipt, self.url).reason, "replayed")
        pending = im.pay(9500, "GBP", "ocado.com", provenance=[{"source": "user"}])
        self.assertTrue(pending.needs_approval)
        import urllib.request
        urllib.request.urlopen(urllib.request.Request(f"{self.url}/__fake/actions/{pending.id}/approve", data=b"{}", method="POST")).read()
        final = im.wait_for_decision(pending.id, initial_delay=0.01)
        self.assertTrue(final.human)
        self.assertEqual(im.settle(final.id, "completed", 9500)["settlement"]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
