// THE ROUND TRIP — does a tag leaf's filter actually match the article the user
// tapped it on?
//
// Every other test in this area checks one half: the tree declares the right
// action, or the resolver mints the right row, or the matcher matches the right
// field. None of them can see the failure that spans the seam — a filter whose
// value is provably the article's own tag, correctly kinded, correctly
// strengthened, and *still* unequal to what the matcher compares it against.
// That failure is invisible from every UI seam too: `isInertActionLeaf` only
// hides a leaf that resolves to NOTHING, so a present-but-unmatchable value
// renders a chip, applies, toasts, and filters nothing forever.
//
// So this test starts from a geo/entity/event fixture, walks the SHIPPED tree
// to the leaf, resolves it exactly as the app does, and feeds the result to
// `suppressionMatchesCandidate` — the real scorer-side matcher, which knows
// nothing about the tree. The discriminator is independent of the thing judged.
//
// The `MIDDLE_EAST` case is the one that found a real bug: building the filter
// from `geoTextFromTags` (display prose, "Middle East") produced a `place` row
// that `normCountry`-compares "MIDDLE EAST" against the tag's "MIDDLE_EAST" and
// never matches. `from_context_place` reads the verbatim tag field instead.

// `geoTextFromTags` / `placeValueFromTags` are pure, but they live in an
// RN/WatermelonDB module — mocked exactly as that module's own suite does.
jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import {
  geoTextFromTags,
  placeValueFromTags,
} from '@/lib/database/services/article-suggestion-service';
import { suppressionMatchesCandidate } from '../../scoring-engine/suppression';
import type { SoftSuppression } from '../../scoring-engine/persona-context';
import type { ScoredCandidateInput } from '../../scoring-engine/relevance';
import { BUNDLED_FEEDBACK_TREE } from '@/lib/services/feedback-tree-snapshot';
import { resolveLeafActions } from '../resolve-leaf-actions';
import type { FeedbackTreeNode, LocalFeedbackContext, ResolvedPersonaAction } from '../types';

type GeoTag = { city?: string; region?: string; countryCode: string };

function findNodeSafe(nodes: FeedbackTreeNode[], id: string): FeedbackTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = n.children ? findNodeSafe(n.children, id) : null;
    if (hit) return hit;
  }
  return null;
}

/** Throwing lookup — a missing node means the tree moved under this test, which
 *  must fail loudly rather than skip the round trip it exists to run. */
function findNode(nodes: FeedbackTreeNode[], id: string): FeedbackTreeNode {
  const hit = findNodeSafe(nodes, id);
  if (!hit) throw new Error(`node ${id} not in the bundled tree`);
  return hit;
}

/** The scorer-side row `applyPersonaActions` ultimately persists and the
 *  persona loader hands back — reconstructed from the resolved action. */
function asSuppression(a: ResolvedPersonaAction): SoftSuppression {
  return {
    keywords: a.suppressionKeywords ?? [],
    strength: a.suppressionStrength ?? 0,
    ...(a.suppressionKind ? { kind: a.suppressionKind } : {}),
    ...(a.suppressionValue ? { value: a.suppressionValue } : {}),
    ...(a.suppressionPattern ? { pattern: a.suppressionPattern } : {}),
  } as SoftSuppression;
}

