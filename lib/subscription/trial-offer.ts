// Whether the store will give THIS reader a free Individual trial right now,
// so the read hold's upgrade button can say "Try Individual free for 14 days"
// instead of "See plans". The stores run the trial; Mera only asks.
//
// Proof or nothing: an unknown, an error, a missing package or a paid intro
// offer all answer null, and the button says "See plans". The trial is never
// claimed without the store saying so. Never read device-auth's legacy
// `trialAvailable` for this: nothing about it reflects the store.
//
// - iOS: the Individual product's intro offer must be free AND
//   `checkTrialOrIntroductoryPriceEligibility` must answer ELIGIBLE (Apple
//   decides per subscription group, so a past Professional subscriber is not).
// - Android: Play hands the app only offers this account is eligible for, so
//   a `freePhase` on the package's default option is the proof.
//
// A yes is cached per process (it only changes on a purchase); a null is not,
// and a reader who bought Individual is no longer shown the trial line
// (ReadHoldUpgradeButton keys the label on the tier too).

import { getOfferingSafe } from '@/lib/revenuecat';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Purchases, { INTRO_ELIGIBILITY_STATUS, type PurchasesOffering, type PurchasesPackage } from 'react-native-purchases';

export interface TrialOffer {
    readonly trialDays: number;
}

/** The offering's Individual package. Product ids carry the plan name on both
 *  stores (iOS `mera_news_individual_monthly`, Play
 *  `mera_news_subscriptions:mera-news-individual-monthly`). */
export function individualPackage(offering: PurchasesOffering | null): PurchasesPackage | null {
    return offering?.availablePackages.find((p) => /individual/i.test(p.product.identifier)) ?? null;
}

/** A period in days; null for a unit that is not a fixed number of days. */
function periodDays(unit: string, units: number): number | null {
    if (!(units > 0)) return null;
    if (unit === 'DAY') return units;
    if (unit === 'WEEK') return units * 7;
    return null;
}

export async function resolveTrialOffer(): Promise<TrialOffer | null> {
    try {
        const pkg = individualPackage(await getOfferingSafe());
        if (!pkg) return null;
        const product = pkg.product;
        if (Platform.OS === 'ios') {
            const intro = product.introPrice;
            if (!intro || intro.price !== 0) return null;
            const answer = await Purchases.checkTrialOrIntroductoryPriceEligibility([product.identifier]);
            if (answer[product.identifier]?.status !== INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE) return null;
            const days = periodDays(intro.periodUnit, intro.periodNumberOfUnits * Math.max(1, intro.cycles));
            return days ? { trialDays: days } : null;
        }
        const free = product.defaultOption?.freePhase;
        if (!free) return null;
        const days = periodDays(free.billingPeriod.unit, free.billingPeriod.value * (free.billingCycleCount ?? 1));
        return days ? { trialDays: days } : null;
    } catch {
        return null;
    }
}

let cached: Promise<TrialOffer | null> | null = null;

/** The free Individual trial this reader is eligible for, or null (unknown
 *  included). Null until the store answers; never blocks render. */
export function useTrialOffer(): TrialOffer | null {
    const [offer, setOffer] = useState<TrialOffer | null>(null);
    useEffect(() => {
        let alive = true;
        cached ??= resolveTrialOffer();
        void cached.then((o) => {
            // A null can mean the offering had not loaded yet; ask again on the next mount.
            if (!o) cached = null;
            if (alive) setOffer(o);
        });
        return () => {
            alive = false;
        };
    }, []);
    return offer;
}

export function __resetTrialOfferForTests(): void {
    cached = null;
}
