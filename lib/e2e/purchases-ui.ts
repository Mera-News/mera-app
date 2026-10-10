// react-native-purchases-ui for the E2E build only: metro.config.js resolves the package here when
// EXPO_PUBLIC_E2E=1 (the same flag app.config.js's e2e branch keys on). The E2E build carries no
// RevenueCat key, so the native paywall cannot run; this asks the mock backend's scenario what the
// paywall resolves to (test/mock-backend/paywall.ts). Every other build bundles the real package.
import { GRAPHQL_SERVER_ENDPOINT } from '@/lib/config/endpoints';

// Values copied from @revenuecat/purchases-typescript-internal's PAYWALL_RESULT.
export enum PAYWALL_RESULT {
    NOT_PRESENTED = 'NOT_PRESENTED',
    ERROR = 'ERROR',
    CANCELLED = 'CANCELLED',
    PURCHASED = 'PURCHASED',
    RESTORED = 'RESTORED',
}

async function presentPaywall(): Promise<PAYWALL_RESULT> {
    const res = await fetch(new URL('/__e2e/paywall', GRAPHQL_SERVER_ENDPOINT).toString(), { method: 'POST' });
    if (!res.ok) return PAYWALL_RESULT.ERROR;
    return ((await res.json()) as { result: PAYWALL_RESULT }).result;
}

async function presentCustomerCenter(): Promise<void> {}

const RevenueCatUI = { presentPaywall, presentPaywallIfNeeded: presentPaywall, presentCustomerCenter };
export default RevenueCatUI;
