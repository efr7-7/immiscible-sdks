# immiscible

The Immiscible developer CLI. See what your coding agents did this week, then put a fail-closed guard in front of every one of them, on your own machine, with no account (from 0.3.0, not yet on npm):

```shell
npx immiscible scan     # Claude Code, Codex and Gemini CLI: commands, secrets read, domains, cost
npx immiscible guard    # one guard for Claude Code, Codex, Cursor, Windsurf, Gemini CLI, Droid, opencode and Amp
```

For your team, `scan --share` and `guard --team` bring every machine under one set of rules, and `scan --ci` makes every hook and MCP server a repository adds a reviewed change.

For any other agent, one command puts Immiscible in front of it: approvals, spend limits and a kill switch, decided before it pays, shares data or acts, with a signed record of each decision.

```shell
npx immiscible init
```

To see that first, offline and with no account:

```shell
npx immiscible try
```

Node 22.13 or later. No dependencies. Free for up to 5 people at https://immiscible.ai.

| Command | Does |
|---|---|
| `immiscible try` | A governed agent in under a minute, offline, no account: one action allowed, one held for you to approve at the prompt, one denied; then the receipt, verified. Runs against the SDK's fake on 127.0.0.1. |
| `immiscible verify <receipt>` | Check a signed receipt, or an attestation, offline (`--keys keys.json`, or your server's published keys). Exit 12 when it is not valid. |
| `immiscible evidence ai-act` | Save the EU AI Act deployer evidence pack for the workspace you are signed in to, from 0.3.0 (not yet published): a zip, or JSON with `--out pack.json`. Exit 12 when the ledger did not verify. |
| `immiscible check` | What the agents on this machine can touch: MCP servers and what each can do, Claude Code permissions, provider keys in `.env` and shell config. Runs locally and needs no sign-in; a key is shown only as its prefix, last four characters and a fingerprint. `--upload` sends the findings (never a key) for a report link. Exit 11 when something is high risk. |
| `immiscible scan` | What your coding agents did this week, from the history Claude Code, Codex and Gemini CLI keep locally and the guard's own log for the others, from 0.3.0 (not yet published): risky commands, secret files read, domains reached, a secret read then the network, cost and bypass modes. Never shows prompts, file contents or secrets. `--html` for a one-file report. Exit 11 when something is high risk. |
| `immiscible attest` | What the coding agents did on this branch, as an in-toto statement for its pull request, from 0.3.0 (not yet published): sessions and cost per agent, what the guard allowed, asked and refused by rule, agents that ran unguarded, and whether the decision log verifies. Counts only. `--comment` posts and updates it on the pull request with gh; `--sign` has your workspace sign it for `verify`. |
| `immiscible login` | Sign in through your browser (OAuth device code with PKCE). `--token` stores a token you already have. |
| `immiscible init` | Detect the project, create the agent and its rule, add `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` to `.env`, install the Claude Code hook (after showing the diff), print the code for your SDK, make a live test call. Safe to run again. |
| `immiscible install codex` | A fail-closed hook for Codex, Cursor, Windsurf, Gemini CLI or Factory Droid (a plugin for opencode or Amp), for you or (`--scope managed`) for everyone on the machine; `--dry-run` shows the change. Not yet published. |
| `immiscible doctor` | Check the server, clock, sign-in, `.env`, agent key, the hook (and that it fails closed) and `.gitignore`; print fixes. |
| `immiscible status` | What waits for approval, today's decisions, this month's spend in the books currency. |
| `immiscible whoami` | Who, which workspace and which server. |
| `immiscible logout` | Revoke this machine's token and forget it. |
| `immiscible token create --name ci` | A CI token, shown once (`--read-only`, `--days`); `token list`, `token revoke <id>`. |
| `immiscible mcp` | Print how to add the MCP server to Claude Code, Cursor, VS Code, Windsurf, Codex or Gemini CLI (`--client`). Changes nothing; never prints the key. |

Non-interactive (CI, AI coding agents): `--yes`, `--name`, `--purpose`, `--json`, `IMMISCIBLE_TOKEN` and `IMMISCIBLE_URL`. Every outcome has its own exit code; `immiscible help --json` lists commands, flags and exit codes as data.

An AI coding agent can set it up itself, with a person allowing the sign-in once:

```shell
npx immiscible login --json        # line 1: a link to show the person; line 2 once they allow it
npx immiscible init --yes --json   # the agent, its rule, .env, the Claude Code hook and a live test call
npx immiscible doctor --json       # exit 0 when nothing failed
```

Claude Code's MCP server in one line: `claude mcp add --transport http immiscible https://immiscible.ai/mcp --header "Authorization: Bearer $IMMISCIBLE_AGENT_KEY"`.

The token is stored in `~/.config/immiscible/credentials.json` with mode 0600. Guide: https://immiscible.ai/docs/cli. Answers to common questions (Claude Code hooks, approvals, spend limits, MCP permissions): https://immiscible.ai/docs/answers

MIT licence.
