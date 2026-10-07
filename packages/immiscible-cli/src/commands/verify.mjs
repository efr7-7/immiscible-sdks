/**
 * immiscible verify: check a signed receipt, offline, with the same verifier
 * the SDK ships (src/vendor/verify.mjs). Needs no account and no agent key:
 * only the receipt and the issuer's public keys, from a file you hold
 * (--keys keys.json, nothing fetched) or from your server's
 * /.well-known/immiscible-keys.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyReceipt, decodeReceiptUnverified, JWKS_PATH } from '../vendor/verify.mjs';
import { CliError, EXIT, usage } from '../errors.mjs';

const money = (minor, cur) => {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(minor / 100);
  } catch {
    return `${minor / 100} ${cur}`;
  }
};
const when = (sec) => `${new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The receipt from an argument: a file, "-" for stdin, or the token itself. */
async function readReceipt(arg, { dir, stdin }) {
  if (!arg) throw usage('verify needs a receipt', 'Run immiscible verify <receipt.jwt>, pass the token itself, or - to read it from stdin.');
  if (arg === '-') {
    let text = '';
    for await (const chunk of stdin) text += chunk;
    return text.trim();
  }
  const file = path.resolve(dir, arg);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(arg)) return arg;
  throw usage(`${arg} is not a file or a receipt`, 'Pass the path of a file holding the receipt, the receipt itself (three base64url parts), or - for stdin.');
}

/** Where the keys come from: a file (pinned), a URL, or the server's own key set. */
function keysFrom(flags, { dir, url }) {
  const k = flags.keys;
  if (!k) return { opts: { issuer: url }, from: `${url}${JWKS_PATH}` };
  if (/^https?:\/\//i.test(k)) return { opts: { jwksUrl: k, ...(flags.url ? { issuer: url } : {}) }, from: k };
  const file = path.resolve(dir, k);
  if (!existsSync(file)) throw usage(`--keys ${k} is not a file or a URL`);
  let jwks;
  try {
    jwks = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw usage(`--keys ${k} is not JSON`, 'Save the issuer\'s key set, from /.well-known/immiscible-keys.json, and pass that file.');
  }
  return { opts: { jwks, ...(flags.url ? { issuer: url } : {}) }, from: path.basename(file) };
}

/**
 * Verify, and print the outcome. Shared with `try`, which runs it on the
 * receipt it has just been given.
 */
export async function verifyAndReport({ ui, token, opts, from, fetchImpl }) {
  let r;
  try {
    r = await verifyReceipt(token, { ...opts, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  } catch (err) {
    throw new CliError(err?.message ?? String(err), { exit: EXIT.ERROR, code: 'verify_failed' });
  }
  let kid = null;
  try { kid = decodeReceiptUnverified(token).header.kid ?? null; } catch { /* malformed: r says so */ }
  const result = { valid: r.valid, reason: r.reason, message: r.message, kid, keys: from, claims: r.claims };
  if (ui.json) return result;
  const { c } = ui;
  if (!r.valid) {
    ui.fail(`Not valid: ${r.message}`);
    ui.out(`  ${c.dim(`reason ${r.reason}, keys from ${from}`)}`);
    return result;
  }
  const cl = r.claims;
  ui.ok(`Verified: signed by key ${kid} from ${from}, and not changed since`);
  const rows = [['action', `${cl.act} (${cl.typ})`], ['agent', cl.sub]];
  if (cl.amt != null) rows.push(['amount', `${money(cl.amt, cl.cur)}${cl.mer ? ` to ${cl.mer}` : ''}`]);
  else if (cl.mer) rows.push(['target', cl.mer]);
  rows.push(['approved', cl.hum ? 'by a person' : 'by the rules, with no person needed']);
  if (cl.mdt) rows.push(['rule', cl.mdt]);
  rows.push(['issued', when(cl.iat)], ['expires', when(cl.exp)], ['issuer', cl.iss]);
  ui.table(rows, { indent: '  ' });
  return result;
}

export async function verify(ctx) {
  const { ui, flags } = ctx;
  const token = await readReceipt(ctx.rest[0], { dir: ctx.dir, stdin: ctx.stdin ?? process.stdin });
  const { opts, from } = keysFrom(flags, { dir: ctx.dir, url: ctx.url });
  const result = await verifyAndReport({ ui, token, opts, from, fetchImpl: ctx.fetchImpl });
  if (ui.json) ui.writeJson({ ok: result.valid, ...result });
  return result.valid ? EXIT.OK : EXIT.INVALID;
}
