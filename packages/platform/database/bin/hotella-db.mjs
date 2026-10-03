#!/usr/bin/env node
/**
 * hotella-db <command>
 *   migrate            apply pending migrations to DATABASE_URL
 *   grant <role>       grant the application's ordinary DB role access to the application schemas (after migrate)
 *   generate [name]    drizzle-kit generate (writes SQL to ./migrations; REVIEW IT before committing)
 *   check              fail if the schema code has changes not captured by a migration (drift)
 *   studio             drizzle-kit studio
 */
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
    // Generate into a temporary copy of the journal; any new SQL file means schema drift. drizzle-kit only resolves
    // `out` relative to the config, and it reports some failures on stderr with exit code 0, so the copy lives under
    // the package (git-ignored) and any error output fails the check.
    const tmpName = `.dbcheck-${process.pid}`;
    const tmp = join(pkgDir, tmpName);
    const out = join(tmp, 'migrations');
    rmSync(tmp, { recursive: true, force: true });
    cpSync(join(pkgDir, 'migrations'), out, { recursive: true });
    const cfg = join(pkgDir, 'drizzle.config.check.ts');
    const base = readFileSync(join(pkgDir, 'drizzle.config.ts'), 'utf8');
    writeFileSync(cfg, base.replace("out: './migrations'", `out: './${tmpName}/migrations'`));
    const before = new Set(readdirSync(out).filter((f) => f.endsWith('.sql')));
    let r;
    let added = [];
    try {
      r = drizzleKit(['generate', '--config', 'drizzle.config.check.ts', '--name', 'drift_check']);
      added = readdirSync(out).filter((f) => f.endsWith('.sql') && !before.has(f));
    } finally {
      rmSync(cfg, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
    const failed = r.status !== 0 || /\bError\b|ENOENT/.test(`${r.stdout}\n${r.stderr}`);
    if (failed) {
      console.error('\ndb:check could not run drizzle-kit (see the output above).');
      process.exit(r.status || 3);
    }
    if (added.length > 0) {
      console.error(
        `\nSchema drift: ${added.length} migration(s) would be generated. Run "pnpm db:generate <name>" and review the SQL.`,
      );
      process.exit(2);
    }
    console.log('db:check OK — schema and migrations are in sync');
    break;
  }
  case 'grant': {
    const { grantApplicationRole } = require(join(pkgDir, 'dist', 'migrate.js'));
    const url = process.env.DATABASE_URL;
    const role = rest[0];
    if (!url || !role) {
      console.error('usage: DATABASE_URL=<admin url> hotella-db grant <role>');
      process.exit(1);
    }
    await grantApplicationRole(url, role);
    console.log(`grants applied to ${role}`);
    break;
  }
  case 'studio': {
    const r = drizzleKit(['studio', '--config', 'drizzle.config.ts']);
    process.exit(r.status ?? 1);
    break;
  }
  default:
    console.error('usage: hotella-db <migrate|grant <role>|generate [name]|check|studio>');
    process.exit(1);
}
