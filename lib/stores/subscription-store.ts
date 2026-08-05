import { create } from 'zustand';
import type { CustomerInfo } from 'react-native-purchases';
import { getActiveTier, type SubscriptionTier } from '@/lib/revenuecat';
import { deriveAiAccess, type AiAccess } from '@/lib/subscription/ai-access';
import { clearJwtSubscriptionLock } from '@/lib/subscription/jwt-subscription-gate';

/** The subset of `userBilling` this store mirrors. */
export interface ServerBillingSnapshot {
  subscriptionTier?: string | null;
  hasEverSubscribed?: boolean | null;
  showLapseInterstitial?: boolean | null;
}

interface SubscriptionState {
  /** Highest active entitlement per RevenueCat, or null when none. */
  tier: SubscriptionTier;
  /** Convenience flag: true when any paid tier is active per RevenueCat. */
  isPremium: boolean;
  /** Latest CustomerInfo from RevenueCat (null until first sync). */
  customerInfo: CustomerInfo | null;

  /**
   * `subscriptionTier` as last read from OUR server — the source of truth.
   * `null` means "never heard from the server", NOT "no subscription"; the
   * difference is what keeps `aiAccess` at `'unknown'` instead of flashing a
   * lock at a paying user on cold start.
   */
  serverTier: string | null;
  /** Server-derived: has this user ever held a paid tier. `null` until known. */
  hasEverSubscribed: boolean | null;
  /** Server-derived: is an unacknowledged lapse interstitial owed. `null` until known. */
  showLapseInterstitial: boolean | null;

  /** Replace the CustomerInfo and derive tier/isPremium from it. */
  setCustomerInfo: (info: CustomerInfo | null) => void;
  /** Push a `userBilling` snapshot from the server. Wins over RevenueCat. */
  setServerBilling: (billing: ServerBillingSnapshot | null) => void;
  /**
   * Record that the server refused a guarded AI query with a 402.
   *
   * Deliberately writes `serverTier: 'none'` rather than adding a separate
   * "locked" latch: a 402 *is* the server saying the tier is `none`, so this
   * keeps one field for one fact. A later `setServerBilling` — including the
   * forced one `recordAiLocked` kicks off — simply overwrites it, so a
   * mid-flight re-subscribe self-heals with no extra clearing logic.
   */
  markServerLocked: () => void;
  /** Clear the lapse flag locally once the ack mutation has been sent. */
  clearLapseInterstitial: () => void;
  /** Clear on logout / user switch. */
  reset: () => void;
}

const initialState = {
  tier: null as SubscriptionTier,
  isPremium: false,
  customerInfo: null as CustomerInfo | null,
  serverTier: null as string | null,
  hasEverSubscribed: null as boolean | null,
  showLapseInterstitial: null as boolean | null,
};

export const useSubscriptionStore = create<SubscriptionState>()((set) => ({
  ...initialState,

  setCustomerInfo: (info) => {
    const tier = getActiveTier(info);
    set({ customerInfo: info, tier, isPremium: tier !== null });
  },

  setServerBilling: (billing) => {
    if (!billing) return;
    // The ONE signal that lifts the /token 403 latch, and it is deliberately
    // this one: every path that can end a refusal — a purchase
    // (refreshUserBillingAfterPurchase on all four call sites),
    // presentFreeTierPaywall, and the periodic/foreground syncEntitlement —
    // lands here, and three of them never call syncEntitlement at all.
    //
    // Requires an EXPLICIT paid tier, using the same `undefined`-ignoring rule
    // as the setter below: the lapse-state query does not select
    // subscriptionTier, and `'none'` is the refusal, not a lift. This mirrors
    // the server's own `hasActiveSubscription` check, so the next getJwtToken()
    // is only re-armed when the gate it faces will actually pass.
    if (
      billing.subscriptionTier !== undefined &&
      billing.subscriptionTier !== null &&
      billing.subscriptionTier !== 'none'
    ) {
      clearJwtSubscriptionLock();
    }
    set({
      // `undefined` (a query that didn't select the field) must not erase a
      // value we already know; only an explicit value overwrites.
      ...(billing.subscriptionTier !== undefined
        ? { serverTier: billing.subscriptionTier ?? 'none' }
        : {}),
      ...(billing.hasEverSubscribed != null
        ? { hasEverSubscribed: billing.hasEverSubscribed }
        : {}),
      ...(billing.showLapseInterstitial != null
        ? { showLapseInterstitial: billing.showLapseInterstitial }
        : {}),
    });
  },

  markServerLocked: () => set({ serverTier: 'none' }),

  clearLapseInterstitial: () => set({ showLapseInterstitial: false }),

  // Every server-sourced field resets too. Leaving `serverTier` behind would
  // hand user B user A's entitlement for the rest of the session, and resetting
  // it to `'none'` rather than `null` would flash Mera News Free across a
  // logout → login round trip. `null` = "unknown", which is the truth here.
  reset: () => {
    // Otherwise user B inherits user A's /token refusal for the whole session
    // and never gets a JWT, whatever they are subscribed to.
    clearJwtSubscriptionLock();
    set({ ...initialState });
  },
}));

/** Reactive selector: is the user on any paid tier (RevenueCat's view). */
export const useIsPremium = () => useSubscriptionStore((s) => s.isPremium);

/** Reactive selector: the active subscription tier (or null). */
export const useSubscriptionTier = () => useSubscriptionStore((s) => s.tier);

function selectAiAccess(s: SubscriptionState): AiAccess {
  return deriveAiAccess({
    serverTier: s.serverTier,
    hasCustomerInfo: s.customerInfo !== null,
    isPremium: s.isPremium,
  });
}

/**
 * Reactive: is Mera's AI layer available. Returns a primitive, so components
 * re-render only when the verdict itself changes.
 */
export const useAiAccess = (): AiAccess => useSubscriptionStore(selectAiAccess);

/**
 * Imperative twin of `useAiAccess`, for the callers that are not components —
 * scheduler task conditions, the chat store's own actions, the 402 recorder.
 */
export function getAiAccess(): AiAccess {
  return selectAiAccess(useSubscriptionStore.getState());
}
