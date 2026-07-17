// Persona v3 silent-migration planner — parse + plan determinism tests.

import {
  MIGRATION_FACT_WEIGHT,
  MIGRATION_TOPIC_SEED_WEIGHT,
  buildPersonaMigrationPlan,
  inferLocationRole,
  parseLocationFromStatement,
  type FactSnapshot,
} from '../persona-management/persona-migration';

const fact = (
  id: string,
  statement: string,
  topics: string[] = [],
): FactSnapshot => ({ id, statement, topics });

describe('constants', () => {
  it('seeds topic weight 0.75 (M-P2 delta, not 0.6) and fact weight 1.0', () => {
    expect(MIGRATION_TOPIC_SEED_WEIGHT).toBe(0.75);
    expect(MIGRATION_FACT_WEIGHT).toBe(1.0);
  });
});

describe('parseLocationFromStatement', () => {
  it('parses a full anchored chain (neighborhood, city, country, continent)', () => {
    expect(
      parseLocationFromStatement('Lives in Nieuw-West, Amsterdam, Netherlands, Europe'),
    ).toEqual({ city: 'Nieuw-West', region: 'Amsterdam', countryCode: 'NL' });
  });

  it('parses a city, region, country, continent chain (Chhindwara case)', () => {
    expect(
      parseLocationFromStatement('Family lives in Chhindwara, Madhya Pradesh, India, Asia'),
    ).toEqual({ city: 'Chhindwara', region: 'Madhya Pradesh', countryCode: 'IN' });
  });

  it('parses a city + country chain without a continent', () => {
    expect(parseLocationFromStatement('Lives in Bhopal, India')).toEqual({
      city: 'Bhopal',
      region: null,
      countryCode: 'IN',
    });
  });

  it('handles continent blocs with parentheticals', () => {
    expect(
      parseLocationFromStatement('Lives in Berlin, Germany, Europe (EU)'),
    ).toEqual({ city: 'Berlin', region: null, countryCode: 'DE' });
  });

  it('parses country-only chains to a city-less location', () => {
    expect(parseLocationFromStatement('Travelling to Portugal, Europe')).toEqual({
      city: null,
      region: null,
      countryCode: 'PT',
    });
  });

  it('returns null for unanchored facts (no comma chain)', () => {
    expect(parseLocationFromStatement('Interested in Middle East politics')).toBeNull();
    expect(parseLocationFromStatement('Works in AI')).toBeNull();
    expect(parseLocationFromStatement('Visiting Japan')).toBeNull();
  });

  it('returns null when the country cannot be resolved deterministically', () => {
    expect(
      parseLocationFromStatement('Lives in Someville, Wakanda, Africa'),
    ).toBeNull();
  });

  it('does not treat a comma-separated interest list as a location', () => {
    expect(
      parseLocationFromStatement('Interested in AI, blockchain, quantum computing'),
    ).toBeNull();
  });
});

describe('inferLocationRole', () => {
  it("prefers partner_family over family ('girlfriend's parents')", () => {
    expect(
      inferLocationRole("Girlfriend's parents live in Porto, Portugal, Europe"),
    ).toBe('partner_family');
  });

  it("prefers family over home ('parents live in')", () => {
    expect(
      inferLocationRole('Parents live in Brooklyn, New York, United States, North America'),
    ).toBe('family');
  });

  it('detects travel', () => {
    expect(inferLocationRole('Planning a trip to Madeira, Portugal, Europe')).toBe('travel');
    expect(inferLocationRole('Visiting Tokyo, Japan, Asia next month')).toBe('travel');
  });

  it('detects home', () => {
    expect(inferLocationRole('Lives in Amsterdam, Netherlands, Europe')).toBe('home');
    expect(inferLocationRole('Moved to Berlin, Germany, Europe')).toBe('home');
  });

  it('falls back to interest', () => {
    expect(inferLocationRole('Follows news about Kyiv, Ukraine, Europe')).toBe('interest');
  });
});

describe('buildPersonaMigrationPlan', () => {
  it('creates a topic row per metadata topic with migration seeds', () => {
    const plan = buildPersonaMigrationPlan([
      fact('f1', 'Works at a tech company', ['AI regulation', 'Startup funding']),
    ]);
    expect(plan.topicRows).toEqual([
      expect.objectContaining({
        factId: 'f1',
        text: 'AI regulation',
        normalizedText: 'ai regulation',
        weight: 0.75,
        status: 'active',
        provenance: 'migration',
        highPriority: false,
      }),
      expect.objectContaining({ factId: 'f1', text: 'Startup funding' }),
    ]);
    expect(plan.factWeightUpdates).toEqual([{ factId: 'f1', weight: 1.0 }]);
    expect(plan.changeLogEntries).toHaveLength(1);
    expect(plan.changeLogEntries[0]).toMatchObject({
      actionType: 'migrate_fact',
      source: 'migration',
      action: { targetId: 'f1', topicsCreated: 2, after: { weight: 1.0 } },
    });
  });

  it('dedupes topics within a fact on normalized text', () => {
    const plan = buildPersonaMigrationPlan([
      fact('f1', 'x', ['Amsterdam housing', '  amsterdam   HOUSING ', '']),
    ]);
    expect(plan.topicRows).toHaveLength(1);
    expect(plan.changeLogEntries[0].action.topicsCreated).toBe(1);
  });

  it('derives a location candidate from an anchored fact and dedupes across facts', () => {
    const plan = buildPersonaMigrationPlan([
      fact('f1', 'Lives in Jordaan, Amsterdam, Netherlands, Europe', ['Amsterdam news']),
      fact('f2', 'Lives in Jordaan, Amsterdam, Netherlands, Europe', []),
      fact('f3', 'Works in AI', ['AI news']),
    ]);
    expect(plan.locationCandidates).toEqual([
      {
        sourceFactId: 'f1',
        city: 'Jordaan',
        region: 'Amsterdam',
        countryCode: 'NL',
        role: 'home',
        weight: 1.0,
        validUntil: null,
      },
    ]);
    // Every fact still gets a weight update + change-log entry.
    expect(plan.factWeightUpdates).toHaveLength(3);
    expect(plan.changeLogEntries).toHaveLength(3);
  });

  it('is deterministic (same input → identical plan)', () => {
    const input = [
      fact('f1', 'Lives in Bhopal, Madhya Pradesh, India, Asia', ['Bhopal weather']),
      fact('f2', 'Follows Formula 1', ['F1 races']),
    ];
    expect(buildPersonaMigrationPlan(input)).toEqual(buildPersonaMigrationPlan(input));
  });
});
