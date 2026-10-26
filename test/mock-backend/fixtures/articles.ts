// Synthetic article set for the mock backend. Plain data (structuredClone-safe) plus
// builders that turn it into the generated GraphQL shapes at resolve time, so
// `publishedAt` is always "a few hours ago" whatever the clock says.
// Nothing here is real: invented outlets, invented towns, example.com links.
import type {
    ArticleSummary,
    ArticleWithClusters,
    CursorPageInfo,
    NewsArticle,
    NewsCluster,
    PublicationSource,
} from '@/lib/generated/graphql-types';

export interface FixturePublication {
    id: string;
    publisherId: string;
    name: string;
    url: string;
    /** ISO alpha-3, or GLOBAL for international outlets. */
    countryCode: 'NLD' | 'GLOBAL';
    countryName: string | null;
    category: string;
}

export interface FixtureArticle {
    id: string;
    title: string;
    description: string;
    url: string;
    publicationIndex: number;
    clusterIndex: number;
    minutesAgo: number;
    imageIndex: number;
    category: string;
    eventType: string;
    entities: string[];
    city: string | null;
    region: string | null;
}

export interface FixtureArticleSet {
    publications: FixturePublication[];
    articles: FixtureArticle[];
}

/** 24-hex ids: a prefix letter then the number, zero padded. */
const hex24 = (prefix: string, n: number): string => prefix + String(n).padStart(23, '0');

const publications: FixturePublication[] = [
    { name: 'Fixtureville Courier', countryCode: 'NLD', countryName: 'Netherlands', category: 'general' },
    { name: 'Harbour Daily', countryCode: 'NLD', countryName: 'Netherlands', category: 'general' },
    { name: 'Sample Wire', countryCode: 'GLOBAL', countryName: null, category: 'world' },
    { name: 'Placeholder Post', countryCode: 'GLOBAL', countryName: null, category: 'world' },
].map((p, i) => ({
    id: hex24('b', i + 1),
    publisherId: hex24('d', i + 1),
    url: `https://example.com/${p.name.toLowerCase().replace(/\s+/g, '-')}`,
    ...p,
})) as FixturePublication[];

// Article i belongs to publication i % 4, so NLD = 0,1,4,5,8,9 and GLOBAL = 2,3,6,7,10,11.
// Articles 0 and 1 are one story told by two outlets (cluster 0); the rest stand alone.
const rows: [string, string, string, string, string | null, string | null][] = [
    ['Harbour bridge repairs begin in Fixtureville', 'Crews closed one lane of the old harbour bridge on Monday to start a repair programme expected to run through spring.', 'infrastructure', 'construction', 'Fixtureville', 'Zuid-Sample'],
    ['Fixtureville bridge works to last through spring', 'Drivers face lane closures on the harbour bridge while engineers replace worn bearings, the city says.', 'infrastructure', 'construction', 'Fixtureville', 'Zuid-Sample'],
    ['Global lighthouse fund reaches its target', 'A restoration fund for twelve coastal lighthouses passed its goal, organisers said on Tuesday.', 'culture', 'fundraising', null, null],
    ['Sampleton council approves new tram line', 'Councillors voted nine to four for a tram line linking the station with the university district.', 'transport', 'policy', 'Sampleton', 'Noord-Sample'],
    ['Fixtureville library extends opening hours', 'The central library will open until ten in the evening on weekdays after a successful pilot.', 'community', 'service', 'Fixtureville', 'Zuid-Sample'],
    ['Cyclists get a new route along the canal', 'A separated cycle path along the Placeholder canal opens this weekend, ending years of shared lanes.', 'transport', 'opening', 'Sampleton', 'Noord-Sample'],
    ['International chess festival opens with record entries', 'More than nine hundred players registered for the festival, the largest field in its history.', 'sport', 'event', null, null],
    ['Researchers map a quiet reef off the Sample coast', 'A survey team published the first full map of a reef that had gone unchecked for decades.', 'science', 'research', null, null],
    ['Harbour Daily marks fifty years of print', 'The paper celebrated its anniversary with a special edition and an open day at its old press hall.', 'media', 'anniversary', 'Fixtureville', 'Zuid-Sample'],
    ['Market traders trial reusable crates', 'Stallholders at the Saturday market will swap single-use boxes for reusable crates this month.', 'environment', 'trial', 'Sampleton', 'Noord-Sample'],
    ['Wire services agree shared corrections format', 'Four news agencies announced a common format for publishing corrections, starting next quarter.', 'media', 'policy', null, null],
    ['Observatory schedules a public night of stargazing', 'The Placeholder observatory will open its dome to visitors on the clearest night of the month.', 'science', 'event', null, null],
];

