// Becomes a re-export once the client exports its news list (the pod's passthrough uses the same list).

/** Operations that stay on Mera whatever the news mode is: accounts, billing, push, feedback. */
export const ACCOUNT_OPERATIONS: ReadonlySet<string> = new Set([
    'AdvanceOnboardingStage',
    'DeleteExpoPushToken',
    'UpdateExpoPushToken',
    'IssueLlmWarning',
    'RequestUnblock',
    'UnblockRequestStatus',
    'SubmitFeedbackResponse',
    'ActiveFeedbackRequests',
    'FeedbackTree',
    'UpdateNotificationWindow',
    'UpdateNotificationsEnabled',
    'UpdateProcessingMode',
    'UpdateUserConfig',
    'AppVersionInfo',
    'GetIntercomIdentity',
    'GetPlanPromo',
    'GetReadingPlans',
    'GetUserBilling',
    'GetUserBillingLapseState',
    'GetUserPersona',
    'GetUserReading',
    'LegalConsentAppConfig',
]);

/** Only Mera serves these, and they refer to articles Mera's server may not have: while own news is on they go nowhere. */
export const MERA_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
    'GetFactCheck',
    'GetFactCheckLegacy',
    'GetCachedFactCheck',
    'GetCachedFactCheckLegacy',
    'RequestFactCheckAgain',
]);

/** Operations that go to the person's own news server while that mode is on. */
export const NEWS_OPERATIONS: ReadonlySet<string> = new Set([
    'AllCountries',
    'ClusterMembershipsForArticles',
    'GetArticleById',
    'GetArticleIdsForPersona',
    'GetArticleIdsForTopics',
    'GetArticlesForCountry',
    'GetArticlesForPublisher',
    'GetArticlesForPublisherNoOrder',
    'GetArticlesForStories',
    'GetArticlesForStoriesLegacy',
    'GetArticlesForTopicsByIds',
    'GetArticlesForTopicsByIdsLegacy',
    'GetCanonicalTopics',
    'GetNewsClusterForArticle',
    'GetNewsClusters',
    'GetNewsClustersForTopicText',
    'GetNewsPublishers',
    'GetRecentArticleCount',
    'GetRelatedArticlesPage',
    'GetRelatedArticlesPageFiltered',
    'GetRelatedArticlesPageLegacy',
    'GetTopHeadlinesForCountry',
    'GetTopHeadlinesForCountryWindowed',
    'GetWorldHeadlines',
    'PlaceSearch',
    'PublicationDisplayNames',
    'PublicationProfile',
    'PublicationSourcesForNewsPublisher',
    'SearchNews',
    'SearchPublishers',
]);

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
