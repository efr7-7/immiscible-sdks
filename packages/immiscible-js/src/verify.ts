/**
 * Receipts: check that an agent's action was authorised, within what limits,
 * before you ship, pay out or let a tool run.
 *
 * Offline, a receipt is checked with WebCrypto Ed25519 against the issuer's
 * key set: fetched from `<issuer>/.well-known/immiscible-keys.json` and cached
 * (refetched when an unknown key id appears, which is how rotation reaches
 * you), or pinned: a key set you hold and pass in, so nothing is fetched at
 * all. The header is checked before any crypto runs: EdDSA only, the receipt
 * type, a key id the issuer publishes. `alg: none` and HMAC confusion fail
 * there.
 *
 * Offline checks cannot see replays. For payments, also check online once
 * per order (`online: true`): the issuer marks the receipt seen, and a second
 * check reports it replayed.
 *
 * Works wherever `fetch` and WebCrypto Ed25519 exist: Node 18.4+, Deno, Bun,
 * Cloudflare Workers and current browsers.
 */

/** The receipt's JOSE `typ`. A wire name, kept from the protocol's first version. */
export const RECEIPT_TYP = 'assay-receipt+jwt';
/** Where an issuer publishes its receipt keys. */
export const JWKS_PATH = '/.well-known/immiscible-keys.json';
const ACCEPTED_ALGS = new Set(['EdDSA', 'Ed25519']);
const B64U = /^[A-Za-z0-9_-]+$/;
const JWKS_TTL_MS = 5 * 60_000;
const JWKS_MIN_REFETCH_MS = 30_000;
const MAX_TOKEN = 8192;

export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export interface Jwks {
  keys: Jwk[];
}

export interface ReceiptClaims {
  iss: string;
  sub: string;
  act: string;
  typ: string;
  amt?: number;
  cur?: string;
  mer?: string;
  mdt?: string;
  hum?: boolean;
  /** Receipt version: 2 binds the decision (aud, crt, mdh, prv, tnt). Absent on version 1. */
  ver?: number;
  /** v2: the party the receipt was issued for (a payment's merchant host). */
  aud?: string;
  /** v2: the basket's digest, cartDigest(cart, currency). */
  crt?: string;
  /** v2: SHA-256 of the signed mandate it was allowed under. */
  mdh?: string;
  /** v2: what shaped the request: sources the agent declared and the gateway observed. */
  prv?: { declared: string[]; observed: string[]; mismatch: boolean };
  /** v2: untrusted content was observed in the agent's session. */
  tnt?: boolean;
  iat: number;
  exp: number;
  jti: string;
  [k: string]: unknown;
}

export interface Expect {
  /** Exact, in minor units. */
  amount?: number;
  currency?: string;
  /** A domain or a list of them. */
  merchant?: string | string[];
  type?: string;
  agent?: string;
  mandate?: string;
  /** Require that a person approved this specific action. */
  humanApproved?: boolean;
  /** Receipt v2: the party you are (a payment's merchant host), checked exactly against `aud`. */
  audience?: string;
  /** Receipt v2: the basket you are about to charge for; its digest must equal `crt`. */
  cart?: CartLine[];
  /** Receipt v2: or the basket's digest, from cartDigest(). */
  cartDigest?: string;
}

/** One line of a basket: the merchant's SKU or the product's URL, a whole quantity and a unit price in minor units. */
export interface CartLine {
  sku?: string;
  url?: string;
  quantity: number;
  unitPrice: number;
  /** For people; not part of the digest. */
  name?: string;
}

