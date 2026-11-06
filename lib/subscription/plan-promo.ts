// A promo the server switches on and off with PLAN_PROMO (userBilling.planPromo, null on a paid
// plan). The env holds an id because the copy needs 20 languages: an id this build has no copy
// for shows nothing.
//
// Its own quiet query, like GET_READING_PLANS: a server without the field fails only this.

import { gql } from '@apollo/client';
import { create } from 'zustand';
import client from '@/lib/apollo-client';

export const PLAN_PROMO_NOTICE = 'plan_promo';
export const PLAN_PROMO_SETTING = 'plan_promo_noticed';

const PROMO_COPY = {
    web_summit: {
        line: 'subscription.promoWebSummit',
        title: 'subscription.promoWebSummitTitle',
        body: 'subscription.promoWebSummitBody',
    },
} as const;

type PromoCopy = (typeof PROMO_COPY)[keyof typeof PROMO_COPY];

const copyFor = (promo: string | null): PromoCopy | null =>
    promo != null && Object.hasOwn(PROMO_COPY, promo) ? PROMO_COPY[promo as keyof typeof PROMO_COPY] : null;

const GET_PLAN_PROMO = gql`
  query GetPlanPromo {
    userBilling {
      planPromo
    }
  }
`;

const usePlanPromoStore = create<{ promo: string | null }>(() => ({ promo: null }));

export const usePlanPromoCopy = (): PromoCopy | null => copyFor(usePlanPromoStore((s) => s.promo));

async function syncNotice(promo: string | null): Promise<void> {
    // Lazy: entitlement sync is imported early, and these pull in the database.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { deleteSetting, getSetting, setSetting } = require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
    const { deleteByTypes, notify } = require('@/lib/database/services/notification-service') as typeof import('@/lib/database/services/notification-service');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const noticed = await getSetting(PLAN_PROMO_SETTING);
    const copy = copyFor(promo);
    if (copy && promo) {
        if (noticed === promo) return;
        await setSetting(PLAN_PROMO_SETTING, promo);
        await notify({
            type: PLAN_PROMO_NOTICE,
            title: copy.title,
            body: copy.body,
            icon: null,
            actions: [{ id: 'open-plans', labelKey: 'feedStatus.seePlans' }],
            source: `plan_promo:${promo}`,
        });
    } else if (noticed) {
        await deleteByTypes([PLAN_PROMO_NOTICE]);
        await deleteSetting(PLAN_PROMO_SETTING);
    }
}

/** Fetch the promo and bring the Inbox into line. Quiet on failure; keeps the last answer. */
export async function syncPlanPromo(): Promise<void> {
    try {
        const { data } = await client.query<{ userBilling: { planPromo: string | null } }>({
            query: GET_PLAN_PROMO,
            fetchPolicy: 'no-cache',
            context: { noSyncStatus: true, expectedErrorCodes: ['GRAPHQL_VALIDATION_FAILED'] },
        });
        if (!data?.userBilling) return;
        const promo = data.userBilling.planPromo ?? null;
        usePlanPromoStore.setState({ promo });
        await syncNotice(promo);
    } catch {
        // The next sync tries again.
    }
}

export function __resetPlanPromoForTests(): void {
    usePlanPromoStore.setState({ promo: null });
}
