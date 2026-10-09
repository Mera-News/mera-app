// swipe-feedback: the Feed-tab signal writers and the Mera chat handoff.
//
// Real article-feedback-service on the in-memory DB, real feedback-tree (the bundled snapshot),
// real i18n and real floating-chat-store. Assertions read the stored rows and the store back.
import database from '@/lib/database';
import type ArticleFeedbackModel from '@/lib/database/models/ArticleFeedback';
import { swipeCallbacks } from '@/components/custom/feed/swipe-callbacks';
import * as feedbackTreeService from '@/lib/services/feedback-tree-service';
import logger from '@/lib/logger';
import {
  changeSwipeVerdict,
  commitFeedbackTreePath,
  openArticleChat,
  openFeedbackChatWithPath,
  recordSwipeVerdict,
  removeSwipeVerdict,
  updateFeedbackTreePath,
  wireSwipeCallbacks,
} from '@/lib/services/swipe-feedback';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { initI18nEn } from '@/test/helpers';

function makeSuggestion(overrides: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: 'sugg-1',
    articleId: 'art-1',
    clusters: [],
    relevance: 0.8,
    reason: '',
    status: 'complete' as ForYouSuggestion['status'],
    country_code: 'IN',
    language_code: 'en',
    publication_name: 'The Hindu',
    title_en: 'A story',
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: '2026-07-20',
    firstPubDate: '2026-07-19',
    rawScore: null,
    eventType: null,
    headlineScope: null,
    matchedTopics: [{ topicId: 't1', text: 'cricket' }],
    ...overrides,
  };
}

/** Every stored feedback row for an article, oldest first. */
async function feedbackRows(articleId = 'art-1') {
  const rows = await database.get<ArticleFeedbackModel>('article_feedback').query().fetch();
  return rows
    .filter((r) => r.articleId === articleId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
const sentiments = async () => (await feedbackRows()).map((r) => r.sentiment);
const contextOf = async (sentiment: string) =>
  JSON.parse((await feedbackRows()).find((r) => r.sentiment === sentiment)!.contextJson!);

/** The wired callbacks are fire-and-forget (`void`): poll until the write has landed. */
async function eventually(check: () => Promise<void> | void, ms = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() - start > ms) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

const unwired = { ...swipeCallbacks };

beforeEach(async () => {
  await initI18nEn();
  feedbackTreeService.resetFeedbackTreeMemo();
  useFloatingChatStore.getState().reset();
});

afterEach(() => {
  Object.assign(swipeCallbacks, unwired);
  jest.restoreAllMocks();
});

describe('recordSwipeVerdict', () => {
  it('records a verdict with origin/surface + context snapshot', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');

    const rows = await feedbackRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      articleId: 'art-1',
      suggestionId: 'sugg-1',
      sentiment: 'like',
      title: 'A story',
      origin: 'suggestion',
      surface: 'swipe',
    });
    // Context snapshot carries the matched topics + relevance + publication
    // (keyed `publication`, matching the digest's DigestSignalContext).
    expect(JSON.parse(rows[0].contextJson!)).toMatchObject({ relevance: 0.8, publication: 'The Hindu' });
    // A bare verdict (no tree path) is reaped at write: it can never reach the digest.
    expect(rows[0].processedAt).not.toBeNull();
  });

  it('is latest-wins: a dislike replaces an earlier like on the same article', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');
    await recordSwipeVerdict(makeSuggestion(), 'dislike');

    expect(await sentiments()).toEqual(['dislike']);
  });

  it('recording the same verdict twice keeps one row', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');
    await recordSwipeVerdict(makeSuggestion(), 'like');

    expect(await sentiments()).toEqual(['like']);
  });
});

describe('changeSwipeVerdict', () => {
  it('removes the old sentiment and records the new one', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');

    await changeSwipeVerdict(makeSuggestion(), 'like', 'dislike');

    expect(await sentiments()).toEqual(['dislike']);
  });

  it('no-ops when from === to', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');
    const before = (await feedbackRows())[0];

    await changeSwipeVerdict(makeSuggestion(), 'like', 'like');

    const rows = await feedbackRows();
    expect(rows.map((r) => r.id)).toEqual([before.id]);
  });

  it('no-op on a card that has no verdict stored writes nothing', async () => {
    await changeSwipeVerdict(makeSuggestion(), 'like', 'like');
    expect(await feedbackRows()).toEqual([]);
  });
});

