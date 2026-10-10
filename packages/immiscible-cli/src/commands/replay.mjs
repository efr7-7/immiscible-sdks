/**
 * immiscible replay: the flight recorder. One timeline per coding-agent
 * session, across Claude Code, Codex and Gemini CLI, from the history they
 * keep on this machine and the decisions `immiscible guard` logged.
 *
 *   immiscible replay                 the sessions of the last 7 days
 *   immiscible replay <session>       one session in full (the id, or its first characters)
 *   immiscible replay <session> --html timeline.html
 *
 * Runs locally, needs no account, sends nothing. Commands are shown with
 * credentials redacted; prompts and file contents never are. The decision
 * log is hash-chained, and the timeline says whether each day's chain holds.
 */

import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { readHistory } from '../history/readers.mjs';
import { AGENT_LABELS, usd } from '../history/analyse.mjs';
import { BRAND } from '../history/render.mjs';
import { readDecisions, buildTimelines, findTimeline, logDir } from '../history/recorder.mjs';
import { parseSince } from './scan.mjs';
import { EXIT, CliError, usage } from '../errors.mjs';

const label = (a) => AGENT_LABELS[a] ?? a;
const hhmm = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : '--:--:--');
const dayOf = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
const costText = (c) => (c.micros ? usd(c.micros) : c.unpriced ? 'not priced' : usd(0));
const MARK = { allow: '✓', ask: '?', deny: '✗' };

