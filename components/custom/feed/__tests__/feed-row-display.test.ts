// feed-row-display — a Feed card never swaps its fronting article under the
// reader, and only a card that has been pending reserves note height.

import {
  displayedSuggestionOf,
  newFeedRowSession,
  resolveFeedRowDisplay,
} from '../feed-row-display';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

function sugg(o: Partial<ForYouSuggestion> & { _id: string }): ForYouSuggestion {
  return {
    articleId: `art-${o._id}`,
    clusters: [],
    relevance: 0.6,
    reason: 'because',
    status: ArticleSuggestionStatus.Complete,
    country_code: null,
    language_code: 'en',
    publication_name: `Pub ${o._id}`,
    title_en: `Title ${o._id}`,
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: new Date(0).toISOString(),
    firstPubDate: new Date(0).toISOString(),
    rawScore: 0.5,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    ...o,
  };
}

/** A row as `ingest` stores it: the row id stays, the representative moves. */
function row(id: string, rep: ForYouSuggestion): FeedListItem {
  return { id, suggestion: rep, memberCount: 2, memberIds: [id], breaking: false, score: 1 };
}

const live = (...rows: ForYouSuggestion[]) => new Map(rows.map((r) => [r._id, r]));

describe('resolveFeedRowDisplay: the fronting article stays put', () => {
  it('keeps the first representative when the store re-elects another', () => {
    const session = newFeedRowSession();
    const a = sugg({ _id: 'a', status: ArticleSuggestionStatus.ReasonPending, reason: '' });
    const b = sugg({ _id: 'b' });
    expect(resolveFeedRowDisplay(row('art-a', a), live(a, b), session).suggestion._id).toBe('a');
    // b got its note and now fronts the story in the store, under the old id.
    const d = resolveFeedRowDisplay(row('art-a', { ...b, _id: 'b' }), live(a, b), session);
    expect(d.suggestion._id).toBe('a');
    expect(d.suggestion.title_en).toBe('Title a');
  });

  it('shows the frozen article LIVE, so its own note lands in place', () => {
    const session = newFeedRowSession();
    const pending = sugg({ _id: 'a', status: ArticleSuggestionStatus.ReasonPending, reason: '' });
    resolveFeedRowDisplay(row('art-a', pending), live(pending), session);
    const done = sugg({ _id: 'a', reason: 'Now written' });
    const d = resolveFeedRowDisplay(row('art-a', pending), live(done), session);
    expect(d.suggestion.reason).toBe('Now written');
  });

  it('falls back to the row as first rendered, never the newer representative, once the store drops it', () => {
    const session = newFeedRowSession();
    const a = sugg({ _id: 'a' });
    const b = sugg({ _id: 'b' });
    resolveFeedRowDisplay(row('art-a', a), live(a, b), session);
    expect(resolveFeedRowDisplay(row('art-a', b), live(b), session).suggestion._id).toBe('a');
  });

  it('maps the frozen suggestion back to its row, for taps and verdicts', () => {
    const session = newFeedRowSession();
    const a = sugg({ _id: 'a' });
    resolveFeedRowDisplay(row('art-a', a), live(a), session);
    expect(session.rowBySuggestion.get('a')).toBe('art-a');
  });

  it('a new session re-elects', () => {
    const a = sugg({ _id: 'a' });
    const b = sugg({ _id: 'b' });
    const first = newFeedRowSession();
    resolveFeedRowDisplay(row('art-a', a), live(a, b), first);
    expect(resolveFeedRowDisplay(row('art-a', b), live(a, b), newFeedRowSession()).suggestion._id).toBe('b');
  });
});

describe('resolveFeedRowDisplay: note height is reserved only where it can change', () => {
  it('a card complete at first render keeps its natural height', () => {
    const session = newFeedRowSession();
    const a = sugg({ _id: 'a' });
    expect(resolveFeedRowDisplay(row('art-a', a), live(a), session).reserveNoteSpace).toBe(false);
  });

  it('a card pending at any point keeps the reserve after its note lands, for the session', () => {
    const session = newFeedRowSession();
    const pending = sugg({ _id: 'a', status: ArticleSuggestionStatus.ReasonPending, reason: '' });
    expect(resolveFeedRowDisplay(row('art-a', pending), live(pending), session).reserveNoteSpace).toBe(true);
    const done = sugg({ _id: 'a', reason: 'Now written' });
    expect(resolveFeedRowDisplay(row('art-a', pending), live(done), session).reserveNoteSpace).toBe(true);
    expect(resolveFeedRowDisplay(row('art-a', pending), live(done), newFeedRowSession()).reserveNoteSpace).toBe(false);
  });

  it('a declined note (reason_skipped) counts as pending: the box it shows keeps its height', () => {
    const session = newFeedRowSession();
    const skipped = sugg({ _id: 'a', status: ArticleSuggestionStatus.ReasonSkipped, reason: '' });
    expect(resolveFeedRowDisplay(row('art-a', skipped), live(skipped), session).reserveNoteSpace).toBe(true);
  });
});

describe('displayedSuggestionOf: the article the card shows, for the sort', () => {
  it('a row not frozen yet reads its representative, and records nothing', () => {
    const session = newFeedRowSession();
    const a = sugg({ _id: 'a' });
    expect(displayedSuggestionOf(row('art-a', a), live(a), session)).toBe(a);
    expect(session.frozenRep.size).toBe(0);
    expect(session.rowBySuggestion.size).toBe(0);
    expect(session.wasPending.size).toBe(0);
  });

  it('a frozen row reads the FROZEN article live, not the newer representative', () => {
    const session = newFeedRowSession();
    const pending = sugg({ _id: 'a', status: ArticleSuggestionStatus.ReasonPending, reason: '' });
    const sibling = sugg({ _id: 'b' });
    resolveFeedRowDisplay(row('art-a', pending), live(pending, sibling), session);
    // The store re-elected the sibling (it has its note); the card still shows `a`.
    expect(displayedSuggestionOf(row('art-a', sibling), live(pending, sibling), session)._id).toBe('a');
    const done = sugg({ _id: 'a', reason: 'Now written' });
    expect(displayedSuggestionOf(row('art-a', sibling), live(done, sibling), session)).toBe(done);
  });

  it('a frozen article swept from the store falls back to the row as first rendered', () => {
    const session = newFeedRowSession();
    const a = sugg({ _id: 'a' });
    const b = sugg({ _id: 'b' });
    resolveFeedRowDisplay(row('art-a', a), live(a), session);
    expect(displayedSuggestionOf(row('art-a', b), live(b), session)).toBe(a);
  });
});
