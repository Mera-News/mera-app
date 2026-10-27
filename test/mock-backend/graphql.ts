// Default GraphQL handlers: one per operation the app sends, answering from the
// synthetic fixtures in ./fixtures. `GQL_OPERATIONS` is the inventory the
// gql-coverage contract test compares against the app's own documents.
//
// Handlers are stateless: a mutation echoes success but does not change what the
// next query returns. A test that needs state overrides the pair with `mockGql`.
//
// Scenario (see ./scenario) is read at resolve time:
//   tier                billing ops report it ('none' = unentitled, 'starter' = 250/day)
//   readingUsed         billing's readingUsed (0..1, null = meter not visible); planMultiplier follows tier
//   articles: 'empty'   every id op and article list answers empty
//   imageOrigin         origin of the fixture image URLs (default: the request's own)
//   paywall             after a scripted purchase, billing ops report `upgradeTo` (billingTier)
//   failOperation       that one operation answers with a GraphQL error instead of data
//
// A transport failure has no helper: `http.post('*/graphql', () => HttpResponse.error())`.
import { graphql, HttpResponse, type RequestHandler } from 'msw';
import type { HeadlineScope, Mutation, Query } from '@/lib/generated/graphql-types';
import {
    ARTICLE_IDS,
    COUNTRY_HEADLINE_IDS,
    GLOBAL_HEADLINE_IDS,
    TOPIC_ARTICLE_IDS,
    articleById,
    articleFixtures,
    articleSummary,
    articleWithClusters,
    articlesByIds,
    articlesForCountry,
    newsArticle,
    newsCluster,
    pageOf,
    publicationSource,
    stableClusterId,
    type BuildContext,
    type FixtureArticle,
} from './fixtures/articles';
import { FIXTURE_ACCOUNT } from './fixtures/account';
import { appConfig, appVersionInfo } from './fixtures/graphql/appConfig';
import { billingFor } from './fixtures/graphql/billing';
import { factCheckFor } from './fixtures/graphql/factCheck';
import { feedbackRequests } from './fixtures/graphql/feedback';
import { personaFor, unblockRequestFor } from './fixtures/graphql/persona';
import { countries, places } from './fixtures/graphql/places';
import {
    displayNamesFor,
    newsPublisher,
    publicationProfileFor,
    publisherSearchHit,
} from './fixtures/graphql/publications';
import { searchHits } from './fixtures/graphql/search';
import { billingTier, getScenario, type Scenario } from './scenario';

type Vars = Record<string, any>;

interface Ctx extends BuildContext {
    variables: Vars;
    scenario: Scenario;
}

interface Op {
    kind: 'query' | 'mutation';
    name: string;
    resolve: (ctx: Ctx) => unknown;
}

const ops: Op[] = [];
const query = <K extends keyof Query>(name: string, resolve: (ctx: Ctx) => Pick<Query, K>) => {
    ops.push({ kind: 'query', name, resolve });
};
const mutation = <K extends keyof Mutation>(name: string, resolve: (ctx: Ctx) => Pick<Mutation, K>) => {
    ops.push({ kind: 'mutation', name, resolve });
};

const { publications, articles } = articleFixtures;
const isEmpty = (c: Ctx): boolean => c.scenario.articles === 'empty';
const iso = (ms: number): string => new Date(ms).toISOString();
const clusterSize = (a: FixtureArticle): number => articles.filter((x) => x.clusterIndex === a.clusterIndex).length;
/** One article per story: what a deduplicated headline edition lists. */
const storyLeaders = (list: readonly FixtureArticle[]): FixtureArticle[] =>
    list.filter((a, i) => list.findIndex((x) => x.clusterIndex === a.clusterIndex) === i);

// ---- feed ids and hydration ---------------------------------------------------------

