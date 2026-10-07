# Changelog: @immiscible/claude-code-hook

## Unreleased

Changed

- The hook sends the project the call runs in (Claude Code's `CLAUDE_PROJECT_DIR`, or the working directory) and the working directory, so the default rules can let a coding agent past its intern stage edit and test inside its project without asking. Anything that names a path outside it still asks a person. The CLI bundles this hook from 0.2.0.

## 0.1.1 (6 October 2026)

Changed

- A line break in a Bash command is sent as ` ; `, so `ls` followed by `rm -rf ~` on the next line never reads as one harmless `ls`. The 0.1.0 hook sent it as a space; the server now treats a command name inside another command's arguments as a second command, so 0.1.0 is covered too, but upgrade.
- A command too long to send whole is cut at 289 characters and marked `[cut]`. Immiscible never lets a cut command go ahead without a person.
- `--print-config` prints the matcher that leaves out Immiscible's own read-only MCP tools (`check_action_status`, `explain_decision`, `spend_summary`, `find_waste`, `unwatched_keys`).

Server side, for every hook version: under every rule, a destructive command (`rm`, `git push --force`, `git reset --hard`, `curl ... | sh`, writing over `~/.bashrc` or `.git/hooks`) asks a person, and a secrets file or the environment leaving the machine is refused. The default rule asks before anything that is not provably read-only.

## 0.1.0 (6 October 2026)

First release.
