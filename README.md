# Immiscible SDKs

**Before an agent does something it can’t take back, a person gets asked.**

[Immiscible](https://immiscible.ai) is governance for the AI agents a company already runs, from any vendor. Before an agent pays, shares personal data or calls a tool, it asks Immiscible, which allows it with a signed receipt, asks a named person, or refuses, against rules your people wrote. This repository holds the open source pieces that connect agents to it: the CLI, the TypeScript and Python SDKs, the Claude Code hook and plugin, and packages for Claude Desktop, ChatGPT and Codex, and the Gemini CLI. Everything here is MIT licensed. The Immiscible server itself is not open source.

[![immiscible on npm](https://img.shields.io/npm/v/immiscible?label=npx%20immiscible&color=1E2F6E)](https://www.npmjs.com/package/immiscible)
[![@immiscible/sdk on npm](https://img.shields.io/npm/v/@immiscible/sdk?label=%40immiscible%2Fsdk&color=1E2F6E)](https://www.npmjs.com/package/@immiscible/sdk)
[![@immiscible/claude-code-hook on npm](https://img.shields.io/npm/v/@immiscible/claude-code-hook?label=claude-code-hook&color=1E2F6E)](https://www.npmjs.com/package/@immiscible/claude-code-hook)
[![immiscible on PyPI](https://img.shields.io/pypi/v/immiscible?label=pip%20install%20immiscible&color=1E2F6E)](https://pypi.org/project/immiscible/)
[![MIT licence](https://img.shields.io/badge/licence-MIT-F0563A)](LICENSE)

```bash
npx immiscible check     # what the agents on this machine can touch; runs locally, no sign-in
npx immiscible init      # put Immiscible in front of the agent in this project
```

<p align="center"><img src="docs/screenshots/cli-hook.png" alt="Three tool calls through the Claude Code hook: git status is allowed, git push asks a person with the reason and an approval link, and sending .env off the machine is denied" width="900"><br><sub>The hook’s answers to three Bash calls, against a local demo server. The decisions and reasons come from the server; Claude Code turns an ask into its own permission prompt.</sub></p>

## What is published

The CLI is at 0.2.0, released on 7 October 2026; the other packages are at 0.1.1, released on 6 October 2026. The SDKs here match what was published; the standalone hook package has unreleased changes since, listed in its CHANGELOG (the CLI already bundles the current hook).

| Package | What it is | Published | Install |
|---|---|---|---|
| [`immiscible`](packages/immiscible-cli) | The developer CLI | npm 0.2.0 | `npx immiscible try`, then `npx immiscible init` |
| [`@immiscible/sdk`](packages/immiscible-js) | TypeScript and JavaScript, with guards for the OpenAI Agents SDK, LangChain, LangGraph and the Vercel AI SDK | npm 0.1.1 | `npm install @immiscible/sdk` |
| [`immiscible`](packages/immiscible-py) | Python 3.9+, standard library only | PyPI 0.1.1 | `pip install immiscible` |
| [`@immiscible/claude-code-hook`](packages/immiscible-claude-code) | A fail-closed PreToolUse hook for Claude Code | npm 0.1.1 | installed by `npx immiscible init` |
| [Claude Code plugin](packages/immiscible-claude-code) | The hook, the MCP server, the `ask-before-acting` skill and the `immiscible-analyst` subagent, which reads and never acts | from this repository | `/plugin marketplace add efr7-7/immiscible-sdks`, then `/plugin install immiscible@immiscible` |
| [Claude Desktop extension](packages/immiscible-desktop) | An MCP Bundle with a dependency-free local bridge | not published | `npm run pack` in the folder, then open `dist/immiscible.mcpb` and paste the agent key |
| [ChatGPT and Codex plugin](packages/immiscible-openai) | The MCP server with OAuth, and the `ask-before-acting` skill | not published | a plugin folder; or `codex mcp add immiscible --url https://immiscible.ai/mcp --bearer-token-env-var IMMISCIBLE_AGENT_KEY` |
| [Gemini CLI extension](packages/immiscible-gemini) | The MCP server and the same instructions as context | not published | `gemini extensions install ./packages/immiscible-gemini` from a clone |

None of the plugins or extensions is listed in a directory or marketplace yet; install them from this repository.

**Coming in CLI 0.3.0 (in this repository, not yet on npm): your coding agents.** `immiscible scan` shows what Claude Code, Codex and Gemini CLI did on your machine this week, locally and with no account. `immiscible guard` puts one fail-closed check in front of Claude Code, Codex, Cursor, Windsurf, Gemini CLI, Factory Droid, opencode and Amp, with `undo` for what an agent deletes. `immiscible attest` puts what the agents did on a branch, under which rules, on its pull request as an in-toto statement your workspace can sign. `scan --ci` fails a build on any hook or MCP server a repository adds without review, and runs as a GitHub Action straight from this repository:

```yaml
- uses: efr7-7/immiscible-sdks/packages/immiscible-cli@main
```

`scan --share` and `guard --team` give a team every machine and one set of signed rules. Until 0.3.0 is on npm, run it from a clone: `node packages/immiscible-cli/bin/immiscible.mjs scan`.

**New in CLI 0.2.0:** `npx immiscible try` (a governed agent in under a minute, offline and with no account: one action allowed, one held for you to approve, one denied, then the receipt verified) and `immiscible verify` (check a signed receipt offline). What they print: [`try`](docs/screenshots/cli-try.png) and [`verify`](docs/screenshots/cli-verify.png).

## The CLI (0.2.0)

| Command | Does |
|---|---|
| `immiscible check` | Lists what the agents on this machine can touch: MCP servers and what each can do, Claude Code permissions, provider keys in `.env` and shell config. Local, changes nothing, no sign-in; a key is shown only as its prefix, last four characters and a fingerprint. `--upload` makes a report link from the findings, never a key. |
| `immiscible init` | Signs you in, creates the agent and its rule, writes `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` to `.env`, installs the Claude Code hook and deny rules after showing the diff, prints the code for your SDK and makes a live test call. Safe to run again. |
| `immiscible mcp` | Prints how to add the MCP server to Claude Code, Cursor, VS Code, Windsurf, Codex or Gemini CLI. Changes nothing. |
| `immiscible doctor` | Checks the server, sign-in, `.env`, the agent key and that the hook fails closed, and prints fixes. |
| `immiscible status` | What waits for approval, today’s decisions and this month’s spend. |
| `immiscible login`, `logout`, `whoami`, `token` | Browser sign-in by device code, and tokens for CI. |

Every command takes `--json` and has its own exit codes, so an AI coding agent can run the setup itself, with a person allowing the sign-in once. Node 22.13 or later; no dependencies.

<p align="center"><img src="docs/screenshots/cli-init.png" alt="immiscible init --hook in a project: the agent and its rule created, sent to a second owner to confirm, .env and .gitignore written, and the Claude Code settings shown as a diff before the hook is installed" width="900"></p>
<p align="center"><sub><code>init --hook</code> from CLI 0.2.0 against a local demo server with made-up data. The new rule waits for a second owner, as it would in a real workspace.</sub></p>

## In code

```ts
import { Immiscible, toolAction } from '@immiscible/sdk';

const run = new Immiscible().run(); // reads IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY
await run.guard(toolAction('deploy', { service: 'api' }, { summary: 'Deploy the api service', domain: 'mycompany.com' }), () => deploy());
```

`guard` asks, waits for a person if one is asked, runs your code only if allowed, and reports the outcome. A refusal throws with the reasons. If Immiscible cannot be reached, it fails closed.

**Enforced or a check.** The Claude Code hook is enforced: Claude Code runs it, not the model, and a failure blocks the call. `guard` in your own code is a check: your agent asks because your code does. For paths an agent cannot route around, the hosted service also offers an MCP proxy that holds the tool’s credential and a model gateway that checks the budget before each call ([the docs](https://immiscible.ai/docs/concepts)).

## Ask Immiscible

Ask about your AI spend from Claude, ChatGPT or Cursor: add `https://immiscible.ai/mcp` as a connector and ask what you spent, what is being wasted and which keys nobody is watching. It answers from your own bills. Anything that would change something, such as a budget or switching a key off, waits for a person.

For Claude Code directly: `claude mcp add --transport http immiscible https://immiscible.ai/mcp --header "Authorization: Bearer $IMMISCIBLE_AGENT_KEY"`.

## The service

These packages talk to an Immiscible server. The hosted one is [immiscible.ai](https://immiscible.ai), in the EU (Frankfurt): free for 3 governed agents and up to 5 people, with 30 days of Business on us, then Team at £39 a month billed yearly for 10 agents, with people free; [pricing](https://immiscible.ai/pricing). Self-hosting in your own cloud is offered on the Enterprise plan. Immiscible holds no security certification; [the security page](https://immiscible.ai/trust) says what is and is not done.

## Working here

Each package has its own tests: `npm test` in `packages/immiscible-js`, `packages/immiscible-cli`, `packages/immiscible-claude-code` and `packages/immiscible-desktop`; `python3 -m unittest discover -s tests -t .` in `packages/immiscible-py`. Releases are published by `.github/workflows/release-packages.yml` from a tag, with npm and PyPI trusted publishing. The packages are written in the private product repository and mirrored here. British English, no em or en dashes, and zero runtime dependencies in every package. For coding agents: [AGENTS.md](AGENTS.md).

## Links

Docs: [immiscible.ai/docs](https://immiscible.ai/docs). The CLI: [/docs/cli](https://immiscible.ai/docs/cli). The free AI check: [/check](https://immiscible.ai/check). For AI agents: [/docs/ai-agents](https://immiscible.ai/docs/ai-agents) and [llms.txt](https://immiscible.ai/llms.txt).

MIT licence for everything here. The names of other products are used only to say what works with what; none of those companies endorses or partners with Immiscible.
