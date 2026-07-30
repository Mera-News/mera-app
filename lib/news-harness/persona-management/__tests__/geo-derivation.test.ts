// geo-derivation — pure tier-1 rules, the tier-2 LLM contract, and the
// additive reconcile plan. The position rule (which resolver is allowed where)
// is the easiest thing to get wrong, so the ambiguity negatives are first-class
// cases here, not afterthoughts.

import {
  deriveCountriesFromFacts,
  buildGeoLlmRequest,
  parseGeoLlmResponse,
  reconcileGeoPlan,
  type ExistingGeoRow,
  type GeoCandidate,
} from '../geo-derivation';

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

describe('buildGeoLlmRequest', () => {
  it('emits one id-tagged line per unresolved fact', () => {
    const { systemPrompt, prompt } = buildGeoLlmRequest(
      [fact('f1', 'Works at a startup in Bangalore'), fact('f2', 'Enjoys hiking')],
      ALLOWED,
    );
    expect(prompt).toBe('[f1] Works at a startup in Bangalore\n[f2] Enjoys hiking');
    expect(systemPrompt).toContain('STRICT JSON');
    expect(systemPrompt).toContain('alpha-2');
  });

  it('inlines a short allowed enum but not a long one', () => {
    const short = buildGeoLlmRequest([fact('f1', 'x')], new Set(['NL', 'IN']));
    expect(short.systemPrompt).toContain('Valid codes: IN, NL');

    const long = new Set(
      Array.from({ length: 60 }, (_, i) => `X${String(i).padStart(1, '0')}`),
    );
    expect(buildGeoLlmRequest([fact('f1', 'x')], long).systemPrompt).not.toContain(
      'Valid codes',
    );
  });
});

describe('parseGeoLlmResponse', () => {
  const unresolved = [
    fact('f1', 'Works at a startup in Bangalore'),
    fact('f2', 'Sails out of Rotterdam'),
  ];

  it('decodes valid rows and fills the role weight', () => {
    const out = parseGeoLlmResponse(
      'Sure!\n{"locations":[{"id":"f1","country":"in","city":"Bangalore","role":"home"}]}',
      unresolved,
      ALLOWED,
    );
    expect(out).toEqual([
      {
        countryCode: 'IN',
        city: 'Bangalore',
        region: null,
        role: 'home',
        weight: 1.0,
        sourceFactId: 'f1',
      },
    ]);
  });

  it('drops every code outside allowedAlpha2', () => {
    const out = parseGeoLlmResponse(
      '{"locations":[{"id":"f1","country":"IN"},{"id":"f2","country":"FR"}]}',
      unresolved,
      ALLOWED,
    );
    expect(out.map((c) => c.countryCode)).toEqual(['IN']);
  });

  it('drops unknown ids, malformed codes and duplicate ids', () => {
    const out = parseGeoLlmResponse(
      '{"locations":[' +
        '{"id":"nope","country":"NL"},' +
        '{"id":"f1","country":"INDIA"},' +
        '{"id":"f2","country":"NL"},' +
        '{"id":"f2","country":"US"}]}',
      unresolved,
      ALLOWED,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sourceFactId: 'f2', countryCode: 'NL' });
  });

  it('falls back to the inferred role when the model omits or invents one', () => {
    const out = parseGeoLlmResponse(
      '{"locations":[{"id":"f1","country":"IN","role":"vacation-home"}]}',
      unresolved,
      ALLOWED,
    );
    // "Works at a startup in Bangalore" → inferLocationRole → 'interest'.
    expect(out[0].role).toBe('interest');
    expect(out[0].weight).toBe(0.4);
  });

  it('returns [] for prose, broken JSON or a missing array', () => {
    expect(parseGeoLlmResponse('I cannot help with that.', unresolved, ALLOWED)).toEqual([]);
    expect(parseGeoLlmResponse('{"locations":[', unresolved, ALLOWED)).toEqual([]);
    expect(parseGeoLlmResponse('{"other":[]}', unresolved, ALLOWED)).toEqual([]);
    expect(parseGeoLlmResponse('', unresolved, ALLOWED)).toEqual([]);
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
