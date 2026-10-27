// geo-derivation — pure tier-1 rules, the tier-2 LLM contract, and the
// additive reconcile plan. The position rule (which resolver is allowed where)
// is the easiest thing to get wrong, so the ambiguity negatives are first-class
// cases here, not afterthoughts.

import {
  deriveCountriesFromFacts,
  buildFactPlacesRequest,
  decodeFactPlaces,
  selectFactsForPlaces,
  reconcileGeoPlan,
  type ExistingGeoRow,
  type GeoCandidate,
} from '@/lib/news-harness/persona-management/geo-derivation';
import { placesSourceHash, type ReaderPlace } from '@/lib/news-harness/persona-management/fact-places';

const ALLOWED = new Set(['NL', 'IN', 'BR', 'US', 'DE', 'GB', 'KZ']);

function fact(id: string, statement: string) {
  return { id, statement };
}

function codesFor(statements: string[]): string[] {
  const { resolved } = deriveCountriesFromFacts(
    statements.map((s, i) => fact(`f${i}`, s)),
  );
  return resolved.map((r) => r.countryCode);
}

describe('deriveCountriesFromFacts — tier 1 positives', () => {
  it('resolves a comma-chained statement with city + role', () => {
    const { resolved, unresolved } = deriveCountriesFromFacts([
      fact('f1', 'Lives in Amsterdam, Netherlands'),
    ]);
    expect(unresolved).toHaveLength(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      countryCode: 'NL',
      city: 'Amsterdam',
      role: 'home',
      sourceFactId: 'f1',
    });
    expect(resolved[0].weight).toBe(1.0);
  });

  it('resolves a full-ISO country the curated map does not carry, in a chain', () => {
    // Kazakhstan is absent from COUNTRY_CODES — the chain position is where
    // full-ISO matching is allowed.
    expect(codesFor(['Parents live in Almaty, Kazakhstan'])).toEqual(['KZ']);
  });

  it('resolves a preposition-anchored country with no comma chain', () => {
    expect(codesFor(['Works at a startup in Germany'])).toEqual(['DE']);
  });

  it('resolves an anchored country followed by trailing words', () => {
    expect(codesFor(['Moved to Kazakhstan last year'])).toEqual(['KZ']);
  });

  it('resolves a demonym in a free position, as an interest', () => {
    const { resolved } = deriveCountriesFromFacts([
      fact('f1', 'Follows Brazilian football'),
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      countryCode: 'BR',
      city: null,
      region: null,
      role: 'interest',
    });
    expect(resolved[0].weight).toBe(0.4);
  });

  it('keeps the curated colloquial overrides', () => {
    expect(codesFor(['Grew up in Holland'])).toEqual(['NL']);
    expect(codesFor(['Studied in the UK'])).toEqual(['GB']);
  });
});

describe('deriveCountriesFromFacts — the position rule (ambiguity guards)', () => {
  it('does NOT resolve JO from a person named Jordan', () => {
    const { resolved, unresolved } = deriveCountriesFromFacts([
      fact('f1', 'My friend Jordan moved to Austin'),
    ]);
    expect(resolved).toHaveLength(0);
    expect(unresolved.map((f) => f.id)).toEqual(['f1']);
  });

  it('does NOT resolve GE from the US state Georgia, even though it is anchored', () => {
    const { resolved, unresolved } = deriveCountriesFromFacts([
      fact('f1', 'Grew up in Georgia'),
    ]);
    expect(resolved).toHaveLength(0);
    expect(unresolved.map((f) => f.id)).toEqual(['f1']);
  });

  it('does not free-position scan the full ISO name set', () => {
    // "Austin" / "Chad" / "Turkey" only exist in the full ISO tables (or are
    // blocked outright), so none of these may produce a country.
    expect(codesFor(['Talked to Chad about the guinea pigs'])).toEqual([]);
    expect(codesFor(['Roasts a turkey every November'])).toEqual([]);
    expect(codesFor(['Sent the photos to us'])).toEqual([]);
  });

  it('drops demonym hits that are really about a language or cuisine', () => {
    expect(codesFor(['Loves Thai food'])).toEqual([]);
    expect(codesFor(['Taking Spanish lessons'])).toEqual([]);
  });

  it('sends a city-only fact to tier 2 rather than guessing', () => {
    // Full-ISO name matching cannot resolve a city; that is exactly what the
    // LLM tier is for.
    const { resolved, unresolved } = deriveCountriesFromFacts([
      fact('f1', 'Works at a startup in Bangalore'),
    ]);
    expect(resolved).toHaveLength(0);
    expect(unresolved.map((f) => f.id)).toEqual(['f1']);
  });

  it('skips blank statements without emitting anything', () => {
    const { resolved, unresolved } = deriveCountriesFromFacts([fact('f1', '   ')]);
    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(0);
  });
});

