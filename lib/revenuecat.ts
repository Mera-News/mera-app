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
  INTRO_ELIGIBILITY_STATUS,
  LOG_LEVEL,
  PurchasesEntitlementInfo,
  PurchasesOffering,
} from 'react-native-purchases';
import {
  REVENUECAT_API_KEY,
  REVENUECAT_IOS_KEY,
  REVENUECAT_ANDROID_KEY,
} from '@/lib/config/endpoints';
import { getStaticAppContext } from '@/lib/observability/app-context';
import logger from '@/lib/logger';

// Resolve the platform-specific key, falling back to the generic key. Done at
// call time — never at module load — so importing this module is safe even
// where react-native's Platform isn't available yet.
//
// The fallback is guarded because it has already shipped once: a release build
// that resolved to the `test_` Test Store key crashed on launch in
// SimulatedStoreErrorDialogActivity ("Test Store API key used in release
// build") for 7 users on each of MERA-APP-3T and 3S. EXPO_PUBLIC_* values are
// inlined by Metro at bundle time, so an empty platform key in the build
// environment is enough to arm it, silently. Outside __DEV__ we surface that
// rather than shipping a Test Store key to the store.
function resolveApiKey(): string {
  const platformKey =
    Platform.OS === 'android' ? REVENUECAT_ANDROID_KEY : REVENUECAT_IOS_KEY;
  if (platformKey) return platformKey;

  if (!__DEV__ && REVENUECAT_API_KEY.startsWith('test_')) {
    logger.captureException(
      new Error(
        `RevenueCat: no ${Platform.OS} key in this bundle; refusing to fall back to a Test Store key in a release build`,
      ),
      { tags: { service: 'revenuecat', step: 'resolve-api-key' } },
    );
    // Empty string → configure() fails loudly and purchases stay unavailable,
    // which is strictly better than a launch crash.
    return '';
  }
  return REVENUECAT_API_KEY;
}

// Entitlement identifiers configured in the RevenueCat dashboard. Must match
// the server (mera-server-auth REVENUECAT_ENTITLEMENT_* env vars). Every real
// subscriber holds `mera-news-*-plan` — that is the only form a store purchase
// or a promotional grant produces.
//
// The bare `individual` / `professional` ids are NOT a legacy grant format, as
// this comment used to claim. They are separate entitlements that only ever had
// RevenueCat Test Store products behind them, and those products were archived
// on 2026-08-06, so nothing can grant them now. They stay in these arrays
// because accepting an id nobody holds costs nothing, while removing one that
// turned out to be held would silently lock a paying user out. Starter never had
// a bare alias. Professional outranks individual outranks starter when more than
// one is active.
export const INDIVIDUAL_ENTITLEMENT_IDS = [
  'mera-news-individual-plan',
  'individual',
];
export const PROFESSIONAL_ENTITLEMENT_IDS = [
  'mera-news-professional-plan',
  'professional',
];
export const STARTER_ENTITLEMENT_IDS = ['mera-news-starter-plan'];

// Offering identifier (RevenueCat dashboard) whose paywall the app presents.
// Holds all three tiers (starter + individual + professional) as packages;
// the paywall splits them via its Tabs component. This is the SDK identifier,
// not the REST `ofrng…` id (which the client SDK never uses).
export const OFFERING_SUBSCRIPTION = 'mera-news-subscription';

export type SubscriptionTier = 'starter' | 'individual' | 'professional' | null;

let configured = false;

// RevenueCat rejects with a PurchasesError carrying rich diagnostic fields
// (code, readableErrorCode, underlyingErrorMessage, userInfo) that a bare
// `String(e)` throws away — exactly the fields that explain an empty-offerings
// / "products couldn't be fetched from App Store Connect" failure. Pull them
// out defensively so they land in the logs.
function describeError(e: unknown): Record<string, unknown> {
  if (e && typeof e === 'object') {
    const err = e as Record<string, unknown>;
    return {
      message: err.message ?? String(e),
      code: err.code,
      readableErrorCode: err.readableErrorCode,
      underlyingErrorMessage: err.underlyingErrorMessage,
      userInfo: err.userInfo,
    };
  }
  return { message: String(e) };
}

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

