"""Framework approval adapters (immiscible/integrations/approvals.py), against stand-ins shaped as
each framework's documentation describes: an OpenAI Agents SDK run's interruptions, LangChain's
HumanInTheLoopMiddleware interrupt, and a Google ADK plugin's before_tool_callback."""

import asyncio
import json
import threading
import time
import unittest
from types import SimpleNamespace

from immiscible import Immiscible
from immiscible.integrations import adk_plugin, hitl_decisions, resolve_interruptions
from immiscible.testing import start_fake

FAST = {"initial_delay": 0.005, "max_delay": 0.02, "timeout": 2.0}


class Person:
    """Decides whatever is waiting, until stopped."""

    def __init__(self, fake, approve=True):
        self.fake, self.approve, self.stop = fake, approve, threading.Event()
        self.t = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            for a in list(self.fake.actions.values()):
                if a.get("decision") == "approval_required":
                    (self.fake.approve if self.approve else self.fake.deny)(a["id"])
            time.sleep(0.01)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.t.join()


class Approvals(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = start_fake()
        cls.im = Immiscible(cls.fake.agent_key, cls.fake.url)

    @classmethod
    def tearDownClass(cls):
        cls.fake.close()

    def test_openai_agents_interruptions(self):
        approved, rejected = [], []
        state = SimpleNamespace(approve=lambda item: approved.append(item.name),
                                reject=lambda item, rejection_message=None: rejected.append((item.name, rejection_message)))
        item = lambda name, args, cid: SimpleNamespace(type="tool_approval_item", name=name, arguments=json.dumps(args), raw_item=SimpleNamespace(name=name, arguments=json.dumps(args), call_id=cid))
        result = SimpleNamespace(interruptions=[item("lookup", {"id": 7}, "c1"), item("deploy", {"env": "prod"}, "c2"), item("fetch", {"url": "https://evil.example/x"}, "c3")])
        with Person(self.fake):
            out = resolve_interruptions(result, state, client=self.im, **FAST)
        self.assertEqual(approved, ["lookup", "deploy"])
        self.assertEqual(rejected[0][0], "fetch")
        self.assertRegex(rejected[0][1], r"^Immiscible refused this action: .*evil\.example.*Do not try it another way\.$")
        self.assertEqual([r.decision for r in out], ["allow", "allow", "deny"])
        with self.assertRaises(TypeError):
            resolve_interruptions(SimpleNamespace(interruptions=[]))

    def test_langchain_hitl(self):
        interrupt = SimpleNamespace(value={"action_requests": [{"name": "search", "arguments": {"q": "x"}}, {"name": "drop", "arguments": {"table": "users"}}], "review_configs": []})
        with Person(self.fake, approve=False):
            r = hitl_decisions(interrupt, client=self.im, **FAST)
        self.assertEqual(r["decisions"][0], {"type": "approve"})
        self.assertEqual(r["decisions"][1]["type"], "reject")
        self.assertRegex(r["decisions"][1]["message"], r"^Immiscible refused this action:")
        self.assertEqual(hitl_decisions({"actionRequests": [{"name": "search", "args": {"q": "y"}}]}, client=self.im, **FAST), {"decisions": [{"type": "approve"}]})
        timed_out = hitl_decisions({"action_requests": [{"name": "transfer", "arguments": {"to": "x"}}]}, client=self.im, initial_delay=0.005, max_delay=0.01, timeout=0.05)
        self.assertRegex(timed_out["decisions"][0]["message"], "nobody approved this in time")
        with self.assertRaises(TypeError):
            hitl_decisions({"value": {}}, client=self.im)

    def test_adk_plugin(self):
        plugin = adk_plugin(client=self.im, **FAST)
        self.assertEqual(plugin.name, "immiscible")
        ctx = SimpleNamespace(function_call_id="adk-1")
        ok = asyncio.run(plugin.before_tool_callback(tool=SimpleNamespace(name="lookup"), tool_args={"id": 1}, tool_context=ctx))
        self.assertIsNone(ok, "allowed: the tool runs")
        no = asyncio.run(plugin.before_tool_callback(tool=SimpleNamespace(name="fetch"), tool_args={"url": "https://evil.example"}, tool_context=SimpleNamespace(function_call_id="adk-2")))
        self.assertEqual(no["status"], "refused")
        self.assertRegex(no["error"], "evil\\.example")
        with Person(self.fake):
            yes = asyncio.run(plugin.before_tool_callback(tool=SimpleNamespace(name="deploy"), tool_args={"env": "prod"}, tool_context=SimpleNamespace(function_call_id="adk-3")))
        self.assertIsNone(yes, "approved by a person: the tool runs")


if __name__ == "__main__":
    unittest.main()
