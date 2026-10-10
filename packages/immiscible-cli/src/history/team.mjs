/**
 * Who else works here, worked out on this machine from git and sent nowhere.
 *
 * The person's own email domain comes from `git config user.email`; the
 * colleagues are the distinct commit authors at that domain in the last 90
 * days, across the repositories the agents worked in. Only a count and the
 * domain come back: no names, no addresses. Personal domains (gmail.com and
 * the like) and GitHub's noreply addresses never count as a company.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PERSONAL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'yahoo.co.uk', 'proton.me', 'protonmail.com', 'pm.me', 'fastmail.com', 'hey.com', 'aol.com', 'gmx.com', 'gmx.de', 'yandex.ru', 'qq.com', '163.com', 'users.noreply.github.com', 'noreply.github.com', 'example.com']);

const git = (args, cwd, timeout = 3000) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout : '';
};

export const domainOf = (email) => {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})>?\s*$/i.exec(String(email ?? '').trim());
  return m ? m[1].toLowerCase() : null;
};

/**
 * { domain, colleagues, repositories } or null when there is no company
 * domain to go on. dirs: the repositories the agents worked in.
 */
export function teamHint(dirs, { cwd = process.cwd(), maxRepos = 20 } = {}) {
  const own = git(['config', 'user.email'], cwd).trim();
  const domain = domainOf(own);
  if (!domain || PERSONAL.has(domain) || /noreply/.test(domain)) return null;
  const authors = new Set();
  let repos = 0;
  for (const d of [...new Set(dirs)].filter((x) => x && existsSync(path.join(x, '.git'))).slice(0, maxRepos)) {
    repos++;
    for (const line of git(['log', '--since=90.days', '--format=%ae', '-n', '2000'], d).split('\n')) {
      const e = line.trim().toLowerCase();
      if (e && e !== own.toLowerCase() && domainOf(e) === domain && !/\[bot\]|noreply/.test(e)) authors.add(e);
    }
  }
  return repos ? { domain, colleagues: authors.size, repositories: repos } : null;
}
