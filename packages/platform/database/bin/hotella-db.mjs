#!/usr/bin/env node
/**
 * hotella-db <command>
 *   migrate            apply pending migrations to DATABASE_URL
 *   generate [name]    drizzle-kit generate (writes SQL to ./migrations; REVIEW IT before committing)
 *   check              fail if the schema code has changes not captured by a migration (drift)
 *   studio             drizzle-kit studio
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);

function drizzleKit(args, cwd = pkgDir) {
  // drizzle-kit's exports map hides bin.cjs; resolve the package dir through its main entry instead.
  const bin = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
  const r = spawnSync(process.execPath, [bin, ...args], { stdio: 'pipe', cwd, encoding: 'utf8' });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  return r;
}

switch (cmd) {
  case 'migrate': {
    const { runMigrations } = require(join(pkgDir, 'dist', 'migrate.js'));
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error('DATABASE_URL is required');
      process.exit(1);
    }
    await runMigrations(url);
    console.log('migrations applied');
    break;
  }
  case 'generate': {
    const name = rest[0] ? ['--name', rest[0]] : [];
    const r = drizzleKit(['generate', '--config', 'drizzle.config.ts', ...name]);
    process.exit(r.status ?? 1);
    break;
  }
  case 'check': {
    // Generate into a temporary copy of the journal; any new SQL file means schema drift.
    // The temp config lives next to the real one so its relative schema globs resolve identically.
    const tmp = mkdtempSync(join(tmpdir(), 'hotella-dbcheck-'));
    const out = join(tmp, 'migrations');
    cpSync(join(pkgDir, 'migrations'), out, { recursive: true });
    const cfg = join(pkgDir, 'drizzle.config.check.ts');
    const base = readFileSync(join(pkgDir, 'drizzle.config.ts'), 'utf8');
    writeFileSync(cfg, base.replace("out: './migrations'", `out: ${JSON.stringify(out)}`));
    const before = new Set(readdirSync(out).filter((f) => f.endsWith('.sql')));
    let r;
    try {
      r = drizzleKit(['generate', '--config', 'drizzle.config.check.ts', '--name', 'drift_check']);
    } finally {
      rmSync(cfg, { force: true });
    }
    const after = readdirSync(out).filter((f) => f.endsWith('.sql'));
    const added = after.filter((f) => !before.has(f));
    rmSync(tmp, { recursive: true, force: true });
    if (r.status !== 0) process.exit(r.status ?? 1);
    if (added.length > 0) {
      console.error(
        `\nSchema drift: ${added.length} migration(s) would be generated. Run "pnpm db:generate <name>" and review the SQL.`,
      );
      process.exit(2);
    }
    console.log('db:check OK — schema and migrations are in sync');
    break;
  }
  case 'studio': {
    const r = drizzleKit(['studio', '--config', 'drizzle.config.ts']);
    process.exit(r.status ?? 1);
    break;
  }
  default:
    console.error('usage: hotella-db <migrate|generate [name]|check|studio>');
    process.exit(1);
}