// Persona ids: topic matches first (spread over the requested topics), then each
// requested headline scope. The app inserts in that order and the server clips a
// capped response in request order, so topics must stay ahead of headlines.
query<'articleIdsForPersona'>('GetArticleIdsForPersona', (c) => {
    const input = c.variables.query ?? {};
    const topics: { text: string }[] = input.topics ?? [];
    const scopes: { scope: string; countryCode?: string | null; limit?: number | null }[] =
        input.topHeadlines?.scopes ?? [];
    const empty = isEmpty(c);
    return {
        articleIdsForPersona: {
            __typename: 'PersonaQueryResult',
            topicResults: topics.map((t, ti) => {
                const ids = empty ? [] : TOPIC_ARTICLE_IDS.filter((_, i) => i % topics.length === ti);
                return {
                    __typename: 'PersonaTopicResult' as const,
                    topicText: t.text,
                    articleIds: ids,
                    matchMeta: ids.map((id) => ({
                        __typename: 'PersonaMatchMeta' as const,
                        articleId: id,
                        vectorScore: 0.8,
                        textScore: null,
                        stableClusterId: stableClusterId(articleById(id)!),
                    })),
                    nextCursor: null,
                    hasNextPage: false,
                };
            }),
            headlineResults: scopes.map((s) => {
                const pool = s.scope === 'COUNTRY' ? COUNTRY_HEADLINE_IDS : GLOBAL_HEADLINE_IDS;
                const ids = empty ? [] : pool.slice(0, s.limit && s.limit > 0 ? s.limit : undefined);
                return {
                    __typename: 'HeadlineScopeResult' as const,
                    scope: s.scope as HeadlineScope,
                    countryCode: s.scope === 'COUNTRY' ? (s.countryCode ?? null) : null,
                    articleIds: [...ids],
                    clusterSizes: ids.map((id) => clusterSize(articleById(id)!)),
                    stableClusterIds: ids.map((id) => stableClusterId(articleById(id)!)),
                };
            }),
        },
    };
});

query<'articleIdsForTopics'>('GetArticleIdsForTopics', (c) => {
    const topics: { topicText: string }[] = c.variables.topics ?? [];
    return {
        articleIdsForTopics: {
            __typename: 'ArticleIdsForTopicsResponse',
            results: topics.map((t, ti) => ({
                __typename: 'TopicArticleIdsResult' as const,
                topicText: t.topicText,
                articleIds: isEmpty(c) ? [] : ARTICLE_IDS.filter((_, i) => i % topics.length === ti),
                hasNextPage: false,
                nextCursor: null,
            })),
        },
    };
});

// Never truncates: every requested article that exists is delivered.
query<'articlesForTopicsByIds'>('GetArticlesForTopicsByIds', (c) => ({
    articlesForTopicsByIds: {
        __typename: 'ArticlesForTopicsByIdsResponse',
        articles: isEmpty(c) ? [] : articlesByIds(c.variables.articleIds).map((a) => articleWithClusters(a, c)),
        dailyLimitReached: false,
        resetAt: null,
    },
}));

// Quota-exempt sibling: never capped.
query<'articlesForStories'>('GetArticlesForStories', (c) => ({
    articlesForStories: {
        __typename: 'ArticlesForTopicsByIdsResponse',
        articles: isEmpty(c) ? [] : articlesByIds(c.variables.articleIds).map((a) => articleWithClusters(a, c)),
        dailyLimitReached: false,
    },
}));

// Pre-story_key documents, sent only after a server answered GRAPHQL_VALIDATION_FAILED.
query<'articlesForTopicsByIds'>('GetArticlesForTopicsByIdsLegacy', (c) => ({
    articlesForTopicsByIds: {
        __typename: 'ArticlesForTopicsByIdsResponse',
        articles: isEmpty(c) ? [] : articlesByIds(c.variables.articleIds).map((a) => articleWithClusters(a, c)),
        dailyLimitReached: false,
        resetAt: null,
    },
}));
query<'articlesForStories'>('GetArticlesForStoriesLegacy', (c) => ({
    articlesForStories: {
        __typename: 'ArticlesForTopicsByIdsResponse',
        articles: isEmpty(c) ? [] : articlesByIds(c.variables.articleIds).map((a) => articleWithClusters(a, c)),
        dailyLimitReached: false,
    },
}));

query<'articleById'>('GetArticleById', (c) => {
    const a = articleById(c.variables.id);
    return { articleById: a ? newsArticle(a, c) : null };
});

query<'recentArticleCount'>('GetRecentArticleCount', (c) => ({
    recentArticleCount: isEmpty(c) ? 0 : articles.length,
}));

// ---- article lists ------------------------------------------------------------------

