// The server ask (fetchFactCheck, requestFactCheck) and the article tick (requestArticleFactCheck),
// against the mock GraphQL server, the real Apollo client and the in-memory DB. Replaces
// lib/fact-check/__tests__/fact-check-graphql-client.test.ts (fetch/request/asked-list halves) and
// request-article-fact-check.test.ts, which mocked the client, the DB services and four stores.
//
// A FACT CHECK IS FETCHED AND SHOWN ONLY IF THIS DEVICE ASKED FOR IT: the asserts below read the
// operation each call used off the wire, the rows it wrote off the DB, and the asked list off the
// persisted setting.
import { fetchFactCheck, requestFactCheck, stopAskedFactCheckPollerForTest } from '@/lib/fact-check/fact-check-graphql-client';
import { requestArticleFactCheck } from '@/lib/fact-check/request-article-fact-check';
import * as retention from '@/lib/database/services/saved-article-suggestion-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { getAiAccess, useSubscriptionStore } from '@/lib/stores/subscription-store';
import { advanceUntilDone, http, HttpResponse, mockGqlError, server, signInFixtureAccount, useFakeClock as installFakeClock } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import {
  ASK_OP,
  askedIds,
  askedMap,
  checkRow,
  fullArticle,
  opsOf,
  pendingRow,
  REREAD_OP,
  retainedAs,
  serveChecks,
  storedFor,
  until,
} from './kit';
import { upsertFactCheck } from '@/lib/database/services/fact-check-record-service';

