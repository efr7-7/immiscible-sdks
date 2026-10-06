#!/usr/bin/env node
/**
 * Build dist/esm (ES modules) and dist/cjs (CommonJS), each with its
 * declarations, from src/*.ts. Needs TypeScript, a dev dependency only: the
 * published package has no runtime dependencies.
 *
 *   npm run build
 *
 * TypeScript is found in node_modules, or at $TSC (a path to tsc's bin
 * script), and type roots at $TYPE_ROOTS when @types/node is installed
 * somewhere else.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

let tsc = process.env.TSC;
if (!tsc) {
  try {
    tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  } catch {
    console.error('build: TypeScript is not installed. Run `npm install` here, or set TSC to the path of tsc.');
    process.exit(1);
  }
}

const extra = process.env.TYPE_ROOTS ? ['--typeRoots', process.env.TYPE_ROOTS] : [];

rmSync(join(root, 'dist'), { recursive: true, force: true });
for (const project of ['tsconfig.json', 'tsconfig.cjs.json']) {
  const r = spawnSync(process.execPath, [tsc, '-p', join(root, project), ...extra], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// dist/cjs is CommonJS inside a "type": "module" package: say so, for Node and for TypeScript.
mkdirSync(join(root, 'dist', 'cjs'), { recursive: true });
writeFileSync(join(root, 'dist', 'cjs', 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
writeFileSync(join(root, 'dist', 'esm', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

if (!existsSync(join(root, 'dist', 'esm', 'index.js')) || !existsSync(join(root, 'dist', 'cjs', 'index.js'))) {
  console.error('build: expected dist/esm/index.js and dist/cjs/index.js');
  process.exit(1);
}
console.log('build: dist/esm and dist/cjs written');