// --- Subscriber attributes -------------------------------------------------
//
// A purpose-limited, PSEUDONYMOUS set of build/device/account facts attached to
// the RevenueCat customer, so support can triage a paying customer from their
// app_user_id alone ("which build? which OTA bundle? does our server agree they
// are Professional?") without us ever asking them for a screenshot — and so the
// dashboard can segment on them.
//
// WHAT MUST NEVER GO IN HERE, and why the list is closed rather than "obvious":
//   * No `setEmail` / `setDisplayName` / `setPhoneNumber` / `setPushToken`, and
//     no `collectDeviceIdentifiers()`. The join key already exists — the
//     better-auth userId `Purchases.logIn` sets as `app_user_id` — so PII would
//     buy nothing and cost a vendor copy of the user directory.
//   * No `$`-prefixed reserved attribute. `NSPrivacyTracking = false` in the iOS
//     privacy manifest structurally rules out $idfa/$idfv/$gpsAdId/$ip and the
//     whole attribution family; sending them would make the manifest a lie.
//   * Nothing derived from persona facts, topics, interests, locations, or
//     reading history. That is the product's core invariant (no collection links
//     a user to a topic) and it does not get an exception for a billing vendor.
// Values EXCLUDED even though ./observability/runtime-context.ts hands them to
// us for free: relevance_v3, free_tier_mode, model_state, network_connected,
// server_reachable, runtime_version, is_embedded_launch. They are Sentry-side
// debugging values with no support or segmentation use here, and `send it, it
// might be handy` is how a purpose-limited set stops being one. Note
// `subscription_tier` is excluded for the opposite reason: it IS RevenueCat's
// own view, so echoing it back adds nothing — `server_tier` is the one that
// carries information, because a disagreement between the two is the defect.
//
// RevenueCat's documented limits: max 50 attributes, key <= 40 chars, value <=
// 500 chars, values must be strings. We send 11 of 50; the coercion below is
// defensive so a future field can never silently blow a limit at runtime.
const ATTRIBUTE_KEY_MAX = 40;
const ATTRIBUTE_VALUE_MAX = 500;

/**
 * The last payload actually sent, serialized. `syncRevenueCatAttributes` runs on
 * every foreground and every 15-minute scheduler tick, and
 * `syncAttributesAndOfferingsIfNeeded` is a network call — re-sending eleven
 * unchanged strings all day is pure waste. Skipping the unchanged case is why
 * the login path forces: attributes are stored per `app_user_id`, so a second
 * user signing in on the same device with a byte-identical map would otherwise
 * be skipped and end up with no attributes at all.
 */
let lastAttributesSignature: string | null = null;

function buildSubscriberAttributes(): Record<string, string> {
  const app = getStaticAppContext();
  // Deliberately `require`d at call time, not imported at module scope.
  // ./observability/runtime-context.ts reads Zustand stores, and
  // lib/stores/subscription-store.ts imports THIS file — a static import would
  // close the cycle revenuecat → runtime-context → subscription-store →
  // revenuecat. It also drags in lib/database (which constructs a SQLiteAdapter
  // at import time, and dies outside a native runtime) for every consumer of
  // this module, tests included.
  const {
    getRuntimeContext,
  } = require('@/lib/observability/runtime-context') as typeof import('@/lib/observability/runtime-context');
  const runtime = getRuntimeContext();

  const raw: Record<string, unknown> = {
    app_version: app.app_version,
    app_build: app.app_build,
    platform: app.platform,
    os_version: app.os_version,
    device_tier: app.device_tier,
    ota_update_id: app.ota_update_id,
    ota_channel: app.ota_channel,
    app_language: runtime.app_language,
    onboarding_stage: runtime.onboarding_stage,
    processing_mode: runtime.processing_mode,
    server_tier: runtime.server_tier,
  };

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key.slice(0, ATTRIBUTE_KEY_MAX)] = String(value ?? '').slice(
      0,
      ATTRIBUTE_VALUE_MAX,
    );
  }
  return out;
}

