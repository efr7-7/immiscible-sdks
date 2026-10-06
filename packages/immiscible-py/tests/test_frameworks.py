"""The integrations with the real framework packages, end to end against the fake.

The frameworks are not dependencies. Each case is skipped unless its package imports:

    pip install openai openai-agents langchain-core langgraph
"""

import importlib.util
import json
import unittest

from immiscible import Immiscible
from immiscible.integrations import guard_langchain_tools, guard_tools, guarded
from immiscible.testing import start_fake


def has(*mods):
    return all(importlib.util.find_spec(m) is not None for m in mods)


def buy_action(call):
    return Immiscible.payment_action(call.args["pence"], "GBP", call.args["domain"], provenance=[{"source": "user"}])


class Frameworks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = start_fake()
        cls.base = Immiscible(cls.fake.agent_key, cls.fake.url)

    @classmethod
    def tearDownClass(cls):
        cls.fake.close()

    def last_action(self):
        return list(self.fake.actions.values())[-1]

    @unittest.skipUnless(has("openai", "httpx"), "openai not installed")
    def test_openai_sdk_through_the_gateway_inside_the_run(self):
        im = self.base.run()
        client = im.gateway.openai_client(task_id="fw-py-1")
        r = client.chat.completions.create(model="gpt-test", messages=[{"role": "user", "content": "hi"}])
        self.assertEqual(r.choices[0].message.content, "ok")
        self.assertTrue(im.context.session_id.startswith("imss_"))
        client.chat.completions.create(model="gpt-test", messages=[{"role": "user", "content": "again"}])
        sent = [x for x in self.fake.requests if x["path"] == "/v1/chat/completions"][-1]
        self.assertEqual(sent["headers"]["x-immiscible-session"], im.context.session_id)
        self.assertEqual(sent["headers"]["x-immiscible-task-id"], "fw-py-1")
        self.assertIn(im.context.trace_id, sent["headers"]["traceparent"])

    @unittest.skipUnless(has("agents", "openai", "httpx"), "openai-agents not installed")
    def test_openai_agents_run_with_a_guarded_tool(self):
        from agents import Agent, Runner, function_tool, set_default_openai_api, set_default_openai_client, set_tracing_disabled

        im = self.base.run()
        set_tracing_disabled(True)
        set_default_openai_client(im.gateway.openai_client(async_=True))
        set_default_openai_api("chat_completions")
        ran = []

        @function_tool
        def buy(pence: int, domain: str) -> str:
            """Buy groceries."""
            ran.append(pence)
            return f"bought {pence} at {domain}"

        agent = Agent(name="Shopper", model="gpt-test", tools=guard_tools([buy], client=im, map_to_action=buy_action))
        ok = Runner.run_sync(agent, 'CALL buy {"pence":1200,"domain":"tesco.com"}')
        self.assertIn("done: bought 1200 at tesco.com", str(ok.final_output))
        a = self.last_action()
        self.assertEqual(a["request"]["payment"]["amount"], 1200)
        self.assertTrue(a["request"]["idempotencyKey"].startswith("tool_"))
        self.assertEqual(a["request"]["session"], {"client": "custom", "id": im.context.session_id})
        self.assertTrue(any(s["actionId"] == a["id"] and s["status"] == "completed" for s in self.fake.settlements))
        refused = Runner.run_sync(agent, 'CALL buy {"pence":1200,"domain":"0cado.com"}')
        self.assertIn("done: Immiscible refused this action", str(refused.final_output))
        self.assertEqual(ran, [1200])

    @unittest.skipUnless(has("agents"), "openai-agents not installed")
    def test_guarded_decorator_under_function_tool(self):
        from agents import function_tool

        @function_tool
        @guarded(buy_action, client=self.base)
        def buy(pence: int, domain: str) -> str:
            """Buy groceries."""
            return f"bought {pence}"

        self.assertEqual(sorted(buy.params_json_schema["properties"]), ["domain", "pence"])

    @unittest.skipUnless(has("langchain_core", "langgraph"), "langchain-core or langgraph not installed")
    def test_langgraph_tool_node_with_a_guarded_tool(self):
        from langchain_core.messages import AIMessage
        from langchain_core.tools import tool
        from langgraph.graph import END, START, MessagesState, StateGraph
        from langgraph.prebuilt import ToolNode

        ran = []

        @tool
        def buy(pence: int, domain: str) -> str:
            """Buy groceries."""
            ran.append(pence)
            return f"bought {pence}"

        graph = StateGraph(MessagesState)
        graph.add_node("tools", ToolNode(guard_langchain_tools([buy], client=self.base, map_to_action=buy_action)))
        graph.add_edge(START, "tools")
        graph.add_edge("tools", END)
        node = graph.compile()

        def call(cid, args):
            return {"messages": [AIMessage(content="", tool_calls=[{"id": cid, "name": "buy", "args": args, "type": "tool_call"}])]}

        out = node.invoke(call("lg_py_1", {"pence": 1400, "domain": "ocado.com"}))
        self.assertEqual(out["messages"][-1].content, "bought 1400")
        self.assertEqual(self.last_action()["request"]["idempotencyKey"], "tool_lg_py_1")
        refused = node.invoke(call("lg_py_2", {"pence": 1400, "domain": "0cado.com"}))
        self.assertIn("Immiscible refused", refused["messages"][-1].content)
        self.assertEqual(ran, [1400])

    @unittest.skipUnless(has("langchain_core"), "langchain-core not installed")
    def test_guarded_decorator_under_langchain_tool(self):
        from langchain_core.tools import tool

        @tool
        @guarded(buy_action, client=self.base)
        def buy(pence: int, domain: str) -> str:
            """Buy groceries."""
            return f"bought {pence}"

        self.assertEqual(sorted(buy.args), ["domain", "pence"])
        self.assertEqual(buy.invoke({"pence": 500, "domain": "tesco.com"}), "bought 500")
        self.assertIn("refused", buy.invoke({"pence": 500, "domain": "0cado.com"}))


if __name__ == "__main__":
    unittest.main()
