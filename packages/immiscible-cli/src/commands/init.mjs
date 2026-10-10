/**
 * immiscible init: govern the agent in this project, in one command.
 *
 *   1. Detect the project: SDKs, Claude Code, MCP configs, wallets.
 *   2. Reuse the agent key already in .env if the server still accepts it;
 *      otherwise ask for the agent's name and purpose (the purposes of the
 *      console's "Add an agent") and create the agent and its rule. A rule
 *      that needs another owner is sent to them: payments start once they
 *      confirm.
 *   3. Add IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY to .env, never replacing
 *      a value that is already there unless you agree to.
 *   4. For Claude Code, install the PreToolUse hook (fails closed) after
 *      showing the change to .claude/settings.json.
 *   5. Print the code for the SDK found, and make a live test call.
 *
 * Running it again changes nothing that is already right: the key in .env
 * is reused, .env and the settings are left byte for byte, and the test
 * call carries the same idempotency key while the agent's rules are
 * unchanged, so no second record is made. Once a rule changes (a second
 * owner confirms it), the server makes the test afresh, so init never
 * prints an old answer as the current one.
 *
 * Non-interactive (CI, an AI coding agent): --yes, with --name and
 * --purpose, or their defaults. --json prints one object.
 */

import path from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { detectProject, defaultAgentName, defaultPurpose, vendorFor } from '../detect.mjs';
import { readEnvFile, planEnv, writeEnv, envIgnored } from '../dotenv.mjs';
import { planSettings, installHook, diffLines, compactDiff } from '../claude.mjs';
import { snippetFor, coversFrom } from '../snippets.mjs';
import { request, errorFrom } from '../api.mjs';
import { CliError, EXIT } from '../errors.mjs';
import { resolveContext } from '../config.mjs';
import { login } from './login.mjs';

