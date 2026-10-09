import type {
    AppConfig,
    FactCheck,
    FeedbackRequestView,
    Place,
    PublicationProfile,
    UserBillingInfo,
    UserPersona,
} from '@/lib/generated/graphql-types';
import {
    appConfig,
    articles,
    billingNone,
    billingStarter,
    factCheck,
    feedbackRequests,
    persona,
    places,
    publicationProfile,
} from '../mock-backend/fixtures/graphql';
import type { FixtureArticleSet } from '../mock-backend/fixtures/articles';

interface Fixtures {
    /** The 12 articles and 4 publications, as plain data (not GraphQL shapes). */
    articles: FixtureArticleSet;
    persona: UserPersona;
    billingStarter: UserBillingInfo;
    billingNone: UserBillingInfo;
    appConfig: AppConfig;
    feedbackRequests: FeedbackRequestView[];
    places: Place[];
    factCheck: FactCheck;
    publicationProfile: PublicationProfile;
}

const FIXTURES: Fixtures = {
    articles,
    persona,
    billingStarter,
    billingNone,
    appConfig,
    feedbackRequests,
    places,
    factCheck,
    publicationProfile,
};

/** A deep copy of a named fixture, safe to mutate. */
export function fixture<K extends keyof Fixtures>(name: K): Fixtures[K] {
    return structuredClone(FIXTURES[name]);
}
