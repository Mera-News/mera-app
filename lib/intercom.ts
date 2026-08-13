// Thin wrapper around @intercom/intercom-react-native (the in-app support
// Messenger), structured like lib/revenuecat.ts: all SDK access funnels through
// here, nothing else imports the package, and every native call is a no-op when
// no key is configured.
//
// Three things make this NOT a straight copy of lib/revenuecat.ts, and each one
// caused a bug in review before it caused one on a device.
//
// 1. INIT IS ASYNC AND REJECTS. `Purchases.configure()` is synchronous and
//    total. `Intercom.initialize()` returns a Promise that rejects on a key
//    that does not start with `ios_sdk-` / `android_sdk-` or is shorter than
//    48/52 chars (verified in the package source). So "is a key present"
//    (bundle-time, synchronous) and "did init succeed" (async) are genuinely
//    different questions, and only the first may gate a UI branch — see the
//    isIntercomEnabled/`configured` split below.
//
// 2. WE INITIALISE LAZILY, on the first support tap. The app never pays for a
//    native SDK the vast majority of users never open, and nothing has to be
//    wired into app start. The cost is that `configured` is false for most of
//    the process lifetime, which is exactly why it must not gate the UI.
//
// 3. IDENTITY IS A JWT WITH A ONE-HOUR TTL, validated by Intercom on EVERY
//    request. So the token is re-minted immediately before every present(),
//    never once at login. A mint-at-login design dies silently mid-conversation.

import { useCallback, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import Intercom from '@intercom/intercom-react-native';
import { gql } from '@apollo/client';
import {
  INTERCOM_APP_ID,
  INTERCOM_IOS_KEY,
  INTERCOM_ANDROID_KEY,
} from '@/lib/config/endpoints';
import logger from '@/lib/logger';

// Standalone document on purpose. Selecting an unknown field is a GraphQL
// VALIDATION error and validation rejects the WHOLE operation, so folding this
// into an existing query would take that query out entirely on any server that
// has not deployed `intercomIdentity` yet. Same reasoning as the deliberate
// split in lib/billing-service.ts.
//
// `noSyncStatus` is read by the error link in lib/apollo-client.ts: a support
// token that cannot be minted must not paint "sync failed" across the For You
// feed. See the note there.
const GET_INTERCOM_IDENTITY = gql`
  query GetIntercomIdentity {
    intercomIdentity {
      jwt
      expiresAt
    }
  }
`;

// How long we are willing to make someone stare at a spinner after tapping
// "Support" before we give up and open their mail client instead. A support tap
// on a bad network is the failure that will actually happen, and an email that
// sends beats a Messenger that never loads.
const READY_TIMEOUT_MS = 6000;

let configured = false;
let initPromise: Promise<boolean> | null = null;

// Bumped by logoutIntercom(). presentIntercomMessenger() captures it on entry
// and re-checks before login and before present, abandoning quietly if it
// moved. Without this, a logout landing between the identity fetch and the
// login call would re-establish the DEPARTED user's Intercom session after
// they signed out — the SDK holds identity natively, so it would survive into
// the next user's session on the same device.
let identityEpoch = 0;

/**
 * Is an Intercom key present in this bundle?
 *
 * Bundle-time and synchronous, so it is safe to call at module load and from
 * render. THIS is what decides whether the UI offers the Messenger or the
 * mailto: fallback — never `configured`, which is false until a lazy init has
 * resolved and would therefore make the first tap fall back to mailto forever.
 */
export function isIntercomEnabled(): boolean {
  return !!INTERCOM_APP_ID && !!resolveApiKey();
}

/**
 * Has initialize() actually resolved? Private to this module's own guards and
 * exported only for tests. Deliberately NOT a UI gate.
 */
export function isIntercomConfigured(): boolean {
  return configured;
}

// Platform key resolved at call time, never at module load, so importing this
// module is safe where react-native's Platform is not available yet.
function resolveApiKey(): string {
  return Platform.OS === 'android' ? INTERCOM_ANDROID_KEY : INTERCOM_IOS_KEY;
}

function describeError(e: unknown): Record<string, unknown> {
  if (e && typeof e === 'object') {
    const err = e as Record<string, unknown>;
    return { message: err.message ?? String(e), code: err.code };
  }
  return { message: String(e) };
}

/** Reject a promise that may never settle, so a caller can never hang on it. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[intercom] ${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Initialise the SDK once. Safe to call repeatedly: the in-flight promise is
 * shared, and a rejection clears it so a later tap can retry rather than being
 * permanently poisoned by one bad network moment.
 */
export function configureIntercom(): Promise<boolean> {
  if (configured) return Promise.resolve(true);
  if (!isIntercomEnabled()) return Promise.resolve(false);
  if (initPromise) return initPromise;

  initPromise = Intercom.initialize(resolveApiKey(), INTERCOM_APP_ID)
    .then(() => {
      configured = true;
      return true;
    })
    .catch((e) => {
      // Cleared so the next tap retries. `configured` stays false, so every
      // entry point falls through to mailto: in the meantime.
      initPromise = null;
      logger.captureException(e, {
        tags: { module: 'intercom', method: 'initialize' },
        extra: describeError(e),
      });
      return false;
    });

  return initPromise;
}

/**
 * Mint a fresh identity JWT. Returns null on any failure.
 *
 * Apollo is required lazily, NOT imported at the top of this file. A static
 * import would close the cycle auth-client -> intercom -> apollo-client ->
 * auth-client, which is the same cycle the sentry-scope require in
 * clearAuthStorage() exists to avoid.
 */
async function fetchIntercomJwt(): Promise<string | null> {
  try {
    // Typed at the destructure rather than as a call type argument: `client`
    // comes from an untyped require (see above), and TS rejects type arguments
    // on an untyped call.
    const client = require('@/lib/apollo-client')
      .default as import('@apollo/client').ApolloClient;
    const { data } = await client.query<{
      intercomIdentity: { jwt: string; expiresAt: string };
    }>({
      query: GET_INTERCOM_IDENTITY,
      // Never a cache read: the token is short-lived and validated on every
      // Intercom request, so a cached one is worse than no token at all.
      fetchPolicy: 'network-only',
      context: { noSyncStatus: true },
    });
    return data?.intercomIdentity?.jwt ?? null;
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'intercom', method: 'fetchJwt' },
      extra: describeError(e),
    });
    return null;
  }
}