const articlePage = (c: Ctx, list: readonly FixtureArticle[]) => {
    const page = pageOf(isEmpty(c) ? [] : list, c.variables.first, c.variables.after);
    return {
        __typename: 'ArticlesForPublicationSourceResponse' as const,
        articles: page.items.map((a) => newsArticle(a, c)),
        pageInfo: page.pageInfo,
    };
};

query<'articlesForCountry'>('GetArticlesForCountry', (c) => ({
    articlesForCountry: articlePage(c, articlesForCountry(c.variables.countryCode)),
}));

const headlinesPage = (c: Ctx) => {
    const leaders = storyLeaders(articlesForCountry(c.variables.countryCode));
    const page = pageOf(isEmpty(c) ? [] : leaders, c.variables.first, c.variables.after);
    return {
        topHeadlinesForCountry: {
            __typename: 'TopHeadlinesForCountryResponse' as const,
            articles: page.items.map((a) => newsArticle(a, c)),
            headlines: page.items.map((a) => ({
                __typename: 'TopHeadline' as const,
                stableClusterId: stableClusterId(a),
                clusterSize: clusterSize(a),
                article: newsArticle(a, c),
            })),
            pageInfo: page.pageInfo,
            editionBuiltAt: iso(c.now - 30 * 60_000),
        },
    };
};
query<'topHeadlinesForCountry'>('GetTopHeadlinesForCountry', headlinesPage);
query<'topHeadlinesForCountry'>('GetTopHeadlinesForCountryWindowed', headlinesPage);

// The publisher's own articles (three per fixture outlet), newest first unless the
// caller asks for TOP_HEADLINES, which ranks by story size.
const publisherPage = (c: Ctx) => {
    const own = articles.filter((a) => publications[a.publicationIndex].publisherId === c.variables.newsPublisherId);
    const ordered =
        c.variables.order === 'TOP_HEADLINES' ? [...own].sort((a, b) => clusterSize(b) - clusterSize(a)) : own;
    return { articlesForPublisher: articlePage(c, ordered) };
};
query<'articlesForPublisher'>('GetArticlesForPublisher', publisherPage);
query<'articlesForPublisher'>('GetArticlesForPublisherNoOrder', publisherPage);

// ---- clusters -----------------------------------------------------------------------

const clustersPage = (c: Ctx, list: readonly FixtureArticle[]) => {
    const page = pageOf(isEmpty(c) ? [] : storyLeaders(list), c.variables.first, c.variables.after);
    return {
        __typename: 'NewsClustersResponse' as const,
        newsClusters: page.items.map((a) => newsCluster(a, c, 1)),
        pageInfo: page.pageInfo,
    };
};
query<'newsClusters'>('GetNewsClusters', (c) => {
    const codes: string[] | null = c.variables.countryCodes ?? null;
    const list =
        codes && codes.length > 0 && !codes.includes('GLOBAL')
            ? articles.filter((a) => codes.includes(publications[a.publicationIndex].countryCode))
            : articles;
    return { newsClusters: clustersPage(c, list) };
});
query<'newsClustersForTopicText'>('GetNewsClustersForTopicText', (c) => ({
    newsClustersForTopicText: clustersPage(c, articles),
}));
query<'newsClusterForArticle'>('GetNewsClusterForArticle', (c) => {
    const a = articleById(c.variables.articleId);
    return { newsClusterForArticle: a ? newsCluster(a, c, c.variables.first ?? 10) : null };
});

// ---- related articles ---------------------------------------------------------------

const relatedPage = (c: Ctx) => {
    const exclude = new Set<string>([c.variables.articleId, ...(c.variables.excludeIds ?? [])]);
    const list = articles.filter((a) => !exclude.has(a.id));
    const page = pageOf(isEmpty(c) ? [] : list, c.variables.first, c.variables.after);
    const count = (codes: string[]) =>
        [...new Set(codes)].map((code) => ({
            __typename: 'RelatedFacetCount' as const,
            code,
            count: codes.filter((x) => x === code).length,
        }));
    return {
        relatedArticlesPage: {
            __typename: 'RelatedArticlesPage' as const,
            articles: page.items.map((a) => articleSummary(a, c)),
            pageInfo: page.pageInfo,
            restarted: page.restarted,
            facets: {
                __typename: 'RelatedArticleFacets' as const,
                countries: count(list.map((a) => publications[a.publicationIndex].countryCode)),
                languages: count(list.map(() => 'en')),
            },
        },
    };
};
query<'relatedArticlesPage'>('GetRelatedArticlesPage', relatedPage);
query<'relatedArticlesPage'>('GetRelatedArticlesPageLegacy', relatedPage);
query<'relatedArticlesPage'>('GetRelatedArticlesPageFiltered', relatedPage);

