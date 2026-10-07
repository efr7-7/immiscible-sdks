# immiscible

The Immiscible developer CLI. One command puts Immiscible in front of the agent in your project: approvals, spend limits and a kill switch, decided before it pays, shares data or acts, with a signed record of each decision.

```shell
npx immiscible init
```

To see it first, offline and with no account:

```shell
npx immiscible try
```

Node 22.13 or later. No dependencies. Free for up to 5 people at https://immiscible.fly.dev.

| Command | Does |
|---|---|
| `immiscible try` | A governed agent in under a minute, offline, no account: one action allowed, one held for you to approve at the prompt, one denied; then the receipt, verified. Runs against the SDK's fake on 127.0.0.1. |
| `immiscible verify <receipt>` | Check a signed receipt offline (`--keys keys.json`, or your server's published keys). Exit 12 when it is not valid. |
| `immiscible check` | What the agents on this machine can touch: MCP servers and what each can do, Claude Code permissions, provider keys in `.env` and shell config. Runs locally and needs no sign-in; a key is shown only as its prefix, last four characters and a fingerprint. `--upload` sends the findings (never a key) for a report link. Exit 11 when something is high risk. |
| `immiscible login` | Sign in through your browser (OAuth device code with PKCE). `--token` stores a token you already have. |
| `immiscible init` | Detect the project, create the agent and its rule, add `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` to `.env`, install the Claude Code hook (after showing the diff), print the code for your SDK, make a live test call. Safe to run again. |
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

Claude Code's MCP server in one line: `claude mcp add --transport http immiscible https://immiscible.fly.dev/mcp --header "Authorization: Bearer $IMMISCIBLE_AGENT_KEY"`.

The token is stored in `~/.config/immiscible/credentials.json` with mode 0600. Guide: https://immiscible.fly.dev/docs/cli. Answers to common questions (Claude Code hooks, approvals, spend limits, MCP permissions): https://immiscible.fly.dev/docs/answers

MIT licence.