/**
 * Reset Intercom identity. Called from clearAuthStorage() and again from
 * wipeAllLocalUserData(), mirroring logoutRevenueCat().
 *
 * TOTAL: this function may never reject, and never rejects. Intercom.logout()
 * rejects when the SDK was never initialised, which lazy init makes the COMMON
 * case — and clearAuthStorage() awaits it unguarded, inside the logout handler's
 * try block. A rejection here would skip wipeAllLocalUserData() and the
 * navigation that follows it, stranding the device with no auth cookie but a
 * live `cached_user_id`. That is verbatim the bug AppPreferencesTab's
 * "PAST THIS LINE NOTHING MAY THROW" comment calls unreachable.
 */
export async function logoutIntercom(): Promise<void> {
  // Bumped unconditionally, even when the SDK was never initialised: a present
  // that is mid-flight must be abandoned regardless of init state.
  identityEpoch += 1;
  if (!configured) return;
  try {
    await Intercom.logout();
  } catch (e) {
    // Swallowed by design. A logout must never be the thing that breaks
    // signing out.
    logger.warn('[intercom] logout failed', { error: String(e) });
  }
}

/**
 * Open the Messenger, refreshing identity first.
 *
 * Returns true when the Messenger was presented, false when the caller should
 * fall back to mailto:. It never throws and never rejects, so a call site can
 * treat `false` as its single fallback signal.
 */
