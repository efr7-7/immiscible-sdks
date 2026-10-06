/**
 * Crypto payments: decide, then sign.
 *
 * Immiscible decides; it never holds funds, private keys or seed phrases,
 * and never signs or broadcasts a transaction. Your wallet does that, and
 * these wrappers make sure it does so only after an allow:
 *
 *   decideThenSign(immiscible, payment, sign)
 *       asks POST /v1/actions/authorize, waits for a person if one is asked,
 *       checks the signed receipt covers exactly this transfer (asset,
 *       network, recipient, amount), and only then calls your `sign`.
 *
 *   x402Fetch(immiscible, { pay })
 *       a fetch that answers HTTP 402 Payment Required (x402, versions 1
 *       and 2) by asking Immiscible with the server's payment requirements,
 *       and calls your x402 signer only on allow.
 *       https://github.com/coinbase/x402/blob/main/specs/x402-specification-v1.md
 *       https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
 *
 * Amounts are decimal strings in the asset's own units ("12.50"), never
 * floats; x402's atomic amounts are converted exactly.
 */

import type { Immiscible } from './client.js';
import type { Action, Decision, Provenance } from './types.js';
import { ImmiscibleDeniedError, ImmiscibleError } from './errors.js';
import { verifyReceipt, decodeReceiptUnverified, type VerifyOptions } from './verify.js';

export interface CryptoPayment {
  /** USDC, USDT, EURC, ETH, BTC, SOL and so on. */
  asset: string;
  /** base, ethereum, solana, polygon, arbitrum, bitcoin, or a CAIP-2 id such as eip155:8453. */
  network: string;
  /** In the asset's own units, as a decimal string: "12.50". */
  amount: string;
  /** The address that will receive it. */
  recipient: string;
  recipientName?: string;
  protocol?: { kind: 'x402' | 'invoice' | 'other'; resource?: string; invoice?: string; x402Version?: number };
  summary?: string;
  provenance?: Provenance[];
  idempotencyKey?: string;
}

/** The authorize body for a crypto payment. Immiscible prices it; you never send a money value. */
export function cryptoAction(p: CryptoPayment): Action {
  if (!p || typeof p !== 'object') throw new TypeError('cryptoAction: payment must be an object');
  if (typeof p.amount !== 'string' || !/^\d+(\.\d+)?$/.test(p.amount)) throw new TypeError('cryptoAction: amount must be a decimal string such as "12.50", never a number');
  for (const k of ['asset', 'network', 'recipient'] as const) if (typeof p[k] !== 'string' || !p[k]) throw new TypeError(`cryptoAction: ${k} is required`);
  return {
    type: 'payment',
    summary: p.summary ?? `Pay ${p.amount} ${p.asset.toUpperCase()} to ${p.recipientName ?? p.recipient}`,
    payment: {
      crypto: {
        asset: p.asset, network: p.network, amount: p.amount, recipient: p.recipient,
        ...(p.recipientName ? { recipientName: p.recipientName } : {}),
        ...(p.protocol ? { protocol: p.protocol } : {}),
      },
    } as unknown as Action['payment'],
    ...(p.provenance ? { provenance: p.provenance } : {}),
    ...(p.idempotencyKey ? { idempotencyKey: p.idempotencyKey } : {}),
  };
}

// ------------------------------------------------------------ amounts

