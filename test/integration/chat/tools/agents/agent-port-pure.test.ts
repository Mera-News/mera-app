// The pure half of the device port's place ladder: no network, no database. It lives in the
// integration project because importing the port pulls in the database and logger modules, which
// the unit project (no setup, no native mocks) cannot load.
import {
  fallbackCandidates,
  narrowToExact,
  placeQueryForms,
  unmatchedWords,
  withUserTerm,
} from '@/lib/chat-tools/agent-device-port';
import type { Place } from '@/lib/mera-harness';

const place = (locality: string, over: Partial<Place> = {}): Place => ({
  neighbourhood: undefined,
  locality,
  admin1: 'North Holland',
  countryCode: 'NL',
  countryName: 'Netherlands',
  bloc: 'EU',
  ...over,
});

describe('placeQueryForms', () => {
  it('falls back from the whole phrase to its words', () => {
    const forms = placeQueryForms('Nieuw-West Amsterdam');
    expect(forms[0]).toBe('Nieuw-West Amsterdam');
    expect(forms).toContain('Amsterdam');
  });

  it('tries the whole phrase, then comma segments widest first, then words from the end, then hyphenated words', () => {
    expect(placeQueryForms('Nieuw-West, Amsterdam').slice(0, 3)).toEqual([
      'Nieuw-West, Amsterdam',
      'Amsterdam',
      'Nieuw-West',
    ]);
    expect(placeQueryForms('niew west Amsterdam')).toEqual(['niew west Amsterdam', 'Amsterdam', 'west', 'niew']);
  });

  it('is deterministic, drops duplicates ignoring case, and drops forms under two characters', () => {
    expect(placeQueryForms('Rome rome')).toEqual(['Rome rome', 'rome']);
    expect(placeQueryForms('a b')).toEqual(['a b']);
    expect(placeQueryForms('Rome rome')).toEqual(placeQueryForms('Rome rome'));
  });

  it('returns nothing for a blank query', () => {
    expect(placeQueryForms('   ')).toEqual([]);
    expect(placeQueryForms('')).toEqual([]);
  });

  // BUG CANDIDATE (chat-U5b-1): the hyphen pass pushes the whitespace WORD, so a comma still glued
  // to it ("Nieuw-West,") becomes a lookup form. The server's prefix match can never hold it, so it
  // costs one wasted placeSearch round trip whenever every earlier form missed.
  test.failing('never offers a lookup form that still carries a comma', () => {
    expect(placeQueryForms('Nieuw-West, Amsterdam').filter((f) => f.includes(',') && f !== 'Nieuw-West, Amsterdam')).toEqual([]);
  });

  it('today: the comma-suffixed hyphen word is the last form tried', () => {
    expect(placeQueryForms('Nieuw-West, Amsterdam')).toEqual([
      'Nieuw-West, Amsterdam',
      'Amsterdam',
      'Nieuw-West',
      'Nieuw-West,',
    ]);
  });
});

describe('narrowToExact', () => {
  // THE DEVICE CASE. placeSearch is an anchored PREFIX match, so the fallback form "Amsterdam"
  // returns three rows. Handing all three back read as ambiguity and the agent asked "which
  // Amsterdam?" offering rows the user never said.
  it('takes the exact name over the prefix matches beside it', () => {
    const out = narrowToExact([place('Amsterdam'), place('Amsterdam-Zuidoost'), place('Nieuw-Amsterdam')], 'Amsterdam');
    expect(out.map((p) => p.locality)).toEqual(['Amsterdam']);
  });

  it('is case and whitespace insensitive', () => {
    const out = narrowToExact([place('Amsterdam'), place('Amsterdam-Zuidoost')], '  amsterdam ');
    expect(out).toHaveLength(1);
  });

  // Two places genuinely sharing a name is the case the choice chips exist for.
  it('keeps two places that share the same name', () => {
    const tyne = place('Newcastle', { admin1: 'Tyne and Wear' });
    const lyme = place('Newcastle', { admin1: 'Staffordshire' });
    expect(narrowToExact([tyne, lyme], 'Newcastle')).toHaveLength(2);
  });

  it('leaves a list with no exact match alone', () => {
    const out = narrowToExact([place('Amsterdam-Zuidoost'), place('Nieuw-Amsterdam')], 'Amsterdam');
    expect(out).toHaveLength(2);
  });

  it('leaves a single result alone', () => {
    expect(narrowToExact([place('Amsterdam')], 'Amsterdam')).toHaveLength(1);
    expect(narrowToExact([place('Elsewhere')], 'Amsterdam').map((p) => p.locality)).toEqual(['Elsewhere']);
  });
});

describe('fallbackCandidates', () => {
  // THE DEVICE CASE, 2026-09-21. The chain reached the bare word "nieuw", which prefix-hits
  // Amstelveen (historic name Nieuwer-Amstel), Nieuwegein and Nieuw-Vennep. The user was asked to
  // choose between three towns they never mentioned.
  it('rejects prefix noise that does not bear the form name', () => {
    const noise = [place('Amstelveen'), place('Nieuwegein'), place('Nieuw-Vennep')];
    expect(fallbackCandidates(noise, 'nieuw')).toBeNull();
  });

  it('accepts the one exact match among prefix neighbours', () => {
    const out = fallbackCandidates([place('Amsterdam'), place('Amsterdam-Zuidoost'), place('Nieuw-Amsterdam')], 'Amsterdam');
    expect(out?.map((p) => p.locality)).toEqual(['Amsterdam']);
  });

  it('accepts genuine same-name ambiguity, which is what the chips are for', () => {
    expect(fallbackCandidates([place('Newcastle'), place('Newcastle')], 'Newcastle')).toHaveLength(2);
  });

  it('rejects a lone near-miss: one wrong answer is still a wrong answer', () => {
    expect(fallbackCandidates([place('Nieuwegein')], 'nieuw')).toBeNull();
  });

  it('is case and whitespace insensitive', () => {
    expect(fallbackCandidates([place('Amsterdam')], '  amsterdam ')).toHaveLength(1);
  });

  it('rejects a mixed list where only some rows bear the name and others do not', () => {
    // Neither "exactly one" nor "all of them": the exact pair sits among unrelated rows.
    expect(fallbackCandidates([place('Newcastle'), place('Newcastle'), place('Newcastle West')], 'Newcastle')).toBeNull();
  });
});

describe('unmatchedWords', () => {
  it('returns the words the matched form did not use, in the user order, filler dropped', () => {
    expect(unmatchedWords('niew west Amsterdam', 'Amsterdam')).toBe('niew west');
    expect(unmatchedWords('near the Amsterdam area', 'Amsterdam')).toBe('');
  });
});

describe('withUserTerm', () => {
  const vila = place('Vila Baleira', { admin1: 'Madeira', countryCode: 'PT', countryName: 'Portugal' });

  it('stamps a single place reached through an alias with the user own term, title-cased when typed in lower case', () => {
    expect(withUserTerm([vila], 'porto santo')[0].userTerm).toBe('Porto Santo');
    expect(withUserTerm([vila], 'Porto Santo')[0].userTerm).toBe('Porto Santo');
  });

  it('leaves the locality itself, a prefix of it, and a list of several places alone', () => {
    expect(withUserTerm([vila], 'Vila Baleira')[0].userTerm).toBeUndefined();
    expect(withUserTerm([vila], 'vila')[0].userTerm).toBeUndefined();
    const two = [vila, place('Amsterdam')];
    expect(withUserTerm(two, 'porto santo')).toBe(two);
  });
});
