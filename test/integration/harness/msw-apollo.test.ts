// Spike S1: the real Apollo client (real link chain, real error link) talks to MSW.
import { gql } from '@apollo/client';
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import client from '@/lib/apollo-client';
import { AppVersionService } from '@/lib/app-version-service';
import { ArticleService } from '@/lib/article-service';
import { HeadlineScope } from '@/lib/generated/graphql-types';
import { fixture, mockGqlError, server } from '@/test/helpers';
import { unhandled } from '@/test/helpers/msw';

describe('MSW behind the real Apollo client', () => {
  it('answers the app\'s own AppVersionInfo document', async () => {
    expect(await AppVersionService.getVersionInfo()).toEqual({
      __typename: 'AppVersionInfo',
      minSupportedVersion: '0.0.0',
      storeUrl: 'https://example.com/store/mera',
    });
  });

  it('answers a feed operation through ArticleService with the fixture ids', async () => {
    const result = await ArticleService.getArticleIdsForPersona({
      topics: [{ text: 'bridges' }, { text: 'trams' }],
      topHeadlines: {
        scopes: [{ scope: HeadlineScope.Country, countryCode: 'NLD' }, { scope: HeadlineScope.Global }],
      },
    });
    const ids = [...result.topicResults, ...result.headlineResults].flatMap((r) => r.articleIds);
    const expected = fixture('articles').articles.map((a) => a.id);
    expect([...ids].sort()).toEqual([...expected].sort());
    // Topic matches come first.
    expect(ids.slice(0, 6)).toEqual(expect.arrayContaining(expected.slice(0, 6)));
  });

  it('surfaces a GraphQL error the way the error link passes it on', async () => {
    server.use(mockGqlError('AppVersionInfo', 'UNAUTHENTICATED'));
    const err = await AppVersionService.getVersionInfo().then(
      () => null,
      (e: unknown) => e,
    );
    expect(CombinedGraphQLErrors.is(err)).toBe(true);
    expect((err as CombinedGraphQLErrors).errors[0].extensions).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('fires the unhandled guard for an operation with no handler (negative control)', async () => {
    const NO_HANDLER = gql`
      query NoSuchOperationForGuard {
        recentArticleCount
      }
    `;
    await expect(client.query({ query: NO_HANDLER, fetchPolicy: 'no-cache' })).rejects.toBeDefined();
    // The setup's afterEach would fail this test on a non-empty list; clear it here.
    expect(unhandled.length).toBeGreaterThan(0);
    expect(unhandled.every((u) => u === 'POST http://127.0.0.1:8790/graphql')).toBe(true);
    unhandled.splice(0);
  });
});
