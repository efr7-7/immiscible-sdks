#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: ask Immiscible before a tool call runs.
 *
 *   immiscible-claude-code-hook                    the hook itself (Claude Code runs it; the tool call arrives on stdin)
 *   immiscible-claude-code-hook --print-config     print a PreToolUse entry for .claude/settings.json
 *
 * Environment (each also read under its older ASSAY_ name):
 *   IMMISCIBLE_URL          your Immiscible base URL (default http://localhost:8787)
 *   IMMISCIBLE_AGENT_KEY    an agent key, from Agents in the console
 *   IMMISCIBLE_TIMEOUT_MS   how long to wait for a decision (default 10000)
 *
 * It fails closed: if Immiscible cannot be reached or does not answer in
 * time, the tool call is refused.
 */

import { fileURLToPath } from 'node:url';

if (process.argv.includes('--print-config')) {
  const self = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  const config = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__.*',
          // || exit 2: Claude Code blocks only on exit code 2, so a missing file or a crash blocks too.
          hooks: [{ type: 'command', command: `node "${self}" || exit 2`, timeout: 60 }],
        },
      ],
    },
  };
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  process.exit(0);
}

await import('../hook/claude-code-hook.mjs');