describe('removeSwipeVerdict', () => {
  it('destroys the stored feedback row for the un-voted sentiment', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');

    await removeSwipeVerdict(makeSuggestion(), 'like');

    expect(await feedbackRows()).toEqual([]);
  });

  it('leaves the other sentiment alone', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'dislike');

    await removeSwipeVerdict(makeSuggestion(), 'like');

    expect(await sentiments()).toEqual(['dislike']);
  });
});

describe('updateFeedbackTreePath', () => {
  it('stores the path on the verdict row and commits nothing', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'dislike');

    await updateFeedbackTreePath(makeSuggestion(), 'dislike', ['a', 'b']);

    const ctx = await contextOf('dislike');
    expect(ctx.treePath).toEqual(['a', 'b']);
    expect(ctx.committed).toBeUndefined();
    // Navigation is not context: the row stays out of the digest.
    expect((await feedbackRows())[0].processedAt).not.toBeNull();
  });

  it('keeps the snapshot written at record time', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'dislike');
    await updateFeedbackTreePath(makeSuggestion(), 'dislike', ['a']);

    expect(await contextOf('dislike')).toMatchObject({ relevance: 0.8, publication: 'The Hindu', treePath: ['a'] });
  });

  it('writes nothing when the card has no verdict row', async () => {
    await updateFeedbackTreePath(makeSuggestion(), 'dislike', ['a']);
    expect(await feedbackRows()).toEqual([]);
  });
});

// A committed path write re-opens the row for the digest (processed_at = null), and it lands after
// applyLeafActions stamped the row spent. When a leaf applied something, the commit must stamp it
// again, AFTER the write.
describe('commitFeedbackTreePath', () => {
  it('commits the path, then re-stamps the row spent when the leaf applied something', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'dislike');

    await commitFeedbackTreePath(makeSuggestion(), 'dislike', ['a'], 2);

    const ctx = await contextOf('dislike');
    expect(ctx).toMatchObject({ treePath: ['a'], committed: true });
    // Re-stamped after the write: had the stamp come first, the commit would have cleared it.
    expect((await feedbackRows())[0].processedAt).not.toBeNull();
  });

  it('leaves the row open for the digest when nothing applied', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'dislike');

    await commitFeedbackTreePath(makeSuggestion(), 'dislike', ['a'], 0);

    expect(await contextOf('dislike')).toMatchObject({ treePath: ['a'], committed: true });
    expect((await feedbackRows())[0].processedAt).toBeNull();
  });

  it('defaults appliedCount to 0', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');

    await commitFeedbackTreePath(makeSuggestion(), 'like', ['more_about_topic']);

    expect((await feedbackRows())[0].processedAt).toBeNull();
  });
});

describe('openFeedbackChatWithPath', () => {
  it('resolves like-root path labels + opens chat with verdict + label breadcrumb', async () => {
    await openFeedbackChatWithPath(makeSuggestion(), 'like', ['more_about_topic', 'a_lot_more']);

    const chat = useFloatingChatStore.getState();
    expect(chat.isExpanded).toBe(true);
    expect(chat.context).toMatchObject({
      kind: 'article-suggestion',
      articleId: 'art-1',
      suggestionId: 'sugg-1',
      articleTitle: 'A story',
      verdict: 'like',
      treePath: ['More about this topic', 'A lot more'],
    });
    expect(chat.pendingInitialMessage).toBe(
      'I liked this story. More like this: More about this topic → A lot more.',
    );
  });

  it('resolves dislike-root path labels from the dislike tree', async () => {
    await openFeedbackChatWithPath(makeSuggestion(), 'dislike', ['publication_issue', 'paywall']);

    const chat = useFloatingChatStore.getState();
    expect(chat.context).toMatchObject({
      verdict: 'dislike',
      treePath: ['Issue with this publication', "It's paywalled"],
    });
    expect(chat.pendingInitialMessage).toBe(
      "I didn't like this story: Issue with this publication → It's paywalled.",
    );
  });

  it('stops at the first id that does not resolve', async () => {
    await openFeedbackChatWithPath(makeSuggestion(), 'like', ['more_about_topic', 'not_a_node', 'a_lot_more']);

    expect(useFloatingChatStore.getState().context).toMatchObject({ treePath: ['More about this topic'] });
  });

  it('uses the no-path message when the path is empty', async () => {
    await openFeedbackChatWithPath(makeSuggestion(), 'dislike', []);

    const chat = useFloatingChatStore.getState();
    expect(chat.context).toMatchObject({ verdict: 'dislike', treePath: [] });
    expect(chat.pendingInitialMessage).toBe("I didn't like this story. Help me get fewer like it.");
  });

  it('uses the like no-path message when the like path is empty', async () => {
    await openFeedbackChatWithPath(makeSuggestion(), 'like', []);

    expect(useFloatingChatStore.getState().pendingInitialMessage).toBe(
      "I liked this story. I'd like more like this.",
    );
  });

  it('still opens the chat, without labels, when the tree cannot be read', async () => {
    const capture = jest.spyOn(logger, 'captureException').mockImplementation(() => '');
    jest.spyOn(feedbackTreeService, 'getFeedbackTree').mockRejectedValueOnce(new Error('tree unavailable'));

    await openFeedbackChatWithPath(makeSuggestion(), 'like', ['more_about_topic']);

    expect(capture).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'swipe-feedback', method: 'openChat.labels' },
    });
    const chat = useFloatingChatStore.getState();
    expect(chat.context).toMatchObject({ treePath: [] });
    expect(chat.pendingInitialMessage).toBe("I liked this story. I'd like more like this.");
  });

  it('opens with an empty title when the suggestion has none', async () => {
    await openFeedbackChatWithPath(makeSuggestion({ title_en: null }), 'like', []);
    expect(useFloatingChatStore.getState().context).toMatchObject({ articleTitle: '' });
  });
});

