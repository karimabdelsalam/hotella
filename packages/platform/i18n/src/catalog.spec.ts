import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkMessages, findLocalesDir, SUPPORTED_LOCALES } from './catalog';

describe('message checks across locales (ADR-0022)', () => {
  const en = { 'x.count': '{count, plural, one {# item} other {# items}} in {room}' };

  it('accepts a locale that offers its own CLDR plural categories', () => {
    const ok = {
      en,
      ru: {
        'x.count':
          '{count, plural, one {# вещь} few {# вещи} many {# вещей} other {# вещи}} в {room}',
      },
      de: { 'x.count': '{count, plural, one {# Sache} other {# Sachen}} in {room}' },
      ar: {
        'x.count':
          '{count, plural, =0 {لا شيء} one {شيء} two {شيئان} few {# أشياء} many {# شيئًا} other {# شيء}} في {room}',
      },
    };
    expect(checkMessages(ok)).toEqual([]);
  });

  it('reports missing plural forms, missing or unknown arguments and invalid ICU', () => {
    const bad = {
      en,
      ru: { 'x.count': '{count, plural, one {# вещь} other {# вещи}} в {room}' },
      de: { 'x.count': '{count, plural, one {# Sache} other {# Sachen}} im {zimmer}' },
      ar: { 'x.count': '{count, plural, one {شيء}' },
    };
    const problems = checkMessages(bad);
    expect(problems).toContain('ru: "x.count" — {count, plural} lacks the "few" form');
    expect(problems).toContain('ru: "x.count" — {count, plural} lacks the "many" form');
    expect(problems).toContain('de: "x.count" does not use {room}');
    expect(problems).toContain('de: "x.count" uses unknown {zimmer}');
    expect(problems.some((p) => p.startsWith('ar: "x.count" is not valid ICU'))).toBe(true);
  });

  it('ships a catalog for exactly the supported locales', () => {
    const dir = findLocalesDir(undefined, process.cwd());
    const present = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(present).toEqual([...SUPPORTED_LOCALES].sort());
  });
});