export interface SyncRevenueCatAttributesOptions {
  /** Bypass the unchanged-payload skip. Used by the login path — see above. */
  force?: boolean;
}

/**
 * Push the subscriber attributes above onto the CURRENT RevenueCat customer.
 * No-op when the SDK isn't configured, and never throws: an attribute sync is
 * telemetry, and telemetry must not be the thing that breaks a sign-in or a
 * purchase.
 */
export async function syncRevenueCatAttributes(
  opts: SyncRevenueCatAttributesOptions = {},
): Promise<void> {
  if (!configured) return;
  try {
    const attributes = buildSubscriberAttributes();
    const signature = JSON.stringify(attributes);
    if (!opts.force && signature === lastAttributesSignature) return;

    // Recorded BEFORE the await, not after it. The entitlement-sync task calls
    // `syncEntitlement()` — whose success path fires this without awaiting —
    // and then calls this again itself. Assigning after the flush leaves the
    // second call reading a stale signature while the first is still suspended
    // on the network, so both send. That interleaving happens exactly when a
    // value just CHANGED, i.e. the only case the skip is meant to protect, so
    // the check has to be atomic with respect to the await.
    lastAttributesSignature = signature;

    Purchases.setAttributes(attributes);
    // setAttributes only queues locally; this is what actually ships them. It
    // also refreshes offerings, which is harmless — the paywall reads whatever
    // is current at present time.
    await Purchases.syncAttributesAndOfferingsIfNeeded();
  } catch (e) {
    // Roll the optimistic signature back so a send that failed (offline, bridge
    // down) is retried on the next foreground rather than being remembered as
    // delivered forever.
    lastAttributesSignature = null;
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'syncAttributes' },
      extra: describeError(e),
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
    // AFTER logIn resolves, never before — and `force`, never conditionally.
    // `configureRevenueCat()` passes no appUserID, so on every cold start the
    // SDK mints its own `$RCAnonymousID:…` customer (see
    // isAnonymousCustomerInfo below for the observed device trace). Attributes
    // set before this point land on that anonymous customer and are lost when
    // the alias happens — support would then look up the real user and find
    // nothing. Awaited rather than fired-and-forgotten because the call cannot
    // throw by construction, so it costs correctness nothing to make the
    // ordering deterministic.
    await syncRevenueCatAttributes({ force: true });
    return customerInfo;
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'login' },
      extra: describeError(e),
    });
    return null;
  }
}

/**
 * Reset to an anonymous customer so the next sign-in starts clean.
 *
 * Idempotent on purpose: a logout runs this TWICE — once via
 * `clearAuthStorage()` and once via `wipeAllLocalUserData()`, which clear
 * overlapping sets of local state and are each independently correct to call.
 * `Purchases.logOut()` throws when the customer is already anonymous, so the
 * second call used to log a warning on every single sign-out. Checking first
 * makes the repeat a genuine no-op rather than a caught error.
 */
export async function logoutRevenueCat(): Promise<void> {
  if (!configured) return;
  try {
    if (await Purchases.isAnonymous()) return;
    await Purchases.logOut();
  } catch (e) {
    // Still caught: isAnonymous() is a bridge call and can itself fail, and a
    // logout must never be the thing that breaks signing out.
    logger.warn('[revenuecat] logOut failed', { error: String(e) });
  }
}

/** Highest active entitlement on the given CustomerInfo, or null. */
export function getActiveTier(
  info: CustomerInfo | null | undefined,
): SubscriptionTier {
  const active = info?.entitlements.active ?? {};
  if (PROFESSIONAL_ENTITLEMENT_IDS.some((id) => active[id])) {
    return 'professional';
  }
  if (INDIVIDUAL_ENTITLEMENT_IDS.some((id) => active[id])) return 'individual';
  if (STARTER_ENTITLEMENT_IDS.some((id) => active[id])) return 'starter';
  return null;
}

