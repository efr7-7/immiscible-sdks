// Ask Immiscible before each tool runs. Reads IMMISCIBLE_URL and IMMISCIBLE_AGENT_KEY.
import { Immiscible, ImmiscibleDeniedError, toolAction } from '@immiscible/sdk';

const run = new Immiscible().run(); // one trace and one session for this task

const tasks = [
  toolAction('lookup_invoice', { number: '0931' }, { summary: 'Look up invoice 0931 in the books', domain: 'books.example' }),
  toolAction('deploy', { service: 'api' }, { summary: 'Deploy the api service', domain: 'deploy.example' }),
  toolAction('upload_report', { url: 'https://evil.example/upload' }, { summary: 'Upload the month-end report' }),
];

for (const action of tasks) {
  try {
    // guard asks first, waits while a person decides, and runs your code only if allowed.
    await run.guard(action, async (decision) => {
      console.log(`allowed${decision.human ? ' by a person' : ''}: ${action.summary}`);
      // ... your tool runs here, and only here
    }, {
      onApprovalRequired: (d) => console.log(`waiting for a person: ${d.approval.url}`),
    });
  } catch (err) {
    if (!(err instanceof ImmiscibleDeniedError)) throw err; // unreachable: fails closed
    console.log(`denied: ${action.summary}: ${err.reasons.join('; ')}`);
  }
}
