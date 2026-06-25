import { create } from 'zustand';
import type { CustomerInfo } from 'react-native-purchases';
import { getActiveTier, type SubscriptionTier } from '@/lib/revenuecat';

interface SubscriptionState {
  /** Highest active entitlement, or null when none. */
  tier: SubscriptionTier;
  /** Convenience flag: true when any paid tier is active. */
  isPremium: boolean;
  /** Latest CustomerInfo from RevenueCat (null until first sync). */
  customerInfo: CustomerInfo | null;

  /** Replace the CustomerInfo and derive tier/isPremium from it. */
  setCustomerInfo: (info: CustomerInfo | null) => void;
  /** Clear on logout / user switch. */
  reset: () => void;
}

export const useSubscriptionStore = create<SubscriptionState>()((set) => ({
  tier: null,
  isPremium: false,
  customerInfo: null,

  setCustomerInfo: (info) => {
    const tier = getActiveTier(info);
    set({ customerInfo: info, tier, isPremium: tier !== null });
  },

  reset: () => set({ tier: null, isPremium: false, customerInfo: null }),
}));

/** Reactive selector: is the user on any paid tier. */
export const useIsPremium = () => useSubscriptionStore((s) => s.isPremium);

/** Reactive selector: the active subscription tier (or null). */
export const useSubscriptionTier = () => useSubscriptionStore((s) => s.tier);
