# MCP: Claude Code and Claude Desktop

Two ways to use Immiscible over MCP. They work together.

**1. Immiscible's own MCP server.** The agent asks before it acts: `request_payment`, `request_personal_data` and `authorize_action`, then `check_action_status` while a person decides. Ask Immiscible's spend tools are on the same server.

**2. The MCP proxy.** Your tool server sits behind Immiscible, which holds its credential. Every `tools/call` is decided first, so there is no path to the tool that skips the decision.

## Claude Code

One line, which stores the key for you:

```bash
claude mcp add --transport http immiscible https://immiscible.ai/mcp --header "Authorization: Bearer $IMMISCIBLE_AGENT_KEY"
```

Or, for a project you share, commit [`.mcp.json`](.mcp.json). Claude Code fills `${IMMISCIBLE_AGENT_KEY}` from the environment and asks each person to approve the server once. `npx immiscible mcp --client claude-code` prints the same for your own server.

A tool server behind the proxy is the same shape, with the upstream's address from the console ([`proxy.mcp.json`](proxy.mcp.json)):

```bash
claude mcp add --transport http shop https://immiscible.ai/mcp/proxy/mcu_your_upstream_id --header "Authorization: Bearer $IMMISCIBLE_AGENT_KEY"
```

For Claude Code's own shell and file tools, add the hook as well: `npx immiscible init` installs it.

## Claude Desktop

The simplest: in Claude Desktop, add `https://immiscible.ai/mcp` as a custom connector and sign in. You choose which agent it acts as on the consent screen; no key is pasted.

With an agent key instead, use the Immiscible extension (`packages/immiscible-desktop`, an MCP Bundle), or run its dependency-free bridge from a checkout of this repository: merge [`claude_desktop_config.json`](claude_desktop_config.json) into Claude Desktop's config file (Settings, Developer, Edit Config), with the real path and key, and restart Claude Desktop. The bridge forwards each message to the server and holds nothing but the session; if Immiscible cannot be reached, Claude is told there is no decision, which is never an allow.

## What the agent sees

Allowed: the call goes ahead (through the proxy, it is forwarded once). Held: the tool result says a person has been asked, with the link; nothing is sent until they approve. Denied: JSON-RPC error `-32003` with the reasons in plain English.

In CI, `.mcp.json` is checked against what `npx immiscible mcp` prints, and `proxy.mcp.json` is driven through a full `initialize`, `tools/list` and `tools/call` against the fake's proxy.