/** pays_invoices, pays-invoices, "Pays invoices" and "something else" all name a purpose. */
export function matchPurpose(input, purposes) {
  const s = String(input ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  return purposes.find((p) => p.id === s || p.label.toLowerCase().replace(/[\s-]+/g, '_') === s)?.id ?? null;
}

async function checkKey(ctx, key) {
  const r = await request(ctx.url, '/v1/cli/agent-key', { auth: key, fetchImpl: ctx.fetchImpl });
  if (r.ok) return { valid: true, info: r.json };
  if (r.status === 401 || r.status === 403) return { valid: false, reason: r.json?.error?.message ?? `HTTP ${r.status}` };
  if (r.status === 404) throw new CliError(`${ctx.url} does not have the CLI API (/v1/cli/agent-key answered 404); it may run an older version of Immiscible`, { exit: EXIT.ERROR, code: 'cli_api_missing' });
  throw errorFrom(r, { what: 'checking the agent key' });
}

async function testCall(ctx, key) {
  const r = await request(ctx.url, '/v1/cli/test', { method: 'POST', auth: key, body: {}, fetchImpl: ctx.fetchImpl });
  if (!r.ok || !['allow', 'deny', 'approval_required'].includes(r.json?.decision)) {
    return { governed: false, status: r.status, message: r.json?.error?.message ?? `HTTP ${r.status}` };
  }
  const { decision, reasons = [], actionId = null, kind = null, tidied = null, replay = false } = r.json;
  return { governed: true, decision, reasons, actionId, kind, tidied, replay };
}

export async function init(ctx) {
  const { ui, flags, dir } = ctx;
  const { c } = ui;
  if (!ui.interactive && !flags.yes) {
    throw new CliError('init changes files in this project, and this is not an interactive terminal', {
      exit: EXIT.INPUT, code: 'confirmation_required',
      fix: 'Run immiscible init --yes --name "Invoice agent" --purpose pays_invoices (names and purposes: immiscible init --help).',
    });
  }

  // ---------------------------------------------------------- detect
  const project = detectProject(dir);
  const wantHook = !flags['no-hook'] && (flags.hook || project.claudeCode.present);
  if (!ui.json) {
    ui.out(`${c.bold('Immiscible')} ${c.dim(`init in ${dir}`)}`);
    ui.table([
      ['Server', ctx.url],
      ['Found', project.evidence.length ? project.evidence.join(', ') : 'no AI SDK, Claude Code or MCP config'],
    ]);
    ui.blank();
  }

  // ------------------------------------------- .env as it stands now
  const envFile = path.join(dir, '.env');
  const env0 = readEnvFile(envFile);
  if (env0.values.IMMISCIBLE_URL && env0.values.IMMISCIBLE_URL.replace(/\/+$/, '') !== ctx.url && !flags.force) {
    throw new CliError(`.env points at ${env0.values.IMMISCIBLE_URL}, but this run uses ${ctx.url} (from ${ctx.urlFrom})`, {
      exit: EXIT.INPUT, code: 'env_url_conflict',
      fix: `Run with --url ${env0.values.IMMISCIBLE_URL} to keep it, or --force to replace it.`,
    });
  }

  // -------------------------------------- reuse the key that is there
  let agent = null;
  let workspace = null;
  let key = null;
  let rules = [];
  let pending = null;
  let created = false;
  let reused = null;
  let covers = null; // what the agent's rules cover, so the printed code is code they can allow
  const replace = flags.force ? ['IMMISCIBLE_URL'] : [];
  const existing = env0.values.IMMISCIBLE_AGENT_KEY;
  if (existing) {
    const k = await ui.spin('Checking the agent key in .env', () => checkKey(ctx, existing));
    if (k.valid) {
      key = existing;
      agent = { ...k.info.agent, url: `${ctx.url}/app/agents/${k.info.agent.id}?w=${k.info.workspace.id}` };
      workspace = k.info.workspace;
      reused = 'env';
      pending = k.info.pending ?? null;
      covers = coversFrom(k.info.covers);
      ui.ok(`Using the agent key already in .env: ${c.bold(agent.name)} ${c.dim(`(${workspace.name})`)}`);
      if (pending) ui.warn(pending.message);
    } else {
      ui.warn(`The agent key in .env is not accepted (${k.reason}).`);
      const ok = flags.yes || (ui.interactive && await ui.confirm('Replace it with a new one?', { default: true }));
      if (!ok) throw new CliError('kept the agent key in .env as it is', { exit: EXIT.INPUT, code: 'key_not_replaced', fix: 'Remove IMMISCIBLE_AGENT_KEY from .env, or run again with --yes to replace it.' });
      replace.push('IMMISCIBLE_AGENT_KEY');
    }
  }

  // ------------------------------------------------ create the agent
  if (!key) {
    let token = ctx.token;
    if (!token) {
      if (!ui.interactive || ctx.tokenWithheld) ctx.requireToken();
      ui.out('You are not signed in. Signing in first.');
      await login(ctx);
      token = resolveContext({ flags: { ...flags, url: ctx.url }, env: ctx.env, dir }).token;
      ui.blank();
    }
    const client = ctx.api(token);
    const [who, purposes] = await ui.spin('Reading the workspace', () => Promise.all([client.get('/v1/cli/whoami'), client.get('/v1/cli/purposes')]));
    workspace = who.workspace;
    if (!who.can?.addAgents) {
      throw new CliError(`your role in ${who.workspace.name} (${who.workspace.role}) cannot add agents`, { exit: EXIT.REFUSED, code: 'forbidden', fix: 'Ask an owner or admin to run this, or to give you a role that can.' });
    }
    if (!ui.json) ui.table([['Workspace', `${who.workspace.name} ${c.dim(`(${who.workspace.role})`)}`], ['Signed in as', who.user.email]]);

    let name = typeof flags.name === 'string' ? flags.name.trim() : '';
    if (!name) name = ui.interactive && !flags.yes ? await ui.ask('Name for this agent, as people will see it', { default: defaultAgentName(project) }) : defaultAgentName(project);
    let purpose = null;
    if (flags.purpose) {
      purpose = matchPurpose(flags.purpose, purposes.data);
      if (!purpose) throw new CliError(`unknown purpose "${flags.purpose}"`, { exit: EXIT.USAGE, code: 'usage', fix: `Use one of: ${purposes.data.map((p) => p.id).join(', ')}.` });
    } else if (ui.interactive && !flags.yes) {
      purpose = await ui.choose('What does it do?', purposes.data.map((p) => ({ value: p.id, label: p.label, hint: p.rule ?? '' })), { default: defaultPurpose(project) });
    } else {
      purpose = defaultPurpose(project);
    }

    const out = await ui.spin('Creating the agent and its rule', () => client.post('/v1/cli/agents', { name, purpose, vendor: vendorFor(project), reuse: true }));
    agent = out.agent;
    workspace = out.workspace;
    key = out.key;
    rules = out.rules ?? [];
    pending = out.pending;
    covers = coversFrom([...rules, pending?.rule]);
    created = !out.reused;
    reused = out.reused ? 'name' : null;
    if (out.reused) ui.ok(`${c.bold(agent.name)} already exists in ${workspace.name}: issued it a new key`);
    else ui.ok(`Created ${c.bold(agent.name)} in ${workspace.name}`);
    for (const r of rules) ui.out(`  ${c.dim('Rule:')} ${r.description}`);
    if (pending) {
      if (pending.rule) ui.out(`  ${c.dim('Rule:')} ${pending.rule.description}`);
      ui.warn(pending.message);
      if (pending.confirmUrl) ui.note(`  Another owner confirms it here: ${pending.confirmUrl}`);
    }
  }

  // ------------------------------------------------------------ .env
  const envPlan = planEnv(env0.text, { IMMISCIBLE_URL: ctx.url, IMMISCIBLE_AGENT_KEY: key }, { replace });
  writeEnv(envFile, envPlan);
  if (envPlan.changed) ui.ok(`${envPlan.added.length ? `Added ${envPlan.added.join(' and ')}` : ''}${envPlan.added.length && envPlan.replaced.length ? '; ' : ''}${envPlan.replaced.length ? `replaced ${envPlan.replaced.join(' and ')}` : ''} in .env`);
  else ui.ok('.env already has IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY');
  // .env holds the agent key, so in a git repository it goes in .gitignore
  // (created if need be), shown and confirmed like every other change.
  const gitignoreFile = path.join(dir, '.gitignore');
  const gitignore = existsSync(gitignoreFile) ? readFileSync(gitignoreFile, 'utf8') : null;
  let ignored = envIgnored(gitignore);
  let gitignoreState = ignored ? 'unchanged' : 'skipped';
  if (ignored === false || (ignored === null && existsSync(path.join(dir, '.git')))) {
    let go = !flags['no-gitignore'];
    if (go && !ui.json) ui.out(`${c.bold('.gitignore')}${gitignore == null ? c.dim(' (new file)') : ''} ${c.green('+ .env')}`);
    if (go && ui.interactive && !flags.yes) go = await ui.confirm('Add .env to .gitignore? It holds the agent key.', { default: true });
    if (go) {
      writeFileSync(gitignoreFile, `${gitignore == null || gitignore === '' || gitignore.endsWith('\n') ? gitignore ?? '' : `${gitignore}\n`}.env\n`);
      ignored = true;
      gitignoreState = gitignore == null ? 'created' : 'added';
      ui.ok(gitignore == null ? 'Created .gitignore with .env in it' : 'Added .env to .gitignore');
    } else {
      gitignoreState = 'declined';
      ui.warn('.env is not in .gitignore. It holds the agent key: add it before you commit.');
    }
  }

  // ------------------------------------------------- Claude Code hook
  let hook = { state: 'skipped', reason: flags['no-hook'] ? '--no-hook' : 'no Claude Code project found (pass --hook to install it anyway)' };
  if (wantHook) {
    const settingsFile = path.join(dir, '.claude', 'settings.json');
    const plan = planSettings(settingsFile);
    if (plan.error) {
      hook = { state: 'error', reason: plan.error, settings: settingsFile };
      ui.warn(`Claude Code hook not installed: ${plan.error}.`);
    } else {
      const diff = plan.changed ? compactDiff(diffLines(plan.before, plan.after)) : [];
      let go = true;
      if (plan.changed && !ui.json) {
        ui.blank();
        ui.out(`${c.bold('.claude/settings.json')}${plan.before ? '' : c.dim(' (new file)')}`);
        for (const l of diff) ui.out(l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : c.dim(l));
        ui.blank();
        if (ui.interactive && !flags.yes) go = await ui.confirm('Install the Claude Code hook? It asks Immiscible before each tool call, and fails closed.', { default: true });
      }
      if (go) {
        const r = installHook(dir, plan);
        hook = { state: plan.changed ? plan.state : r.fileState === 'unchanged' ? 'unchanged' : 'updated', settings: settingsFile, hookFile: r.hookFile, hookFileState: r.fileState, diff };
        if (hook.state === 'unchanged') ui.ok('The Claude Code hook is already installed');
        else ui.ok(`Installed the Claude Code hook ${c.dim('(.claude/hooks/immiscible-claude-code-hook.mjs; fails closed)')}`);
      } else {
        hook = { state: 'declined', settings: settingsFile, diff };
        ui.note('Skipped the hook. Run immiscible init again when you want it.');
      }
    }
  }

  // --------------------------------------------------------- snippet
  const snippet = snippetFor(project, { hookInstalled: ['added', 'updated', 'unchanged'].includes(hook.state), covers });
  if (snippet && !ui.json && snippet.id !== 'claude-code') {
    ui.blank();
    ui.out(`${c.bold(`Add this to your code`)} ${c.dim(`(${snippet.title})`)}`);
    ui.blank();
    for (const l of snippet.text.split('\n')) ui.out(`  ${l}`);
  }

  // ------------------------------------------------------- test call
  let test = null;
  if (!flags['no-test']) {
    test = await ui.spin('Making a live test call', () => testCall(ctx, key));
    ui.blank();
    if (test.governed && pending) {
      // Connected, but nothing is governed by a rule yet: not a tick.
      ui.warn(`Waiting for another owner to confirm the rule for ${agent.name} (${workspace.name}). Until then everything it asks for is refused.`);
      ui.note(`  The connection works: the test ${test.kind === 'payment' ? 'payment' : 'call'} reached Immiscible${test.decision === 'deny' ? ' and was refused, as it should be while the rule waits' : ''}.`);
    } else if (test.governed) {
      ui.ok(`Governed by Immiscible: ${agent.name} (${workspace.name})`);
      const said = { allow: 'was allowed', deny: 'was refused', approval_required: 'would have gone to a person' }[test.decision];
      ui.note(`  The test ${test.kind === 'payment' ? 'payment' : 'call'} ${said}${test.reasons.length ? `: ${test.reasons.map((x) => x.replace(/\.+$/, '')).join('; ')}` : ''}.${test.decision === 'approval_required' ? ' It was cancelled at once, so nobody has to decide it.' : ''}`);
    } else {
      ui.fail(`The test call did not come back governed: ${test.message}`);
    }
  }

  const exitCode = test && !test.governed ? EXIT.TEST : pending ? EXIT.PENDING : EXIT.OK;
  if (ui.json) {
    ui.writeJson({
      ok: exitCode === EXIT.OK,
      exitCode,
      url: ctx.url,
      workspace,
      agent,
      created,
      reused,
      rules,
      pending,
      message: pending?.message ?? null,
      env: { file: envFile, added: envPlan.added, kept: envPlan.kept, replaced: envPlan.replaced, conflicts: envPlan.conflicts, gitignored: ignored, gitignore: gitignoreState },
      hook,
      snippet,
      detected: { languages: project.languages, sdks: project.sdks, primary: project.primary, claudeCode: project.claudeCode, mcp: project.mcp, wallets: project.wallets },
      test,
    });
  } else if (agent && !test) {
    ui.blank();
    ui.ok(`Set up: ${agent.name} (${workspace.name})`);
  }
  if (!ui.json && agent?.url) ui.note(`Console: ${agent.url}`);
  return exitCode;
}
