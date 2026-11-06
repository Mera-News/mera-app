// A promo line the server switches on and off with PLAN_PROMO (userBilling.planPromo, null on a
// paid plan). The text is the server's, so an offer never needs an app release.
//
// Its own quiet query, like GET_READING_PLANS: a server without the field fails only this.

import { gql } from '@apollo/client';
import { create } from 'zustand';
import client from '@/lib/apollo-client';

const GET_PLAN_PROMO = gql`
  query GetPlanPromo {
    userBilling {
      planPromo
    }
  }
`;

const usePlanPromoStore = create<{ promo: string | null }>(() => ({ promo: null }));

export const usePlanPromo = (): string | null => usePlanPromoStore((s) => s.promo);

/** Fetch the promo. Quiet on failure; keeps the last answer. */
export async function syncPlanPromo(): Promise<void> {
    try {
        const { data } = await client.query<{ userBilling: { planPromo: string | null } }>({
            query: GET_PLAN_PROMO,
            fetchPolicy: 'no-cache',
            context: { noSyncStatus: true, expectedErrorCodes: ['GRAPHQL_VALIDATION_FAILED'] },
        });
        if (!data?.userBilling) return;
        usePlanPromoStore.setState({ promo: data.userBilling.planPromo ?? null });
    } catch {
        // The next sync tries again.
    }
}

export function __resetPlanPromoForTests(): void {
    usePlanPromoStore.setState({ promo: null });
}
