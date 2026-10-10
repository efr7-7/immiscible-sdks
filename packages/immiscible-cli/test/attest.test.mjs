/**
 * immiscible attest: the branch's own sessions and decisions, never another
 * branch's; counts and rule names, never a command; posted once and then
 * updated on the pull request; signed by the workspace and checked offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmp, runCli, bootServer, person, mintToken, inRepo } from './helpers.mjs';
import { claudeSession } from './history-fixtures.mjs';
import { verifyAttestation, markdown, judgeAttestation, MARKER, ATTEST_TYP } from '../src/commands/attest.mjs';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';

/** A key set and a signer, as a server would have. */
function issuerKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'EdDSA' };
  const signJws = (claims) => {
    const input = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'k1', typ: ATTEST_TYP })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${input}.${edSign(null, Buffer.from(input), privateKey).toString('base64url')}`;
  };
  return { jwks: { keys: [jwk] }, signJws };
}

const projectDirName = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const g = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });

/** Decisions as the hooks write them: one file a day, each line holding the hash of the one before. */
function logDecisions(dir, entries) {
  mkdirSync(dir, { recursive: true });
  const byDay = new Map();
  for (const e of entries.sort((a, b) => a.at - b.at)) {
    const day = new Date(e.at).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  for (const [day, list] of byDay) {
    let prev = null;
    for (const x of list) {
      const e = { at: new Date(x.at).toISOString(), client: x.client, session: x.session, summary: x.summary, decision: x.decision, rule: x.rule, reason: 'r', dir: x.dir, prev };
      e.hash = createHash('sha256').update(JSON.stringify(e)).digest('hex');
      prev = e.hash;
      appendFileSync(path.join(dir, `${day}.jsonl`), `${JSON.stringify(e)}\n`);
    }
  }
}

function setup() {
  const now = Date.now();
  const h = tmp('imm-attest-');
  const repo = path.join(h, 'work', 'payments-api');
  mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  g(repo, 'switch', '-q', '-c', 'feature/refunds');
  g(repo, 'commit', '-q', '--allow-empty', '-m', 'refunds');
  const cdir = path.join(h, '.claude', 'projects', projectDirName(repo));
  mkdirSync(cdir, { recursive: true });
  const calls = [{ name: 'Bash', input: { command: 'npm test -- --secret-flag' } }];
  // c1 on this branch, started before the branch existed; c2 on another branch.
  writeFileSync(path.join(cdir, 'c1.jsonl'), claudeSession({ id: 'c1', cwd: repo, branch: 'feature/refunds', at: now - 3_600_000, calls }));
  writeFileSync(path.join(cdir, 'c2.jsonl'), claudeSession({ id: 'c2', cwd: repo, branch: 'other', at: now - 1_800_000, calls }));
  logDecisions(path.join(h, '.immiscible', 'decisions'), [
    { at: now - 3_590_000, client: 'claude-code', session: 'c1', summary: 'Bash: npm test -- --secret-flag', decision: 'allow', rule: 'none', dir: repo },
    { at: now - 3_580_000, client: 'claude-code', session: 'c1', summary: 'Bash: git push --force origin main', decision: 'deny', rule: 'force_push', dir: repo },
    { at: now - 1_790_000, client: 'claude-code', session: 'c2', summary: 'Bash: rm -rf ~', decision: 'deny', rule: 'rm_home', dir: repo },
    { at: now + 2_000, client: 'cursor', session: 'k1', summary: 'Bash: npm run lint', decision: 'allow', rule: 'none', dir: repo },
    { at: now + 3_000, client: 'cursor', session: 'k1', summary: 'Bash: npm publish', decision: 'ask', rule: 'publish', dir: repo },
    { at: now + 4_000, client: 'cursor', session: 'k9', summary: 'Bash: ls', decision: 'allow', rule: 'none', dir: path.join(h, 'elsewhere') },
  ]);
  return { h, repo };
}

test('attest: this branch only, counts and rule names, never a command', async () => {
  const { h, repo } = setup();
  const r = await runCli(['attest', '--json', '--out', 'stmt.json'], { cwd: repo, home: h });
  assert.equal(r.code, 0, r.stderr);
  const s = r.json.statement;
  assert.equal(s._type, 'https://in-toto.io/Statement/v1');
  assert.equal(s.predicateType, 'https://immiscible.ai/attestation/coding-agents/v1');
  assert.equal(s.subject[0].digest.gitCommit, g(repo, 'rev-parse', 'HEAD').stdout.trim());
  assert.match(s.subject[0].name, /@feature\/refunds$/);
  const p = s.predicate;
  assert.equal(p.commits, 1);
  assert.equal(p.base.ref, 'main');
  const claude = p.agents.find((a) => a.agent === 'claude-code');
  assert.equal(claude.sessions, 1, 'the other branch\'s session is left out');
  assert.equal(claude.decisions, 2);
  assert.ok(claude.costMicros > 0);
  const cursor = p.agents.find((a) => a.agent === 'cursor');
  assert.equal(cursor.sessions, 1, 'a session in another folder is left out');
  assert.deepEqual([p.guard.allowed, p.guard.asked, p.guard.refused], [2, 1, 1]);
  assert.deepEqual(p.guard.rules.map((x) => x.rule).sort(), ['force_push', 'publish']);
  assert.ok(!p.guard.rules.some((x) => x.rule === 'rm_home'), 'another branch\'s refusal is not this one\'s');
  assert.equal(p.log.verifies, true);
  assert.ok(p.log.days.every((d) => /^[0-9a-f]{64}$/.test(d.head)));
  const text = JSON.stringify(r.json);
  for (const leak of ['npm test', 'secret-flag', 'git push', 'npm publish', repo]) assert.ok(!text.includes(leak), `no ${leak} in the statement or comment`);
  assert.deepEqual(JSON.parse(readFileSync(path.join(repo, 'stmt.json'), 'utf8')), s);
  assert.ok(r.json.markdown.startsWith(MARKER));
  assert.match(r.json.markdown, /\| Claude Code \| 1 \| 2 \|/);
  assert.match(r.json.markdown, /1 refused \(`force_push` 1\)/);
});

test('attest: an unguarded agent is named; a broken log is said', () => {
  const md = markdown({
    _type: 'x', subject: [{ name: 'r@b', digest: { gitCommit: 'a'.repeat(40) } }], predicateType: 'y',
    predicate: { generator: { version: '0.3.0' }, base: { ref: 'main' }, commits: 2, agents: [{ agent: 'codex', sessions: 2, decisions: 0, costMicros: 1_200_000, unpriced: false, models: [] }], guard: { decisions: 0, allowed: 0, asked: 0, refused: 0, paused: 0, rules: [], unguarded: ['codex'], teamRules: [] }, log: { verifies: false, days: [{ day: '2026-10-10' }] }, cost: { micros: 1_200_000, unpriced: false } },
  });
  assert.match(md, /\*\*Not guarded:\*\* Codex/);
  assert.match(md, /does not verify/);
  assert.match(md, /\| Codex \| 2 \| none logged \| \$1\.20 \|/);
});

test('attest: refuses where there is no branch to describe', async () => {
  const { h, repo } = setup();
  g(repo, 'switch', '-q', 'main');
  const onMain = await runCli(['attest'], { cwd: repo, home: h });
  assert.equal(onMain.code, 2);
  assert.match(onMain.stderr + onMain.stdout, /the branch others are measured from/);
  const none = await runCli(['attest'], { cwd: h, home: h });
  assert.equal(none.code, 2);
  assert.match(none.stderr + none.stdout, /not a git repository/);
});

test('attest --comment: posted once, then the same comment updated', async () => {
  const { h, repo } = setup();
  const bin = path.join(h, 'bin');
  mkdirSync(bin);
  const calls = path.join(h, 'gh-calls');
  const state = path.join(h, 'gh-posted');
  // A stand-in for gh: one pull request; the comment list holds ours once it is posted.
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "$*" >> ${calls}
case "$1 $2" in
  "pr view") echo '{"number":7,"url":"https://github.com/example/payments-api/pull/7"}' ;;
  "api user") echo 'dev' ;;
  "pr comment") cat > /dev/null; touch ${state} ;;
  "api --paginate") if [ -f ${state} ]; then echo '{"id":11,"login":"someone","mine":false}'; echo '{"id":42,"login":"dev","mine":true}'; else echo '{"id":11,"login":"someone","mine":false}'; fi ;;
  "api --method") cat > ${h}/patched ;;
esac
`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const first = await runCli(['attest', '--comment', '--json'], { cwd: repo, home: h, env });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.json.comment, { url: 'https://github.com/example/payments-api/pull/7', updated: false });
  const second = await runCli(['attest', '--comment', '--json'], { cwd: repo, home: h, env });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.comment.updated, true);
  assert.match(readFileSync(calls, 'utf8'), /api --method PATCH repos\/\{owner\}\/\{repo\}\/issues\/comments\/42 /, 'our comment, not someone else\'s');
  assert.ok(JSON.parse(readFileSync(path.join(h, 'patched'), 'utf8')).body.startsWith(MARKER));
});

