/**
 * The welcome card: the Cardinal squares, the wordmark, the version and the
 * credits, with one line of the site's dot field beneath. Shown when
 * `immiscible` runs with no command in a terminal, by `immiscible about`,
 * and at the end of the installers.
 *
 * The constellation card is the default: the Cardinal squares drawn in
 * dots, with the dot field thickening towards the right edge behind the
 * words. It goes compact (a smaller mark, steps beneath) under 98 columns
 * and to the classic card under 74, or on request (IMMISCIBLE_CARD=compact
 * or classic).
 *
 * Drawn from brand.config.json: the back square is currentColor (the
 * terminal's own foreground, as on the site), the front square coral
 * #F0563A; the dots are the dot field's cool family for what was stopped and
 * one coral dot for the request a person was asked about. Nothing is drawn in
 * --json mode, in CI, on a pipe or in a terminal narrower than the card; a
 * plain text version is used instead. Colour follows NO_COLOR and --no-color;
 * the dots fade in once, briefly, unless IMMISCIBLE_NO_MOTION or CI is set.
 */

import { platform, arch } from 'node:os';
import { VERSION } from './version.mjs';

export const CORAL = '#F0563A';
const COOL = ['#2347C4', '#4C7DFF', '#7FA6FF', '#ACD8F6', '#DCEEFB'];
const XTERM = { '#F0563A': 203, '#2347C4': 26, '#4C7DFF': 69, '#7FA6FF': 111, '#ACD8F6': 153, '#DCEEFB': 195 };

export const TAGLINE = ['Before an agent does something it can’t take back,', 'a person gets asked.'];
export const CREDITS = 'Made by Eóin Forker · MIT licence';
export const SITE = 'immiscible.ai';

/**
 * The mark from brand/cardinal-squares.svg (viewBox 0 0 32 32), sampled on a
 * 2 px grid: 'b' the back square, 'f' the front square, '.' empty. Painted
 * back, front, then the back's crossing bar over the front, as the SVG is.
 */
export function markGrid() {
  const ring = (x, y, o) => x >= o && x < o + 24 && y >= o && y < o + 24 && !(x >= o + 4 && x < o + 20 && y >= o + 4 && y < o + 20);
  const rows = [];
  for (let y = 0; y < 32; y += 2) {
    let row = '';
    for (let x = 0; x < 32; x += 2) {
      const px = x + 1;
      const py = y + 1;
      let v = '.';
      if (ring(px, py, 0)) v = 'b';
      if (ring(px, py, 8)) v = 'f';
      if (px >= 20 && px < 24 && py >= 6 && py < 14) v = 'b';
      row += v;
    }
    rows.push(row);
  }
  return rows;
}

/** How this terminal takes colour: 'truecolor', '256', or null for none. */
export function colourDepth({ env = process.env, useColor = true } = {}) {
  if (!useColor) return null;
  const ct = String(env.COLORTERM ?? '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit') || env.WT_SESSION || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'vscode') return 'truecolor';
  return '256';
}

