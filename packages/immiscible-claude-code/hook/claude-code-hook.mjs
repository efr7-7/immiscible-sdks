#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: ask Immiscible before a tool call runs.
 *
 * Claude Code runs this command before each matching tool call, with the
 * call as JSON on stdin. The script sends it to POST /v1/actions/authorize as
 * an action of type `tool.call`, with a one-line summary (the tool name and
 * its input), the target domain where there is one, and provenance taken
 * from the session itself, then prints the decision in the form Claude Code
 * understands:
 *
 *   allow              -> no output, exit 0 (Claude Code's own permission settings then
 *                         decide, exactly as if the hook were not there)
 *   deny               -> "deny"   (the call is refused, and the model sees why)
 *   approval_required  -> "ask"    (Claude Code asks you, with the reasons and the approval link)
 *
 * A read-only call (ls, git status, reading a file) is decided like any
 * other and recorded; the agent's rule says whether it needs a person
 * (readOnly in the rule; the default Claude Code rules let it go ahead).
 *
 * It sends the project the call runs in (CLAUDE_PROJECT_DIR, or the working
 * directory) and the working directory. The default rules let edits, test
 * runs and builds go ahead once the agent is past its intern stage, and only
 * inside that project; anything that names a path outside it asks a person.
 *
 * An MCP tool (mcp__<server>__<tool>) names its server as its destination,
 * mcp:<server>, so a rule decides which MCP servers the agent may use: list
 * mcp:<server> (or mcp:*) in the rule's domains. It is never treated as a
 * local call.
 *
 * Provenance comes from the client, not the model: if the session transcript
 * shows a web fetch, a web search or an MCP tool result earlier on, the
 * request says so, and Immiscible treats the session as carrying untrusted input.
 *
 * It also sends Claude Code's session id. When the same session's model
 * traffic goes through the Immiscible gateway (ANTHROPIC_BASE_URL), Immiscible has
 * seen every tool result that entered the context, and compares that with
 * the provenance declared here: the transcript scan can miss what fell out
 * of its last 2 MB, the gateway cannot.
 *
 * It fails closed. If Immiscible cannot be reached, answers with an error, or does
 * not answer inside the timeout, the call is refused. Claude Code blocks a
 * call only when a hook exits with code 2, so the command ends in
 * `|| exit 2`: a missing file, a missing node or a crash blocks the call
 * too. If you need to work offline, remove the hook; do not teach it to
 * allow on error.
 *
 * Environment:
 *   IMMISCIBLE_MODE         local: decide on this machine with the rules below
 *                           (scripts/local-policy.mjs), no account and no network;
 *                           a call that needs a person becomes Claude Code's own
 *                           permission prompt. Set by `immiscible guard`.
 *   IMMISCIBLE_URL          your Immiscible base URL (default https://immiscible.ai, the hosted service)
 *   IMMISCIBLE_AGENT_KEY    an agent key, from Agents in the console
 *   IMMISCIBLE_TIMEOUT_MS   how long to wait for a decision (default 10000, at most 50000,
 *                           so the hook answers before Claude Code's own 60 second limit)
 * Each is also read under its older ASSAY_ name when the new one is unset.
 *
 * ~/.claude/settings.json, or .claude/settings.json for one project:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|mcp__(?!immiscible__(check_action_status|explain_decision|spend_summary|find_waste|unwatched_keys)$).*",
 *           "hooks": [ { "type": "command", "command": "node ~/.immiscible/claude-code-hook.mjs || exit 2", "timeout": 60 } ]
 *         }
 *       ]
 *     }
 *   }
 *
 * `node claude-code-hook.mjs --self-test` checks the file runs here, sending
 * nothing (see selfTest below).
 *
 * One file, no dependencies, Node 22.
 */

import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

const env = (name) => process.env[`IMMISCIBLE_${name}`] || process.env[`ASSAY_${name}`] || '';
const BASE = (env('URL') || 'https://immiscible.ai').replace(/\/$/, '');
const KEY = env('AGENT_KEY');
/** Below Claude Code's hook timeout (60 s in the settings below), so the refusal is ours, not a timeout. */
const MAX_TIMEOUT_MS = 50_000;
const TIMEOUT_MS = Math.min(Number(env('TIMEOUT_MS')) || 10_000, MAX_TIMEOUT_MS);
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

