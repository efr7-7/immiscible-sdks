/**
 * The parts that need no server: arguments, .env merging, the settings
 * merge and its diff, detection, and the hook copy staying in step with
 * the repository's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.mjs';
import { planEnv, parseEnv, envIgnored } from '../src/dotenv.mjs';
import { planSettings, diffLines, compactDiff, HOOK_COMMAND, MATCHER, isOurs } from '../src/claude.mjs';
import { detectProject, defaultAgentName } from '../src/detect.mjs';
import { snippetFor } from '../src/snippets.mjs';
import { matchPurpose } from '../src/commands/init.mjs';
import { resolveContext, normaliseUrl, DEFAULT_URL } from '../src/config.mjs';
import { tmp, fixture } from './helpers.mjs';

test('args: flags, short flags, values, and unknown flags refused', () => {
  const a = parseArgs(['init', '-y', '--name=Invoice agent', '--purpose', 'other', '--json']);
  assert.equal(a.command, 'init');
  assert.deepEqual(a.flags, { yes: true, name: 'Invoice agent', purpose: 'other', json: true });
  assert.throws(() => parseArgs(['init', '--yse']), /unknown flag --yse/);
  assert.throws(() => parseArgs(['init', '--name']), /needs a value/);
  assert.throws(() => parseArgs(['init', '--json=1']), /takes no value/);
});

test('env: adds, keeps, never replaces unasked, and replaces only what it is told', () => {
  const cur = '# mine\nOPENAI_API_KEY=sk-1\nIMMISCIBLE_URL=https://a.example\n';
  const p = planEnv(cur, { IMMISCIBLE_URL: 'https://a.example', IMMISCIBLE_AGENT_KEY: 'ask_1' });
  assert.deepEqual(p.added, ['IMMISCIBLE_AGENT_KEY']);
  assert.deepEqual(p.kept, ['IMMISCIBLE_URL']);
  assert.ok(p.text.startsWith(cur));
  assert.equal(parseEnv(p.text).IMMISCIBLE_AGENT_KEY, 'ask_1');
  const c = planEnv(cur, { IMMISCIBLE_URL: 'https://b.example' });
  assert.equal(c.changed, false);
  assert.deepEqual(c.conflicts, [{ name: 'IMMISCIBLE_URL', current: 'https://a.example', wanted: 'https://b.example' }]);
  const r = planEnv(cur, { IMMISCIBLE_URL: 'https://b.example' }, { replace: ['IMMISCIBLE_URL'] });
  assert.equal(parseEnv(r.text).IMMISCIBLE_URL, 'https://b.example');
  assert.equal(parseEnv(r.text).OPENAI_API_KEY, 'sk-1');
  assert.equal(planEnv(p.text, { IMMISCIBLE_URL: 'https://a.example', IMMISCIBLE_AGENT_KEY: 'ask_1' }).changed, false, 'the second run changes nothing');
  assert.equal(parseEnv('export A="x y" # c\nB=\'q\'\n#C=1').A, 'x y');
  assert.equal(envIgnored('node_modules\n.env\n'), true);
  assert.equal(envIgnored('node_modules\n'), false);
  assert.equal(envIgnored('.env\n!.env\n'), false);
  assert.equal(envIgnored(null), null);
});

test('settings: our entry is added once, kept beside yours, and replaced in place when old', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  const fresh = planSettings(file);
  assert.equal(fresh.state, 'added');
  const s = JSON.parse(fresh.after);
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 60 }] }]);
  writeFileSync(file, fresh.after);
  assert.equal(planSettings(file).changed, false, 'a second run leaves it');
  // An older entry of ours, with a narrow matcher and no || exit 2, beside a hook of yours in the same entry.
  writeFileSync(file, JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.immiscible/claude-code-hook.mjs' }, { type: 'command', command: 'echo mine' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/immiscible-claude-code-hook.mjs || exit 2' }] }] } }, null, 4));
  const up = planSettings(file);
  assert.equal(up.state, 'updated');
  const after = JSON.parse(up.after);
  assert.equal(after.model, 'x');
  assert.equal(after.hooks.PreToolUse.length, 1, 'the duplicate is gone');
  assert.equal(after.hooks.PreToolUse[0].matcher, MATCHER);
  assert.deepEqual(after.hooks.PreToolUse[0].hooks.map((h) => h.command), [HOOK_COMMAND, 'echo mine']);
  assert.match(up.after, /^\{\n {4}"model"/, 'the file keeps its indentation');
  writeFileSync(file, '{ not json');
  assert.equal(planSettings(file).state, 'unparseable');
  assert.ok(isOurs(HOOK_COMMAND));
  assert.ok(!isOurs('node ./scripts/format.mjs'));
});

test('diff: only what changed, with context', () => {
  const d = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual(d, ['  a', '- b', '+ B', '  c', '+ d']);
  const long = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const c = compactDiff(diffLines(long, long.replace('l10', 'X')));
  assert.ok(c.includes('  ...'));
  assert.ok(c.includes('- l10') && c.includes('+ X'));
  assert.ok(c.length < 12);
});

test('detect: the three fixture projects, and the rest of the matrix', () => {
  const node = detectProject(fixture('node-openai'));
  assert.deepEqual(node.languages, ['node']);
  assert.equal(node.primary.id, 'openai');
  assert.equal(defaultAgentName(node), 'Invoice runner agent');
  const py = detectProject(fixture('python-anthropic'));
  assert.equal(py.primary.id, 'anthropic');
  assert.equal(py.primary.lang, 'python');
  const cc = detectProject(fixture('claude-code'));
  assert.equal(cc.claudeCode.present, true);
  assert.equal(cc.primary, null);
  assert.equal(snippetFor(cc).id, 'claude-code');
  assert.match(defaultAgentName(cc), /^Claude Code in /);

  const dir = tmp();
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@openai/agents': '1', openai: '5', ai: '5', 'x402-fetch': '1' }, devDependencies: { '@modelcontextprotocol/sdk': '1' } }));
  mkdirSync(path.join(dir, '.cursor'));
  writeFileSync(path.join(dir, '.cursor', 'mcp.json'), '{}');
  const many = detectProject(dir);
  assert.equal(many.primary.id, 'openai-agents', 'the agent framework wins over the plain SDK');
  assert.deepEqual(many.wallets.map((w) => w.package), ['x402-fetch']);
  assert.deepEqual(many.mcp.map((m) => m.package ?? m.file), ['@modelcontextprotocol/sdk', '.cursor/mcp.json']);
  assert.equal(snippetFor(many).id, 'node:openai-agents');

  const poetry = tmp();
  writeFileSync(path.join(poetry, 'pyproject.toml'), '[tool.poetry.dependencies]\npython = "^3.11"\nlangchain-core = "^0.3"\n\n[tool.other]\nx = 1\n');
  assert.equal(detectProject(poetry).primary.id, 'langchain');
});

test('purposes: ids, labels and spellings all match', () => {
  const p = [{ id: 'pays_invoices', label: 'Pays invoices' }, { id: 'other', label: 'Something else' }];
  assert.equal(matchPurpose('pays-invoices', p), 'pays_invoices');
  assert.equal(matchPurpose('Pays invoices', p), 'pays_invoices');
  assert.equal(matchPurpose('something else', p), 'other');
  assert.equal(matchPurpose('juggling', p), null);
});

test('config: the server comes from the flag, the environment, .env, the file, then the default', () => {
  const home = tmp();
  const dir = tmp();
  const env = { HOME: home };
  assert.equal(resolveContext({ env, dir }).url, DEFAULT_URL);
  writeFileSync(path.join(dir, '.env'), 'IMMISCIBLE_URL=https://dotenv.example/\n');
  assert.equal(resolveContext({ env, dir }).url, 'https://dotenv.example');
  assert.equal(resolveContext({ env: { ...env, IMMISCIBLE_URL: 'https://env.example' }, dir }).url, 'https://env.example');
  assert.equal(resolveContext({ flags: { url: 'http://localhost:8787' }, env, dir }).urlFrom, '--url');
  assert.equal(normaliseUrl('ftp://x'), null);
  assert.equal(resolveContext({ env: { ...env, IMMISCIBLE_TOKEN: 'imc_x' }, dir }).tokenFrom, 'IMMISCIBLE_TOKEN');
});

test('hook: the copy in this package is the repository\'s hook, byte for byte', () => {
  const repo = fileURLToPath(new URL('../../../scripts/claude-code-hook.mjs', import.meta.url));
  if (!existsSync(repo)) return;
  assert.equal(readFileSync(new URL('../hook/claude-code-hook.mjs', import.meta.url), 'utf8'), readFileSync(repo, 'utf8'), 'run npm run sync in packages/immiscible-cli');
});
