#!/usr/bin/env node
/**
 * The quickstart, shipped with the package, so it runs from an install:
 *
 *   npx -p @immiscible/sdk immiscible-demo          # against the built-in fake, no server needed
 *   npx -p @immiscible/sdk immiscible-demo --live   # against IMMISCIBLE_URL with IMMISCIBLE_AGENT_KEY
 *
 * The same steps as examples/quickstart.mjs: ask before a tool runs, wait
 * for a person when asked, check the receipt, and see a lookalike refused.
 */

if (!process.argv.includes('--live') && !process.argv.includes('--demo')) process.argv.push('--demo');
await import('../examples/quickstart.mjs');
