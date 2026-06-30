// Thin wrapper around react-native-purchases (RevenueCat).
//
// All SDK access funnels through here so the rest of the app never imports
// `react-native-purchases` directly and every call is null-safe when the SDK
// isn't configured (no API key set — see REVENUECAT_API_KEY). The server (via
// the auth-service webhook) remains the source of truth for entitlements; the
// client uses these helpers for purchasing, the paywall, and optimistic UI.

import { Platform } from 'react-native';
import Purchases, {
  CustomerInfo,
  LOG_LEVEL,
  PurchasesOffering,
} from 'react-native-purchases';
import {
  REVENUECAT_API_KEY,
  REVENUECAT_IOS_KEY,
  REVENUECAT_ANDROID_KEY,
} from '@/lib/config/endpoints';
import logger from '@/lib/logger';

// Resolve the platform-specific key, falling back to the generic (Test Store)
// key. Done at call time — never at module load — so importing this module is
// safe even where react-native's Platform isn't available yet.
function resolveApiKey(): string {
  const platformKey =
    Platform.OS === 'android' ? REVENUECAT_ANDROID_KEY : REVENUECAT_IOS_KEY;
  return platformKey || REVENUECAT_API_KEY;
}

// Entitlement identifiers configured in the RevenueCat dashboard. Must match
// the server (mera-server-auth RevenueCatService) — `professional` outranks
// `individual` when both are active.
export const ENTITLEMENT_INDIVIDUAL = 'individual';
export const ENTITLEMENT_PROFESSIONAL = 'professional';

// Offering identifier (RevenueCat dashboard) whose paywall the app presents.
// Holds both tiers (individual + professional) as packages; the paywall splits
// them via its Tabs component. This is the SDK identifier, not the REST
// `ofrng…` id (which the client SDK never uses).
export const OFFERING_SUBSCRIPTION = 'mera-news-subscription';

export type SubscriptionTier = 'individual' | 'professional' | null;

let configured = false;

/** True when a RevenueCat key is present and configure() has run. */
export function isRevenueCatConfigured(): boolean {
  return configured;
}

/** True when a RevenueCat key is available to configure with. */
export function isRevenueCatEnabled(): boolean {
  return resolveApiKey().length > 0;
}

/** Configure the SDK once at app start. No-op when no key is set. */
export function configureRevenueCat(): void {
  if (configured || !isRevenueCatEnabled()) return;
  try {
    if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    Purchases.configure({ apiKey: resolveApiKey() });
    configured = true;
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'configure' },
    });
  }
}

/**
 * Identify the RevenueCat customer as our better-auth user so the webhook's
 * `app_user_id` maps back to the same user the server keys on. Returns the
 * resulting CustomerInfo (or null when disabled / on error).
 */
export async function loginRevenueCat(
  userId: string,
): Promise<CustomerInfo | null> {
  if (!configured || !userId) return null;
  try {
    const { customerInfo } = await Purchases.logIn(userId);
    return customerInfo;
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'login' },
    });
    return null;
  }
}

/** Reset to an anonymous customer so the next sign-in starts clean. */
export async function logoutRevenueCat(): Promise<void> {
  if (!configured) return;
  try {
    await Purchases.logOut();
  } catch (e) {
    // logOut throws if the current user is already anonymous — non-fatal.
    logger.warn('[revenuecat] logOut failed', { error: String(e) });
  }
}

/** Highest active entitlement on the given CustomerInfo, or null. */
export function getActiveTier(
  info: CustomerInfo | null | undefined,
): SubscriptionTier {
  const active = info?.entitlements.active ?? {};
  if (active[ENTITLEMENT_PROFESSIONAL]) return 'professional';
  if (active[ENTITLEMENT_INDIVIDUAL]) return 'individual';
  return null;
}

/**
 * Fetch a specific offering by its dashboard identifier, null-safe. Returns
 * null when the SDK isn't configured, the offering doesn't exist, or on error —
 * callers then fall back to presenting the current offering's paywall.
 */
export async function getOfferingSafe(
  identifier: string = OFFERING_SUBSCRIPTION,
): Promise<PurchasesOffering | null> {
  if (!configured) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.all[identifier] ?? null;
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'getOffering' },
    });
    return null;
  }
}

/** Fetch the latest CustomerInfo, null-safe. */
export async function getCustomerInfoSafe(): Promise<CustomerInfo | null> {
  if (!configured) return null;
  try {
    return await Purchases.getCustomerInfo();
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'getCustomerInfo' },
    });
    return null;
  }
}

/**
 * Subscribe to CustomerInfo changes (renewals/expirations/purchases). Returns
 * an unsubscribe function; a no-op when the SDK isn't configured.
 */
export function addCustomerInfoUpdateListener(
  cb: (info: CustomerInfo) => void,
): () => void {
  if (!configured) return () => {};
  Purchases.addCustomerInfoUpdateListener(cb);
  return () => Purchases.removeCustomerInfoUpdateListener(cb);
}
