import test from 'node:test';
import assert from 'node:assert/strict';
import { markGrid, markLines, dotLine, cardLines, plainCard, colourDepth, showCard, aboutJson, CORAL } from '../src/banner.mjs';
import { VERSION } from '../src/version.mjs';

const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

test('the mark is the Cardinal squares geometry: two rings, back crossing over the front once', () => {
  const g = markGrid();
  assert.equal(g.length, 16);
  assert.ok(g.every((r) => r.length === 16));
  assert.equal(g[0].slice(0, 12), 'bbbbbbbbbbbb', 'the back ring starts at the top left');
  assert.equal(g[15].slice(4), 'ffffffffffff', 'the front ring ends at the bottom right');
  assert.equal(g[4][10], 'b', 'the back bar is laid over the front where they cross at the top right');
  assert.equal(g[11][4], 'f', 'the front passes over the back at the bottom left');
});

test('without colour the card has no escape codes; with colour the front square is coral', () => {
  for (const l of markLines(null)) assert.equal(l, strip(l));
  const n = Number.parseInt(CORAL.slice(1), 16);
  const rgb = `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  assert.ok(markLines('truecolor').join('').includes(rgb));
  assert.ok(strip(dotLine(32, 'truecolor')).split(' ').length === 32);
});

test('the card carries the version and credits and fits the terminal', () => {
  const wide = cardLines({ width: 100 }).map(strip);
  assert.ok(wide.some((l) => l.includes(`v${VERSION}`)));
  assert.ok(wide.some((l) => l.includes('Eóin Forker')));
  assert.ok(wide.every((l) => l.length <= 100));
  const narrow = cardLines({ width: 60 }).map(strip);
  assert.ok(narrow.every((l) => l.length <= 78));
  assert.ok(!narrow.some((l) => l.includes('█')), 'no mark when the terminal is narrow');
  assert.match(plainCard(), new RegExp(`immiscible v${VERSION.replaceAll('.', '\\.')}`));
});

test('pipes, CI and --json get no art', async () => {
  let out = '';
  const pipe = { isTTY: false, write: (s) => { out += s; } };
  assert.equal(await showCard({ ui: { json: false }, stdout: pipe, env: {} }), false);
  assert.equal(out, `${plainCard()}\n`);
  out = '';
  const tty = { isTTY: true, columns: 100, write: (s) => { out += s; } };
  assert.equal(await showCard({ ui: { json: false }, stdout: tty, env: { CI: '1' } }), false);
  assert.ok(!out.includes('█'));
  out = '';
  assert.equal(await showCard({ ui: { json: true }, stdout: tty, env: {} }), false);
  assert.equal(out, '');
  assert.equal(colourDepth({ env: { COLORTERM: 'truecolor' } }), 'truecolor');
  assert.equal(colourDepth({ env: {} }), '256');
  assert.equal(colourDepth({ env: {}, useColor: false }), null);
  assert.equal(aboutJson().version, VERSION);
});

test('a terminal gets the drawn card, still with no motion when IMMISCIBLE_NO_MOTION is set', async () => {
  let out = '';
  const tty = { isTTY: true, columns: 100, write: (s) => { out += s; } };
  const ui = { json: false, useColor: true, c: { bold: (s) => s, dim: (s) => s } };
  assert.equal(await showCard({ ui, stdout: tty, env: { COLORTERM: 'truecolor', IMMISCIBLE_NO_MOTION: '1' } }), true);
  assert.ok(out.includes('●'));
  assert.ok(!out.includes('\u001b[?25l'), 'no animation frames');
});

test('the constellation card: the large dotted mark with the field thickening to the right', async () => {
  const { constellationLines, constellationGrid, CONSTELLATION_WIDTH, COMPACT_WIDTH } = await import('../src/banner.mjs');
  const big = constellationGrid(2);
  assert.equal(big.length, 16);
  assert.equal(big[0].slice(0, 12), 'bbbbbbbbbbbb');
  assert.equal(big[15].slice(4), 'ffffffffffff');
  const small = constellationGrid(4);
  assert.equal(small[2][5], 'b', 'the back crosses over the front once, top right');
  const lines = constellationLines({ depth: 'truecolor', width: 110 }).map(strip);
  assert.ok(lines.every((l) => l.length <= 110), 'fits the terminal');
  assert.ok(lines.some((l) => l.includes(`v${VERSION}`)) && lines.some((l) => l.includes('a person gets asked.')) && lines.some((l) => l.includes('immiscible guard')));
  const right = lines.slice(1, 17).map((l) => l.slice(80)).join('');
  const left = lines.slice(1, 17).map((l) => l.slice(36, 60)).join('');
  assert.ok((right.match(/[●•]/g) ?? []).length > (left.match(/[●•]/g) ?? []).length, 'the field thickens towards the right');
  const coral = Number.parseInt(CORAL.slice(1), 16);
  const rgb = `${(coral >> 16) & 255};${(coral >> 8) & 255};${coral & 255}m●`;
  assert.ok(constellationLines({ depth: 'truecolor' }).join('').includes(rgb));
  assert.ok(!constellationLines({ depth: 'truecolor', reveal: 0.3 }).join('').includes(rgb), 'the coral square arrives last');
  const compact = constellationLines({ depth: 'truecolor', compact: true, width: 80 }).map(strip);
  assert.ok(compact.every((l) => l.length <= 80));
  let out = '';
  const ui = { json: false, useColor: true, c: { bold: (s) => s, dim: (s) => s } };
  const term = (columns) => ({ isTTY: true, columns, write: (s) => { out += s; } });
  const env = { COLORTERM: 'truecolor', IMMISCIBLE_NO_MOTION: '1' };
  await showCard({ ui, stdout: term(110), env });
  assert.ok(strip(out).includes('● '.repeat(12)), 'large card in a wide terminal');
  out = '';
  await showCard({ ui, stdout: term(84), env });
  assert.ok(out.includes('●') && !strip(out).includes('● '.repeat(12)), 'compact card in an 84-column terminal');
  out = '';
  await showCard({ ui, stdout: term(110), env: { ...env, IMMISCIBLE_CARD: 'classic' } });
  assert.ok(out.includes('█'), 'classic on request');
  out = '';
  await showCard({ ui, stdout: term(COMPACT_WIDTH - 4), env });
  assert.ok(out.includes(`v${VERSION}`) && !out.includes('●'), 'classic in a narrow terminal');
  void CONSTELLATION_WIDTH;
});