function toAtomic(amount: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** 10000n, 6 -> "0.01". Exact. */
export function fromAtomic(atomic: string | bigint, decimals: number): string {
  const n = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const frac = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${n / base}.${frac}` : `${n / base}`;
}

const sameAddress = (a: string, b: string) => (/^0x/i.test(a) ? a.toLowerCase() === String(b).toLowerCase() : a === b);
const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6, EURC: 6, PYUSD: 6, DAI: 18, ETH: 18, BTC: 8, SOL: 9, POL: 18, AVAX: 18 };
const NETWORK_ALIASES: Record<string, string> = {
  'eip155:8453': 'base', 'eip155:84532': 'base-sepolia', 'eip155:1': 'ethereum', 'eip155:42161': 'arbitrum', 'eip155:10': 'optimism',
  'eip155:137': 'polygon', 'eip155:43114': 'avalanche',
};
const netName = (n: string) => NETWORK_ALIASES[n] ?? String(n).toLowerCase();

/**
 * Does a receipt's `cry` claim cover this transfer? Same asset, network and
 * recipient, and an amount no larger than authorised. Returns the problems.
 */
export function receiptCovers(claims: Record<string, any>, p: Pick<CryptoPayment, 'asset' | 'network' | 'amount' | 'recipient'>): string[] {
  const c = claims?.cry;
  if (!c) return ['the receipt is not for a crypto payment'];
  const bad: string[] = [];
  if (String(p.asset).toUpperCase() !== c.ast) bad.push(`it is for ${c.ast}, not ${p.asset}`);
  if (netName(p.network) !== c.net) bad.push(`it is for ${c.net}, not ${p.network}`);
  if (!sameAddress(c.to, p.recipient)) bad.push(`it pays ${c.to}, not ${p.recipient}`);
  const d = DECIMALS[c.ast] ?? 18;
  const want = toAtomic(p.amount, d);
  const have = toAtomic(String(c.amt), d);
  if (want == null || have == null || want > have) bad.push(`it authorises ${c.amt} ${c.ast}, less than ${p.amount}`);
  return bad;
}

export interface DecideThenSignOptions {
  /** How to check the receipt's signature. Default: the client's base URL's published key set. */
  verify?: VerifyOptions;
  /** Wait for a person when one is asked. Default true. */
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Signed {
  /** The transaction hash or signature the network gave, reported back to Immiscible. */
  txHash?: string;
  [k: string]: unknown;
}

/**
 * Ask, then sign. Your `sign` runs only after an allow whose signed
 * receipt covers exactly this transfer; anything else throws
 * ImmiscibleDeniedError and nothing is signed. Afterwards the action is
 * settled (completed with the transaction hash, or failed).
 */
export async function decideThenSign<T extends Signed | void>(
  immiscible: Immiscible,
  payment: CryptoPayment,
  sign: (d: Decision) => Promise<T> | T,
  opts: DecideThenSignOptions = {},
): Promise<T> {
  const d = await immiscible.decide(cryptoAction(payment), { wait: opts.wait, timeoutMs: opts.timeoutMs, signal: opts.signal });
  if (!d.receipt) throw new ImmiscibleDeniedError({ ...d, decision: 'deny', reasons: ['Allowed, but no receipt came back, so nothing is signed.'] } as Decision);
  const v = await verifyReceipt(d.receipt, { issuer: immiscible.baseUrl, ...(opts.verify ?? {}) });
  if (!v.valid) throw new ImmiscibleDeniedError({ ...d, decision: 'deny', reasons: [`The receipt did not verify (${v.reason}), so nothing is signed.`] } as Decision);
  const problems = receiptCovers(v.claims ?? decodeReceiptUnverified(d.receipt).claims, payment);
  if (problems.length) throw new ImmiscibleDeniedError({ ...d, decision: 'deny', reasons: [`The receipt does not cover this transfer: ${problems.join('; ')}.`] } as Decision);
  let out: T;
  try {
    out = await sign(d);
  } catch (err) {
    await settleCrypto(immiscible, d.id, 'failed');
    throw err;
  }
  await settleCrypto(immiscible, d.id, 'completed', (out as Signed | undefined)?.txHash);
  return out;
}

async function settleCrypto(immiscible: Immiscible, id: string, status: 'completed' | 'failed', txHash?: string): Promise<void> {
  try {
    await immiscible.request('POST', `/v1/actions/${encodeURIComponent(id)}/settle`, { body: { status, ...(txHash ? { txHash } : {}) }, retry: true });
  } catch (err) {
    globalThis.console?.warn?.(`[immiscible] could not settle ${id}: ${(err as Error).message}`);
  }
}

// --------------------------------------------------------------- x402

/** One entry of a 402's accepts[], in either version. */
export interface X402Requirements {
  scheme: string;
  network: string;
  /** v2 */
  amount?: string;
  /** v1 */
  maxAmountRequired?: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  resource?: string;
  description?: string;
  extra?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: X402Requirements[];
  [k: string]: unknown;
}

/**
 * Token contracts this wrapper recognises, by network, so an atomic x402
 * amount can be read as money. USDC as Circle publishes it. Anything else
 * is refused unless you add it with `assets`.
 */
export const X402_ASSETS: Record<string, Record<string, { symbol: string; decimals: number }>> = {
  base: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 } },
  'base-sepolia': { '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', decimals: 6 } },
  ethereum: { '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 } },
  arbitrum: { '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 } },
  optimism: { '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 } },
  polygon: { '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6 } },
  avalanche: { '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { symbol: 'USDC', decimals: 6 } },
};

export interface X402Options {
  /**
   * Your x402 signer: given the requirements Immiscible allowed, return the
   * payment header value (base64 JSON), for example from the x402 client
   * library. Called only on allow. Immiscible never sees a key.
   */
  pay: (req: { requirements: X402Requirements; paymentRequired: X402PaymentRequired; decision: Decision }) => Promise<string> | string;
  fetch?: typeof fetch;
  provenance?: Provenance[];
  /** Extra token contracts: { network: { address: { symbol, decimals } } }. */
  assets?: Record<string, Record<string, { symbol: string; decimals: number }>>;
  verify?: VerifyOptions;
  wait?: boolean;
  timeoutMs?: number;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

/** Read a 402: v2 in the PAYMENT-REQUIRED header, v1 in the JSON body. */
export async function readPaymentRequired(res: Response): Promise<X402PaymentRequired | null> {
  const h = res.headers.get('payment-required');
  if (h) {
    try { return b64json(h); } catch { return null; }
  }
  try {
    const body = await res.clone().json();
    return body && Array.isArray(body.accepts) ? body : null;
  } catch {
    return null;
  }
}

/**
 * A fetch that pays x402 resources only when Immiscible allows it. On a
 * 402 it reads the requirements, picks the first "exact" one in a token it
 * recognises, asks Immiscible (asset, network, amount, payTo, resource),
 * and on allow calls `pay` and retries with X-PAYMENT (v1) or
 * PAYMENT-SIGNATURE (v2). The settlement header (X-PAYMENT-RESPONSE or
 * PAYMENT-RESPONSE) is reported back with its transaction hash.
 * A refusal throws ImmiscibleDeniedError; `pay` is never called.
 */
export function x402Fetch(immiscible: Immiscible, opts: X402Options): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const f = opts.fetch ?? ((i: any, init?: RequestInit) => globalThis.fetch(i, init));
  const tokens = (net: string) => ({ ...(X402_ASSETS[net] ?? {}), ...Object.fromEntries(Object.entries(opts.assets?.[net] ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
  return async (input, init = {}) => {
    const first = await f(input, init);
    if (first.status !== 402) return first;
    const pr = await readPaymentRequired(first);
    if (!pr || !Array.isArray(pr.accepts) || !pr.accepts.length) throw new ImmiscibleError('the 402 response carried no payment requirements Immiscible could read', { type: 'x402_unreadable' });
    const pick = pr.accepts.map((r) => ({ r, net: netName(r.network), t: tokens(netName(r.network))[String(r.asset).toLowerCase()] })).find((x) => x.r.scheme === 'exact' && x.t);
    if (!pick) throw new ImmiscibleError('none of the 402 payment options is in a token this wrapper recognises; add it with `assets`', { type: 'x402_unknown_asset' });
    const atomic = pick.r.amount ?? pick.r.maxAmountRequired;
    if (typeof atomic !== 'string' || !/^\d+$/.test(atomic)) throw new ImmiscibleError('the 402 amount is not an atomic integer string', { type: 'x402_unreadable' });
    const resource = pr.resource?.url ?? pick.r.resource ?? String(input);
    const payment: CryptoPayment = {
      asset: pick.t.symbol, network: pick.r.network, amount: fromAtomic(atomic, pick.t.decimals), recipient: pick.r.payTo,
      summary: `Pay ${fromAtomic(atomic, pick.t.decimals)} ${pick.t.symbol} for ${resource}`,
      protocol: { kind: 'x402', resource, x402Version: pr.x402Version },
      ...(opts.provenance ? { provenance: opts.provenance } : {}),
    };
    let settled: Response | null = null;
    await decideThenSign(immiscible, payment, async (decision) => {
      const header = await opts.pay({ requirements: pick.r, paymentRequired: pr, decision });
      const headers = new Headers(init.headers ?? {});
      headers.set(pr.x402Version >= 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT', header);
      settled = await f(input, { ...init, headers });
      const sr = settled.headers.get('payment-response') ?? settled.headers.get('x-payment-response');
      let tx: string | undefined;
      if (sr) {
        try { tx = b64json(sr)?.transaction; } catch { tx = undefined; }
      }
      if (!settled.ok) throw new ImmiscibleError(`the resource answered ${settled.status} after payment`, { type: 'x402_failed' });
      return { txHash: tx };
    }, { verify: opts.verify, wait: opts.wait, timeoutMs: opts.timeoutMs });
    return settled as unknown as Response;
  };
}
