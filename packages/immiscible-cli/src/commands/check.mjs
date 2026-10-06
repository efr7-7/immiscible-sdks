/**
 * immiscible check: the AI check, from the machine the agents run on.
 *
 * Reads this project and your home directory (src/scan.mjs) and says what
 * the agents here can touch: MCP servers and what each can do, Claude Code
 * permissions, and provider keys in .env files and shell config. Runs
 * locally; nothing leaves the machine. With --upload, only the findings are
 * sent (no key, redacted or not, and no file contents) to make a report
 * link that lasts seven days.
 *
 * Exit 0 when nothing high-risk was found, 11 when something was. No sign-in
 * is needed, not even for --upload.
 */

import { homedir } from 'node:os';
import { scan, uploadBody } from '../scan.mjs';
import { request, errorFrom } from '../api.mjs';
import { EXIT } from '../errors.mjs';

const CAP = { pay: 'can make payments', shell: 'can run shell commands', db_write: 'can write to a database', email: 'can send email', write: 'can change files or records', network: 'can reach the internet' };

export async function check(ctx) {
  const { ui, flags } = ctx;
  const home = ctx.env.HOME || homedir();
  const r = scan(ctx.dir, { home });
  const high = r.findings.filter((f) => f.severity === 'high');

  let uploaded = null;
  if (flags.upload) {
    const body = uploadBody(r);
    const res = await ui.spin('Sending the findings (no keys)', () => request(ctx.url, '/api/check/upload', { method: 'POST', body, fetchImpl: ctx.fetchImpl, headers: { 'x-immiscible-csrf': '1' } }));
    if (!res.ok) throw errorFrom(res, { what: 'sending the findings' });
    const share = res.json?.share ?? {};
    uploaded = { url: share.page ? `${ctx.url}${share.page}` : null, expiresAt: share.expiresAt ?? null, sent: body.permissions.length };
  }

  const exit = high.length ? EXIT.FINDINGS : EXIT.OK;
  if (ui.json) {
    ui.writeJson({
      ok: true, exitCode: exit, dir: r.dir, name: r.name, local: !flags.upload,
      agents: r.agents, mcp: r.mcp, claude: r.claude, env: r.env,
      keys: r.keys.map((k) => ({ provider: k.provider, kind: k.kind, file: k.file, name: k.name, redacted: k.redacted, fingerprint: k.fingerprint, ignoredByGit: k.ignored, ...(k.server ? { server: k.server } : {}) })),
      findings: r.findings.map(({ kind, ...f }, i) => ({ rank: i + 1, ...f })),
      uploaded,
    });
    return exit;
  }

  const { c } = ui;
  const where = r.dir.startsWith(home) ? `~${r.dir.slice(home.length)}` : r.dir;
  ui.blank();
  ui.out(`  Checked ${c.bold(where)} ${c.dim(uploaded ? `(sent ${uploaded.sent} findings, no keys)` : '(nothing left this machine)')}`);
  ui.blank();
  const servers = r.mcp.servers;
  const capable = servers.filter((s) => !s.governed && CAP[s.capability]).slice(0, 3).map((s) => `${s.name} ${CAP[s.capability]}`);
  const envKeys = r.keys.filter((k) => k.kind === 'env');
  const shellKeys = r.keys.filter((k) => k.kind === 'shell');
  const keyParts = [];
  if (envKeys.length) keyParts.push(`${envKeys.length} provider ${envKeys.length === 1 ? 'key' : 'keys'} in ${[...new Set(envKeys.map((k) => k.file))].join(', ')}`);
  for (const e of r.env.filter((x) => x.keys && x.ignored !== true)) keyParts.push(`${e.file} is not in .gitignore`);
  if (shellKeys.length) keyParts.push(`${shellKeys.length} in shell config`);
  const claudeLine = r.claude.allows.length ? `Claude Code ${r.claude.allows[0].what}${r.claude.hook ? ', and the Immiscible hook asks first' : ''}` : r.claude.present ? `nothing allowed without asking${r.claude.hook ? '; the Immiscible hook is installed' : ''}` : 'not used here';
  ui.table([
    ['Agents', r.agents.length ? r.agents.join(', ') : 'no agent framework found'],
    ['MCP', servers.length ? [`${servers.length} ${servers.length === 1 ? 'server' : 'servers'}`, ...capable].join(' · ') : 'no servers configured'],
    ['Claude', claudeLine],
    ['Keys', keyParts.length ? keyParts.join(' · ') : 'no provider keys found'],
  ], { indent: '  ' });
  ui.blank();
  if (r.findings.length) {
    ui.out(`  ${c.bold('Riskiest first')}`);
    r.findings.slice(0, 5).forEach((f, i) => ui.out(`  ${f.severity === 'high' ? c.red(String(i + 1)) : c.dim(String(i + 1))}  ${f.detail}`));
    if (r.findings.length > 5) ui.note(`     and ${r.findings.length - 5} more: --json lists them all`);
  } else {
    ui.out('  Nothing here can pay, run commands or write to a database without asking.');
  }
  for (const k of r.keys.slice(0, 10)) ui.note(`     ${k.label} key ${k.redacted} in ${k.file}${k.name ? ` (${k.name})` : ''}, ${k.fingerprint}`);
  ui.blank();
  const next = [
    uploaded?.url ? ['Your report, for seven days:', uploaded.url] : ['Add spend and every key in your company:', `${ctx.url}/check`],
    nextStep(r),
  ];
  const w = Math.max(...next.map(([k]) => k.length));
  for (const [k, v] of next) ui.out(`  ${k.padEnd(w)}  ${v}`);
  if (!uploaded) ui.note('  Make a report link from these findings (no keys are sent):  npx immiscible check --upload');
  return exit;
}

/**
 * The one next step, true to what was found: the first finding that nothing
 * asks about yet, or, with nothing open, doctor for a project the hook
 * already governs and init for one it does not.
 */
export function nextStep(r) {
  const at = r.findings.findIndex((f) => !f.asksFirst);
  if (at === -1) return r.claude.hook ? ['Governed here already; check it end to end:', 'npx immiscible doctor'] : ['Govern the agents here:', 'npx immiscible init'];
  const f = r.findings[at];
  const which = at === 0 ? 'the first one' : `number ${at + 1}`;
  if (f.kind === 'key_shell') return [`Fix ${which}:`, 'move the key from your shell config into the project\'s .env'];
  return [`Fix ${which} now:`, 'npx immiscible init'];
}