export async function replay(ctx) {
  const { ui, flags } = ctx;
  const { c } = ui;
  const home = ctx.env.HOME || homedir();
  const since = parseSince(flags.since, Date.now());
  if ((ctx.rest ?? []).length > 1) throw usage('replay takes one session at a time');
  const { sessions } = readHistory({ home, env: ctx.env, since, projectDirs: [ctx.dir] });
  const log = readDecisions(logDir(home, ctx.env), since);
  const timelines = buildTimelines(sessions, log.decisions).filter((t) => (t.endedAt ?? t.startedAt ?? since) >= since);
  const chain = { days: log.days.length, ok: log.days.every((d) => d.ok), broken: log.days.filter((d) => !d.ok).map((d) => ({ file: d.file, line: d.brokenAt })) };
  const ref = ctx.rest?.[0] ?? null;

  if (!ref) {
    const list = timelines.slice(0, 50).map((t) => ({ key: t.key, agent: t.agent, id: t.id, repo: t.repo, branch: t.branch, startedAt: t.startedAt, endedAt: t.endedAt, calls: t.calls, decisions: t.decisions, cost: t.cost }));
    if (ui.json) { ui.writeJson({ ok: chain.ok, local: true, since: new Date(since).toISOString(), chain, sessions: list }); return chain.ok ? EXIT.OK : EXIT.INVALID; }
    ui.blank();
    ui.out(`  ${c.bold('Flight recorder')} ${c.dim(`sessions since ${dayOf(since)}, read on this machine`)}`);
    ui.blank();
    if (!list.length) {
      ui.note('  No sessions in this window. Run an agent, or widen it: immiscible replay --since 30d');
      if (!chain.ok) ui.note(`  Decision log: chain broken in ${chain.broken.map((b) => `${b.file} line ${b.line}`).join(', ')}`);
      return chain.ok ? EXIT.OK : EXIT.INVALID;
    }
    for (const t of list.slice(0, 20)) {
      const d = t.decisions;
      const marks = [d.deny ? c.red(`${d.deny} refused`) : null, d.ask ? c.yellow(`${d.ask} asked`) : null].filter(Boolean).join(c.dim(', '));
      ui.out(`  ${c.bold(t.id.slice(0, 8))}  ${label(t.agent).padEnd(11)} ${t.repo.padEnd(22).slice(0, 22)} ${c.dim(`${dayOf(t.endedAt)} ${hhmm(t.endedAt)}`)}  ${String(t.calls).padStart(3)} call${t.calls === 1 ? ' ' : 's'}  ${costText(t.cost).padStart(7)}${marks ? `  ${marks}` : ''}`);
    }
    ui.blank();
    ui.note(`  One in full: immiscible replay ${list[0].id.slice(0, 8)}${chain.days ? `   Decision log: ${chain.ok ? 'chain holds' : `chain broken in ${chain.broken.map((b) => `${b.file} line ${b.line}`).join(', ')}`}` : ''}`);
    return chain.ok ? EXIT.OK : EXIT.INVALID;
  }

  const found = findTimeline(timelines, ref);
  if (found.error) throw new CliError(found.error, { exit: EXIT.USAGE, code: 'no_such_session', fix: found.candidates ? `One of: ${found.candidates.join(', ')}` : 'Run immiscible replay to list the sessions, or widen the window with --since 30d.' });
  const t = found.timeline;
  let html = null;
  if (flags.html) {
    const file = path.resolve(ctx.dir, flags.html);
    try { writeFileSync(file, renderTimelineHtml(t, chain)); } catch (e) {
      throw new CliError(`could not write ${flags.html}: ${e.code ?? e.message}`, { exit: EXIT.ERROR, code: 'write_failed', fix: 'Choose a path in a directory you can write to.' });
    }
    html = file;
  }
  if (ui.json) { ui.writeJson({ ok: chain.ok, local: true, chain, session: t, ...(html ? { html } : {}) }); return chain.ok ? EXIT.OK : EXIT.INVALID; }

  ui.blank();
  ui.out(`  ${c.bold(`${label(t.agent)} in ${t.repo}`)}${t.branch ? c.dim(` on ${t.branch}`) : ''}  ${c.dim(`${dayOf(t.startedAt)} ${hhmm(t.startedAt)} to ${hhmm(t.endedAt)}`)}`);
  ui.note(`  ${t.id}  ·  ${t.calls} calls  ·  ${costText(t.cost)} at list prices  ·  ${t.decisions.deny} refused, ${t.decisions.ask} asked`);
  ui.blank();
  for (const e of t.events) {
    const m = e.decision ? (e.decision === 'deny' ? c.red(MARK.deny) : e.decision === 'ask' ? c.yellow(MARK.ask) : c.green(MARK.allow)) : c.dim('·');
    const kind = c.dim(e.kind.padEnd(8));
    ui.out(`  ${c.dim(hhmm(e.at))}  ${m} ${kind} ${e.text}${e.ran === false ? c.dim('  (did not run)') : ''}`);
    if (e.reason && e.decision !== 'allow') ui.out(`             ${c.dim(e.reason.replace(/^Immiscible guard: /, ''))}`);
  }
  ui.blank();
  if (chain.days) ui.note(`  Decision log: ${chain.ok ? `chain holds across ${chain.days} day${chain.days === 1 ? '' : 's'}` : `chain broken in ${chain.broken.map((b) => `${b.file} line ${b.line}`).join(', ')}`}`);
  if (html) ui.ok(`Timeline written to ${html}`);
  if (!t.decisions.allow && !t.decisions.ask && !t.decisions.deny) ui.note('  No decisions in this session: put a hook in front of it with npx immiscible guard');
  return chain.ok ? EXIT.OK : EXIT.INVALID;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** One session as a self-contained page in the brand's tokens: no script, no request to anywhere. */
export function renderTimelineHtml(t, chain) {
  const b = BRAND;
  const rows = t.events.map((e) => `<tr class="${e.decision ?? ''}"><td class="mono muted">${esc(hhmm(e.at))}</td><td class="mark">${e.decision ? esc(MARK[e.decision]) : ''}</td><td class="muted">${esc(e.kind)}</td><td><code>${esc(e.text)}</code>${e.ran === false ? ' <span class="muted">did not run</span>' : ''}${e.reason && e.decision !== 'allow' ? `<div class="why">${esc(e.reason.replace(/^Immiscible guard: /, ''))}</div>` : ''}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(label(t.agent))} in ${esc(t.repo)}, ${esc(dayOf(t.startedAt))}</title>
<style>
:root{--paper:${b.paper};--raised:${b.paperRaised};--ink:${b.ink};--soft:${b.inkSoft};--muted:${b.muted};--line:${b.line};--field:${b.field};--coral:${b.coral}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:40px 20px 64px}
header{display:flex;align-items:center;gap:12px;margin-bottom:28px}
header svg{width:28px;height:28px;color:var(--ink)}
h1{font-weight:300;font-size:32px;line-height:1.2;margin:0 0 6px}
.muted{color:var(--muted)}
.mono,code{font-family:ui-monospace,"SF Mono",monospace;font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--raised);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:24px}
td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
td.mark{width:20px;font-weight:600}
tr.deny td.mark,tr.deny code{color:var(--coral)}
tr.ask td.mark{color:var(--field)}
.why{color:var(--soft);font-size:13px;margin-top:4px}
.chain{border-left:3px solid var(--field);padding:8px 14px;background:var(--raised);color:var(--soft);margin:18px 0 0}
</style>
</head>
<body>
<main>
<header>${b.mark}<span class="mono muted">immiscible replay</span></header>
<h1>${esc(label(t.agent))} in ${esc(t.repo)}</h1>
<p class="muted">${esc(dayOf(t.startedAt))} ${esc(hhmm(t.startedAt))} to ${esc(hhmm(t.endedAt))}${t.branch ? ` · ${esc(t.branch)}` : ''} · ${t.calls} calls · ${esc(costText(t.cost))} at list prices · ${t.decisions.deny} refused, ${t.decisions.ask} asked</p>
<p class="chain">Read on the machine that ran it. Commands are shown with credentials redacted; prompts and file contents are not included. ${chain.days ? (chain.ok ? `The decision log's hash chain holds across ${chain.days} day${chain.days === 1 ? '' : 's'}.` : 'The decision log’s hash chain is broken: a line was removed or edited.') : 'No decisions were logged for this session.'}</p>
<table><tbody>${rows}</tbody></table>
<p class="muted mono">session ${esc(t.id)}</p>
</main>
</body>
</html>
`;
}
