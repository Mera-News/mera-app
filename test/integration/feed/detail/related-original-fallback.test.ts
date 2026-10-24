// The related page asks for ArticleSummary.title_original; a server that predates the field
// rejects the whole document, so the app falls back to the legacy document, quietly, and
// remembers for the session. Real Apollo client against MSW.
import ArticleService, { __resetRelatedOriginalSupport } from '@/lib/article-service';
import { mockGql, mockGqlError, server } from '@/test/helpers';
import { recordOps, resetServiceState, sentOf, spyLogger } from '../../data/apollo/article-service/kit';

const page = {
    __typename: 'RelatedArticlesPage',
    articles: [],
    pageInfo: { __typename: 'PageInfo', endCursor: null, hasNextPage: false, pageSize: 0 },
    restarted: false,
};
const opNames = async (sent: ReturnType<typeof recordOps>) => (await sentOf(sent)).map((s) => s.op);

beforeEach(() => {
    resetServiceState();
    __resetRelatedOriginalSupport();
});

it('asks for title_original with the default document', async () => {
    const sent = recordOps();
    await ArticleService.getRelatedArticlesPage({ articleId: 'art-1' });
    const [call] = await sentOf(sent);
    expect(call.op).toBe('GetRelatedArticlesPage');
    expect(call.query).toMatch(/title_original/);
});

it('on GRAPHQL_VALIDATION_FAILED asks the legacy document, quietly, and remembers for the session', async () => {
    server.use(mockGqlError('GetRelatedArticlesPage', 'GRAPHQL_VALIDATION_FAILED', { message: 'Cannot query field' }));
    server.use(mockGql('GetRelatedArticlesPageLegacy', { relatedArticlesPage: page }));
    const sent = recordOps();
    const logs = spyLogger();

    const first = await ArticleService.getRelatedArticlesPage({ articleId: 'art-1' });
    expect(first).toEqual({ ...page, facets: null });
    expect(await opNames(sent)).toEqual(['GetRelatedArticlesPage', 'GetRelatedArticlesPageLegacy']);
    const legacy = (await sentOf(sent, 'GetRelatedArticlesPageLegacy'))[0];
    expect(legacy.query).not.toMatch(/title_original/);
    expect(logs.capture).not.toHaveBeenCalled();
    expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('legacy related document this session'));

    await ArticleService.getRelatedArticlesPage({ articleId: 'art-2' });
    expect(await opNames(sent)).toEqual([
        'GetRelatedArticlesPage',
        'GetRelatedArticlesPageLegacy',
        'GetRelatedArticlesPageLegacy',
    ]);
});

it('any other error is not a fallback: it surfaces', async () => {
    server.use(mockGqlError('GetRelatedArticlesPage', 'INTERNAL_SERVER_ERROR', { message: 'boom' }));
    const logs = spyLogger();
    await expect(ArticleService.getRelatedArticlesPage({ articleId: 'art-1' })).rejects.toBeTruthy();
    expect(logs.info).not.toHaveBeenCalledWith(expect.stringContaining('legacy related document'));
});
