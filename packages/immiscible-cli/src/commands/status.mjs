/**
 * immiscible status: what waits for approval, today's decisions, and this
 * month's spend in the workspace's books currency.
 */

import { EXIT } from '../errors.mjs';

const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

const monthName = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export async function status(ctx) {
  const { ui } = ctx;
  const s = await ui.spin('Reading the workspace', () => ctx.api(ctx.requireToken()).get('/v1/cli/status'));
  if (ui.json) {
    ui.writeJson({ ok: true, url: ctx.url, ...s });
    return EXIT.OK;
  }
  const { c } = ui;
  ui.out(`${c.bold(s.workspace.name)} ${c.dim(`(${s.workspace.role})`)}`);
  ui.blank();
  if (s.waiting.count) {
    ui.out(`${c.bold('Waiting for approval')}  ${c.yellow(String(s.waiting.count))}`);
    for (const a of s.waiting.items.slice(0, 10)) {
      const what = [a.summary ?? a.type, a.amountText].filter(Boolean).join(', ');
      ui.out(`  ${c.yellow('●')} ${what}  ${c.dim(`${a.agentName}, ${ago(a.createdAt)}`)}`);
      ui.out(`    ${c.dim(a.url)}`);
    }
    if (s.waiting.count > 10) ui.note(`  and ${s.waiting.count - 10} more in the console`);
  } else {
    ui.out(`${c.bold('Waiting for approval')}  nothing`);
  }
  ui.blank();
  const t = s.today;
  ui.out(`${c.bold('Today')} ${c.dim('(since 00:00 UTC)')}  ${t.total ? `${t.allowed} allowed, ${t.asked} asked a person, ${t.refused} refused` : 'no decisions yet'}`);
  const m = s.month;
  const parts = [];
  if (m.ai) parts.push(`AI ${m.ai.text}`);
  parts.push(`agent payments ${m.payments.text}`);
  for (const u of m.payments.unconverted ?? []) parts.push(`and ${u.text}`);
  ui.out(`${c.bold(monthName(m.month))}  ${parts.join(', ')}`);
  if (m.rate) ui.note(`Converted at ${m.rate.perUsd} ${m.currency} to the dollar (${m.rate.source}, ${m.rate.day}).`);
  return EXIT.OK;
}
