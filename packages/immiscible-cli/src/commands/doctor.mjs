/**
 * immiscible doctor: is this project governed, and if not, what to do.
 *
 * Checks, in order: Node, the server, the clock, the sign-in, .env, the
 * agent key, the Claude Code hook (installed, the full matcher, and failing
 * closed: it is run against an address that cannot answer and must refuse),
 * and .gitignore. Each failure says how to fix it and where the docs are.
 * Exit 0 when nothing failed (warnings allowed), 7 otherwise.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from '../api.mjs';
import { readEnvFile, envIgnored } from '../dotenv.mjs';
import { detectProject } from '../detect.mjs';
import { inspectHook, MATCHER, HOOK_TIMEOUT } from '../claude.mjs';
import { EXIT } from '../errors.mjs';

const NODE_MIN = [22, 13];
const SKEW_WARN_S = 5;
const SKEW_FAIL_S = 60;

const nodeOk = (v) => {
  const [a, b] = v.split('.').map(Number);
  return a > NODE_MIN[0] || (a === NODE_MIN[0] && b >= NODE_MIN[1]);
};

/** Run the installed hook command with an address nothing answers on: it must refuse. */
export function hookFailsClosed(dir, command) {
  if (process.platform === 'win32') return { ran: false, reason: 'not checked on Windows' };
  const event = JSON.stringify({ session_id: 'immiscible-doctor', tool_name: 'Bash', tool_input: { command: 'echo immiscible doctor' }, hook_event_name: 'PreToolUse' });
  const r = spawnSync('/bin/sh', ['-c', command], {
    input: event,
    encoding: 'utf8',
    timeout: 20_000,
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, IMMISCIBLE_URL: 'http://127.0.0.1:9', IMMISCIBLE_AGENT_KEY: 'ask_immiscible_doctor_check', IMMISCIBLE_TIMEOUT_MS: '3000' },
  });
  let decision = null;
  try { decision = JSON.parse(r.stdout.trim().split('\n').at(-1))?.hookSpecificOutput?.permissionDecision ?? null; } catch { /* no JSON */ }
  // Claude Code blocks a call on a "deny" decision, or on exit code 2.
  const blocks = decision === 'deny' || r.status === 2;
  return { ran: true, blocks, decision, exitCode: r.status, stderr: (r.stderr ?? '').trim().slice(0, 300) };
}

