// read-story-filter: the pre-scoring already-read gate's matcher. The pure half
// (buildReadStoryIndex / matchesReadStory) takes plain rows; the two DB touch-points run over the
// real story_impressions and article_suggestions tables, seeded through the app's own services.
import database from '@/lib/database';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import { TITLE_JACCARD_PROPAGATION_THRESHOLD } from '@/lib/algorithms/story-grouping';
import {
  batchMarkAlreadyRead,
  buildReadStoryIndex,
  EMPTY_READ_STORY_INDEX,
  loadReadStoryIndex,
  matchesReadStory,
  READ_STORY_TITLE_JACCARD_THRESHOLD,
  type ReadStoryImpressionRow,
} from '@/lib/feed-grouping/read-story-filter';
import logger from '@/lib/logger';
import { useFakeClock } from '@/test/helpers';
import { seedScored, seedUnscored, seedViewOnlyImpression, suggestionRow } from './seed';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
  },
}));
const mockCaptureException = logger.captureException as jest.Mock;

afterEach(() => jest.restoreAllMocks());

function opened(overrides: Partial<ReadStoryImpressionRow> = {}): ReadStoryImpressionRow {
  return {
    articleId: 'a1',
    titleNorm: null,
    opened: true,
    ...overrides,
  };
}

// ===========================================================================
// buildReadStoryIndex
// ===========================================================================

describe('buildReadStoryIndex', () => {
  it('folds opened rows into the two axes', () => {
    const index = buildReadStoryIndex([
      opened({ articleId: 'a1', titleNorm: 'alpha beta gamma' }),
      opened({ articleId: 'a2' }),
    ]);

    expect(index.impressionCount).toBe(2);
    expect(index.articleIds).toEqual(new Set(['a1', 'a2']));
    expect(index.titleTokenSets).toHaveLength(1);
  });

  it('ignores rows that were merely seen, never opened', () => {
    const index = buildReadStoryIndex([
      { articleId: 'seen', titleNorm: 'alpha beta gamma', opened: false },
      { articleId: 'legacy', titleNorm: 'alpha beta gamma' }, // opened absent
    ]);

    expect(index.impressionCount).toBe(0);
    expect(index.articleIds.size).toBe(0);
    expect(matchesReadStory({ articleId: 'seen' }, index)).toBe(false);
  });

  it('keeps an id-only row matchable (a read with no title snapshot)', () => {
    const index = buildReadStoryIndex([opened({ articleId: 'a1', titleNorm: '  ' })]);
    expect(index.impressionCount).toBe(1);
    expect(index.titleTokenSets).toHaveLength(0);
    expect(matchesReadStory({ articleId: 'a1' }, index)).toBe(true);
  });

  it('never throws on junk input', () => {
    expect(() => buildReadStoryIndex(undefined as any)).not.toThrow();
    expect(buildReadStoryIndex([null as any]).impressionCount).toBe(0);
  });
});

// ===========================================================================
// matchesReadStory: the two axes
// ===========================================================================

describe('matchesReadStory', () => {
  it('matches on article_id equality', () => {
    const index = buildReadStoryIndex([opened({ articleId: 'art-1' })]);
    expect(matchesReadStory({ articleId: 'art-1' }, index)).toBe(true);
    expect(matchesReadStory({ articleId: 'art-2' }, index)).toBe(false);
  });

  it('still matches a same-cluster candidate whose headline is near-identical (the title key)', () => {
    const index = buildReadStoryIndex([
      opened({
        articleId: 'art-1',
        titleNorm: 'anthropic launches claude opus for enterprise customers',
      }),
    ]);
    expect(
      matchesReadStory(
        {
          articleId: 'art-2',
          title: 'Anthropic launches Claude Opus for enterprise customers today',
        },
        index,
      ),
    ).toBe(true);
  });

  it('matches a re-serve of the same headline from another publisher (title axis)', () => {
    const index = buildReadStoryIndex([
      opened({
        articleId: 'art-1',
        titleNorm: 'anthropic launches claude opus for enterprise customers',
      }),
    ]);
    // Different article id, no cluster id, near-identical headline: 6 shared
    // tokens of a 7-token union ⇒ 0.857.
    expect(
      matchesReadStory(
        {
          articleId: 'art-999',
          title: 'Anthropic launches Claude Opus for enterprise customers today',
        },
        index,
      ),
    ).toBe(true);
  });

  it('does NOT match a genuinely new development in the same story', () => {
    const index = buildReadStoryIndex([
      opened({
        articleId: 'art-1',
        titleNorm: 'anthropic launches claude opus for enterprise customers',
      }),
    ]);
    // Shares only "anthropic": a new headline about a new event must still
    // reach the feed. THIS IS THE BOUNDARY THE WHOLE DESIGN RESTS ON.
    expect(
      matchesReadStory(
        { articleId: 'art-2', title: 'Anthropic faces EU antitrust probe model pricing' },
        index,
      ),
    ).toBe(false);
  });

  it('brackets the 0.55 bar: 0.6 matches, 0.5 does not', () => {
    const index = buildReadStoryIndex([
      opened({ articleId: 'art-1', titleNorm: 'aaa bbb ccc ddd' }),
    ]);
    // ∩ = {aaa,bbb,ccc} (3), ∪ = 5 ⇒ 0.6 ≥ 0.55.
    expect(matchesReadStory({ title: 'aaa bbb ccc eee' }, index)).toBe(true);
    // ∩ = {aaa,bbb,ccc} (3), ∪ = 6 ⇒ 0.5 < 0.55.
    expect(matchesReadStory({ title: 'aaa bbb ccc eee fff' }, index)).toBe(false);
  });

  it('uses the SAME constant as score propagation', () => {
    expect(READ_STORY_TITLE_JACCARD_THRESHOLD).toBe(TITLE_JACCARD_PROPAGATION_THRESHOLD);
    expect(READ_STORY_TITLE_JACCARD_THRESHOLD).toBe(0.55);
  });

  it('is inert on an empty index and on empty candidates', () => {
    expect(matchesReadStory({ articleId: 'x' }, EMPTY_READ_STORY_INDEX)).toBe(false);
    const index = buildReadStoryIndex([opened({ articleId: 'a1', titleNorm: 'aaa bbb' })]);
    expect(matchesReadStory({}, index)).toBe(false);
    expect(matchesReadStory({ articleId: '   ', title: null }, index)).toBe(false);
  });

  it('only compares against read titles that share a token (blocking is exact)', () => {
    const index = buildReadStoryIndex([
      opened({ articleId: 'a1', titleNorm: 'aaa bbb ccc' }),
      opened({ articleId: 'a2', titleNorm: 'xxx yyy zzz' }),
    ]);
    expect(matchesReadStory({ title: 'xxx yyy zzz' }, index)).toBe(true);
    expect(matchesReadStory({ title: 'qqq rrr sss' }, index)).toBe(false);
  });
});