// ---- publishers, publications, search ------------------------------------------------

const publicationIndexes = publications.map((_, i) => i);

query<'newsPublishers'>('GetNewsPublishers', (c) => {
    const code: string | null = c.variables.countryCode ?? null;
    const idx = publicationIndexes.filter(
        (i) => !code || code === 'GLOBAL' || publications[i].countryCode === code,
    );
    const page = pageOf(idx, c.variables.first, c.variables.after);
    return {
        newsPublishers: {
            __typename: 'NewsPublishersResponse',
            newsPublishers: page.items.map((i) => newsPublisher(i, c)),
            pageInfo: page.pageInfo,
        },
    };
});

query<'searchPublishers'>('SearchPublishers', (c) => {
    const q = String(c.variables.query ?? '').toLowerCase();
    const idx = publicationIndexes.filter((i) => publications[i].name.toLowerCase().includes(q));
    const page = pageOf(idx, c.variables.first, c.variables.after);
    return {
        searchPublishers: {
            __typename: 'SearchPublishersResponse',
            publishers: page.items.map((i) => publisherSearchHit(i, c)),
            pageInfo: page.pageInfo,
        },
    };
});

query<'publicationSourcesForNewsPublisher'>('PublicationSourcesForNewsPublisher', (c) => ({
    publicationSourcesForNewsPublisher: {
        __typename: 'PublicationSourcesForPublisherResponse',
        publicationSources: publications
            .filter((p) => p.publisherId === c.variables.publisherId)
            .map((p) => publicationSource(p, c)),
    },
}));

query<'publicationProfile'>('PublicationProfile', (c) => ({
    publicationProfile: publicationProfileFor(c.variables),
}));
query<'publicationDisplayNames'>('PublicationDisplayNames', (c) => ({
    publicationDisplayNames: displayNamesFor(c.variables.names ?? []),
}));

query<'searchNews'>('SearchNews', (c) => ({
    searchNews: isEmpty(c) ? [] : searchHits(c, c.variables.limit),
}));
query<'placeSearch'>('PlaceSearch', () => ({ placeSearch: places }));
query<'allCountries'>('AllCountries', () => ({ allCountries: countries }));

// ---- fact check ---------------------------------------------------------------------

query<'factCheck'>('GetFactCheck', (c) => ({
    factCheck: factCheckFor(c.variables.articleId ?? ARTICLE_IDS[0], c.now),
}));
query<'cachedFactCheck'>('GetCachedFactCheck', (c) => ({
    cachedFactCheck: factCheckFor(c.variables.articleId ?? ARTICLE_IDS[0], c.now),
}));
// The legacy documents (no recheckAvailableAt) answer the same row; the client
// only sends them after a server rejects the field.
query<'factCheck'>('GetFactCheckLegacy', (c) => ({
    factCheck: factCheckFor(c.variables.articleId ?? ARTICLE_IDS[0], c.now),
}));
query<'cachedFactCheck'>('GetCachedFactCheckLegacy', (c) => ({
    cachedFactCheck: factCheckFor(c.variables.articleId ?? ARTICLE_IDS[0], c.now),
}));
// "Fact check again" on the fixture's minute-old check: within the day, so the
// server answers it unchanged with recheckAvailableAt still ahead.
mutation<'requestFactCheck'>('RequestFactCheckAgain', (c) => ({
    requestFactCheck: factCheckFor(c.variables.articleId ?? ARTICLE_IDS[0], c.now),
}));

// ---- account, billing, config -------------------------------------------------------

const billing = (c: Ctx) =>
    billingFor(billingTier(c.scenario, c.now), c.now, { readingUsed: c.scenario.readingUsed });
query<'userBilling'>('GetUserBilling', (c) => ({ userBilling: billing(c) }));
query<'userBilling'>('GetUserBillingLapseState', (c) => ({ userBilling: billing(c) }));
query<'userBilling'>('GetUserReading', (c) => ({ userBilling: billing(c) }));

