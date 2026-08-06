// The single place the Sentry scope is written. Everything Sentry knows about
// who and what an event came from is set here (plus the static build tags in
// lib/sentry-init.ts, which runs too early to read a store).
//
// WHY TOP-LEVEL Sentry.setTag / setContext / setUser AND NOT withScope:
// @sentry/react-native applies `enableSyncToNative` to the GLOBAL and ISOLATION
// scopes only (node_modules/@sentry/react-native/dist/js/sdk.js:59-60), bridging
// setUser/setTag/setTags/setContext/setExtra/addBreadcrumb to the native layer at
// SET time (dist/js/scopeSync.js:19-63). A LOCAL scope (Sentry.withScope) is not
// synced, so anything set inside one is invisible to a native crash — which is
// exactly the event class we most need attributed. Never move these onto a local
// scope.
//
// PRIVACY: see the contract in ./app-context.ts, which governs this module too.
// `user.id` is the raw better-auth userId and nothing else; no email, username,
// ip_address, phone, push token or ad identifier ever goes on the scope, and no
// value derived from persona facts, topics, interests, locations or reading
// history appears in any tag or context.
//
// KNOWN AND ACCEPTED GAP — background tasks carry no user.
// lib/background/inference-task.ts imports lib/sentry-init.ts during a
// TaskManager wake, with no React tree and therefore no mount to register this
// module. Errors thrown in that path ship with the static build tags and NO
// user.id or runtime tags. That is accepted. The tempting "fix" — importing the
// stores into sentry-init.ts so it can do this itself — reintroduces the module
// cycle that file is documented to avoid (sentry-init → stores → account-service
// → apollo-client → auth-client), and would move Sentry's initialisation behind
// store hydration, so a boot-time throw would go unreported. Don't.

import * as Sentry from '@sentry/react-native';

import { SENTRY_ENABLED } from '@/lib/sentry-init';
import { getStaticAppContext } from './app-context';
import type { RuntimeContext } from './runtime-context';

// ./runtime-context and the stores it reads are pulled in LAZILY, on first use.
// This module is imported by lib/auth-client.ts, which sits underneath
// apollo-client — a static store import here would close the
// auth-client → … → auth-client cycle described in the header. Keeping the
// static graph to (sentry, sentry-init, app-context) makes importing this
// module safe from anywhere. The require cost is one module-cache lookup.
function readRuntimeContext(): RuntimeContext {
  const { getRuntimeContext } =
    require('./runtime-context') as typeof import('./runtime-context');
  return getRuntimeContext();
}

/**
 * Set (or clear) the join key: the raw better-auth userId, the same value that
 * is RevenueCat's `app_user_id` and our `UserBilling.userId`.
 *
 * Deliberately NOT hashed. A hash would need a pepper, the pepper would ship in
 * the JS bundle and therefore be public — so it would buy no real protection —
 * while destroying the only thing the id is for: joining a crash to a support
 * conversation and to a subscriber record.
 *
 * Pass null on sign-out. Both sign-out paths call it independently
 * (lib/auth-client.ts clearAuthStorage, lib/security/local-wipe.ts
 * wipeAllLocalUserData), so it must stay idempotent.
 */
export function applySentryUser(userId: string | null): void {
  if (!SENTRY_ENABLED) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

// Sentry tag VALUES must be strings; booleans arrive from the runtime context
// (relevance_v3, network_connected, …) and would otherwise be coerced by the
// SDK in a way we don't control.
function toTagValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

// The last payload actually pushed. Store subscriptions fire far more often
// than the values we care about change: mera-protocol-store carries
// downloadProgress and processProgress (a 3 GB model download ticks it
// continuously) and network-store re-checks reachability on a timer. Without
// this guard every tick would cross the native bridge ~10 times to re-set
// identical tags. Comparing the serialised payload is cheap next to that.
let lastEmitted: string | null = null;

/**
 * Push the current runtime state onto the global scope: one tag per field (so
 * every field is filterable in the issue stream) plus a single merged
 * `mera_app_state` context (so an event you're already reading shows the whole
 * picture without ten tag lookups).
 */
export function refreshSentryScope(): void {
  if (!SENTRY_ENABLED) return;
  try {
    const runtime = readRuntimeContext();
    const merged = { ...getStaticAppContext(), ...runtime };

    const serialised = JSON.stringify(merged);
    if (serialised === lastEmitted) return;
    lastEmitted = serialised;

    for (const [key, value] of Object.entries(runtime)) {
      Sentry.setTag(key, toTagValue(value));
    }
    Sentry.setContext('mera_app_state', merged);
  } catch {
    // Diagnostics must never break the thing they observe. A store that isn't
    // hydrated yet simply means this run had nothing to report; the next store
    // change re-runs it.
  }
}

/**
 * Subscribe to every store that feeds the runtime context and keep the scope
 * current for the life of the app. Called once from app/_layout.tsx; returns a
 * teardown that removes all subscriptions.
 *
 * The stores are required lazily for the same cycle reason as
 * readRuntimeContext() above — and harmlessly so, since this only ever runs on
 * mount, long after the module graph has settled.
 */
export function startSentryScopeSync(): () => void {
  if (!SENTRY_ENABLED) return () => {};

  // Emit once up front. Waiting for the first store change would leave a quiet
  // session with no runtime tags at all — and a session that never changes
  // state is a plausible one to crash in.
  refreshSentryScope();

  const { useAppLanguageStore } =
    require('@/lib/stores/app-language-store') as typeof import('@/lib/stores/app-language-store');
  const { useMeraProtocolStore } =
    require('@/lib/stores/mera-protocol-store') as typeof import('@/lib/stores/mera-protocol-store');
  const { useNetworkStore } =
    require('@/lib/stores/network-store') as typeof import('@/lib/stores/network-store');
  const { useSubscriptionStore } =
    require('@/lib/stores/subscription-store') as typeof import('@/lib/stores/subscription-store');
  const { useUserStore } =
    require('@/lib/stores/user-store') as typeof import('@/lib/stores/user-store');

  const unsubscribes = [
    useAppLanguageStore.subscribe(refreshSentryScope),
    useMeraProtocolStore.subscribe(refreshSentryScope),
    useNetworkStore.subscribe(refreshSentryScope),
    useSubscriptionStore.subscribe(refreshSentryScope),
    useUserStore.subscribe(refreshSentryScope),
  ];

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