export interface VerifyOptions {
  /** The Immiscible URL you trust. Required unless you pin `jwks` (and then it is still checked against `iss` when given). */
  issuer?: string;
  /** A pinned key set: an object or its JSON text. Nothing is fetched. */
  jwks?: Jwks | string;
  /** Fetch keys from here instead of `<issuer>/.well-known/immiscible-keys.json`. */
  jwksUrl?: string;
  expect?: Expect;
  /** Also call POST /v1/verify (single use). For payments, do. Needs `issuer` or `baseUrl`. */
  online?: boolean;
  /** Where the online check goes, when it is not `issuer`. */
  baseUrl?: string;
  /** Default 60. */
  clockSkewSec?: number;
  maxAgeSec?: number;
  /** Seconds since the epoch, or a Date. For tests. */
  now?: number | Date;
  /** Check `iss` against `issuer`. Default true. */
  checkIssuer?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export type VerifyReason =
  | 'malformed' | 'unsupported_alg' | 'wrong_typ' | 'unsupported_crit' | 'missing_kid' | 'unknown_kid' | 'jwks_unavailable'
  | 'bad_signature' | 'missing_claim' | 'expired' | 'issued_in_future' | 'not_yet_valid' | 'too_old' | 'wrong_issuer'
  | 'type_mismatch' | 'amount_mismatch' | 'currency_mismatch' | 'merchant_mismatch' | 'agent_mismatch' | 'mandate_mismatch'
  | 'human_required' | 'audience_mismatch' | 'cart_mismatch' | 'replayed' | 'revoked' | 'rejected_by_issuer' | 'verify_unavailable';

export interface VerifyResult {
  valid: boolean;
  /** A stable code when not valid. */
  reason: VerifyReason | null;
  /** Plain English when not valid. */
  message: string | null;
  header: Record<string, unknown> | null;
  /** Only ever claims that were verified. */
  claims: ReceiptClaims | null;
  /** Present after an online check. */
  replayed?: boolean;
  revoked?: boolean;
}

/** Plain-English messages for each machine reason. */
export const REASONS: Readonly<Record<VerifyReason, string>> = Object.freeze({
  malformed: 'not a compact JWS (three base64url parts of JSON)',
  unsupported_alg: 'the algorithm is not EdDSA; Immiscible receipts are only ever EdDSA',
  wrong_typ: `the token type is not ${RECEIPT_TYP}`,
  unsupported_crit: 'the token carries a critical header this verifier does not understand',
  missing_kid: 'the token names no key id',
  unknown_kid: 'signed by a key the issuer does not publish',
  jwks_unavailable: "the issuer's public keys could not be fetched, so nothing can be trusted",
  bad_signature: 'the signature does not match: the receipt was altered or not issued by Immiscible',
  missing_claim: 'a required claim is missing',
  expired: 'the receipt has expired',
  issued_in_future: 'the receipt claims to be issued in the future',
  not_yet_valid: 'the receipt is not valid yet',
  too_old: 'the receipt is older than you allow',
  wrong_issuer: 'issued by a different Immiscible deployment than the one you trust',
  type_mismatch: 'the receipt is for a different kind of action',
  amount_mismatch: 'the authorised amount does not match this order',
  currency_mismatch: 'the authorised currency does not match this order',
  merchant_mismatch: 'the receipt was authorised for a different merchant',
  agent_mismatch: 'the receipt was issued to a different agent',
  mandate_mismatch: 'the receipt was allowed under a different mandate',
  human_required: 'a person did not approve this specific action',
  audience_mismatch: 'the receipt was issued for a different party',
  cart_mismatch: 'the receipt was authorised for a different basket, or names none',
  replayed: 'this receipt has already been used; receipts are single use',
  revoked: 'the receipt was revoked by its owner',
  rejected_by_issuer: 'the issuer rejected this receipt',
  verify_unavailable: 'the online check could not be completed, so the receipt is not accepted',
});

class Fail extends Error {
  reason: VerifyReason;
  constructor(reason: VerifyReason, detail?: string) {
    super(detail ?? REASONS[reason] ?? reason);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- helpers

const utf8 = new TextEncoder();

function b64uToBytes(s: string): Uint8Array {
  if (typeof s !== 'string' || !B64U.test(s)) throw new Fail('malformed');
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(pad);
  } catch {
    throw new Fail('malformed');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Only the canonical spelling of these bytes: unused low bits in the last character must be zero, so one
  // signature has one spelling and a receipt cannot be re-presented as a "different" string.
  if (btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== s) throw new Fail('malformed');
  return out;
}

function jsonPart(s: string): Record<string, any> {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64uToBytes(s)));
  } catch (err) {
    if (err instanceof Fail) throw err;
    throw new Fail('malformed');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Fail('malformed');
  return v as Record<string, any>;
}

let subtlePromise: Promise<SubtleCrypto> | undefined;
/** WebCrypto, from the global where it exists, or node:crypto on older Node. */
function subtle(): Promise<SubtleCrypto> {
  subtlePromise ??= (async () => {
    if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
    const spec = 'node:crypto'; // a variable, so browser bundlers leave it alone
    const m = await import(spec);
    return m.webcrypto.subtle as SubtleCrypto;
  })();
  return subtlePromise;
}

const trimSlash = (u: string): string => String(u).replace(/\/+$/, '');

function normaliseDomain(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (s.startsWith('www.')) s = s.slice(4);
  return s || null;
}

// ------------------------------------------------------------------ JWKS

interface CacheEntry {
  at: number;
  lastFetch: number;
  keys: Map<string, Promise<CryptoKey>>;
  inflight: Promise<void> | null;
}

const jwksCache = new Map<string, CacheEntry>();

/** Forget every cached key set (for tests, or after you learn of a revocation). */
export function clearJwksCache(): void {
  jwksCache.clear();
}

function importJwk(jwk: Jwk): Promise<CryptoKey> {
  return subtle().then((s) => s.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x, ext: true } as JsonWebKey, { name: 'Ed25519' }, false, ['verify']));
}