describe('openArticleChat', () => {
  it('opens the DEFAULT article chat (no verdict/path, no auto-sent message)', () => {
    openArticleChat(makeSuggestion());

    const chat = useFloatingChatStore.getState();
    expect(chat.isExpanded).toBe(true);
    expect(chat.context).toEqual({
      kind: 'article-suggestion',
      articleId: 'art-1',
      suggestionId: 'sugg-1',
      articleTitle: 'A story',
    });
    // Crucially NOT the primed handoff path.
    expect(chat.pendingInitialMessage).toBeNull();
  });
});

describe('wireSwipeCallbacks', () => {
  it('replaces the no-op contract members', () => {
    wireSwipeCallbacks();
    for (const key of Object.keys(unwired) as (keyof typeof unwired)[]) {
      expect(swipeCallbacks[key]).not.toBe(unwired[key]);
    }
  });

  it('installs real implementations onto the swipe-callbacks contract', async () => {
    wireSwipeCallbacks();

    swipeCallbacks.onVerdict(makeSuggestion(), 'like');

    await eventually(async () => expect(await sentiments()).toEqual(['like']));
  });

  it('wires onVerdictChanged to flip the stored verdict', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');
    wireSwipeCallbacks();

    swipeCallbacks.onVerdictChanged(makeSuggestion(), 'like', 'dislike');

    await eventually(async () => expect(await sentiments()).toEqual(['dislike']));
  });

  it('wires onVerdictRemoved to destroy the stored feedback row', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'like');
    wireSwipeCallbacks();

    swipeCallbacks.onVerdictRemoved(makeSuggestion(), 'like');

    await eventually(async () => expect(await feedbackRows()).toEqual([]));
  });

  it('wires onTreePathChanged to store the path without committing', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'dislike');
    wireSwipeCallbacks();

    swipeCallbacks.onTreePathChanged(makeSuggestion(), 'dislike', ['x']);

    await eventually(async () => expect(await contextOf('dislike')).toMatchObject({ treePath: ['x'] }));
    expect((await contextOf('dislike')).committed).toBeUndefined();
  });

  it('wires onLeafCommitted to commit the path and re-stamp when the leaf applied something', async () => {
    await recordSwipeVerdict(makeSuggestion(), 'dislike');
    wireSwipeCallbacks();

    swipeCallbacks.onLeafCommitted(makeSuggestion(), 'dislike', ['x'], 1);

    await eventually(async () => {
      expect(await contextOf('dislike')).toMatchObject({ treePath: ['x'], committed: true });
      expect((await feedbackRows())[0].processedAt).not.toBeNull();
    });
  });

  it('wires onInvokeMera to the primed verdict + path handoff', async () => {
    wireSwipeCallbacks();

    swipeCallbacks.onInvokeMera(makeSuggestion(), 'like', ['more_about_topic']);

    await eventually(() => {
      expect(useFloatingChatStore.getState().context).toMatchObject({
        verdict: 'like',
        treePath: ['More about this topic'],
      });
    });
    expect(useFloatingChatStore.getState().pendingInitialMessage).toBe(
      'I liked this story. More like this: More about this topic.',
    );
  });

  it('wires the VerdictBar Mera icon to the plain article chat (no prime)', () => {
    wireSwipeCallbacks();

    swipeCallbacks.onOpenArticleChat(makeSuggestion());

    const chat = useFloatingChatStore.getState();
    expect(chat.context).toMatchObject({ kind: 'article-suggestion', articleId: 'art-1' });
    expect(chat.pendingInitialMessage).toBeNull();
  });
});
