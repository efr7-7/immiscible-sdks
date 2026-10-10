/**
 * The scan report as a terminal summary and as one self-contained HTML
 * file. Both read only the report analyse.mjs made, which holds no prompt,
 * file content, command string or secret value.
 *
 * The HTML uses the brand's own tokens (BRAND below, copied from
 * brand.config.json "colors" and "logo", because this package is published
 * on its own; test/history.test.mjs fails if they drift) and the system
 * font stack: no new visual language, no script, no request to anywhere.
 */

import { AGENT_LABELS, usd } from './analyse.mjs';

export const BRAND = Object.freeze({
  paper: '#EEF1F6',
  paperRaised: '#FFFFFF',
  ink: '#0E1019',
  inkSoft: '#3B4150',
  muted: '#5B6170',
  line: '#E3E6EC',
  field: '#1E2F6E',
  coral: '#F0563A',
  mark: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" fill-rule="evenodd" d="M0 0H24V24H0ZM4 4V20H20V4Z"/><path fill="#F0563A" fill-rule="evenodd" d="M8 8H32V32H8ZM12 12V28H28V12Z"/><path fill="currentColor" d="M20 6H24V14H20Z"/></svg>',
});

const label = (a) => AGENT_LABELS[a] ?? a;
const day = (iso) => iso.slice(0, 10);
const costText = (r) => (r.costMicros ? usd(r.costMicros) : r.unpriced ? 'not priced' : usd(0));

/* ---------------------------------------------------------------- terminal */

