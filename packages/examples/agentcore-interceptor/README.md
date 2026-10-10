# AWS AgentCore Gateway: ask Immiscible before every tool call

A REQUEST interceptor for an Amazon Bedrock AgentCore Gateway, as a Node.js 22 Lambda function with no dependencies. Before the gateway calls a tool, it asks Immiscible:

| Immiscible says | The gateway |
|---|---|
| allow | calls the tool, with the request unchanged |
| deny | answers at once with a tool error naming the reason; the tool is not called |
| needs a person | waits up to `IMMISCIBLE_APPROVAL_WAIT_S` seconds (default 0) for an answer in Slack, Teams, email or the console; then calls the tool if they approved, or answers with the approval link |
| no answer, an error, no key | answers with a refusal: it fails closed |

Other MCP methods (`tools/list`, `initialize`) pass through unchanged. It also passes responses through if you attach it as a RESPONSE interceptor, and leaves HTTP targets alone.

**Built to the published API, not yet run against AWS.** The event and output shapes are from AWS's [interceptor types](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-interceptors-types.html) page (version 1.0): a REQUEST interceptor that returns `transformedGatewayResponse` makes the gateway answer with it at once, without calling the target. The local test runs those documented events through the handler against the fake Immiscible.

## Set up

1. Make an agent in Immiscible for the gateway (Agents, Add an agent) and give it a rule for `tool.call`. Copy its key.
2. Create a Lambda function from `index.mjs` (runtime Node.js 22, handler `index.handler`). Set `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY`; keep the key in Secrets Manager or as an encrypted environment variable.
3. Attach it to the gateway as its REQUEST interceptor. Turn on `passRequestHeaders` only if you want the MCP session id passed on (it joins the call to the session in Immiscible); the function never logs headers.
4. Give the gateway's execution role permission to invoke this one function, and nothing wider.

If you set `IMMISCIBLE_APPROVAL_WAIT_S`, keep it well under the Lambda's timeout. The idempotency key is built from the session, the JSON-RPC id, the tool and its arguments, so a gateway retry of the same call is the same request, as AWS asks of interceptors.

## What Immiscible sees

Each call is a `tool.call` action. A gateway tool named `ops___deploy` (target `ops`, tool `deploy`) reads as `deploy on ops: {"service":"api"}`, and a URL in the arguments becomes the target domain, so a rule can name the hosts a tool may reach.

## Test it here

```bash
(cd ../../immiscible-js && npm ci && npm run build)
node ../test.mjs agentcore-interceptor
```
