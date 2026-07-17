import {
  buildRetrievalProfile,
  type RetrievalLocationInput,
  type RetrievalTopicInput,
} from '../retrieval-profile';

const topic = (t: Partial<RetrievalTopicInput> & { topicId: string; text: string }): RetrievalTopicInput => ({
  weight: 0,
  highPriority: false,
  ...t,
});

describe('buildRetrievalProfile — weight → limit mapping', () => {
  it('weight 0.5, no high_priority → limit 15 (round(6+9))', () => {
    const { topics } = buildRetrievalProfile({
      topics: [topic({ topicId: 't1', text: 'a', weight: 0.5 })],
      locations: [],
    });
    expect(topics).toHaveLength(1);
    expect(topics[0].effectiveWeight).toBeCloseTo(0.5, 6);
    expect(topics[0].limit).toBe(15);
  });

  it('weight 0.5, high_priority → limit 19 (round(6+18*0.7)=round(18.6))', () => {
    const { topics } = buildRetrievalProfile({
      topics: [topic({ topicId: 't1', text: 'a', weight: 0.5, highPriority: true })],
      locations: [],
    });
    expect(topics[0].limit).toBe(19);
  });

  it('high_priority raises the limit vs the same weight without it', () => {
    const withHp = buildRetrievalProfile({
      topics: [topic({ topicId: 't1', text: 'a', weight: 0.3, highPriority: true })],
      locations: [],
    }).topics[0].limit;
    const withoutHp = buildRetrievalProfile({
      topics: [topic({ topicId: 't1', text: 'a', weight: 0.3, highPriority: false })],
      locations: [],
    }).topics[0].limit;
    expect(withHp).toBeGreaterThan(withoutHp);
  });

  it('weight 1.0, factWeight 1, no high_priority → limit 24 (round(6+18)=24)', () => {
    const { topics } = buildRetrievalProfile({
      topics: [topic({ topicId: 't1', text: 'a', weight: 1.0, factWeight: 1 })],
      locations: [],
    });
    expect(topics[0].effectiveWeight).toBeCloseTo(1.0, 6);
    expect(topics[0].limit).toBe(24);
  });

  it('weight 1.0 with high_priority would exceed 24 unclamped (round(6+25.2)=31) but clamps to 24', () => {
    const { topics } = buildRetrievalProfile({
      topics: [topic({ topicId: 't1', text: 'a', weight: 1.0, highPriority: true })],
      locations: [],
    });
    expect(topics[0].limit).toBe(24);
  });
});

describe('buildRetrievalProfile — factWeight multiplier', () => {
  it('weight 0.8, factWeight 0.5 → w_eff 0.4 → limit 13 (round(6+7.2)=round(13.2))', () => {
    const { topics } = buildRetrievalProfile({
      topics: [topic({ topicId: 't1', text: 'a', weight: 0.8, factWeight: 0.5 })],
      locations: [],
    });
    expect(topics[0].effectiveWeight).toBeCloseTo(0.4, 6);
    expect(topics[0].limit).toBe(13);
  });

  it('missing factWeight defaults to 1.0 (no multiplier applied)', () => {
    const withUndefined = buildRetrievalProfile({
      topics: [topic({ topicId: 't1', text: 'a', weight: 0.6 })],
      locations: [],
    }).topics[0].effectiveWeight;
    const withExplicit1 = buildRetrievalProfile({
      topics: [topic({ topicId: 't1', text: 'a', weight: 0.6, factWeight: 1 })],
      locations: [],
    }).topics[0].effectiveWeight;
    expect(withUndefined).toBeCloseTo(withExplicit1, 6);
  });
});

describe('buildRetrievalProfile — maxTopics cap', () => {
  it('caps at 200 topics, keeping the highest w_eff ones sorted descending', () => {
    const topics: RetrievalTopicInput[] = [];
    for (let i = 0; i < 250; i++) {
      // weights spread across (0, 1], strictly positive and distinct.
      topics.push(topic({ topicId: `t${i}`, text: `topic-${String(i).padStart(3, '0')}`, weight: (i + 1) / 250 }));
    }
    const result = buildRetrievalProfile({ topics, locations: [] });
    expect(result.topics.length).toBe(200);

    // The kept set should be exactly the top-200 by w_eff (i.e. weight here
    // since factWeight defaults to 1): topics t50..t249 (250-200=50 lowest dropped).
    const keptIds = new Set(result.topics.map((t) => t.topicId));
    for (let i = 50; i < 250; i++) expect(keptIds.has(`t${i}`)).toBe(true);
    for (let i = 0; i < 50; i++) expect(keptIds.has(`t${i}`)).toBe(false);

    // sorted descending by effectiveWeight
    for (let i = 1; i < result.topics.length; i++) {
      expect(result.topics[i - 1].effectiveWeight).toBeGreaterThanOrEqual(result.topics[i].effectiveWeight);
    }
  });
});