export function renderText(report, ui) {
  const { c } = ui;
  const r = report;
  ui.blank();
  ui.out(`  ${c.bold('What your agents did')} ${c.dim(`${day(r.window.since)} to ${day(r.window.until)}`)}`);
  ui.note(`  ${r.privacy}`);
  ui.blank();

  if (!r.totals.sessions) {
    ui.out('  No coding agent sessions in this window.');
  } else {
    const lead = r.findings.slice(0, 3);
    lead.forEach((f, i) => ui.out(`  ${f.severity === 'high' ? c.red(String(i + 1)) : c.dim(String(i + 1))}  ${f.sentence}`));
    if (r.findings.length > 3) ui.note(`     and ${r.findings.length - 3} more below`);
  }
  ui.blank();

  const section = (title) => { ui.out(`  ${c.bold(title)}`); };

  section('Sources');
  ui.table(r.sources.map((s) => [s.label, s.status === 'read' ? `${s.sessions} ${s.sessions === 1 ? 'session' : 'sessions'}${s.via === 'guard' ? c.dim(", from the guard's log") : ''}${s.unreadable ? c.dim(`, ${s.unreadable} unreadable files passed over`) : ''}` : c.dim(s.note ?? 'skipped')]), { indent: '    ' });
  ui.blank();

  if (r.guard) {
    const g = r.guard;
    section('Guard');
    ui.out(`    ${g.total} ${g.total === 1 ? 'decision' : 'decisions'}: ${g.deny} refused, ${g.ask} asked, ${g.allow} allowed${g.settings ? c.dim(`; ${g.settings} ${g.settings === 1 ? 'settings change' : 'settings changes'} kept out of a session`) : ''}${g.paused ? c.dim(`; ${g.paused} let through while paused`) : ''}`);
    if (g.rules.length) ui.note(`    ${g.rules.slice(0, 6).map((x) => `${x.decision === 'deny' ? 'refused' : 'asked'} ${x.rule} ${x.count}`).join(' · ')}`);
    for (const d of g.brokenDays) ui.out(`    ${c.red('✗')} the log for ${d.day} does not verify from line ${d.line}`);
    ui.blank();
  }

  if (!r.totals.sessions) return;

  section('Sessions');
  ui.table([
    ...r.byAgent.map((a) => [a.label, `${a.sessions} in ${a.repositories} ${a.repositories === 1 ? 'repository' : 'repositories'}, ${a.costMicros ? usd(a.costMicros) : 'not priced'}${a.unpricedSessions && a.costMicros ? c.dim(` (+${a.unpricedSessions} not priced)`) : ''}`]),
  ], { indent: '    ' });
  ui.note(`    ${r.byRepo.slice(0, 6).map((x) => `${x.repo} ${x.sessions}`).join(' · ')}${r.byRepo.length > 6 ? ` · and ${r.byRepo.length - 6} more` : ''}`);
  ui.blank();

  section('Commands');
  ui.out(`    ${r.commands.total} run${r.commands.programs.length ? c.dim(`: ${r.commands.programs.slice(0, 8).map((p) => `${p.name} ${p.count}`).join(' · ')}`) : ''}`);
  for (const x of r.commands.risky) ui.out(`    ${c.yellow('!')} ${x.label}: ${x.count} in ${x.repos.join(', ')}`);
  ui.blank();

  section('Files');
  ui.out(`    ${r.files.reads} read, ${r.files.written} written`);
  for (const x of r.files.secretReads.slice(0, 8)) ui.out(`    ${c.yellow('!')} ${x.path} ${c.dim(`read ${x.count} by ${x.agents.join(', ')}`)}`);
  if (r.transcripts?.distinct) {
    ui.out(`    ${c.red('✗')} ${r.transcripts.distinct} secret${r.transcripts.distinct === 1 ? '' : 's'} in the agents' own history, in plain text: ${r.transcripts.byKind.map((k) => `${k.count} ${k.label}`).join(', ')}`);
    for (const l of r.transcripts.locations.slice(0, 4)) ui.out(`      ${c.dim(`${l.path} (${l.count})`)}`);
  }
  ui.blank();

  section('Network');
  ui.out(`    ${r.network.calls} outbound calls, ${r.network.searches} web searches${r.network.domains.length ? c.dim(`: ${r.network.domains.slice(0, 8).map((d) => `${d.domain} ${d.count}`).join(' · ')}`) : ''}`);
  if (r.mcp.length) ui.note(`    MCP tools called: ${r.mcp.map((m) => `${m.server} ${m.count}`).join(' · ')}`);
  for (const e of r.exfiltration) ui.out(`    ${c.red('✗')} ${label(e.agent)} in ${e.repo}: read ${e.secrets.join(', ')}, then reached ${e.domains.join(', ')}`);
  ui.blank();

  section('Permissions and hooks');
  if (r.permissions.modes.length) ui.out(`    ${r.permissions.modes.map((m) => `${m.label} ${m.mode} ${m.sessions}`).join(' · ')}`);
  for (const m of r.permissions.settings) ui.out(`    ${c.yellow('!')} ${m.where}: ${m.setting} = ${m.value}`);
  for (const h of r.permissions.hooks) ui.out(`    ${h.immiscible ? c.green('✓') : c.yellow('!')} ${h.label} ${h.event} hook in ${h.where}: ${h.program}${h.immiscible ? c.dim(' (Immiscible)') : ''}`);
  if (!r.permissions.modes.length && !r.permissions.hooks.length && !r.permissions.settings.length) ui.note('    No modes recorded and no hooks configured.');
  ui.blank();

  section('Cost');
  ui.out(`    About ${usd(r.totals.costMicros)} at list prices${r.totals.unpricedSessions ? c.dim(`, ${r.totals.unpricedSessions} ${r.totals.unpricedSessions === 1 ? 'session' : 'sessions'} not priced`) : ''}`);
  const priciest = [...r.sessions].filter((s) => s.costMicros).sort((a, b) => b.costMicros - a.costMicros).slice(0, 3);
  for (const s of priciest) ui.note(`    ${usd(s.costMicros).padStart(9)}  ${label(s.agent)} in ${s.repo}${s.branch ? ` on ${s.branch}` : ''}, ${day(s.startedAt ?? r.window.until)}`);
  ui.blank();

  if (r.findings.length > 3) {
    section('Everything else');
    r.findings.slice(3).forEach((f) => ui.out(`    ${f.severity === 'high' ? c.red('!') : c.dim('·')} ${f.sentence}`));
    ui.blank();
  }
}

