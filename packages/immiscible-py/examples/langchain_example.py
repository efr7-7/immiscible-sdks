"""LangChain / LangGraph: guarded tools inside a ToolNode, in a graph.

    pip install immiscible langchain-core langgraph
    python examples/langchain_example.py --demo

With a real model, bind the same guarded tools (`model.bind_tools(tools)`) or
pass them to `create_react_agent(model, tools)`; point the model at the
gateway with `ChatOpenAI(**immiscible.gateway.openai())` (base_url, api_key,
default_headers).
"""

import sys

from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from immiscible import Immiscible
from immiscible.integrations import guard_langchain_tools

demo = "--demo" in sys.argv
fake = None
if demo:
    from immiscible.testing import start_fake

    fake = start_fake()

immiscible = (Immiscible(fake.agent_key, fake.url) if demo else Immiscible()).run(client="langchain")


@tool
def buy(pence: int, domain: str) -> str:
    """Buy groceries from a supermarket."""
    return f"ordered £{pence / 100:.2f} from {domain}"


tools = guard_langchain_tools(
    [buy],
    client=immiscible,
    map_to_action=lambda call: Immiscible.payment_action(call.args["pence"], "GBP", call.args["domain"], provenance=[{"source": "user"}]),
    # In a graph with a checkpointer, call langgraph.types.interrupt(...) here instead, and resume when the person answers.
    on_approval_required=lambda d: print(f"a person must approve: {d.approval_url}"),
)

graph = StateGraph(MessagesState)
graph.add_node("tools", ToolNode(tools))
graph.add_edge(START, "tools")
graph.add_edge("tools", END)
app = graph.compile()

for cid, args in (("c1", {"pence": 1200, "domain": "tesco.com"}), ("c2", {"pence": 1200, "domain": "0cado.com"})):
    out = app.invoke({"messages": [AIMessage(content="", tool_calls=[{"id": cid, "name": "buy", "args": args, "type": "tool_call"}])]})
    print(f"{cid}: {out['messages'][-1].content}")

if fake:
    fake.close()
