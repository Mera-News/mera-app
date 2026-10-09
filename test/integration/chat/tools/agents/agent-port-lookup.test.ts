// The device port's place lookup and `find_similar_facts`, end to end: the real place-service and
// Apollo client talk to MSW (`PlaceSearch` scripted per test), the facts are real rows. What the
// port SENT to the server is read back from the recorded variables.
import { lookupPlaceWithFallback, makeAgentToolPort } from '@/lib/chat-tools/agent-device-port';
import { mockGql, mockGqlError, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, seedFacts } from '@/test/integration/chat/_helpers';

type Row = { _id: string; city: string; region: string; countryCode: string; displayName: string; normalized: string; population: number; search_keys: string[] };

const row = (city: string, countryCode = 'NL', keys: string[] = [city.toLowerCase()], region = 'North Holland'): Row => ({
  _id: `${countryCode}-${city}`,
  city,
  region,
  countryCode,
  displayName: `${city}, ${region}`,
  normalized: city.toLowerCase(),
  population: 1000,
  search_keys: keys,
});

/** Scripts `PlaceSearch`: each query (lower-cased) maps to its rows, anything else is an empty list.
 *  Returns the queries the port sent, in order. */
function servePlaces(table: Record<string, Row[]>): string[] {
  const sent: string[] = [];
  server.use(
    mockGql('PlaceSearch', (variables) => {
      const query = String(variables.query);
      sent.push(query);
      return { placeSearch: table[query.toLowerCase()] ?? [] };
    }),
  );
  return sent;
}

const localities = (out: Awaited<ReturnType<typeof lookupPlaceWithFallback>>): string[] =>
  out.status === 'resolved' ? out.places.map((p) => p.locality) : [];

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});

describe('lookupPlaceWithFallback over the server', () => {
  it('asks nothing rather than offering three towns the user never named', async () => {
    // "nieuw west": the whole form and "west" miss, "nieuw" returns prefix noise.
    const sent = servePlaces({
      nieuw: [row('Amstelveen', 'NL', ['amstelveen', 'nieuwer-amstel']), row('Nieuwegein'), row('Nieuw-Vennep')],
    });

    const out = await lookupPlaceWithFallback({ query: 'nieuw west' });

    expect(out.status).toBe('no_match');
    // The ladder walked every form before giving up.
    expect(sent).toEqual(['nieuw west', 'west', 'nieuw']);
  });

  it('still resolves the city out of a neighbourhood phrase, and returns the words it did not use', async () => {
    const sent = servePlaces({
      amsterdam: [row('Amsterdam'), row('Amsterdam-Zuidoost'), row('Nieuw-Amsterdam')],
    });

    const out = await lookupPlaceWithFallback({ query: 'Nieuw-West Amsterdam' });

    expect(localities(out)).toEqual(['Amsterdam']);
    expect(out).toMatchObject({ status: 'resolved', unmatched: 'Nieuw-West' });
    // Whole phrase first, then the widest tail; it stopped at the first fallback form that earned it.
    expect(sent).toEqual(['Nieuw-West Amsterdam', 'Amsterdam']);
  });

  it('ux2 D1: returns the words the fallback match did not use', async () => {
    servePlaces({ amsterdam: [row('Amsterdam')] });
    const out = await lookupPlaceWithFallback({ query: 'niew west Amsterdam' });
    expect(out).toMatchObject({ status: 'resolved', unmatched: 'niew west' });
  });

  it('keeps real ambiguity when the user typed the query THEMSELVES', async () => {
    // Not a fallback form, so the higher bar must not apply: the user asked for "Newcastle".
    const sent = servePlaces({
      newcastle: [
        row('Newcastle upon Tyne', 'GB', ['newcastle upon tyne'], 'England'),
        row('Newcastle-under-Lyme', 'GB', ['newcastle-under-lyme'], 'England'),
      ],
    });

    const out = await lookupPlaceWithFallback({ query: 'Newcastle' });

    expect(localities(out)).toEqual(['Newcastle upon Tyne', 'Newcastle-under-Lyme']);
    // One lookup, plus one search for rows named exactly "Newcastle" (none exist).
    expect(sent).toEqual(['Newcastle', 'Newcastle']);
  });

  it('ux2 D13: an alias match carries the user term, a name match does not', async () => {
    const vila = row('Vila Baleira', 'PT', ['vila baleira', 'porto santo'], 'Madeira');
    servePlaces({ 'porto santo': [vila], amsterdam: [row('Amsterdam')] });

    const alias = await lookupPlaceWithFallback({ query: 'porto santo' });
    expect(alias.status === 'resolved' && alias.places[0].userTerm).toBe('Porto Santo');

    const named = await lookupPlaceWithFallback({ query: 'Amsterdam' });
    expect(named.status === 'resolved' && named.places[0].userTerm).toBeUndefined();
    expect(named).not.toHaveProperty('unmatched');
  });

  it('a lookup that FAILED stops the ladder and is never a confident no-such-place', async () => {
    let calls = 0;
    server.use(
      mockGqlError('PlaceSearch', 'INTERNAL_SERVER_ERROR', { message: 'down' }),
    );
    server.events.on('request:start', () => (calls += 1));

    const out = await lookupPlaceWithFallback({ query: 'Nieuw-West Amsterdam' });

    expect(out.status).toBe('unavailable');
    // No narrower form was tried against a server that had just failed.
    expect(calls).toBe(1);
  });

  it('a genuine zero-result is no_match, which is not the same answer as unavailable', async () => {
    servePlaces({});
    const out = await lookupPlaceWithFallback({ query: 'Atlantis' });
    expect(out.status).toBe('no_match');
  });

  it('forwards the country hint as a filter: a hint that matches nothing never falls through to another country', async () => {
    servePlaces({ springfield: [row('Springfield', 'US', ['springfield'], 'Illinois'), row('Springfield', 'GB', ['springfield'], 'England')] });
    const hinted = await lookupPlaceWithFallback({ query: 'Springfield', countryHint: 'gb' });
    expect(hinted.status === 'resolved' && hinted.places.map((p) => p.countryCode)).toEqual(['GB']);

    const missed = await lookupPlaceWithFallback({ query: 'Springfield', countryHint: 'FR' });
    expect(missed.status).toBe('no_match');
  });
});

