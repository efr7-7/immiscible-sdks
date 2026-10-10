/**
 * List prices for costing a session from its token counts, in US dollars per
 * million tokens: [input, cache read, output]. A copy of the rows the
 * coding agents use from the server's price table (src/core/catalog.js,
 * PRICE_LIST and the catalogue routes), because this package is published
 * on its own and cannot import the server. test/history.test.mjs fails
 * when a row here drifts from the server's table.
 *
 * A model not listed here is reported as "not priced", never guessed.
 */

export const PRICES_CHECKED = '2026-10-07';

export const PRICES = Object.freeze({
  // Anthropic (https://platform.claude.com/docs/en/about-claude/pricing)
  'anthropic/claude-opus-4.8': [5, 0.5, 25],
  'anthropic/claude-sonnet-5': [2, 0.2, 10],
  'anthropic/claude-opus-4-7': [5, 0.5, 25],
  'anthropic/claude-opus-4-6': [5, 0.5, 25],
  'anthropic/claude-opus-4-5': [5, 0.5, 25],
  'anthropic/claude-opus-4-1': [15, 1.5, 75],
  'anthropic/claude-opus-4': [15, 1.5, 75],
  'anthropic/claude-sonnet-4-6': [3, 0.3, 15],
  'anthropic/claude-sonnet-4-5': [3, 0.3, 15],
  'anthropic/claude-sonnet-4': [3, 0.3, 15],
  'anthropic/claude-haiku-4-5': [1, 0.1, 5],
  'anthropic/claude-3-5-haiku': [0.8, 0.08, 4],
  // OpenAI (https://developers.openai.com/api/docs/pricing)
  'openai/gpt-5.5': [5, 0.5, 30],
  'openai/gpt-5': [1.25, 0.125, 10],
  'openai/gpt-5-mini': [0.25, 0.025, 2],
  'openai/gpt-5-nano': [0.05, 0.005, 0.4],
  'openai/gpt-4.1': [2, 0.5, 8],
  'openai/gpt-4.1-mini': [0.4, 0.1, 1.6],
  'openai/gpt-4o': [2.5, 1.25, 10],
  'openai/gpt-4o-mini': [0.15, 0.075, 0.6],
  'openai/o3': [2, 0.5, 8],
  'openai/o4-mini': [1.1, 0.275, 4.4],
});

/** Model names as the agents write them, to the ids above. */
const ALIASES = Object.freeze({
  'claude-opus-4-8': 'anthropic/claude-opus-4.8',
  'claude-opus-4.8': 'anthropic/claude-opus-4.8',
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'claude-opus-4-0': 'anthropic/claude-opus-4',
  'claude-sonnet-4-0': 'anthropic/claude-sonnet-4',
  'gpt-5.5': 'openai/gpt-5.5',
});

/** The price id for a model name an agent recorded, or null. */
export function priceId(model) {
  const raw = String(model ?? '').trim().toLowerCase();
  if (!raw || raw.startsWith('<')) return null;
  const name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const tries = [name, name.replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, ''), name.replace(/\[.*\]$/, '')];
  for (const n of tries) {
    if (ALIASES[n]) return ALIASES[n];
    for (const p of ['anthropic', 'openai']) if (PRICES[`${p}/${n}`]) return `${p}/${n}`;
  }
  // Codex model variants priced as their base model (gpt-5-codex is GPT-5).
  const codex = /^(gpt-5(?:\.\d)?)(?:-codex.*)?$/.exec(name);
  if (codex && PRICES[`openai/${codex[1]}`]) return `openai/${codex[1]}`;
  return null;
}

/**
 * Cost in millionths of a US dollar, or null when the model is not priced.
 * usage: { input, cacheRead, cacheWrite, output }, input excluding cache
 * reads. Cache writes are billed at 1.25 times input, as Anthropic's
 * five-minute cache is; OpenAI records none.
 */
export function costMicros(model, usage) {
  const id = priceId(model);
  if (!id) return null;
  const [inp, cached, out] = PRICES[id];
  const u = (k) => Math.max(0, Number(usage?.[k]) || 0);
  return Math.round(u('input') * inp + u('cacheRead') * cached + u('cacheWrite') * inp * 1.25 + u('output') * out);
}
