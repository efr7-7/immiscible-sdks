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
  help: { value: false, short: 'h' },
  version: { value: false, short: 'v' },
};

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
    if (!spec) throw usage(`unknown flag --${name}`);
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
