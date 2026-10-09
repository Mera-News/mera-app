import type {
    NewsPublisher,
    PublicationDisplayName,
    PublicationProfile,
    PublisherSearchHit,
} from '@/lib/generated/graphql-types';
import { articleFixtures, publicationSource, type BuildContext } from '../articles';

const { publications } = articleFixtures;

/** Profile of the first fixture outlet. */
export const publicationProfile: PublicationProfile = {
    __typename: 'PublicationProfile',
    newsPublisherId: publications[0].publisherId,
    name: publications[0].name,
    displayName: publications[0].name,
    homepageUrl: publications[0].url,
    publicationType: 'newspaper',
    categories: [publications[0].category],
    languages: ['en'],
    isOfficial: false,
    countryCode: publications[0].countryCode,
    countryName: publications[0].countryName,
    sourceNames: [publications[0].name],
    subscriptionUri: null,
};

export function publicationProfileFor(args: {
    newsPublisherId?: string | null;
    name?: string | null;
}): PublicationProfile {
    const p =
        publications.find((x) => x.publisherId === args.newsPublisherId || x.name === args.name) ??
        publications[0];
    return {
        ...publicationProfile,
        newsPublisherId: p.publisherId,
        name: p.name,
        displayName: p.name,
        homepageUrl: p.url,
        categories: [p.category],
        countryCode: p.countryCode,
        countryName: p.countryName,
        sourceNames: [p.name],
    };
}

export const displayNamesFor = (names: readonly string[]): PublicationDisplayName[] =>
    names.map((name) => ({ __typename: 'PublicationDisplayName', name, displayName: name }));

export function newsPublisher(i: number, ctx: BuildContext): NewsPublisher {
    const p = publications[i];
    return {
        __typename: 'NewsPublisher',
        _id: p.publisherId,
        name: p.name,
        website_url: p.url,
        country_code: p.countryCode,
        country_name: p.countryName,
        subscription_uri: null,
        is_active: true,
        publicationSources: [publicationSource(p, ctx)],
        createdAt: new Date(ctx.now - 30 * 86_400_000).toISOString(),
        updatedAt: new Date(ctx.now - 86_400_000).toISOString(),
    };
}

export function publisherSearchHit(i: number, ctx: BuildContext): PublisherSearchHit {
    const p = publications[i];
    return {
        __typename: 'PublisherSearchHit',
        _id: p.publisherId,
        name: p.name,
        website_url: p.url,
        country_code: p.countryCode,
        country_name: p.countryName,
        subscription_uri: null,
        matchingSources: [publicationSource(p, ctx)],
    };
}
