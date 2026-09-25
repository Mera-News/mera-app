// agent-device-port — the place-lookup ladder.
//
// The module reaches fact-service -> lib/database/index, which builds a real
// SQLiteAdapter at module scope and kills the suite at load. Mock at the
// service boundary, the same way useCloudPersonaChat.test.tsx does.
jest.mock('../../database/services/fact-similarity-service', () => ({ findSimilarFacts: jest.fn() }));
jest.mock('../../place-service', () => ({
  lookupPlace: jest.fn(),
  searchPlaces: jest.fn(async () => ({ ok: true, places: [] })),
  PLACE_CANDIDATE_LIMIT: 3,
}));
jest.mock('../../llm/cloudComplete', () => ({ cloudChatStream: jest.fn() }));
jest.mock('../../database/services/fact-service', () => ({ getFacts: jest.fn() }));
jest.mock('../tool-handlers', () => ({
  handleDeleteUserFacts: jest.fn(),
  handleSaveExtractedFacts: jest.fn(),
}));
const mockHandleWebSearch = jest.fn(async () => ({ searched: true, results: [] }));
jest.mock('../web-search-handler', () => ({
  handleWebSearch: (...a: unknown[]) => mockHandleWebSearch(...(a as [])),
}));
let mockWebSearchInChat = true;
jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => ({ webSearchInChat: mockWebSearchInChat }) },
}));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  callModelViaCloud,
  makeAgentDeps,
  fallbackCandidates,
  lookupPlaceWithFallback,
  narrowToExact,
  placeQueryForms,
} from '../agent-device-port';
import { lookupPlace, searchPlaces } from '../../place-service';

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

  it('ux2 D1: returns the words the fallback match did not use', async () => {
    mockLookupPlace.mockImplementation(async (q: string) =>
      q.toLowerCase() === 'amsterdam'
        ? { status: 'resolved' as const, places: [place('Amsterdam')] }
        : { status: 'no_match' as const, query: q },
    );
    const out = await lookupPlaceWithFallback({ query: 'niew west Amsterdam' });
    expect(out).toMatchObject({ status: 'resolved', unmatched: 'niew west' });
  });

  it('ux2 D13: an alias match carries the user term, a name match does not', async () => {
    const vila: Place = { ...place('Vila Baleira'), admin1: 'Madeira', countryCode: 'PT', countryName: 'Portugal' };
    mockLookupPlace.mockResolvedValue({ status: 'resolved' as const, places: [vila] });
    const alias = await lookupPlaceWithFallback({ query: 'porto santo' });
    expect(alias.status === 'resolved' && alias.places[0].userTerm).toBe('Porto Santo');

    mockLookupPlace.mockResolvedValue({ status: 'resolved' as const, places: [place('Amsterdam')] });
    const named = await lookupPlaceWithFallback({ query: 'Amsterdam' });
    expect(named.status === 'resolved' && named.places[0].userTerm).toBeUndefined();
    expect(named).not.toHaveProperty('unmatched');
  });

  it('a transport failure never becomes a confident no-such-place', async () => {
    mockLookupPlace.mockResolvedValue({ status: 'unavailable' as const });
    const out = await lookupPlaceWithFallback({ query: 'Nieuw-West Amsterdam' });
    expect(out.status).toBe('unavailable');
  });
});


// ux1 C1: "Porto" offered Porto Alegre, Port-au-Prince and Porto Velho, because
// the real Porto ranked fourth by population and was cut at three.
describe('the place named exactly survives the candidate cap', () => {
  const mockSearch = searchPlaces as jest.MockedFunction<typeof searchPlaces>;
  const pt = (locality: string): Place => ({ ...place(locality), countryCode: 'PT', countryName: 'Portugal', admin1: 'Porto' });

  beforeEach(() => {
    mockLookupPlace.mockReset();
    mockSearch.mockReset();
  });

  it('fetches the exact-name row and resolves to it', async () => {
    mockLookupPlace.mockImplementation(async (_q: string, hint?: string) =>
      hint === 'PT'
        ? { status: 'resolved', places: [pt('Porto')] }
        : { status: 'resolved', places: [place('Porto Alegre'), place('Port-au-Prince'), place('Porto Velho')] },
    );
    mockSearch.mockResolvedValue({
      ok: true,
      places: [
        { city: 'Porto Alegre', countryCode: 'BR' },
        { city: 'Port-au-Prince', countryCode: 'HT' },
        { city: 'Porto Velho', countryCode: 'BR' },
        { city: 'Porto', countryCode: 'PT' },
      ] as never,
    });
    const out = await lookupPlaceWithFallback({ query: 'Porto' });
    expect(out.status).toBe('resolved');
    expect(out.status === 'resolved' && out.places.map((p) => p.locality)).toEqual(['Porto']);
  });

  it('asks nothing extra when an exact match is already among the three', async () => {
    mockLookupPlace.mockResolvedValue({ status: 'resolved', places: [place('Amsterdam'), place('Amstelveen')] });
    await lookupPlaceWithFallback({ query: 'Amsterdam' });
    expect(mockSearch).not.toHaveBeenCalled();
  });
});