test('attest --sign: the workspace signs exactly the statement; verify checks it and catches a change', { skip: inRepo ? false : 'not inside the Immiscible repository', timeout: 120_000 }, async (t) => {
  const s = await bootServer();
  t.after(s.stop);
  const owner = await person(s.base);
  const token = await mintToken(s.base, owner);
  const { h, repo } = setup();
  const r = await runCli(['--url', s.base, 'attest', '--sign', '--json'], { cwd: repo, home: h, env: { IMMISCIBLE_TOKEN: token } });
  assert.equal(r.code, 0, r.stderr);
  const jwt = r.json.signed.token;
  assert.equal(r.json.signed.workspace, owner.wid);
  assert.match(r.json.markdown, /immiscible verify/);
  const keys = await (await fetch(`${s.base}/.well-known/immiscible-keys.json`)).json();
  const v = verifyAttestation(jwt, keys, { issuer: null });
  assert.equal(v.valid, true, v.message);
  assert.deepEqual(v.claims.stm, r.json.statement);
  assert.ok(!JSON.stringify(v.claims).includes(owner.email ?? '@'), 'the member is a pseudonym');
  const ok = await runCli(['--url', s.base, 'verify', jwt, '--json'], { cwd: h, home: h });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json.kind, 'attestation');
  // One count changed: the signature no longer holds.
  const [hd, body, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  claims.stm.predicate.guard.refused = 0;
  const forged = `${hd}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
  const bad = await runCli(['--url', s.base, 'verify', forged, '--json'], { cwd: h, home: h });
  assert.equal(bad.code, 12);
  assert.equal(bad.json.reason, 'bad_signature');
  // In CI: the pull request's comment, checked against the server's keys and the head commit.
  const bin = path.join(h, 'ci-bin');
  mkdirSync(bin);
  writeFileSync(path.join(h, 'comments.jsonl'), `${JSON.stringify('LGTM')}\n${JSON.stringify(r.json.markdown)}\n`);
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncat ${path.join(h, 'comments.jsonl')}\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const event = path.join(h, 'event.json');
  const ci = async (sha, extra = []) => {
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha } } }));
    return runCli(['--url', s.base, 'attest', '--check', '--json', ...extra], { cwd: repo, home: h, env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_PATH: event, IMMISCIBLE_TOKEN: token } });
  };
  const current = await ci(r.json.statement.subject[0].digest.gitCommit);
  assert.equal(current.code, 0, current.stdout + current.stderr);
  assert.equal(current.json.state, 'current');
  assert.equal(current.json.workspace, owner.wid);
  const stale = await ci('f'.repeat(40));
  assert.equal(stale.json.state, 'stale');
  assert.equal(stale.code, 0, 'stale is a warning');
  assert.equal((await ci('f'.repeat(40), ['--strict'])).code, 11, 'and a failure with --strict');

  // The server refuses what is not a statement.
  const junk = await fetch(`${s.base}/v1/cli/attest`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ statement: { _type: 'x' } }) });
  assert.equal(junk.status, 400);
});

test('attest --check: none, unsigned, stale, current, and findings for an unguarded agent or a broken log', () => {
  const { jwks, signJws } = issuerKeys();
  const head = 'd'.repeat(40);
  const stmt = (commit, extra = {}) => ({
    _type: 'https://in-toto.io/Statement/v1', subject: [{ name: 'r@b', digest: { gitCommit: commit } }], predicateType: 'https://immiscible.ai/attestation/coding-agents/v1',
    predicate: { generator: { version: '0.3.0' }, base: { ref: 'main' }, commits: 1, agents: [], guard: { decisions: 0, allowed: 0, asked: 0, refused: 0, paused: 0, rules: [], unguarded: [], teamRules: [], ...extra.guard }, log: { verifies: true, days: [], ...extra.log }, cost: { micros: 0, unpriced: false } },
  });
  const body = (s, iss = 'https://imm.example') => markdown(s, { token: signJws({ iss, sub: 'w1', iat: 1, jti: 'j', stm: s }) });
  const judge = (bodies, o = {}) => judgeAttestation({ bodies, jwks, issuer: 'https://imm.example', headSha: head, ...o });
  assert.equal(judge(['LGTM']).state, 'none');
  assert.equal(judge([markdown(stmt(head))]).state, 'unsigned');
  assert.equal(judge([body(stmt('e'.repeat(40)))]).state, 'stale');
  assert.equal(judge([body(stmt('e'.repeat(40))), body(stmt(head))]).state, 'current');
  assert.equal(judge([body(stmt(head))], { workspaceId: 'w2' }).state, 'invalid', 'another workspace\'s attestation does not count');
  assert.equal(judge([body(stmt(head), 'https://other.example')]).state, 'invalid');
  const tampered = body(stmt(head)).replace(/(immiscible:token [^.]+\.)([^.]+)/, (_, a, b) => a + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), sub: 'w9' })).toString('base64url'));
  assert.equal(judge([tampered]).state, 'invalid');
  const risky = judge([body(stmt(head, { guard: { unguarded: ['codex'] }, log: { verifies: false } }))]);
  assert.equal(risky.state, 'current');
  assert.deepEqual(risky.findings, ['Codex ran on this branch with no guard', 'the decision log did not verify on the machine that wrote the attestation']);
});
