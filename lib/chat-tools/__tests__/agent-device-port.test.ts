// agent-device-port — the place-lookup ladder.
//
// The module reaches fact-service -> lib/database/index, which builds a real
// SQLiteAdapter at module scope and kills the suite at load. Mock at the
// service boundary, the same way useCloudPersonaChat.test.tsx does.
jest.mock('../../database/services/fact-similarity-service', () => ({ findSimilarFacts: jest.fn() }));
jest.mock('../../place-service', () => ({ lookupPlace: jest.fn() }));
jest.mock('../../llm/cloudComplete', () => ({ cloudChatStream: jest.fn() }));
jest.mock('../../database/services/fact-service', () => ({ getFacts: jest.fn() }));
jest.mock('../tool-handlers', () => ({
  handleDeleteUserFacts: jest.fn(),
  handleSaveExtractedFacts: jest.fn(),
}));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  fallbackCandidates,
  lookupPlaceWithFallback,
  narrowToExact,
  placeQueryForms,
} from '../agent-device-port';
import { lookupPlace } from '../../place-service';

const mockLookupPlace = lookupPlace as jest.MockedFunction<typeof lookupPlace>;
import type { Place } from '@/lib/mera-harness';

const place = (locality: string): Place => ({
  neighbourhood: undefined,
  locality,
  admin1: 'North Holland',
  countryCode: 'NL',
  countryName: 'Netherlands',
  bloc: 'EU',
});

describe('placeQueryForms', () => {
  it('falls back from the whole phrase to its words', () => {
    const forms = placeQueryForms('Nieuw-West Amsterdam');
    expect(forms[0]).toBe('Nieuw-West Amsterdam');
    expect(forms).toContain('Amsterdam');
  });
});

describe('narrowToExact', () => {
  // THE DEVICE CASE. placeSearch is an anchored PREFIX match, so the fallback
  // form "Amsterdam" returns three rows. Handing all three back read as
  // ambiguity and the agent asked "which Amsterdam?" offering
  // Amsterdam-Zuidoost and Nieuw-Amsterdam, neither of which the user said.
  it('takes the exact name over the prefix matches beside it', () => {
    const out = narrowToExact(
      [place('Amsterdam'), place('Amsterdam-Zuidoost'), place('Nieuw-Amsterdam')],
      'Amsterdam',
    );
    expect(out.map((p) => p.locality)).toEqual(['Amsterdam']);
  });

  it('is case and whitespace insensitive', () => {
    const out = narrowToExact([place('Amsterdam'), place('Amsterdam-Zuidoost')], '  amsterdam ');
    expect(out).toHaveLength(1);
  });

  // REAL AMBIGUITY SURVIVES. Two places genuinely sharing a name is the case
  // the choice chips exist for, and narrowing it would pick one at random.
  it('keeps two places that share the same name', () => {
    const tyne = { ...place('Newcastle'), admin1: 'Tyne and Wear' };
    const lyme = { ...place('Newcastle'), admin1: 'Staffordshire' };
    expect(narrowToExact([tyne, lyme], 'Newcastle')).toHaveLength(2);
  });

  it('leaves a list with no exact match alone', () => {
    const out = narrowToExact([place('Amsterdam-Zuidoost'), place('Nieuw-Amsterdam')], 'Amsterdam');
    expect(out).toHaveLength(2);
  });

  it('leaves a single result alone', () => {
    expect(narrowToExact([place('Amsterdam')], 'Amsterdam')).toHaveLength(1);
  });
});

describe('fallbackCandidates', () => {
  // THE DEVICE CASE, 2026-09-21. The agent looked up "nieuw west"; the whole
  // form and "west" both missed, and the chain reached the bare word "nieuw".
  // `placeSearch` is an anchored prefix over a multikey array that includes
  // Latin ALTERNATE names, so ^nieuw hits Amstelveen (historic name
  // Nieuwer-Amstel), Nieuwegein and Nieuw-Vennep, population-sorted. The user
  // was asked to choose between three towns they never mentioned.
  it('rejects prefix noise that does not bear the form name', () => {
    const noise = [place('Amstelveen'), place('Nieuwegein'), place('Nieuw-Vennep')];
    expect(fallbackCandidates(noise, 'nieuw')).toBeNull();
  });

  it('accepts the one exact match among prefix neighbours', () => {
    const out = fallbackCandidates(
      [place('Amsterdam'), place('Amsterdam-Zuidoost'), place('Nieuw-Amsterdam')],
      'Amsterdam',
    );
    expect(out?.map((p) => p.locality)).toEqual(['Amsterdam']);
  });

  it('accepts genuine same-name ambiguity, which is what the chips are for', () => {
    const twins = [place('Newcastle'), place('Newcastle')];
    expect(fallbackCandidates(twins, 'Newcastle')).toHaveLength(2);
  });

  it('rejects a lone near-miss: one wrong answer is still a wrong answer', () => {
    expect(fallbackCandidates([place('Nieuwegein')], 'nieuw')).toBeNull();
  });

  it('is case and whitespace insensitive', () => {
    expect(fallbackCandidates([place('Amsterdam')], '  amsterdam ')).toHaveLength(1);
  });
});

describe('lookupPlaceWithFallback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('asks nothing rather than offering three towns the user never named', async () => {
    // "nieuw west": the whole form and "west" miss, "nieuw" returns noise.
    mockLookupPlace.mockImplementation(async (q: string) => {
      if (q.toLowerCase() === 'nieuw') {
        return {
          status: 'resolved' as const,
          places: [place('Amstelveen'), place('Nieuwegein'), place('Nieuw-Vennep')],
        };
      }
      return { status: 'no_match' as const, query: q };
    });

    const out = await lookupPlaceWithFallback({ query: 'nieuw west' });

    expect(out.status).toBe('no_match');
  });

  it('still resolves the city out of a neighbourhood phrase', async () => {
    // The case the ladder was built for, and the gate must not cost it.
    mockLookupPlace.mockImplementation(async (q: string) => {
      if (q.toLowerCase() === 'amsterdam') {
        return {
          status: 'resolved' as const,
          places: [place('Amsterdam'), place('Amsterdam-Zuidoost'), place('Nieuw-Amsterdam')],
        };
      }
      return { status: 'no_match' as const, query: q };
    });

    const out = await lookupPlaceWithFallback({ query: 'Nieuw-West Amsterdam' });

    expect(out.status).toBe('resolved');
    expect(out.status === 'resolved' && out.places.map((p) => p.locality)).toEqual(['Amsterdam']);
  });

  it('keeps real ambiguity when the user typed the query THEMSELVES', async () => {
    // Not a fallback form, so the higher bar must not apply: the user asked
    // for "Newcastle" and deserves the choice.
    mockLookupPlace.mockResolvedValue({
      status: 'resolved' as const,
      places: [place('Newcastle upon Tyne'), place('Newcastle-under-Lyme')],
    });

    const out = await lookupPlaceWithFallback({ query: 'Newcastle' });

    expect(out.status).toBe('resolved');
    expect(out.status === 'resolved' && out.places).toHaveLength(2);
  });

  it('a transport failure never becomes a confident no-such-place', async () => {
    mockLookupPlace.mockResolvedValue({ status: 'unavailable' as const });
    const out = await lookupPlaceWithFallback({ query: 'Nieuw-West Amsterdam' });
    expect(out.status).toBe('unavailable');
  });
});
