/**
 * What every command is handed: the parsed flags, the output, the project
 * directory, and the server and token resolved for it.
 */

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { resolveContext } from './config.mjs';
import { api } from './api.mjs';
import { CliError, EXIT, usage } from './errors.mjs';

export function makeContext({ flags, ui, env = process.env, cwd = process.cwd(), fetchImpl = fetch }) {
  const dir = path.resolve(cwd, flags.dir ?? '.');
  if (flags.dir && !(existsSync(dir) && statSync(dir).isDirectory())) throw usage(`--dir ${flags.dir} is not a directory`);
  const r = resolveContext({ flags, env, dir });
  if (!r.url) throw usage(`${r.urlFrom} is not a URL: ${r.badUrl}`, 'Use the address of your Immiscible server, such as https://immiscible.example.');
  return {
    ui, flags, env, dir, fetchImpl,
    url: r.url,
    urlFrom: r.urlFrom,
    token: r.token,
    tokenFrom: r.tokenFrom,
    saved: r.saved,
    api: (token = r.token) => api(r.url, token, { fetchImpl }),
    /** The CLI token, or the "sign in first" error. */
    requireToken() {
      if (r.token) return r.token;
      throw new CliError(`not signed in to ${r.url}`, { exit: EXIT.AUTH, code: 'not_signed_in', fix: 'Run immiscible login (with --json it first prints the link for a person to open), or pass --token, or set IMMISCIBLE_TOKEN in CI.' });
    },
  };
}