const mockImpact = jest.fn();
jest.mock('expo-haptics', () => ({
  __esModule: true,
  impactAsync: (...a: unknown[]) => mockImpact(...a),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});
afterEach(() => {
  jest.restoreAllMocks();
  // The first ask arms the in-session poller; a timer left over fires after teardown.
  stopAskedFactCheckPollerForTest();
  useSubscriptionStore.getState().reset();
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
});

describe('fetchFactCheck: the raw call', () => {
  it('reports a terminal row as terminal, and never answers from a cache', async () => {
    const wire = serveChecks({ ask: () => checkRow() });

    const first = await fetchFactCheck('a1');
    await fetchFactCheck('a1');

    expect(first.terminal).toBe(true);
    expect(first.row).toMatchObject({ status: 'complete', verdict: 'supported' });
    // no-cache: the second call reached the server again instead of reading its own answer.
    expect(opsOf(wire, ASK_OP)).toEqual(['a1', 'a1']);
  });

  it('reports an in-flight row as NOT terminal', async () => {
    serveChecks({ ask: () => pendingRow() });
    expect(await fetchFactCheck('a1')).toMatchObject({ terminal: false, row: { status: 'pending' } });
  });

  it('treats a null row (nobody asked, or the resolver echoed nothing yet) as not terminal', async () => {
    serveChecks({ ask: () => null });
    expect(await fetchFactCheck('a1')).toEqual({ terminal: false, row: null });
  });

  it('propagates a GraphQL failure: this is the raw call, callers decide how to degrade', async () => {
    server.use(mockGqlError(ASK_OP, 'INTERNAL_SERVER_ERROR', { message: 'boom' }));
    await expect(fetchFactCheck('a1')).rejects.toThrow('boom');
  });
});

describe('requestFactCheck', () => {
  it('stores a terminal row in the legacy whole-article slot, payload verbatim', async () => {
    const row = checkRow({ articleTitle: 'Server title' });
    serveChecks({ ask: () => row });

    const outcome = await requestFactCheck('a1', 'Caller title');

    expect(outcome.terminal).toBe(true);
    const [stored, ...rest] = await storedFor('a1');
    expect(rest).toEqual([]);
    expect(stored).toMatchObject({
      articleId: 'a1',
      factCheckId: row._id,
      articleTitle: 'Server title',
      status: 'complete',
      verdict: 'supported',
      claim: null,
      claimKey: null,
    });
    expect(stored.payload).toEqual(JSON.parse(JSON.stringify(row)));
    expect(stored.resolvedAt).not.toBeNull();
  });

  it("falls back to the caller's title when the server row has none", async () => {
    serveChecks({ ask: () => pendingRow({ articleTitle: null }) });
    await requestFactCheck('a1', 'Caller title');
    expect((await storedFor('a1'))[0].articleTitle).toBe('Caller title');
  });

  it('stores a pending marker when the server echoes no row at all', async () => {
    serveChecks({ ask: () => null });

    const outcome = await requestFactCheck('a1', 'Caller title');

    expect(outcome).toEqual({ terminal: false, row: null });
    expect(await storedFor('a1')).toEqual([
      expect.objectContaining({ factCheckId: '', status: 'pending', articleTitle: 'Caller title', payload: null, resolvedAt: null }),
    ]);
  });

  it('degrades a transport failure to "not yet confirmed": nothing stored, nothing retained, no throw', async () => {
    installFakeClock(Date.now());
    server.use(http.post('*/graphql', () => HttpResponse.error()));

    const outcome = await advanceUntilDone(requestFactCheck('a1', 'T'), 600_000, 500);

    expect(outcome).toEqual({ terminal: false, row: null });
    expect(await storedFor('a1')).toEqual([]);
    expect(await retainedAs('a1')).toBeNull();
  });

  it('degrades a GraphQL failure the same way, and does not keep the article', async () => {
    server.use(mockGqlError(ASK_OP, 'INTERNAL_SERVER_ERROR'));
    expect(await requestFactCheck('a1', 'T')).toEqual({ terminal: false, row: null });
    expect(await storedFor('a1')).toEqual([]);
    expect(await retainedAs('a1')).toBeNull();
  });

  it('is idempotent: asking again for a settled article re-confirms the same single row', async () => {
    const row = checkRow();
    serveChecks({ ask: () => row });

    await requestFactCheck('a1', 'T');
    const again = await requestFactCheck('a1', 'T');

    expect(again).toMatchObject({ terminal: true, row: { _id: row._id } });
    expect(await storedFor('a1')).toHaveLength(1);
  });
});

describe('the retention of the checked article', () => {
  it('keeps the full snapshot the screen passed, as a retention row and not a save', async () => {
    serveChecks({ ask: () => pendingRow() });

    await requestFactCheck('a1', 'T', { articleId: 'a1', article: fullArticle('a1') });

    const kept = await retainedAs('a1');
    expect(kept?.retained).toBe(true);
    expect(kept?.suggestion).toMatchObject({
      articleId: 'a1',
      title_en: 'Full snapshot headline',
      publication_name: 'Full Snapshot Daily',
      article_url: 'https://example.com/full-snapshot',
    });
    expect(await retention.isSuggestionSaved('a1')).toBe(false);
  });

  it('degrades to the server row (title, url, publication) when the caller has no snapshot', async () => {
    serveChecks({
      ask: () => pendingRow({ articleTitle: 'Row title', articleUrl: 'https://example.com/row', publicationName: 'Row Pub' }),
    });

    await requestFactCheck('a1', 'Caller title');

    expect((await retainedAs('a1'))?.suggestion).toMatchObject({
      title_en: 'Row title',
      article_url: 'https://example.com/row',
      publication_name: 'Row Pub',
    });
  });

  it('keeps a title-only snapshot on the pending-stub branch (no row echoed)', async () => {
    serveChecks({ ask: () => null });
    await requestFactCheck('a1', 'Caller title');
    expect((await retainedAs('a1'))?.suggestion.title_en).toBe('Caller title');
  });

  it('keeps a titleless snapshot when neither the caller nor the server row names the article', async () => {
    serveChecks({ ask: () => pendingRow({ articleTitle: null, articleUrl: null, publicationName: null }) });

    await requestFactCheck('a1');

    const kept = await retainedAs('a1');
    expect(kept?.retained).toBe(true);
    expect(kept?.suggestion.title_en ?? null).toBeNull();
    expect(await retention.isSuggestionSaved('a1')).toBe(false);
  });

  it('a later degraded keep never overwrites the full snapshot', async () => {
    serveChecks({ ask: () => pendingRow({ articleTitle: 'Row title', publicationName: 'Row Pub' }) });
    await requestFactCheck('a1', 'T', { articleId: 'a1', article: fullArticle('a1') });

    // The poll re-enters with row-derived data only.
    await requestFactCheck('a1', 'T');

    expect((await retainedAs('a1'))?.suggestion).toMatchObject({
      title_en: 'Full snapshot headline',
      publication_name: 'Full Snapshot Daily',
    });
  });

  it('a failed keep never fails the ask or degrades its outcome', async () => {
    serveChecks({ ask: () => checkRow() });
    // R23: one failing call on a real object; the real client swallows it.
    const keep = jest.spyOn(retention, 'keepArticleForFactCheck').mockRejectedValueOnce(new Error('disk full'));

    const outcome = await requestFactCheck('a1', 'T');

    expect(keep).toHaveBeenCalledTimes(1);
    expect(outcome.terminal).toBe(true);
    expect(await storedFor('a1')).toHaveLength(1);
  });
});

describe('the asked list', () => {
  it('records the first ask from this device, with the suggestion it came from', async () => {
    serveChecks({ ask: () => pendingRow() });

    await requestFactCheck('a1', 'T', { articleId: 'a1', suggestion: { _id: 's1' } as never });

    expect(await askedMap()).toEqual({
      a1: { articleId: 'a1', suggestionId: 's1', title: 'T', askedAt: expect.any(Number) },
    });
  });

  it('does not record an ask when a local row already exists (a poll is not an ask)', async () => {
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'pending', payload: null });
    serveChecks({ ask: () => pendingRow() });

    await requestFactCheck('a1', 'T');

    expect(await askedIds()).toEqual([]);
  });

  it('an explicit tap on an unfinished row nobody here asked for records the ask', async () => {
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'pending', payload: null });
    serveChecks({ ask: () => pendingRow() });

    await requestFactCheck('a1', 'T', undefined, true);

    expect((await askedMap()).a1).toMatchObject({ suggestionId: null, title: 'T' });
  });

  it('an explicit tap on a settled row records nothing: there is nothing to wait for', async () => {
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'complete', payload: null });
    serveChecks({ ask: () => checkRow() });

    await requestFactCheck('a1', 'T', undefined, true);

    expect(await askedIds()).toEqual([]);
  });

  it('never fetches through the read-only operation on an ask', async () => {
    const wire = serveChecks({ ask: () => pendingRow() });
    await requestFactCheck('a1', 'T');
    expect(opsOf(wire, REREAD_OP)).toEqual([]);
    expect(opsOf(wire, ASK_OP)).toEqual(['a1']);
  });
});

