/**
 * The local test: each documented event through the handler, against
 * IMMISCIBLE_URL (the fake Immiscible in ../test.mjs). Prints one line per case.
 */

import { readFileSync } from 'node:fs';
import { handler } from './index.mjs';

const EVENTS = JSON.parse(readFileSync(new URL('./events.json', import.meta.url), 'utf8'));
const show = (name, out) => {
  const res = out.mcp?.transformedGatewayResponse;
  console.log(res ? `${name}: answered by the gateway: ${res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body)}` : `${name}: passed to the target`);
};

show('tools/list', await handler(EVENTS.toolsList));
show('lookup_invoice', await handler(EVENTS.lookup));
show('deploy, no wait', await handler(EVENTS.deploy, { env: { ...process.env, IMMISCIBLE_APPROVAL_WAIT_S: '0' } }));
show('deploy, waiting for a person', await handler({ ...EVENTS.deploy, mcp: { ...EVENTS.deploy.mcp, gatewayRequest: { ...EVENTS.deploy.mcp.gatewayRequest, body: { ...EVENTS.deploy.mcp.gatewayRequest.body, id: 30 } } } }, { env: { ...process.env, IMMISCIBLE_APPROVAL_WAIT_S: '10' } }));
show('upload_report', await handler(EVENTS.upload));
show('response', await handler(EVENTS.response));
show('unreachable', await handler(EVENTS.lookup, { env: { IMMISCIBLE_URL: 'http://127.0.0.1:9', IMMISCIBLE_AGENT_KEY: 'x' } }));
