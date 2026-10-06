# Changelog: immiscible (the CLI)

## 0.1.2 (not yet published)

Changed

- The bundled hook says which project each call runs in (Claude Code's `CLAUDE_PROJECT_DIR`, or the working directory), so a coding agent past its intern stage can edit and test inside its project without asking. Anything outside the project still asks a person.
- `doctor` reads `IMMISCIBLE_AGENT_KEY` and `IMMISCIBLE_URL` the way the hook does: the environment first, then `.env`. When the two differ it warns and names which one it checked.
- `doctor` compares the installed hook with the one your server serves at `/downloads/claude-code-hook.mjs`, and warns "the hook is out of date" when they differ, rather than reporting it as fine.
- `check` ends on a next step that matches what it found: `doctor` in a project the hook already governs, `init` only when something is still open.

Fixed

- `status` counted `init`'s own connection tests in today's figures (a test could show as a refusal). They are left out, as they already were from the agent's record. (A server change.)

## 0.1.1 (6 October 2026)

Added

- `immiscible check`: what the agents on this machine can touch (MCP servers, Claude Code permissions, provider keys in `.env` files and shell config). Runs locally and changes nothing; `--upload` makes a report link from the findings only. Exit code 11 when something is high-risk.
- `immiscible mcp [--client <client>]`: the one-line command or config entry that adds Immiscible's MCP server to Claude Code, Cursor, VS Code, Windsurf, Codex, Gemini or a connector. Changes nothing.
- `help --json`, and `--no-gitignore` for `init`.
- `init --hook` now also adds Claude Code deny rules beside the hook, shown in the same diff: `Bash(rm -rf:*)`, `Bash(rm -fr:*)`, `Bash(sudo rm:*)`, `Bash(git push --force:*)`, `Bash(git push -f:*)`, `Bash(git reset --hard:*)`, `Bash(git clean -f:*)`, `Read(./.env)` and `Read(./.env.*)`. Deny rules you already have are kept, in your order.

Changed

- The hook matcher leaves out Immiscible's own read-only MCP tools, so the hook never asks Immiscible about asking Immiscible. `doctor` accepts the older matcher.
- The bundled hook sends a line break in a Bash command as ` ; `, so two commands never read as one, and marks a command too long to send whole with `[cut]`. Immiscible asks a person about a cut command.
- `doctor` prints the docs link on its own line under each fix.
- The code `init` prints for a tool rule defines the values it uses and opens a ticket rather than sending an invoice, which a tool rule does not cover.

Fixed

- `init` could print an old answer from its test call after a rule changed (for example once a second owner confirmed it). The server now makes the test afresh whenever the agent's rules change.
- An agent made by `init --yes` had no one named as answering for it. The person signing in is now its sponsor, and Something else is recorded as General tasks.

## 0.1.0 (6 October 2026)

First release: `login`, `logout`, `whoami`, `init`, `doctor`, `status` and `token`.
