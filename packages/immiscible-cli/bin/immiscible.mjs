#!/usr/bin/env node
/**
 * immiscible: the developer CLI. See ../README.md, or run immiscible help.
 * Not the operator CLI in the repository's src/cli, which runs on the server.
 */

import { main } from '../src/main.mjs';

const code = await main(process.argv.slice(2));
// Let stdout drain before exiting, so piped JSON is never cut short.
process.stdout.write('', () => process.exit(code));
