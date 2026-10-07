/**
 * immiscible try and immiscible verify. What is proved: try needs no account
 * and no network beyond 127.0.0.1; it shows one action allowed, one held for
 * the person at the terminal and one denied, in that order and in well under
 * a minute; the person's answer at the prompt decides the held payment; the
 * receipt it prints verifies with `immiscible verify`, and an altered one
 * does not (exit 12); the output is calm (colour only on a terminal, no
 * emoji); and without a terminal it asks for --yes rather than hanging.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { main } from '../src/main.mjs';
import { startFakeImmiscible } from '../src/vendor/fake.mjs';
import { runCli, tmp } from './helpers.mjs';

const ANSI = /\u001b\[/;
const EMOJI = /\p{Extended_Pictographic}/u;
// The tick, cross and exclamation the CLI already uses are text symbols, not emoji.
const strip = (s) => s.replace(/[✓✗]/g, '');

/** Run in this process, with a terminal (or not), and every socket that is not loopback refused. */
async function runHere(argv, { tty = false, answers = [], env = {} } = {}) {
  const sockets = [];
  const fetched = [];
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function watched(...a) {
    const o = a[0] && typeof a[0] === 'object' ? a[0] : { port: a[0], host: a[1] };
    sockets.push(String(o.host ?? o.path ?? 'localhost'));
    if (o.host && !['127.0.0.1', 'localhost', '::1'].includes(o.host)) throw new Error('the network is off in this test');
    return realConnect.apply(this, a);
  };
  let out = '';
  const stdout = new Writable({ write(chunk, _e, cb) { out += chunk; if (/\[Y\/n\]/.test(chunk) && answers.length) setImmediate(() => stdin.write(`${answers.shift()}\n`)); cb(); } });
  stdout.isTTY = tty;
  stdout.columns = 100;
  let err = '';
  const stderr = new Writable({ write(chunk, _e, cb) { err += chunk; cb(); } });
  const stdin = new PassThrough();
  stdin.isTTY = tty;
  const started = Date.now();
  try {
    const code = await main(argv, {
      env: { HOME: tmp('imm-try-home-'), ...(tty ? {} : { CI: '1' }), ...env },
      cwd: tmp('imm-try-'),
      stdout, stderr, stdin,
      fetchImpl: (url, init) => { fetched.push(new URL(url).host); return fetch(url, init); },
    });
    return { code, out, err, sockets, fetched, ms: Date.now() - started };
  } finally {
    net.Socket.prototype.connect = realConnect;
    stdin.destroy();
  }
}

test('try --yes --json: allowed, held then approved, denied; a verified receipt; loopback only', async () => {
  const r = await runHere(['try', '--yes', '--json']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out.trim());
  assert.equal(j.ok, true);
  assert.equal(j.offline, true);
  assert.deepEqual(j.steps.map((s) => s.request.type), ['tool.call', 'payment', 'payment']);
  assert.deepEqual(j.steps.map((s) => s.decision), ['allow', 'allow', 'deny']);
  assert.deepEqual(j.steps.map((s) => s.decidedBy), ['the rules', 'a person', 'the rules']);
  assert.match(j.steps[1].reasons.join(' '), /above the £1,000\.00/);
  assert.match(j.steps[1].signals.join(' '), /harbour-print\.example is new/);
  assert.match(j.steps[2].reasons.join(' '), /looks like kingscrosscouriers\.example/);
  assert.equal(j.steps[2].receipt, undefined, 'a denied action has no receipt');
  assert.equal(j.verify.valid, true);
  assert.equal(j.verify.claims.hum, true, 'the receipt shown is the one a person approved');
  assert.equal(j.verify.claims.amt, 125000);
  assert.equal(readFileSync(j.files.receipt, 'utf8').trim(), j.receipt);
  assert.ok(existsSync(j.files.keys));
  assert.equal(j.next, 'npx immiscible init');
  assert.ok(r.fetched.length >= 4 && r.fetched.every((h) => h.startsWith('127.0.0.1:')), `fetched only the local fake: ${r.fetched}`);
  assert.ok(r.sockets.every((h) => ['127.0.0.1', 'localhost'].includes(h)), `sockets: ${r.sockets}`);
  assert.ok(r.ms < 10_000, `took ${r.ms}ms`);
});

test('try at a terminal: the person says no, so the payment is denied and the receipt is the tool call\'s', async () => {
  const r = await runHere(['try'], { tty: true, answers: ['n'] });
  assert.equal(r.code, 0, r.err);
  assert.ok(ANSI.test(r.out), 'colour on a terminal');
  const plain = r.out.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(plain, /\? Approve paying Harbour Print £1,250\.00 for invoice 0931\? \[Y\/n\]/);
  assert.match(plain, /Denied by you: the payment code never ran\./);
  assert.match(plain, /Verified: signed by key \S+ from keys\.json/);
  assert.match(plain, /approved {2}by the rules, with no person needed/);
});