function keysFrom(jwks: unknown): Map<string, Promise<CryptoKey>> {
  const keys = new Map<string, Promise<CryptoKey>>();
  const list = Array.isArray((jwks as Jwks)?.keys) ? (jwks as Jwks).keys : [];
  for (const k of list) {
    if (!k || k.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.x !== 'string' || typeof k.kid !== 'string') continue;
    if (k.alg && !ACCEPTED_ALGS.has(k.alg)) continue;
    if (k.use && k.use !== 'sig') continue;
    const p = importJwk(k);
    p.catch(() => {}); // surfaced when the key is actually used
    keys.set(k.kid, p);
  }
  return keys;
}

/** Parse a pinned key set (object or JSON text) and check it holds at least one usable key. */
export function pinJwks(jwks: Jwks | string): Jwks {
  const doc = typeof jwks === 'string' ? JSON.parse(jwks) : jwks;
  const usable = (Array.isArray(doc?.keys) ? doc.keys : []).filter((k: Jwk) => k?.kty === 'OKP' && k?.crv === 'Ed25519' && typeof k?.x === 'string' && typeof k?.kid === 'string');
  if (!usable.length) throw new TypeError('pinJwks: the key set holds no Ed25519 signing key (kty OKP, crv Ed25519, with x and kid)');
  return { keys: usable };
}

/**
 * Fetch an issuer's key set once, to pin it: store the result with your
 * configuration and pass it as `jwks`, and receipts verify with no network.
 */
export async function fetchJwks(issuer: string, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Jwks> {
  const f = opts.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(i, init));
  const res = await f(`${trimSlash(issuer)}${JWKS_PATH}`, { headers: { accept: 'application/json' }, signal: opts.signal });
  if (!res.ok) throw new Error(`fetchJwks: ${issuer} answered ${res.status}`);
  return pinJwks(await res.json());
}

async function fetchJwksDoc(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new Fail('jwks_unavailable', `${REASONS.jwks_unavailable} (${(err as Error)?.message ?? err})`);
  }
  if (!res.ok) throw new Fail('jwks_unavailable', `${REASONS.jwks_unavailable} (HTTP ${res.status})`);
  try {
    return await res.json();
  } catch {
    throw new Fail('jwks_unavailable', `${REASONS.jwks_unavailable} (not JSON)`);
  }
}

