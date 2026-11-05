// Not preferred on the Continuous Feed, through useFeedScreen with the real writer, stores and
// in-memory DB. A card goes at the tap, stays gone after the purge, comes back on Undo, and the
// session's held context still decides everything else.
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { batchMarkScoreFailed } from '@/lib/database/services/article-suggestion-scoring-writes';
import { resolveFeedRowDisplay } from '@/components/custom/feed/feed-row-display';
import { resetFeedViewPrefs } from '@/components/custom/feed/feed-view-prefs';
import { revertSourcePrefChange, setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import { setAppState } from '@/test/helpers';
import { HIGH, MEDIUM, act, hydrateSuggestions, renderFeed, resetFeedStores, seedArticles, seedComplete, waitFor } from './support';

beforeEach(async () => {
  setAppState('active');
  resetFeedViewPrefs();
  await resetFeedStores();
});

const hide = async (name: string) => {
  let res: Awaited<ReturnType<typeof setSourcePrefFromUi>> | undefined;
  await act(async () => {
    res = await setSourcePrefFromUi({ kind: 'publisher', names: [name] }, 'muted');
  });
  return res!;
};

it('the card leaves at the tap, and Undo puts it back in its place', async () => {
  await seedComplete([['gone', HIGH, { publication: 'Gone' }], ['kept', MEDIUM, { publication: 'Kept' }]]);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toEqual(['gone', 'kept']));

  const res = await hide('Gone');
  await waitFor(() => expect(feed.ids()).toEqual(['kept']));

  await act(async () => {
    await revertSourcePrefChange(res);
    await res.commitPurge?.();
  });
  await waitFor(() => expect(feed.ids()).toEqual(['gone', 'kept']));
});

it('stays gone after the purge, with the store reloaded', async () => {
  await seedComplete([['gone', HIGH, { publication: 'Gone' }], ['kept', MEDIUM, { publication: 'Kept' }]]);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toEqual(['gone', 'kept']));

  const res = await hide('Gone');
  await act(async () => {
    await res.commitPurge?.();
    await hydrateSuggestions();
  });
  await waitFor(() => expect(feed.ids()).toEqual(['kept']));
});

it('a card frozen on the hidden article leaves even when a sibling could front the story', async () => {
  await seedComplete([
    ['gone', HIGH, { publication: 'Gone', clusterId: 'story' }],
    ['copy', HIGH, { publication: 'Copy', clusterId: 'story' }],
    ['kept', MEDIUM, { publication: 'Kept' }],
  ]);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toHaveLength(2));
  const hiddenId = feed.result.current.listData.find((it) => it.memberCount === 2)!;
  const front = hiddenId.suggestion.publication_name!;
  // What FeedScreen does as it renders each row.
  for (const it of feed.result.current.listData) {
    resolveFeedRowDisplay(it, feed.result.current.liveById, feed.result.current.rowSessionRef.current);
  }

  await hide(front);
  await waitFor(() => expect(feed.ids()).toEqual(['kept']));
});

it('a not-read card leaves too, and Undo puts it back', async () => {
  await seedComplete([['pick', HIGH, { publication: 'Kept' }]]);
  await seedArticles([{ id: 'tried', title: 'Ferry strike disrupts the island crossings', publication: 'Gone' }]);
  const tried = (await loadSuggestions()).filter((s) => s.articleId === 'tried').map((s) => s._id);
  await batchMarkScoreFailed(tried);
  await hydrateSuggestions();
  const feed = await renderFeed();
  await waitFor(() => expect(feed.ids()).toEqual(['pick', 'tried']));

  const res = await hide('Gone');
  await waitFor(() => expect(feed.ids()).toEqual(['pick']));

  await act(async () => {
    await revertSourcePrefChange(res);
  });
  await waitFor(() => expect(feed.ids()).toEqual(['pick', 'tried']));
});
