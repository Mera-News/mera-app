// User geo/language context — the RN-coupled loader + hook that BUILDS a
// `UserGeoLanguageContext` from on-device state, feeding the pure priority
// helpers in `lib/feed-grouping/geo-language-priority.ts`.
//
// This is the only geo/language file that touches WatermelonDB + the Zustand
// language store; everything downstream (representative election, the merged
// Related-Articles sort) stays pure and takes the built context as a parameter.
//
// Country-code formats collide here (see `lib/explore/scopes.ts`):
//   • `locations.countryCode` and the device country are ISO ALPHA-2.
//   • Article/publication `country_code` (what the priority helpers compare
//     against) is ISO ALPHA-3.
// So this loader converts every country to alpha-3 via `alpha2ToAlpha3` before
// putting it in the context; conversion failures are dropped (matching
// `deriveExploreScopes`).

import { useEffect, useState } from 'react';
import { getAll } from '@/lib/database/services/location-service';
import { alpha2ToAlpha3 } from '@/lib/explore/scopes';
import { getDeviceCountryAlpha2 } from '@/lib/explore/device-country';
import { useAppLanguage, useAppLanguageStore } from '@/lib/stores/app-language-store';
import { baseLang, type UserGeoLanguageContext } from '@/lib/feed-grouping/geo-language-priority';

/**
 * Resolve the user's geo/language context from on-device state:
 *
 *   • home     — the first `locations` row with `role === 'home'` (rows arrive
 *                weight-desc from `getAll()`), converted to alpha-3; falls back
 *                to the device country when there is no home row (or its code
 *                is unmappable), and to null when even that fails.
 *   • others   — the remaining location countries (all roles, weight order),
 *                converted to alpha-3, dropping conversion failures, deduped,
 *                and with the home country excluded so it never appears twice.
 *   • language — the app-UI language base tag (`useAppLanguageStore` state).
 *
 * The WHOLE body is wrapped in try/catch → `null` (fail open): a `null` context
 * degrades every downstream comparator to its legacy, geo/language-blind
 * behavior rather than throwing.
 *
 * BACKGROUND-TASK CAVEAT: in a background task (feed sync / inference) the
 * language store may not have hydrated yet and can still hold its default
 * `'en'`. That is harmless — it only softens the tier-2 "app language" match
 * for that one run; the country tiers (0/1) and everything else are unaffected.
 */
export async function loadUserGeoLanguageContext(): Promise<UserGeoLanguageContext | null> {
    try {
        const locations = await getAll(); // weight-desc (canonical ordering)

        const homeLoc = locations.find((l) => l.role === 'home');
        let homeCountryAlpha3: string | null = homeLoc
            ? alpha2ToAlpha3(homeLoc.countryCode)
            : null;
        if (homeCountryAlpha3 === null) {
            homeCountryAlpha3 = alpha2ToAlpha3(getDeviceCountryAlpha2());
        }

        const otherCountriesAlpha3: string[] = [];
        const seen = new Set<string>();
        if (homeCountryAlpha3 !== null) {
            seen.add(homeCountryAlpha3); // exclude the home country from "others"
        }
        for (const loc of locations) {
            const alpha3 = alpha2ToAlpha3(loc.countryCode);
            if (alpha3 === null || seen.has(alpha3)) {
                continue; // drop conversion failures + dedupe (incl. home)
            }
            seen.add(alpha3);
            otherCountriesAlpha3.push(alpha3);
        }

        const appLanguageBase = baseLang(useAppLanguageStore.getState().appLanguage);

        return { homeCountryAlpha3, otherCountriesAlpha3, appLanguageBase };
    } catch {
        return null; // fail open — legacy geo/language-blind behavior downstream
    }
}

/**
 * React hook: loads the user's geo/language context and re-loads it whenever the
 * app language changes. Returns `null` while loading (and on failure), which the
 * pure comparators handle gracefully as legacy behavior.
 */
export function useUserGeoLanguageContext(): UserGeoLanguageContext | null {
    const appLanguage = useAppLanguage();
    const [ctx, setCtx] = useState<UserGeoLanguageContext | null>(null);

    useEffect(() => {
        let cancelled = false;
        loadUserGeoLanguageContext().then((loaded) => {
            if (!cancelled) {
                setCtx(loaded);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [appLanguage]);

    return ctx;
}
