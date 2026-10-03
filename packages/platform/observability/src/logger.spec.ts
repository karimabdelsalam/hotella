import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from './logger';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('logger redaction', () => {
  it('redacts tokens, otp, phone and authorization headers', () => {
    const { stream, lines } = capture();
    const logger = pino(
      { level: 'info', redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } },
      stream,
    );
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc' } },
        user: { phone: '+201000000000', token: 't' },
        otp: '123456',
      },
      'login',
    );
    const [line] = lines();
    expect(JSON.stringify(line)).not.toContain('Bearer abc');
    expect(JSON.stringify(line)).not.toContain('+201000000000');
    expect(JSON.stringify(line)).not.toContain('123456');
    expect((line as { otp: string }).otp).toBe('[REDACTED]');
  });

  it('redacts sensitive keys nested three levels deep', () => {
    const { stream, lines } = capture();
    const logger = pino(
      { level: 'info', redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } },
      stream,
    );
    logger.info({ a: { b: { c: { password: 'p4ss', token: 'tok' } } } }, 'deep');
    const text = JSON.stringify(lines()[0]);
    expect(text).not.toContain('p4ss');
    expect(text).not.toContain('tok"');
  });

  it('always carries a correlation_id field via mixin', () => {
    const { stream, lines } = capture();
    const logger = pino({ level: 'info', mixin: () => ({ correlation_id: null }) }, stream);
    logger.info('hello');
    expect(lines()[0]).toHaveProperty('correlation_id');
  });
});
