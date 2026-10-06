/**
 * immiscible: the developer CLI. Dispatch, help, and the one place errors
 * become output and an exit code.
 */

import { parseArgs, FLAGS } from './args.mjs';
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

const COMMANDS = { login, logout, whoami, init, doctor, status, token, mcp, check };

const HELP = {
  main: `Immiscible: decisions before your AI agents pay, share data or act.

Usage
  immiscible <command> [flags]

Commands
  check     What the agents here can touch: MCP servers, Claude Code permissions, keys. Runs locally
  init      Govern the agent in this project: create it, write .env, install the Claude Code hook, test it
  login     Sign in through your browser (device code); --token for CI
  status    What waits for approval, today's decisions, this month's spend
  doctor    Check the server, clock, sign-in, .env, agent key and hook; print fixes
  whoami    Who and which workspace you are signed in as
  logout    Revoke this machine's token and forget it
  token     Make, list and revoke CI tokens: token create --name ci
  mcp       Print how to add the MCP server to Claude Code, Cursor, VS Code and others

Flags for every command
  --url <url>     Your Immiscible server (or IMMISCIBLE_URL)
  --token <tok>   A CLI token (or IMMISCIBLE_TOKEN), for CI
  --json          One JSON object on stdout, nothing else
  --no-color      No colour (NO_COLOR is respected too)
  -h, --help      Help for a command
  -v, --version   The version

Exit codes: 0 ok, 1 error, 2 usage, 3 not signed in, 4 input needed, 5 unreachable,
6 refused, 7 doctor found failures, 8 sign-in denied or expired, 9 test call failed,
10 waiting for another owner, 11 check found something high-risk.

Docs: https://immiscible.fly.dev/docs/cli (or /docs/cli on your own server)`,

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
    docs: 'https://immiscible.fly.dev/docs/cli',
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
    if (!run) throw usage(`unknown command "${command}"`, `Commands: ${Object.keys(COMMANDS).join(', ')}. Run immiscible help.`);
    const ctx = makeContext({ flags, ui, env, cwd, fetchImpl });
    ctx.rest = rest;
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
