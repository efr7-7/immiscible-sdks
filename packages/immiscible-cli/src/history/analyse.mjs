/**
 * What the coding agents on this machine did: a pure function from the
 * sessions readers.mjs found (and the settings config.mjs read) to a report.
 * No file system, no clock, no network: everything it needs is passed in.
 *
 * The report holds command names, paths, domains, counts and costs only.
 * Command strings, prompts, file contents and secret values never enter it:
 * a command is reduced here to the programs it runs, the risky kinds it
 * matches, the secret paths it reads and the domains it reaches, and the
 * string itself is dropped.
 */

import path from 'node:path';
import { costMicros, priceId } from './prices.mjs';

export const PRIVACY = 'Read on this machine only. No prompt text, file contents or secret values are shown or stored: only paths, command names, domains and counts.';

export const AGENT_LABELS = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', cursor: 'Cursor', windsurf: 'Windsurf', 'factory-droid': 'Factory Droid', opencode: 'opencode', amp: 'Amp' });
const label = (a) => AGENT_LABELS[a] ?? a;

/* ---------------------------------------------------------------- shell commands */

/** Words and operators, honouring quotes. Operators (|, ||, &&, ;, &, newline) are their own tokens. */
export function tokenize(cmd) {
  const out = [];
  let cur = '';
  let has = false;
  let q = null;
  const s = String(cmd ?? '');
  const push = () => { if (has) out.push(cur); cur = ''; has = false; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    if (ch === ' ' || ch === '\t') { push(); continue; }
    if (ch === '\n' || ch === ';') { push(); out.push({ op: ';' }); continue; }
    if (ch === '|' || ch === '&') {
      push();
      if (s[i + 1] === ch) { out.push({ op: ch + ch }); i++; } else out.push({ op: ch });
      continue;
    }
    if (ch === '<' || ch === '>') { push(); out.push({ op: ch }); if (s[i + 1] === '>') i++; continue; }
    cur += ch; has = true;
  }
  push();
  return out;
}

const PREFIXES = new Set(['sudo', 'time', 'nohup', 'env', 'command', 'exec', 'nice', 'doas']);
const SHELLS = /^(ba|z|da|k)?sh$/;

/** The simple commands in a command line: [{ program, args, redirIn: [..] }], unwrapping bash -c. */
export function segments(cmd, depth = 0) {
  const toks = tokenize(cmd);
  const segs = [];
  let cur = [];
  let redirIn = [];
  let redirOut = [];
  let pending = null;
  const flush = () => {
    const words = cur.slice();
    // Drop leading assignments (FOO=1), wrappers (sudo, env) and the wrappers' own flags (sudo -E).
    let afterPrefix = false;
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || PREFIXES.has(words[0]) || (afterPrefix && words[0].startsWith('-')))) {
      afterPrefix = PREFIXES.has(words[0]) || (afterPrefix && words[0].startsWith('-'));
      words.shift();
    }
    if (words.length) {
      const program = path.basename(words[0]);
      const args = words.slice(1);
      const c = args.findIndex((a) => /^-\w*c$/.test(a));
      if (SHELLS.test(program) && c !== -1 && args[c + 1] != null && depth < 3) segs.push(...segments(args[c + 1], depth + 1));
      else segs.push({ program, args, redirIn, redirOut });
    }
    cur = []; redirIn = []; redirOut = [];
  };
  for (const t of toks) {
    if (typeof t === 'object') {
      if (t.op === '<' || t.op === '>') { pending = t.op; continue; }
      flush();
      continue;
    }
    if (pending) { (pending === '<' ? redirIn : redirOut).push(t); pending = null; continue; }
    cur.push(t);
  }
  flush();
  return segs;
}

const RISKY = Object.freeze({
  force_push: 'force push',
  rm_rf: 'rm -rf',
  terraform: 'terraform apply or destroy',
  kubectl: 'kubectl',
  publish: 'package publish',
});

