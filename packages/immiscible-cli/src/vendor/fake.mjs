// Copied from @immiscible/sdk (dist/esm/testing.js) by scripts/sync-vendor.mjs. Do not edit here.
/**
 * A fake Immiscible for tests and demos. Node only (node:http, node:crypto).
 *
 *   import { startFakeImmiscible } from '@immiscible/sdk/testing';
 *   const fake = await startFakeImmiscible();
 *   const immiscible = new Immiscible({ apiKey: fake.agentKey, baseUrl: fake.url });
 *
 * It speaks the same HTTP contract as the real server and signs real Ed25519
 * receipts, so verifiers are tested against real signatures. Its policy is a
 * small, readable imitation of a groceries mandate and a tools mandate: it is
 * NOT the real policy engine, and passing against it proves your
 * integration, not your mandate.
 *
 * Also imitated, in miniature:
 *   - the gateway: /v1/chat/completions and /anthropic/v1/messages, with
 *     server-issued sessions (x-immiscible-session) and observed provenance
 *     (web tool output in a session taints it). The fake model answers
 *     "ok", or, when the last user message says `CALL <tool> <json args>`,
 *     calls that tool, then reports the tool's result.
 *   - W3C trace context: a valid traceparent is continued and echoed back.
 *   - the MCP proxy at /mcp/proxy/fake-shop: `search` (allowed) and
 *     `buy` ({ amount, merchant }, judged as a payment).
 *   - a control plane a person would use: POST /__fake/actions/:id/approve|deny.
 */
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as edSign, verify as edVerify, randomBytes, createHash } from 'node:crypto';
const b64u = (b) => Buffer.from(b).toString('base64url');
const rid = (p) => `${p}_${randomBytes(8).toString('hex')}`;
export const DEFAULT_MANDATE = Object.freeze({
    id: 'mdt_fake_groceries',
    title: 'Weekly groceries',
    currency: 'GBP',
    perTransaction: 15000,
    approveAbove: 8000,
    merchants: ['tesco.com', 'ocado.com', 'sainsburys.co.uk'],
    fields: ['address', 'email'],
    recipients: ['tesco.com', 'ocado.com'],
    blockedDomains: ['evil.example'],
    approveTools: /\b(delete|drop|transfer|deploy)\b/i,
});
const VAULT = { address: '1 Example Street, London', email: 'person@example.com', name: 'A. Person' };
const KNOWN = ['amazon.com', 'amazon.co.uk', 'paypal.com', 'apple.com', 'google.com', 'ebay.com'];
const INJECTION = /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|all|your)\b.{0,25}\binstructions?\b|\bgift\s?cards?\b|\burgent(ly)?\b.{0,40}\b(wire|transfer)\b/i;
/** Session clients the real server accepts (a subset of its client registry). */
const KNOWN_CLIENTS = new Set(['custom', 'mcp', 'claude-code', 'cursor', 'openai-sdk', 'anthropic-sdk', 'langchain', 'vercel-ai', 'cline', 'aider', 'copilot', 'devin', 'zed']);
const TRACEPARENT_RX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
function editDistance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++)
        dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return dp[a.length][b.length];
}
const host = (d) => (typeof d === 'string' ? d.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '') : '');
const money = (amt, cur) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(amt / 100);
export async function startFakeImmiscible(opts = {}) {
    const mandate = { ...DEFAULT_MANDATE, ...(opts.mandate ?? {}) };
    const agentKey = opts.agentKey ?? 'ask_fake_agent_key';
    const agentId = opts.agentId ?? 'agt_fake';
    const ttl = opts.receiptTtlSec ?? 300;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    const kid = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url').slice(0, 22);
    const actions = new Map();
    const byIdem = new Map();
    const seen = new Set();
    const issued = new Set();
    const settlements = [];
    const outcomes = [];
    const requests = [];
    const tainted = new Map();
    const issuedSessions = new Set();
    const proxyCalls = new Map();
    const failures = new Map();
    let upstreamCalls = 0;
    let url = '';
    function taintSession(sid, source = 'web') {
        if (!tainted.has(sid))
            tainted.set(sid, new Set());
        tainted.get(sid).add(source);
    }
    /** Read a model request for web tool output, as the real gateway does (much simplified). */
    function observe(body, sessionId) {
        if (!sessionId)
            return;
        const names = new Map();
        let dirty = false;
        const msgs = Array.isArray(body?.messages) ? body.messages : [];
        for (const m of msgs) {
            for (const b of Array.isArray(m?.content) ? m.content : [])
                if (b?.type === 'tool_use')
                    names.set(b.id, b.name);
            for (const c of Array.isArray(m?.tool_calls) ? m.tool_calls : [])
                names.set(c.id, c.function?.name);
        }
        const web = (n) => /fetch|search|web|browse/i.test(n ?? 'unknown');
        for (const m of msgs) {
            for (const b of Array.isArray(m?.content) ? m.content : [])
                if (b?.type === 'tool_result' && web(names.get(b.tool_use_id)))
                    dirty = true;
            if (m?.role === 'tool' && web(names.get(m.tool_call_id)))
                dirty = true;
        }
        if (dirty)
            taintSession(sessionId, 'web');
        else if (!tainted.has(sessionId))
            tainted.set(sessionId, new Set());
    }
    function mint(claims, { header = {}, key = privateKey } = {}) {
        const h = { alg: 'EdDSA', kid, typ: 'assay-receipt+jwt', ...header };
        const input = `${b64u(JSON.stringify(h))}.${b64u(JSON.stringify(claims))}`;
        return `${input}.${b64u(edSign(null, Buffer.from(input), key))}`;
    }
    function issueReceipt(a, human) {
        const iat = Math.floor(Date.now() / 1000);
        const p = a.request.payment;
        const claims = {
            iss: url, sub: agentId, act: a.id, typ: a.type,
            ...(p ? { amt: p.amount, cur: p.currency, mer: host(p.merchant?.domain) } : {}),
            ...(a.type === 'data.release' ? { mer: host(a.request.data.recipient), fld: a.grant } : {}),
            ...(a.type === 'tool.call' && a.request.target?.domain ? { mer: host(a.request.target.domain) } : {}),
            mdt: mandate.id, hum: human, iat, exp: iat + ttl, jti: b64u(randomBytes(18)),
        };
        issued.add(claims.jti);
        a.receipt = mint(claims);
        a.expiresAt = new Date((iat + ttl) * 1000).toISOString();
        a.human = human;
    }
    function evaluate(req) {
        const signals = [];
        const reasons = [];
        const declared = Array.isArray(req.provenance) ? req.provenance : [];
        const seenIn = req.session?.id ? [...(tainted.get(req.session.id) ?? [])] : [];
        const declaredTrusted = declared.length > 0 && declared.every((p) => ['user', 'agent'].includes(p?.source));
        const prov = [...declared, ...seenIn.map((source) => ({ source, detail: 'seen by the gateway' }))];
        const untrusted = !prov.length || prov.some((p) => !['user', 'agent'].includes(p?.source));
        const mismatch = seenIn.length && declaredTrusted
            ? { id: 'provenance_mismatch', severity: 'high', effect: 'approval', detail: `the agent declared only trusted sources, but the gateway saw ${seenIn.join(', ')} content enter this session` }
            : null;
        const text = [req.summary, ...prov.map((p) => p?.detail)].filter(Boolean).join(' ');
        const deny = (sig, detail, reason) => {
            signals.push({ id: sig, severity: 'high', detail });
            reasons.push(reason);
            return { decision: 'deny', reasons, signals };
        };
        if (req.type === 'payment') {
            const p = req.payment ?? {};
            const d = host(p.merchant?.domain);
            if (!mandate.merchants.includes(d)) {
                const near = [...mandate.merchants, ...KNOWN].find((k) => editDistance(k, d) <= 2);
                if (near)
                    return deny('lookalike_domain', `${d} looks like ${near}`, `${d} looks like ${near}; lookalike domains are refused`);
            }
            if (p.currency !== mandate.currency)
                return deny('currency_mismatch', `${p.currency} is not ${mandate.currency}`, `the mandate is in ${mandate.currency}`);
            if (p.amount > mandate.perTransaction) {
                return deny('over_transaction', 'above the per-transaction limit', `${money(p.amount, p.currency)} is above ${money(mandate.perTransaction, p.currency)} per transaction in ${mandate.title}`);
            }
            reasons.push(`within ${mandate.title}: ${money(p.amount, p.currency)} of ${money(mandate.perTransaction, p.currency)} per transaction`);
            if (mismatch)
                signals.push(mismatch);
            if (untrusted)
                signals.push({ id: 'rule_of_two', severity: 'high', detail: 'untrusted input, money, and an external effect in one request' });
            if (INJECTION.test(text))
                signals.push({ id: 'injection_language', severity: 'high', detail: 'the request carries instruction-override language' });
            if (p.amount > mandate.approveAbove) {
                signals.push({ id: 'approve_above', severity: 'medium', detail: 'above the approval threshold' });
                reasons.splice(0, reasons.length, `${money(p.amount, p.currency)} is above the ${money(mandate.approveAbove, p.currency)} you asked to approve in ${mandate.title}`);
            }
            if (!mandate.merchants.includes(d))
                signals.push({ id: 'new_merchant', severity: 'medium', detail: `${d} is new` });
            return { decision: signals.length ? 'approval_required' : 'allow', reasons, signals };
        }
        if (req.type === 'tool.call') {
            const d = host(req.target?.domain);
            if (d && mandate.blockedDomains.includes(d))
                return deny('recipient_not_allowed', `${d} is blocked`, `no mandate lets this agent reach ${d}`);
            if (mismatch)
                signals.push(mismatch);
            if (mandate.approveTools.test(String(req.summary ?? '')))
                signals.push({ id: 'sensitive_tool', severity: 'medium', detail: 'this tool call changes something that matters' });
            reasons.push(signals.length ? 'a person must approve this tool call' : `${d || 'the tool'} is covered by the fake tools mandate`);
            return { decision: signals.length ? 'approval_required' : 'allow', reasons, signals };
        }
        if (req.type === 'data.release') {
            const dd = req.data ?? {};
            const r = host(dd.recipient);
            if (!mandate.recipients.includes(r))
                return deny('recipient_not_allowed', `${r} is not covered`, `no mandate lets this agent share data with ${r}`);
            const extra = (dd.fields ?? []).filter((f) => !mandate.fields.includes(f));
            if (extra.length)
                return deny('no_mandate', `fields ${extra.join(', ')}`, `no mandate covers ${extra.join(', ')}`);
            reasons.push(`${(dd.fields ?? []).join(', ')} may go to ${r}`);
            return { decision: 'allow', reasons, signals, grant: dd.fields };
        }
        return deny('no_mandate', 'nothing authorises this action type', `no mandate lets this agent do ${req.type}`);
    }
    const out = (a, extra = {}) => {
        const o = { id: a.id, decision: a.decision, status: a.status, reasons: a.reasons, mandateId: a.decision === 'deny' ? null : mandate.id, risk: { score: Math.min(100, a.signals.length * 30), signals: a.signals } };
        if (a.decision === 'allow' && a.receipt)
            Object.assign(o, { receipt: a.receipt, expiresAt: a.expiresAt, human: a.human });
        if (a.decision === 'approval_required') {
            o.approval = { id: a.approvalId, url: `${url}/app/approvals/${a.approvalId}`, expiresAt: a.approvalExpiresAt };
            o.expiresAt = a.approvalExpiresAt;
        }
        if (a.settledAt)
            o.settlement = { status: a.status, amount: a.settledAmount, at: a.settledAt, incident: a.incident };
        return { ...o, ...extra };
    };
    function authorize(body) {
        if (!body?.type || !body?.summary)
            return { status: 400, json: { error: { type: 'invalid_request', message: 'type and summary are required' } } };
        if (body.type === 'payment' && !Number.isSafeInteger(body.payment?.amount)) {
            return { status: 400, json: { error: { type: 'invalid_request', message: 'payment.amount must be a whole number of minor units' } } };
        }
        if (body.session != null && (typeof body.session.id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(body.session.id))) {
            return { status: 400, json: { error: { type: 'invalid_request', message: 'session.id must be 1 to 128 printable characters with no spaces' } } };
        }
        if (body.session?.client != null && !KNOWN_CLIENTS.has(String(body.session.client))) {
            return { status: 400, json: { error: { type: 'invalid_request', message: 'session.client must be a known client id such as claude-code, openai-sdk or custom' } } };
        }
        if (body.idempotencyKey && byIdem.has(body.idempotencyKey))
            return { json: out(actions.get(byIdem.get(body.idempotencyKey)), { idempotentReplay: true }) };
        const r = evaluate(body);
        const a = {
            id: rid('act'), type: body.type, request: body, decision: r.decision, reasons: r.reasons, signals: r.signals, grant: r.grant ?? null,
            status: r.decision === 'allow' ? 'allowed' : r.decision === 'deny' ? 'denied' : 'pending_approval',
        };
        if (a.decision === 'allow')
            issueReceipt(a, false);
        if (a.decision === 'approval_required') {
            a.approvalId = rid('apr');
            a.approvalExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
        }
        actions.set(a.id, a);
        if (body.idempotencyKey)
            byIdem.set(body.idempotencyKey, a.id);
        const released = a.decision === 'allow' && a.grant ? Object.fromEntries(a.grant.map((f) => [f, VAULT[f] ?? null])) : null;
        return { json: out(a, released ? { released } : {}) };
    }
    function decide(actionId, approve, reason) {
        const a = actions.get(actionId);
        if (!a || a.decision !== 'approval_required')
            return false;
        if (approve) {
            a.decision = 'allow';
            a.status = 'allowed';
            a.reasons = [...a.reasons, 'approved by a person'];
            issueReceipt(a, true);
        }
        else {
            a.decision = 'deny';
            a.status = 'denied';
            a.reasons = [reason ?? 'refused by a person'];
        }
        return true;
    }
    function verify(token) {
        const parts = String(token).split('.');
        if (parts.length !== 3)
            return { valid: false, reason: 'malformed' };
        let header;
        let claims;
        try {
            header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
            claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        }
        catch {
            return { valid: false, reason: 'malformed' };
        }
        if (header.alg !== 'EdDSA' || header.typ !== 'assay-receipt+jwt' || header.kid !== kid)
            return { valid: false, reason: 'bad header or unknown key' };
        if (!edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) {
            return { valid: false, reason: 'signature does not match: the receipt was altered or not issued by Immiscible' };
        }
        if (Math.floor(Date.now() / 1000) > claims.exp + 30)
            return { valid: false, reason: 'expired', expired: true };
        if (claims.iss !== url)
            return { valid: false, reason: 'issued for a different deployment' };
        if (!issued.has(claims.jti))
            return { valid: false, reason: 'not a receipt this deployment issued' };
        if (seen.has(claims.jti))
            return { valid: false, replayed: true, claims, reason: 'this receipt has already been verified once; receipts are single use' };
        seen.add(claims.jti);
        return { valid: true, claims };
    }
    /** The fake model: "ok", or a tool call when asked for one, then a summary of the tool's result. */
    function model(protocol, body) {
        const msgs = Array.isArray(body?.messages) ? body.messages : [];
        const last = msgs[msgs.length - 1];
        const textOf = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((b) => b?.text ?? (typeof b?.content === 'string' ? b.content : '')).join(' ') : '');
        const toolResult = protocol === 'openai'
            ? (last?.role === 'tool' ? textOf(last) : null)
            : (Array.isArray(last?.content) && last.content.some((b) => b?.type === 'tool_result') ? last.content.filter((b) => b?.type === 'tool_result').map((b) => (typeof b.content === 'string' ? b.content : textOf({ content: b.content }))).join(' ') : null);
        const ask = last?.role === 'user' && toolResult == null ? /CALL\s+([A-Za-z0-9_-]+)\s+(\{.*\})/s.exec(textOf(last)) : null;
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (protocol === 'openai') {
            const base = { id: rid('chatcmpl'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body?.model ?? 'fake', usage };
            if (ask) {
                return { ...base, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: rid('call'), type: 'function', function: { name: ask[1], arguments: ask[2] } }] } }] };
            }
            return { ...base, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: toolResult != null ? `done: ${toolResult}` : 'ok' } }] };
        }
        const base = { id: rid('msg'), type: 'message', role: 'assistant', model: body?.model ?? 'fake', usage: { input_tokens: 10, output_tokens: 5 } };
        if (ask)
            return { ...base, content: [{ type: 'tool_use', id: rid('toolu'), name: ask[1], input: JSON.parse(ask[2]) }], stop_reason: 'tool_use', stop_sequence: null };
        return { ...base, content: [{ type: 'text', text: toolResult != null ? `done: ${toolResult}` : 'ok' }], stop_reason: 'end_turn', stop_sequence: null };
    }
    function proxy(msg, sessionHeader) {
        const ok = (result, headers) => ({ json: { jsonrpc: '2.0', id: msg.id, result }, headers });
        const err = (code, message, data) => ({ json: { jsonrpc: '2.0', id: msg.id, error: { code, message, ...(data ? { data } : {}) } } });
        if (msg?.method === 'initialize') {
            return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'immiscible-proxy-fake-shop', version: '1' } }, { 'mcp-session-id': `mps_${randomBytes(16).toString('hex')}` });
        }
        if (msg?.method === 'tools/list') {
            return ok({ tools: [{ name: 'search', description: 'search the shop', inputSchema: { type: 'object' } }, { name: 'buy', description: 'buy', inputSchema: { type: 'object' } }] });
        }
        if (msg?.method !== 'tools/call')
            return err(-32601, 'method not found');
        const { name, arguments: args = {}, _meta: meta = {} } = msg.params ?? {};
        const digest = createHash('sha256').update(`${name}\n${JSON.stringify(args)}`).digest('hex');
        let a = null;
        if (meta['immiscible/approvalId']) {
            a = [...actions.values()].find((x) => x.approvalId === meta['immiscible/approvalId']);
            if (!a || proxyCalls.get(a.id)?.digest !== digest)
                return err(-32602, 'that approval was for a different tool call');
        }
        else if (meta['immiscible/idempotencyKey'] && byIdem.has(meta['immiscible/idempotencyKey'])) {
            a = actions.get(byIdem.get(meta['immiscible/idempotencyKey']));
        }
        if (!a) {
            const request = name === 'buy'
                ? { type: 'payment', summary: `buy through the proxy: ${args.amount} at ${args.merchant}`, payment: { amount: args.amount, currency: 'GBP', merchant: { domain: args.merchant } } }
                : { type: 'tool.call', summary: `${name} through the proxy`, target: { domain: 'shop.example' } };
            const sid = sessionHeader ? `mcp:${sessionHeader}` : undefined;
            const seenHere = [...(tainted.get(sid) ?? [])].map((source) => ({ source }));
            const r = authorize({ ...request, provenance: [{ source: 'agent', detail: 'tool call through the fake proxy' }, ...seenHere], ...(meta['immiscible/idempotencyKey'] ? { idempotencyKey: meta['immiscible/idempotencyKey'] } : {}) });
            if (r.status)
                return err(-32602, r.json.error.message);
            a = actions.get(r.json.id);
            proxyCalls.set(a.id, { digest, forwarded: false, sid });
        }
        if (a.decision === 'deny')
            return err(-32003, `Immiscible refused this call to fake-shop: ${a.reasons.join(' ')}`, { decision: 'deny', actionId: a.id, reasons: a.reasons, signals: a.signals.map((x) => ({ id: x.id, label: x.id })) });
        if (a.decision === 'approval_required') {
            const d = out(a);
            return ok({ content: [{ type: 'text', text: `A person must approve this call to fake-shop before it runs. Approval: ${d.approval.url}. Action id: ${a.id}.` }], structuredContent: { decision: 'approval_required', actionId: a.id, approval: d.approval, reasons: a.reasons }, isError: true });
        }
        const pc = proxyCalls.get(a.id);
        if (pc.forwarded)
            return err(-32006, `This call was already made (action ${a.id})`);
        pc.forwarded = true;
        upstreamCalls++;
        a.settledAt = new Date().toISOString();
        a.status = 'completed';
        a.settledAmount = a.request.payment?.amount ?? null;
        if (pc.sid)
            taintSession(pc.sid, 'tool');
        return ok({ content: [{ type: 'text', text: `fake-shop did ${name} with ${JSON.stringify(args)}` }], isError: false, _meta: { 'immiscible/actionId': a.id } });
    }
    async function route(req, body) {
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;
        const fail = failures.get(p);
        if (fail && fail.n > 0 && fail.after) {
            fail.n--;
            failures.set(p, { ...fail, after: false, n: 0 });
            const r = await route(req, body);
            failures.set(p, fail);
            void r;
            return { drop: true };
        }
        if (fail && fail.n > 0) {
            fail.n--;
            if (fail.status === 0)
                return { drop: true };
            return { status: fail.status, json: { error: { type: 'fake_failure', message: `injected ${fail.status}` } } };
        }
        const auth = String(req.headers.authorization ?? '');
        const bearer = /^bearer /i.test(auth) ? auth.slice(7).trim() : req.headers['x-api-key'] ?? null;
        const authed = bearer === agentKey;
        const noKey = { status: 401, json: { error: { type: 'invalid_api_key', message: 'unknown or revoked key' } } };
        if (req.method === 'GET' && p === '/.well-known/immiscible-keys.json')
            return { json: { keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, alg: 'EdDSA', use: 'sig' }] } };
        if (req.method === 'POST' && p === '/v1/verify') {
            if (typeof body?.receipt !== 'string')
                return { status: 400, json: { valid: false, reason: 'send { "receipt": "<compact JWS>" }' } };
            return { json: verify(body.receipt) };
        }
        let m = p.match(/^\/__fake\/actions\/([^/]+)\/(approve|deny)$/);
        if (req.method === 'POST' && m)
            return decide(m[1], m[2] === 'approve') ? { json: out(actions.get(m[1])) } : { status: 409, json: { error: { type: 'not_pending' } } };
        if (req.method === 'POST' && p === '/v1/actions/authorize') {
            if (!authed)
                return noKey;
            const b = { ...(body ?? {}) };
            if (b.idempotencyKey == null && typeof req.headers['idempotency-key'] === 'string')
                b.idempotencyKey = req.headers['idempotency-key'];
            return authorize(b);
        }
        if (req.method === 'POST' && (p === '/anthropic/v1/messages' || p === '/v1/chat/completions')) {
            if (!authed)
                return { status: 401, json: { error: { type: 'invalid_api_key', message: 'unknown or revoked key' } } };
            const protocol = p.startsWith('/anthropic') ? 'anthropic' : 'openai';
            const presented = req.headers['x-immiscible-session'];
            let sid = null;
            let issue = null;
            if (presented != null) {
                if (!issuedSessions.has(presented))
                    return { status: 400, json: { error: { type: 'invalid_session', message: 'x-immiscible-session was not issued to this key; drop it to be given a new one' } } };
                sid = presented;
                issue = presented;
            }
            else if (req.headers['x-immiscible-client-session'] != null) {
                sid = String(req.headers['x-immiscible-client-session']);
            }
            else if (!(protocol === 'openai' ? body?.user : body?.metadata?.user_id)) {
                sid = `imss_${randomBytes(12).toString('base64url')}_${randomBytes(8).toString('base64url')}`;
                issuedSessions.add(sid);
                issue = sid;
            }
            observe(body, sid);
            return { json: model(protocol, body), headers: issue ? { 'x-immiscible-session': issue } : {} };
        }
        if (req.method === 'POST' && p === '/mcp/proxy/fake-shop') {
            if (!authed)
                return { status: 401, json: { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32001, message: 'unknown or revoked key' } } };
            if (body?.id === undefined)
                return { status: 202, json: {} };
            return proxy(body, req.headers['mcp-session-id']);
        }
        m = p.match(/^\/v1\/actions\/([^/]+)$/);
        if (req.method === 'GET' && m) {
            if (!authed)
                return noKey;
            const a = actions.get(m[1]);
            return a ? { json: out(a) } : { status: 404, json: { error: { type: 'not_found', message: 'no such action for this agent' } } };
        }
        m = p.match(/^\/v1\/actions\/([^/]+)\/settle$/);
        if (req.method === 'POST' && m) {
            if (!authed)
                return noKey;
            const a = actions.get(m[1]);
            if (!a)
                return { status: 404, json: { error: { type: 'not_found', message: 'no such action for this agent' } } };
            if (!['completed', 'failed', 'cancelled'].includes(body?.status))
                return { status: 400, json: { error: { type: 'invalid_status', message: 'status must be completed, failed or cancelled' } } };
            if (a.decision !== 'allow')
                return { status: 409, json: { error: { type: 'not_allowed', message: 'only an allowed action can be settled' } } };
            if (a.settledAt)
                return { status: 409, json: { error: { type: 'already_settled', message: 'this action was already settled' } } };
            const authorised = a.request.payment?.amount ?? null;
            a.settledAmount = body.amount ?? (body.status === 'completed' ? authorised : null);
            a.incident = authorised != null && body.status === 'completed' && a.settledAmount > authorised;
            a.settledAt = new Date().toISOString();
            a.status = body.status;
            settlements.push({ actionId: a.id, ...body, incident: a.incident });
            return { json: out(a) };
        }
        if (req.method === 'POST' && p === '/v1/outcomes') {
            if (!authed)
                return noKey;
            outcomes.push(body);
            return { json: { taskId: body?.taskId, status: body?.status, yield: { yieldRate: null } } };
        }
        return { status: 404, json: { error: { type: 'not_found', message: p } } };
    }
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            let body = null;
            try {
                body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
            }
            catch {
                body = null;
            }
            requests.push({ method: req.method, path: req.url, headers: req.headers, body });
            const r = await route(req, body);
            if (r.drop) {
                req.socket.destroy();
                return;
            }
            // Trace context: continue the caller's trace with a span of our own, as the real server does.
            const tp = TRACEPARENT_RX.exec(String(req.headers.traceparent ?? ''));
            const traceparent = `00-${tp ? tp[1] : randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-${tp ? tp[3] : '01'}`;
            res.writeHead(r.status ?? 200, { 'content-type': 'application/json', traceparent, ...(r.headers ?? {}) });
            res.end(JSON.stringify(r.json ?? {}));
        });
    });
    await new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    return {
        url, agentKey, agentId, kid, mandate, publicKey, privateKey, actions, settlements, outcomes, requests, tainted, issuedSessions,
        get upstreamCalls() {
            return upstreamCalls;
        },
        get jwks() {
            return { keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, alg: 'EdDSA', use: 'sig' }] };
        },
        taintSession,
        mint,
        approve: (actionId) => decide(actionId, true),
        deny: (actionId, reason) => decide(actionId, false, reason),
        failNext(path, n, status = 503, o = {}) {
            failures.set(path, { n, status, after: Boolean(o.after) });
        },
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}