export async function presentIntercomMessenger(): Promise<boolean> {
  if (!isIntercomEnabled()) return false;

  const epoch = identityEpoch;
  const moved = () => identityEpoch !== epoch;

  try {
    const ready = await withTimeout(
      configureIntercom(),
      READY_TIMEOUT_MS,
      'initialize',
    );
    if (!ready || moved()) return false;

    // The JWT is re-minted here on EVERY present, not once at login. It lives
    // about an hour and Intercom validates it on every request, so a
    // mint-at-login design would work in testing and then fail silently in the
    // middle of a real conversation.
    const jwt = await withTimeout(
      fetchIntercomJwt(),
      READY_TIMEOUT_MS,
      'fetchJwt',
    );
    if (!jwt || moved()) return false;

    await Intercom.setUserJwt(jwt);
    if (moved()) return false;

    // Second tap onward only needs the refreshed token, not a full re-login.
    if (!(await Intercom.isUserLoggedIn())) {
      const { userId, userEmail } = require('@/lib/stores/user-store')
        .useUserStore.getState();
      if (!userId || moved()) return false;
      await Intercom.loginUserWithUserAttributes({
        userId,
        ...(userEmail ? { email: userEmail } : {}),
      });
    }

    if (moved()) return false;

    // Fire-and-forget, deliberately NOT awaited: fetching the raw device token
    // can take seconds, and on iOS can never settle at all if neither APNs
    // delegate fires. Nothing about opening the Messenger should wait on it.
    // Required lazily to keep notification-service out of this module's import
    // graph (it reaches the stores and the database).
    try {
      void require('@/lib/notification-service')
        .registerIntercomPushToken()
        .catch(() => {
          /* Non-fatal: the user simply gets no push for support replies. */
        });
    } catch {
      // Module unavailable in this context — never block the Messenger on it.
    }

    await Intercom.present();
    return true;
  } catch (e) {
    logger.captureException(e, {
      tags: { module: 'intercom', method: 'present' },
      extra: describeError(e),
    });
    return false;
  }
}

/**
 * Hand Intercom the raw APNs/FCM device token.
 *
 * This is NOT the `ExponentPushToken[...]` the server stores; the existing
 * getExpoPushTokenAsync path is untouched and the two coexist. Must run AFTER
 * an Intercom login resolves — sending it before yields "Failed to register a
 * device token, identity verification is not setup correctly", which reads like
 * a credentials problem and is not one.
 */
export async function sendIntercomPushToken(token: string): Promise<void> {
  if (!configured || !token) return;
  try {
    // The login check lives HERE rather than at the call sites so the ordering
    // rule holds for boot registration and token rotation alike. Sending before
    // a login resolves yields "Failed to register a device token, identity
    // verification is not setup correctly" — which names credentials and means
    // ordering, and has cost people days.
    if (!(await Intercom.isUserLoggedIn())) return;
    await Intercom.sendTokenToIntercom(token);
  } catch (e) {
    logger.warn('[intercom] sendTokenToIntercom failed', { error: String(e) });
  }
}

/**
 * The one place the "tap Support" behaviour is defined, shared by all three
 * entry points so they cannot drift.
 *
 * Contract:
 *  - Offline, or no Intercom key in this bundle: open mail immediately. No
 *    spinner, no error. Email is genuinely BETTER offline — the composer opens,
 *    the user writes, and Mail queues it until there is a network. A Messenger
 *    that cannot connect is strictly worse than that.
 *  - Otherwise: show a spinner, try the Messenger, and on ANY failure or after
 *    ~6s open mail instead, silently. The mailto fallback is today's behaviour,
 *    not an incident, so it gets no alert and no toast.
 *  - Only if opening mail ITSELF fails is there anything to tell the user, and
 *    that is left to the caller via `onMailFailed`.
 */
export function useSupportAction(onMailFailed?: () => void) {
  const [busy, setBusy] = useState(false);
  // A ref, not the `busy` state: two taps in the same frame both read the old
  // state. The row is never disabled, so double-tapping is expected input.
  const inFlight = useRef(false);

  const openSupport = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { SUPPORT_EMAIL } = require('@/lib/config/branding');
      const openMail = async () => {
        try {
          await Linking.openURL(`mailto:${SUPPORT_EMAIL}`);
        } catch {
          onMailFailed?.();
        }
      };

      const { isOnline } = require('@/lib/stores/network-store');
      if (!isIntercomEnabled() || !isOnline()) {
        await openMail();
        return;
      }

      setBusy(true);
      const presented = await presentIntercomMessenger();
      if (!presented) await openMail();
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }, [onMailFailed]);

  return { busy, openSupport };
}

/** Test seam only. */
export function __resetIntercomForTests(): void {
  configured = false;
  initPromise = null;
  identityEpoch = 0;
}