/** The risky kind a simple command is, or null. */
export function riskyKind({ program, args }) {
  const a = args;
  if (program === 'git' && a.includes('push')) {
    if (a.some((x) => x === '--force' || x === '-f' || x.startsWith('--force-with-lease') || x === '--force-if-includes' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x) || (x.startsWith('+') && x.length > 1))) return 'force_push';
  }
  if (program === 'rm') {
    const flags = a.filter((x) => x.startsWith('-')).join(' ');
    const r = /(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags);
    const f = /(^|\s)-[a-zA-Z]*f|--force/.test(flags);
    if (r && f) return 'rm_rf';
  }
  if ((program === 'terraform' || program === 'tofu' || program === 'terragrunt') && a.some((x) => x === 'apply' || x === 'destroy')) return 'terraform';
  if (program === 'kubectl' || program === 'oc') return 'kubectl';
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program) && a.includes('publish')) return 'publish';
  if ((program === 'cargo' || program === 'poetry' || program === 'uv' || program === 'flit') && a[0] === 'publish') return 'publish';
  if (program === 'twine' && a[0] === 'upload') return 'publish';
  if (program === 'gem' && a[0] === 'push') return 'publish';
  return null;
}

/* ---------------------------------------------------------------- secrets and network */

const SECRET_PATHS = [
  /(^|[/\\])\.env$/i,
  /(^|[/\\])\.env\.(?!example$|sample$|template$|dist$|defaults?$)[\w.-]+$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|[/\\])\.aws[/\\](credentials|config)$/,
  /(^|[/\\])\.config[/\\]gcloud[/\\]/,
  /application_default_credentials\.json$/,
  /(^|[/\\])\.azure[/\\]/,
  /(^|[/\\])\.kube[/\\]config$/,
  /(^|[/\\])\.(npmrc|pypirc|netrc|git-credentials)$/,
  /(^|[/\\])\.docker[/\\]config\.json$/,
  /(^|[/\\])(credentials|secrets?)\.(json|ya?ml|toml)$/i,
  /(^|[/\\])service[-_]?account[\w.-]*\.json$/i,
];

/** Is this a path that holds secrets: .env files, keys, *.pem, cloud and registry credentials? */
export function isSecretPath(p) {
  const s = String(p ?? '').trim();
  if (!s || s.length > 512 || /^https?:/i.test(s)) return false;
  if (/\.pub$/.test(s) || /known_hosts$/.test(s)) return false;
  return SECRET_PATHS.some((rx) => rx.test(s));
}