test('try at a terminal: pressing return approves', async () => {
  const r = await runHere(['try'], { tty: true, answers: [''] });
  assert.equal(r.code, 0, r.err);
  const plain = r.out.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(plain, /Approved by you, and signed/);
  assert.match(plain, /approved {2}by a person/);
});

test('try, human output through a pipe: calm, in order, and ends on what happened and init', async () => {
  const r = await runHere(['try', '--yes']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!ANSI.test(r.out), 'no colour off a terminal');
  assert.ok(!EMOJI.test(strip(r.out)), 'no emoji');
  const order = ['Immiscible, offline', '✓ Allowed', '! Held for a person', '✓ Approved', '✗ Denied', 'The receipt', '$ immiscible verify', '✓ Verified', 'What just happened', 'POST to /v1/actions/authorize', '/.well-known/immiscible-keys.json', 'npx immiscible init'];
  let at = -1;
  for (const s of order) {
    const i = r.out.indexOf(s, at + 1);
    assert.ok(i > at, `"${s}" in order`);
    at = i;
  }
  const lines = r.out.trimEnd().split('\n');
  assert.match(lines.at(-2), /^ {2}npx immiscible init/);
});

test('try without a terminal and without --yes exits 4 and names the flag', async () => {
  const r = await runCli(['try', '--json'], { cwd: tmp(), home: tmp() });
  assert.equal(r.code, 4);
  assert.equal(r.json.error.code, 'input_needed');
  assert.match(r.json.error.fix, /--yes/);
});

test('verify: the receipt try saved verifies from the files; one changed character fails with exit 12', async () => {
  const t = await runCli(['try', '--yes', '--json'], { cwd: tmp(), home: tmp() });
  assert.equal(t.code, 0, t.stderr);
  const { files } = t.json;
  const ok = await runCli(['verify', files.receipt, '--keys', files.keys, '--json'], { cwd: tmp(), home: tmp() });
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.json.valid, true);
  assert.equal(ok.json.claims.mer, 'harbour-print.example');

  const [h, p, s] = t.json.receipt.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  const altered = `${h}.${Buffer.from(JSON.stringify({ ...claims, amt: 1250000 })).toString('base64url')}.${s}`;
  const dir = tmp();
  writeFileSync(path.join(dir, 'altered.jwt'), altered);
  const bad = await runCli(['verify', 'altered.jwt', '--keys', files.keys, '--json'], { cwd: dir, home: tmp() });
  assert.equal(bad.code, 12);
  assert.equal(bad.json.valid, false);
  assert.equal(bad.json.reason, 'bad_signature');

  const human = await runCli(['verify', altered, '--keys', files.keys], { cwd: dir, home: tmp() });
  assert.equal(human.code, 12);
  assert.match(human.stdout, /^✗ Not valid: the signature does not match/m);
});

test('verify: keys from a URL, the issuer checked against --url, and stdin', async () => {
  const fake = await startFakeImmiscible();
  try {
    const res = await fetch(`${fake.url}/v1/actions/authorize`, { method: 'POST', headers: { authorization: `Bearer ${fake.agentKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'tool.call', summary: 'Read a page', target: { domain: 'example.com' } }) }).then((x) => x.json());
    const keysUrl = `${fake.url}/.well-known/immiscible-keys.json`;
    const fromUrl = await runCli(['verify', res.receipt, '--keys', keysUrl, '--json'], { cwd: tmp(), home: tmp() });
    assert.equal(fromUrl.code, 0, fromUrl.stdout);
    const fromServer = await runCli(['verify', '-', '--url', fake.url, '--json'], { cwd: tmp(), home: tmp(), input: `${res.receipt}\n` });
    assert.equal(fromServer.code, 0, fromServer.stdout);
    const elsewhere = await runCli(['verify', res.receipt, '--keys', keysUrl, '--url', 'http://127.0.0.1:1', '--json'], { cwd: tmp(), home: tmp() });
    assert.equal(elsewhere.code, 12);
    assert.equal(elsewhere.json.reason, 'wrong_issuer');
  } finally {
    await fake.close();
  }
});

test('verify: no receipt is a usage error, and so is a word that is neither a file nor a receipt', async () => {
  const none = await runCli(['verify', '--json'], { cwd: tmp(), home: tmp() });
  assert.equal(none.code, 2);
  const word = await runCli(['verify', 'nonsense', '--keys', 'k.json', '--json'], { cwd: tmp(), home: tmp() });
  assert.equal(word.code, 2);
});

test('help lists try and verify, and --keys is a flag', async () => {
  const r = await runCli(['help', '--json'], { cwd: tmp(), home: tmp() });
  const names = r.json.commands.map((c) => c.name);
  assert.ok(names.includes('try') && names.includes('verify'));
  assert.ok(r.json.flags['--keys']);
  assert.equal(r.json.exitCodes[12], 'invalid');
});
