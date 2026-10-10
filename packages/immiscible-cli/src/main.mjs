/**
 * immiscible: the developer CLI. Dispatch, help, and the one place errors
 * become output and an exit code.
 */

import { parseArgs, FLAGS, nearest } from './args.mjs';
import { makeUi } from './ui.mjs';
import { makeContext } from './context.mjs';
import { CliError, EXIT, usage } from './errors.mjs';
import { VERSION } from './version.mjs';
import { login } from './commands/login.mjs';
import { whoami, logout } from './commands/session.mjs';
import { init } from './commands/init.mjs';
import { doctor } from './commands/doctor.mjs';
import { status } from './commands/status.mjs';
import { token } from './commands/token.mjs';
import { mcp, MCP_CLIENTS } from './commands/mcp.mjs';
import { check } from './commands/check.mjs';
import { scanHistory } from './commands/scan.mjs';
import { replay } from './commands/replay.mjs';
import { attest } from './commands/attest.mjs';
import { undo } from './commands/undo.mjs';
import { cost } from './commands/cost.mjs';
import { policy } from './commands/policy.mjs';
import { tryIt } from './commands/try.mjs';
import { verify } from './commands/verify.mjs';
import { evidence } from './commands/evidence.mjs';
import { install } from './commands/install.mjs';
import { guard } from './commands/guard.mjs';
import { installAgents, AGENT_TARGETS } from './commands/install-agents.mjs';
import { showCard, aboutJson } from './banner.mjs';

const about = async ({ ui }) => {
  if (ui.json) ui.writeJson(aboutJson()); else await showCard({ ui });
  return EXIT.OK;
};

/** install claude-code (the Claude Code fleet pack) or install codex|cursor|windsurf|gemini|droid|opencode|amp (the other agents' hooks and plugins). */
const installAny = (ctx) => ((ctx.rest?.[0] ?? null) === 'claude-code' ? install(ctx) : installAgents(ctx));

const COMMANDS = { about, try: tryIt, verify, login, logout, whoami, init, install: installAny, guard, doctor, status, token, mcp, check, scan: scanHistory, replay, undo, cost, attest, policy, evidence };

