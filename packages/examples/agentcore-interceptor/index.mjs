/**
 * An AWS Bedrock AgentCore Gateway REQUEST interceptor that asks Immiscible
 * before every MCP tool call. A Lambda function (Node.js 22), no dependencies.
 *
 * Built to the published interceptor API (input and output version 1.0,
 * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-types.html)
 * and tested locally with those event shapes; not yet run against AWS.
 *
 *   tools/call, allowed           the request goes on to the target unchanged
 *   tools/call, refused           the gateway answers at once with a tool error naming the reason
 *   tools/call, needs a person    waits up to IMMISCIBLE_APPROVAL_WAIT_S (default 0) for an answer,
 *                                 then goes on if approved, otherwise answers with the approval link
 *   anything else (tools/list...) passed through unchanged
 *   Immiscible unreachable        refused: it fails closed
 *
 * Returning transformedGatewayResponse from a REQUEST interceptor makes the
 * gateway answer with it at once, without calling the target (AWS docs,
 * "Important notes about request interceptor output").
 *
 * Environment: IMMISCIBLE_URL, IMMISCIBLE_AGENT_KEY (keep it in Secrets
 * Manager or encrypted environment variables), IMMISCIBLE_TIMEOUT_MS
 * (default 5000), IMMISCIBLE_APPROVAL_WAIT_S (default 0; keep it under the
 * Lambda's own timeout).
 */

import { createHash } from 'node:crypto';

const VERSION = '1.0';
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The request goes on unchanged. */
const passRequest = (mcp) => ({ interceptorOutputVersion: VERSION, mcp: { transformedGatewayRequest: { body: mcp.gatewayRequest?.body ?? {} } } });

/** The gateway answers at once with a tool result the agent can read, and the target is never called. */
const refuse = (body, text) => ({
  interceptorOutputVersion: VERSION,
  mcp: {
    transformedGatewayResponse: {
      statusCode: 200,
      body: { jsonrpc: '2.0', id: body?.id ?? null, result: { content: [{ type: 'text', text }], isError: true } },
    },
  },
});

function hostOf(v) {
  try {
    return typeof v === 'string' && /^https?:\/\//i.test(v) ? new URL(v).hostname : null;
  } catch {
    return null;
  }
}

/** A gateway tool is named <target>___<tool>; a person reads "deploy on ops" more easily. */
const readable = (name) => {
  const i = name.indexOf('___');
  return i > 0 ? `${name.slice(i + 3)} on ${name.slice(0, i)}` : name;
};

/** The action Immiscible is asked about: the tool and its arguments, and a URL argument's host as the target. */
export function actionFor(body, headers = {}) {
  const name = String(body?.params?.name ?? 'tool');
  const args = body?.params?.arguments && typeof body.params.arguments === 'object' ? body.params.arguments : {};
  const url = Object.values(args).find((v) => hostOf(v));
  const session = headers['Mcp-Session-Id'] ?? headers['mcp-session-id'] ?? null;
  // One key per request: a gateway retry of the same call (AWS asks interceptors to be idempotent) is the same request.
  const key = createHash('sha256').update(JSON.stringify([session, body?.id ?? null, name, args])).digest('hex').slice(0, 40);
  return {
    type: 'tool.call',
    summary: `${clip(readable(name), 120)}: ${clip(JSON.stringify(args), 250)}`,
    ...(url ? { target: { domain: hostOf(url) } } : {}),
    ...(typeof session === 'string' && /^[\x21-\x7e]{1,128}$/.test(session) ? { session: { client: 'custom', id: session } } : {}),
    idempotencyKey: `agentcore_${key}`,
  };
}

async function call(base, key, method, path, body, timeoutMs) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

const reasonsOf = (d) => (Array.isArray(d?.reasons) ? d.reasons.map((r) => String(r).trim().replace(/[.\s]+$/, '')).filter(Boolean).join('; ') : '');

export async function handler(event, { env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const mcp = event?.mcp;
  // HTTP targets (Runtime, inference) are not tool calls: pass through untouched.
  if (!mcp) return { interceptorOutputVersion: VERSION, http: {} };
  // Configured as a RESPONSE interceptor too: hand the response back unchanged.
  if (mcp.gatewayResponse != null) {
    return { interceptorOutputVersion: VERSION, mcp: { transformedGatewayResponse: { statusCode: mcp.gatewayResponse.statusCode ?? 200, body: mcp.gatewayResponse.body ?? {} } } };
  }
  const body = mcp.gatewayRequest?.body;
  if (body?.method !== 'tools/call') return passRequest(mcp);

  const fail = (why) => refuse(body, `Immiscible (failing closed): ${why} The tool did not run.`);
  const base = String(env.IMMISCIBLE_URL || 'https://immiscible.ai').replace(/\/+$/, '');
  const key = env.IMMISCIBLE_AGENT_KEY;
  if (!key) return fail('IMMISCIBLE_AGENT_KEY is not set, so this call cannot be checked.');
  const timeoutMs = Math.min(Number(env.IMMISCIBLE_TIMEOUT_MS) || 5000, 30_000);
  const waitS = Math.max(0, Number(env.IMMISCIBLE_APPROVAL_WAIT_S) || 0);

  let d;
  try {
    const r = await call(base, key, 'POST', '/v1/actions/authorize', actionFor(body, mcp.gatewayRequest?.headers ?? {}), timeoutMs);
    if (!r.ok || !r.json?.decision) return fail(r.json?.error?.message ?? `Immiscible answered ${r.status}.`);
    d = r.json;
    const until = Date.now() + waitS * 1000;
    while (d.decision === 'approval_required' && d.id && Date.now() < until) {
      await sleep(Math.min(2000, Math.max(0, until - Date.now())));
      const p = await call(base, key, 'GET', `/v1/actions/${encodeURIComponent(d.id)}`, null, timeoutMs);
      if (p.ok && p.json?.decision) d = { ...d, ...p.json };
    }
  } catch (err) {
    return fail(err?.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms.` : `Immiscible could not be reached (${err.message}).`);
  }
  if (d.decision === 'allow') return passRequest(mcp);
  if (d.decision === 'approval_required') {
    return refuse(body, `Immiscible needs a person to approve this: ${reasonsOf(d) || 'a rule asks for one'}. ${d.approval?.url ? `Approve or deny at ${d.approval.url}, then try again.` : 'See Approvals in the console, then try again.'}`);
  }
  return refuse(body, `Immiscible refused this: ${reasonsOf(d) || 'a rule or a person said no'}. Do not try it another way.`);
}
