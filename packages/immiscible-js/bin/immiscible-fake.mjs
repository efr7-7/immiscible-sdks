#!/usr/bin/env node
/**
 * Run the fake Immiscible on its own, for tests in other languages.
 *
 *   npx immiscible-fake [--port 8799]
 *
 * Prints one line of JSON ({ url, agentKey, kid, jwks }) and serves until
 * stdin closes or the process is stopped. A person's approval is
 * POST <url>/__fake/actions/<id>/approve (or /deny).
 */

import { startFakeImmiscible } from '../dist/esm/testing.js';

const i = process.argv.indexOf('--port');
const port = i > 0 ? Number(process.argv[i + 1]) : 0;
const fake = await startFakeImmiscible({ port });
process.stdout.write(`${JSON.stringify({ url: fake.url, agentKey: fake.agentKey, kid: fake.kid, jwks: fake.jwks })}\n`);

const stop = async () => {
  await fake.close();
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
