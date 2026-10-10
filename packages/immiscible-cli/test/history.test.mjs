/**
 * immiscible scan: the history readers, the pure analysis and the command.
 * What is proved: fixture histories for Claude Code and Codex produce the
 * expected findings, including a secret read followed by the network and a
 * force push; a missing agent is skipped with a note; a sentinel secret and
 * prompt text never appear in the terminal, JSON or HTML output; 1,000
 * sessions scan in under 5 seconds; and the copied price table and brand
 * tokens match the server's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { segments, riskyKind, isSecretPath, hostOf, analyse } from '../src/history/analyse.mjs';
import { readHistory, argvToCommand } from '../src/history/readers.mjs';
import { tomlTop, programOf } from '../src/history/config.mjs';
import { priceId, costMicros, PRICES } from '../src/history/prices.mjs';
import { BRAND } from '../src/history/render.mjs';
import { parseSince, shownPath } from '../src/commands/scan.mjs';
import { runCli, tmp, inRepo } from './helpers.mjs';
import { fleetHome, manySessions, SENTINEL, PROMPT_SENTINEL } from './history-fixtures.mjs';

const kinds = (cmd) => segments(cmd).map(riskyKind).filter(Boolean);

test('risky commands are recognised through wrappers, chains and shells', () => {
  assert.deepEqual(kinds('git push --force origin main'), ['force_push']);
  assert.deepEqual(kinds('git push -f'), ['force_push']);
  assert.deepEqual(kinds('git push origin +main'), ['force_push']);
  assert.deepEqual(kinds('git push --force-with-lease'), ['force_push']);
  assert.deepEqual(kinds('git push origin main'), []);
  assert.deepEqual(kinds('cd x && rm -rf build'), ['rm_rf']);
  assert.deepEqual(kinds('sudo -E rm -fr /tmp/x'), ['rm_rf']);
  assert.deepEqual(kinds('rm -r build'), []);
  assert.deepEqual(kinds('bash -lc "terraform apply -auto-approve"'), ['terraform']);
  assert.deepEqual(kinds('terraform plan'), []);
  assert.deepEqual(kinds('FOO=1 kubectl get pods | grep x'), ['kubectl']);
  assert.deepEqual(kinds('npm test; npm publish --access public'), ['publish']);
  assert.deepEqual(kinds('twine upload dist/*'), ['publish']);
  assert.deepEqual(kinds('echo "git push --force"'), []);
  assert.equal(argvToCommand(['bash', '-lc', 'git push -f']), 'git push -f');
  assert.equal(argvToCommand(['kubectl', 'get', 'pods']), 'kubectl get pods');
});

test('secret paths and hosts', () => {
  for (const p of ['.env', '/a/b/.env', '.env.production', 'certs/server.pem', '~/.ssh/id_ed25519', '/Users/x/.aws/credentials', '.npmrc', 'gcp/service-account.json', '/h/.kube/config']) assert.ok(isSecretPath(p), p);
  for (const p of ['.env.example', '.env.sample', 'src/env.ts', '~/.ssh/id_ed25519.pub', 'README.md', 'https://x.test/.env']) assert.ok(!isSecretPath(p), p);
  assert.equal(hostOf('https://user:pw@API.Example.com:8443/x?token=1'), 'api.example.com');
  assert.equal(hostOf('not a url'), null);
  assert.equal(programOf('FOO=1 node ./hooks/setup.mjs --x'), 'node setup.mjs');
  assert.equal(programOf('/usr/local/bin/guard --strict'), 'guard');
  assert.deepEqual(tomlTop('model = "gpt-5"\napproval_policy = "never" # c\n[t]\nsandbox_mode = "x"\n'), { model: 'gpt-5', approval_policy: 'never' });
});

test('--since takes periods and dates', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(parseSince(undefined, now), now - 7 * 86400000);
  assert.equal(parseSince('24h', now), now - 86400000);
  assert.equal(parseSince('2w', now), now - 14 * 86400000);
  assert.equal(parseSince('2026-10-01', now), Date.parse('2026-10-01'));
  assert.throws(() => parseSince('soon', now), /--since/);
  assert.throws(() => parseSince('2027-01-01', now), /--since/);
});

test('models are priced from the copied table, and unknown models are not guessed', () => {
  assert.equal(priceId('claude-sonnet-4-5-20250929'), 'anthropic/claude-sonnet-4-5');
  assert.equal(priceId('claude-opus-4-8'), 'anthropic/claude-opus-4.8');
  assert.equal(priceId('gpt-5-codex'), 'openai/gpt-5');
  assert.equal(priceId('gemini-2.5-pro'), null);
  assert.equal(priceId('<synthetic>'), null);
  // 1M fresh input at $3, 1M cache reads at $0.30, 1M output at $15
  assert.equal(costMicros('claude-sonnet-4-5', { input: 1e6, cacheRead: 1e6, output: 1e6 }), 18_300_000);
  assert.equal(costMicros('mystery-model', { input: 1e6 }), null);
});

test('fixture histories produce the expected findings', () => {
  const { home } = fleetHome();
  const now = Date.now();
  const since = now - 7 * 86400000;
  const { sessions, sources } = readHistory({ home, env: {}, since });
  const shown = shownPath(home);
  const r = analyse({ sessions, sources, since, until: now, shown });

  assert.equal(r.totals.sessions, 3, 'the three-week-old session is outside the window');
  assert.deepEqual(r.byAgent.map((a) => [a.agent, a.sessions]), [['claude-code', 2], ['codex', 1]]);
  assert.deepEqual(r.byRepo.map((x) => x.repo).sort(), ['hollis-agents', 'payments-api']);
  const risky = Object.fromEntries(r.commands.risky.map((x) => [x.kind, x.count]));
  assert.deepEqual(risky, { force_push: 2, rm_rf: 1, terraform: 1, kubectl: 1, publish: 1 });
  assert.deepEqual(r.files.secretReads.map((x) => x.path).sort(), ['~/.aws/credentials', '~/work/hollis-agents/.env']);
  assert.deepEqual(r.exfiltration.map((e) => [e.agent, e.secrets, e.domains]).sort(), [
    ['claude-code', ['~/work/hollis-agents/.env'], ['collect.example.net']],
    ['codex', ['~/.aws/credentials'], ['paste.example.com']],
  ]);
  assert.deepEqual(r.network.domains.map((d) => d.domain).sort(), ['collect.example.net', 'docs.example.org', 'paste.example.com']);
  assert.equal(r.permissions.bypassSessions, 2, 'bypassPermissions, and Codex with approvals never in a full-access sandbox');
  assert.deepEqual(r.mcp, [{ server: 'stripe', count: 1 }]);
  // A streamed Claude message is counted once: 4 calls of 1,000 fresh, 20,000 read, 2,000 written, 500 out at Sonnet 4.5 prices.
  const a = r.sessions.find((s) => s.session.startsWith('claude-code:aaaa1111'));
  assert.equal(a.costMicros, 96_000);
  // Codex: 200,000 input of which 150,000 cached, 8,000 output, at GPT-5 prices.
  assert.equal(r.sessions.find((s) => s.agent === 'codex').costMicros, 161_250);
  assert.equal(r.findings[0].kind, 'exfiltration_shape');
  assert.ok(r.findings.slice(0, 3).some((f) => f.kind === 'force_push' || f.kind === 'exfiltration_shape'));
  assert.ok(r.findings.every((f) => !/[\u2013\u2014]/.test(f.sentence)));
});

test('immiscible scan: findings, skipped sources, and no secret or prompt in any format', async () => {
  const { home } = fleetHome();
  const cwd = tmp('imm-scan-cwd-');
  const text = await runCli(['scan', '--html', 'report.html'], { cwd, home });
  assert.equal(text.code, 11, text.stderr);
  assert.match(text.stdout, /Read on this machine only/);
  const lead = text.stdout.split('\n').filter((l) => /^ {2}[123] {2}/.test(l));
  assert.equal(lead.length, 3);
  assert.match(lead[0], /the shape of a secret leaving the machine/);
  assert.match(text.stdout, /force pushed twice/);
  assert.match(text.stdout, /Gemini CLI\s+no ~\/\.gemini\/tmp here/);
  assert.match(text.stdout, /Cursor is here, but keeps its history in an undocumented database/);
  assert.match(text.stdout, /SessionStart hook in ~\/work\/hollis-agents\/\.claude\/settings\.json runs node setup\.mjs/);

  const json = await runCli(['scan', '--json'], { cwd, home });
  assert.equal(json.code, 11);
  assert.equal(json.json.ok, true);
  assert.equal(json.json.local, true);
  assert.equal(json.json.sources.find((s) => s.agent === 'gemini-cli').status, 'absent');
  assert.equal(json.json.totals.sessions, 3);

  const html = readFileSync(path.join(cwd, 'report.html'), 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script|https?:\/\/(?!www\.w3\.org)/i, 'self-contained: no script, no remote resource');
  assert.match(html, new RegExp(BRAND.coral));

  for (const [name, out] of [['text', text.stdout + text.stderr], ['json', json.stdout], ['html', html]]) {
    assert.ok(!out.includes(SENTINEL), `${name} output holds the sentinel secret`);
    assert.ok(!out.includes('SENTINEL'), `${name} output holds part of the sentinel`);
    assert.ok(!out.includes(PROMPT_SENTINEL), `${name} output holds prompt text`);
    assert.ok(!out.includes('Authorization'), `${name} output holds a command string`);
  }
});

test('immiscible scan with no agent history says so and exits 0', async () => {
  const home = tmp('imm-scan-empty-');
  const r = await runCli(['scan', '--json'], { cwd: home, home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.totals.sessions, 0);
  assert.ok(r.json.sources.every((s) => s.status === 'absent' && s.note));
  const t = await runCli(['scan'], { cwd: home, home });
  assert.match(t.stdout, /No coding agent sessions in this window/);
  const bad = await runCli(['scan', '--since', 'whenever'], { cwd: home, home });
  assert.equal(bad.code, 2);
});

test('1,000 sessions scan in under 5 seconds', async () => {
  const home = manySessions(1000);
  const t0 = Date.now();
  const r = await runCli(['scan', '--json'], { cwd: home, home });
  const ms = Date.now() - t0;
  assert.equal(r.json?.totals.sessions, 1000, r.stderr);
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test('the copied price table and brand tokens match the server', { skip: !inRepo && 'outside the repository' }, async () => {
  const catalog = await import(new URL('../../../src/core/catalog.js', import.meta.url));
  for (const [id, [inp, cached, out]] of Object.entries(PRICES)) {
    const m = catalog.pricedModel(id);
    assert.ok(m?.price, `${id} is in the server's table`);
    assert.deepEqual([m.price.inputPerMTok, m.price.cachedInputPerMTok ?? m.price.inputPerMTok, m.price.outputPerMTok], [inp, cached, out], id);
  }
  const brandFile = fileURLToPath(new URL('../../../brand.config.json', import.meta.url));
  assert.ok(existsSync(brandFile));
  const brand = JSON.parse(readFileSync(brandFile, 'utf8'));
  for (const k of ['paper', 'paperRaised', 'ink', 'inkSoft', 'muted', 'line', 'field', 'coral']) assert.equal(BRAND[k], brand.colors[k], k);
  assert.equal(BRAND.mark, brand.logo.svg);
});

test('scan: secrets the agents\' own history holds are found by kind and counted once, never shown', async () => {
  const { secretsIn } = await import('../src/history/secrets.mjs');
  const aws = 'AKIAIOSFODNN7EXAMPLE';
  const ghp = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const text = `{"content":"AWS_ACCESS_KEY_ID=${aws}\\nGH=${ghp}"} and again ${aws} -----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----`;
  const found = secretsIn(text);
  assert.deepEqual(found.map((f) => f.id).sort(), ['aws', 'github', 'private_key']);
  assert.ok(found.every((f) => /^sha256:[0-9a-f]{12}$/.test(f.fingerprint)));
  assert.ok(!JSON.stringify(found).includes(aws) && !JSON.stringify(found).includes(ghp), 'no value is returned');
  assert.deepEqual(secretsIn('sk_test_ is a prefix, AKIA is a word, ghp_short'), [], 'prefixes alone are not secrets');

  const { analyse } = await import('../src/history/analyse.mjs');
  const r = analyse({
    since: 0, until: Date.now(), sessions: [], sources: [],
    transcriptSecrets: [
      { agent: 'claude-code', file: '/h/.claude/projects/-repo/a.jsonl', secrets: found },
      { agent: 'codex', file: '/h/.codex/sessions/2026/10/10/r.jsonl', secrets: [found[0]] },
    ],
  });
  assert.equal(r.transcripts.distinct, 3, 'one key in two files is one secret');
  assert.equal(r.transcripts.files, 2);
  const f = r.findings.find((x) => x.kind === 'secrets_in_transcripts');
  assert.equal(f.severity, 'high');
  assert.match(f.sentence, /hold 3 secrets in plain text \(.+\), in 2 files anything running as you can read\. Rotate them\.$/);
  for (const k of ['an AWS access key', 'a GitHub token', 'a private key']) assert.ok(f.sentence.includes(k), k);
  assert.ok(!JSON.stringify(r).includes('sha256:'), 'fingerprints stay out of the report');
});

test('scan: colleagues are counted from git on this machine, by company domain only', async () => {
  const { teamHint, domainOf } = await import('../src/history/team.mjs');
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const repo = mkdtempSync(path.join(tmpdir(), 'imm-team-'));
  const g = (args, email = 'me@acme.io') => spawnSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_NAME: 'x', GIT_COMMITTER_NAME: 'x' } });
  g(['init', '-q']);
  g(['config', 'user.email', 'me@acme.io']);
  for (const e of ['me@acme.io', 'sam@acme.io', 'priya@acme.io', 'priya@acme.io', 'dependabot[bot]@acme.io', 'ext@other.com']) g(['commit', '-q', '--allow-empty', '-m', 'x'], e);
  assert.deepEqual(teamHint([repo], { cwd: repo }), { domain: 'acme.io', colleagues: 2, repositories: 1 });
  g(['config', 'user.email', 'me@gmail.com']);
  assert.equal(teamHint([repo], { cwd: repo }), null, 'a personal address is not a company');
  assert.equal(domainOf('Sam <sam@Acme.IO>'), 'acme.io');
});
