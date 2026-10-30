// Manage plan > Redeem a code: the store runs offer codes end to end. Mera
// keeps no code list and records no redemption (owner); the plan arrives
// through the normal webhook and reaches the app through the existing
// refreshes (RevenueCat's customer-info listener, the entitlement-sync task on
// foreground and every 15 minutes). Nothing new polls for it.
//
// The purchase hold comes FIRST: both the iOS sheet and the Play page are a
// departure and a return, and the release is timer-owned (never a finally).

import logger from '@/lib/logger';
import { holdRestartAcrossPurchase } from '@/lib/subscriptions/subscribe-flow';
import { Linking, Platform } from 'react-native';
import Purchases from 'react-native-purchases';

export const PLAY_REDEEM_URL = 'https://play.google.com/redeem';

/** Opens the store's code redemption. Never throws (a press handler). */
export async function redeemOfferCode(): Promise<void> {
    holdRestartAcrossPurchase('purchase');
    try {
        if (Platform.OS === 'ios') await Purchases.presentCodeRedemptionSheet();
        else await Linking.openURL(PLAY_REDEEM_URL);
    } catch (error) {
        logger.captureException(error, { tags: { component: 'redeemOfferCode', platform: Platform.OS } });
    }
}
