/**
 * immiscible policy replay --file draft.json [--since 30d] [--exclusive] [--json]
 *
 * What a draft rule would have decided on the requests your agents really
 * made (POST /v1/cli/policy/replay): each request decided again in order,
 * with limits adding up as they would have. The draft is checked and never
 * stored or signed; nothing is written. A draft with the id of an existing
 * rule stands in for it; --exclusive replays the drafts alone.
 *
 * draft.json holds one rule or a list of them, as the console's rule editor
 * writes them (kind, title, limits...), or { "template": "coding_agent_baseline" }.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, usage } from '../errors.mjs';
import { parseSince } from './scan.mjs';

const WORD = { allow: 'allowed', approval_required: 'asked a person', deny: 'refused' };

export async function policy(ctx) {
  const { ui, flags } = ctx;
  const sub = ctx.rest?.[0] ?? null;
  if (sub !== 'replay') throw usage(sub ? `unknown policy command "${sub}"` : 'policy needs a command', 'Run immiscible policy replay --file draft.json.');
  if (typeof flags.file !== 'string' || !flags.file.trim()) throw usage('policy replay needs --file with the draft rule', 'Run immiscible policy replay --file draft.json.');
  let drafts;
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(ctx.dir, flags.file), 'utf8'));
    drafts = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.mandates) ? parsed.mandates : [parsed];
  } catch (err) {
    throw new CliError(`could not read ${flags.file} (${err.code ?? err.message})`, { exit: EXIT.USAGE, code: 'bad_file', fix: 'Give a JSON file holding one rule, or a list of rules.' });
  }
  const since = new Date(parseSince(flags.since ?? '30d', Date.now())).toISOString();
  const token = ctx.requireToken();
  const client = ctx.api(token);
  const r = await ui.spin('Replaying the draft over recorded requests', () => client.post('/v1/cli/policy/replay', { mandates: drafts, since, exclusive: Boolean(flags.exclusive) }, { timeoutMs: 120_000 }));
  if (ui.json) { ui.writeJson({ ok: true, url: ctx.url, ...r }); return EXIT.OK; }

  const { c } = ui;
  ui.blank();
  ui.out(`  ${c.bold('Policy replay')} ${c.dim(`${r.requests} request${r.requests === 1 ? '' : 's'} since ${r.since.slice(0, 10)}, decided again under ${r.drafts.map((d) => d.title).join(', ') || 'the current rules'}${r.exclusive ? ' alone' : ''}`)}`);
  ui.blank();
  for (const k of ['allow', 'approval_required', 'deny']) {
    const was = r.recorded[k] ?? 0;
    const now = r.totals[k] ?? 0;
    const delta = now - was;
    ui.out(`  ${WORD[k].padEnd(15)} ${String(now).padStart(5)}  ${delta ? (delta > 0 ? c.yellow(`+${delta}`) : c.green(String(delta))) : c.dim('same')}  ${c.dim(`(was ${was})`)}`);
  }
  ui.blank();
  if (!r.changed) ui.note('  Nothing would have been decided differently.');
  else {
    ui.out(`  ${c.bold(`${r.changed} decision${r.changed === 1 ? '' : 's'} would change:`)} ${Object.entries(r.flips).map(([k, n]) => `${n} ${k.replace('approval_required', 'asked').replace('allow', 'allowed').replace('deny', 'refused')}`).join(', ')}`);
    const top = Object.entries(r.signals).sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [id, n] of top) {
      const e = (r.examples[id] ?? []).find((x) => x.recorded !== x.replayed) ?? r.examples[id]?.[0];
      ui.out(`  ${c.dim(String(n).padStart(4))}  ${id}${e ? c.dim(`  e.g. ${e.at.slice(0, 10)} ${e.summary.slice(0, 60)}${e.amount != null ? ` (${(e.amount / 100).toFixed(2)} ${e.currency})` : ''}`) : ''}`);
    }
  }
  if (r.truncated) ui.note('  Only the first 5,000 requests were replayed; narrow it with --since.');
  ui.note(`  ${r.note}`);
  return EXIT.OK;
}