// ux1 C1: every leg's text streamed into the acknowledgement bubble.
describe('makeAgentDeps streams only the leg the loop marks', () => {
  const { cloudChatStream } = require('../../llm/cloudComplete');
  async function* text(delta: string) {
    yield { type: 'text-delta', delta };
    yield { type: 'finish', reason: 'stop' };
  }
  it('forwards deltas for streamToUser legs only', async () => {
    (cloudChatStream as jest.Mock).mockImplementation(() => text('hi'));
    const onDelta = jest.fn();
    const deps = makeAgentDeps('msg', onDelta);
    const base = { role: 'tool' as const, model: 'BIG', systemPrompt: 's', messages: [] };
    await deps.callModel({ ...base });
    expect(onDelta).not.toHaveBeenCalled();
    await deps.callModel({ ...base, streamToUser: true });
    expect(onDelta).toHaveBeenCalledWith({ content: 'hi' });
    expect(callModelViaCloud).toBeDefined();
  });
});

// ux1 batch 5: the model was told "no existing residence fact" while "Lives in
// Berlin..." was on file, because similarity to "I moved to Porto" is zero.
describe('find_similar_facts always shows the current home on a residence lookup', () => {
  const { findSimilarFacts } = require('../../database/services/fact-similarity-service');
  const { getFacts } = require('../../database/services/fact-service');

  it('puts the home first even when it shares no word with the message', async () => {
    (findSimilarFacts as jest.Mock).mockResolvedValue([
      { id: 'job', statement: 'Product manager', questionnaireAttribute: 'profession: x', score: 0.2 },
    ]);
    (getFacts as jest.Mock).mockResolvedValue([
      { id: 'job', statement: 'Product manager', questionnaireAttribute: 'profession: x' },
      { id: 'berlin', statement: 'Lives in Berlin, Germany, EU', questionnaireAttribute: 'location: residence' },
    ]);
    const { makeAgentToolPort } = require('../agent-device-port');
    const out = await makeAgentToolPort('I moved to Porto').findSimilarFacts({ kind: 'residence' });
    expect(out.candidates.map((c: { factId: string }) => c.factId)).toEqual(['berlin', 'job']);
  });

  it('leaves other kinds alone', async () => {
    (findSimilarFacts as jest.Mock).mockResolvedValue([]);
    (getFacts as jest.Mock).mockResolvedValue([
      { id: 'berlin', statement: 'Lives in Berlin, Germany, EU', questionnaireAttribute: 'location: residence' },
    ]);
    const { makeAgentToolPort } = require('../agent-device-port');
    const out = await makeAgentToolPort('I play chess').findSimilarFacts({ kind: 'interest' });
    expect(out.candidates).toEqual([]);
  });
});


describe('ux2 D10: web search through the device port', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWebSearchInChat = true;
  });

  it('offers webSearch when the setting is on and runs it on the device', async () => {
    const deps = makeAgentDeps('what is porto santo', jest.fn());
    expect(typeof deps.tools.webSearch).toBe('function');
    await deps.tools.webSearch?.({ queries: ['Porto Santo'] });
    expect(mockHandleWebSearch).toHaveBeenCalledWith({ queries: ['Porto Santo'] });
  });

  it('offers no webSearch when the setting is off', () => {
    mockWebSearchInChat = false;
    const deps = makeAgentDeps('what is porto santo', jest.fn());
    expect(deps.tools.webSearch).toBeUndefined();
  });
});
