import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CLAUDE.md rule 12 / BUILD_PLAN 6.5: AI code never writes business tables. The AI context reaches other contexts only
 * through their public APIs (never their schema, repositories or services), and its own schema is `ai` alone; together
 * with dependency-cruiser and the ESLint import rules this keeps every business change behind a tool and the gate.
 */
const SRC = join(process.cwd(), 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'testing' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('the AI context writes no business table', () => {
  const files = sources(SRC);

  it('imports other bounded contexts only through their public entry', () => {
    const offending = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from '(@hotella\/domain-[a-z-]+[^']*)'/g)]
        .map((m) => m[1]!)
        .filter((spec) => !/^@hotella\/domain-[a-z-]+\/public$/.test(spec))
        .map((spec) => `${relative(SRC, file)} → ${spec}`),
    );
    expect(offending).toEqual([]);
  });

  it('declares tables in the ai schema only, and only its repositories touch them (ai, evaluation, insights and twin)', () => {
    const schema = readFileSync(join(SRC, 'infrastructure', 'schema.ts'), 'utf8');
    expect([...schema.matchAll(/pgSchema\('([a-z_]+)'\)/g)].map((m) => m[1])).toEqual(['ai']);
    const drizzleWriters = files.filter((file) =>
      /\.(insert|update|delete)\(\s*[a-zA-Z]+\s*\)/.test(readFileSync(file, 'utf8')),
    );
    expect(drizzleWriters.map((f) => relative(SRC, f)).sort()).toEqual([
      join('infrastructure', 'evaluation-repositories.ts'),
      join('infrastructure', 'insight-repositories.ts'),
      join('infrastructure', 'repositories.ts'),
      join('infrastructure', 'twin-repositories.ts'),
    ]);
  });
});
