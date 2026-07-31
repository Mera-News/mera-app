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
import {
    getActive as getActivePublicationPreferences,
    observeActive as observeActivePublicationPreferences,
} from '@/lib/database/services/publication-preference-service';
import { alpha2ToAlpha3 } from '@/lib/explore/scopes';
import { getDeviceCountryAlpha2 } from '@/lib/explore/device-country';
import { useAppLanguage, useAppLanguageStore } from '@/lib/stores/app-language-store';
import {
    baseLang,
    normAlpha3,
    normPublicationName,
    type UserGeoLanguageContext,
} from '@/lib/feed-grouping/geo-language-priority';

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
        const pubPrefs = await getActivePublicationPreferences();

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

        // source-pref (D3). Only POSITIVE preferences (`weight > 0`) — a
        // downrank or a mute is a scoring/exclusion concern that already has its
        // own machinery; feeding one in here would make "shown less" also mean
        // "and it fronts the card", which is the opposite of what it promises.
        //
        // The two row kinds are told apart by `scopeKind` alone (source-pref
        // v47 / D6): a scope row's `publicationName` is a human LABEL ("India"),
        // never a publication, so it must not land in `preferredPublications`.
        const preferredPublications = new Set<string>();
        const preferredCountriesAlpha3 = new Set<string>();
        for (const p of pubPrefs) {
            if (p.weight <= 0) continue;
            if (p.scopeKind === 'country') {
                const a3 = normAlpha3(p.scopeValue);
                if (a3 !== null) preferredCountriesAlpha3.add(a3);
                continue;
            }
            if (p.scopeKind != null) continue; // unknown future scope kind — ignore, don't guess
            const name = normPublicationName(p.publicationName);
            if (name !== null) preferredPublications.add(name);
        }

        // Spread CONDITIONALLY — same idiom as `buildPersonaContext`'s
        // filters/proposal blocks. A user who has expressed NO source preference
        // gets a context object byte-identical to the pre-source-pref one, which
        // is the strongest available form of this wave's regression contract:
        // the legacy path is not "equivalent", it is the same object shape, and
        // the exact-match seam tests keep asserting it unchanged.
        return {
            homeCountryAlpha3,
            otherCountriesAlpha3,
            appLanguageBase,
            ...(preferredPublications.size > 0 ? { preferredPublications } : {}),
            ...(preferredCountriesAlpha3.size > 0 ? { preferredCountriesAlpha3 } : {}),
        };
    } catch {
        return null; // fail open — legacy geo/language-blind behavior downstream
    }
}

/**
 * React hook: loads the user's geo/language + source-preference context and
 * re-loads it whenever the app language changes OR the user's active source
 * preferences change. Returns `null` while loading (and on failure), which the
 * pure comparators handle gracefully as legacy behavior.
 *
 * source-pref: the preference subscription is LOAD-BEARING, not a nicety. The
 * whole feature is applied at render time, so "prefer Indian sources" is
 * supposed to take effect on the very next render — but a hook memoized on
 * `[appLanguage]` alone would not re-read the preferences until the language
 * changed or the screen remounted, and confirming a proposal in chat would
 * appear to do nothing. `observeActive()` emits on every insert/update/retire of
 * `publication_preferences`, including the executor's and the Activity undo's.
 *
 * The subscription only bumps a revision counter rather than holding the rows,
 * so the single source of truth for BUILDING a context stays
 * `loadUserGeoLanguageContext` (which background tasks call directly).
 */
export function useUserGeoLanguageContext(): UserGeoLanguageContext | null {
    const appLanguage = useAppLanguage();
    const [ctx, setCtx] = useState<UserGeoLanguageContext | null>(null);
    const [prefsRevision, setPrefsRevision] = useState(0);

    useEffect(() => {
        // Fail open, exactly like the loader: if the observable cannot be built
        // (no DB in a test/background context), the context simply stops
        // auto-refreshing — it never throws into the render tree.
        try {
            const sub = observeActivePublicationPreferences().subscribe(() => {
                setPrefsRevision((r) => r + 1);
            });
            return () => sub.unsubscribe();
        } catch {
            return undefined;
        }
    }, []);

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
    }, [appLanguage, prefsRevision]);

    return ctx;
}
