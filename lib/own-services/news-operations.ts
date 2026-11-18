// Where each GraphQL operation may go. The client owns the lists (its pod passes news through with
// the same ones); only the account documents that live in the app are named here.
import {
    ACCOUNT_OPERATION_NAMES,
    HOST_NEWS_OPERATION_NAMES,
    isNewsOperation,
    MERA_SERVICE_OPERATION_NAMES,
    NEWS_OPERATION_NAMES,
} from '@/lib/graphql/news-operations';

export { isNewsOperation };

/** Account documents in the app itself (billing, plans, support, consent): always Mera. */
const APP_ACCOUNT_OPERATION_NAMES = [
    'AppVersionInfo',
    'GetIntercomIdentity',
    'GetPlanPromo',
    'GetUserBilling',
    'GetUserBillingLapseState',
    'GetUserReading',
    'LegalConsentAppConfig',
];

/** Operations that stay on Mera whatever the news mode is: accounts, billing, push, feedback. */
export const ACCOUNT_OPERATIONS: ReadonlySet<string> = new Set([...ACCOUNT_OPERATION_NAMES, ...APP_ACCOUNT_OPERATION_NAMES]);

/** Only Mera serves these, and they refer to articles Mera's server may not have: while own news is on they go nowhere. */
export const MERA_ONLY_OPERATIONS: ReadonlySet<string> = new Set(MERA_SERVICE_OPERATION_NAMES);

/** Operations that go to the person's own news server while that mode is on. */
export const NEWS_OPERATIONS: ReadonlySet<string> = new Set([...NEWS_OPERATION_NAMES, ...HOST_NEWS_OPERATION_NAMES]);

export type FeatureKey =
    | 'search'
    | 'worldHeadlines'
    | 'relatedArticles'
    | 'storyUpdates'
    | 'publicationPages'
    | 'placeSearch'
    | 'factChecks'
    | 'storyGrouping'
    | 'publicationNames';

/** The news operations an own server can lack, by the feature a reader loses without them. */
export const FEATURE_OF: Readonly<Record<string, FeatureKey>> = {
    SearchNews: 'search',
    SearchPublishers: 'search',
    GetWorldHeadlines: 'worldHeadlines',
    GetCanonicalTopics: 'worldHeadlines',
    GetTopHeadlinesForCountryWindowed: 'worldHeadlines',
    GetRelatedArticlesPage: 'relatedArticles',
    GetRelatedArticlesPageFiltered: 'relatedArticles',
    GetRelatedArticlesPageLegacy: 'relatedArticles',
    GetArticlesForStories: 'storyUpdates',
    GetArticlesForStoriesLegacy: 'storyUpdates',
    PublicationProfile: 'publicationPages',
    GetArticlesForPublisher: 'publicationPages',
    PublicationSourcesForNewsPublisher: 'publicationPages',
    PlaceSearch: 'placeSearch',
    GetFactCheck: 'factChecks',
    GetFactCheckLegacy: 'factChecks',
    GetCachedFactCheck: 'factChecks',
    GetCachedFactCheckLegacy: 'factChecks',
    ClusterMembershipsForArticles: 'storyGrouping',
    GetNewsClusterForArticle: 'storyGrouping',
    PublicationDisplayNames: 'publicationNames',
};

/** The `Query` root field each FEATURE_OF operation selects, as introspection lists it. */
export const ROOT_FIELD_OF: Readonly<Record<string, string>> = {
    SearchNews: 'searchNews',
    SearchPublishers: 'searchPublishers',
    GetWorldHeadlines: 'worldHeadlines',
    GetCanonicalTopics: 'canonicalTopics',
    GetTopHeadlinesForCountryWindowed: 'topHeadlinesForCountry',
    GetRelatedArticlesPage: 'relatedArticlesPage',
    GetRelatedArticlesPageFiltered: 'relatedArticlesPage',
    GetRelatedArticlesPageLegacy: 'relatedArticlesPage',
    GetArticlesForStories: 'articlesForStories',
    GetArticlesForStoriesLegacy: 'articlesForStories',
    PublicationProfile: 'publicationProfile',
    GetArticlesForPublisher: 'articlesForPublisher',
    PublicationSourcesForNewsPublisher: 'publicationSourcesForNewsPublisher',
    PlaceSearch: 'placeSearch',
    GetFactCheck: 'factCheck',
    GetFactCheckLegacy: 'factCheck',
    GetCachedFactCheck: 'cachedFactCheck',
    GetCachedFactCheckLegacy: 'cachedFactCheck',
    ClusterMembershipsForArticles: 'clusterMembershipsForArticles',
    GetNewsClusterForArticle: 'newsClusterForArticle',
    PublicationDisplayNames: 'publicationDisplayNames',
};

/**
 * Features the server lacks: those whose every operation's root field is absent from `fields`, or
 * whose operations are latched this session. Null when the server would not say and nothing is latched.
 */
export function missingFeatures(fields: string[] | null, latched: ReadonlySet<string>): FeatureKey[] | null {
    if (fields === null && latched.size === 0) return null;
    const have = fields ? new Set(fields) : null;
    const ops = Object.keys(FEATURE_OF);
    const features = [...new Set(Object.values(FEATURE_OF))];
    return features.filter((f) => {
        const own = ops.filter((o) => FEATURE_OF[o] === f);
        return own.every((o) => latched.has(o) || (have !== null && !have.has(ROOT_FIELD_OF[o])));
    });
}