const articles: FixtureArticle[] = rows.map(([title, description, category, eventType, city, region], i) => ({
    id: hex24('a', i + 1),
    title,
    description,
    url: `https://example.com/story/${i + 1}`,
    publicationIndex: i % 4,
    clusterIndex: i < 2 ? 0 : i - 1,
    // Spread over the last ~5 hours so the 48h prune never drops them.
    minutesAgo: 5 + i * 25,
    imageIndex: (i % 4) + 1,
    category,
    eventType,
    entities: [city ?? 'Sample Coast'],
    city,
    region,
}));

export const articleFixtures: FixtureArticleSet = { publications, articles };

export const ARTICLE_IDS: readonly string[] = articles.map((a) => a.id);

/** The order the persona/topics id ops hand ids out in: topic matches first, then
 *  headline scopes. The server truncates a clipped response in request order, so
 *  keeping topics ahead of headlines is what the billing guarantee relies on. */
export const TOPIC_ARTICLE_IDS: readonly string[] = ARTICLE_IDS.slice(0, 6);
/** NLD outlets among the remaining six. */
export const COUNTRY_HEADLINE_IDS: readonly string[] = [ARTICLE_IDS[8], ARTICLE_IDS[9]];
/** GLOBAL outlets among the remaining six. */
export const GLOBAL_HEADLINE_IDS: readonly string[] = [ARTICLE_IDS[6], ARTICLE_IDS[7], ARTICLE_IDS[10], ARTICLE_IDS[11]];

export const clusterId = (a: FixtureArticle): string => hex24('c', a.clusterIndex + 1);
export const stableClusterId = (a: FixtureArticle): string => `stable-${a.clusterIndex + 1}`;
const clusterMembers = (a: FixtureArticle): FixtureArticle[] =>
    articles.filter((x) => x.clusterIndex === a.clusterIndex);

export const articleById = (id: string): FixtureArticle | undefined => articles.find((a) => a.id === id);

/** Requested ids that exist, in request order. */
export const articlesByIds = (ids: readonly string[] | null | undefined): FixtureArticle[] =>
    (ids ?? []).map(articleById).filter((a): a is FixtureArticle => !!a);

export function articlesForCountry(countryCode: string | null | undefined): FixtureArticle[] {
    if (!countryCode || countryCode === 'GLOBAL') return articles;
    return articles.filter((a) => publications[a.publicationIndex].countryCode === countryCode);
}

// ---- builders ---------------------------------------------------------------------