query<'appConfig'>('LegalConsentAppConfig', () => ({ appConfig }));
query<'appVersionInfo'>('AppVersionInfo', () => ({ appVersionInfo }));
query<'activeFeedbackRequests'>('ActiveFeedbackRequests', () => ({ activeFeedbackRequests: feedbackRequests }));
// null = "unseeded": the app keeps its bundled tree.
query<'feedbackTree'>('FeedbackTree', () => ({ feedbackTree: null }));
query<'intercomIdentity'>('GetIntercomIdentity', (c) => ({
    intercomIdentity: { __typename: 'IntercomIdentity', jwt: 'fixture.intercom.jwt', expiresAt: iso(c.now + 3_600_000) },
}));

query<'userPersonaByUserId'>('GetUserPersona', (c) => ({
    userPersonaByUserId: personaFor(c.now, { userId: c.variables.userId ?? FIXTURE_ACCOUNT.userId }),
}));
query<'unblockRequestStatus'>('UnblockRequestStatus', () => ({ unblockRequestStatus: null }));

const echoPersona = (c: Ctx, overrides: Parameters<typeof personaFor>[1]) =>
    personaFor(c.now, {
        userId: c.variables.userId ?? c.variables.input?.userId ?? FIXTURE_ACCOUNT.userId,
        ...overrides,
    });

mutation<'updateNotificationWindow'>('UpdateNotificationWindow', (c) => ({
    updateNotificationWindow: echoPersona(c, {
        preferredNotificationWindow: c.variables.input.preferredNotificationWindow,
    }),
}));
mutation<'updateExpoPushToken'>('UpdateExpoPushToken', (c) => ({
    updateExpoPushToken: echoPersona(c, { expoPushToken: c.variables.input.expoPushToken }),
}));
mutation<'deleteExpoPushToken'>('DeleteExpoPushToken', (c) => ({
    deleteExpoPushToken: echoPersona(c, { expoPushToken: null }),
}));
mutation<'advanceOnboardingStage'>('AdvanceOnboardingStage', (c) => ({
    advanceOnboardingStage: echoPersona(c, { onboardingStage: c.variables.stage }),
}));
mutation<'updateNotificationsEnabled'>('UpdateNotificationsEnabled', (c) => ({
    updateNotificationsEnabled: echoPersona(c, { notificationsEnabled: c.variables.input.enabled }),
}));
mutation<'updateProcessingMode'>('UpdateProcessingMode', (c) => ({
    updateProcessingMode: echoPersona(c, { processingMode: c.variables.input.mode }),
}));
mutation<'updateUserConfig'>('UpdateUserConfig', (c) => ({
    updateUserConfig: echoPersona(c, { language_codes: c.variables.input.language_codes ?? ['en'] }),
}));
mutation<'issueLlmWarning'>('IssueLlmWarning', (c) => ({
    issueLlmWarning: echoPersona(c, { llmWarningCount: 1 }),
}));
mutation<'requestUnblock'>('RequestUnblock', (c) => ({
    requestUnblock: unblockRequestFor(c.now, c.variables.input.feedback),
}));
mutation<'submitFeedbackResponse'>('SubmitFeedbackResponse', () => ({
    submitFeedbackResponse: { __typename: 'SubmitFeedbackResponseResult', ok: true, alreadyAnswered: false },
}));

// ---- export -------------------------------------------------------------------------

const toHandler = (op: Op): RequestHandler =>
    (op.kind === 'query' ? graphql.query : graphql.mutation)(op.name, ({ request, variables }) => {
        const scenario = getScenario();
        if (scenario.failOperation === op.name) {
            return HttpResponse.json({
                errors: [{ message: `E2E mock: ${op.name} failed (scenario failOperation)`, extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
            });
        }
        const origin = scenario.imageOrigin ?? new URL(request.url).origin;
        return HttpResponse.json({
            data: op.resolve({ origin, now: Date.now(), variables, scenario }) as Record<string, unknown>,
        });
    });

export const graphqlHandlers: RequestHandler[] = ops.map(toHandler);

/** Every operation name with a default handler. */
export const GQL_OPERATIONS: readonly string[] = ops.map((o) => o.name);
