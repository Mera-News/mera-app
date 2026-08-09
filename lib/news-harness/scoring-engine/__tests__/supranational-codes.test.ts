// supranational-codes — the app-side mirror of
// mera-server/libs/mera-shared/src/enrichment/supranational-codes.ts.
//
// The trap this whole module exists to avoid: EU is exactly two characters,
// the same length as every real ISO-3166 alpha-2 country code, so membership
// must be decided by an allowlist lookup — never by `code.length > 2` (which
// would wrongly say EU is NOT supranational) or `code.length === 2` (which
// would wrongly say every two-letter code IS). Every test in this file that
// exercises EU is there specifically to fail if someone reintroduces a
// length-based check.

import {
  SUPRANATIONAL_CODES,
  isSupranationalCode,
  supranationalName,
  type SupranationalCode,
} from '../supranational-codes';

describe('SUPRANATIONAL_CODES', () => {
  it('is the exact closed set from the server canonical list', () => {
    expect(Object.keys(SUPRANATIONAL_CODES).sort()).toEqual(
      [
        'EU',
        'EUROPE',
        'MIDDLE_EAST',
        'NORTH_AFRICA',
        'SUB_SAHARAN_AFRICA',
        'AFRICA',
        'ASIA',
        'SOUTH_ASIA',
        'SOUTHEAST_ASIA',
        'CENTRAL_ASIA',
        'EAST_ASIA',
        'NORTH_AMERICA',
        'CENTRAL_AMERICA',
        'SOUTH_AMERICA',
        'LATIN_AMERICA',
        'CARIBBEAN',
        'OCEANIA',
        'BALKANS',
        'NORDICS',
        'BALTICS',
        'GULF',
        'GLOBAL',
      ].sort(),
    );
  });

  it('is frozen — the closed set cannot be mutated at runtime', () => {
    expect(Object.isFrozen(SUPRANATIONAL_CODES)).toBe(true);
  });

  it('EU maps to "European Union"', () => {
    expect(SUPRANATIONAL_CODES.EU).toBe('European Union');
  });
});

describe('isSupranationalCode', () => {
  it('is true for every member of the curated set', () => {
    for (const code of Object.keys(SUPRANATIONAL_CODES) as SupranationalCode[]) {
      expect(isSupranationalCode(code)).toBe(true);
    }
  });

  it('THE TWO-CHARACTER TRAP: EU (length 2) is supranational', () => {
    // A `code.length > 2` implementation returns false here — that is exactly
    // the bug this test exists to catch.
    expect(isSupranationalCode('EU')).toBe(true);
    expect('EU'.length).toBe(2);
  });

  it('THE TWO-CHARACTER TRAP: real two-letter ISO country codes are NOT supranational', () => {
    // A `code.length === 2` (or `<= 2`) implementation returns true here —
    // the opposite bug: every real country would be misclassified as a bloc.
    for (const iso of ['FR', 'US', 'GB', 'IN', 'NL', 'ET', 'SA', 'AF', 'AS', 'NA']) {
      expect(isSupranationalCode(iso)).toBe(false);
    }
  });

  it('is false for a longer, non-member token (not an open vocabulary)', () => {
    expect(isSupranationalCode('SCANDINAVIA')).toBe(false);
    expect(isSupranationalCode('SOUTHERN_EUROPE')).toBe(false);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isSupranationalCode('eu')).toBe(true);
    expect(isSupranationalCode('middle_east')).toBe(true);
    expect(isSupranationalCode(' MIDDLE_EAST ')).toBe(true);
    expect(isSupranationalCode('Middle_East')).toBe(true);
  });

  it('is false for null/undefined/empty, never throws', () => {
    expect(isSupranationalCode(null)).toBe(false);
    expect(isSupranationalCode(undefined)).toBe(false);
    expect(isSupranationalCode('')).toBe(false);
  });
});

describe('supranationalName', () => {
  it('returns the English name for every member', () => {
    expect(supranationalName('MIDDLE_EAST')).toBe('Middle East');
    expect(supranationalName('EU')).toBe('European Union');
    expect(supranationalName('GLOBAL')).toBe('Global');
  });

  it('returns null for a real ISO alpha-2 country code, including EU-length ones', () => {
    expect(supranationalName('FR')).toBeNull();
    expect(supranationalName('US')).toBeNull();
    expect(supranationalName('ET')).toBeNull(); // two letters, not EU
  });

  it('returns null for null/undefined/empty, never throws', () => {
    expect(supranationalName(null)).toBeNull();
    expect(supranationalName(undefined)).toBeNull();
    expect(supranationalName('')).toBeNull();
  });

  it('is case-insensitive and trims whitespace, matching isSupranationalCode', () => {
    expect(supranationalName(' eu ')).toBe('European Union');
    expect(supranationalName('gulf')).toBe('Gulf');
  });
});