export interface BuildContext {
    /** Origin the fixture images are served from. */
    origin: string;
    /** `Date.now()` at resolve time. */
    now: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const pubDate = (a: FixtureArticle, ctx: BuildContext): string => iso(ctx.now - a.minutesAgo * 60_000);
const imageUrl = (a: FixtureArticle, ctx: BuildContext): string =>
    `${ctx.origin.replace(/\/$/, '')}/assets/img/${a.imageIndex}.jpg`;
const geoTags = (a: FixtureArticle) =>
    a.city ? [{ __typename: 'GeoTagDto' as const, city: a.city, region: a.region, countryCode: 'NLD' }] : [];

export function publicationSource(p: FixturePublication, ctx: BuildContext): PublicationSource {
    return {
        __typename: 'PublicationSource',
        _id: p.id,
        publication_name: p.name,
        publication_url: p.url,
        publication_type: 'newspaper',
        categories: [p.category],
        category: p.category,
        country_code: p.countryCode,
        country_name: p.countryName,
        detected_language_code: 'en',
        feed_language_code: 'en',
        feed_url: `${p.url}/feed.xml`,
        gated: false,
        is_active: true,
        newsPublisherId: p.publisherId,
        type: 'rss',
        createdAt: iso(ctx.now - 30 * 86_400_000),
        updatedAt: iso(ctx.now - 86_400_000),
    };
}

export function newsArticle(a: FixtureArticle, ctx: BuildContext): NewsArticle {
    const p = publications[a.publicationIndex];
    return {
        __typename: 'NewsArticle',
        _id: a.id,
        title: a.title,
        title_en: a.title,
        title_en_internal_only: a.title,
        description: a.description,
        description_en: a.description,
        description_en_internal_only: a.description,
        pubDate: pubDate(a, ctx),
        article_url: a.url,
        image_url: imageUrl(a, ctx),
        creator: 'Staff Writer',
        source_uri: p.url,
        original_language_code: 'en',
        category: a.category,
        entities: a.entities,
        event_type: a.eventType,
        geo_tags: geoTags(a),
        clusterConfidence: 0.9,
        publicationSource: publicationSource(p, ctx),
        publicationSourceId: p.id,
        type: 'rss',
        createdAt: pubDate(a, ctx),
        updatedAt: pubDate(a, ctx),
    };
}

export function articleWithClusters(a: FixtureArticle, ctx: BuildContext): ArticleWithClusters {
    const p = publications[a.publicationIndex];
    return {
        __typename: 'ArticleWithClusters',
        _id: a.id,
        clusters: [
            { __typename: 'ClusterMembership', clusterId: clusterId(a), confidence: 0.9, stableClusterId: stableClusterId(a) },
        ],
        title: a.title,
        title_en: a.title,
        description_en: a.description,
        article_url: a.url,
        image_url: imageUrl(a, ctx),
        country_code: p.countryCode,
        publication_name: p.name,
        language_code: 'en',
        pubDate: pubDate(a, ctx),
        geo_tags: geoTags(a),
        entities: a.entities,
        event_type: a.eventType,
        category: a.category,
        maxClusterSize: clusterMembers(a).length,
        // Own id: every fixture article is its own story, so no dedup edge joins them.
        story_key: a.id,
    };
}

export function articleSummary(a: FixtureArticle, ctx: BuildContext): ArticleSummary {
    const p = publications[a.publicationIndex];
    return {
        __typename: 'ArticleSummary',
        _id: a.id,
        title_en: a.title,
        title_original: a.title,
        description_en: a.description,
        article_url: a.url,
        image_url: imageUrl(a, ctx),
        country_code: p.countryCode,
        publication_name: p.name,
        language_code: 'en',
        pubDate: pubDate(a, ctx),
    };
}

export function newsCluster(a: FixtureArticle, ctx: BuildContext, first = 1): NewsCluster {
    const members = clusterMembers(a).slice(0, first);
    return {
        __typename: 'NewsCluster',
        _id: clusterId(a),
        stableClusterId: stableClusterId(a),
        clusterSize: clusterMembers(a).length,
        topicConfidence: 0.8,
        createdAt: pubDate(a, ctx),
        updatedAt: pubDate(a, ctx),
        articles: {
            __typename: 'ClusterArticlesConnection',
            articles: members.map((m) => newsArticle(m, ctx)),
            pageInfo: pageInfo(members.length, clusterMembers(a).length > first, members.length),
        },
    };
}

// ---- paging -------------------------------------------------------------------------

const CURSOR_PREFIX = 'fx-';

function pageInfo(pageSize: number, hasNextPage: boolean, endOffset: number): CursorPageInfo {
    return {
        __typename: 'CursorPageInfo',
        endCursor: pageSize > 0 ? `${CURSOR_PREFIX}${endOffset}` : null,
        hasNextPage,
        pageSize,
    };
}

/** Cursor paging over a fixture list. 12 articles at the default size of 4 are three
 *  pages. A cursor this module did not issue restarts from the top and reports
 *  `restarted: true`, the way the server does when a cursor no longer resolves. */
export function pageOf<T>(
    items: readonly T[],
    first: number | null | undefined,
    after: string | null | undefined,
    defaultFirst = 4,
): { items: T[]; pageInfo: CursorPageInfo; restarted: boolean } {
    const offset = after ? Number(after.startsWith(CURSOR_PREFIX) ? after.slice(CURSOR_PREFIX.length) : NaN) : 0;
    const restarted = !!after && !Number.isInteger(offset);
    const start = restarted ? 0 : offset;
    const size = first && first > 0 ? first : defaultFirst;
    const slice = items.slice(start, start + size);
    const end = start + slice.length;
    return { items: slice, pageInfo: pageInfo(slice.length, end < items.length, end), restarted };
}
