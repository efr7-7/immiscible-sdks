/**
 * immiscible try: see a governed agent in under a minute, with no account.
 *
 * Starts the SDK's offline fake (src/vendor/fake.mjs) on 127.0.0.1: the same
 * HTTP contract as the real server, real Ed25519 receipts, and a small
 * imitation of a rule (not the real policy engine). A made-up finance agent
 * asks three times: a tool call is allowed, a payment to a new supplier is
 * held for the person at this terminal, and a payment to a lookalike of a
 * known supplier is refused. Then the receipt is saved and checked with
 * `immiscible verify`, offline, against the fake's public key. Nothing
 * leaves the machine, and the fake stops when the command ends.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeImmiscible } from '../vendor/fake.mjs';
import { verifyAndReport } from './verify.mjs';
import { CliError, EXIT } from '../errors.mjs';

/** The made-up rule: a finance agent that pays suppliers. */
export const TRY_RULE = Object.freeze({
  id: 'mdt_try_supplier_payments',
  title: 'Supplier payments',
  currency: 'GBP',
  perTransaction: 500_000,
  approveAbove: 100_000,
  merchants: ['kingscrosscouriers.example'],
  fields: [],
  recipients: [],
  blockedDomains: [],
  approveTools: /\b(delete|drop|transfer|deploy)\b/i,
});

/** The three requests, as the agent sends them to POST /v1/actions/authorize. */
export const TRY_REQUESTS = Object.freeze([
  {
    said: 'Look up invoice 0931 in the books',
    body: { type: 'tool.call', summary: 'Look up invoice 0931 in the books', target: { domain: 'books.example' }, provenance: [{ source: 'agent', detail: 'tool call: lookup_invoice' }] },
  },
  {
    said: 'Pay Harbour Print £1,250.00 for invoice 0931',
    body: { type: 'payment', summary: 'Pay Harbour Print invoice 0931', payment: { amount: 125_000, currency: 'GBP', merchant: { name: 'Harbour Print', domain: 'harbour-print.example' } }, provenance: [{ source: 'user', detail: 'invoice 0931, sent by Sam in finance' }] },
  },
  {
    said: 'Pay £480.00 to kingscrosscourier.example, from a link in an email',
    body: { type: 'payment', summary: 'Pay the overdue courier invoice', payment: { amount: 48_000, currency: 'GBP', merchant: { name: 'Kings Cross Courier', domain: 'kingscrosscourier.example' } }, provenance: [{ source: 'email', detail: 'a payment link in an email' }] },
  },
]);

const WORDS = { allow: 'Allowed', approval_required: 'Held for a person', deny: 'Denied' };

