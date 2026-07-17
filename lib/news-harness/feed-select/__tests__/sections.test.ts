// feed-select/sections — pure selector tests (Wave 7b-core M-P5b).
// RN-free: no DB/store imports; the selector consumes plain projections.

import {
  selectSections,
  resolveOwningFact,
  bucketOf,
  type ScoredSuggestionProjection,
  type TopicSnapshot,
  type FactSnapshot,
  type LocationSnapshot,
  type SelectSectionsInput,
} from '../sections';

// --- factories ------------------------------------------------------------

let seq = 0;
function sugg(o: Partial<ScoredSuggestionProjection> = {}): ScoredSuggestionProjection {
  seq += 1;
  return {
    id: o.id ?? `s${seq}`,
    rawScore: o.rawScore ?? 0.5,
    relevance: o.relevance ?? 0.6,
    pubDateMs: o.pubDateMs ?? 1_000,
    title: o.title ?? null,
    clusterMemberships: o.clusterMemberships ?? [],
    stableClusterId: o.stableClusterId,
    eventType: o.eventType,
    headlineScope: o.headlineScope,
    headlineLocationId: o.headlineLocationId,
    matchedTopics: o.matchedTopics ?? [],
  };
}

function topic(o: Partial<TopicSnapshot> & { factId: string | null }): TopicSnapshot {
  return { weight: 0.8, highPriority: false, status: 'active', ...o };
}

function fact(o: Partial<FactSnapshot> = {}): FactSnapshot {
  return { weight: 1, createdAtMs: 100, statement: 'A fact', ...o };
}

function run(
  suggestions: ScoredSuggestionProjection[],
  extra: Partial<SelectSectionsInput> = {},
) {
  return selectSections({
    suggestions,
    topics: extra.topics ?? new Map(),
    facts: extra.facts ?? new Map(),
    locations: extra.locations ?? new Map(),
  });
}

// --- bucketOf -------------------------------------------------------------

describe('bucketOf', () => {
  it('maps relevance to display tiers', () => {
    expect(bucketOf(1.1)).toBe('EMERGENCY');
    expect(bucketOf(0.8)).toBe('HIGH');
    expect(bucketOf(0.6)).toBe('MEDIUM');
    expect(bucketOf(0.4)).toBe('LOW');
    expect(bucketOf(0.39)).toBe('UNSCORED');
    expect(bucketOf(null)).toBe('UNSCORED');
    expect(bucketOf(-1)).toBe('UNSCORED');
  });
});

// --- single-section guarantee --------------------------------------------

describe('single-section guarantee', () => {
  it('assigns a multi-source story (shared cluster) to exactly one section', () => {
    const topics = new Map([
      ['t1', topic({ factId: 'f1' })],
      ['t2', topic({ factId: 'f2' })],
    ]);
    const facts = new Map([
      ['f1', fact()],
      ['f2', fact()],
    ]);
    // s1 + s2 share cluster c1 → one story. Their reps match DIFFERENT facts,
    // but the group is assigned once (via the representative = higher rawScore).
    const s1 = sugg({
      id: 'a',
      rawScore: 0.7,
      clusterMemberships: [{ clusterId: 'c1', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't1', text: 'x' }],
    });
    const s2 = sugg({
      id: 'b',
      rawScore: 0.5,
      clusterMemberships: [{ clusterId: 'c1', confidence: 0.9 }],
      matchedTopics: [{ topicId: 't2', text: 'y' }],
    });
    const { sections, breaking } = run([s1, s2], { topics, facts });

    const allGroups = [
      ...breaking.map((b) => ({ memberIds: b.memberIds })),
      ...sections.flatMap((sec) => sec.groups),
    ];
    const containing = allGroups.filter(
      (g) => g.memberIds.includes('a') || g.memberIds.includes('b'),
    );
    expect(containing).toHaveLength(1);
    expect([...containing[0].memberIds].sort()).toEqual(['a', 'b']);
    // f2 never gets its own section — the story went to f1 (the rep's fact).
    expect(sections.some((sec) => sec.factId === 'f2')).toBe(false);
  });
});

