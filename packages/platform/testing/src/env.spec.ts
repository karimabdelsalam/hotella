import { describe, expect, it } from 'vitest';
import { needsInfra, readTestInfra } from './env';

describe('test infra contract', () => {
  it('reports whether integration infrastructure is available', () => {
    const infra = readTestInfra();
    expect(typeof needsInfra()).toBe('boolean');
    if (needsInfra()) expect(infra.databaseUrl).toBeUndefined();
    else expect(infra.databaseUrl).toMatch(/^postgres/);
  });
});