export async function doctor(ctx) {
  const { ui, dir } = ctx;
  const docs = (a) => `${ctx.url}/docs/cli#${a}`;
  const checks = [];
  const add = (id, title, status, detail, fix = null, anchor = 'doctor') => checks.push({ id, title, status, detail, ...(fix ? { fix } : {}), ...(status !== 'ok' && status !== 'skip' ? { docs: docs(anchor) } : {}) });

  // ------------------------------------------------------------- node
  const v = process.versions.node;
  if (nodeOk(v)) add('node', 'Node.js', 'ok', v);
  else add('node', 'Node.js', 'warn', `${v}; the hook command uses --env-file-if-exists, which needs Node 22.13 or later`, 'Install Node 22 (https://nodejs.org).');

  // ----------------------------------------------- server and clock
  let reachable = false;
  const t0 = Date.now();
  try {
    const r = await request(ctx.url, '/healthz', { fetchImpl: ctx.fetchImpl, timeoutMs: 10_000 });
    const t1 = Date.now();
    reachable = r.ok && r.json?.ok === true;
    if (reachable) add('server', 'Server', 'ok', `${ctx.url} answered in ${r.ms}ms${r.json.version ? ` (version ${r.json.version})` : ''}`);
    else add('server', 'Server', 'fail', `${ctx.url}/healthz answered ${r.status}`, 'Check --url or IMMISCIBLE_URL points at your Immiscible server.', 'doctor');
    const date = r.headers.get('date');
    if (date) {
      const skew = (Date.parse(date) - (t0 + t1) / 2) / 1000;
      const abs = Math.abs(skew);
      // The Date header has one-second resolution, so under a second is noise.
      const words = `${abs < 1 ? 'under a second' : `${abs.toFixed(0)}s`} ${abs < 1 ? 'from' : skew > 0 ? 'behind' : 'ahead of'} the server`;
      if (abs >= SKEW_FAIL_S) add('clock', 'Clock', 'fail', `this machine is ${words}; signed receipts allow 60s`, 'Turn on automatic time (NTP) on this machine.');
      else if (abs >= SKEW_WARN_S) add('clock', 'Clock', 'warn', `this machine is ${words}`, 'Turn on automatic time (NTP) on this machine.');
      else add('clock', 'Clock', 'ok', words);
    } else add('clock', 'Clock', 'skip', 'the server sent no Date header');
  } catch (err) {
    add('server', 'Server', 'fail', err.message, err.fix ?? 'Check your connection and the address.');
    add('clock', 'Clock', 'skip', 'the server could not be reached');
  }

  // ------------------------------------------------------- sign-in
  if (!reachable) add('auth', 'Signed in', 'skip', 'the server could not be reached');
  else if (!ctx.token && ctx.tokenWithheld) add('auth', 'Signed in', 'warn', `${ctx.tokenWithheld} is not sent to ${ctx.url}, which only this project's .env names`, 'Set IMMISCIBLE_URL or pass --url with your server, and the token is used.', 'login');
  else if (!ctx.token) add('auth', 'Signed in', 'warn', 'not signed in (only needed to add agents and for status)', 'Run immiscible login.', 'login');
  else {
    const r = await request(ctx.url, '/v1/cli/whoami', { auth: ctx.token, fetchImpl: ctx.fetchImpl });
    if (r.ok) add('auth', 'Signed in', 'ok', `${r.json.user.email} in ${r.json.workspace.name} (token expires ${r.json.token.expiresAt.slice(0, 10)})`);
    else if (r.status === 404) add('auth', 'Signed in', 'fail', `${ctx.url} has no CLI API; it may run an older version of Immiscible`, 'Upgrade the server.');
    else add('auth', 'Signed in', 'fail', r.json?.error?.message ?? `HTTP ${r.status}`, r.json?.error?.fix ?? 'Run immiscible login.', 'login');
  }

  // ------------------------------------------------------------ .env
  const envFile = path.join(dir, '.env');
  const env = readEnvFile(envFile);
  // The hook's own order: Node's --env-file-if-exists never replaces a
  // variable already in the environment, so the environment wins over .env.
  const pick = (name) => ctx.env[name] || env.values[name] || null;
  const url = pick('IMMISCIBLE_URL');
  const key = pick('IMMISCIBLE_AGENT_KEY');
  const where = (name) => (ctx.env[name] ? 'the environment' : '.env');
  const shadowed = ['IMMISCIBLE_AGENT_KEY', 'IMMISCIBLE_URL'].filter((n) => ctx.env[n] && env.values[n] && ctx.env[n] !== env.values[n]);
  if (!url || !key) {
    const missing = [!url && 'IMMISCIBLE_URL', !key && 'IMMISCIBLE_AGENT_KEY'].filter(Boolean);
    add('env', 'Environment', 'fail', `${missing.join(' and ')} not set in .env or the environment`, 'Run immiscible init.', 'init');
  } else if (url.replace(/\/+$/, '') !== ctx.url) {
    add('env', 'Environment', 'warn', `IMMISCIBLE_URL is ${url} (${where('IMMISCIBLE_URL')}), but this check ran against ${ctx.url}`, `Run immiscible doctor --url ${url}.`);
  } else if (shadowed.length) {
    add('env', 'Environment', 'warn', `${shadowed.join(' and ')} in this shell ${shadowed.length === 1 ? 'differs' : 'differ'} from .env; the hook uses the shell's value, so that is the one checked below`, `Unset ${shadowed.join(' and ')} in this shell (unset ${shadowed.join(' ')}), or make it match .env.`);
  } else {
    add('env', 'Environment', 'ok', `IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY from ${where('IMMISCIBLE_AGENT_KEY')}`);
  }

  // ------------------------------------------------------- agent key
  if (!key) add('agent_key', 'Agent key', 'skip', 'no key to check');
  else if (!reachable) add('agent_key', 'Agent key', 'skip', 'the server could not be reached');
  else {
    const r = await request(ctx.url, '/v1/cli/agent-key', { auth: key, fetchImpl: ctx.fetchImpl });
    if (r.ok) {
      const k = r.json;
      const label = `${k.agent.name} (${k.workspace.name})${where('IMMISCIBLE_AGENT_KEY') === '.env' ? '' : ', key from the environment'}`;
      if (k.agent.status !== 'active') add('agent_key', 'Agent key', 'fail', `${label} is ${k.agent.status === 'frozen' ? 'stopped' : k.agent.status}: every request is refused`, 'Someone who can restart it does so from the agent\'s page in the console.');
      else if (k.waitingForSecondOwner && !k.rules) add('agent_key', 'Agent key', 'warn', `${label}: ${k.pending?.message ?? 'its rule waits for another owner to confirm'}`, k.pending?.confirmUrl ? `Ask another owner of the workspace to confirm it: ${k.pending.confirmUrl}` : 'Ask another owner to confirm it on the agent\'s page in the console.');
      else if (!k.rules) add('agent_key', 'Agent key', 'warn', `${label} has no rules, so everything it asks for is refused`, 'Add a rule on the agent\'s page in the console.');
      else add('agent_key', 'Agent key', 'ok', `${label}: active, ${k.rules} rule${k.rules === 1 ? '' : 's'}`);
    } else if (r.status === 404 && !r.json?.error) {
      add('agent_key', 'Agent key', 'fail', `${ctx.url} has no CLI API; it may run an older version of Immiscible`, 'Upgrade the server.');
    } else {
      const fromShell = where('IMMISCIBLE_AGENT_KEY') !== '.env';
      add('agent_key', 'Agent key', 'fail', `${r.json?.error?.message ?? `HTTP ${r.status}`}${fromShell ? ' (the key in this shell\'s environment, which the hook uses before .env)' : ''}`, fromShell ? 'Unset IMMISCIBLE_AGENT_KEY in this shell, or run immiscible init to make a new key.' : 'Run immiscible init to make a new key.', 'init');
    }
  }

  // ------------------------------------------------- Claude Code hook
  const project = detectProject(dir);
  const h = inspectHook(dir);
  if (!project.claudeCode.present && !h.entries.length) {
    add('hook', 'Claude Code hook', 'skip', 'not a Claude Code project');
  } else if (!h.entries.length) {
    add('hook', 'Claude Code hook', 'fail', 'not installed: Claude Code tool calls are not checked', 'Run immiscible init.', 'init');
  } else {
    const e = h.entries.find((x) => !x.error) ?? h.entries[0];
    const problems = [];
    if (e.error) problems.push(`${path.basename(e.file)} is ${e.error}`);
    else {
      // The older matcher (every MCP tool, Immiscible's own included) covers more, so it is not a problem.
      if (e.matcher !== MATCHER && e.matcher !== 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__.*') problems.push(`the matcher is "${e.matcher}", not the full "${MATCHER}"`);
      if (!/\|\|\s*exit 2\s*$/.test(e.command)) problems.push('the command does not end in "|| exit 2", so a crash would let the call through');
      if (e.timeout != null && e.timeout > HOOK_TIMEOUT) problems.push(`the timeout is ${e.timeout}s; keep it at ${HOOK_TIMEOUT} or less`);
      if (e.command.includes('.claude/hooks/') && !h.hookExists) problems.push('the hook file .claude/hooks/immiscible-claude-code-hook.mjs is missing');
    }
    if (problems.length) {
      add('hook', 'Claude Code hook', 'fail', problems.join('; '), 'Run immiscible init to put it right.', 'init');
    } else {
      const fc = hookFailsClosed(dir, e.command);
      // The server's own copy is the one its rules expect (a newer hook says which project a call runs in).
      const served = reachable && h.hookExists ? await request(ctx.url, '/downloads/claude-code-hook.mjs', { fetchImpl: ctx.fetchImpl, headers: { accept: 'text/javascript' } }).catch(() => null) : null;
      const behindServer = served?.ok && served.text && served.text !== h.hookText;
      if (fc.ran && !fc.blocks) add('hook', 'Claude Code hook', 'fail', `installed, but it did not refuse when Immiscible was unreachable (decision ${fc.decision ?? 'none'}, exit ${fc.exitCode})${fc.stderr ? `: ${fc.stderr}` : ''}`, 'Run immiscible init to reinstall it.', 'init');
      else if (h.hookExists && h.current === false) add('hook', 'Claude Code hook', 'warn', 'installed and fails closed, but the hook is out of date: it differs from the one this CLI ships', 'Run immiscible init to update it.', 'init');
      else if (behindServer) add('hook', 'Claude Code hook', 'warn', `installed and fails closed, but the hook is out of date: it differs from the one ${ctx.url} serves, so edits inside the project may ask a person`, 'Run npx immiscible@latest init to update it.', 'init');
      else add('hook', 'Claude Code hook', 'ok', `installed in ${path.relative(dir, e.file)}, full matcher, ${fc.ran ? 'fails closed (checked)' : 'ends in || exit 2'}`);
    }
  }

  // ------------------------------------------------------- gitignore
  if (env.exists && env.values.IMMISCIBLE_AGENT_KEY) {
    const gi = existsSync(path.join(dir, '.gitignore')) ? readFileSync(path.join(dir, '.gitignore'), 'utf8') : null;
    const ignored = envIgnored(gi);
    if (ignored) add('gitignore', '.gitignore', 'ok', '.env is ignored');
    else if (ignored === false || existsSync(path.join(dir, '.git'))) add('gitignore', '.gitignore', 'warn', '.env holds the agent key and is not in .gitignore', 'Add .env to .gitignore.');
    else add('gitignore', '.gitignore', 'skip', 'not a git repository');
  }

  // ----------------------------------------------------------- report
  const failed = checks.filter((x) => x.status === 'fail');
  const exitCode = failed.length ? EXIT.CHECKS : EXIT.OK;
  if (ui.json) {
    ui.writeJson({ ok: !failed.length, exitCode, url: ctx.url, dir, checks });
    return exitCode;
  }
  const { c } = ui;
  ui.out(`${c.bold('Immiscible')} ${c.dim(`doctor in ${dir}`)}`);
  ui.blank();
  const w = Math.max(...checks.map((x) => x.title.length));
  const mark = { ok: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗'), skip: c.dim('-') };
  for (const x of checks) {
    ui.out(`${mark[x.status]} ${x.title.padEnd(w)}  ${x.status === 'skip' ? c.dim(x.detail) : x.detail}`);
    if (x.fix && x.status !== 'ok' && x.status !== 'skip') {
      // The fix may end in a link of its own, so the docs link goes on its own line.
      ui.out(`  ${' '.repeat(w)}  ${c.dim('Fix:')} ${x.fix}`);
      if (x.docs) ui.out(`  ${' '.repeat(w)}  ${c.dim(`Docs: ${x.docs}`)}`);
    }
  }
  ui.blank();
  const warns = checks.filter((x) => x.status === 'warn').length;
  if (failed.length) ui.out(c.red(`${failed.length} check${failed.length === 1 ? '' : 's'} failed${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}.`));
  else ui.out(warns ? c.yellow(`No failures, ${warns} warning${warns === 1 ? '' : 's'}.`) : c.green('Everything checks out.'));
  return exitCode;
}