/* ---------------------------------------------------------------- HTML */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function renderHtml(report) {
  const r = report;
  const b = BRAND;
  const rows = (cols, items) => items.map((it) => `<tr>${cols.map((f) => `<td>${f(it)}</td>`).join('')}</tr>`).join('');
  const table = (heads, cols, items) => (items.length ? `<table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows(cols, items)}</tbody></table>` : '<p class="muted">None.</p>');
  const lead = r.findings.slice(0, 3);
  const css = `
:root{--paper:${b.paper};--raised:${b.paperRaised};--ink:${b.ink};--soft:${b.inkSoft};--muted:${b.muted};--line:${b.line};--field:${b.field};--coral:${b.coral}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:40px 20px 64px}
header{display:flex;align-items:center;gap:12px;margin-bottom:28px}
header svg{width:28px;height:28px;color:var(--ink)}
h1{font-weight:300;font-size:32px;line-height:1.2;margin:0 0 6px}
h2{font-weight:500;font-size:17px;margin:36px 0 10px}
.muted{color:var(--muted)}
.privacy{border-left:3px solid var(--field);padding:8px 14px;background:var(--raised);color:var(--soft);margin:18px 0 26px}
ol.lead{list-style:none;padding:0;margin:0}
ol.lead li{background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin:0 0 8px;display:flex;gap:12px}
ol.lead b{font-family:ui-monospace,"SF Mono",monospace;color:var(--muted)}
ol.lead li.high b{color:var(--coral)}
table{width:100%;border-collapse:collapse;background:var(--raised);border:1px solid var(--line);border-radius:6px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:500;color:var(--muted);font-size:13px}
td code,.mono{font-family:ui-monospace,"SF Mono",monospace;font-size:13px}
.flag{color:var(--coral)}
`;
  const sourceRows = r.sources.map((s) => ({ ...s, text: s.status === 'read' ? `${s.sessions} sessions${s.via === 'guard' ? ", from the guard's log" : ''}${s.unreadable ? `, ${s.unreadable} unreadable files passed over` : ''}` : s.note ?? 'skipped' }));
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>What your agents did, ${esc(day(r.window.since))} to ${esc(day(r.window.until))}</title>
<style>${css}</style>
</head>
<body>
<main>
<header>${b.mark}<span class="mono muted">immiscible scan</span></header>
<h1>What your agents did</h1>
<p class="muted">${esc(day(r.window.since))} to ${esc(day(r.window.until))} · ${r.totals.sessions} sessions · ${r.totals.repositories} repositories · about ${esc(usd(r.totals.costMicros))} at list prices</p>
<p class="privacy">${esc(r.privacy)}</p>
${lead.length ? `<ol class="lead">${lead.map((f, i) => `<li class="${esc(f.severity)}"><b>${i + 1}</b><span>${esc(f.sentence)}</span></li>`).join('')}</ol>` : '<p>No coding agent sessions in this window.</p>'}
<h2>Sources</h2>
${table(['Agent', 'Read'], [(s) => esc(s.label), (s) => esc(s.text)], sourceRows)}
${r.guard ? `<h2>Guard</h2><p>${r.guard.total} decisions: ${r.guard.deny} refused, ${r.guard.ask} asked, ${r.guard.allow} allowed.${r.guard.settings ? ` ${Number(r.guard.settings)} settings changes kept out of a session.` : ''}</p>${r.guard.rules.length ? table(['Rule', 'Decision', 'Times'], [(x) => `<code>${esc(x.rule)}</code>`, (x) => (x.decision === 'deny' ? '<span class="flag">refused</span>' : 'asked'), (x) => x.count], r.guard.rules) : ''}${r.guard.brokenDays.map((d) => `<p class="flag">The log for ${esc(d.day)} does not verify from line ${Number(d.line)}.</p>`).join('')}` : ''}
<h2>Sessions by agent</h2>
${table(['Agent', 'Sessions', 'Repositories', 'Cost'], [(a) => esc(a.label), (a) => a.sessions, (a) => a.repositories, (a) => esc(a.costMicros ? usd(a.costMicros) : 'not priced')], r.byAgent)}
<h2>Sessions by repository</h2>
${table(['Repository', 'Sessions', 'Agents', 'Cost'], [(x) => `<code>${esc(x.repo)}</code>`, (x) => x.sessions, (x) => esc(x.agents.join(', ')), (x) => esc(usd(x.costMicros))], r.byRepo)}
<h2>Commands</h2>
<p>${r.commands.total} run. ${esc(r.commands.programs.map((p) => `${p.name} ${p.count}`).join(' · '))}</p>
${table(['Flagged', 'Times', 'Repositories', 'Agents'], [(x) => `<span class="flag">${esc(x.label)}</span>`, (x) => x.count, (x) => esc(x.repos.join(', ')), (x) => esc(x.agents.join(', '))], r.commands.risky)}
<h2>Secret files read</h2>
<p>${r.files.reads} files read, ${r.files.written} written.</p>
${table(['Path', 'Times', 'Agents'], [(x) => `<code>${esc(x.path)}</code>`, (x) => x.count, (x) => esc(x.agents.join(', '))], r.files.secretReads)}
${r.transcripts?.distinct ? `<h2>Secrets in the agents' own history</h2><p>${r.transcripts.distinct} distinct, in plain text, in ${r.transcripts.files} history files. Shown by kind only; rotate them.</p>${table(['Kind', 'How many'], [(k) => `<span class="flag">${esc(k.label)}</span>`, (k) => k.count], r.transcripts.byKind)}${table(['Where', 'Agent', 'Secrets'], [(l) => `<code>${esc(l.path)}</code>`, (l) => esc(label(l.agent)), (l) => l.count], r.transcripts.locations)}` : ''}
<h2>Network</h2>
<p>${r.network.calls} outbound calls, ${r.network.searches} web searches.</p>
${table(['Domain', 'Times'], [(d) => `<code>${esc(d.domain)}</code>`, (d) => d.count], r.network.domains)}
${r.exfiltration.length ? `<h2>A secret read, then the network</h2>${table(['Agent', 'Repository', 'Read', 'Then reached'], [(e) => esc(label(e.agent)), (e) => `<code>${esc(e.repo)}</code>`, (e) => esc(e.secrets.join(', ')), (e) => `<span class="flag">${esc(e.domains.join(', '))}</span>`], r.exfiltration)}` : ''}
<h2>Permissions and hooks</h2>
${table(['Agent', 'Mode', 'Sessions'], [(m) => esc(m.label), (m) => `<code>${esc(m.mode)}</code>`, (m) => m.sessions], r.permissions.modes)}
${r.permissions.hooks.length ? table(['Agent', 'Hook', 'Where', 'Runs'], [(h) => esc(h.label), (h) => esc(h.event), (h) => `<code>${esc(h.where)}</code>`, (h) => `${esc(h.program)}${h.immiscible ? ' (Immiscible)' : ' <span class="flag">not recognised</span>'}`], r.permissions.hooks) : ''}
<h2>Every session</h2>
${table(['Started', 'Agent', 'Repository', 'Branch', 'Tool calls', 'Cost', 'Flags'], [(s) => esc(s.startedAt ? s.startedAt.slice(0, 16).replace('T', ' ') : ''), (s) => esc(label(s.agent)), (s) => `<code>${esc(s.repo)}</code>`, (s) => esc(s.branch ?? ''), (s) => s.toolCalls, (s) => esc(costText(s)), (s) => `<span class="flag">${esc(s.flags.join(', '))}</span>`], r.sessions.slice(0, 500))}
${r.findings.length > 3 ? `<h2>Everything else</h2><ul>${r.findings.slice(3).map((f) => `<li>${esc(f.sentence)}</li>`).join('')}</ul>` : ''}
</main>
</body>
</html>
`;
}
