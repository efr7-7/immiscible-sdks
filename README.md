# Immiscible SDKs

**Know what every AI agent spends, and decide what it’s allowed to do.**

Immiscible is governance for the AI agents a company already runs, from any vendor. Before an agent pays, shares personal data or acts, it asks Immiscible, which allows it with a signed receipt, asks a named person, or refuses, against rules your people wrote. This repository holds the open source pieces that connect your agents to it: the CLI, the SDKs, the Claude Code hook and plugin, and the packages for Claude Desktop, ChatGPT and Codex, and the Gemini CLI.

```bash
npx immiscible check     # what the agents on this machine can touch; runs locally, no sign-in
npx immiscible init      # put Immiscible in front of the agent in this project
```

[![immiscible on npm](https://img.shields.io/npm/v/immiscible?label=npx%20immiscible&color=1E2F6E)](https://www.npmjs.com/package/immiscible)
[![@immiscible/sdk on npm](https://img.shields.io/npm/v/@immiscible/sdk?label=%40immiscible%2Fsdk&color=1E2F6E)](https://www.npmjs.com/package/@immiscible/sdk)
[![@immiscible/claude-code-hook on npm](https://img.shields.io/npm/v/@immiscible/claude-code-hook?label=claude-code-hook&color=1E2F6E)](https://www.npmjs.com/package/@immiscible/claude-code-hook)
[![immiscible on PyPI](https://img.shields.io/pypi/v/immiscible?label=pip%20install%20immiscible&color=1E2F6E)](https://pypi.org/project/immiscible/)
[![MIT licence](https://img.shields.io/badge/licence-MIT-F0563A)](LICENSE)

Free for up to 5 people at [immiscible.fly.dev](https://immiscible.fly.dev), with 30 days of Team on us. The server is hosted, or self-hosted in your own cloud on the Scale plan.

## Packages (0.1.1)

| Package | What it is | Install |
|---|---|---|
| [`immiscible`](packages/immiscible-cli) | The developer CLI: `check`, `init`, `mcp`, `doctor`, `status`, `login`, `token` | `npx immiscible init` |
| [`@immiscible/sdk`](packages/immiscible-js) | TypeScript and JavaScript, with guards for the OpenAI Agents SDK, LangChain, LangGraph and the Vercel AI SDK | `npm install @immiscible/sdk` |
| [`immiscible`](packages/immiscible-py) | Python 3.9+, standard library only | `pip install immiscible` |
| [`@immiscible/claude-code-hook`](packages/immiscible-claude-code) | A fail-closed PreToolUse hook for Claude Code | installed by `npx immiscible init` |
| [Claude Code plugin](packages/immiscible-claude-code) | The hook, the MCP server, the `ask-before-acting` skill and the `immiscible-analyst` subagent, which reads and never acts | `/plugin marketplace add efr7-7/immiscible-sdks`, then `/plugin install immiscible@immiscible` |
| [Claude Desktop extension](packages/immiscible-desktop) | An MCP Bundle with a dependency-free local bridge | `npm run pack` in the folder, then open `dist/immiscible.mcpb` and paste the agent key |
| [ChatGPT and Codex plugin](packages/immiscible-openai) | The MCP server with OAuth, and the `ask-before-acting` skill | a plugin folder; or `codex mcp add immiscible --url https://immiscible.fly.dev/mcp --bearer-token-env-var IMMISCIBLE_AGENT_KEY` |
| [Gemini CLI extension](packages/immiscible-gemini) | The MCP server and the same instructions as context | `gemini extensions install ./packages/immiscible-gemini` from a clone |

The plugins, the Desktop bundle and the Gemini extension are not in any directory yet; install them from this repository.

Any other MCP client: `npx immiscible mcp --client <client>` prints the one-line setup for Claude Code, Cursor, VS Code, Windsurf, Codex or Gemini CLI, and changes nothing. For Claude Code directly: `claude mcp add --transport http immiscible https://immiscible.fly.dev/mcp --header "Authorization: Bearer $IMMISCIBLE_AGENT_KEY"`.

## The CLI

| Command | Does |
|---|---|
| `immiscible check` | Lists what the agents on this machine can touch: MCP servers and what each can do, Claude Code permissions, provider keys in `.env` and shell config. Local, changes nothing, no sign-in; a key is shown only as its prefix, last four characters and a fingerprint. `--upload` makes a report link from the findings, never a key. |
| `immiscible init` | Signs you in, creates the agent and its rule, writes `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` to `.env`, installs the Claude Code hook and deny rules after showing the diff, prints the code for your SDK and makes a live test call. Safe to run again. |
| `immiscible mcp` | Prints how to add the MCP server to your client. |
| `immiscible doctor` | Checks the server, sign-in, `.env`, the agent key and that the hook fails closed, and prints fixes. |
| `immiscible status` | What waits for approval, today’s decisions and this month’s spend. |

Every command takes `--json` and has its own exit codes, so an AI coding agent can run the setup itself, with a person allowing the sign-in once.

## In code

```ts
import { Immiscible, toolAction } from '@immiscible/sdk';

const run = new Immiscible().run(); // reads IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY
await run.guard(toolAction('deploy', { service: 'api' }, { summary: 'Deploy the api service', domain: 'mycompany.com' }), () => deploy());
```

`guard` asks, waits for a person if one is asked, runs your code only if allowed, and reports the outcome. A refusal throws with the reasons. If Immiscible cannot be reached, it fails closed.

## Ask Immiscible

Ask about your AI spend from Claude, ChatGPT or Cursor: add `https://immiscible.fly.dev/mcp` as a connector and ask what you spent, what is being wasted and which keys nobody is watching. It answers from your own bills. Anything that would change something, such as a budget or switching a key off, is decided by a person first.

## Links

Docs: [immiscible.fly.dev/docs](https://immiscible.fly.dev/docs). The free AI check: [immiscible.fly.dev/check](https://immiscible.fly.dev/check). For AI agents: [immiscible.fly.dev/docs/ai-agents](https://immiscible.fly.dev/docs/ai-agents) and [AGENTS.md](AGENTS.md).

MIT licence for everything here. The names of other products are used only to say what works with what; none of those companies endorses Immiscible.
