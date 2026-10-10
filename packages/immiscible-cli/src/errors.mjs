/**
 * Exit codes: one per outcome, the same in every command, so a script or an
 * AI coding agent can act on the number alone. docs/site/cli.md lists them.
 */

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1, // unexpected: a server error, a file that could not be written
  USAGE: 2, // an unknown command or flag, or a bad value
  AUTH: 3, // not signed in, or the token is no longer accepted
  INPUT: 4, // input is needed and this is not a terminal: pass the flags
  NETWORK: 5, // the server could not be reached
  REFUSED: 6, // the server said no: a role, a rule, a plan limit
  CHECKS: 7, // doctor: one or more checks failed
  DENIED: 8, // login: denied in the browser, or the code expired
  TEST: 9, // init: the live test call did not come back governed
  PENDING: 10, // init: done, and the rule waits for another owner to confirm
  FINDINGS: 11, // check or scan: something high-risk was found
  INVALID: 12, // verify: the receipt is not valid; evidence: the ledger did not verify
});

export class CliError extends Error {
  /**
   * @param {string} message  one sentence for a person
   * @param {{ exit?: number, code?: string, fix?: string, docs?: string, detail?: object }} [o]
   */
  constructor(message, { exit = EXIT.ERROR, code = 'error', fix = null, docs = null, detail = null } = {}) {
    super(message);
    Object.assign(this, { exit, code, fix, docs, detail });
  }
}

export const usage = (message, fix = 'Run immiscible help.') => new CliError(message, { exit: EXIT.USAGE, code: 'usage', fix });
