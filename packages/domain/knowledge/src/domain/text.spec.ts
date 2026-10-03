import { describe, expect, it } from 'vitest';
import { chunkText, fuseRanks, normalizeForSearch } from './text';

describe('normalization for keyword search', () => {
  it('unifies Arabic spelling variants and strips diacritics', () => {
    expect(normalizeForSearch('إفطارٌ مجّانيّ')).toBe(normalizeForSearch('افطار مجاني'));
    expect(normalizeForSearch('المكتبة')).toBe('مكتبه');
    expect(normalizeForSearch('مستشفى')).toBe('مستشفي');
    expect(normalizeForSearch('الفـــطار')).toBe('فطار');
    expect(normalizeForSearch('Check-out at 12:00!')).toBe('check out at 12 00');
    expect(normalizeForSearch('من ٧ لـ ١٠')).toBe('من 7 لـ 10'.replace('لـ', 'ل'));
    expect(normalizeForSearch('۷')).toBe('7');
  });

  it('strips the definite article and its prefixes, but not from short words', () => {
    expect(normalizeForSearch('بالمطعم والإفطار للمسبح')).toBe('مطعم افطار مسبح');
    expect(normalizeForSearch('الإفطار')).toBe(normalizeForSearch('إفطار'));
    expect(normalizeForSearch('الف')).toBe('الف');
  });
});

describe('chunking', () => {
  it('keeps short paragraphs together and splits long ones at sentences with one sentence of overlap', () => {
    expect(chunkText('Pool opens at 7.\n\nBreakfast is served until 10.')).toEqual([
      'Pool opens at 7.\n\nBreakfast is served until 10.',
    ]);
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(long, 200);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 260)).toBe(true);
    // Overlap: each chunk after the first starts with the last sentence of the previous one.
    const lastOfFirst = chunks[0]!.split('. ').at(-1)!;
    expect(chunks[1]!.startsWith(lastOfFirst.replace(/\.$/, ''))).toBe(true);
    expect(chunkText('')).toEqual([]);
  });
});

describe('rank fusion', () => {
  it('rewards items ranked well in several lists', () => {
    const scores = fuseRanks([
      ['a', 'b', 'c'],
      ['b', 'c', 'd'],
    ]);
    const order = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order).toEqual(['b', 'c', 'a', 'd']);
  });
});
