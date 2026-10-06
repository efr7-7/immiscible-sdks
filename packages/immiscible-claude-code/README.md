# @immiscible/claude-code-hook

A Claude Code PreToolUse hook that asks Immiscible before every matching tool call. `allow` carries on, `deny` refuses with the reasons, `approval_required` asks you with the approval link.
Agent governance and spend control for Claude Code: Bash, file edits, WebFetch and every MCP tool, checked before they run.
It fails closed. One file, no dependencies, Node 18+.

```shell
npm install -g @immiscible/claude-code-hook
```

```shell
export IMMISCIBLE_URL=https://your-immiscible.example
export IMMISCIBLE_AGENT_KEY=ask_...
immiscible-claude-code-hook --print-config     # a PreToolUse entry for .claude/settings.json
```

`.claude/settings.json` (what `--print-config` prints, with your absolute path):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__.*",
        "hooks": [{ "type": "command", "command": "node \"/path/to/immiscible-claude-code-hook.mjs\" || exit 2", "timeout": 60 }]
      }
    ]
  }
}
```

The hook in `hook/` is a copy of the repository's `scripts/claude-code-hook.mjs` (also served by a running Immiscible at `/downloads/claude-code-hook.mjs`); `npm run sync` refreshes it and `npm test` fails if the two differ. It reads `IMMISCIBLE_*`, or the older `ASSAY_*`; the `bin` adds `--print-config`.

Tool calls are counted against their own line, 200 in 10 minutes by default, before a person is asked; the guide says how to raise it.

Guide: [the Claude Code hook](https://immiscible.fly.dev/docs/guides/mcp-proxy#the-claude-code-hook). Quickstart: [immiscible.fly.dev/docs/quickstart](https://immiscible.fly.dev/docs/quickstart). SDKs: [`@immiscible/sdk`](https://www.npmjs.com/package/@immiscible/sdk), [`immiscible` on PyPI](https://pypi.org/project/immiscible/). MIT licence.