function fg(hex, depth) {
  if (!depth) return '';
  if (depth === 'truecolor') {
    const n = Number.parseInt(hex.slice(1), 16);
    return `\u001b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  }
  return `\u001b[38;5;${XTERM[hex] ?? 15}m`;
}
function bg(hex, depth) {
  if (!depth) return '';
  if (depth === 'truecolor') {
    const n = Number.parseInt(hex.slice(1), 16);
    return `\u001b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
  }
  return `\u001b[48;5;${XTERM[hex] ?? 15}m`;
}
const RESET = '\u001b[0m';

/** The mark as terminal lines, two pixel rows to a line with half blocks. */
export function markLines(depth) {
  const g = markGrid();
  const lines = [];
  for (let y = 0; y < g.length; y += 2) {
    let line = '';
    for (let x = 0; x < g[y].length; x++) {
      const t = g[y][x];
      const b = g[y + 1]?.[x] ?? '.';
      line += cell(t, b, depth);
    }
    lines.push(line);
  }
  return lines;
}

function cell(top, bottom, depth) {
  if (top === '.' && bottom === '.') return ' ';
  if (!depth) {
    if (top !== '.' && bottom !== '.') return '█';
    return top !== '.' ? '▀' : '▄';
  }
  const paint = (v) => (v === 'f' ? CORAL : null);
  const tc = paint(top);
  const bc = paint(bottom);
  if (top === bottom) return `${tc ? fg(tc, depth) : '\u001b[39m'}█${RESET}`;
  if (bottom === '.') return `${tc ? fg(tc, depth) : '\u001b[39m'}▀${RESET}`;
  if (top === '.') return `${bc ? fg(bc, depth) : '\u001b[39m'}▄${RESET}`;
  // The two squares meet in one cell: the back square in the terminal's own colour, the front as a coral background.
  if (tc) return `\u001b[39m${bg(tc, depth)}▄${RESET}`;
  return `\u001b[39m${bg(bc, depth)}▀${RESET}`;
}

/** One line of the dot field: the cool family, then a single coral dot. */
export function dotLine(n = 32, depth = null, { seed = 20261006 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const dots = [];
  for (let i = 0; i < n - 1; i++) dots.push(COOL[Math.floor(rnd() * COOL.length)]);
  dots.splice(Math.floor(n * 0.72), 0, CORAL);
  return dots.slice(0, n).map((hex) => (depth ? `${fg(hex, depth)}•${RESET}` : (hex === CORAL ? '•' : '·'))).join(' ');
}


/** The card as lines. width: the terminal's columns. */
export function cardLines({ depth = null, width = 80, env = process.env, bold = (s) => s, dim = (s) => s } = {}) {
  const info = [
    '',
    `${bold('immiscible')}  ${dim(`v${VERSION}`)}`,
    TAGLINE[0],
    TAGLINE[1],
    '',
    dim(`node ${process.versions.node} · ${platform()} ${arch()} · ${SITE}`),
    dim(CREDITS),
    '',
  ];
  const mark = markLines(depth);
  const narrow = width < 78;
  const lines = [''];
  if (narrow) {
    for (const l of info.slice(1, 7)) lines.push(`  ${l}`);
  } else {
    for (let i = 0; i < mark.length; i++) lines.push(`  ${mark[i]}    ${info[i] ?? ''}`);
  }
  lines.push('');
  lines.push(`  ${dotLine(narrow ? 16 : 32, depth)}`);
  lines.push('');
  lines.push(`  ${dim('Start')}  immiscible scan    ${dim('Fix')}  immiscible guard    ${dim('Help')}  immiscible help`);
  lines.push('');
  void env;
  return lines;
}

/* ------------------------------------------------------------------ */
/* The constellation card (the default): the Cardinal squares drawn in */
/* dots, set inside the site's dot field, the words in a clearing.     */
/* ------------------------------------------------------------------ */

function hexRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function nearestXterm(hex) {
  const [r, g, b] = hexRgb(hex);
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}
function fgAny(hex, depth) {
  if (!depth) return '';
  if (depth === 'truecolor') return fg(hex, depth);
  return `\u001b[38;5;${XTERM[hex] ?? nearestXterm(hex)}m`;
}
/** A field colour pushed towards Every-black, so the mark's own dots stand out from the field. */
function faded(hex, amount = 0.55) {
  const [r, g, b] = hexRgb(hex);
  const bg = [11, 13, 21];
  const m = (v, i) => Math.round(v + (bg[i] - v) * amount);
  return `#${((1 << 24) | (m(r, 0) << 16) | (m(g, 1) << 8) | m(b, 2)).toString(16).slice(1).toUpperCase()}`;
}

/**
 * The mark sampled on a grid of `step` px: step 2 gives 16 by 16 (each ring
 * two dots thick, the large card), step 4 gives 8 by 8 (one dot thick, the
 * compact card). Painted back, front, then the back's crossing bar, as the SVG is.
 */
export function constellationGrid(step = 4) {
  const ring = (x, y, o) => x >= o && x < o + 24 && y >= o && y < o + 24 && !(x >= o + 4 && x < o + 20 && y >= o + 4 && y < o + 20);
  const rows = [];
  for (let y = step / 2; y < 32; y += step) {
    let row = '';
    for (let x = step / 2; x < 32; x += step) {
      let v = '.';
      if (ring(x, y, 0)) v = 'b';
      if (ring(x, y, 8)) v = 'f';
      if (x >= 20 && x < 24 && y >= 6 && y < 14) v = 'b';
      row += v;
    }
    rows.push(row);
  }
  return rows;
}

/** Below this width the compact card is used; below COMPACT_WIDTH, the classic one. */
export const CONSTELLATION_WIDTH = 96;
export const COMPACT_WIDTH = 72;

function rng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/**
 * The constellation card as lines: the Cardinal squares drawn in dots (the
 * back square in the dot field's cool family, the front in coral), and on the
 * right the words, with the field thickening towards the right edge behind
 * them. reveal (0 to 1) is the one-off animation: the field arrives first,
 * then the back square, then the coral square last.
 */
export function constellationLines({ depth = null, bold = (s) => s, dim = (s) => s, reveal = 1, width = CONSTELLATION_WIDTH, compact = false, seed = 20261006 } = {}) {
  const rnd = rng(seed);
  const step = compact ? 4 : 2;
  const g = constellationGrid(step);
  const n = g.length;
  const dot = (hex, ch = '●') => (depth ? `${fgAny(hex, depth)}${ch}${RESET}` : ch);
  const W = Math.max(compact ? COMPACT_WIDTH : CONSTELLATION_WIDTH, Math.min(width - 2, 120));
  const markCols = n * 2;
  const textX = 2 + markCols + (compact ? 4 : 6);
  const rows = Math.max(n, compact ? 8 : 16);
  // The words on the right, row by row.
  const steps = [['scan', 'what your coding agents did this week'], ['guard', 'fix it in one command, no account'], ['try', 'see approvals work, offline']];
  const arrow = depth ? `${fg(CORAL, depth)}›${RESET}` : '›';
  const right = compact
    ? ['', `${bold('immiscible')}  ${dim(`v${VERSION}`)}`, '', TAGLINE[0], TAGLINE[1]]
    : ['', '', '', bold('immiscible'), dim(`v${VERSION}`), '', '', TAGLINE[0], TAGLINE[1], '', '',
      ...steps.map(([c, w]) => `${arrow} ${bold(`immiscible ${c}`.padEnd(19))}${dim(w)}`)];
  const textWidth = Math.max(...right.map(vis));
  const out = [''];
  for (let y = 0; y < rows; y++) {
    // The mark.
    let line = '  ';
    for (let x = 0; x < n; x++) {
      const v = g[y]?.[x] ?? '.';
      const r = rnd();
      if (v === 'f') line += reveal >= 1 ? dot(CORAL) : reveal > 0.85 ? dot(faded(CORAL, 0.45)) : ' ';
      else if (v === 'b') line += reveal > 0.6 ? dot(COOL[Math.floor(r * COOL.length)]) : ' ';
      else line += ' ';
      line += ' ';
    }
    line += ' '.repeat(textX - 2 - markCols);
    // The words, then the field to the right edge, thickening as it goes.
    const words = right[y] ?? '';
    line += words;
    let x = textX + vis(words);
    const clearTo = textX + textWidth + 2;
    if (x % 2) { line += ' '; x++; }
    while (x < W) {
      const r1 = rnd();
      const r2 = rnd();
      const r3 = rnd();
      const inWords = x < clearTo && words !== '';
      const p = 0.62 * Math.max(0, (x - textX) / (W - textX)) ** 1.15;
      line += !inWords && r1 < p && r3 < reveal ? dot(faded(COOL[Math.floor(r2 * 4)], 0.35 + r3 * 0.25), r2 < 0.35 ? '●' : '•') : ' ';
      line += ' ';
      x += 2;
    }
    out.push(line.replace(/ +$/, ''));
  }
  out.push('');
  if (compact) {
    for (const [c, w] of steps) out.push(`  ${arrow} ${bold(`immiscible ${c}`.padEnd(19))}${dim(w)}`);
    out.push('');
  }
  const env = `${SITE}/docs/cli  ·  node ${process.versions.node.split('.')[0]} · ${platform()} ${arch()}`;
  if (compact) out.push(`  ${dim(env)}`, `  ${dim(CREDITS)}`);
  else out.push(`  ${dim(`${env}  ·  ${CREDITS}`)}`);
  out.push('');
  return out;
}

const vis = (s) => s.replace(/\u001b\[[0-9;]*m/g, '').length;

/** Plain text for pipes, CI and --json-free logs: no art, no escapes. */
export function plainCard() {
  return [`immiscible v${VERSION}`, `${TAGLINE[0]} ${TAGLINE[1]}`, CREDITS, `Start: immiscible scan, then immiscible guard. Help: immiscible help. ${SITE}`].join('\n');
}

/** Write the card to stdout. Returns true when the drawn card was shown. */
export async function showCard({ ui, stdout = process.stdout, env = process.env, motion = true } = {}) {
  if (ui?.json) return false;
  const width = stdout.columns ?? 80;
  if (!stdout.isTTY || env.CI || env.TERM === 'dumb') {
    stdout.write(`${plainCard()}\n`);
    return false;
  }
  const depth = colourDepth({ env, useColor: Boolean(ui?.useColor) });
  const bold = ui?.c?.bold ?? ((s) => s);
  const dim = ui?.c?.dim ?? ((s) => s);
  const animate = motion && depth && !env.IMMISCIBLE_NO_MOTION;
  const classic = String(env.IMMISCIBLE_CARD ?? '').toLowerCase() === 'classic' || width < COMPACT_WIDTH + 2;
  const compact = String(env.IMMISCIBLE_CARD ?? '').toLowerCase() === 'compact' || width < CONSTELLATION_WIDTH + 2;

  if (!classic) {
    const draw = (reveal) => constellationLines({ depth, bold, dim, reveal, width, compact });
    if (!animate) {
      stdout.write(`${draw(1).join('\n')}\n`);
      return true;
    }
    stdout.write('\u001b[?25l');
    try {
      let first = true;
      for (const r of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1]) {
        const lines = draw(r);
        if (!first) stdout.write(`\u001b[${lines.length}A`);
        stdout.write(`${lines.map((l) => `\u001b[2K${l}`).join('\n')}\n`);
        first = false;
        await new Promise((res) => setTimeout(res, r >= 0.9 ? 90 : 45));
      }
    } finally {
      stdout.write('\u001b[?25h');
    }
    return true;
  }

  const lines = cardLines({ depth, width, env, bold, dim });
  stdout.write(`${lines.join('\n')}\n`);
  return true;
}

/** The same facts as data, for `immiscible about --json`. */
export function aboutJson() {
  return { ok: true, name: 'immiscible', version: VERSION, node: process.versions.node, platform: `${platform()} ${arch()}`, tagline: TAGLINE.join(' '), credits: CREDITS, site: `https://${SITE}`, docs: `https://${SITE}/docs/cli` };
}