const HELP = {
  main: `Immiscible: what your coding agents did, a guard in front of them in one command, and what any agent may spend, share and do.

Usage
  immiscible <command> [flags]

Commands
  scan      What your coding agents did this week: commands, secret reads, domains, cost. Runs locally
  guard     Put a fail-closed hook in front of every coding agent here, in one command. Undo with --off
  undo      Put files back to the checkpoint the guard took before an agent deleted or overwrote them
  replay    One coding-agent session as a timeline: every call, every decision, hash-chained
  cost      What coding agents cost per branch, pull request or ticket, across vendors. Runs locally
  attest    What the agents did on this branch and under which rules, for its pull request: attest --comment
  try       See it work in under a minute, offline, with no account: allowed, held, denied, verified
  verify    Check a signed receipt or attestation offline: immiscible verify receipt.jwt --keys keys.json
  check     What the agents here can touch: MCP servers, Claude Code permissions, keys. Runs locally
  init      Govern the agent in this project: create it, write .env, install the Claude Code hook, test it
  install   A fail-closed hook for every session: install claude-code, codex, cursor, windsurf, gemini, droid, opencode or amp
  login     Sign in through your browser (device code); --token for CI
  status    What waits for approval, today's decisions, this month's spend
  doctor    Check the server, clock, sign-in, .env, agent key and hook; print fixes
  whoami    Who and which workspace you are signed in as
  logout    Revoke this machine's token and forget it
  token     Make, list and revoke CI tokens: token create --name ci
  policy    What a draft rule would have decided on your agents' real requests: policy replay --file draft.json
  evidence  Download the EU AI Act deployer evidence pack: evidence ai-act --out pack.zip
  mcp       Print how to add the MCP server to Claude Code, Cursor, VS Code and others
  about     The version, credits and links

Flags for every command
  --url <url>     Your Immiscible server (or IMMISCIBLE_URL)
  --token <tok>   A CLI token (or IMMISCIBLE_TOKEN), for CI
  --json          One JSON object on stdout, nothing else
  --no-color      No colour (NO_COLOR is respected too)
  -h, --help      Help for a command
  -v, --version   The version

Exit codes: 0 ok, 1 error, 2 usage, 3 not signed in, 4 input needed, 5 unreachable,
6 refused, 7 doctor found failures, 8 sign-in denied or expired, 9 test call failed,
10 waiting for another owner, 11 check or scan found something high-risk, 12 receipt not valid
or evidence ledger did not verify.

Docs: https://immiscible.ai/docs/cli (or /docs/cli on your own server)`,

  about: `immiscible about: the version, credits and links, drawn as the welcome card.

Usage
  immiscible about [--json]

Shown too when immiscible runs with no command in a terminal. Plain text on a pipe or in CI;
no animation when IMMISCIBLE_NO_MOTION is set.`,

  try: `immiscible try: see a governed agent in under a minute, with no account.

Usage
  immiscible try [--yes] [--json]

  Starts a test server on this machine (127.0.0.1) with its own signing key, and a
  made-up finance agent asks it three times: a tool call is allowed, a payment to a
  new supplier is held for you to approve here, and a payment to a lookalike of a
  known supplier is denied. Then it saves the receipt and runs immiscible verify on
  it, offline. The test server imitates a rule; it is not the real policy engine.
  Nothing leaves the machine, and the server stops when try ends.

Flags
  -y, --yes   Approve the held payment without asking (needed when not a terminal)

Exit codes: 0 done, 4 not a terminal and no --yes.`,

  verify: `immiscible verify: check a signed receipt, offline.

Usage
  immiscible verify <receipt.jwt | receipt | -> [--keys <keys.json | url>] [--json]

  Checks the Ed25519 signature, the key id, the type and the expiry, and prints what
  the receipt says was allowed: the action, the amount and where it went, and whether
  a person approved it. Needs no account and no agent key.

Flags
  --keys <file|url>  The issuer's public keys, as served at /.well-known/immiscible-keys.json.
                     A file means nothing is fetched. Without it, the keys come from your
                     server (--url, IMMISCIBLE_URL, or the one you signed in to), and the
                     receipt must have been issued by that server.

Exit codes: 0 valid, 12 not valid (altered, expired, an unknown key or another issuer).`,

  check: `immiscible check: what the agents on this machine can touch.

Usage
  immiscible check [--upload] [--json] [--dir <path>]

  Reads this project and your home directory, and runs nothing: MCP configs (.mcp.json,
  .cursor/mcp.json, .vscode/mcp.json, ~/.claude.json, Claude Desktop, Windsurf, Gemini)
  and what each server can do; Claude Code permission settings; provider keys in .env
  files and shell config, and whether git ignores the file. A key is shown only as its
  provider, its prefix and last four characters, and a fingerprint (sha256:...).
  Nothing leaves the machine.

Flags
  --upload      Send the findings, and only the findings, to make a report link that
                lasts seven days. No key (not even redacted), no file contents.
  --dir <path>  The project directory (default: here)

Exit codes: 0 nothing high-risk, 11 something high-risk (a payment tool that never asks,
any shell command allowed, a key in a file git does not ignore).`,

  scan: `immiscible scan: what your coding agents did this week.

Usage
  immiscible scan [--since <7d | 24h | 2w | date>] [--html <file>] [--json]
  immiscible scan --share [--name <machine name>]
  immiscible scan --ci [--approve] [--strict] [--dir <repo>] [--json]

  Reads the session history Claude Code, Codex and Gemini CLI already keep on this
  machine (~/.claude/projects, ~/.codex/sessions, ~/.gemini/tmp) and their hooks and
  permission settings, and reports: sessions by agent and repository; commands run,
  flagging force pushes, rm -rf, terraform apply, kubectl and package publishes; secret
  files read (.env, keys, *.pem, cloud credentials); domains reached; a secret read
  followed by the network in one session; cost at list prices; and bypass modes and
  hooks that are not Immiscible's. It leads with the three most important findings.
  Cursor, Windsurf, Factory Droid, opencode and Amp: their own history is not read; once
  guarded, the calls their hooks let through are counted from the guard's own log.
  No prompt text, file contents or secret values are shown or written: only paths,
  command names, domains and counts. Nothing leaves the machine without --share; no account needed.

Flags
  --since <period|date>  How far back (default 7d)
  --html <file>          Also write the report as one self-contained HTML file
  --dir <path>           The project to check settings for, besides those sessions ran in
  --share                Also send this machine's guard to your workspace (signed in): agent
                         names, how they are guarded, decision counts by rule and finding
                         kinds, for the Agents page. Never a command, path, domain or repository
  --name <name>          With --share, what the Agents page calls this machine

In CI (--ci): instead of history, the hooks, plugins and MCP servers this repository
configures for any coding agent (Claude Code, Codex, Cursor, Windsurf, Gemini CLI, Droid,
opencode, Amp, VS Code), each with a fingerprint, against the allow list committed in
.immiscible/agent-config.json. In GitHub Actions each one not allowed is an annotation.
--approve writes the allow list for what is there now, to commit for review.
Each entry is also checked for risks: an unpinned npx, uvx or similar package, a key in the
file, a SessionStart hook reaching the network, a remote server over plain http.
--strict fails the build on a risk even when the entry is approved.

Exit codes: 0 nothing high-risk, 11 something high-risk (a secret read then the network,
a force push, approvals bypassed, an unrecognised SessionStart hook; with --ci, anything
not in the allow list).`,

  policy: `immiscible policy replay: test a rule on what really happened, before it is live.

Usage
  immiscible policy replay --file draft.json [--since 30d] [--exclusive] [--json]

  Decides every request your agents made in the window again, in order, under the
  draft rule, with limits adding up as they would have, and shows how many would be
  allowed, asked about or refused, against what was decided then, with examples. The
  draft is checked and never stored or signed; nothing is written.

  draft.json holds one rule or a list, as the console's rule editor writes them, or
  { "template": "coding_agent_baseline" }. A draft carrying the id of an existing rule
  stands in for it; any other is added beside the agent's rules.

Flags
  --file <file>          The draft rule or rules (JSON)
  --since <period|date>  How far back (default 30d, at most 92 days)
  --exclusive            Replay the drafts alone, without the rules already live`,

  cost: `immiscible cost: what your coding agents cost, per branch, pull request or ticket.

Usage
  immiscible cost [--by branch|pr|ticket|repo|agent] [--since 30d] [--csv <file>] [--json]
  immiscible cost --share [--since 30d]            also send each session's cost to your workspace
  immiscible cost --team [--by pr|branch|ticket|repo|agent|person] [--csv <file>]   the team's, together

  Adds up the sessions Claude Code, Codex and Gemini CLI kept on this machine, at list
  prices, grouped across vendors: per branch (the default), per pull request, per ticket
  id in the branch name (ENG-123), per repository or per agent. A session with no branch,
  pull request or ticket to go on is shown as unattributed, never as zero.

  --by pr asks the GitHub CLI (gh) for each repository's pull requests and matches them
  by branch; it shows which were merged. Everything else runs locally and sends nothing,
  unless you --share: then each session's agent, repository, branch, pull request, ticket
  id and cost goes to your workspace (never a prompt, command or file), and --team shows
  everyone's together, per pull request across vendors and people.

Flags
  --by <grouping>        branch (default), pr, ticket, repo or agent
  --since <period|date>  How far back (default 30d)
  --csv <file>           Also write every row as CSV
  --prs                  With --by ticket, also read ticket ids from pull request titles (needs gh)
  --share                Also send each session's cost to your workspace (signed in)
  --team                 The team's cost from what everyone shared (owners, admins, analysts)`,

  attest: `immiscible attest: what the coding agents did on this branch, for its pull request.

Usage
  immiscible attest [--base <ref>] [--comment] [--sign] [--out <file>] [--json]
  immiscible attest --check [--strict]      in CI, on a pull request

  Reads the agents' own history and the guard's decision log on this machine, keeps what
  belongs to the branch checked out here (its sessions, and the decisions made in them
  since the branch began), and writes it as an in-toto Statement about the branch head:
  each agent's sessions, models and cost at list prices, what the guard allowed, asked
  about and refused by rule, any agent that ran with no guard, the team rules in force,
  and whether the decision log verifies. Counts only: never a command, path or prompt.

Flags
  --base <ref>    The branch it is measured from (default: origin's default branch, main or master)
  --comment       Post it on the branch's pull request, or update the one posted before (needs gh)
  --sign          Have your workspace sign it (signed in); immiscible verify checks the token offline
  --out <file>    Also write the statement as JSON
  --check         In CI: verify the pull request's signed attestation against your server's keys
                  and its head commit. An agent that ran unguarded, or a decision log that did not
                  verify, exits 11; a signature that does not hold exits 12
  --strict        With --check, also exit 11 when there is none, it is unsigned, or it is for an
                  earlier commit

  A signature says which workspace received the statement and when, and that it has not
  changed since. The counts are what this machine read.

Exit codes: 0 ok, 2 not on a branch with a base, 3 --sign without a sign-in, 11 --check found an
unguarded agent or a broken log, 12 the signature did not check out.`,

  replay: `immiscible replay: the flight recorder for your coding agents.

Usage
  immiscible replay [--since <7d | 24h | 2w | date>] [--json]
  immiscible replay <session> [--html <file>] [--json]

  With no session, lists the sessions in the window, newest first. With one (its id, or
  the first characters of it), shows that session as one timeline: every command, file
  read and write and fetch, in order, with the decision the guard made on each and the
  rule behind it. Calls the guard refused are marked as not run.

  It reads two things already on this machine: the history Claude Code, Codex and
  Gemini CLI keep, and the decision log immiscible guard's hooks write
  (~/.immiscible/decisions, one file a day). Each line of that log carries the hash of
  the line before, so a line removed or edited is found and named. Credentials in
  commands are redacted by shape; prompt text and file contents are never shown.
  Nothing leaves the machine; no account needed.

Flags
  --since <period|date>  How far back (default 7d)
  --html <file>          Also write the session as one self-contained HTML file

Exit codes: 0 ok, 2 no such session, 12 the decision log's hash chain is broken.`,

  undo: `immiscible undo: put files back as they were before a coding agent changed them.

Usage
  immiscible undo [--json]
  immiscible undo <checkpoint> [--dry-run] [--yes] [--json]

  Before a call that deletes or overwrites files in a git repository (rm, git clean,
  git reset --hard, git checkout --, edits to agent configuration), the guard's hooks
  take a checkpoint: every tracked and untracked file that git does not ignore, kept as
  a commit under refs/immiscible/checkpoints/ in that repository. Nothing is pushed:
  git pushes branches and tags, never these. Checkpoints older than 7 days are deleted
  as new ones are taken. When Claude Code or Cursor asks you to approve such a call,
  the question names the checkpoint.

  With no checkpoint, lists those of the last 7 days. With one, shows what would
  change, asks, takes a checkpoint of how things are now (so the undo can be undone),
  then writes the files back, removes files made since and restores the index. Commits,
  branches, ignored files and anything outside the repository are left as they are.

Flags
  --dry-run   Show what would change and write nothing
  -y, --yes   Go ahead without asking (needed when not a terminal)

Exit codes: 0 done, 2 no such checkpoint, 4 a yes is needed.`,

  init: `immiscible init: govern the agent in this project.

Usage
  immiscible init [--name <name>] [--purpose <purpose>] [--yes] [--json]

  Detects the project (package.json, pyproject.toml, requirements, .claude/, MCP configs,
  x402 and wallet SDKs), creates the agent and its rule, adds IMMISCIBLE_URL and
  IMMISCIBLE_AGENT_KEY to .env without replacing what is there, installs the Claude Code
  hook after showing the change, prints the code for your SDK and makes a live test call.
  Running it again changes nothing that is already right.

Flags
  --name <name>        The agent's name, as people will see it
  --purpose <purpose>  pays_invoices, books_travel, handles_refunds, buys_software,
                       answers_customers or other
  -y, --yes            Accept the defaults and confirm the changes (needed when not a terminal)
  --hook / --no-hook   Install the Claude Code hook even without .claude/, or never
  --no-test            Skip the live test call
  --no-gitignore       Leave .gitignore alone (init adds .env to it otherwise)
  --force              Replace IMMISCIBLE_URL in .env when it points elsewhere
  --dir <path>         The project directory (default: here)

Exit codes: 0 governed, 4 confirmation or input needed, 9 test call failed,
10 the rule waits for another owner to confirm.`,

  guard: `immiscible guard: the fix after immiscible scan, in one command.

Usage
  immiscible guard [--agents all|claude-code,codex,cursor,windsurf,gemini,droid,opencode,amp] [--scope user|managed]
                   [--team | --connect --key <agent key>] [--dry-run] [--yes] [--json]
  immiscible guard --off [--dry-run] [--yes]
  immiscible guard --status | --pause <15m..2h> | --resume

  Finds the coding agents on this machine and puts one fail-closed hook in front of
  each (the same hooks immiscible install writes). With no account the hooks run local
  rules and send nothing anywhere:

    Refused  force pushes to main, master, release or production; rm -r of the root
             or home directory; secrets sent off the machine; disk wipes; network or
             shutdown lines added to shell start-up files
    Asked    publishing; terraform, pulumi, kubectl and helm changes; curl | sh; sudo;
             history rewrites; dropping a database; edits to agent and shell
             configuration and to Immiscible's own records; the network after the
             session read a secret file

  Claude Code, Cursor and Factory Droid ask you at the keyboard; Codex, Windsurf, Gemini
  CLI, opencode and Amp cannot ask from a hook, so they refuse with the way to go ahead.

  --team (signed in) adds your workspace's own rules, set by an admin on the Agents
  page: commands to refuse or ask about, protected branches, blocked domains. Fetched
  signed and checked, then decided on this machine; they only add, never loosen.

  Before a call that deletes or overwrites files in a git repository, the hooks take
  a checkpoint, and immiscible undo puts the files back.

  --connect sends the same calls to your Immiscible server instead, so a named person
  approves in Slack, Teams, email or on the phone, and every decision is signed.

  --off puts every file back exactly as it was before guard, from ~/.immiscible/guard.json;
  a file changed since guard wrote it is left alone and named.

Flags
  --agents <list>  Only these agents (default: every one found)
  --scope <scope>  user (default) or managed, for everyone on the machine (as administrator)
  --team           Add your workspace's rules to the local ones (signed in; run again to update)
  --connect        Ask the server instead of the local rules (needs --key or IMMISCIBLE_AGENT_KEY)
  --key <key>      An agent key, for --connect
  --status         What is guarded here, how, the team's rules, and any pause
  --pause <time>   For up to 2h, let through what would be asked (logged as paused); refusals stay.
                   An agent cannot run this, or --off: the guard refuses it
  --resume         End a pause now
  --off            Undo guard
  --dry-run        Show every change and write nothing
  -y, --yes        Go ahead without asking (needed when not a terminal)`,

  install: `immiscible install claude-code: one Claude Code hook for a whole machine.

Usage
  immiscible install claude-code [--scope user|managed] [--transport command|http]
                                 [--key <agent key>] [--gateway <url>] [--dry-run] [--yes] [--json]

  user (the default) merges the hook into ~/.claude/settings.json, so every project
  this person opens is governed. managed writes Claude Code's managed settings file
  (/Library/Application Support/ClaudeCode on macOS, /etc/claude-code on Linux,
  C:\\Program Files\\ClaudeCode on Windows; run as an administrator), which people cannot
  override, and sets allowManagedHooksOnly so only managed hooks run.

  command (the default) copies the hook beside the settings and runs it with node; it
  fails closed, so a tool call is refused when Immiscible cannot answer. http has
  Claude Code send each PreToolUse and PermissionRequest event to your server
  (/v1/hooks/claude-code); the server refuses anything it cannot check, but if the
  server cannot be reached at all Claude Code lets the call go on.

  Writes IMMISCIBLE_URL (and IMMISCIBLE_AGENT_KEY with --key, ANTHROPIC_BASE_URL with
  --gateway) into the settings' env, adds Claude Code deny rules for the most
  destructive commands, keeps every other setting and hook, and changes nothing when
  run again. After copying the hook it runs node <hook> --self-test.

Flags
  --scope <scope>          user or managed
  --transport <transport>  command or http
  --key <key>              An agent key to write into the settings (left out, each
                           person's environment supplies IMMISCIBLE_AGENT_KEY)
  --gateway <url>          Send Claude Code's model traffic through your Immiscible gateway
  --dry-run                Show the change and write nothing
  -y, --yes                Write without asking (needed when not a terminal)

immiscible install <${AGENT_TARGETS.join('|')}>: a fail-closed hook for another coding agent.

Usage
  immiscible install <${AGENT_TARGETS.join('|')}> [--scope user|managed] [--key <agent key>]
                     [--dry-run] [--yes] [--json]

  Copies the hook (node, no dependencies) and adds one entry to the agent's own hook
  configuration, so it asks Immiscible before each shell command and MCP tool call
  (and file write, where the agent has that event). It fails closed: when Immiscible
  cannot answer, the call is refused. Keeps every other setting and hook, and changes
  nothing when run again. After copying the hook it runs node <hook> --self-test.

  user (the default)  for this person: ~/.codex/hooks.json, ~/.cursor/hooks.json,
                      ~/.codeium/windsurf/hooks.json or ~/.gemini/settings.json;
                      the hook goes in ~/.immiscible
  managed             for everyone on the machine, in the agent's managed or system file
                      (run as an administrator): Codex's requirements.toml with
                      allow_managed_hooks_only, Cursor's enterprise hooks.json, Windsurf's
                      system hooks.json, Gemini CLI's system settings.json

  Codex and Gemini CLI wait up to 4 minutes for a person to approve in Slack, Teams,
  email or the console; Cursor asks the person at the keyboard; Windsurf refuses
  with the approval link.

Flags
  --scope <scope>  user or managed
  --key <key>      An agent key, written to hook.env beside the hook (left out, each
                   person's environment supplies IMMISCIBLE_AGENT_KEY)
  --dry-run        Show the change and write nothing
  -y, --yes        Write without asking (needed when not a terminal)

Exit codes: 0 installed or already installed, 4 not a terminal and no --yes.`,

  login: `immiscible login: sign in through your browser.

Usage
  immiscible login [--url <url>] [--no-browser]
  immiscible login --token <imc_...>      Store a token you already have (CI)

  Shows a one-time code and opens /app/device, where you allow it and pick the
  workspace. The token is stored in ~/.config/immiscible/credentials.json (mode 0600),
  lasts 90 days, and can be ended from your sessions in the console.
  With --json, prints a line with the code first, then the result.

Exit codes: 0 signed in, 8 denied or expired.`,

  doctor: `immiscible doctor: check this project is governed.

Usage
  immiscible doctor [--json] [--dir <path>]

  Checks Node, the server, the clock, the sign-in, .env, the agent key, the Claude Code
  hook (installed, the full matcher, and failing closed) and .gitignore.

Exit codes: 0 no failures (warnings allowed), 7 a check failed.`,

  status: `immiscible status: what needs you.

Usage
  immiscible status [--json]

  Requests waiting for approval, today's decisions (since 00:00 UTC), and this month's
  AI spend and agent payments in the workspace's books currency.`,

  token: `immiscible token: CI tokens, shown once.

Usage
  immiscible token create --name <name> [--read-only] [--days <1 to 90>] [--json]
  immiscible token list [--json]
  immiscible token revoke <id>

  A CI token acts for you in the workspace you are signed in to, with your CLI scopes
  or fewer (--read-only: no adding agents). It never approves anything. Set it as
  IMMISCIBLE_TOKEN in your CI secrets. Owners and admins can also make one in the
  console, beside service tokens.`,

  mcp: `immiscible mcp: add Immiscible's MCP server to an MCP client.

Usage
  immiscible mcp [--client <client>] [--json]

  Prints the one-line command or the config entry for each client, and changes
  nothing. The configs read the agent key from IMMISCIBLE_AGENT_KEY (immiscible init
  writes it to .env) or sign in with OAuth; the key itself is never printed.

Clients
  ${MCP_CLIENTS.join(', ')}`,

  evidence: `immiscible evidence: evidence packs for an auditor.

Usage
  immiscible evidence ai-act [--out <file.zip | file.json>] [--force] [--json]

  The EU AI Act deployer evidence pack for the workspace you are signed in to: the
  agents with their purpose and risk class, the people who oversee each rule and their
  authority, the rules that ask a person or refuse, retention and the oldest record,
  the kill-switch history, and a check of the ledger. A zip holds pack.json and a
  readable SUMMARY.md; --out ending in .json saves the JSON alone. For owners, admins,
  security admins and auditors. Never replaces a file unless --force. It is evidence
  for a compliance file, not legal advice.

Exit codes: 0 saved and the ledger verified, 6 your role cannot export evidence,
12 saved, but the ledger did not verify.`,

  whoami: `immiscible whoami: the person, workspace and token in use.

Usage
  immiscible whoami [--json]`,

  logout: `immiscible logout: revoke this machine's token and forget it.

Usage
  immiscible logout [--json]

  A token from IMMISCIBLE_TOKEN is left alone: unset it, and revoke it in the console.`,
};