async function resolveKey(kid: string, o: { pinned: Map<string, Promise<CryptoKey>> | null; jwksUrl: string | null; fetchImpl: typeof fetch; nowMs: number }): Promise<Promise<CryptoKey>> {
  if (o.pinned) {
    const k = o.pinned.get(kid);
    if (!k) throw new Fail('unknown_kid');
    return k;
  }
  const url = o.jwksUrl as string;
  let entry = jwksCache.get(url);
  const stale = !entry || o.nowMs - entry.at > JWKS_TTL_MS;
  const missing = !!entry && !entry.keys.has(kid) && o.nowMs - entry.lastFetch > JWKS_MIN_REFETCH_MS;
  if (stale || missing) {
    if (!entry?.inflight) {
      const inflight = fetchJwksDoc(url, o.fetchImpl).then(
        (doc) => {
          jwksCache.set(url, { at: o.nowMs, lastFetch: o.nowMs, keys: keysFrom(doc), inflight: null });
        },
        (err) => {
          const e = jwksCache.get(url);
          if (e) {
            e.inflight = null;
            e.lastFetch = o.nowMs;
          }
          throw err;
        },
      );
      if (entry) entry.inflight = inflight;
      else jwksCache.set(url, { at: 0, lastFetch: o.nowMs, keys: new Map(), inflight });
      entry = jwksCache.get(url) as CacheEntry;
    }
    try {
      await entry.inflight;
    } catch (err) {
      // A stale cache still beats nothing while the issuer is briefly down,
      // but only for keys already held; an unknown kid fails closed.
      if (!entry.keys.has(kid)) {
        if (entry.at === 0) jwksCache.delete(url);
        throw err;
      }
    }
    entry = jwksCache.get(url);
  }
  const k = entry?.keys.get(kid);
  if (!k) throw new Fail('unknown_kid');
  return k;
}

// ------------------------------------------------------------ bindings

/** Deterministic JSON: sorted keys, no whitespace. The bytes a digest covers (as the server's canonicalJson). */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** The canonical bytes of a basket: schema, currency, and each line's sku, url, quantity and unit price, in order. */
export function canonicalCart(cart: CartLine[], currency: string): string {
  if (!Array.isArray(cart) || !cart.length) throw new TypeError('canonicalCart: the cart must list at least one line');
  const items = cart.map((l, i) => {
    const sku = typeof l?.sku === 'string' ? l.sku.trim() : undefined;
    const url = typeof l?.url === 'string' ? l.url.trim() : undefined;
    if (!sku && !url) throw new TypeError(`canonicalCart: line ${i} needs a sku or a url`);
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1 || !Number.isSafeInteger(l.unitPrice) || l.unitPrice < 0) throw new TypeError(`canonicalCart: line ${i} needs a whole quantity of 1 or more and a whole unitPrice of 0 or more`);
    return { ...(sku ? { sku } : {}), ...(url ? { url } : {}), quantity: l.quantity, unitPrice: l.unitPrice };
  });
  return canonicalJson({ schema: 'assay.cart.v1', currency: String(currency ?? '').toUpperCase(), items });
}

