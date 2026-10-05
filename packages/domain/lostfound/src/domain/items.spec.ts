import { describe, expect, it } from 'vitest';
import {
  duplicateScore,
  type FoundSide,
  isOpen,
  matchScore,
  type MatchSide,
  mergeSuggestions,
  retentionUntil,
} from './items';

const day = 86_400_000;
const at = new Date('2026-10-03T10:00:00Z');
const lost: MatchSide = {
  category: 'PHONE',
  colour: 'BLACK',
  brand: 'Samsung',
  locationId: 'room-504',
  at,
};

describe('matchScore', () => {
  it('scores the same phone found in the same room the next day as a strong match, with its reasons', () => {
    const m = matchScore({ ...lost, brand: ' SAMSUNG ', at: new Date(at.getTime() + day) }, lost);
    expect(m).toEqual({
      score: 100,
      reasons: ['CATEGORY', 'COLOUR', 'BRAND', 'LOCATION', 'DATE_CLOSE'],
    });
  });

  it('never matches another category or outside the date window', () => {
    expect(matchScore({ ...lost, category: 'WATCH' }, lost)).toBeNull();
    expect(matchScore({ ...lost, at: new Date(at.getTime() - 2 * day) }, lost)).toBeNull();
    expect(matchScore({ ...lost, at: new Date(at.getTime() + 31 * day) }, lost)).toBeNull();
  });

  it('a different colour or brand recorded by staff counts against the match', () => {
    expect(matchScore({ ...lost, colour: 'WHITE', brand: 'Apple' }, lost)).toBeNull();
  });

  it('AI-derived attributes fill gaps but weigh less than recorded ones', () => {
    const found: MatchSide = {
      category: 'PHONE',
      colour: null,
      brand: null,
      locationId: null,
      at: new Date(at.getTime() + 5 * day),
      ai: { colours: ['BLACK'], brand: 'samsung' },
    };
    expect(matchScore(found, lost)).toEqual({
      score: 60,
      reasons: ['CATEGORY', 'COLOUR_AI', 'BRAND_AI'],
    });
    expect(matchScore({ ...found, ai: null }, lost)).toBeNull();
  });
});

describe('lifecycle', () => {
  it('registered and matched items are open; released, claimed and disposed are final', () => {
    expect(isOpen('REGISTERED')).toBe(true);
    expect(isOpen('MATCHED')).toBe(true);
    expect(isOpen('RELEASED')).toBe(false);
    expect(isOpen('DISPOSED')).toBe(false);
  });

  it('keeps an item until the retention date', () => {
    expect(retentionUntil(at, 90)).toBe('2027-01-01');
  });
});

describe('photo readings (BUILD_PLAN 9.5)', () => {
  it('merges the description and photo readings into one set of signals', () => {
    expect(mergeSuggestions([])).toBeNull();
    expect(
      mergeSuggestions([
        { objectType: null, colours: ['BLACK'], brand: null },
        { objectType: 'sunglasses', colours: ['BLACK', 'GOLD'], brand: 'Ray-Ban' },
        { objectType: 'glasses case', colours: ['BROWN'], brand: 'Other' },
      ]),
    ).toEqual({ objectType: 'sunglasses', colours: ['BLACK', 'GOLD', 'BROWN'], brand: 'Ray-Ban' });
  });

  const glasses: FoundSide = {
    colour: null,
    brand: null,
    locationId: 'pool',
    at,
    ai: { objectType: 'Sunglasses', colours: ['BLACK'], brand: 'Ray-Ban' },
  };

  it('flags the same sunglasses handed in twice at the pool, with its reasons', () => {
    expect(
      duplicateScore(glasses, {
        ...glasses,
        at: new Date(at.getTime() + day),
        ai: { objectType: 'sunglasses ', colours: ['BLACK', 'GOLD'], brand: 'RAY BAN' },
      }),
    ).toEqual({ score: 100, reasons: ['OBJECT_TYPE', 'COLOUR', 'BRAND', 'LOCATION'] });
  });

  it('needs the same kind of object named by a model, a close date, and no contradicting brand', () => {
    expect(
      duplicateScore(glasses, { ...glasses, ai: { ...glasses.ai!, objectType: 'watch' } }),
    ).toBeNull();
    expect(duplicateScore(glasses, { ...glasses, ai: null })).toBeNull();
    expect(
      duplicateScore(glasses, { ...glasses, at: new Date(at.getTime() + 4 * day) }),
    ).toBeNull();
    expect(
      duplicateScore(glasses, { ...glasses, ai: { ...glasses.ai!, brand: 'Oakley' } }),
    ).toBeNull();
    // Staff-recorded colour counts: a white pair is not the black one.
    expect(
      duplicateScore(glasses, {
        ...glasses,
        colour: 'WHITE',
        locationId: null,
        ai: { ...glasses.ai!, brand: null },
      }),
    ).toBeNull();
  });
});