/**
 * Whether this CustomerInfo describes an ANONYMOUS RevenueCat customer — one
 * the SDK minted for itself because `configureRevenueCat()` passes no
 * appUserID and `loginRevenueCat()` has not run yet.
 *
 * It matters because an anonymous payload is an answer about *nobody*. On
 * every cold start the SDK configures anonymously, fetches
 * `/v1/subscribers/$RCAnonymousID:…` (observed on device), and that empty
 * CustomerInfo lands in the store seconds before `Purchases.logIn` aliases it
 * to the real user. Reading "no entitlements" off it as "this user is not
 * subscribed" is what flashes Mera News Free at a paying subscriber — the exact
 * failure `AiAccess`'s `'unknown'` state exists to prevent.
 *
 * `$RCAnonymousID:` is RevenueCat's own documented prefix for generated IDs.
 */
export function isAnonymousCustomerInfo(
  info: CustomerInfo | null | undefined,
): boolean {
  return info?.originalAppUserId?.startsWith('$RCAnonymousID:') ?? false;
}

/** The active entitlement backing the highest tier, or null. */
export function getActiveEntitlementInfo(
  info: CustomerInfo | null | undefined,
): PurchasesEntitlementInfo | null {
  const active = info?.entitlements.active ?? {};
  for (const id of [
    ...PROFESSIONAL_ENTITLEMENT_IDS,
    ...INDIVIDUAL_ENTITLEMENT_IDS,
    ...STARTER_ENTITLEMENT_IDS,
  ]) {
    if (active[id]) return active[id];
  }
  return null;
}

/**
 * Flatten `customerInfo.subscriptionsByProductIdentifier` to the handful of
 * fields that would reveal a *pending* plan change (a deferred App Store
 * upgrade/downgrade that takes effect at the next renewal).
 *
 * This is a probe, not a feature. `PurchasesEntitlementInfo` /
 * `PurchasesSubscriptionInfo` (react-native-purchases 10.4.0) carry no field
 * naming a future product — RevenueCat only surfaces that server-side, as
 * `PRODUCT_CHANGE.new_product_id`. So we cannot yet say whether the store
 * records the deferred product client-side at all. Logging these rows from a
 * device that is *currently* in the deferred state answers that definitively;
 * until it does, the app deliberately shows no pending-change notice (a wrong
 * "Professional starts on X" is worse than silence). See
 * POWER_USER_FOLLOWUPS #12.
 */
export function describeSubscriptions(
  info: CustomerInfo | null | undefined,
): Record<string, unknown>[] {
  const subs = info?.subscriptionsByProductIdentifier ?? {};
  return Object.entries(subs).map(([productIdentifier, s]) => ({
    productIdentifier,
    isActive: s.isActive,
    willRenew: s.willRenew,
    periodType: s.periodType,
    store: s.store,
    purchaseDate: s.purchaseDate,
    expiresDate: s.expiresDate,
    unsubscribeDetectedAt: s.unsubscribeDetectedAt,
  }));
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
    const target = offerings.all[identifier] ?? null;
    logger.debug('[revenuecat] getOfferings ok', {
      requested: identifier,
      current: offerings.current?.identifier ?? null,
      allIdentifiers: Object.keys(offerings.all),
      targetFound: target !== null,
      targetPackageCount: target?.availablePackages?.length ?? 0,
      targetProducts: target?.availablePackages?.map((p) => ({
        packageId: p.identifier,
        productId: p.product.identifier,
        priceString: p.product.priceString,
      })),
    });
    if (target && target.availablePackages?.length === 0) {
      logger.warn('[revenuecat] offering has zero available packages', {
        requested: identifier,
      });
    }
    return target;
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'getOffering' },
      extra: describeError(e),
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
      extra: describeError(e),
    });
    return null;
  }
}

/**
 * The ONLY store product that carries an introductory offer. Verified against
 * the RevenueCat catalogue on 2026-08-08: of the eleven registered products,
 * this is the single one with a non-null `trial_duration` (P1W). Starter has
 * none, Professional has none, and NONE of the four Play Store products has one
 * — so there is no trial to offer on Android at all, on any tier.
 */
export const TRIAL_PRODUCT_ID = 'mera_news_individual_monthly';

