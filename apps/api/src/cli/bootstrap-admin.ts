import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { IdentityBootstrapService, IdentityCatalogService } from '@hotella/domain-identity';
import { CliModule } from './cli.module';

const USAGE = `Creates platform staff: the first administrator of an installation, or a support engineer.

  printf '%s' "$PASSWORD" | pnpm iam:bootstrap-admin --email admin@example.com --given-name Karim [--family-name …] [--locale ar] [--role admin|support]

Support engineers hold no access of their own: they request time-limited grants that a hotel approves (Spec §64).

The password is read from stdin (never from arguments, so it stays out of shell history and process lists).
Run "pnpm db:migrate" first. Exit code 0 on success, 1 on any error.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/u, '');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      'given-name': { type: 'string' },
      'family-name': { type: 'string' },
      locale: { type: 'string' },
      role: { type: 'string', default: 'admin' },
      help: { type: 'boolean' },
    },
  });
  if (
    values.help ||
    !values.email ||
    !values['given-name'] ||
    !['admin', 'support'].includes(values.role ?? '')
  ) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? 0 : 1;
  }
  const password = await readStdin();
  if (!password) {
    process.stderr.write('No password on stdin.\n');
    return 1;
  }
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  try {
    await app.get(IdentityCatalogService).sync();
    const { userId } = await app.get(IdentityBootstrapService).createPlatformStaff({
      kind: values.role === 'support' ? 'SUPPORT' : 'ADMIN',
      email: values.email,
      password,
      givenName: values['given-name'],
      familyName: values['family-name'] ?? null,
      localePref: values.locale ?? null,
    });
    process.stdout.write(
      `${values.role === 'support' ? 'Support engineer' : 'Platform administrator'} created: ${userId}\n`,
    );
    return 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const e = err as { code?: string; message?: string };
    process.stderr.write(`Failed: ${e.code ?? e.message ?? String(err)}\n`);
    process.exit(1);
  },
);