export async function tryIt(ctx) {
  const { ui, flags } = ctx;
  const { c } = ui;
  if (!ui.interactive && !flags.yes) {
    throw new CliError('try asks you to approve a payment, and this is not a terminal', { exit: EXIT.INPUT, code: 'input_needed', fix: 'Pass --yes to approve it, or run immiscible try in a terminal.' });
  }
  const fake = await startFakeImmiscible({ agentId: 'agt_try_finance', mandate: TRY_RULE, receiptTtlSec: 3600 });
  try {
    const call = async (method, p, body) => {
      const res = await ctx.fetchImpl(`${fake.url}${p}`, {
        method,
        headers: { authorization: `Bearer ${fake.agentKey}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.json();
    };

    ui.heading('Immiscible, offline');
    ui.out('A made-up finance agent asks three times before it acts. The fake Immiscible server the');
    ui.out('SDKs test against decides, on this machine, with a small imitation of a rule and its own');
    ui.out('signing key. No account; nothing leaves this machine.');
    ui.blank();
    ui.out(`${c.bold('The rule')}  ${TRY_RULE.title}: up to £5,000.00 a payment. A person approves anything`);
    ui.out('          above £1,000.00, and any supplier the agent has not paid before.');
    ui.blank();

    const steps = [];
    let receipt = null;
    for (const [i, req] of TRY_REQUESTS.entries()) {
      let d = await call('POST', '/v1/actions/authorize', req.body);
      const step = { request: req.body, actionId: d.id, decision: d.decision, reasons: d.reasons, signals: d.risk.signals.map((s) => s.detail), decidedBy: 'the rules' };
      ui.out(`${c.dim(`${i + 1}`)}  ${req.said}`);
      const why = [...d.reasons, ...d.risk.signals.filter((s) => s.id === 'new_merchant').map((s) => s.detail)].join('; ');
      const line = `${WORDS[d.decision]}: ${why}`;
      if (d.decision === 'allow') ui.ok(line); else if (d.decision === 'deny') ui.fail(line); else ui.warn(line);

      if (d.decision === 'approval_required') {
        const yes = flags.yes ? true : await ui.confirm(`Approve ${req.said.replace(/^Pay /, 'paying ')}?`, { default: true });
        if (flags.yes) ui.note('  approved with --yes');
        d = await call('POST', `/__fake/actions/${d.id}/${yes ? 'approve' : 'deny'}`);
        step.decision = d.decision;
        step.reasons = d.reasons;
        step.decidedBy = 'a person';
        if (d.decision === 'allow') ui.ok(`Approved by you, and signed: the payment may go ahead`);
        else ui.fail('Denied by you: the payment code never ran.');
      } else if (d.decision === 'deny') {
        ui.out(`  ${c.dim('The payment code never ran.')}`);
      }
      if (d.receipt) {
        step.receipt = d.receipt;
        if (!receipt || d.human) receipt = { token: d.receipt, actionId: d.id };
      }
      steps.push(step);
      ui.blank();
    }

    // The receipt, saved so the verify command below can be run again by hand.
    const dir = mkdtempSync(path.join(tmpdir(), 'immiscible-try-'));
    const files = { receipt: path.join(dir, 'receipt.jwt'), keys: path.join(dir, 'keys.json') };
    writeFileSync(files.receipt, `${receipt.token}\n`);
    writeFileSync(files.keys, `${JSON.stringify(fake.jwks, null, 2)}\n`);

    ui.heading('The receipt');
    ui.out(receipt.token);
    ui.blank();
    ui.out(c.dim(`$ immiscible verify ${files.receipt} --keys ${files.keys}`));
    const verified = await verifyAndReport({ ui, token: receipt.token, opts: { jwks: fake.jwks }, from: 'keys.json' });
    if (!verified.valid) throw new CliError(`the receipt did not verify: ${verified.message}`, { exit: EXIT.ERROR, code: 'verify_failed' });
    ui.blank();

    ui.heading('What just happened');
    ui.table([
      ['Asked', 'Each request was a POST to /v1/actions/authorize, made before anything ran.'],
      ['Decided', 'The rules answered allow, ask a person or deny, with their reasons.'],
      ['Approved', 'You decided the held payment here. In a workspace it reaches the right person in'],
      ['', 'Slack, Teams, email or on a phone.'],
      ['Signed', 'Allowed actions carry an Ed25519 receipt that anyone can check offline against the'],
      ['', 'public keys at /.well-known/immiscible-keys.json, with no account.'],
      ['Recorded', 'In a workspace every decision also goes into a hash-chained ledger. This test server'],
      ['', 'kept nothing, and stopped when try ended.'],
    ], { indent: '  ' });
    ui.blank();
    ui.heading('Next: govern your own agent');
    ui.out(`  npx immiscible init     ${c.dim(`sign in, create the agent and its rule, make a live test call`)}`);
    ui.out(`  ${c.dim(`A free workspace: ${ctx.url}/signup`)}`);

    if (ui.json) {
      ui.writeJson({ ok: true, offline: true, rule: { ...TRY_RULE, approveTools: undefined }, steps, receipt: receipt.token, verify: verified, files, next: 'npx immiscible init' });
    }
    return EXIT.OK;
  } finally {
    await fake.close();
  }
}
