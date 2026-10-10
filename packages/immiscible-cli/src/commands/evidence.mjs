/**
 * immiscible evidence ai-act [--out pack.zip] [--force] [--json]
 *
 * Downloads the EU AI Act deployer evidence pack for the workspace you are
 * signed in to (GET /v1/cli/evidence/ai-act): a zip with pack.json and a
 * readable SUMMARY.md, or the JSON alone when --out ends in .json. For the
 * people who read evidence (owners, admins, security admins, auditors).
 * Never overwrites a file unless --force. Exits 12 when the pack reports
 * that the ledger did not verify, so a scheduled export notices.
 */

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, usage } from '../errors.mjs';
import { errorFrom } from '../api.mjs';

const SUBJECTS = ['ai-act'];

export async function evidence(ctx) {
  const { ui, flags } = ctx;
  const sub = ctx.rest?.[0] ?? null;
  if (!SUBJECTS.includes(sub)) throw usage(sub ? `unknown evidence pack "${sub}"` : 'evidence needs the pack to make', 'Run immiscible evidence ai-act --out pack.zip.');
  if (flags.out != null && (typeof flags.out !== 'string' || !flags.out.trim())) throw usage('--out needs a file name', 'Run immiscible evidence ai-act --out pack.zip.');
  const token = ctx.requireToken();
  const today = new Date().toISOString().slice(0, 10);
  const file = path.resolve(ctx.dir, flags.out ?? `ai-act-evidence-${today}.zip`);
  const asJson = /\.json$/i.test(file);
  if (existsSync(file) && !flags.force) throw usage(`${path.basename(file)} already exists`, 'Choose another --out, or pass --force to replace it.');

  const client = ctx.api(token);
  let verified;
  let brokenAt = null;
  let bytes;
  if (asJson) {
    const pack = await ui.spin('Assembling the evidence pack', () => client.get('/v1/cli/evidence/ai-act', { timeoutMs: 120_000 }));
    verified = Boolean(pack.integrity?.chainVerified);
    brokenAt = pack.integrity?.brokenAt ?? null;
    bytes = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`);
  } else {
    const r = await ui.spin('Assembling the evidence pack', () => client.raw('GET', '/v1/cli/evidence/ai-act?format=zip', { binary: true, timeoutMs: 120_000 }));
    if (!r.ok) throw errorFrom(r, { what: 'the evidence pack' });
    verified = r.headers.get('x-immiscible-chain-verified') === 'true';
    bytes = r.bytes;
  }
  try {
    writeFileSync(file, bytes);
  } catch (err) {
    throw new CliError(`could not write ${file} (${err.code ?? err.message})`, { exit: EXIT.ERROR, code: 'write_failed', fix: 'Choose a directory you can write to with --out.' });
  }
  if (ui.json) {
    ui.writeJson({ ok: verified, url: ctx.url, pack: 'ai-act', file, format: asJson ? 'json' : 'zip', bytes: bytes.length, chainVerified: verified, ...(asJson && !verified ? { brokenAt } : {}) });
  } else {
    ui.ok(`Saved the EU AI Act evidence pack to ${ui.c.bold(path.relative(process.cwd(), file) || file)}`);
    if (verified) ui.note('The ledger verified when the pack was made.');
    else ui.out(`${ui.c.red('✗')} The ledger did not verify${brokenAt != null ? ` (first break at record ${brokenAt})` : ''}; the pack says where. Records from the break on cannot be relied on.`);
    ui.note('Evidence for a compliance file; it does not make anyone compliant and is not legal advice.');
  }
  return verified ? EXIT.OK : EXIT.INVALID;
}