// ux1 C1: "Porto" offered Porto Alegre, Port-au-Prince and Porto Velho, because the real Porto
// ranked fourth by population and was cut at three.
describe('the place named exactly survives the candidate cap', () => {
  const portoRows = (): Record<string, Row[]> => ({
    porto: [
      row('Porto Alegre', 'BR', ['porto alegre'], 'RS'),
      row('Port-au-Prince', 'HT', ['port au prince', 'porto principe'], 'Ouest'),
      row('Porto Velho', 'BR', ['porto velho'], 'RO'),
      row('Porto', 'PT', ['porto'], 'Porto'),
    ],
  });

  it('fetches the exact-name row and resolves to it alone', async () => {
    const sent = servePlaces(portoRows());

    const out = await lookupPlaceWithFallback({ query: 'Porto' });

    expect(localities(out)).toEqual(['Porto']);
    // The lookup, the search for exact names, then one country-restricted lookup for Portugal.
    expect(sent).toEqual(['Porto', 'Porto', 'Porto']);
  });

  it('asks nothing extra when an exact match is already among the three', async () => {
    const sent = servePlaces({ amsterdam: [row('Amsterdam'), row('Amstelveen')] });

    await lookupPlaceWithFallback({ query: 'Amsterdam' });

    expect(sent).toEqual(['Amsterdam']);
  });

  it('asks nothing extra when the caller already gave a country', async () => {
    const sent = servePlaces(portoRows());

    const out = await lookupPlaceWithFallback({ query: 'Porto', countryHint: 'BR' });

    expect(sent).toEqual(['Porto']);
    expect(localities(out)).toEqual(['Porto Alegre', 'Porto Velho']);
  });
});

