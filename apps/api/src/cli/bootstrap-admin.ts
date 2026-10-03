import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { IdentityBootstrapService, IdentityCatalogService } from '@hotella/domain-identity';
import { CliModule } from './cli.module';

const USAGE = `Creates the first platform administrator of an installation.

  printf '%s' "$PASSWORD" | pnpm iam:bootstrap-admin --email admin@example.com --given-name Karim [--family-name …] [--locale ar]

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
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.email || !values['given-name']) {
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
    const { userId } = await app.get(IdentityBootstrapService).createPlatformAdmin({
      email: values.email,
      password,
      givenName: values['given-name'],
      familyName: values['family-name'] ?? null,
      localePref: values.locale ?? null,
    });
    process.stdout.write(`Platform administrator created: ${userId}\n`);
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
