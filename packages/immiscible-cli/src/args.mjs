/**
 * Arguments: a command, then flags. --flag value, --flag=value, -y. Unknown
 * flags are an error, not a silent no-op: an agent that mistypes --yes
 * should hear about it.
 */

import { usage } from './errors.mjs';

/** Every flag, whether it takes a value, and its short form. */
export const FLAGS = {
  url: { value: true },
  token: { value: true },
  json: { value: false },
  yes: { value: false, short: 'y' },
  name: { value: true },
  purpose: { value: true },
  dir: { value: true },
  hook: { value: false },
  'no-hook': { value: false },
  'no-test': { value: false },
  'no-gitignore': { value: false },
  'no-browser': { value: false },
  'no-color': { value: false },
  force: { value: false },
  'read-only': { value: false },
  days: { value: true },
  client: { value: true },
  upload: { value: false },
  keys: { value: true },
  out: { value: true },
  since: { value: true },
  html: { value: true },
  by: { value: true },
  csv: { value: true },
  prs: { value: false },
  file: { value: true },
  exclusive: { value: false },
  scope: { value: true },
  transport: { value: true },
  key: { value: true },
  gateway: { value: true },
  'dry-run': { value: false },
  off: { value: false },
  connect: { value: false },
  agents: { value: true },
  'no-team': { value: false },
  ci: { value: false },
  approve: { value: false },
  strict: { value: false },
  pause: { value: true },
  resume: { value: false },
  status: { value: false },
  share: { value: false },
  team: { value: false },
  base: { value: true },
  comment: { value: false },
  sign: { value: false },
  check: { value: false },
  help: { value: false, short: 'h' },
  version: { value: false, short: 'v' },
};

/**
 * The nearest of some names to a mistyped one, within two edits (a swap of
 * two neighbouring letters is one, as the server's own did-you-mean counts
 * it), or null: "statsu" is status, "--jsn" is --json.
 */
export function nearest(word, names) {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  };
  let best = null;
  for (const n of names) {
    const k = dist(String(word).toLowerCase(), n);
    if (k <= 2 && k * 2 < Math.max(n.length, 3) && (!best || k < best.k)) best = { n, k };
  }
  return best?.n ?? null;
}

const SHORT = Object.fromEntries(Object.entries(FLAGS).filter(([, f]) => f.short).map(([k, f]) => [f.short, k]));

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    let name = null;
    let inline;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      inline = eq > 0 ? a.slice(eq + 1) : undefined;
    } else if (/^-[A-Za-z]$/.test(a)) {
      name = SHORT[a.slice(1)];
      if (!name) throw usage(`unknown flag ${a}`);
    } else {
      positional.push(a);
      continue;
    }
    const spec = FLAGS[name];
    if (!spec) { const near = nearest(name, Object.keys(FLAGS)); throw usage(`unknown flag --${name}${near ? `; did you mean --${near}?` : ''}`); }
    if (spec.value) {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith('--'))) throw usage(`--${name} needs a value`);
      flags[name] = v;
    } else {
      if (inline !== undefined) throw usage(`--${name} takes no value`);
      flags[name] = true;
    }
  }
  return { command: positional[0] ?? null, rest: positional.slice(1), flags };
}