/**
 * `'eligible'` — this Apple Account has never taken the introductory offer.
 * `'ineligible'` — it has (or the platform has no trial to give).
 * `'unknown'` — we could not find out.
 *
 * Callers must treat `'unknown'` as "do not promise a trial". Apple's own
 * guidance is to show the non-introductory price when eligibility is unknown,
 * and the asymmetry matters here: offering a trial that the store then refuses
 * to honour is a broken promise at the payment sheet, whereas withholding the
 * word from someone who is in fact eligible costs nothing.
 */
export type TrialAvailability = 'eligible' | 'ineligible' | 'unknown';

export async function getTrialAvailability(): Promise<TrialAvailability> {
  // Not a capability gap we should paper over: Android genuinely has no trial
  // product, and `checkTrialOrIntroductoryPriceEligibility` always answers
  // UNKNOWN there, so asking would only produce a misleading maybe.
  if (Platform.OS !== 'ios') return 'ineligible';
  if (!configured) return 'unknown';
  try {
    const result = await Purchases.checkTrialOrIntroductoryPriceEligibility([
      TRIAL_PRODUCT_ID,
    ]);
    const status = result[TRIAL_PRODUCT_ID]?.status;
    if (status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE) {
      return 'eligible';
    }
    if (
      status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE
    ) {
      return 'ineligible';
    }
    return 'unknown';
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'getTrialAvailability' },
      extra: describeError(e),
    });
    return 'unknown';
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

/**
 * Dump everything the SDK can tell us about the current RevenueCat state to the
 * logs — for diagnosing empty offerings / "products couldn't be fetched from
 * App Store Connect". Each probe is isolated so one failure doesn't hide the
 * rest. Safe to call anytime (no-op when unconfigured); wire it behind a debug
 * gesture or call it right before presenting the paywall.
 */
export async function logRevenueCatDiagnostics(): Promise<void> {
  logger.info('[revenuecat] --- diagnostics start ---', {
    platform: Platform.OS,
    configured,
    // Which key kind is in use — never log the key value itself.
    apiKeyPrefix: resolveApiKey().slice(0, 5),
  });
  if (!configured) {
    logger.warn('[revenuecat] not configured — nothing to diagnose');
    return;
  }

  try {
    logger.info('[revenuecat] appUserID', {
      appUserID: await Purchases.getAppUserID(),
    });
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'diag.appUserID' },
      extra: describeError(e),
    });
  }

  // Whether the store permits purchases at all (parental controls, device
  // restrictions). If false, offerings/products will look "empty" regardless
  // of dashboard config.
  try {
    logger.info('[revenuecat] canMakePayments', {
      canMakePayments: await Purchases.canMakePayments(),
    });
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'diag.canMakePayments' },
      extra: describeError(e),
    });
  }

  // Fetches the raw offerings (also logs the parsed breakdown via getOfferingSafe).
  try {
    const offerings = await Purchases.getOfferings();
    logger.info('[revenuecat] offerings snapshot', {
      current: offerings.current?.identifier ?? null,
      all: Object.entries(offerings.all).map(([id, o]) => ({
        id,
        packages: o.availablePackages.map((p) => p.product.identifier),
      })),
    });
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'diag.offerings' },
      extra: describeError(e),
    });
  }

  try {
    const info = await Purchases.getCustomerInfo();
    logger.info('[revenuecat] customerInfo', {
      originalAppUserId: info.originalAppUserId,
      activeEntitlements: Object.keys(info.entitlements.active),
      activeSubscriptions: info.activeSubscriptions,
      allPurchasedProductIdentifiers: info.allPurchasedProductIdentifiers,
      tier: getActiveTier(info),
    });
    // The pending-plan-change probe — see describeSubscriptions().
    logger.info('[revenuecat] subscriptions', {
      subscriptions: describeSubscriptions(info),
    });
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'revenuecat', method: 'diag.customerInfo' },
      extra: describeError(e),
    });
  }

  await getOfferingSafe();
  logger.info('[revenuecat] --- diagnostics end ---');
}