// ===========================================================================
// loadReadStoryIndex
// ===========================================================================

describe('loadReadStoryIndex', () => {
  it('builds from the impression service', async () => {
    await recordOpen({ articleId: 'a1', titleNorm: 'aaa bbb ccc', surface: 'feed' });
    await seedViewOnlyImpression('a2');

    const index = await loadReadStoryIndex();

    expect(index.impressionCount).toBe(1);
    expect(index.articleIds).toEqual(new Set(['a1']));
  });

  it('fails OPEN (matches nothing) when the read throws', async () => {
    await recordOpen({ articleId: 'a1', surface: 'feed' });
    jest.spyOn(database.get('story_impressions'), 'query').mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const index = await loadReadStoryIndex();

    expect(index.impressionCount).toBe(0);
    expect(matchesReadStory({ articleId: 'a1' }, index)).toBe(false);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// batchMarkAlreadyRead
// ===========================================================================

describe('batchMarkAlreadyRead', () => {
  it('writes the distinct terminal status and zeroes the scores', async () => {
    await seedScored(
      { id: 's1' },
      { relevance: 0.9, reason: 'why', computedScore: 0.7, rawScore: 0.8 },
    );
    // A row that was never scored has no scored_at, so it takes the one the caller passes.
    await seedUnscored({ id: 's2' });
    expect((await suggestionRow('s1')).reason).toBe('why');

    await batchMarkAlreadyRead(['s1', 's2'], 1_700_000_000_000);

    for (const id of ['s1', 's2']) {
      const row = await suggestionRow(id);
      expect(row.status).toBe(ArticleSuggestionStatus.AlreadyRead);
      expect(row.status).toBe('already_read');
      // Distinct from the hard-filter terminal status, on purpose.
      expect(row.status).not.toBe(ArticleSuggestionStatus.Excluded);
      expect(row.relevance).toBe(0);
      expect(row.reason).toBe('');
      expect(row.rawScore).toBe(0);
      expect(row.computedScore).toBe(0);
    }
    expect((await suggestionRow('s2')).scoredAt).toBe(1_700_000_000_000);
  });

  it('never slides an existing scored_at forward', async () => {
    useFakeClock(123);
    await seedScored({ id: 's1' }, { relevance: 0.9, reason: 'why' });
    expect((await suggestionRow('s1')).scoredAt).toBe(123);

    await batchMarkAlreadyRead(['s1'], 999_999);

    expect((await suggestionRow('s1')).scoredAt).toBe(123);
  });

  it('tolerates a row hard-deleted underneath the batch', async () => {
    await seedUnscored({ id: 's1' });

    await expect(batchMarkAlreadyRead(['s1', 'gone'], 1)).resolves.toBeUndefined();
    expect((await suggestionRow('s1')).status).toBe(ArticleSuggestionStatus.AlreadyRead);
  });

  it('no-ops on an empty id list', async () => {
    await seedUnscored({ id: 's1' });
    const write = jest.spyOn(database, 'write');

    await batchMarkAlreadyRead([]);

    expect(write).not.toHaveBeenCalled();
    expect((await suggestionRow('s1')).status).toBe(ArticleSuggestionStatus.Unscored);
  });
});
