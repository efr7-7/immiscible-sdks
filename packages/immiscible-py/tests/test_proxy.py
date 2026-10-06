"""The MCP proxy client against the fake proxy."""

import threading
import unittest

from immiscible import Immiscible, ImmiscibleApprovalRequiredError, ImmiscibleDeniedError, approval_meta, mcp_proxy_url, mcp_server_url
from immiscible.testing import start_fake


class Proxy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = start_fake()
        cls.im = Immiscible(cls.fake.agent_key, cls.fake.url)

    @classmethod
    def tearDownClass(cls):
        cls.fake.close()

    def test_urls(self):
        self.assertEqual(mcp_proxy_url("https://x.example/", "ups 1"), "https://x.example/mcp/proxy/ups%201")
        self.assertEqual(mcp_server_url("https://x.example/"), "https://x.example/mcp")
        with self.assertRaises(TypeError):
            approval_meta("nope")

    def test_list_call_approval_once_and_deny(self):
        px = self.im.mcp_proxy("fake-shop")
        self.assertEqual([t["name"] for t in px.list_tools()["tools"]], ["search", "buy"])
        self.assertTrue(px.session_id.startswith("mps_"))
        self.assertIn("did search", px.call("search", {"q": "milk"})["content"][0]["text"])
        before = self.fake.upstream_calls
        with self.assertRaises(ImmiscibleApprovalRequiredError) as pending:
            px.call("buy", {"amount": 9500, "merchant": "ocado.com"})
        self.assertEqual(self.fake.upstream_calls, before)
        self.fake.approve(pending.exception.action_id)
        self.assertIn("did buy", px.retry_after_approval("buy", {"amount": 9500, "merchant": "ocado.com"}, pending.exception)["content"][0]["text"])
        with self.assertRaises(Exception) as again:
            px.retry_after_approval("buy", {"amount": 9500, "merchant": "ocado.com"}, pending.exception)
        self.assertEqual(getattr(again.exception, "code", None), -32006)
        self.assertEqual(self.fake.upstream_calls, before + 1)

        def approve_soon(err):
            t = threading.Timer(0.03, self.fake.approve, (err.action_id,))
            t.daemon = True
            t.start()

        out = px.call_with_approval("buy", {"amount": 9000, "merchant": "ocado.com"}, initial_delay=0.01, on_approval_required=approve_soon)
        self.assertIn("did buy", out["content"][0]["text"])
        with self.assertRaises(ImmiscibleDeniedError) as denied:
            px.call("buy", {"amount": 1000, "merchant": "0cado.com"})
        self.assertIn("lookalike_domain", [s["id"] for s in denied.exception.signals])


if __name__ == "__main__":
    unittest.main()