function out(decision, reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  })}\n`);
  process.exit(0);
}

const refuse = (reason) => out('deny', `Immiscible hook (failing closed): ${reason}`);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** The longest command sent whole; a longer one is cut here and marked [cut]. */
const CUT_AT = 289;

function hostOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** One line a person can read, plus where the call goes, if anywhere. */
function describe(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'Bash') {
    const url = /\bhttps?:\/\/[^\s'"<>|;)]+/i.exec(String(i.command ?? ''))?.[0];
    // A line break separates commands, as ; does. Shown as ; so the summary
    // never reads as one harmless command when it is two.
    const cmd = clip(String(i.command ?? '').replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ; '), Infinity);
    // A command too long to send whole is cut and marked, and Immiscible
    // never lets a cut command go ahead on its own: the end is what it cannot see.
    // full: the whole command, for the local rules, which send nothing and so need not cut it.
    return { summary: `Bash: ${cmd.length > CUT_AT ? `${cmd.slice(0, CUT_AT)} [cut]` : cmd}`, full: `Bash: ${cmd}`, domain: url ? hostOf(url) : null };
  }
  if (tool === 'WebFetch') return { summary: `WebFetch: ${clip(i.url, 250)}`, domain: hostOf(i.url) };
  if (tool === 'WebSearch') return { summary: `WebSearch: ${clip(i.query, 250)}`, domain: null };
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read'].includes(tool)) {
    return { summary: `${tool}: ${clip(i.file_path ?? i.notebook_path, 250)}`, domain: null };
  }
  // An MCP tool's destination is its server: mcp__github__create_issue goes to mcp:github.
  const mcp = /^mcp__([A-Za-z0-9_-]+?)__/.exec(tool);
  if (mcp) return { summary: `${tool}: ${clip(JSON.stringify(i), 250)}`, domain: null, recipient: `mcp:${mcp[1].toLowerCase()}` };
  const url = typeof i.url === 'string' ? i.url : null;
  return { summary: `${tool}: ${clip(JSON.stringify(i), 250)}`, domain: url ? hostOf(url) : null };
}

/**
 * What influenced this session, read from Claude Code's own transcript
 * (the last 2 MB of it). Web fetches and searches bring in web content; MCP
 * tools bring in third-party tool output.
 */
function sessionProvenance(transcriptPath, tool) {
  const prov = [{ source: 'agent', detail: `Claude Code ${tool} call` }];
  if (typeof transcriptPath !== 'string' || !transcriptPath) return prov;
  let text = '';
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return prov;
  }
  if (/"name"\s*:\s*"(WebFetch|WebSearch)"/.test(text)) prov.push({ source: 'web', detail: 'the session fetched or searched the web' });
  if (/"name"\s*:\s*"mcp__/.test(text)) prov.push({ source: 'tool', detail: 'the session used MCP tool output' });
  return prov;
}

/**
 * The project the call runs in: Claude Code's CLAUDE_PROJECT_DIR, or the
 * working directory it reports, and that working directory. Immiscible lets
 * an edit or a test run go ahead (when the rule says so) only inside it.
 */
function project(event) {
  const abs = (x) => (typeof x === 'string' && x.startsWith('/') ? x.slice(0, 1024) : null);
  const cwd = abs(event.cwd);
  const dir = abs(process.env.CLAUDE_PROJECT_DIR) ?? cwd;
  return dir ? { dir, cwd: cwd ?? dir } : null;
}

// >>> immiscible local policy (generated from scripts/local-policy.mjs; edit it there and run node scripts/sync-local-policy.mjs)
const LP_SECRET = /(^|[\s"'=:/(@<])(\.env(\.[\w.-]+)?|[\w.-]*\.pem|[\w.-]*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|credentials\.json|service-account[\w.-]*\.json|\.aws\/credentials|\.aws\/config|\.ssh\/[\w.-]+|\.config\/gh\/hosts\.yml|\.docker\/config\.json|\.kube\/config)(?=$|[\s"'`;|&)>])/i;
const LP_PUBLIC_KEY = /\.pub(?=$|[\s"'`;|&)>])/i;
const LP_NETWORK = /(^|[\s;|&(`$])(curl|wget|nc|ncat|netcat|socat|scp|sftp|rsync|ftp|telnet|ssh|http|https|xh|aria2c|invoke-webrequest|invoke-restmethod|iwr|irm)(?=$|[\s;|&)])/i;
const LP_UPLOAD = /(^|[\s;|&(`$])(gh\s+(gist|repo|release|issue|pr)\s+(create|upload|comment|edit)|git\s+push)(?=$|[\s;|&)])/i;
const LP_CONFIG_FILE = /(^|[/\s])(\.claude\/settings(\.local)?\.json|\.claude\.json|\.codex\/(config|requirements)\.toml|\.codex\/hooks\.json|\.cursor\/(hooks|mcp)\.json|\.gemini\/settings\.json|\.codeium\/windsurf\/(hooks|mcp_config)\.json|\.factory\/(hooks|settings)\.json|\.?opencode\/plugins\/[^/\s]+|\.?opencode\.jsonc?|\.?amp\/plugins\/[^/\s]+|amp\/settings\.json|\.mcp\.json|\.vscode\/(tasks|settings|mcp)\.json|\.(bash|zsh)rc|\.(bash_)?profile|\.zprofile|\.github\/workflows\/[\w.-]+\.ya?ml)$/i;
/**
 * An agent changing its own guard: guard --off, --pause, --connect or --url, and install with --url or the
 * http transport, by any spelling a shell would run (quotes, backslashes, variables, case, xargs). Read on the
 * line with quotes and backslashes taken out, so a near miss is refused rather than allowed.
 */
function lpGuardSelf(c) {
  const line = String(c).replace(/["'\\]/g, '').toLowerCase();
  if (!/immiscible/.test(line) && !/\$\{?\w+\}?\s+guard\b/.test(line)) return false;
  if (/\bguard\b/.test(line) && /(^|\s)--(off|pause|connect|url|key)\b/.test(line)) return true;
  return /\binstall\b/.test(line) && /(^|\s)--(url|transport|key)\b/.test(line);
}

/** Commands that delete or overwrite files in a working tree: the guard takes a checkpoint first, so they can be undone. */
const LP_DESTRUCTIVE = /(^|[;|&(]\s*)(sudo\s+)?(xargs\s+(-\S+\s+)*)?((\\|\/(usr\/)?bin\/)?rm\s|rmdir\s|unlink\s|shred\s|truncate\s|mv\s|sed\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*i|find\s[^;|&]*\s-delete\b|rsync\s[^;|&]*--delete|git\s+(clean\s|reset\s+--hard|checkout\s+(--\s|\.\s*($|[;|&]))|restore\s|stash\s+(drop|clear)\b|rm\s))/;
/** Paths a checkpoint never copies and undo never removes: secrets stay out of git objects. */
const LP_CHECKPOINT_SKIP = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc', '.pgpass', '.git-credentials', 'credentials.json', 'service-account*.json'];
const LP_RULES = [
  // Refused: almost never meant, and not undone by a person afterwards.
  { id: 'guard_self', decision: 'deny', test: (c) => lpGuardSelf(c), reason: 'an agent cannot switch off, pause or redirect the guard that checks it; only you can, from your own terminal' },
  { id: 'force_push_protected', decision: 'deny', test: (c) => /\bgit\b[^;|&]*\bpush\b(?=[^;|&]*(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+[\w./-]+))(?=[^;|&]*[\s:+](main|master|release\/[\w.-]+|production|prod)\b)/.test(c), reason: 'a force push to a protected branch (main, master, release or production) rewrites history other people have', suggest: (c) => c.replace(/\s(?:--force(?:-with-lease)?(?:=\S*)?|-[a-zA-Z]*f[a-zA-Z]*)(?=\s|$)|(?<=\s)\+(?=[\w./-])/g, (m) => (/^\s-[a-zA-Z]*f/.test(m) && m.trim() !== '-f' ? m.replace('f', '') : '')).replace(/\s{2,}/g, ' ').trim() },
  { id: 'rm_root_or_home', decision: 'deny', test: (c) => /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/|\$HOME\/\*|"\$HOME"|\.\.\/\.\.)(\s|$|;)/.test(c), reason: 'rm -r of the root, home or a parent directory deletes far more than a project' },
  { id: 'disk_wipe', decision: 'deny', test: (c) => /\b(mkfs(\.\w+)?|diskutil\s+(erase\w*|zeroDisk|secureErase))\b|\bdd\b[^;|&]*\bof=\/dev\//.test(c), reason: 'formatting or overwriting a disk' },
  { id: 'secret_off_machine', decision: 'deny', test: (c) => LP_SECRET.test(c) && !LP_PUBLIC_KEY.test(c) && (LP_NETWORK.test(c) || LP_UPLOAD.test(c)), reason: 'a secret file and a network or upload command in the same call: that is how keys leave a machine' },
  { id: 'shell_rc_backdoor', decision: 'deny', test: (c) => />>?\s*~?\/?[\w./]*\.(bash|zsh)rc\b/.test(c) && /\b(curl|wget|nc|base64|eval|shutdown|reboot)\b/.test(c), reason: 'adding a network, eval or shutdown command to a shell start-up file' },
  // Asked: fine when meant, and a person should be the one who means it.
  { id: 'pipe_to_shell', decision: 'ask', test: (c) => /\b(curl|wget|iwr|irm|invoke-webrequest)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(iex|invoke-expression)\b/i.test(c), reason: 'running a script straight from the internet' },
  { id: 'force_push', decision: 'ask', test: (c) => /\bgit\b[^;|&]*\bpush\b[^;|&]*(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+[\w./-]+)/.test(c), reason: 'a force push rewrites a branch' },
  { id: 'publish', decision: 'ask', test: (c) => /\b(npm|pnpm|bun)\s+publish\b|\byarn\s+(npm\s+)?publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgem\s+push\b|\bpoetry\s+publish\b|\bdocker\s+(push|buildx\s+build[^;|&]*--push)\b|\bgh\s+release\s+create\b/.test(c), reason: 'publishing a package or image other people will install' },
  { id: 'infrastructure', decision: 'ask', test: (c) => /\bterraform\s+(apply|destroy|import|state\s+(rm|mv))\b|\bpulumi\s+(up|destroy)\b|\bkubectl\s+(apply|delete|scale|rollout|drain|cordon|replace|patch|exec)\b|\bhelm\s+(install|upgrade|uninstall|rollback)\b|\b(aws|gcloud|az)\s+\S+\s+(delete|terminate|remove|destroy)[\w-]*\b|\bfly\s+(deploy|destroy|apps\s+destroy)\b|\bvercel\s+(--prod|deploy\s+--prod)\b/.test(c), reason: 'changing live infrastructure' },
  { id: 'database_destructive', decision: 'ask', test: (c) => /\b(drop\s+(table|database|schema)|truncate\s+table)\b|\bprisma\s+migrate\s+reset\b|\brails\s+db:(drop|reset)\b/i.test(c), reason: 'dropping or emptying a database' },
  { id: 'history_rewrite', decision: 'ask', test: (c) => /\bgit\s+(reset\s+--hard\s+\S*(origin|upstream)\/|clean\s+-[a-zA-Z]*f[a-zA-Z]*d|branch\s+-D\s+(main|master)\b|filter-(branch|repo)\b)/.test(c), reason: 'throwing away work git cannot give back' },
  { id: 'guard_records', decision: 'ask', test: (c) => /\.immiscible(\/|\b)|\bpause\.json\b|\bteam-rules\.json\b|\bguard(-managed)?\.json\b/i.test(c.replace(/["'\\]/g, '')), reason: "touching Immiscible's own records (~/.immiscible), which the guard reads to decide" },
  { id: 'sudo', decision: 'ask', test: (c) => /(^|[;|&(]\s*)sudo\s/.test(c), reason: 'a command as the administrator' },
  { id: 'world_writable', decision: 'ask', test: (c) => /\bchmod\s+(-R\s+)?(0?777|a\+w|o\+w)\b/.test(c), reason: 'making files writable by everyone' },
];

/**
 * Whether a checkpoint could put this call's harm back: 'files' when it deletes
 * or overwrites files in a working tree, 'none' when it was asked and reaches
 * past the machine (a publish, a deploy, the network), null otherwise.
 */
function lpUndoable(tool, body, decision, rule) {
  if (decision === 'deny') return null;
  // git clean -x deletes ignored files, which a checkpoint never holds.
  if (tool === 'Bash' && /\bgit\s+clean\s+-[a-zA-Z]*x/.test(body)) return decision === 'ask' ? 'none' : null;
  if (rule === 'agent_config' || rule === 'history_rewrite' || (tool === 'Bash' && LP_DESTRUCTIVE.test(body))) return 'files';
  return decision === 'ask' ? 'none' : null;
}

/**
 * Decide one tool call locally. summary: the hook's one-line summary.
 * state: { secretRead: string | null } for this session. Returns
 * { decision, rule, reason, secretRead } where secretRead is set when this
 * call read a secret file (the hook keeps it for the rest of the session).
 */
function localDecide(summary, state = {}, team = null) {
  // Longer than the rules read: a person decides, since the end is what they cannot see.
  if (/^Bash:/.test(String(summary ?? '')) && String(summary).length > 20000) return { decision: 'ask', rule: 'too_long', reason: 'Immiscible guard: this command is too long to check here, so a person should read it first.', secretRead: null, undoable: 'none' };
  const base = lpBuiltIn(summary, state);
  const t = team ? lpTeamDecide(team, summary) : null;
  // The team's rules only add: a team rule can refuse or ask about more, never allow what the built-in rules stop.
  const rank = { allow: 0, ask: 1, deny: 2 };
  if (t && rank[t.decision] > rank[base.decision]) {
    const m = /^([\w.-]+):\s?([\s\S]*)$/.exec(String(summary ?? ''));
    return { decision: t.decision, rule: t.rule, reason: t.reason, secretRead: base.secretRead, undoable: lpUndoable(m ? m[1] : '', m ? m[2] : '', t.decision, t.rule) };
  }
  return base;
}

/**
 * The team's own rules (immiscible guard --team), from ~/.immiscible/team-rules.json
 * (IMMISCIBLE_TEAM_RULES names another file): commands to refuse or ask about,
 * branches nobody pushes to straight, domains nothing reaches. Data, never
 * code: a command rule is its words, matched against each command in a call.
 * Read once per hook run; a missing or broken file is "no team rules".
 */
let lpTeamCache;
async function lpTeam() {
  if (lpTeamCache !== undefined) return lpTeamCache;
  lpTeamCache = null;
  try {
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    // The machine's file (guard --team --scope managed, for everyone) and the person's own. Both apply: each
    // can only add, so a person's file never switches the machine's rules off.
    const system = process.platform === 'win32' ? join(process.env.ProgramData || 'C:\\ProgramData', 'immiscible', 'team-rules.json') : '/etc/immiscible/team-rules.json';
    const own = process.env.IMMISCIBLE_TEAM_RULES || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.immiscible', 'team-rules.json');
    const words = (x) => (Array.isArray(x?.words) && x.words.length && x.words.every((w) => typeof w === 'string' && w && w.length <= 80) ? x.words : null);
    const list = (xs) => (Array.isArray(xs) ? xs.filter((x) => words(x) && typeof x.id === 'string').slice(0, 100) : []);
    const merged = { versions: [], deny: [], ask: [], protectedBranches: [], blockedDomains: [] };
    for (const file of [system, own]) {
      let j;
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const r = j?.rules ?? {};
      if (Number.isSafeInteger(j?.version)) merged.versions.push(j.version);
      merged.deny.push(...list(r.deny));
      merged.ask.push(...list(r.ask));
      merged.protectedBranches.push(...(Array.isArray(r.protectedBranches) ? r.protectedBranches : []).filter((b) => typeof b === 'string' && /^[\w./*-]{1,100}$/.test(b)));
      merged.blockedDomains.push(...(Array.isArray(r.blockedDomains) ? r.blockedDomains : []).filter((d) => typeof d === 'string' && /^(\*\.)?[a-z0-9.-]+$/i.test(d)).map((d) => d.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')));
    }
    if (merged.versions.length || merged.deny.length || merged.ask.length || merged.protectedBranches.length || merged.blockedDomains.length) lpTeamCache = merged;
  } catch { lpTeamCache = null; }
  return lpTeamCache;
}

/** Words a shell would see in one command: quotes and backslashes taken out, quoted spaces kept. */
function lpWords(seg) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < seg.length) cur += seg[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') { q = ch; has = true; }
    else if (ch === '\\' && i + 1 < seg.length) { cur += seg[++i]; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else { cur += ch; has = true; }
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Shell keywords and wrappers that run the command after them, with how many value words their options take. */
const LP_WRAPPERS = { sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'], env: ['-u', '-C', '-S'], nice: ['-n'], ionice: ['-c', '-n'], stdbuf: ['-i', '-o', '-e'], timeout: ['-s', '-k'], xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a'], nohup: [], command: [], exec: [], builtin: [], time: [], eval: [], then: [], do: [], else: [], elif: [], if: [], while: [], until: [], '!': [] };

/** Every command a shell line runs, each as its words: through ;, &&, ||, pipes, $(...), backticks, groups, sh -c and wrappers. */
function lpCommands(body, depth = 0) {
  const text = String(body).slice(0, 20000);
  const out = [];
  const inner = [];
  // $(...) and backticks run their own commands: take them out and read them too.
  const flat = text.replace(/\$\(([^()]*)\)/g, (_, x) => { inner.push(x); return ' x '; }).replace(/`([^`]*)`/g, (_, x) => { inner.push(x); return ' x '; });
  for (const seg of flat.split(/;|&&|\|\||\||&|\n/)) {
    let w = lpWords(seg.replace(/[(){}]/g, ' '));
    for (let guard = 0; guard < 8 && w.length; guard++) {
      if (/^[A-Za-z_]\w*=/.test(w[0])) { w = w.slice(1); continue; }
      const name = w[0].replace(/^.*[\\/]/, '').toLowerCase();
      const opts = LP_WRAPPERS[name];
      if (!opts) break;
      let i = 1;
      while (i < w.length && (w[i].startsWith('-') || (name === 'env' && /^[A-Za-z_]\w*=/.test(w[i])))) i += opts.includes(w[i]) ? 2 : 1;
      // timeout's duration, then the command.
      if (name === 'timeout' && i < w.length && /^\d/.test(w[i])) i++;
      w = w.slice(i);
    }
    if (!w.length) continue;
    w[0] = w[0].replace(/^.*[\\/]/, '').toLowerCase();
    // sh -c '...', bash -lc "...": the string is the command.
    if (/^(ba|z|da|k|fi)?sh$/.test(w[0]) && depth < 3) {
      const c = w.findIndex((x) => /^-\w*c\w*$/.test(x));
      if (c >= 0 && w[c + 1] != null) { out.push(...lpCommands(w[c + 1], depth + 1)); continue; }
    }
    out.push(w);
  }
  if (depth < 3) for (const x of inner) out.push(...lpCommands(x, depth + 1));
  return out;
}

const lpGlob = (pattern, name) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name);

/** A host from a word: a URL, user@host:path, or a bare domain with or without a path. */
function lpHostOf(word) {
  const w = String(word);
  if (/^[a-z][\w+.-]*:\/\//i.test(w)) { try { return new URL(w).hostname.toLowerCase().replace(/\.$/, '') || null; } catch { return null; } }
  const m = /^(?:[^@/\s]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,63})\.?(?:[:/]|$)/i.exec(w);
  return m ? m[1].toLowerCase() : null;
}
const LP_NET_PROGRAMS = /^(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|ftp|http|https|xh|aria2c|git|ping|dig|nslookup|host)$/;

/** The team's decision on one call, or null. */
function lpTeamDecide(team, summary) {
  const s = String(summary ?? '');
  const m = /^([\w.-]+):\s?([\s\S]*)$/.exec(s);
  const tool = m ? m[1] : '';
  const body = m ? m[2] : s;
  const said = (decision, id, reason) => ({ decision, rule: `team:${id}`, reason: `Immiscible guard, your team's rule: ${reason}.` });
  const cmds = tool === 'Bash' ? lpCommands(body) : [];
  // Every address the call names: URLs anywhere, and hosts given to a program that reaches the network.
  const hosts = [...body.matchAll(/\b[a-z][\w+.-]*:\/\/[^\s'"<>`)]+/gi)].map((x) => lpHostOf(x[0])).filter(Boolean);
  for (const w of cmds) if (LP_NET_PROGRAMS.test(w[0])) for (const x of w.slice(1)) { const h = x.startsWith('-') ? null : lpHostOf(x); if (h) hosts.push(h); }
  const blocked = hosts.find((h) => team.blockedDomains.some((d) => h === d || h.endsWith(`.${d}`)));
  if (blocked) return said('deny', 'blocked_domain', `nothing here reaches ${blocked}`);
  if (tool !== 'Bash') return null;
  const hit = (rule) => cmds.some((w) => w[0] === rule.words[0].toLowerCase() && rule.words.slice(1).every((x) => w.includes(x)));
  for (const r of team.deny) if (hit(r)) return said('deny', r.id, r.reason || `${r.words.join(' ')} is refused here`);
  if (team.protectedBranches.length) {
    for (const w of cmds) {
      const at = w.indexOf('push');
      if (w[0] !== 'git' || at < 0) continue;
      const args = w.slice(at + 1);
      const flags = args.filter((x) => x.startsWith('-'));
      const forcedAll = flags.some((x) => /^(--force(-with-lease)?(=.*)?|-[a-zA-Z]*f[a-zA-Z]*)$/.test(x));
      if (flags.some((x) => x === '--mirror')) return said('deny', 'protected_branch', 'a mirror push can rewrite or delete protected branches');
      const deleting = flags.some((x) => x === '--delete' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(x));
      // Positional words: the remote, then refspecs. Options that take a value are skipped with it.
      const pos = [];
      for (let i = 0; i < args.length; i++) {
        if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(args[i])) { i++; continue; }
        if (!args[i].startsWith('-')) pos.push(args[i]);
      }
      const refspecs = pos.slice(1);
      const named = (b) => team.protectedBranches.find((p) => lpGlob(p, b.replace(/^refs\/heads\//, '')));
      if (flags.includes('--all') || flags.includes('--branches')) {
        const p = team.protectedBranches[0];
        if (forcedAll) return said('deny', 'protected_branch', `a forced push of every branch includes ${p}`);
        return said('ask', 'protected_branch', `pushing every branch includes ${p}, which is protected`);
      }
      if (!refspecs.length) {
        // No refspec: the current branch, when the hook could tell it.
        const cur = team.currentBranch ? named(team.currentBranch) : null;
        if (cur) return forcedAll ? said('deny', 'protected_branch', `${team.currentBranch} is protected, so it is never force pushed`) : said('ask', 'protected_branch', `${team.currentBranch} is protected: changes reach it through review, not a push`);
        continue;
      }
      for (const spec of refspecs) {
        const forced = forcedAll || spec.startsWith('+');
        const raw = spec.replace(/^\+/, '');
        const colon = raw.indexOf(':');
        const src = colon >= 0 ? raw.slice(0, colon) : raw;
        let dst = colon >= 0 ? raw.slice(colon + 1) : raw;
        if (colon < 0 && dst === 'HEAD') dst = team.currentBranch ?? 'HEAD';
        const b = named(dst);
        if (!b) continue;
        const branch = dst.replace(/^refs\/heads\//, '');
        if (deleting || (colon >= 0 && !src)) return said('deny', 'protected_branch', `${branch} is protected, so it is never deleted`);
        if (forced) return said('deny', 'protected_branch', `${branch} is protected, so it is never force pushed`);
        return said('ask', 'protected_branch', `${branch} is protected: changes reach it through review, not a push`);
      }
    }
  }
  for (const r of team.ask) if (hit(r)) return said('ask', r.id, r.reason || `${r.words.join(' ')} needs a person here`);
  return null;
}

/** Asks a pause never softens: the guard's own records, agent configuration, a secret then the network, a command too long to read. */
const LP_NOT_PAUSED = new Set(['guard_records', 'agent_config', 'secret_then_network', 'too_long']);

/**
 * Until when the person paused the guard (ms), from ~/.immiscible/pause.json, or 0.
 * A pause longer than two hours is treated as two hours from when it was set.
 */
async function lpPausedUntil(managed = false) {
  try {
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    // A machine with a managed guard takes a pause only from the administrator's file, which agents cannot write.
    const system = process.platform === 'win32' ? join(process.env.ProgramData || 'C:\\ProgramData', 'immiscible', 'pause.json') : '/etc/immiscible/pause.json';
    const file = managed ? system : join(home, '.immiscible', 'pause.json');
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = Date.parse(p.at);
    const until = Date.parse(p.until);
    const now = Date.now();
    if (!Number.isFinite(at) || !Number.isFinite(until)) return 0;
    // Set now, not in the future, for no more than two hours, and not rewritten since it was set.
    if (at > now + 60_000 || until - at > 2 * 3_600_000) return 0;
    if (fs.statSync(file).mtimeMs > at + 60_000) return 0;
    return until;
  } catch { return 0; }
}

/** The built-in rules alone. */
function lpBuiltIn(summary, state = {}) {
  const s = String(summary ?? '');
  const m = /^([\w.-]+):\s?([\s\S]*)$/.exec(s);
  const tool = m ? m[1] : '';
  const body = m ? m[2] : s;
  const said = (decision, rule, reason, secretRead = null) => ({ decision, rule, reason, secretRead, undoable: lpUndoable(tool, body, decision, rule) });
  if (tool === 'Bash' || tool === 'PowerShell') {
    for (const r of LP_RULES) {
      if (!r.test(body)) continue;
      // Redirect decisions: a refused command may have a safer form; it is suggested, never run for the agent.
      const safer = r.suggest ? r.suggest(body) : null;
      const offer = safer && safer !== body && !LP_RULES.some((x) => x.decision === 'deny' && x.test(safer)) ? ` Try instead: ${safer}` : '';
      return { ...said(r.decision, r.id, `Immiscible guard: ${r.reason}.${offer}`), ...(offer ? { suggestion: safer } : {}) };
    }
    const secret = LP_SECRET.exec(body);
    const readsSecret = secret && !LP_PUBLIC_KEY.test(body) ? secret[2] : null;
    if (state.secretRead && (LP_NETWORK.test(body) || LP_UPLOAD.test(body))) {
      return said('ask', 'secret_then_network', `Immiscible guard: this session read ${state.secretRead} earlier, and this command reaches the network. A person should check nothing secret leaves.`, readsSecret);
    }
    return said('allow', null, null, readsSecret);
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const file = body.trim();
    if (/(^|\/)\.immiscible\//.test(file)) return said('ask', 'guard_records', `Immiscible guard: ${file} is one of Immiscible's own records, which the guard reads to decide.`);
    if (LP_CONFIG_FILE.test(file)) return said('ask', 'agent_config', `Immiscible guard: ${file} decides what coding agents and shells run on their own; changes to it are how a hook or a backdoor gets in.`);
    return said('allow', null, null);
  }
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    const secret = LP_SECRET.exec(` ${body}`);
    return said('allow', null, null, secret && !LP_PUBLIC_KEY.test(body) ? secret[2] : null);
  }
  if (tool === 'WebFetch' || tool === 'WebSearch' || /^mcp__/.test(tool)) {
    if (state.secretRead && tool !== 'WebSearch') return said('ask', 'secret_then_network', `Immiscible guard: this session read ${state.secretRead} earlier, and this call reaches outside the machine. A person should check nothing secret leaves.`);
    return said('allow', null, null);
  }
  return said('allow', null, null);
}
/**
 * The session's local state: whether it has read a secret file. Kept in
 * ~/.immiscible/state (IMMISCIBLE_STATE_DIR in tests) under a hash of the
 * agent and session id, holding the path's short form only, never contents;
 * a secret read counts for a day, and files untouched for 7 days are swept.
 * Any failure is "no state", never a crash.
 */
async function lpState(client, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return { state: {}, save: async () => {} };
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const dir = process.env.IMMISCIBLE_STATE_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.immiscible', 'state');
  const file = join(dir, `${createHash('sha256').update(`${client}:${sessionId}`).digest('hex').slice(0, 24)}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { state = {}; }
  const save = async (next) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ ...next, at: Date.now() }), { mode: 0o600 });
      for (const f of fs.readdirSync(dir)) {
        const p = join(dir, f);
        if (f.endsWith('.json') && Date.now() - fs.statSync(p).mtimeMs > 7 * 86_400_000) fs.rmSync(p, { force: true });
      }
    } catch { /* state is a help, never a reason to fail */ }
  };
  return { state, save };
}

/**
 * Credentials replaced before anything is written to the decision log or a
 * checkpoint's message: by their published shapes, after a name that says
 * what they are (GITHUB_TOKEN=, PGPASSWORD=, --password, a URL's user:pass@,
 * Bearer), and any value that looks random (a long run of letters and digits
 * together). The CLI's redactSecrets is the same; a test keeps them equal.
 */
const LP_REDACT = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)|(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])|(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}|(?<![A-Za-z0-9])gh[pousr]_[0-9A-Za-z]{36,}|(?<![A-Za-z0-9])github_pat_[0-9A-Za-z_]{60,}|(?<![A-Za-z0-9])sk-[0-9A-Za-z_-]{20,}|(?<![A-Za-z0-9])xox[abprs]-[0-9A-Za-z-]{20,}|(?<![A-Za-z0-9])npm_[0-9A-Za-z]{36}|(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}|((?<![A-Za-z0-9])[A-Za-z0-9_]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_]*\s*[=:]\s*["']?)[^\s'"&]{6,}|((?:^|\s)--?(?:token|password|passwd|secret|api-key|key)(?:\s+|=)["']?)[^\s'"&-][^\s'"&]{5,}|(\bBearer\s+)[0-9A-Za-z._~+\/-]{16,}=*|(:\/\/[^\s:\/@]+:)[^\s@\/]+(?=@)/gi;
const LP_LOOSE = /[A-Za-z0-9_+.-]{16,}=*/g;
const lpLooksRandom = (t) => !/^[0-9a-f-]+$/i.test(t) && t.split(/[-_.]/).some((p) => p.length >= 16 && /[A-Za-z]/.test(p) && /\d/.test(p));
function lpRedact(s) {
  return String(s ?? '')
    .replace(LP_REDACT, (m, _end, kv, flag, bearer, url) => (kv ? `${kv}[redacted]` : flag ? `${flag}[redacted]` : bearer ? `${bearer}[redacted]` : url ? `${url}[redacted]` : '[redacted]'))
    .replace(LP_LOOSE, (t) => (lpLooksRandom(t) ? '[redacted]' : t));
}

/**
 * The flight recorder's local half: every decision a local hook makes is
 * appended to ~/.immiscible/decisions/<YYYY-MM-DD>.jsonl, each line holding the
 * hash of the one before, so a removed or edited line shows. Commands are
 * cut to 300 characters with credentials redacted, and the directory the call
 * ran in is kept; `immiscible replay` reads it beside the agents' own history,
 * and `immiscible scan` reads it for agents whose own history it cannot.
 * Never fails the call.
 */
async function lpLog(client, sessionId, summary, d, dir = null) {
  try {
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const { createHash } = await import('node:crypto');
    const logDir = process.env.IMMISCIBLE_LOG_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.immiscible', 'decisions');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const now = new Date();
    const file = join(logDir, `${now.toISOString().slice(0, 10)}.jsonl`);
    let prev = null;
    try {
      const text = fs.readFileSync(file, 'utf8').trimEnd();
      prev = JSON.parse(text.slice(text.lastIndexOf('\n') + 1)).hash ?? null;
    } catch { prev = null; }
    const entry = { at: now.toISOString(), client, session: typeof sessionId === 'string' ? sessionId.slice(0, 128) : null, summary: lpRedact(summary).slice(0, 300), decision: d.decision, rule: d.rule, reason: d.reason, ...(typeof dir === 'string' && dir ? { dir: dir.slice(0, 300) } : {}), ...(d.after ? { after: true } : {}), ...(d.checkpoint ? { checkpoint: d.checkpoint.id, repo: d.checkpoint.repo } : {}), prev };
    entry.hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch { /* the record is a help, never a reason to fail */ }
}

/**
 * Undo before approve: a checkpoint of a git working tree, taken before a call
 * that deletes or overwrites files. Tracked and untracked files (not ignored
 * ones, and never secret files such as .env or keys) are written as a commit
 * under refs/immiscible/checkpoints/<id>, with the index file itself kept as a
 * blob so staged work, conflicts and sparse checkouts come back as they were.
 * git push sends branches and tags, never this namespace (only --mirror
 * would, which is why secret files are left out); checkpoints older than 7
 * days are deleted as new ones are taken. `immiscible undo <id>` puts the
 * files back. Any failure, a large untracked tree or a directory outside a
 * repository is "no checkpoint", never a refusal.
 */
async function lpCheckpoint(dir, summary) {
  if (!dir) return null;
  try {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const ident = { GIT_AUTHOR_NAME: 'immiscible', GIT_AUTHOR_EMAIL: 'checkpoint@immiscible.invalid', GIT_COMMITTER_NAME: 'immiscible', GIT_COMMITTER_EMAIL: 'checkpoint@immiscible.invalid' };
    const git = (args, extra = {}) => {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...ident, ...extra }, stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    const root = git(['rev-parse', '--show-toplevel']);
    if (!root) return null;
    const untracked = git(['ls-files', '-o', '--exclude-standard', '-z', '--', ':/']);
    if (untracked == null || untracked.split('\0').length > 5000) return null;
    const indexFile = git(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const tmp = join(tmpdir(), `immiscible-index-${process.pid}-${Date.now()}`);
    let tree = null;
    try {
      if (indexFile && fs.existsSync(indexFile)) fs.copyFileSync(indexFile, tmp);
      if (git(['add', '-A', '--', ':/', ...LP_CHECKPOINT_SKIP.map((g) => `:(exclude,glob)**/${g}`)], { GIT_INDEX_FILE: tmp }) == null) return null;
      tree = git(['write-tree'], { GIT_INDEX_FILE: tmp });
    } finally { fs.rmSync(tmp, { force: true }); }
    if (!tree) return null;
    const indexBlob = indexFile && fs.existsSync(indexFile) ? git(['hash-object', '-w', '--', indexFile]) : null;
    const head = git(['rev-parse', '-q', '--verify', 'HEAD']);
    const message = `immiscible checkpoint\n\ncommand: ${lpRedact(summary).replace(/\s+/g, ' ').slice(0, 200)}\nworktree: ${root}\n${indexBlob ? `index-file: ${indexBlob}\n` : ''}`;
    const commit = git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message]);
    if (!commit) return null;
    const id = commit.slice(0, 10);
    if (git(['update-ref', `refs/immiscible/checkpoints/${id}`, commit]) == null) return null;
    const week = Math.floor(Date.now() / 1000) - 7 * 86400;
    for (const line of (git(['for-each-ref', '--format=%(refname) %(committerdate:unix)', 'refs/immiscible/checkpoints']) ?? '').split('\n')) {
      const [ref, at] = line.split(' ');
      if (ref && Number(at) < week) git(['update-ref', '-d', ref]);
    }
    return { id, repo: root };
  } catch { return null; }
}

/**
 * Decide one call locally, keep the session's state, take a checkpoint when
 * the call could be undone, and log the decision: the one entry point the
 * hooks use. where: { dir, canAsk }: the directory the call runs in, and
 * whether this agent can ask the person (Claude Code and Cursor can).
 */
async function localGuard(client, sessionId, summary, where = {}) {
  const { state, save } = await lpState(client, sessionId);
  const fresh = state.secretRead && Date.now() - (state.secretReadAt ?? state.at ?? 0) < 86_400_000;
  let team = await lpTeam();
  // A push with no branch named goes to the current one: ask git, only when a team rule could care.
  if (team?.protectedBranches.length && where.dir && /\bgit\b[\s\S]*\bpush\b/.test(String(summary))) {
    try {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('git', ['-C', where.dir, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.status === 0 && r.stdout.trim()) team = { ...team, currentBranch: r.stdout.trim() };
    } catch { /* no branch known: a push with no refspec is judged by its words alone */ }
  }
  const d = localDecide(summary, fresh ? state : { ...state, secretRead: null }, team);
  // Paused by the person (immiscible guard --pause): what would be asked goes ahead, logged as paused. Refusals
  // stay, and so do the asks that protect the guard itself, agent configuration and secrets.
  if (d.decision === 'ask' && !LP_NOT_PAUSED.has(d.rule) && !String(d.rule ?? '').startsWith('team:') && (await lpPausedUntil(where.managed === true)) > Date.now()) {
    d.reason = `Immiscible guard is paused: ${d.reason.replace(/^Immiscible guard[^:]*: /, '')}`;
    d.rule = `paused:${d.rule}`;
    d.decision = 'allow';
  }
  if (d.secretRead && !fresh) await save({ ...state, secretRead: d.secretRead, secretReadAt: Date.now() });
  // A call put to the person at the keyboard, by an agent whose after-call hook says when it ran: kept for a
  // day in a file of its own (so the two hooks never write over each other's state), and logged as answerable.
  if (d.decision === 'ask' && where.canAsk && where.after) {
    const q = await lpState(`${client}#asked`, sessionId);
    const asked = (Array.isArray(q.state.asked) ? q.state.asked : []).filter((x) => Date.now() - (x?.at ?? 0) < 86_400_000).slice(-49);
    asked.push({ summary: lpRedact(summary).slice(0, 300), rule: d.rule ?? null, at: Date.now() });
    await q.save({ asked });
    d.after = true;
  }
  const runs = d.decision === 'allow' || (d.decision === 'ask' && where.canAsk);
  if (runs && d.undoable === 'files' && process.env.IMMISCIBLE_CHECKPOINTS !== 'off') {
    // An edit is checkpointed in the repository that holds the file, wherever the agent runs.
    const file = /^(Write|Edit|MultiEdit|NotebookEdit): (\/.+)$/.exec(String(summary ?? ''))?.[2];
    d.checkpoint = await lpCheckpoint(file ? file.slice(0, file.lastIndexOf('/')) || '/' : where.dir, summary);
    // A command that reaches past the repository (../, ~, another absolute path, git -C) is not what the checkpoint holds.
    if (d.checkpoint && !file) {
      const body = String(summary).replace(/^[\w.-]+:\s?/, '');
      const root = d.checkpoint.repo;
      const outside = /(^|[\s=])(~|\$HOME)(\/|\s|$)|(^|[\s/=])\.\.(\/|\s|$)|\bgit\s+-C\s/.test(body)
        || [...body.matchAll(/(?:^|[\s=])(\/[^\s;|&'"]*)/g)].some((m) => m[1] !== root && !m[1].startsWith(`${root}/`) && !/^\/dev\/null$/.test(m[1]));
      if (outside) d.checkpoint = { ...d.checkpoint, partial: true };
    }
  }
  if (d.decision === 'ask' && where.canAsk) {
    d.reason += d.checkpoint && !d.checkpoint.partial ? ` If you approve, it can be undone: npx immiscible undo ${d.checkpoint.id}` : ' This one cannot be undone from here.';
  }
  if (process.env.IMMISCIBLE_LOCAL_LOG !== 'off') await lpLog(client, sessionId, summary, d, where.dir);
  return d;
}
/**
 * After a call ran (Factory Droid's PostToolUse, Cursor's afterShellExecution
 * and afterMCPExecution): when the person had been asked about it, log that
 * they let it run, so scan and replay know an ask was answered yes. Anything
 * else is not logged; the log keeps decisions, not every call.
 */
async function localRan(client, sessionId, summary) {
  const { state, save } = await lpState(`${client}#asked`, sessionId);
  const asked = Array.isArray(state.asked) ? state.asked : [];
  const want = lpRedact(summary).slice(0, 300);
  const i = asked.findIndex((x) => x?.summary === want);
  if (i < 0) return false;
  const [hit] = asked.splice(i, 1);
  await save({ asked });
  if (process.env.IMMISCIBLE_LOCAL_LOG !== 'off') await lpLog(client, sessionId, summary, { decision: 'ran', rule: hit.rule ?? null, reason: 'the person let it run' });
  return true;
}

/**
 * Agent configuration integrity (Claude Code). Claude Code reloads its
 * settings files when they change mid-session and runs the ConfigChange hook
 * for each change it detects; exit 2 or {"decision":"block"} keeps the change
 * from taking effect, except for managed (policy) settings.
 * https://code.claude.com/docs/en/hooks#configchange
 *
 * At SessionStart the hook notes what the session started with: the hooks,
 * the broad permission rules, bypass mode and the MCP switches of the user,
 * project and local settings files. A change during the session that adds a
 * hook, widens permissions, turns on bypass mode or every project MCP server,
 * adds an MCP server or an apiKeyHelper, or turns hooks off is blocked: that
 * is how a planted hook (the Shai-Hulud worm's SessionStart hook) or a
 * script run by the agent gets in. Anything else goes through. A person who
 * made the change restarts Claude Code to load it.
 */
/** Immiscible's own hook, exactly as guard and init install it: a command naming one of its hook files, or the server's hook URL. */
const LP_OUR_HOOK = /^(node (--env-file-if-exists="[^"]*" )?"[^"]*(\/\.immiscible\/claude-code-hook\.mjs|\/immiscible\/claude-code-hook\.mjs|\/\.claude\/hooks\/immiscible-claude-code-hook\.mjs)" \|\| exit 2|https?:\/\/\S+\/v1\/hooks\/claude-code)$/;
/** Settings keys that hold a command Claude Code runs, and environment variables that change what runs or where traffic goes. */
const LP_HELPERS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'statusLine', 'fileSuggestion'];
const LP_RISKY_ENV = ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'PATH', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'IMMISCIBLE_MODE', 'IMMISCIBLE_URL', 'IMMISCIBLE_LOCAL_LOG', 'IMMISCIBLE_CHECKPOINTS'];
/**
 * The facts of one settings file that matter here. Hook commands are kept as
 * a hash beside the event and the program's name, never their arguments, and
 * helper commands and risky environment values only as hashes, so a token on
 * a command line is not copied into the state or the log.
 */
async function lpConfigFacts(settings) {
  const { createHash } = await import('node:crypto');
  const o = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const hooks = [];
  let ours = false;
  for (const [event, list] of Object.entries(o.hooks && typeof o.hooks === 'object' ? o.hooks : {})) {
    for (const e of Array.isArray(list) ? list : []) {
      for (const h of Array.isArray(e?.hooks) ? e.hooks : []) {
        const what = String(typeof h?.command === 'string' ? h.command : typeof h?.url === 'string' ? h.url : JSON.stringify(h ?? null));
        if (LP_OUR_HOOK.test(what)) { ours = true; continue; }
        const program = typeof h?.command === 'string' ? (what.trim().split(/\s+/)[0] ?? '').replace(/^.*\//, '').slice(0, 40) : h?.type === 'http' ? 'an http hook' : (h?.type ?? 'a hook');
        hooks.push(`${event} ${program} ${createHash('sha256').update(`${event}\n${what}`).digest('hex').slice(0, 16)}`);
      }
    }
  }
  const p = o.permissions && typeof o.permissions === 'object' ? o.permissions : {};
  // An allow rule that lets anything run or be written: an interpreter, a shell, network tools, any file.
  const broad = (r) => typeof r === 'string' && /^(\*|Bash|Write|Edit|MultiEdit|WebFetch|mcp__.*|Bash\((\*|:\*|(sudo|bash|sh|zsh|fish|dash|node|python\d*(\.\d+)?|ruby|perl|php|deno|bun|npx|pnpx|bunx|eval|exec|env|xargs|curl|wget|nc|ssh|scp|rm|git push|chmod|dd)\b[^)]*)\)|(Write|Edit|MultiEdit|Read)\((\*|\*\*|\/\*\*|~\/\*\*|\/\/\*\*)\))$/.test(r.trim());
  const hash = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
  const helpers = {};
  for (const k of LP_HELPERS) if (o[k] != null) helpers[k] = hash(o[k]);
  const env = {};
  const e = o.env && typeof o.env === 'object' ? o.env : {};
  for (const k of LP_RISKY_ENV) if (e[k] != null) env[k] = hash(e[k]);
  const plugins = Object.entries(o.enabledPlugins && typeof o.enabledPlugins === 'object' ? o.enabledPlugins : {}).filter(([, on]) => on).map(([k]) => k.slice(0, 120));
  const markets = Object.keys(o.extraKnownMarketplaces && typeof o.extraKnownMarketplaces === 'object' ? o.extraKnownMarketplaces : {}).map((k) => k.slice(0, 120));
  return {
    hooks,
    ours,
    allow: (Array.isArray(p.allow) ? p.allow : []).filter(broad).map((r) => r.trim().slice(0, 80)),
    bypass: p.defaultMode === 'bypassPermissions' || o.defaultMode === 'bypassPermissions',
    hooksOff: o.disableAllHooks === true,
    allMcp: o.enableAllProjectMcpServers === true,
    mcp: Array.isArray(o.enabledMcpjsonServers) ? o.enabledMcpjsonServers.filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)) : [],
    helpers,
    env,
    plugins,
    markets,
  };
}

/** What a change adds that a session should not pick up mid-way: plain phrases, empty when nothing. */
function lpConfigRisks(before, after) {
  const out = [];
  const added = (k) => after[k].filter((x) => !before[k].includes(x));
  for (const h of added('hooks')) {
    const [event, program] = h.split(' ');
    out.push(`adds a ${event} hook that runs ${program}`);
  }
  if (before.ours && !after.ours) out.push("removes Immiscible's hook");
  if (after.hooksOff && !before.hooksOff) out.push('turns every hook off');
  for (const r of added('allow')) out.push(`allows ${r} without asking`);
  if (after.bypass && !before.bypass) out.push('turns on bypass permissions');
  if (after.allMcp && !before.allMcp) out.push("turns on every project's MCP servers");
  for (const m of added('mcp')) out.push(`turns on the MCP server ${m}`);
  for (const [k, v] of Object.entries(after.helpers ?? {})) if ((before.helpers ?? {})[k] !== v) out.push(`sets the ${k} command`);
  for (const [k, v] of Object.entries(after.env ?? {})) if ((before.env ?? {})[k] !== v) out.push(`changes ${k}`);
  for (const k of Object.keys(before.env ?? {})) if (/^IMMISCIBLE_/.test(k) && !(k in (after.env ?? {}))) out.push(`removes ${k}`);
  for (const x of after.plugins ?? []) if (!(before.plugins ?? []).includes(x)) out.push(`turns on the plugin ${x}`);
  for (const x of after.markets ?? []) if (!(before.markets ?? []).includes(x)) out.push(`adds the plugin marketplace ${x}`);
  return out;
}

/** The settings files a source names, as Claude Code lays them out. */
function lpSettingsFiles(cwd, home) {
  return {
    user_settings: `${home}/.claude/settings.json`,
    project_settings: cwd ? `${cwd}/.claude/settings.json` : null,
    local_settings: cwd ? `${cwd}/.claude/settings.local.json` : null,
  };
}

/**
 * SessionStart and ConfigChange for Claude Code in local mode. Returns
 * { block: reason } to keep a change out, or {} to let it through; never
 * throws. The session's starting point is kept in its local state.
 */
async function localConfigGuard(event) {
  try {
    const fs = await import('node:fs');
    const { homedir } = await import('node:os');
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    const cwd = typeof event.cwd === 'string' && event.cwd.startsWith('/') ? event.cwd : null;
    const files = lpSettingsFiles(process.env.CLAUDE_PROJECT_DIR || cwd, home);
    const factsOf = async (file) => {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? lpConfigFacts({}) : null; }
      try { return lpConfigFacts(JSON.parse(text)); } catch { return null; }
    };
    const { state, save } = await lpState('claude-code', event.session_id);
    if (event.hook_event_name === 'SessionStart') {
      const config = {};
      for (const [source, file] of Object.entries(files)) if (file) config[source] = { file, facts: (await factsOf(file)) ?? (await lpConfigFacts({})) };
      await save({ ...state, config });
      // A project hook seen for the first time is named once: SessionStart cannot stop it, but a person can look.
      const project = config.project_settings?.facts?.hooks ?? [];
      const local = config.local_settings?.facts?.hooks ?? [];
      const knownFile = `${home}/.immiscible/known-hooks.json`;
      let known = [];
      try { known = JSON.parse(fs.readFileSync(knownFile, 'utf8')); } catch { known = []; }
      const fresh = [...project, ...local].filter((h) => !known.includes(h));
      if (!fresh.length) return {};
      try {
        fs.mkdirSync(`${home}/.immiscible`, { recursive: true, mode: 0o700 });
        fs.writeFileSync(knownFile, JSON.stringify([...known, ...fresh].slice(-2000)), { mode: 0o600 });
      } catch { /* a warning repeated next time is fine */ }
      const [event0, program0] = fresh[0].split(' ');
      return { warn: `Immiscible guard: this project's .claude settings run ${fresh.length === 1 ? `a ${event0} hook (${program0})` : `${fresh.length} hooks, among them a ${event0} hook (${program0})`} that ${fresh.length === 1 ? 'is' : 'are'} not Immiscible's and new to this machine. Planted hooks spread this way; check .claude/settings.json, or run npx immiscible scan.` };
    }
    const source = typeof event.source === 'string' ? event.source : null;
    if (source === 'policy_settings' || source === 'skills') return {};
    const file = typeof event.file_path === 'string' && event.file_path ? event.file_path : files[source] ?? null;
    if (!file) return {};
    const key = Object.keys(files).find((k) => files[k] === file) ?? source ?? file;
    const now = await factsOf(file);
    if (!now) return {}; // not JSON: Claude Code cannot load it either
    const start = state.config?.[key]?.facts ?? null;
    // No starting point (the guard arrived mid-session, or the records were removed): judge the file as it stands.
    const risks = lpConfigRisks(start ?? (await lpConfigFacts({})), now);
    const short = file.startsWith(home) ? `~${file.slice(home.length)}` : file;
    const d = risks.length
      ? { decision: 'deny', rule: 'config_change', reason: `Immiscible guard: ${short} changed during this session, and the change ${risks.slice(0, 3).join('; ')}. It is kept out of this session: that is how a planted hook gets in. If you made the change, restart Claude Code to load it.` }
      : { decision: 'allow', rule: null, reason: null };
    if (!risks.length) await save({ ...state, config: { ...state.config, [key]: { file, facts: now } } });
    if (process.env.IMMISCIBLE_LOCAL_LOG !== 'off') await lpLog('claude-code', event.session_id, `ConfigChange: ${short}`, d);
    return risks.length ? { block: d.reason } : {};
  } catch { return {}; }
}
// <<< immiscible local policy

/**
 * Where this hook file is installed, for the coverage report: managed (the
 * machine's managed settings, which people cannot override), user
 * (~/.immiscible, from immiscible install or guard) or project
 * (.claude/hooks, from immiscible init). Read from the file's own path.
 */
function installScope() {
  const at = decodeURIComponent(new URL(import.meta.url).pathname).replace(/\\/g, '/');
  if (/\/(ClaudeCode|claude-code)\/immiscible\/claude-code-hook\.mjs$/.test(at)) return 'managed';
  if (/\/\.immiscible\/claude-code-hook\.mjs$/.test(at)) return 'user';
  if (/\/\.claude\/hooks\/immiscible-claude-code-hook\.mjs$/.test(at)) return 'project';
  return 'unknown';
}

async function main() {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return refuse('could not read the tool call from Claude Code.');
  }
  if (event.hook_event_name === 'SessionStart' || event.hook_event_name === 'ConfigChange') {
    // Configuration integrity: only in local mode, which installs these two events.
    const r = env('MODE') === 'local' ? await localConfigGuard(event) : {};
    if (r.block) process.stdout.write(`${JSON.stringify({ decision: 'block', reason: r.block })}\n`);
    else if (r.warn) process.stdout.write(`${JSON.stringify({ systemMessage: r.warn })}\n`);
    process.exit(0);
  }
  const tool = clip(event.tool_name ?? 'unknown', 120);
  const { summary, full, domain, recipient } = describe(tool, event.tool_input);
  if (env('MODE') === 'local') {
    // immiscible guard: decided here, with nothing sent anywhere, on the whole command.
    const d = await localGuard('claude-code', event.session_id, full ?? summary, { dir: project(event)?.cwd ?? null, canAsk: true, managed: installScope() === 'managed' });
    if (d.decision === 'deny') return out('deny', `${d.reason} Refused on this machine; to allow it, run it yourself.`);
    if (d.decision === 'ask') return out('ask', `${d.reason} Approve here, or connect a phone with: npx immiscible guard --connect`);
    process.exit(0);
  }
  if (!KEY) return refuse('IMMISCIBLE_AGENT_KEY is not set, so this tool call cannot be checked.');
  const body = {
    type: 'tool.call',
    summary,
    ...(domain ? { target: { domain } } : recipient ? { target: { recipient } } : {}),
    provenance: sessionProvenance(event.transcript_path, tool),
    ...(project(event) ? { project: project(event) } : {}),
    ...(typeof event.session_id === 'string' && /^[!-~]{1,128}$/.test(event.session_id) ? { session: { client: 'claude-code', id: event.session_id } } : {}),
    ...(typeof event.tool_use_id === 'string' && event.tool_use_id ? { idempotencyKey: event.tool_use_id.slice(0, 128) } : {}),
    hook: { transport: 'command', scope: installScope() },
  };
  let res;
  let json;
  try {
    res = await fetch(`${BASE}/v1/actions/authorize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = null; }
  } catch (err) {
    return refuse(err?.name === 'TimeoutError' ? `no answer from Immiscible within ${TIMEOUT_MS}ms.` : `Immiscible could not be reached (${err.message}).`);
  }
  if (!res.ok) return refuse(json?.error?.message ?? `Immiscible answered ${res.status}.`);
  if (!json) return refuse(`Immiscible answered ${res.status} with something that is not a decision.`);
  // Each reason is a clause without a full stop; joined with semicolons so the model reads them apart.
  const clauses = (json.reasons ?? []).map((r) => String(r).trim().replace(/\.$/, '')).filter(Boolean);
  const reasons = clauses.length ? `${clauses.join('; ')}.` : '';
  // Allow prints nothing: Claude Code's own permission settings still apply,
  // as if the hook were not there. (An explicit "allow" would skip them.)
  if (json.decision === 'allow') process.exit(0);
  if (json.decision === 'approval_required') {
    return out('ask', `Immiscible asks for a person: ${reasons}${json.approval?.url ? ` Approve or deny at ${json.approval.url}` : ''}`);
  }
  if (json.decision === 'deny') {
    // Redirect decisions: a refusal may carry a safer form of the command the rules allow.
    const sg = json.suggestion;
    if (sg?.kind === 'command' && typeof sg.command === 'string' && tool === 'Bash') {
      // Only when the server saw the whole command (not cut) and the rule says redirect: run the safer form instead.
      if (sg.redirect === true && sg.decision === 'allow' && summary === `Bash: ${String(event.tool_input?.command ?? '').trim()}`) {
        process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `Immiscible ran the safer form instead: ${sg.command}. ${reasons}`, updatedInput: { ...event.tool_input, command: sg.command } } })}\n`);
        process.exit(0);
      }
      return out('deny', `Immiscible refused: ${reasons} Try instead: ${sg.command}`);
    }
    if (sg?.kind === 'payment') return out('deny', `Immiscible refused: ${reasons} The rule would allow up to ${sg.amount} (minor units, ${sg.currency}).`);
    return out('deny', `Immiscible refused: ${reasons}`);
  }
  return refuse('Immiscible returned no decision.');
}

/**
 * node claude-code-hook.mjs --self-test: proves this file runs here (the
 * installer calls it after copying the hook). It reads a made-up tool call,
 * builds the request it would send, and prints one JSON line; it sends
 * nothing and exits 0. It says whether IMMISCIBLE_AGENT_KEY is set, without
 * showing it.
 */
function selfTest() {
  const major = Number(process.versions.node.split('.')[0]);
  const { summary } = describe('Bash', { command: 'git status' });
  const ok = major >= 22 && summary === 'Bash: git status';
  const mode = env('MODE') === 'local' ? 'local' : 'server';
  process.stdout.write(`${JSON.stringify({ ok, node: process.versions.node, url: BASE, mode, agentKey: KEY ? 'set' : 'missing', sample: summary })}\n`);
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--self-test')) selfTest();
else main().catch((err) => refuse(err.message));
