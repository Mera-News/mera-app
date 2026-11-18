// The `t` keys of the own-service pages, by status, address problem and feature. Typed literals, so
// `t()` stays checked against the dictionary.
import type { AiCheckStatus } from '@/lib/own-services/own-ai-state';
import type { NewsCheckStatus } from '@/lib/own-services/own-news-state';
import type { FeatureKey } from '@/lib/own-services/news-operations';

export const AI_STATUS_KEY = {
    connected: 'ownServices.status.connected',
    refused: 'ownServices.ai.status.refused',
    unreachable: 'ownServices.status.unreachable',
    'not-openai': 'ownServices.ai.status.notOpenai',
    'no-model': 'ownServices.ai.status.noModel',
    redirect: 'ownServices.status.redirect',
    busy: 'ownServices.ai.status.busy',
    failing: 'ownServices.ai.status.failing',
} as const satisfies Record<AiCheckStatus, string>;

export const NEWS_STATUS_KEY = {
    connected: 'ownServices.status.connected',
    refused: 'ownServices.news.status.refused',
    unreachable: 'ownServices.status.unreachable',
    'no-feed': 'ownServices.news.status.noFeed',
    redirect: 'ownServices.status.redirect',
} as const satisfies Record<NewsCheckStatus, string>;

export const ADDRESS_ERROR_KEY = {
    'not-https': 'ownServices.address.notHttps',
    userinfo: 'ownServices.address.userinfo',
    invalid: 'ownServices.address.invalid',
} as const;

/** The line under the code field for each way a pairing is refused. */
export const POD_CODE_ERROR_KEY = {
    wrong_code: 'ownServices.pod.codeWrong',
    pairing_closed: 'ownServices.pod.codeExpired',
    too_many_tries: 'ownServices.pod.codeTooMany',
    already_paired: 'ownServices.pod.alreadyPairedElsewhere',
    'phone-old': 'ownServices.pod.codePhoneOld',
    'server-old': 'ownServices.pod.status.serverOld',
} as const;

/** The paired page's one status line, by health. A healthy server says nothing. */
export const POD_HEALTH_KEY = {
    unreachable: 'ownServices.pod.status.unreachable',
    refused: 'ownServices.pod.status.refused',
    'phone-old': 'ownServices.pod.status.phoneOld',
    'server-old': 'ownServices.pod.status.serverOld',
} as const;

export const FEATURE_KEY = {
    search: 'ownServices.feature.search',
    worldHeadlines: 'ownServices.feature.worldHeadlines',
    relatedArticles: 'ownServices.feature.relatedArticles',
    storyUpdates: 'ownServices.feature.storyUpdates',
    publicationPages: 'ownServices.feature.publicationPages',
    placeSearch: 'ownServices.feature.placeSearch',
    factChecks: 'ownServices.feature.factChecks',
    storyGrouping: 'ownServices.feature.storyGrouping',
    publicationNames: 'ownServices.feature.publicationNames',
} as const satisfies Record<FeatureKey, string>;

const YOU = '/logged-in/app_container/you';
export const OWN_ROUTES = {
    ai: `${YOU}/own-ai`,
    aiChanges: `${YOU}/own-ai-changes`,
    news: `${YOU}/own-news`,
    pod: `${YOU}/own-pod`,
    podPair: `${YOU}/own-pod-pair`,
    podCode: `${YOU}/own-pod-code`,
    newsMissing: `${YOU}/own-news-missing`,
    // The link opens Mera Protocol with its On this phone control focused.
    onDevice: `${YOU}/mera-protocol?focus=on-device`,
    plans: '/logged-in/preferences/manage-subscription',
} as const;

/** The page each "isn't answering" line opens. */
export const SERVICE_ROUTE = { pod: OWN_ROUTES.pod, ai: OWN_ROUTES.ai, news: OWN_ROUTES.news } as const;