describe('selectFactsForPlaces', () => {
  const home: ReaderPlace = { countryCode: 'IN', region: 'Madhya Pradesh', city: 'Bhopal', role: 'home' };
  const stamped = (id: string, statement: string, extra: Record<string, unknown> = {}) => ({
    id,
    statement,
    metadata: { places: ['IN'], places_source: placesSourceHash(statement, [home]), ...extra },
  });

  it('takes unplaced, changed and wrong-marked facts, never a user choice', () => {
    const facts = [
      { id: 'new', statement: 'Pensioner', metadata: {} },
      stamped('same', 'Follows cricket'),
      { ...stamped('edited', 'Follows cricket'), statement: 'Follows hockey' },
      stamped('wrong', 'Water cuts', { places_wrong: true }),
      { id: 'mine', statement: 'Pensioner', metadata: { places_by: 'user' } },
    ];
    expect(selectFactsForPlaces(facts, [home])).toEqual(['new', 'edited', 'wrong']);
  });

  it('re-selects every fact when the reader moves home, not when they plan a trip', () => {
    const facts = [stamped('a', 'Pensioner')];
    const trip: ReaderPlace = { countryCode: 'FR', region: null, city: 'Paris', role: 'travel' };
    expect(selectFactsForPlaces(facts, [home, trip])).toEqual([]);
    expect(selectFactsForPlaces(facts, [{ ...home, city: 'Indore' }])).toEqual(['a']);
  });
});

describe('buildFactPlacesRequest', () => {
  const req = buildFactPlacesRequest({
    batch: [
      { id: 'f1', statement: 'Pensioner', rejected: [] },
      { id: 'f2', statement: 'Worried about water cuts', rejected: ['IN'] },
    ],
    otherFacts: ['Lives in Bhopal', 'Pensioner'],
    readerPlaces: [{ countryCode: 'IN', region: 'Madhya Pradesh', city: 'Bhopal', role: 'home' }],
  });

  it('names places and never shows a code', () => {
    expect(req.prompt).toContain('- Bhopal, Madhya Pradesh, India (home)');
    expect(req.prompt).toContain('[f1] Pensioner\n');
    expect(req.prompt).toContain('[f2] Worried about water cuts (the reader said this place is wrong: India)');
    expect(req.prompt).not.toMatch(/\b(IN|GB|NL)\b/);
    expect(req.systemPrompt).toContain('STRICT JSON');
    expect(req.systemPrompt).toContain('never as a code');
  });
});

describe('decodeFactPlaces', () => {
  const batch = [
    { id: 'pension', statement: 'Pensioner', rejected: [] },
    { id: 'water', statement: 'Worried about water cuts', rejected: [] },
    { id: 'jobs', statement: 'State government jobs', rejected: [] },
    { id: 'climate', statement: 'Follows climate science', rejected: [] },
    { id: 'trade', statement: 'Works in EU trade law', rejected: [] },
    { id: 'daughter', statement: 'Daughter studies in London', rejected: [] },
  ];
  const reply = JSON.stringify({
    facts: [
      { id: 'pension', level: 'country', country: 'India', role: null },
      { id: 'water', level: 'city', country: 'India', region: 'Madhya Pradesh', city: 'Bhopal' },
      { id: 'jobs', level: 'region', country: 'India', region: 'Madhya Pradesh' },
      { id: 'climate', level: 'anywhere' },
      { id: 'trade', level: 'bloc', bloc: 'European Union' },
      { id: 'daughter', level: 'city', country: 'United Kingdom', city: 'London', role: 'family' },
    ],
  });

  it('decodes the six plan examples to codes', () => {
    const out = decodeFactPlaces(`Sure!\n${reply}`, batch, ALLOWED);
    expect(Object.fromEntries(out.map((o) => [o.factId, o.places]))).toEqual({
      pension: ['IN'],
      water: ['IN|Madhya Pradesh|Bhopal'],
      jobs: ['IN|Madhya Pradesh'],
      climate: ['GLOBAL'],
      trade: ['EU'],
      daughter: ['GB||London'],
    });
  });

  it('makes a location candidate only when the fact names the place and the server has the country', () => {
    const out = decodeFactPlaces(reply, batch, ALLOWED);
    expect(out.filter((o) => o.location).map((o) => o.location)).toEqual([
      { countryCode: 'GB', city: 'London', region: null, role: 'family', weight: 0.7, sourceFactId: 'daughter' },
    ]);
    expect(decodeFactPlaces(reply, batch, new Set(['IN'])).some((o) => o.location)).toBe(false);
  });

  it('drops codes, unknown names, unknown and repeated ids; a rejected place decodes to none', () => {
    const out = decodeFactPlaces(
      JSON.stringify({
        facts: [
          { id: 'pension', level: 'country', country: 'IN' },
          { id: 'water', level: 'country', country: 'Narnia' },
          { id: 'nope', level: 'country', country: 'India' },
          { id: 'jobs', level: 'country', country: 'India' },
          { id: 'jobs', level: 'anywhere' },
          { id: 'trade', level: 'country', country: 'Germany' },
        ],
      }),
      [...batch.slice(0, 4), { id: 'trade', statement: 'Works in EU trade law', rejected: ['DE'] }],
      ALLOWED,
    );
    expect(out.map((o) => [o.factId, o.places])).toEqual([
      ['jobs', ['IN']],
      ['trade', []],
    ]);
  });

  it('returns [] for prose, broken JSON or a missing array', () => {
    expect(decodeFactPlaces('I cannot help with that.', batch, ALLOWED)).toEqual([]);
    expect(decodeFactPlaces('{"facts":[', batch, ALLOWED)).toEqual([]);
    expect(decodeFactPlaces('{"locations":[]}', batch, ALLOWED)).toEqual([]);
  });
});