/** SHA-256 of canonicalCart, base64url: what a v2 receipt's `crt` claim holds for that basket. */
export async function cartDigest(cart: CartLine[], currency: string): Promise<string> {
  const bytes = new Uint8Array(await (await subtle()).digest('SHA-256', utf8.encode(canonicalCart(cart, currency)) as BufferSource));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function checkExpect(claims: Record<string, any>, expect?: Expect): Promise<void> {
  if (!expect) return;
  if (expect.type != null && claims.typ !== expect.type) throw new Fail('type_mismatch');
  if (expect.amount != null && claims.amt !== expect.amount) {
    throw new Fail('amount_mismatch', `${REASONS.amount_mismatch}: authorised ${claims.amt ?? 'nothing'}, order is ${expect.amount}`);
  }
  if (expect.currency != null && String(claims.cur ?? '').toUpperCase() !== String(expect.currency).toUpperCase()) throw new Fail('currency_mismatch');
  if (expect.merchant != null) {
    const want = ([] as string[]).concat(expect.merchant).map(normaliseDomain);
    if (!want.includes(normaliseDomain(claims.mer))) throw new Fail('merchant_mismatch', `${REASONS.merchant_mismatch}: ${claims.mer ?? 'none'}`);
  }
  if (expect.agent != null && claims.sub !== expect.agent) throw new Fail('agent_mismatch');
  if (expect.mandate != null && claims.mdt !== expect.mandate) throw new Fail('mandate_mismatch');
  if (expect.humanApproved === true && claims.hum !== true) throw new Fail('human_required');
  if (expect.audience != null && (typeof claims.aud !== 'string' || normaliseDomain(claims.aud) !== normaliseDomain(expect.audience))) {
    throw new Fail('audience_mismatch', `${REASONS.audience_mismatch}: ${claims.aud ?? 'none'}`);
  }
  if (expect.cart != null || expect.cartDigest != null) {
    let want: string | null = typeof expect.cartDigest === 'string' ? expect.cartDigest : null;
    if (!want && expect.cart != null) {
      try {
        want = await cartDigest(expect.cart, String(claims.cur ?? ''));
      } catch {
        want = null;
      }
    }
    if (!want || typeof claims.crt !== 'string' || want !== claims.crt) throw new Fail('cart_mismatch');
  }
}

const ok = (header: Record<string, unknown>, claims: ReceiptClaims): VerifyResult => ({ valid: true, reason: null, message: null, header, claims });
const bad = (err: Fail): VerifyResult => ({ valid: false, reason: err.reason, message: err.message, header: null, claims: null });

/**
 * Read a receipt's header and claims WITHOUT checking anything. For logs and
 * debugging only; never decide anything on the result.
 */
export function decodeReceiptUnverified(token: string): { header: Record<string, any>; claims: Record<string, any> } {
  const [h, p] = String(token).split('.');
  return { header: jsonPart(h), claims: jsonPart(p) };
}

/**
 * Verify a receipt. Never throws for a bad receipt: the result says
 * `valid: false` with a `reason` code and a plain-English `message`. Throws
 * TypeError only when called with nothing to trust (no issuer, no key set).
 */
export async function verifyReceipt(token: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  const { issuer, expect, clockSkewSec = 60, maxAgeSec, checkIssuer = true } = options;
  if (!issuer && !options.jwks && !options.jwksUrl) {
    throw new TypeError('verifyReceipt: pass { issuer } (the Immiscible URL you trust) or a pinned { jwks }. Never trust the iss inside the token to say where its keys are.');
  }
  const pinned = options.jwks ? keysFrom(pinJwks(options.jwks)) : null;
  const fetchImpl = options.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(i, init));
  const nowMs = options.now instanceof Date ? options.now.getTime() : typeof options.now === 'number' ? options.now * 1000 : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  let result: VerifyResult;
  try {
    if (typeof token !== 'string' || token.length > MAX_TOKEN) throw new Fail('malformed');
    const parts = token.trim().split('.');
    if (parts.length !== 3) throw new Fail('malformed');
    const header = jsonPart(parts[0]);
    if (!ACCEPTED_ALGS.has(header.alg)) throw new Fail('unsupported_alg', `${REASONS.unsupported_alg} (got ${String(header.alg).slice(0, 20)})`);
    const typ = String(header.typ ?? '').toLowerCase().replace(/^application\//, '');
    if (typ !== RECEIPT_TYP) throw new Fail('wrong_typ');
    if (header.crit !== undefined) throw new Fail('unsupported_crit');
    if (typeof header.kid !== 'string' || !header.kid) throw new Fail('missing_kid');
    if (!parts[2]) throw new Fail('bad_signature');
    const sig = b64uToBytes(parts[2]);
    if (sig.length !== 64) throw new Fail('bad_signature');

    const jwksUrl = options.jwksUrl ?? (issuer ? `${trimSlash(issuer)}${JWKS_PATH}` : null);
    const key = await resolveKey(header.kid, { pinned, jwksUrl, fetchImpl, nowMs });
    let verified = false;
    try {
      verified = await (await subtle()).verify({ name: 'Ed25519' }, await key, sig as BufferSource, utf8.encode(`${parts[0]}.${parts[1]}`));
    } catch {
      verified = false;
    }
    if (!verified) throw new Fail('bad_signature');

    const claims = jsonPart(parts[1]);
    if (!Number.isFinite(claims.exp)) throw new Fail('missing_claim', `${REASONS.missing_claim}: exp`);
    if (nowSec - clockSkewSec >= claims.exp) throw new Fail('expired');
    if (claims.iat != null) {
      if (!Number.isFinite(claims.iat)) throw new Fail('missing_claim', `${REASONS.missing_claim}: iat`);
      if (claims.iat > nowSec + clockSkewSec) throw new Fail('issued_in_future');
      if (maxAgeSec != null && nowSec - claims.iat > maxAgeSec + clockSkewSec) throw new Fail('too_old');
    }
    if (claims.nbf != null && Number.isFinite(claims.nbf) && claims.nbf > nowSec + clockSkewSec) throw new Fail('not_yet_valid');
    if (issuer && checkIssuer && trimSlash(claims.iss ?? '') !== trimSlash(issuer)) {
      throw new Fail('wrong_issuer', `${REASONS.wrong_issuer} (${String(claims.iss).slice(0, 80)})`);
    }
    await checkExpect(claims, expect);
    result = ok(header, claims as ReceiptClaims);
  } catch (err) {
    if (err instanceof Fail) return bad(err);
    throw err;
  }
  if (options.online) {
    const base = options.baseUrl ?? issuer;
    if (!base) throw new TypeError('verifyReceipt: online: true needs { issuer } or { baseUrl }');
    const on = await verifyOnline(token, { baseUrl: base, fetch: options.fetch, signal: options.signal, expect });
    if (!on.valid) return { ...on, header: null, claims: null };
    return { ...result, replayed: false };
  }
  return result;
}

/**
 * Verify with the issuer, which also marks the receipt seen: the first check
 * of a receipt is the only one that passes. Use it once per order. Fails
 * closed: if the issuer cannot be reached, the receipt is not valid.
 */
export async function verifyOnline(token: string, opts: { baseUrl?: string; issuer?: string; fetch?: typeof fetch; signal?: AbortSignal; expect?: Expect } = {}): Promise<VerifyResult> {
  const base = opts.baseUrl ?? opts.issuer;
  if (!base) throw new TypeError('verifyOnline: pass { baseUrl } (the Immiscible URL you trust)');
  const f = opts.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(i, init));
  // What the issuer can check before it marks the receipt used: a receipt for
  // another basket, party, merchant or a smaller amount is refused there and
  // stays unused. Everything is checked again here, exactly, afterwards.
  const e = opts.expect;
  // Checked here first, on the claims as written: a receipt that cannot cover this order is refused without
  // asking the issuer, so it is not used up by a check the issuer does not make (type, agent, rule, person).
  if (e) {
    let pre: Record<string, any> | null = null;
    try { pre = decodeReceiptUnverified(token).claims; } catch { pre = null; }
    if (pre) {
      try { await checkExpect(pre, e); } catch (err) {
        if (err instanceof Fail) return { ...bad(err), replayed: false };
        throw err;
      }
    }
  }
  const serverExpect: Record<string, unknown> = {};
  if (e?.amount != null) serverExpect.amount = e.amount;
  if (e?.currency != null) serverExpect.currency = String(e.currency).toUpperCase();
  if (typeof e?.merchant === 'string') serverExpect.merchant = e.merchant;
  if (e?.audience != null) serverExpect.audience = e.audience;
  if (e?.cartDigest != null) serverExpect.cartDigest = e.cartDigest;
  else if (e?.cart != null) serverExpect.cart = e.cart;
  let body: any;
  try {
    const res = await f(`${trimSlash(base)}/v1/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(Object.keys(serverExpect).length ? { receipt: token, expect: serverExpect } : { receipt: token }),
      signal: opts.signal,
    });
    body = await res.json().catch(() => null);
    if (!body || typeof body.valid !== 'boolean') throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? err;
    return { valid: false, reason: 'verify_unavailable', message: `${REASONS.verify_unavailable} (${(err as Error)?.message ?? err})`, header: null, claims: null };
  }
  if (body.replayed) {
    return { valid: false, reason: 'replayed', message: body.reason ?? REASONS.replayed, replayed: true, header: null, claims: body.claims ?? null };
  }
  if (!body.valid) {
    const code = Array.isArray(body.codes) ? body.codes.find((c: string) => c in REASONS) : undefined;
    const reason: VerifyReason = body.expired ? 'expired' : body.revoked ? 'revoked' : (code as VerifyReason | undefined) ?? 'rejected_by_issuer';
    return { valid: false, reason, message: body.reason ?? REASONS[reason], header: null, claims: null, ...(body.revoked ? { revoked: true } : {}) };
  }
  try {
    await checkExpect(body.claims ?? {}, opts.expect);
  } catch (err) {
    if (err instanceof Fail) return { ...bad(err), replayed: false };
    throw err;
  }
  return { valid: true, reason: null, message: null, header: null, claims: body.claims, replayed: false };
}
