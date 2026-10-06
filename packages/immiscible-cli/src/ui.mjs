/**
 * Output: calm and precise. Colour only when stdout is a terminal and
 * NO_COLOR is unset; a spinner only when stderr is a terminal. In --json
 * mode nothing but the JSON reaches stdout, and nothing decorative is
 * written anywhere.
 */

import { createInterface } from 'node:readline/promises';

const CODES = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], cyan: [36, 39], grey: [90, 39] };

export function makeUi({ json = false, color = null, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env } = {}) {
  const tty = Boolean(stdout.isTTY);
  const useColor = !json && (color ?? (tty && env.NO_COLOR == null && env.TERM !== 'dumb'));
  const paint = (name) => (s) => (useColor ? `\u001b[${CODES[name][0]}m${s}\u001b[${CODES[name][1]}m` : String(s));
  const c = Object.fromEntries(Object.keys(CODES).map((k) => [k, paint(k)]));
  const interactive = !json && Boolean(stdin.isTTY) && tty && !env.CI;
  const spinOk = !json && Boolean(stderr.isTTY) && env.TERM !== 'dumb';

  const out = (s = '') => { if (!json) stdout.write(`${s}\n`); };
  const err = (s = '') => { if (!json) stderr.write(`${s}\n`); };

  const ui = {
    json, interactive, c, tty,
    out,
    err,
    blank: () => out(''),
    /** "✓ Done" in green, "! Careful" in yellow, "✗ Failed" in red. */
    ok: (s) => out(`${c.green('✓')} ${s}`),
    warn: (s) => out(`${c.yellow('!')} ${s}`),
    fail: (s) => out(`${c.red('✗')} ${s}`),
    note: (s) => out(c.dim(s)),
    heading: (s) => out(c.bold(s)),
    /** Two columns, labels padded to the widest. */
    table(rows, { indent = '' } = {}) {
      const w = Math.max(0, ...rows.map(([k]) => String(k).length));
      for (const [k, v] of rows) out(`${indent}${c.dim(String(k).padEnd(w))}  ${v}`);
    },
    writeJson(obj) {
      stdout.write(`${JSON.stringify(obj, null, json === 'pretty' ? 2 : 0)}\n`);
    },
    /** A spinner on stderr for the duration of fn; on a pipe, one plain line instead. */
    async spin(label, fn) {
      if (!spinOk) {
        if (!json) stderr.write(`${label}...\n`);
        return fn();
      }
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let i = 0;
      let text = label;
      const draw = () => stderr.write(`\r\u001b[2K${c.cyan(frames[i++ % frames.length])} ${text}`);
      draw();
      const timer = setInterval(draw, 80);
      try {
        return await fn({ update: (t) => { text = t; } });
      } finally {
        clearInterval(timer);
        stderr.write('\r\u001b[2K');
      }
    },
    async ask(question, { default: def = '' } = {}) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const a = (await rl.question(`${c.bold('?')} ${question}${def ? c.dim(` (${def})`) : ''} `)).trim();
        return a || def;
      } finally {
        rl.close();
      }
    },
    async confirm(question, { default: def = true } = {}) {
      const a = (await ui.ask(`${question} ${c.dim(def ? '[Y/n]' : '[y/N]')}`)).toLowerCase();
      if (!a) return def;
      return a === 'y' || a === 'yes';
    },
    /** A numbered choice. items: [{ value, label, hint }]. Returns the value. */
    async choose(question, items, { default: def = null } = {}) {
      out(`${c.bold('?')} ${question}`);
      const w = Math.max(...items.map((it) => it.label.length));
      items.forEach((it, i) => out(`  ${c.dim(String(i + 1).padStart(2))}  ${it.hint ? it.label.padEnd(w) : it.label}${it.hint ? `  ${c.dim(it.hint)}` : ''}`));
      const di = Math.max(0, items.findIndex((it) => it.value === def));
      for (;;) {
        const a = await ui.ask('Number', { default: String(di + 1) });
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1].value;
        const byValue = items.find((it) => it.value === a);
        if (byValue) return byValue.value;
        err(c.yellow(`Choose a number from 1 to ${items.length}.`));
      }
    },
  };
  return ui;
}
