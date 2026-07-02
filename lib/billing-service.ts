import { gql } from '@apollo/client';
import client from './apollo-client';
import { UserBillingInfo } from './generated/graphql-types';
import logger from './logger';

const GET_USER_BILLING = gql`
  query GetUserBilling {
    userBilling {
      subscriptionTier
      dailyArticleLimit
      articlesUsedToday
      entitlementExpiresAt
      resetAt
    }
  }
`;

interface UserBillingResponse {
    userBilling: UserBillingInfo;
}

/**
 * Fetch the current user's billing/quota snapshot from the server — the DB is
 * the source of truth for tier and daily article limit (RevenueCat customerInfo
 * is only optimistic client state). Returns null on any error; callers fall
 * back to promo/default display.
 */
export async function fetchUserBilling(): Promise<UserBillingInfo | null> {
    try {
        const { data } = await client.query<UserBillingResponse>({
            query: GET_USER_BILLING,
            fetchPolicy: 'no-cache',
        });
        return data?.userBilling ?? null;
    } catch (error) {
        logger.captureException(error, {
            tags: { component: 'billing-service', method: 'fetchUserBilling' },
        });
        return null;
    }
}