// ux2 batch 25 D2: "Porto Santo" is an exact search key of Vila Baleira and only a prefix of Porto
// Santo Stefano, so Vila Baleira is the place the user named.
describe('an EXACT alias beats a prefix match', () => {
  it('"Porto Santo" resolves to Vila Baleira alone, carrying the user term', async () => {
    servePlaces({
      'porto santo': [
        row('Porto Santo Stefano', 'IT', ['porto santo stefano'], 'Tuscany'),
        row('Vila Baleira', 'PT', ['vila baleira', 'porto santo', 'vila de porto santo'], 'Madeira'),
      ],
    });

    const out = await lookupPlaceWithFallback({ query: 'Porto Santo' });

    expect(out.status === 'resolved' && out.places.map((p) => [p.locality, p.userTerm])).toEqual([['Vila Baleira', 'Porto Santo']]);
  });

  it('a PREFIX alias is not exact: "Porto" never resolves to Port-au-Prince', async () => {
    servePlaces({
      porto: [
        row('Porto Alegre', 'BR', ['porto alegre'], 'RS'),
        row('Port-au-Prince', 'HT', ['port au prince', 'porto principe'], 'Ouest'),
      ],
    });

    const out = await lookupPlaceWithFallback({ query: 'Porto' });

    expect(localities(out)).toEqual(['Porto Alegre', 'Port-au-Prince']);
  });
});

// ux1 batch 5: the model was told "no existing residence fact" while "Lives in Berlin..." was on
// file, because similarity to "I moved to Porto" is zero.
describe('find_similar_facts always shows the current home on a residence lookup', () => {
  const HOME_KEY = 'location: neighborhood/area, city, and country (preserve specifics)';

  const candidatesFor = async (message: string, kind?: string): Promise<string[]> => {
    const out = await makeAgentToolPort(message).findSimilarFacts({ kind });
    return out.candidates.map((c) => c.statement);
  };

  it('puts the home first even when it shares no word with the message', async () => {
    await seedFacts([
      { statement: 'Product manager', attribute: 'profession: job role and industry' },
      { statement: 'Lives in Berlin, Germany, EU', attribute: HOME_KEY },
    ]);

    const out = await makeAgentToolPort('I moved to Porto').findSimilarFacts({ kind: 'residence' });

    expect(out.candidates.map((c) => c.statement)).toEqual(['Lives in Berlin, Germany, EU', 'Product manager']);
    expect(out.candidates[0]).toMatchObject({ attribute: HOME_KEY, overlap: 1 });
  });

  it('leaves other kinds alone: the home is only ranked by similarity, not promoted', async () => {
    await seedFacts([
      { statement: 'Lives in Berlin, Germany, EU', attribute: HOME_KEY },
      { statement: 'Plays chess', attribute: 'hobbies: x' },
    ]);

    const out = await makeAgentToolPort('Plays chess').findSimilarFacts({ kind: 'interest' });

    expect(out.candidates.map((c) => [c.statement, c.overlap])).toEqual([
      ['Plays chess', 1],
      ['Lives in Berlin, Germany, EU', 0],
    ]);
  });

  it('lists the home once when similarity finds it as well, and treats location and home as residence kinds', async () => {
    await seedFacts([{ statement: 'Lives in Berlin, Germany, EU', attribute: HOME_KEY }]);
    for (const kind of ['location', 'home', 'RESIDENCE']) {
      expect(await candidatesFor('Berlin Germany', kind)).toEqual(['Lives in Berlin, Germany, EU']);
    }
  });

  it('never presents a relative home or the retired combined origin fact as the user home', async () => {
    await seedFacts([
      { statement: 'Parents live in Delhi, India', attribute: HOME_KEY },
      { statement: 'Expat from India living in Berlin, Germany', attribute: 'background: origin and current residence' },
      { statement: 'Lives in Berlin, Germany, EU' },
    ]);

    const out = await makeAgentToolPort('I moved to Porto').findSimilarFacts({ kind: 'residence' });

    // Only the user's own home is pinned (score 1); the others are plain similarity rows at zero.
    expect(out.candidates[0]).toMatchObject({ statement: 'Lives in Berlin, Germany, EU', overlap: 1 });
    expect(out.candidates.slice(1).map((c) => c.overlap)).toEqual([0, 0]);
    expect(out.candidates.slice(1).map((c) => c.statement).sort()).toEqual([
      'Expat from India living in Berlin, Germany',
      'Parents live in Delhi, India',
    ]);
  });
});
