# @immiscible/claude-code-hook

Block or approve Claude Code tool calls by rule. A `PreToolUse` hook that asks Immiscible before every matching tool call: `allow` carries on, `deny` refuses with the reasons, `approval_required` asks you with the approval link.
Agent governance and spend control for Claude Code: Bash, file edits, WebFetch and every MCP tool, checked before they run.
It fails closed. One file, no dependencies, Node 18+.

The quickest install is `npx immiscible init` in your project: it creates the agent and its rule, writes `.env` and adds this hook to `.claude/settings.json` after showing you the change. By hand:

```shell
npm install -g @immiscible/claude-code-hook
```

```shell
export IMMISCIBLE_URL=https://immiscible.fly.dev     # or your own server
export IMMISCIBLE_AGENT_KEY=ask_...
immiscible-claude-code-hook --print-config     # a PreToolUse entry for .claude/settings.json
```

`.claude/settings.json` (what `--print-config` prints, with your absolute path):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__(?!immiscible__(check_action_status|explain_decision|spend_summary|find_waste|unwatched_keys)$).*",
        "hooks": [{ "type": "command", "command": "node \"/path/to/immiscible-claude-code-hook.mjs\" || exit 2", "timeout": 60 }]
      }
    ]
  }
}
```

The hook in `hook/` is a copy of the repository's `scripts/claude-code-hook.mjs` (also served by a running Immiscible at `/downloads/claude-code-hook.mjs`); `npm run sync` refreshes it and `npm test` fails if the two differ. It reads `IMMISCIBLE_*`, or the older `ASSAY_*`; the `bin` adds `--print-config`.

Tool calls are counted against their own line, 200 in 10 minutes by default, before a person is asked; the guide says how to raise it.

Use it beside Claude Code's own permission rules, not instead of them: those match patterns; this decides by where a call goes, asks a named person, and keeps a signed record. A new agent is an intern, so a person signs off its tool calls until it earns more on evidence; its default rule lets provably read-only calls (`ls`, `git status`, `git diff`, `git log`, reading a file) go ahead, still recorded, and, once the agent is past its intern stage, edits, test runs and builds inside the project (`CLAUDE_PROJECT_DIR`, which the hook sends). Pushes, deploys, publishes, installs, destructive commands and anything outside the project always ask. Immiscible's own read-only MCP tools are left out of the matcher, so it never asks itself.

As a Claude Code plugin it carries the hook and Immiscible's MCP server; both read `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY` from the shell or the project's `.env`, which `npx immiscible init` writes.

Guide: [the Claude Code hook](https://immiscible.fly.dev/docs/guides/mcp-proxy#the-claude-code-hook). Quickstart: [immiscible.fly.dev/docs/quickstart](https://immiscible.fly.dev/docs/quickstart). SDKs: [`@immiscible/sdk`](https://www.npmjs.com/package/@immiscible/sdk), [`immiscible` on PyPI](https://pypi.org/project/immiscible/). MIT licence.