const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'rg', 'egrep', 'fgrep', 'source', '.', 'cp', 'base64', 'xxd', 'od', 'strings', 'awk', 'sed', 'jq', 'yq', 'openssl', 'scp', 'rsync', 'curl', 'wget', 'python', 'python3', 'node', 'ruby', 'perl', 'tar', 'zip', 'gpg', 'nl', 'tac', 'bat', 'type', 'dotenv', 'export', 'xargs', 'tee', 'diff', 'git']);
const NETWORK = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'socat', 'aria2c', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const URL_RX = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>`]+/gi;

/** The host of a URL, lowercased, without credentials or port; or null. */
export function hostOf(u) {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return /^[a-z0-9.:-]{1,253}$/.test(h) ? h : null;
  } catch { return null; }
}
export const isLocal = (h) => !h || h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || h === '0.0.0.0' || h.endsWith('.local');

/** Reduce one simple command: what it reads, the hosts it reaches. */
function inspectSegment(seg) {
  const reads = [];
  const hosts = [];
  const prog = seg.program.toLowerCase();
  for (const w of [...seg.args, ...seg.redirIn]) {
    const bare = w.replace(/^@/, '').replace(/^--?[\w-]+=/, '');
    if (isSecretPath(bare) && (READERS.has(prog) || seg.redirIn.includes(w) || w.startsWith('@'))) reads.push(bare);
  }
  const reaches = NETWORK.has(prog) || (prog === 'git' && seg.args.some((a) => ['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(a)));
  if (reaches) {
    for (const w of seg.args) for (const m of w.matchAll(URL_RX)) { const h = hostOf(m[0]); if (h) hosts.push(h); }
    if (!hosts.length && prog !== 'git') {
      // curl example.com, ssh user@host, scp f host:path
      for (const w of seg.args) {
        if (w.startsWith('-')) continue;
        const m = /^(?:[^@\s/]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::[\w./~-]*)?$/.exec(w);
        if (m && !isSecretPath(w) && !/\.(json|txt|sh|py|js|mjs|md|ya?ml|toml|tar|gz|zip)$/i.test(m[1])) { hosts.push(m[1].toLowerCase()); break; }
      }
    }
  }
  return { reads, hosts, network: reaches };
}

/* ---------------------------------------------------------------- report */

const inc = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = (m, n = 10, key = 'name') => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n).map(([k, count]) => ({ [key]: k, count }));
const SAFE_PROGRAM = /^[\w.+@-]{1,40}$/;

/**
 * The report. Input:
 *   sessions  from readHistory()
 *   sources   from readHistory()
 *   config    from readConfig(): { hooks, modes }
 *   since, until  ms
 *   shown     (path) => printable path (home as ~)
 */
export function analyse({ sessions = [], sources = [], config = { hooks: [], modes: [] }, since, until, shown = (p) => p, transcriptSecrets = [], guard = null } = {}) {
  const repoOf = (s) => (s.cwd ? path.basename(s.cwd) : s.project ?? 'unknown');
  const inWindow = sessions.filter((s) => (s.endedAt ?? s.startedAt ?? until) >= since && (s.startedAt ?? since) <= until);

  const programs = new Map();
  const risky = Object.fromEntries(Object.keys(RISKY).map((k) => [k, { kind: k, label: RISKY[k], count: 0, sessions: new Set(), repos: new Set(), agents: new Set() }]));
  const secretReads = new Map(); // path to { count, agents, repos }
  const domains = new Map();
  let searches = 0;
  let networkCalls = 0;
  let filesRead = 0;
  const written = new Set();
  const exfil = [];
  const mcp = new Map();
  const rows = [];

  for (const s of inWindow) {
    const repo = repoOf(s);
    const ref = `${s.agent}:${String(s.id).slice(0, 8)}`;
    const secretsSoFar = new Set();
    const leak = { secrets: new Set(), domains: new Set() };
    let commands = 0;
    const flags = new Set();
    const noteSecret = (p) => {
      const shownPath = shown(p, s.cwd);
      const e = secretReads.get(shownPath) ?? { path: shownPath, count: 0, agents: new Set(), repos: new Set() };
      e.count++; e.agents.add(s.agent); e.repos.add(repo);
      secretReads.set(shownPath, e);
      secretsSoFar.add(shownPath);
    };
    const noteHosts = (hosts) => {
      for (const h of hosts) {
        inc(domains, h);
        if (!isLocal(h) && secretsSoFar.size) { for (const x of secretsSoFar) leak.secrets.add(x); leak.domains.add(h); }
      }
    };
    const calls = [...s.calls].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    for (const c of calls) {
      if (c.tool === 'shell') {
        commands++;
        const segs = segments(c.command);
        const hosts = [];
        let net = false;
        for (const seg of segs) {
          inc(programs, SAFE_PROGRAM.test(seg.program) ? seg.program : 'other');
          const k = riskyKind(seg);
          if (k) { const r = risky[k]; r.count++; r.sessions.add(ref); r.repos.add(repo); r.agents.add(s.agent); flags.add(k); }
          const x = inspectSegment(seg);
          for (const p of x.reads) noteSecret(p);
          if (x.network) net = true;
          hosts.push(...x.hosts);
        }
        if (net) networkCalls++;
        noteHosts(hosts);
      } else if (c.tool === 'read') {
        filesRead++;
        if (c.path && isSecretPath(c.path)) noteSecret(c.path);
      } else if (c.tool === 'write') {
        if (c.path) written.add(shown(c.path, s.cwd));
      } else if (c.tool === 'fetch') {
        networkCalls++;
        const h = hostOf(c.url);
        if (h) noteHosts([h]);
      } else if (c.tool === 'search') {
        searches++;
      } else if (c.tool === 'mcp') {
        inc(mcp, SAFE_PROGRAM.test(c.server) ? c.server : 'other');
      }
    }
    if (leak.domains.size) {
      flags.add('exfiltration_shape');
      exfil.push({ session: ref, agent: s.agent, repo, secrets: [...leak.secrets], domains: [...leak.domains] });
    }

    let cost = 0;
    let unpriced = false;
    const models = [];
    for (const [model, u] of Object.entries(s.usage ?? {})) {
      const tokens = u.input + u.cacheRead + u.cacheWrite + u.output;
      if (!tokens) continue;
      models.push(model);
      const m = costMicros(model, u);
      if (m == null) unpriced = true; else cost += m;
    }
    // Sessions seen only through the guard's log carry no token counts.
    if (s.costUnknown) unpriced = true;
    const bypass = s.modes.includes('bypassPermissions') || (s.modes.includes('approval:never') && s.modes.includes('sandbox:danger-full-access'));
    if (bypass) flags.add('bypass');
    rows.push({
      session: ref, agent: s.agent, repo, dir: s.cwd ? shown(s.cwd) : null, branch: s.branch ?? null,
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      minutes: s.startedAt && s.endedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : null,
      toolCalls: calls.length, commands, models: models.map((m) => (priceId(m) ?? m)).filter((m, i, a) => SAFE_PROGRAM.test(m.replace('/', '')) && a.indexOf(m) === i),
      costMicros: cost, unpriced, source: s.source ?? 'history', modes: s.modes.filter((m) => /^[\w:.-]{1,40}$/.test(m)), flags: [...flags],
    });
  }

  rows.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

  // Sessions by agent and by repository.
  const group = (keyFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      const g = m.get(k) ?? { sessions: 0, costMicros: 0, unpriced: 0, agents: new Set(), repos: new Set() };
      g.sessions++; g.costMicros += r.costMicros; if (r.unpriced) g.unpriced++; g.agents.add(r.agent); g.repos.add(r.repo);
      m.set(k, g);
    }
    return m;
  };
  const byAgent = [...group((r) => r.agent)].map(([agent, g]) => ({ agent, label: label(agent), sessions: g.sessions, costMicros: g.costMicros, unpricedSessions: g.unpriced, repositories: g.repos.size })).sort((a, b) => b.sessions - a.sessions);
  const byRepo = [...group((r) => r.repo)].map(([repo, g]) => ({ repo, sessions: g.sessions, costMicros: g.costMicros, agents: [...g.agents].map(label) })).sort((a, b) => b.sessions - a.sessions || a.repo.localeCompare(b.repo));

  // Permission modes in effect.
  const modeCount = new Map();
  for (const r of rows) for (const m of r.modes) inc(modeCount, `${r.agent}|${m}`);
  const modes = [...modeCount].map(([k, sessions]) => { const [agent, mode] = k.split('|'); return { agent, label: label(agent), mode, sessions }; }).sort((a, b) => b.sessions - a.sessions);
  const bypassRows = rows.filter((r) => r.flags.includes('bypass'));
  const loose = (config.modes ?? []).filter((m) => (m.agent === 'claude-code' && m.value === 'bypassPermissions') || (m.agent === 'codex' && (m.value === 'never' || m.value === 'danger-full-access')) || (m.agent === 'gemini-cli' && (m.value === 'yolo' || m.value === 'true')));
  const hooks = (config.hooks ?? []).map((h) => ({ ...h, label: label(h.agent) }));
  const unrecognised = hooks.filter((h) => !h.immiscible);

  const riskyList = Object.values(risky).filter((r) => r.count).map((r) => ({ kind: r.kind, label: r.label, count: r.count, sessions: r.sessions.size, repos: [...r.repos], agents: [...r.agents].map(label) }));
  const secretList = [...secretReads.values()].map((e) => ({ path: e.path, count: e.count, agents: [...e.agents].map(label), repos: [...e.repos] })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  const totalCost = rows.reduce((n, r) => n + r.costMicros, 0);
  const report = {
    privacy: PRIVACY,
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), days: Math.max(1, Math.round((until - since) / 86400000)) },
    sources: sources.map(({ agent, label: l, status, via, files, unreadable, note }) => ({ agent, label: l, status, ...(via ? { via } : {}), files, sessions: status === 'read' ? rows.filter((r) => r.agent === agent).length : 0, unreadable, note })),
    totals: { sessions: rows.length, agents: byAgent.length, repositories: byRepo.length, commands: rows.reduce((n, r) => n + r.commands, 0), toolCalls: rows.reduce((n, r) => n + r.toolCalls, 0), costMicros: totalCost, unpricedSessions: rows.filter((r) => r.unpriced).length },
    byAgent,
    byRepo,
    commands: { total: rows.reduce((n, r) => n + r.commands, 0), programs: top(programs, 12), risky: riskyList },
    files: { reads: filesRead, written: written.size, secretReads: secretList },
    network: { calls: networkCalls, searches, domains: top(domains, 15, 'domain') },
    mcp: top(mcp, 10, 'server'),
    exfiltration: exfil,
    permissions: { modes, bypassSessions: bypassRows.length, settings: loose, hooks, unrecognisedHooks: unrecognised },
    sessions: rows,
    transcripts: transcriptSummary(transcriptSecrets, shown),
    guard,
  };
  report.findings = findings(report);
  return report;
}

/**
 * Secrets the agents' own history files hold, counted once per distinct value
 * however many files carry it: { distinct, files, byKind: [{ id, label, severity, count }],
 * locations: [{ agent, path, count }] }. Fingerprints stay out of the report.
 */
function transcriptSummary(list, shown) {
  const seen = new Map();
  const files = new Map();
  for (const t of list) {
    for (const s of t.secrets) if (!seen.has(s.fingerprint)) seen.set(s.fingerprint, s);
    const where = shown(path.dirname(t.file));
    const e = files.get(where) ?? { agent: t.agent, path: where, count: 0 };
    e.count += t.secrets.length;
    files.set(where, e);
  }
  const kinds = new Map();
  for (const s of seen.values()) {
    const k = kinds.get(s.id) ?? { id: s.id, label: s.label, severity: s.severity, count: 0 };
    k.count++;
    kinds.set(s.id, k);
  }
  return {
    distinct: seen.size,
    files: list.length,
    byKind: [...kinds.values()].sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'high' ? -1 : 1)),
    locations: [...files.values()].sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const list = (xs, n = 3) => { const a = xs.slice(0, n); const more = xs.length - a.length; return a.length <= 1 && !more ? a.join('') : more ? `${a.join(', ')} and ${more} more` : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`; };
