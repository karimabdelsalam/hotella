import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Swagger keys OpenAPI component schemas by DTO class name: a second `class UpdateDraftDto` anywhere silently replaces
 * the first one's schema in the published document (found in Sprint 11.1). DTO class names are unique across the API.
 */
const DOMAINS = join(process.cwd(), '..', '..', 'packages', 'domain');

function apiSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === 'node_modules' || name === 'dist' ? [] : apiSources(path);
    return /\/api\/[^/]+\.ts$/.test(path) && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('API DTO class names', () => {
  it('are unique across bounded contexts', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const file of apiSources(DOMAINS))
      for (const m of readFileSync(file, 'utf8').matchAll(/class (\w+Dto) extends/g)) {
        const other = seen.get(m[1]!);
        if (other && other !== file) duplicates.push(`${m[1]}: ${other} and ${file}`);
        seen.set(m[1]!, file);
      }
    expect(duplicates).toEqual([]);
  });
});
