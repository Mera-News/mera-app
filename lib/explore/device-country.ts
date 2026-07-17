// Explore tab — device-locale country resolver.
//
// Mirrors `resolveDeviceLocale` in lib/stores/app-language-store.ts, but reads
// the region (country) rather than the language. Returns ISO alpha-2 (e.g.
// 'US'), falling back to 'US' when the OS reports no region — matching the
// app's existing default-locale behaviour.

import { getLocales } from 'expo-localization';

const FALLBACK_ALPHA2 = 'US';

/** The device region as an ISO alpha-2 country code (upper-cased). */
export function getDeviceCountryAlpha2(): string {
    const region = getLocales()[0]?.regionCode;
    const trimmed = region?.trim();
    return trimmed ? trimmed.toUpperCase() : FALLBACK_ALPHA2;
}
