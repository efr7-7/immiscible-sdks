/**
 * Secrets sitting in the agents' own history files.
 *
 * Coding agents write tool output to their transcripts word for word: a
 * `cat .env`, a failing deploy that prints a token, a key pasted into a
 * prompt. Those files are plain text under the home directory, kept for weeks
 * (Claude Code: 30 days by default, cleanupPeriodDays), and readable by
 * anything that runs as the person, including the next agent.
 *
 * This finds credentials by their published shapes and returns only what kind
 * each is and a short SHA-256 fingerprint, so one key seen in many files is
 * counted once. The value is never returned, printed or stored.
 */

import { createHash } from 'node:crypto';

/** Shapes with a fixed, documented prefix, so a hit is very unlikely to be anything else. */
export const SECRET_SHAPES = Object.freeze([
  { id: 'private_key', label: 'private key', severity: 'high', rx: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws', label: 'AWS access key', severity: 'high', rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'stripe_live', label: 'Stripe live key', severity: 'high', rx: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g },
  { id: 'github', label: 'GitHub token', severity: 'high', rx: /\b(?:gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{60,})\b/g },
  { id: 'anthropic', label: 'Anthropic key', severity: 'high', rx: /\bsk-ant-(?:api|admin|oat)\d{2}-[0-9A-Za-z_-]{40,}/g },
  { id: 'openai', label: 'OpenAI key', severity: 'high', rx: /\bsk-(?:proj|svcacct|admin)-[0-9A-Za-z_-]{40,}/g },
  { id: 'google', label: 'Google API key', severity: 'medium', rx: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack', label: 'Slack token', severity: 'high', rx: /\bxox[abprs]-[0-9A-Za-z-]{20,}\b/g },
  { id: 'npm', label: 'npm token', severity: 'high', rx: /\bnpm_[0-9A-Za-z]{36}\b/g },
  { id: 'stripe_test', label: 'Stripe test key', severity: 'medium', rx: /\b(?:sk|rk)_test_[0-9A-Za-z]{16,}\b/g },
  { id: 'openrouter', label: 'OpenRouter key', severity: 'high', rx: /\bsk-or-v1-[0-9a-f]{64}\b/g },
]);

/** The fingerprint a person can match against their own key: sha256 of the value, 12 hex characters. */
export const secretFingerprint = (value) => `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;

/**
 * The secrets in one text, as [{ id, label, severity, fingerprint }], each
 * distinct value once. Lines a JSON transcript escaped (\n inside a string)
 * are matched as they are; nothing is unescaped or kept.
 */
export function secretsIn(text) {
  const out = new Map();
  const t = String(text ?? '');
  for (const s of SECRET_SHAPES) {
    s.rx.lastIndex = 0;
    for (const m of t.matchAll(s.rx)) {
      // A private key block is identified by its header; fingerprint what follows it, up to its footer.
      const value = s.id === 'private_key' ? t.slice(m.index, t.indexOf('-----END', m.index) + 1 || m.index + 200) : m[0];
      const fp = secretFingerprint(value);
      if (!out.has(fp)) out.set(fp, { id: s.id, label: s.label, severity: s.severity, fingerprint: fp });
    }
  }
  return [...out.values()];
}

/**
 * Credentials replaced in a line meant to be shown: by their published
 * shapes, after a name that says what they are (GITHUB_TOKEN=, PGPASSWORD=,
 * --password, a URL's user:pass@, Bearer), and any value that looks random.
 * The same as lpRedact in the hooks (scripts/local-policy.mjs); a test keeps
 * the two equal. Readable names (claude-sonnet-4-5, release-2026-10-10),
 * UUIDs and plain hex (commit hashes) are left alone.
 */
const REDACT = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)|(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])|(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}|(?<![A-Za-z0-9])gh[pousr]_[0-9A-Za-z]{36,}|(?<![A-Za-z0-9])github_pat_[0-9A-Za-z_]{60,}|(?<![A-Za-z0-9])sk-[0-9A-Za-z_-]{20,}|(?<![A-Za-z0-9])xox[abprs]-[0-9A-Za-z-]{20,}|(?<![A-Za-z0-9])npm_[0-9A-Za-z]{36}|(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}|((?<![A-Za-z0-9])[A-Za-z0-9_]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_]*\s*[=:]\s*["']?)[^\s'"&]{6,}|((?:^|\s)--?(?:token|password|passwd|secret|api-key|key)(?:\s+|=)["']?)[^\s'"&-][^\s'"&]{5,}|(\bBearer\s+)[0-9A-Za-z._~+\/-]{16,}=*|(:\/\/[^\s:\/@]+:)[^\s@\/]+(?=@)/gi;
const LOOSE = /[A-Za-z0-9_+.-]{16,}=*/g;
const looksRandom = (t) => !/^[0-9a-f-]+$/i.test(t) && t.split(/[-_.]/).some((p) => p.length >= 16 && /[A-Za-z]/.test(p) && /\d/.test(p));
export function redactSecrets(s) {
  return String(s ?? '')
    .replace(REDACT, (m, _end, kv, flag, bearer, url) => (kv ? `${kv}[redacted]` : flag ? `${flag}[redacted]` : bearer ? `${bearer}[redacted]` : url ? `${url}[redacted]` : '[redacted]'))
    .replace(LOOSE, (t) => (looksRandom(t) ? '[redacted]' : t));
}