describe('buildRetrievalProfile — negatives / zero excluded', () => {
  it('excludes weight 0 and negative-weight topics', () => {
    const { topics } = buildRetrievalProfile({
      topics: [
        topic({ topicId: 'zero', text: 'zero', weight: 0 }),
        topic({ topicId: 'neg', text: 'neg', weight: -0.5 }),
        topic({ topicId: 'pos', text: 'pos', weight: 0.3 }),
      ],
      locations: [],
    });
    const ids = topics.map((t) => t.topicId);
    expect(ids).not.toContain('zero');
    expect(ids).not.toContain('neg');
    expect(ids).toContain('pos');
    expect(topics).toHaveLength(1);
  });
});

describe('buildRetrievalProfile — headline scopes from locations', () => {
  const nowMs = 1_000_000;

  const home: RetrievalLocationInput = { countryCode: 'us', role: 'home', weight: 1.0 };
  const family: RetrievalLocationInput = { countryCode: 'gb', role: 'family', weight: 0.8 };
  const interest: RetrievalLocationInput = { countryCode: 'fr', role: 'interest', weight: 0.9 };
  const expiredTravel: RetrievalLocationInput = {
    countryCode: 'jp',
    role: 'travel',
    weight: 0.7,
    validUntilMs: nowMs - 1000,
  };
  const validTravel: RetrievalLocationInput = {
    countryCode: 'de',
    role: 'travel',
    weight: 0.6,
    validUntilMs: nowMs + 1000,
  };

  it('builds COUNTRY scopes for home/family/valid-travel (sorted by weight desc), excludes interest and expired travel, appends GLOBAL', () => {
    const { headlineScopes } = buildRetrievalProfile({
      topics: [],
      locations: [home, family, interest, expiredTravel, validTravel],
      nowMs,
    });

    expect(headlineScopes).toEqual([
      { scope: 'COUNTRY', countryCode: 'US' },
      { scope: 'COUNTRY', countryCode: 'GB' },
      { scope: 'COUNTRY', countryCode: 'DE' },
      { scope: 'GLOBAL' },
    ]);
  });

  it('FR (interest) and JP (expired travel) never appear as scopes', () => {
    const { headlineScopes } = buildRetrievalProfile({
      topics: [],
      locations: [home, family, interest, expiredTravel, validTravel],
      nowMs,
    });
    const codes = headlineScopes.map((s) => s.countryCode).filter(Boolean);
    expect(codes).not.toContain('FR');
    expect(codes).not.toContain('JP');
  });

  it('empty locations → exactly a single GLOBAL scope', () => {
    const { headlineScopes } = buildRetrievalProfile({ topics: [], locations: [], nowMs });
    expect(headlineScopes).toEqual([{ scope: 'GLOBAL' }]);
  });

  it('caps COUNTRY scopes at 5, still appends a trailing GLOBAL (6 total)', () => {
    const locations: RetrievalLocationInput[] = Array.from({ length: 8 }, (_, i) => ({
      countryCode: `c${i}`,
      role: 'home',
      weight: 1 - i * 0.01,
    }));
    const { headlineScopes } = buildRetrievalProfile({ topics: [], locations, nowMs });
    expect(headlineScopes).toHaveLength(6);
    expect(headlineScopes.filter((s) => s.scope === 'COUNTRY')).toHaveLength(5);
    expect(headlineScopes[headlineScopes.length - 1]).toEqual({ scope: 'GLOBAL' });
  });
});

describe('buildRetrievalProfile — headlineLimitPerScope', () => {
  it('defaults to 10', () => {
    const { headlineLimitPerScope } = buildRetrievalProfile({ topics: [], locations: [] });
    expect(headlineLimitPerScope).toBe(10);
  });

  it('respects an explicit override', () => {
    const { headlineLimitPerScope } = buildRetrievalProfile({ topics: [], locations: [], headlineLimitPerScope: 5 });
    expect(headlineLimitPerScope).toBe(5);
  });
});
