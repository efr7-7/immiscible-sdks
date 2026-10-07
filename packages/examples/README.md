# Examples

Short, copyable examples of asking Immiscible before an agent acts. Each folder is a README and the code, nothing else.

| Folder | For |
|---|---|
| [`node`](node) | The TypeScript and JavaScript SDK: `run.guard(action, fn)` |
| [`python`](python) | The Python SDK: `with run.guard(action):` |
| [`mcp`](mcp) | Claude Code and Claude Desktop, through Immiscible's MCP server or the MCP proxy |
| [`openai-agents`](openai-agents) | The OpenAI Agents SDK: `guardOpenAITools(tools)` |
| [`langchain`](langchain) | LangChain and LangGraph: `guardLangChainTools(tools)` in a `ToolNode` |
| [`curl`](curl) | The HTTP contract every one of them wraps |

Every example reads `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY`. `npx immiscible init` makes an agent and writes both to `.env`; `npx immiscible try` shows the whole flow first, offline, with no account.

Each one does the same three things: a call the rules allow goes ahead, one that needs a person waits until they decide, and one the rules refuse never runs, with the reasons. The framework packages (OpenAI Agents, LangChain) are your project's dependencies; no Immiscible package depends on them.

## Tested against the fake

CI runs every example against the fake Immiscible the SDKs test with: the same HTTP contract, real Ed25519 receipts, and a small imitation of a rule (not the real policy engine). The test plays the person and approves whatever waits.

```bash
(cd ../immiscible-js && npm ci && npm run build)
node test.mjs                 # every example
node test.mjs node mcp        # some
VERBOSE=1 node test.mjs curl  # with what each printed
```

It uses the SDKs in this repository, not the published ones, and installs the framework packages into each example's own folder.