describe('requestArticleFactCheck: the tick', () => {
  const article = { articleId: 'a1', title: 'A headline' };

  it('asks the SERVER for a check on this article, as an explicit ask', async () => {
    const wire = serveChecks({ ask: () => pendingRow() });

    expect(requestArticleFactCheck(article)).toBe(true);
    await until(async () => (await askedIds()).includes('a1') && (await storedFor('a1')).length === 1);

    expect(opsOf(wire, ASK_OP)).toEqual(['a1']);
    expect((await askedMap()).a1).toMatchObject({ title: 'A headline', suggestionId: null });
  });

  it('passes the full article through as the retention snapshot', async () => {
    serveChecks({ ask: () => pendingRow({ articleTitle: 'Row title' }) });

    requestArticleFactCheck({ ...article, article: fullArticle('a1') });
    await until(async () => (await retainedAs('a1')) !== null);

    expect((await retainedAs('a1'))?.suggestion.title_en).toBe('Full snapshot headline');
  });

  it('passes the full suggestion through as the retention snapshot, and records where the ask came from', async () => {
    serveChecks({ ask: () => pendingRow() });
    const suggestion = {
      _id: 's1',
      articleId: 'a1',
      title_en: 'Suggestion headline',
      title_original: 'Suggestion headline',
      publication_name: 'Suggestion Pub',
      article_url: 'https://example.com/suggestion',
      status: 'complete',
      relevance: 0.8,
      reason: 'because',
      clusters: [],
      userTopicIds: [],
      createdAt: new Date().toISOString(),
      firstPubDate: new Date().toISOString(),
    };

    requestArticleFactCheck({ ...article, suggestion: suggestion as never });
    await until(async () => (await retainedAs('a1')) !== null);

    expect((await retainedAs('a1'))?.suggestion).toMatchObject({ title_en: 'Suggestion headline', publication_name: 'Suggestion Pub' });
    expect((await askedMap()).a1.suggestionId).toBe('s1');
  });

  it('does NOT open the chat', async () => {
    serveChecks({ ask: () => pendingRow() });

    requestArticleFactCheck(article);
    await until(async () => (await storedFor('a1')).length === 1);

    expect(useFloatingChatStore.getState().isExpanded).toBe(false);
  });

  it('fires the tap haptic once', async () => {
    serveChecks({ ask: () => pendingRow() });
    mockImpact.mockClear();

    requestArticleFactCheck(article);

    expect(mockImpact).toHaveBeenCalledTimes(1);
    await until(async () => (await storedFor('a1')).length === 1);
  });

  it('no-ops on a missing article id: no request, no haptic, no ask', async () => {
    const wire = serveChecks({ ask: () => pendingRow() });
    mockImpact.mockClear();

    expect(requestArticleFactCheck({ articleId: '', title: 'x' })).toBe(false);
    await new Promise((r) => setTimeout(r, 50));

    expect(wire).toEqual([]);
    expect(mockImpact).not.toHaveBeenCalled();
    expect(await askedIds()).toEqual([]);
  });

  it('asks regardless of entitlement, of any Mera Protocol setting, and on-device processing', async () => {
    // No server tier and no purchase: the only not-entitled state the app can be in ('locked' is
    // no longer derivable). The tick must still ask.
    useSubscriptionStore.getState().reset();
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    expect(getAiAccess()).toBe('unknown');
    expect(useMeraProtocolStore.getState().processingMode).toBe(ProcessingMode.OnDevice);
    const wire = serveChecks({ ask: () => pendingRow() });

    expect(requestArticleFactCheck(article)).toBe(true);
    await until(async () => (await storedFor('a1')).length === 1);

    expect(opsOf(wire, ASK_OP)).toEqual(['a1']);
  });
});