/** help --json: the same help, as data, for a script or an AI coding agent. */
export function helpJson(topic = null) {
  const commands = [...HELP.main.matchAll(/^  ([a-z]+) {2,}(.+)$/gm)].filter((m) => COMMANDS[m[1]]).map((m) => ({ name: m[1], summary: m[2] }));
  return {
    ok: true,
    version: VERSION,
    ...(topic && topic !== 'main' ? { command: topic, help: HELP[topic] } : { commands }),
    flags: Object.fromEntries(Object.entries(FLAGS).map(([k, f]) => [`--${k}`, { value: f.value, ...(f.short ? { short: `-${f.short}` } : {}) }])),
    exitCodes: Object.fromEntries(Object.entries(EXIT).map(([k, v]) => [v, k.toLowerCase()])),
    nonInteractive: 'Pass --yes and --json; input comes from flags, and a command that would need to ask exits 4 naming the flag.',
    docs: 'https://immiscible.ai/docs/cli',
  };
}

export async function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, fetchImpl = fetch } = {}) {
  let ui = makeUi({ json: argv.includes('--json'), color: argv.includes('--no-color') ? false : null, stdout, stderr, stdin, env });
  try {
    const { command, rest, flags } = parseArgs(argv);
    ui = makeUi({ json: Boolean(flags.json), color: flags['no-color'] ? false : null, stdout, stderr, stdin, env });
    if (flags.version) {
      if (ui.json) ui.writeJson({ ok: true, version: VERSION }); else stdout.write(`immiscible ${VERSION}\n`);
      return EXIT.OK;
    }
    if (!command && !ui.json && stdout.isTTY && !env.CI) {
      await showCard({ ui, stdout, env });
      stdout.write(`${HELP.main}\n`);
      return EXIT.OK;
    }
    if (!command || command === 'help') {
      const topic = command === 'help' ? argv.find((a, i) => i > argv.indexOf('help') && HELP[a]) : null;
      if (ui.json) ui.writeJson(helpJson(topic)); else stdout.write(`${HELP[topic ?? 'main']}\n`);
      return EXIT.OK;
    }
    if (flags.help) {
      if (!HELP[command]) throw usage(`unknown command "${command}"`);
      if (ui.json) ui.writeJson(helpJson(command)); else stdout.write(`${HELP[command]}\n`);
      return EXIT.OK;
    }
    const run = COMMANDS[command];
    if (!run) { const near = nearest(command, Object.keys(COMMANDS)); throw usage(`unknown command "${command}"${near ? `; did you mean ${near}?` : ''}`, near ? `Run immiscible ${near}, or immiscible help for every command.` : `Commands: ${Object.keys(COMMANDS).join(', ')}. Run immiscible help.`); }
    const ctx = makeContext({ flags, ui, env, cwd, fetchImpl });
    ctx.rest = rest;
    ctx.stdin = stdin;
    return await run(ctx);
  } catch (err) {
    const e = err instanceof CliError ? err : new CliError(err?.message ?? String(err), { exit: EXIT.ERROR, code: 'internal' });
    if (ui.json) {
      ui.writeJson({ ok: false, exitCode: e.exit, error: { code: e.code, message: e.message, ...(e.fix ? { fix: e.fix } : {}), ...(e.docs ? { docs: e.docs } : {}) } });
    } else {
      const { c } = ui;
      stderr.write(`${c.red('✗')} ${e.message[0]?.toUpperCase() ?? ''}${e.message.slice(1)}${/[.?!]$/.test(e.message) ? '' : '.'}\n`);
      if (e.fix) stderr.write(`  ${e.fix}\n`);
      if (e.docs) stderr.write(`  ${c.dim(e.docs)}\n`);
      if (!(err instanceof CliError) && env.IMMISCIBLE_DEBUG) stderr.write(`${err.stack}\n`);
    }
    return e.exit;
  }
}