describe('reconcileGeoPlan', () => {
  const candidate = (over: Partial<GeoCandidate> = {}): GeoCandidate => ({
    countryCode: 'NL',
    city: null,
    region: null,
    role: 'home',
    weight: 1.0,
    sourceFactId: 'f1',
    ...over,
  });

  const row = (over: Partial<ExistingGeoRow> = {}): ExistingGeoRow => ({
    id: 'l1',
    countryCode: 'NL',
    city: null,
    role: 'home',
    weight: 1.0,
    provenance: 'llm',
    ...over,
  });

  it('adds a country that has no existing row', () => {
    const ops = reconcileGeoPlan([], [candidate()]);
    expect(ops).toEqual([{ kind: 'add', candidate: candidate() }]);
  });

  it('never emits a delete', () => {
    const ops = reconcileGeoPlan(
      [row({ id: 'l1', countryCode: 'FR', provenance: 'llm' })],
      [candidate({ countryCode: 'BR', role: 'interest', weight: 0.4 })],
    );
    expect(ops.every((o) => o.kind === 'add' || o.kind === 'setWeight')).toBe(true);
    expect(ops).toHaveLength(1);
  });

  // ROLE_PRIORITY: home 6, work 5, family 4, partner_family 3, travel 2, interest 1.
  it('when two facts name one country, work beats family and loses to home', () => {
    const work = candidate({ role: 'work', weight: 0.8, sourceFactId: 'w' });
    const family = candidate({ role: 'family', weight: 0.9, sourceFactId: 'f' });
    const home = candidate({ role: 'home', weight: 1.0, sourceFactId: 'h' });
    expect(reconcileGeoPlan([], [family, work])).toEqual([{ kind: 'add', candidate: work }]);
    expect(reconcileGeoPlan([], [work, home])).toEqual([{ kind: 'add', candidate: home }]);
  });

  it('emits ZERO ops against a provenance:user row', () => {
    expect(
      reconcileGeoPlan([row({ provenance: 'user', weight: 0.2 })], [candidate()]),
    ).toEqual([]);
  });

  it('emits ZERO ops against a provenance:feedback row', () => {
    expect(
      reconcileGeoPlan([row({ provenance: 'feedback', weight: 0.2 })], [candidate()]),
    ).toEqual([]);
  });

  it('leaves a user row alone even when another row for the same country is llm', () => {
    const ops = reconcileGeoPlan(
      [row({ id: 'l1', provenance: 'user', weight: 0.2 }), row({ id: 'l2', provenance: 'llm', weight: 0.4 })],
      [candidate()],
    );
    expect(ops).toEqual([]);
  });

  it('reweights a derived row whose inferred weight moved', () => {
    const ops = reconcileGeoPlan(
      [row({ provenance: 'migration', weight: 0.4 })],
      [candidate({ weight: 1.0 })],
    );
    expect(ops).toEqual([{ kind: 'setWeight', locationId: 'l1', weight: 1.0 }]);
  });

  it('emits nothing when the derived weight is unchanged', () => {
    expect(reconcileGeoPlan([row({ weight: 1.0 })], [candidate({ weight: 1.0 })])).toEqual([]);
  });

  it('collapses duplicate candidates for one country, strongest role winning', () => {
    const ops = reconcileGeoPlan([], [
      candidate({ sourceFactId: 'f1', role: 'interest', weight: 0.4 }),
      candidate({ sourceFactId: 'f2', role: 'home', weight: 1.0 }),
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'add' });
    expect((ops[0] as { candidate: GeoCandidate }).candidate.role).toBe('home');
  });

  it('matches existing rows on country regardless of case or city', () => {
    const ops = reconcileGeoPlan(
      [row({ countryCode: 'nl', city: 'Rotterdam', weight: 1.0 })],
      [candidate({ city: 'Amsterdam', weight: 1.0 })],
    );
    expect(ops).toEqual([]);
  });
});