export const usd = (micros) => `$${(micros / 1e6).toFixed(micros < 1e6 && micros > 0 ? 3 : 2)}`;

/** Ranked findings, most important first, each one plain sentence. severity: high, medium or info. */
export function findings(r) {
  const out = [];
  for (const e of r.exfiltration) {
    out.push({ severity: 'high', kind: 'exfiltration_shape', sentence: `A ${label(e.agent)} session in ${e.repo} read ${list(e.secrets, 2)} and then reached ${list(e.domains, 2)}: the shape of a secret leaving the machine.` });
  }
  const tr = r.transcripts;
  if (tr?.distinct) {
    const high = tr.byKind.some((k) => k.severity === 'high');
    const kinds = list(tr.byKind.map((k) => (k.count > 1 ? `${k.count} ${k.label}s` : `${/^[AEIOU]/i.test(k.label) ? 'an' : 'a'} ${k.label}`)));
    out.push({ severity: high ? 'high' : 'medium', kind: 'secrets_in_transcripts', sentence: `Your agents' own history files hold ${plural(tr.distinct, 'secret')} in plain text (${kinds}), in ${plural(tr.files, 'file')} anything running as you can read. Rotate ${tr.distinct === 1 ? 'it' : 'them'}.` });
  }
  const fp = r.commands.risky.find((x) => x.kind === 'force_push');
  if (fp) out.push({ severity: 'high', kind: 'force_push', sentence: `${list(fp.agents)} force pushed ${times(fp.count)}, in ${list(fp.repos)}.` });
  for (const h of r.permissions.unrecognisedHooks.filter((x) => x.event === 'SessionStart')) {
    out.push({ severity: 'high', kind: 'hook', sentence: `A SessionStart hook in ${h.where} runs ${h.program} at the start of every ${h.label} session, and it is not one Immiscible recognises.` });
  }
  if (r.permissions.bypassSessions) {
    const agents = [...new Set(r.sessions.filter((s) => s.flags.includes('bypass')).map((s) => label(s.agent)))];
    const n = r.permissions.bypassSessions;
    out.push({ severity: 'high', kind: 'bypass', sentence: `${n === 1 ? `A ${agents[0]} session` : `${n} sessions (${list(agents)})`} ran with approvals bypassed, so nothing asked before acting.` });
  }
  for (const m of r.permissions.settings) {
    out.push({ severity: 'medium', kind: 'setting', sentence: `${label(m.agent)} is set to ${m.setting} = ${m.value} in ${m.where}, so it acts without asking.` });
  }
  const others = r.permissions.unrecognisedHooks.filter((x) => x.event !== 'SessionStart');
  if (others.length) out.push({ severity: 'medium', kind: 'hook', sentence: `${plural(others.length, 'hook')} not from Immiscible ${others.length === 1 ? 'runs' : 'run'} on ${list([...new Set(others.map((h) => `${h.label} ${h.event}`))])}: ${list([...new Set(others.map((h) => h.program))])}.` });
  for (const k of ['publish', 'terraform', 'kubectl', 'rm_rf']) {
    const x = r.commands.risky.find((y) => y.kind === k);
    if (!x) continue;
    const what = { publish: 'published a package', terraform: 'ran terraform apply or destroy', kubectl: 'ran kubectl', rm_rf: 'ran rm -rf' }[k];
    out.push({ severity: 'medium', kind: k, sentence: `${list(x.agents)} ${what} ${times(x.count)}, in ${list(x.repos)}.` });
  }
  if (r.files.secretReads.length) {
    const n = r.files.secretReads.reduce((a, b) => a + b.count, 0);
    out.push({ severity: 'medium', kind: 'secret_read', sentence: `Agents read secret files ${times(n)}: ${list(r.files.secretReads.map((x) => x.path))}.` });
  }
  if (r.totals.sessions) {
    const priciest = [...r.sessions].sort((a, b) => b.costMicros - a.costMicros)[0];
    const unpriced = r.totals.unpricedSessions ? ` (${plural(r.totals.unpricedSessions, 'session')} not priced)` : '';
    out.push({ severity: 'info', kind: 'cost', sentence: priciest?.costMicros
      ? `${plural(r.totals.sessions, 'session')} cost about ${usd(r.totals.costMicros)} at list prices${unpriced}; the most expensive was ${label(priciest.agent)} in ${priciest.repo}, at ${usd(priciest.costMicros)}.`
      : `${plural(r.totals.sessions, 'session')} ran across ${plural(r.totals.repositories, 'repository', 'repositories')}${unpriced}.` });
  }
  const g = r.guard;
  if (g?.brokenDays?.length) {
    out.push({ severity: 'medium', kind: 'guard_log', sentence: `The guard's decision log for ${list(g.brokenDays.map((d) => d.day))} does not verify from line ${g.brokenDays[0].line}: a line was changed or removed after it was written, or two hooks wrote at the same moment.` });
  }
  if (g && (g.deny || g.ask)) {
    const top = g.rules[0];
    out.push({ severity: 'info', kind: 'guard', sentence: `Guard refused ${plural(g.deny, 'call')} and asked about ${g.ask}${top ? `, most often for ${top.rule.replace(/_/g, ' ')}` : ''}.` });
  }
  const rank = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
