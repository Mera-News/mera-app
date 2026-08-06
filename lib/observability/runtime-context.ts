// Runtime-varying, non-identifying account and feature-flag state, shared by
// Sentry tags and RevenueCat subscriber attributes. The static half lives in
// ./app-context.ts — see that file's PRIVACY CONTRACT, which governs this one
// too.
//
// Kept separate from app-context.ts on purpose: this module imports stores, and
// lib/sentry-init.ts must not (it is the app's first import, before store
// hydration, and pulling stores in would reintroduce the module cycle that file
// is documented to avoid). sentry-init takes the static half only; the dynamic
// half is pushed onto the scope later by ./sentry-scope.ts.
//
// Every read is non-reactive `getState()` — these run at event time and on
// store-change callbacks, never inside a React render.

import { FREE_TIER_MODE_ENABLED } from '@/lib/config/feature-gates';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { useUserStore } from '@/lib/stores/user-store';

export interface RuntimeContext {
  /** RevenueCat's view of the tier. 'free' rather than null, so it filters. */
  subscription_tier: string;
  /**
   * OUR server's view of the same thing. Carried alongside `subscription_tier`
   * specifically so a disagreement between the two is visible in a dashboard
   * filter — the server is the source of truth and RevenueCat an optimistic
   * mirror (see lib/subscription/ai-access.ts), so drift is a real defect class
   * we currently have no way to spot.
   */
  server_tier: string;
  /** UI language setting. NOT the persona's `language_codes`. */
  app_language: string;
  onboarding_stage: string;
  processing_mode: string;
  relevance_v3: boolean;
  free_tier_mode: boolean;
  model_state: string;
  /**
   * Device connectivity AND whether the server is answering — these are
   * independent (see network-store), and conflating them is what previously
   * ejected users into an uncompletable screen. Both are carried so an
   * offline-path failure is separable from a server-down one.
   */
  network_connected: boolean;
  server_reachable: boolean;
}

export function getRuntimeContext(): RuntimeContext {
  const { appLanguage } = useAppLanguageStore.getState();
  const { tier, serverTier } = useSubscriptionStore.getState();
  const { processingMode, relevanceV3, modelState } =
    useMeraProtocolStore.getState();
  const { isConnected, serverReachable } = useNetworkStore.getState();
  const { userPersona } = useUserStore.getState();

  return {
    subscription_tier: tier ?? 'free',
    server_tier: serverTier ?? 'unknown',
    app_language: appLanguage,
    // Account progress, owned by the server — not a persona-derived value.
    onboarding_stage: userPersona?.onboardingStage ?? 'unknown',
    processing_mode: processingMode,
    relevance_v3: relevanceV3,
    free_tier_mode: FREE_TIER_MODE_ENABLED,
    model_state: modelState,
    network_connected: isConnected,
    server_reachable: serverReachable,
  };
}