function candidate(over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput {
  return {
    id: 'a1',
    titleEn: 'Something happened somewhere',
    descriptionEn: 'A description with no useful nouns in it.',
    matchedTopics: [],
    ...over,
  };
}

/** Resolve a shipped leaf against a context and return its ONE suppression. */
function filterFor(id: string, ctx: LocalFeedbackContext): SoftSuppression {
  const actions = resolveLeafActions(findNode(BUNDLED_FEEDBACK_TREE.root, id).leaf, ctx);
  expect(actions).toHaveLength(1);
  return asSuppression(actions[0]);
}

describe('tag leaves — the filter matches the article it was minted from', () => {
  it.each<[string, GeoTag[]]>([
    ['a city tag', [{ city: 'Amsterdam', countryCode: 'NL' }]],
    ['a region tag', [{ region: 'Bavaria', countryCode: 'DE' }]],
    ['a plain ISO country tag', [{ countryCode: 'FR' }]],
    ['a SUPRANATIONAL tag', [{ countryCode: 'MIDDLE_EAST' }]],
  ])('less_place round-trips on %s', (_label, geoTags) => {
    // Build the context exactly as InlineFeedbackTree does.
    const ctx: LocalFeedbackContext = {
      geoText: geoTextFromTags(geoTags),
      placeValue: placeValueFromTags(geoTags),
    };
    expect(ctx.placeValue).toBeTruthy();

    const filter = filterFor('less_place', ctx);
    expect(filter.kind).toBe('place');
    expect(suppressionMatchesCandidate(candidate({ geoTags }), filter)).toBe(true);
    // …and does NOT match an article tagged somewhere else.
    expect(
      suppressionMatchesCandidate(candidate({ geoTags: [{ countryCode: 'JP', city: 'Osaka' }] }), filter),
    ).toBe(false);
  });

  it('the PROSE form would NOT have matched a supranational tag — the bug this shape avoids', () => {
    const geoTags: GeoTag[] = [{ countryCode: 'MIDDLE_EAST' }];
    // What a `place` filter built from geoText (display prose) would look like.
    const prose: SoftSuppression = {
      keywords: [],
      strength: 0.5,
      kind: 'place',
      value: geoTextFromTags(geoTags)!,
    };
    expect(prose.value).toBe('Middle East');
    expect(suppressionMatchesCandidate(candidate({ geoTags }), prose)).toBe(false);
    // The shipped leaf, on the same article, does match.
    expect(
      suppressionMatchesCandidate(
        candidate({ geoTags }),
        filterFor('less_place', {
          geoText: geoTextFromTags(geoTags),
          placeValue: placeValueFromTags(geoTags),
        }),
      ),
    ).toBe(true);
  });

  it('geoTextFromTags and placeValueFromTags always pick the SAME tag and field', () => {
    // The label the user reads and the value the filter carries must name one
    // place. Only the supranational cook may differ between them.
    const cases: GeoTag[][] = [
      [{ city: 'Amsterdam', region: 'North Holland', countryCode: 'NL' }],
      [{ region: 'Bavaria', countryCode: 'DE' }],
      [{ countryCode: 'FR' }, { city: 'Lyon', countryCode: 'FR' }],
      [{ countryCode: 'EU' }],
    ];
    for (const tags of cases) {
      const text = geoTextFromTags(tags)!;
      const value = placeValueFromTags(tags)!;
      expect(value).toBeTruthy();
      // Either identical, or the prose form of the very same code.
      if (text !== value) expect(value).toBe(tags[0].countryCode);
    }
  });

  it('less_entity round-trips against the article`s entities[]', () => {
    const entities = ['Reserve Bank of India', 'Nifty 50'];
    const filter = filterFor('less_entity', { entity: entities[0] });
    expect(filter.kind).toBe('entity');
    expect(suppressionMatchesCandidate(candidate({ entities }), filter)).toBe(true);
    expect(suppressionMatchesCandidate(candidate({ entities: ['Tesla'] }), filter)).toBe(false);
  });

  it('this_kind_of_event round-trips against the article`s event_type', () => {
    const filter = filterFor('this_kind_of_event', { eventType: 'election' });
    expect(filter.kind).toBe('event_type');
    expect(suppressionMatchesCandidate(candidate({ eventType: 'election' }), filter)).toBe(true);
    expect(suppressionMatchesCandidate(candidate({ eventType: 'weather' }), filter)).toBe(false);
  });

  it('this_category round-trips against the article`s category', () => {
    const filter = filterFor('this_category', { category: 'Sports' });
    expect(filter.kind).toBe('category');
    expect(suppressionMatchesCandidate(candidate({ category: 'Sports' }), filter)).toBe(true);
    expect(suppressionMatchesCandidate(candidate({ category: 'Politics' }), filter)).toBe(false);
  });

  it('a matching row can NEVER be an accident of the keyword haystack', () => {
    // Guards the whole file against passing vacuously: a structured filter must
    // match on its FIELD, so an article whose text merely mentions the value
    // must not match.
    const filter = filterFor('less_entity', { entity: 'Tesla' });
    expect(
      suppressionMatchesCandidate(
        candidate({ titleEn: 'Tesla recalls 4,000 cars', entities: ['Ford'] }),
        filter,
      ),
    ).toBe(false);
  });
});
