# LangChain and LangGraph: guard the tools

```bash
npm install @immiscible/sdk @langchain/core @langchain/langgraph zod
node graph.mjs
```

`guardLangChainTools(tools)` returns copies of your tools that ask Immiscible before they run. They keep their names, descriptions and schemas, so they go anywhere the originals did: `new ToolNode(tools)`, `model.bindTools(tools)` or `createReactAgent({ llm, tools })`. Allowed: the tool runs. Held: it waits while a person decides. Denied: the tool's result is the reasons, written so the model stops.

For a LangGraph human in the loop with a checkpointer, pass `onApprovalRequired: (d) => interrupt({ approve: d.approval.url })` and resume when the person answers, or `wait: false` to refuse at once and route the refusal in the graph. To send the model's calls through Immiscible's gateway: `new ChatOpenAI({ configuration: immiscible.gateway.openai() })`.

The LangChain packages are your project's dependencies; `@immiscible/sdk` does not depend on them. It reads `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY`.

Expected, against the fake (a person approves the deploy):

```text
lookup_invoice: invoice 0931: £1,250.00, due 14 October
waiting for a person: http://127.0.0.1:.../app/approvals/apr_...
deploy: deployed api
upload_report: Immiscible refused this action: no mandate lets this agent reach evil.example. Do not proceed and do not try it another way. Tell the person what was refused and why.
```

The Python guards are the same: `from immiscible.integrations import guard_langchain_tools`.
