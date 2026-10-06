"""The integrations, against objects shaped as each framework hands them over (no framework installed).

tests/test_frameworks.py repeats the important cases with the real packages when they are importable.
"""

import asyncio
import dataclasses
import json
import threading
import unittest
from typing import Any, Callable

from immiscible import Immiscible, ImmiscibleDeniedError
from immiscible.integrations import guard_function_tool, guard_langchain_tool, guard_tools, guarded
from immiscible.testing import start_fake


def buy_action(call):
    return Immiscible.payment_action(call.args["pence"], "GBP", call.args["domain"], provenance=[{"source": "user"}])


@dataclasses.dataclass
class FakeFunctionTool:
    """The shape of agents.FunctionTool that matters here."""
    name: str
    on_invoke_tool: Callable[[Any, str], Any]
    description: str = ""


@dataclasses.dataclass
class FakeToolContext:
    tool_call_id: str


class Integrations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = start_fake()
        cls.im = Immiscible(cls.fake.agent_key, cls.fake.url)

    @classmethod
    def tearDownClass(cls):
        cls.fake.close()

    def last_action(self):
        return list(self.fake.actions.values())[-1]

    def settlement(self, action_id):
        return [s for s in self.fake.settlements if s["actionId"] == action_id][0]

    def test_openai_agents_function_tool(self):
        ran = []

        async def invoke(ctx, input):
            ran.append(json.loads(input))
            return "bought"

        tool = FakeFunctionTool("buy", invoke, "buy groceries")
        g = guard_function_tool(tool, client=self.im, map_to_action=buy_action)
        self.assertIsNot(g, tool)
        self.assertIs(tool.on_invoke_tool, invoke, "the original is untouched")
        self.assertEqual(g.description, "buy groceries")
        out = asyncio.run(g.on_invoke_tool(FakeToolContext("call_py_1"), json.dumps({"pence": 1200, "domain": "tesco.com"})))
        self.assertEqual(out, "bought")
        a = self.last_action()
        self.assertEqual(a["request"]["idempotencyKey"], "tool_call_py_1")
        self.assertEqual(self.settlement(a["id"])["status"], "completed")
        refused = asyncio.run(g.on_invoke_tool(FakeToolContext("call_py_2"), json.dumps({"pence": 1200, "domain": "0cado.com"})))
        self.assertTrue(refused.startswith("Immiscible refused this action:"), refused)
        self.assertEqual(len(ran), 1)
        raising = guard_function_tool(tool, client=self.im, map_to_action=buy_action, on_deny="raise")
        with self.assertRaises(ImmiscibleDeniedError):
            asyncio.run(raising.on_invoke_tool(FakeToolContext("c3"), json.dumps({"pence": 1200, "domain": "0cado.com"})))
        hosted = object()
        self.assertIs(guard_tools([tool, hosted], client=self.im)[1], hosted)

    def test_default_mapping_is_a_tool_call(self):
        async def invoke(ctx, input):
            return "deployed"

        g = guard_function_tool(FakeFunctionTool("deploy", invoke), client=self.im, wait=False)
        out = asyncio.run(g.on_invoke_tool(FakeToolContext("c4"), json.dumps({"branch": "main"})))
        self.assertIn("waiting for the person to approve", out)
        self.assertEqual(self.last_action()["type"], "tool.call")
        self.assertEqual(self.last_action()["request"]["summary"], "Run deploy: branch main")

    def test_langchain_tool_call_and_direct_args_sync_and_async(self):
        class FakeTool:
            name = "buy"
            description = "buy groceries"

            def __init__(self):
                self.ran = 0

            def invoke(self, input, config=None, **kwargs):
                self.ran += 1
                args = input["args"] if isinstance(input, dict) and input.get("type") == "tool_call" else input
                return {"tool_call_id": input.get("id"), "content": f"bought {args['pence']}"} if input.get("type") == "tool_call" else f"bought {args['pence']}"

            async def ainvoke(self, input, config=None, **kwargs):
                return self.invoke(input, config, **kwargs)

        tool = FakeTool()
        g = guard_langchain_tool(tool, client=self.im, map_to_action=buy_action)
        msg = g.invoke({"type": "tool_call", "name": "buy", "id": "lc_py_1", "args": {"pence": 800, "domain": "ocado.com"}})
        self.assertEqual(msg["tool_call_id"], "lc_py_1")
        self.assertEqual(self.last_action()["request"]["idempotencyKey"], "tool_lc_py_1")
        self.assertEqual(g.invoke({"pence": 300, "domain": "tesco.com"}), "bought 300")
        self.assertIn("refused", g.invoke({"pence": 300, "domain": "tesc0.com"}))
        self.assertEqual(asyncio.run(g.ainvoke({"pence": 400, "domain": "tesco.com"})), "bought 400")
        self.assertEqual(tool.ran, 3)

        def approve_soon(d):
            t = threading.Timer(0.03, self.fake.approve, (d.id,))
            t.daemon = True
            t.start()

        waiting = guard_langchain_tool(tool, client=self.im, map_to_action=buy_action, initial_delay=0.01, on_approval_required=approve_soon)
        self.assertEqual(waiting.invoke({"pence": 9900, "domain": "ocado.com"}), "bought 9900")

    def test_guarded_decorator_keeps_the_signature(self):
        @guarded(lambda call: Immiscible.payment_action(call.args["pence"], "GBP", call.args["domain"], provenance=[{"source": "user"}]), client=self.im)
        def buy(pence: int, domain: str) -> str:
            """Buy groceries."""
            return f"bought {pence} at {domain}"

        import inspect
        self.assertEqual(list(inspect.signature(buy).parameters), ["pence", "domain"])
        self.assertEqual(buy.__doc__, "Buy groceries.")
        self.assertEqual(buy.__annotations__, {"pence": int, "domain": str, "return": str})
        self.assertEqual(buy(500, domain="tesco.com"), "bought 500 at tesco.com")
        self.assertIn("refused", buy(500, "0cado.com"))

        @guarded(client=self.im)
        async def lookup(q: str) -> str:
            return f"found {q}"

        self.assertEqual(asyncio.run(lookup("milk")), "found milk")
        self.assertEqual(self.last_action()["request"]["summary"], "Run lookup: q milk")


class RefusalWordingTest(unittest.TestCase):
    def test_reasons_ending_in_a_full_stop_are_not_stopped_twice(self):
        from immiscible.integrations.core import refusal_message
        one = refusal_message(ImmiscibleDeniedError({"id": "act_1", "decision": "deny", "reasons": ["Denied by jules@amethyst.example."]}))
        self.assertTrue(one.startswith("Immiscible refused this action: Denied by jules@amethyst.example. Do not proceed"), one)
        self.assertNotIn("..", one)
        two = refusal_message(ImmiscibleDeniedError({"id": "act_2", "decision": "deny", "reasons": ["First reason.", "Second reason"]}))
        self.assertIn(": First reason; Second reason. Do not proceed", two)



if __name__ == "__main__":
    unittest.main()

