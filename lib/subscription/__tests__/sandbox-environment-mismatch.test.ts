// The one purchase outcome that can never resolve itself: a SANDBOX purchase on
// a build reading the PRODUCTION backend. RevenueCat routes sandbox receipts to
// the staging webhook by configuration, so the UserBilling row the post-purchase
// poll waits for is written into a database this build never queries.
//
// Both halves of the predicate are load-bearing and each is asserted alone:
// sandbox-on-staging is the normal supported test path and must stay silent,
// and production-on-production is the real thing.

import type { CustomerInfo } from 'react-native-purchases';
import {
    hasSandboxPurchase,
    isProductionBackend,
    isSandboxPurchaseOnProduction,
} from '../sandbox-environment-mismatch';

const info = (o: Partial<Record<string, unknown>>) => o as unknown as CustomerInfo;

const withEntitlement = (isSandbox: boolean) =>
    info({ entitlements: { all: { 'mera-news-individual-plan': { isSandbox } } } });

const withSubscription = (isSandbox: boolean) =>
    info({ subscriptionsByProductIdentifier: { mera_news_individual_monthly: { isSandbox } } });

describe('isProductionBackend', () => {
    it('is true for the production auth endpoint', () => {
        expect(isProductionBackend('https://auth.mera.news')).toBe(true);
    });

    it('is false for staging', () => {
        expect(isProductionBackend('https://auth.staging.mera.news')).toBe(false);
    });

    it('is false for local development hosts', () => {
        expect(isProductionBackend('http://localhost:3001')).toBe(false);
        expect(isProductionBackend('http://127.0.0.1:3001')).toBe(false);
    });

    // Never claim a mismatch we cannot substantiate — an unknown endpoint must
    // not produce a warning telling a real paying customer their purchase is a
    // test one.
    it('is false when the endpoint is unknown or empty', () => {
        expect(isProductionBackend('')).toBe(false);
        expect(isProductionBackend('https://example.com')).toBe(false);
    });

    // The case this whole module exists for: a LOCAL development build inherits
    // .env (production) because the EAS `production` profile has no env block.
    // Keying off __DEV__ or the build channel would classify it as staging and
    // miss the mismatch entirely.
    it('is true for a local dev build that inherited the production endpoint', () => {
        expect(isProductionBackend('https://auth.mera.news')).toBe(true);
    });
});

describe('hasSandboxPurchase', () => {
    it('detects it on an entitlement', () => {
        expect(hasSandboxPurchase(withEntitlement(true))).toBe(true);
    });

    // The state this actually runs in: the webhook never landed, so nothing is
    // active on our side and the only evidence is the subscription map.
    it('detects it on the subscription map when no entitlement is active', () => {
        expect(hasSandboxPurchase(withSubscription(true))).toBe(true);
    });

    it('is false for a production purchase', () => {
        expect(hasSandboxPurchase(withEntitlement(false))).toBe(false);
        expect(hasSandboxPurchase(withSubscription(false))).toBe(false);
    });

    it('is false for null, undefined and an empty customer', () => {
        expect(hasSandboxPurchase(null)).toBe(false);
        expect(hasSandboxPurchase(undefined)).toBe(false);
        expect(hasSandboxPurchase(info({}))).toBe(false);
    });
});

describe('isSandboxPurchaseOnProduction', () => {
    it('is true only for the crossed pair', () => {
        expect(
            isSandboxPurchaseOnProduction(withEntitlement(true), 'https://auth.mera.news'),
        ).toBe(true);
    });

    it('is false for a sandbox purchase on staging — the supported test path', () => {
        expect(
            isSandboxPurchaseOnProduction(
                withEntitlement(true),
                'https://auth.staging.mera.news',
            ),
        ).toBe(false);
    });

    it('is false for a real purchase on production', () => {
        expect(
            isSandboxPurchaseOnProduction(withEntitlement(false), 'https://auth.mera.news'),
        ).toBe(false);
    });

    it('is false when there is no customer info at all', () => {
        expect(isSandboxPurchaseOnProduction(null, 'https://auth.mera.news')).toBe(false);
    });
});
