# immiscible

The Immiscible developer CLI. One command puts Immiscible in front of the agent in your project: decisions before it pays, shares data or acts.

```shell
npx immiscible init
```

Node 22.13 or later. No dependencies. Free for up to 5 people at https://immiscible.fly.dev.

| Command | Does |
|---|---|
| `immiscible login` | Sign in through your browser (OAuth device code with PKCE). `--token` stores a token you already have. |
| `immiscible init` | Detect the project, create the agent and its rule, add `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` to `.env`, install the Claude Code hook (after showing the diff), print the code for your SDK, make a live test call. Safe to run again. |
| `immiscible doctor` | Check the server, clock, sign-in, `.env`, agent key, the hook (and that it fails closed) and `.gitignore`; print fixes. |
| `immiscible status` | What waits for approval, today's decisions, this month's spend in the books currency. |
| `immiscible whoami` | Who, which workspace and which server. |
| `immiscible logout` | Revoke this machine's token and forget it. |
| `immiscible token create --name ci` | A CI token, shown once (`--read-only`, `--days`); `token list`, `token revoke <id>`. |

Non-interactive (CI, AI coding agents): `--yes`, `--name`, `--purpose`, `--json`, `IMMISCIBLE_TOKEN` and `IMMISCIBLE_URL`. Every outcome has its own exit code; `immiscible help` lists them.

The token is stored in `~/.config/immiscible/credentials.json` with mode 0600. Guide: https://immiscible.fly.dev/docs/cli

MIT licence.
