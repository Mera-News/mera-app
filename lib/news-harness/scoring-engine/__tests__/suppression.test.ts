// scoring-engine/suppression — the shared kind-aware matcher (D9).
//
// The byte-identity of the `keyword` kind against the historical inline matcher
// is gated at corpus scale by the golden eval (1000 articles, 213 of them
// carrying a non-zero suppression penalty); these tests pin the SEMANTICS —
// especially the two "empty matches nothing" guards, which are the failure mode
// that would silently suppress the entire feed.

import {
  buildSuppressionHaystack,
  suppressionMatchesCandidate,
  screenHardSuppressions,
  suppressionDisplayValue,
} from '../suppression';
import type { SoftSuppression } from '../persona-context';
import type { ScoredCandidateInput } from '../relevance';

const candidate = (over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput => ({
  id: 'a1',
  titleEn: 'Nvidia unveils a new GPU',
  descriptionEn: 'The chipmaker announced it in Taipei.',
  publicationName: 'The Verge',
  countryCode: 'US',
  eventType: 'product_launch',
  category: 'technology',
  entities: ['Nvidia', 'Jensen Huang'],
  geoTags: [{ city: 'Taipei', region: 'Taipei City', countryCode: 'TW' }],
  matchedTopics: [
    { topicId: 't1', text: 'AI hardware', effectiveWeight: 0.8 },
    { topicId: null, effectiveWeight: 0 },
  ],
  ...over,
});

const sup = (over: Partial<SoftSuppression>): SoftSuppression => ({
  keywords: [],
  strength: 1,
  ...over,
});

describe('buildSuppressionHaystack', () => {
  it('joins normalized title, description and entities with two spaces', () => {
    expect(buildSuppressionHaystack(candidate())).toBe(
      'nvidia unveils a new gpu  the chipmaker announced it in taipei.  nvidia  jensen huang',
    );
  });

  it('tolerates every optional field being absent', () => {
    expect(
      buildSuppressionHaystack({ id: 'x', matchedTopics: [] }),
    ).toBe('  ');
  });
});

describe('suppressionMatchesCandidate — keyword (and NULL kind)', () => {
  it('matches a normalized substring of the haystack', () => {
    expect(suppressionMatchesCandidate(candidate(), sup({ keywords: ['NVIDIA'] }))).toBe(true);
    expect(suppressionMatchesCandidate(candidate(), sup({ keywords: ['amd'] }))).toBe(false);
  });

  it('treats an absent kind exactly like an explicit keyword kind', () => {
    const c = candidate();
    expect(suppressionMatchesCandidate(c, sup({ keywords: ['gpu'] }))).toBe(
      suppressionMatchesCandidate(c, sup({ keywords: ['gpu'], kind: 'keyword' })),
    );
  });

  it('never matches on a blank keyword (haystack.includes("") would be true)', () => {
    expect(suppressionMatchesCandidate(candidate(), sup({ keywords: ['', '   '] }))).toBe(false);
    expect(suppressionMatchesCandidate(candidate(), sup({ keywords: [] }))).toBe(false);
  });

  it('ignores `value` — the keyword kind matches on keywords only', () => {
    expect(
      suppressionMatchesCandidate(candidate(), sup({ keywords: [], value: 'nvidia' })),
    ).toBe(false);
  });
});

describe('suppressionMatchesCandidate — structured kinds', () => {
  it('category / event_type are normalized equality, not substring', () => {
    expect(
      suppressionMatchesCandidate(candidate(), sup({ kind: 'category', value: 'Technology' })),
    ).toBe(true);
    expect(
      suppressionMatchesCandidate(candidate(), sup({ kind: 'category', value: 'tech' })),
    ).toBe(false);
    expect(
      suppressionMatchesCandidate(candidate(), sup({ kind: 'event_type', value: 'product_launch' })),
    ).toBe(true);
  });

  it('entity matches any element by equality', () => {
    expect(
      suppressionMatchesCandidate(candidate(), sup({ kind: 'entity', value: 'jensen huang' })),
    ).toBe(true);
    expect(
      suppressionMatchesCandidate(candidate(), sup({ kind: 'entity', value: 'huang' })),
    ).toBe(false);
  });

  it('publication matches the publication name', () => {
    expect(
      suppressionMatchesCandidate(candidate(), sup({ kind: 'publication', value: 'the verge' })),
    ).toBe(true);
  });

  it('topic matches a matched topic text and skips textless synthetic entries', () => {
    expect(
      suppressionMatchesCandidate(candidate(), sup({ kind: 'topic', value: 'ai hardware' })),
    ).toBe(true);
    expect(
      suppressionMatchesCandidate(candidate(), sup({ kind: 'topic', value: '' })),
    ).toBe(false);
  });

  it('place matches geo-tag city / region / countryCode', () => {
    const c = candidate();
    expect(suppressionMatchesCandidate(c, sup({ kind: 'place', value: 'Taipei' }))).toBe(true);
    expect(suppressionMatchesCandidate(c, sup({ kind: 'place', value: 'taipei city' }))).toBe(true);
    expect(suppressionMatchesCandidate(c, sup({ kind: 'place', value: 'tw' }))).toBe(true);
  });

  it('place NEVER matches the top-level publishing countryCode', () => {
    // The story is tagged TW but published from a US outlet — muting "US" must
    // not kill every American wire story about elsewhere.
    expect(
      suppressionMatchesCandidate(candidate(), sup({ kind: 'place', value: 'US' })),
    ).toBe(false);
  });

  it('a blank value on a structured kind matches nothing', () => {
    for (const kind of ['category', 'event_type', 'entity', 'publication', 'place', 'topic'] as const) {
      expect(suppressionMatchesCandidate(candidate(), sup({ kind, value: '  ' }))).toBe(false);
      expect(suppressionMatchesCandidate(candidate(), sup({ kind }))).toBe(false);
    }
  });

  it('an unknown/future kind degrades to keyword semantics and never throws', () => {
    const weird = { keywords: ['nvidia'], strength: 1, kind: 'galaxy_brain' } as unknown as SoftSuppression;
    expect(suppressionMatchesCandidate(candidate(), weird)).toBe(true);
    const weirdNoKeywords = { keywords: [], strength: 1, kind: 'galaxy_brain' } as unknown as SoftSuppression;
    expect(suppressionMatchesCandidate(candidate(), weirdNoKeywords)).toBe(false);
  });
});

describe('screenHardSuppressions', () => {
  it('returns an empty map when there are no hard filters', () => {
    expect(screenHardSuppressions([candidate()], []).size).toBe(0);
    expect(screenHardSuppressions([candidate()], undefined).size).toBe(0);
  });

  it('maps each excluded id to the first matching filter display value', () => {
    // Uses `topic`, not `entity`: entity can no longer exclude anything (68.8%
    // extraction accuracy — see canHardExclude and entity-never-excludes.test).
    const excluded = screenHardSuppressions(
      [
        candidate(),
        candidate({ id: 'a2', titleEn: 'AMD ships', entities: [], matchedTopics: [] }),
      ],
      [sup({ kind: 'topic', value: 'ai hardware', pattern: 'anything about AI hardware' })],
    );
    expect([...excluded.keys()]).toEqual(['a1']);
    expect(excluded.get('a1')).toBe('ai hardware');
  });

  it('NEVER excludes on an entity filter, however strong', () => {
    const excluded = screenHardSuppressions(
      [candidate()],
      [sup({ kind: 'entity', value: 'nvidia', strength: 1 })],
    );
    expect(excluded.size).toBe(0);
  });

  it('stops at the first match (one cause per row)', () => {
    const excluded = screenHardSuppressions(
      [candidate()],
      [
        sup({ kind: 'publication', value: 'the verge' }),
        sup({ kind: 'entity', value: 'nvidia' }),
      ],
    );
    expect(excluded.get('a1')).toBe('the verge');
  });
});

describe('suppressionDisplayValue', () => {
  it('prefers value, then pattern, then the first non-blank keyword', () => {
    expect(suppressionDisplayValue(sup({ value: 'v', pattern: 'p', keywords: ['k'] }))).toBe('v');
    expect(suppressionDisplayValue(sup({ pattern: 'p', keywords: ['k'] }))).toBe('p');
    expect(suppressionDisplayValue(sup({ keywords: ['  ', 'k'] }))).toBe('k');
    expect(suppressionDisplayValue(sup({}))).toBe('filter');
  });
});