// --- owning-fact tie-break chain -----------------------------------------

describe('resolveOwningFact tie-break chain', () => {
  const HP = 1.25;

  it('1: higher fact.weight wins when factScore ties', () => {
    // factScore f1 = topic 0.5 × fact 1.0 = 0.5 ; f2 = topic 1.0 × fact 0.5 = 0.5
    // → tie on score; f1 has the higher fact.weight so it wins.
    const topics = new Map([
      ['t1', topic({ factId: 'f1', weight: 0.5 })],
      ['t2', topic({ factId: 'f2', weight: 1.0 })],
    ]);
    const facts = new Map([
      ['f1', fact({ weight: 1.0, createdAtMs: 100 })],
      ['f2', fact({ weight: 0.5, createdAtMs: 100 })],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1', text: 'a' },
        { topicId: 't2', text: 'b' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('f1');
  });

  it('2: more matched topics (breadth) wins when score+weight tie', () => {
    const topics = new Map([
      ['t1a', topic({ factId: 'f1', weight: 0.5 })],
      ['t1b', topic({ factId: 'f1', weight: 0.5 })],
      ['t2', topic({ factId: 'f2', weight: 0.5 })],
    ]);
    const facts = new Map([
      ['f1', fact({ weight: 1.0, createdAtMs: 100 })],
      ['f2', fact({ weight: 1.0, createdAtMs: 100 })],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1a', text: 'a' },
        { topicId: 't1b', text: 'b' },
        { topicId: 't2', text: 'c' },
      ],
    });
    // f1 score 0.5 (max), count 2; f2 score 0.5, count 1 → f1 by breadth.
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('f1');
  });

  it('3: older fact wins when score+weight+breadth tie', () => {
    const topics = new Map([
      ['t1', topic({ factId: 'f1', weight: 0.5 })],
      ['t2', topic({ factId: 'f2', weight: 0.5 })],
    ]);
    const facts = new Map([
      ['f1', fact({ weight: 1.0, createdAtMs: 500 })], // newer
      ['f2', fact({ weight: 1.0, createdAtMs: 100 })], // older → wins
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1', text: 'a' },
        { topicId: 't2', text: 'b' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('f2');
  });

  it('4: lexicographic fact id is the final tiebreak', () => {
    const topics = new Map([
      ['tb', topic({ factId: 'fB', weight: 0.5 })],
      ['ta', topic({ factId: 'fA', weight: 0.5 })],
    ]);
    const facts = new Map([
      ['fA', fact({ weight: 1.0, createdAtMs: 100 })],
      ['fB', fact({ weight: 1.0, createdAtMs: 100 })],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 'tb', text: 'b' },
        { topicId: 'ta', text: 'a' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('fA');
  });

  it('high_priority lifts w_eff via HP_MULT (score break)', () => {
    const topics = new Map([
      ['t1', topic({ factId: 'f1', weight: 0.5, highPriority: true })], // 0.5×1×1.25=0.625
      ['t2', topic({ factId: 'f2', weight: 0.5 })], // 0.5
    ]);
    const facts = new Map([
      ['f1', fact({ weight: 1.0 })],
      ['f2', fact({ weight: 1.0 })],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1', text: 'a' },
        { topicId: 't2', text: 'b' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('f1');
  });

  it('ignores non-active topics and negative-only matches (no owning fact)', () => {
    const topics = new Map([
      ['t1', topic({ factId: 'f1', weight: 0.5, status: 'suppressed' })],
      ['t2', topic({ factId: 'f2', weight: -0.8 })], // negative → w_eff ≤ 0
    ]);
    const facts = new Map([
      ['f1', fact()],
      ['f2', fact()],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1', text: 'a' },
        { topicId: 't2', text: 'b' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBeNull();
  });
});

// --- headline synthetic sections (pseudo-weights + titles) ----------------

describe('headline synthetic sections', () => {
  it('weights CITY/COUNTRY by HEADLINE_SECTION_BASE × location.weight, GLOBAL fixed', () => {
    const locations = new Map<string, LocationSnapshot>([
      ['loc-city', { city: 'Bhopal', countryCode: 'IN', weight: 1.0 }],
      ['loc-country', { country: 'India', countryCode: 'IN', weight: 0.8 }],
    ]);
    // 2 city headlines (same loc) so the section survives the 1-item fold.
    const city1 = sugg({
      id: 'c1',
      rawScore: 0.5,
      headlineScope: 'CITY',
      headlineLocationId: 'loc-city',
    });
    const city2 = sugg({
      id: 'c2',
      rawScore: 0.45,
      headlineScope: 'CITY',
      headlineLocationId: 'loc-city',
    });
    const g1 = sugg({ id: 'g1', rawScore: 0.5, headlineScope: 'GLOBAL' });
    const g2 = sugg({ id: 'g2', rawScore: 0.45, headlineScope: 'GLOBAL' });

    const { sections } = run([city1, city2, g1, g2], { locations });
    const citySec = sections.find((s) => s.scope === 'CITY');
    const globalSec = sections.find((s) => s.scope === 'GLOBAL');

    expect(citySec).toBeDefined();
    expect(citySec!.kind).toBe('headline');
    expect(citySec!.title).toBe('Local headlines · Bhopal');
    expect(citySec!.weight).toBeCloseTo(0.55, 6); // 0.55 × 1.0
    expect(citySec!.locationId).toBe('loc-city');

    expect(globalSec).toBeDefined();
    expect(globalSec!.title).toBe('Top stories · Worldwide');
    expect(globalSec!.weight).toBeCloseTo(0.35, 6);

    // CITY (0.55) ranks above GLOBAL (0.35).
    expect(sections.indexOf(citySec!)).toBeLessThan(sections.indexOf(globalSec!));
  });

  it('orders default-weight fact sections above headline sections', () => {
    const topics = new Map([['t1', topic({ factId: 'f1' })]]);
    const facts = new Map([['f1', fact({ weight: 1.0, statement: 'Berlin tech' })]]);
    const locations = new Map<string, LocationSnapshot>([
      ['loc', { city: 'Berlin', weight: 1.0 }],
    ]);
    const f1a = sugg({ id: 'f1a', matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const f1b = sugg({ id: 'f1b', matchedTopics: [{ topicId: 't1', text: 'y' }] });
    const h1 = sugg({ id: 'h1', headlineScope: 'CITY', headlineLocationId: 'loc' });
    const h2 = sugg({ id: 'h2', headlineScope: 'CITY', headlineLocationId: 'loc' });

    const { sections } = run([h1, h2, f1a, f1b], { topics, facts, locations });
    const factIdx = sections.findIndex((s) => s.factId === 'f1');
    const headIdx = sections.findIndex((s) => s.scope === 'CITY');
    expect(factIdx).toBeGreaterThanOrEqual(0);
    expect(headIdx).toBeGreaterThan(factIdx); // fact (1.0) above headline (0.55)
  });
});

// --- 1-item fold ----------------------------------------------------------

describe('1-item sections fold into also_for_you', () => {
  it('collapses single-group sections and places also_for_you last', () => {
    const topics = new Map([
      ['t1', topic({ factId: 'f1' })],
      ['t2', topic({ factId: 'f2' })],
    ]);
    const facts = new Map([
      ['f1', fact({ weight: 1.0, statement: 'Fact one' })],
      ['f2', fact({ weight: 1.0, statement: 'Fact two' })],
    ]);
    // f1 gets 2 groups (survives); f2 gets 1 (folds).
    const a = sugg({ id: 'a', matchedTopics: [{ topicId: 't1', text: 'x' }] });
    const b = sugg({ id: 'b', matchedTopics: [{ topicId: 't1', text: 'y' }] });
    const c = sugg({ id: 'c', matchedTopics: [{ topicId: 't2', text: 'z' }] });

    const { sections } = run([a, b, c], { topics, facts });
    expect(sections.some((s) => s.factId === 'f1')).toBe(true);
    expect(sections.some((s) => s.factId === 'f2')).toBe(false);
    const also = sections.find((s) => s.key === 'also_for_you');
    expect(also).toBeDefined();
    expect(also!.kind).toBe('also');
    expect(also!.groups.map((g) => g.representativeId)).toContain('c');
    expect(sections[sections.length - 1].key).toBe('also_for_you'); // last
  });

  it('within-section ordering: rawScore desc → pubDate desc → id', () => {
    const topics = new Map([['t1', topic({ factId: 'f1' })]]);
    const facts = new Map([['f1', fact()]]);
    const hi = sugg({ id: 'hi', rawScore: 0.9, matchedTopics: [{ topicId: 't1', text: 'a' }] });
    const mid = sugg({ id: 'mid', rawScore: 0.5, pubDateMs: 2000, matchedTopics: [{ topicId: 't1', text: 'b' }] });
    const midOlder = sugg({ id: 'midOlder', rawScore: 0.5, pubDateMs: 1000, matchedTopics: [{ topicId: 't1', text: 'c' }] });
    const unscored = sugg({ id: 'z-unscored', rawScore: null, relevance: null, matchedTopics: [{ topicId: 't1', text: 'd' }] });

    const { sections } = run([midOlder, unscored, hi, mid], { topics, facts });
    const sec = sections.find((s) => s.factId === 'f1')!;
    expect(sec.groups.map((g) => g.representativeId)).toEqual([
      'hi',
      'mid',
      'midOlder',
      'z-unscored',
    ]);
  });
});

// --- breaking extraction --------------------------------------------------

describe('breaking extraction', () => {
  it('pulls raw>1.0 and hot-event raw≥0.8 out of sections', () => {
    const topics = new Map([['t1', topic({ factId: 'f1' })]]);
    const facts = new Map([['f1', fact()]]);
    const emergency = sugg({
      id: 'emg',
      rawScore: 1.05,
      relevance: 1.1,
      matchedTopics: [{ topicId: 't1', text: 'a' }],
    });
    const weatherHot = sugg({
      id: 'wx',
      rawScore: 0.85,
      relevance: 0.8,
      eventType: 'weather',
      matchedTopics: [{ topicId: 't1', text: 'b' }],
    });
    const weatherCold = sugg({
      id: 'wxCold',
      rawScore: 0.7,
      relevance: 0.6,
      eventType: 'weather',
      matchedTopics: [{ topicId: 't1', text: 'c' }],
    });
    const plain = sugg({
      id: 'plain',
      rawScore: 0.9,
      relevance: 0.8,
      eventType: 'politics',
      matchedTopics: [{ topicId: 't1', text: 'd' }],
    });

    const { breaking, sections } = run([emergency, weatherHot, weatherCold, plain], {
      topics,
      facts,
    });
    const breakingIds = breaking.map((b) => b.representativeId);
    expect(breakingIds).toEqual(['emg', 'wx']); // raw desc order
    // breaking items are NOT in any section.
    const sectionIds = sections.flatMap((s) =>
      s.groups.flatMap((g) => g.memberIds),
    );
    expect(sectionIds).not.toContain('emg');
    expect(sectionIds).not.toContain('wx');
    // non-breaking high/hot-cold stay in the feed.
    expect(sectionIds).toContain('wxCold');
    expect(sectionIds).toContain('plain');
    // bucket surfaced on breaking items.
    expect(breaking[0].bucket).toBe('EMERGENCY');
  });
});
