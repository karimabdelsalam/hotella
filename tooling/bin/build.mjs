#!/usr/bin/env node
/**
 * hotella-build: compile a package with SWC (JS, CommonJS) and emit declarations with tsc.
 * Usage: hotella-build [--watch]
 * Expects: ./src and ./tsconfig.build.json in the package directory.
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = process.cwd();
const watch = process.argv.includes('--watch');

if (!existsSync(join(pkgDir, 'src'))) {
  console.error(`hotella-build: no src/ directory in ${pkgDir}`);
  process.exit(1);
}
if (!watch) rmSync(join(pkgDir, 'dist'), { recursive: true, force: true });

const swcBin = require.resolve('@swc/cli/bin/swc.js');
const tscBin = require.resolve('typescript/bin/tsc');
const swcrc = join(here, '..', 'swcrc.json');

function run(bin, args) {
  return spawn(process.execPath, [bin, ...args], { stdio: 'inherit', cwd: pkgDir });
}

const swcArgs = [
  'src',
  '-d',
  'dist',
  '--strip-leading-paths',
  '--config-file',
  swcrc,
  ...(watch ? ['--watch'] : []),
];
const tscArgs = [
  '-p',
  'tsconfig.build.json',
  '--emitDeclarationOnly',
  ...(watch ? ['--watch', '--preserveWatchOutput'] : []),
];

const procs = [run(swcBin, swcArgs), run(tscBin, tscArgs)];
let failed = false;
for (const p of procs) {
  p.on('exit', (code) => {
    if (code !== 0) failed = true;
    if (!watch && procs.every((q) => q.exitCode !== null)) process.exit(failed ? 1 : 0);
  });
}
process.on('SIGINT', () => procs.forEach((p) => p.kill('SIGINT')));
process.on('SIGTERM', () => procs.forEach((p) => p.kill('SIGTERM')));
