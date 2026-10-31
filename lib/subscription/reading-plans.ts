// Every plan's daily cloud reading, as the server enforces it (owner: the app
// holds no static plan size or usage ratio anywhere). Copy that states a size
// or a ratio reads it from here and drops the line while it is unknown.
//
// Its own quiet query, like GET_USER_READING: a server without `readingPlans`
// fails only this operation, and the copy simply shows no numbers.

import { gql } from '@apollo/client';
import { create } from 'zustand';
import client from '@/lib/apollo-client';

export interface ReadingPlans {
    readonly starter: number;
    readonly individual: number;
    readonly professional: number;
}

const GET_READING_PLANS = gql`
  query GetReadingPlans {
    userBilling {
      readingPlans {
        starter
        individual
        professional
      }
    }
  }
`;

const useReadingPlansStore = create<{ plans: ReadingPlans | null }>(() => ({ plans: null }));

/** Fetch the plan sizes into the store. Quiet on failure; keeps the last answer. */
export async function fetchReadingPlans(): Promise<ReadingPlans | null> {
    try {
        const { data } = await client.query<{ userBilling: { readingPlans: ReadingPlans | null } }>({
            query: GET_READING_PLANS,
            fetchPolicy: 'no-cache',
            context: { noSyncStatus: true, expectedErrorCodes: ['GRAPHQL_VALIDATION_FAILED'] },
        });
        const plans = data?.userBilling?.readingPlans ?? null;
        if (plans) useReadingPlansStore.setState({ plans });
        return plans;
    } catch {
        return null;
    }
}

export const getReadingPlans = (): ReadingPlans | null => useReadingPlansStore.getState().plans;

export const useReadingPlans = (): ReadingPlans | null => useReadingPlansStore((s) => s.plans);

/** How many times the bigger plan reads the smaller one, or null when it is not a real step up. */
export function planRatio(bigger: number, smaller: number): number | null {
    const r = Math.round(bigger / smaller);
    return Number.isFinite(r) && r >= 2 ? r : null;
}

/** Decimal megabytes as copy writes them: 4, 20, 2.5. */
export const formatMb = (bytes: number): string => `${Number((bytes / 1_000_000).toFixed(1))} MB`;

export function __setReadingPlansForTests(plans: ReadingPlans | null): void {
    useReadingPlansStore.setState({ plans });
}
