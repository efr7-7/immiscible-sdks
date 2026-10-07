# OpenAI Agents SDK: guard the tools

```bash
npm install @immiscible/sdk @openai/agents openai zod
node agent.mjs "Deploy the api service"
```

`guardOpenAITools(tools)` returns copies of your function tools that ask Immiscible before they run. Allowed: the tool runs, and the action is settled afterwards. Held: it waits while a person decides. Denied: the model gets the reasons as the tool's result, written so it stops rather than tries another way. Hosted tools and handoffs pass through untouched.

`new OpenAI(immiscible.gateway.openai())` sends the model calls through Immiscible's gateway too, so spend is counted against budgets and what entered the agent's context is seen, not just declared. Leave it out to keep calling OpenAI directly.

`@openai/agents`, `openai` and `zod` are your project's dependencies; `@immiscible/sdk` does not depend on them. It reads `IMMISCIBLE_URL` and `IMMISCIBLE_AGENT_KEY`. To judge a tool as a payment, pass `mapToAction: ({ name, args }) => Immiscible.paymentAction({ amount: args.pence, currency: 'GBP', merchant: args.domain })`; return `null` for a read-only tool that needs no check.

In CI this runs against the fake, whose model calls the tool you name: `node agent.mjs 'CALL deploy {"service":"api"}'`.
