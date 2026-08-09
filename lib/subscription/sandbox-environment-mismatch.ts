import type { CustomerInfo } from 'react-native-purchases';

/**
 * Detects the one purchase outcome that can never resolve itself: a SANDBOX
 * purchase made by a build pointed at the PRODUCTION backend.
 *
 * ## Why this exists — it is a routing fact, not a bug
 *
 * RevenueCat routes webhooks by environment, and this project has two:
 *
 *   production  -> https://auth.mera.news/webhooks/revenuecat
 *   sandbox     -> https://auth.staging.mera.news/webhooks/revenuecat
 *
 * A sandbox purchase therefore delivers its receipt to STAGING, always. If the
 * app is reading PRODUCTION, the `UserBilling` row it is waiting for is being
 * written into a database it will never query — verified 2026-08-09: prod's
 * `user-billing-webhook-events` holds 104 rows and every one is
 * `environment: PRODUCTION`, while the matching SANDBOX events for the same
 * purchase landed in staging minutes earlier.
 *
 * Without this check the post-purchase poll spends its whole retry budget and
 * then shows "your purchase is being confirmed", which is doubly wrong: the
 * purchase is not being confirmed, and waiting longer cannot help. The tester
 * is left staring at a spinner for a condition that is structurally impossible.
 *
 * Nothing here is a workaround for a defect. Sandbox receipts SHOULD be refused
 * by production — accepting them would let anyone grant themselves a paid tier
 * with a free sandbox purchase. The only thing that was missing is saying so.
 */

/**
 * True when this build talks to the production backend.
 *
 * Derived from the endpoint rather than from `__DEV__` or a build channel,
 * because the thing that actually decides which database the entitlement is
 * read from is the endpoint and nothing else. A local `npx expo run:ios` build
 * inherits `.env` (production) even though it is a development build, which is
 * exactly the case this whole module exists for — keying off `__DEV__` would
 * classify it as staging and miss it.
 */
export function isProductionBackend(
    authEndpoint = process.env.EXPO_PUBLIC_AUTH_ENDPOINT ?? '',
): boolean {
    const endpoint = authEndpoint.toLowerCase();
    if (!endpoint) return false; // unknown -> never claim a mismatch
    if (endpoint.includes('staging')) return false;
    if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) return false;
    return endpoint.includes('mera.news');
}

/**
 * True when `customerInfo` describes a sandbox purchase. Checks BOTH shapes
 * RevenueCat exposes it on, because they do not always agree:
 * `entitlements.active[*].isSandbox` is the one populated for an entitlement
 * that just unlocked, while `activeSubscriptions` -> `subscriptionsByProductIdentifier`
 * carries it per subscription. A purchase that granted no entitlement (the
 * webhook never landed, so nothing is active on our side) still shows up in the
 * subscription map, which is precisely the state this runs in.
 */
export function hasSandboxPurchase(customerInfo: CustomerInfo | null | undefined): boolean {
    if (!customerInfo) return false;

    for (const entitlement of Object.values(customerInfo.entitlements?.all ?? {})) {
        if (entitlement?.isSandbox) return true;
    }

    const subs = (
        customerInfo as unknown as {
            subscriptionsByProductIdentifier?: Record<string, { isSandbox?: boolean }>;
        }
    ).subscriptionsByProductIdentifier;
    for (const sub of Object.values(subs ?? {})) {
        if (sub?.isSandbox) return true;
    }

    return false;
}

/**
 * The whole check: a sandbox purchase on a production-backed build.
 *
 * Deliberately requires BOTH halves. A sandbox purchase on a staging build is
 * the normal, supported test path and must never show a warning; a production
 * purchase on a production build is the real thing. Only the crossed pair is
 * unresolvable.
 */
export function isSandboxPurchaseOnProduction(
    customerInfo: CustomerInfo | null | undefined,
    authEndpoint?: string,
): boolean {
    return isProductionBackend(authEndpoint) && hasSandboxPurchase(customerInfo);
}
