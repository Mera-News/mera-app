// World tab pages: World plus one page per country, in the user's order.
//
// Countries come from the existing scope derivation (lib/explore/scopes.ts:
// primary country, location countries, browse countries), minus hidden ones
// (`explore_suppressed_scopes`), then the stored `nav_order_world` is applied
// (lib/navigation/page-order.ts). City and region scopes are not derived at
// all, so World never has a city or region page; the places stay in Profile.
//
// TWO id formats meet here, and this file is the only place that converts:
//   page id   `country:<alpha2>` (`country:DE`), used by the nav shell, the
//             stored order and the Mera button;
//   scope id  `country:<ALPHA3>` (`country:DEU`), used by the scope list and
//             the backed-up `explore_suppressed_scopes` row. Never migrated.
// The page id comes from the scope's own `countryCodeAlpha2`, so no lookup
// table is involved. Kosovo is XK / XKK here (i18n-iso-countries), not XKX.
//
// Origin decides what removing a page does:
//   place  : a location's country, or the device-region fallback when there
//            are no locations. Removing HIDES it (suppress); the place and its
//            geo signal stay.
//   browse : added from World or Sources. Removing deletes it from the browse
//            set; nothing sits underneath it.
// A country that is both reads as `place`, the representation the page carries.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import logger from '@/lib/logger';
import { applyPageOrder, usePageOrderStore, type CountryPageId } from '@/lib/navigation/page-order';
import { addBrowseCountry, getBrowseCountries, removeBrowseCountry } from './browse-countries';
import { getDeviceCountryAlpha2 } from './device-country';
import {
    alpha2ToAlpha3,
    deriveExploreScopes,
    electPrimaryCountry,
    type ExploreScope,
    type ScopeLocationInput,
} from './scopes';
import { addSuppressedScopeId, getSuppressedScopeIds, removeSuppressedScopeId } from './suppressed-scopes';

export type WorldPageId = 'world' | CountryPageId;
export type WorldPageOrigin = 'world' | 'place' | 'browse';

export interface WorldPage {
    readonly id: WorldPageId;
    readonly scope: ExploreScope;
    readonly origin: WorldPageOrigin;
}

export interface WorldPageInputs {
    readonly locations: readonly ScopeLocationInput[];
    readonly deviceCountryAlpha2: string | null | undefined;
    readonly browseCountries: readonly string[];
    readonly suppressedScopeIds: readonly string[];
    readonly storedOrder: readonly string[] | null | undefined;
}

/** Alpha-3 codes that come from places: the elected primary country (which
 *  may be the device region) plus every location's country. */
function placeAlpha3s(
    locations: readonly ScopeLocationInput[],
    deviceCountryAlpha2: string | null | undefined,
): Set<string> {
    const set = new Set<string>();
    const primary = electPrimaryCountry(locations, deviceCountryAlpha2);
    if (primary?.countryCodeAlpha3) set.add(primary.countryCodeAlpha3);
    for (const loc of locations) {
        const a3 = alpha2ToAlpha3(loc.countryCode);
        if (a3) set.add(a3);
    }
    return set;
}

/** The scope's page id: `world`, or `country:<alpha2>`. */
export function worldPageId(scope: ExploreScope): WorldPageId {
    return scope.kind === 'world' ? 'world' : `country:${scope.countryCodeAlpha2 ?? ''}`;
}

/** World pages in display order. Pure. */
export function deriveWorldPages(input: WorldPageInputs): WorldPage[] {
    const suppressed = new Set(input.suppressedScopeIds);
    const places = placeAlpha3s(input.locations, input.deviceCountryAlpha2);
    const pages: WorldPage[] = [];
    for (const scope of deriveExploreScopes(input.locations, input.deviceCountryAlpha2, input.browseCountries)) {
        if (scope.kind === 'world') {
            pages.push({ id: 'world', scope, origin: 'world' });
        } else if (scope.kind === 'country' && scope.countryCodeAlpha2 && !suppressed.has(scope.id)) {
            const origin = places.has(scope.countryCodeAlpha3 ?? '') ? 'place' : 'browse';
            pages.push({ id: worldPageId(scope), scope, origin });
        }
    }
    const byId = new Map(pages.map((p) => [p.id as string, p]));
    return applyPageOrder(input.storedOrder, pages.map((p) => p.id)).map((id) => byId.get(id)!);
}

// ── Writes ──────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
function notify(): void {
    for (const l of listeners) l();
}

function normalizeAlpha2(alpha2: string): string {
    return alpha2.trim().toUpperCase();
}

function locationService(): typeof import('@/lib/database/services/location-service') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/lib/database/services/location-service');
}

/** Add a country page (alpha-2). Also un-hides it: a hidden place country
 *  would otherwise stay hidden behind the add. Same rule as Sources' "+". */
export async function addWorldCountry(alpha2: string): Promise<void> {
    const code = normalizeAlpha2(alpha2);
    const alpha3 = alpha2ToAlpha3(code);
    if (!alpha3) return;
    try {
        await Promise.all([addBrowseCountry(code), removeSuppressedScopeId(`country:${alpha3}`)]);
    } finally {
        notify();
    }
}

/** Remove a country page (alpha-2). Hides a place country, deletes a browse
 *  country. The origin is decided here from the current locations. */
export async function removeWorldCountry(alpha2: string): Promise<void> {
    const code = normalizeAlpha2(alpha2);
    const alpha3 = alpha2ToAlpha3(code);
    if (!alpha3) return;
    try {
        const locations: ScopeLocationInput[] = await locationService().getAll();
        if (placeAlpha3s(locations, getDeviceCountryAlpha2()).has(alpha3)) {
            await addSuppressedScopeId(`country:${alpha3}`);
        } else {
            await removeBrowseCountry(code);
        }
    } finally {
        notify();
    }
}

// ── The World-alone intro line ──────────────────────────────────────────────
// Shown while World is the only page and the pen has never been opened on
// World. Local only, not backed up, records nothing about reading.

export const WORLD_INTRO_DONE_SETTING_KEY = 'nav_world_intro_done';

function settings(): typeof import('@/lib/database/services/setting-service') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/lib/database/services/setting-service');
}

export async function readWorldIntroDone(): Promise<boolean> {
    try {
        return (await settings().getSetting(WORLD_INTRO_DONE_SETTING_KEY)) === '1';
    } catch {
        return false;
    }
}

/** Called when the pen opens on World (ArrangeConfig.onOpen). */
export async function markWorldIntroDone(): Promise<void> {
    try {
        await settings().setSetting(WORLD_INTRO_DONE_SETTING_KEY, '1');
    } catch (err) {
        logger.captureException(err, { tags: { module: 'world-pages', method: 'markWorldIntroDone' } });
    } finally {
        notify();
    }
}

/** null until read. */
export function useWorldIntroDone(): boolean | null {
    const [done, setDone] = useState<boolean | null>(null);
    useEffect(() => {
        let alive = true;
        const read = () => {
            void readWorldIntroDone().then((v) => {
                if (alive) setDone(v);
            });
        };
        read();
        listeners.add(read);
        return () => {
            alive = false;
            listeners.delete(read);
        };
    }, []);
    return done;
}

// ── The hook ────────────────────────────────────────────────────────────────

/** Keep the previous state when a re-read found nothing new, so equal re-reads
 *  return the SAME arrays (search scroll restore and every page panel's memo
 *  depend on it). The inputs are short, so a string compare is cheap. */
function keepIfEqual<T>(prev: T, next: T): T {
    return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/**
 * World pages for the World tab. Locations are observed only while the screen
 * is focused (tabs stay mounted); browse and hidden countries are re-read on
 * focus (another screen may have changed them) and after every add or remove.
 * `loaded` turns true once locations have emitted, so a caller never fetches
 * against the device-country fallback that shows before that.
 */
export function useWorldPages(): { pages: WorldPage[]; loaded: boolean } {
    const [locations, setLocations] = useState<ScopeLocationInput[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [browseCountries, setBrowseCountries] = useState<string[]>([]);
    const [suppressedScopeIds, setSuppressedScopeIds] = useState<string[]>([]);
    const storedOrder = usePageOrderStore((s) => s.stored.world);
    const deviceCountryAlpha2 = useMemo(() => getDeviceCountryAlpha2(), []);

    const readSettings = useCallback(() => {
        Promise.all([getBrowseCountries(), getSuppressedScopeIds()])
            .then(([browse, suppressed]) => {
                setBrowseCountries((prev) => keepIfEqual(prev, browse));
                setSuppressedScopeIds((prev) => keepIfEqual(prev, suppressed));
            })
            .catch((err: unknown) => {
                logger.captureException(err, { tags: { module: 'world-pages', method: 'readSettings' } });
            });
    }, []);

    useEffect(() => {
        listeners.add(readSettings);
        return () => {
            listeners.delete(readSettings);
        };
    }, [readSettings]);

    useFocusEffect(
        useCallback(() => {
            readSettings();
            const sub = locationService()
                .observeAll()
                .subscribe((rows) => {
                    const next = rows.map((l) => ({
                        city: l.city,
                        region: l.region,
                        countryCode: l.countryCode,
                        role: l.role,
                        weight: l.weight,
                    }));
                    setLocations((prev) => keepIfEqual(prev, next));
                    setLoaded(true);
                });
            return () => sub.unsubscribe();
        }, [readSettings]),
    );

    const pages = useMemo(
        () => deriveWorldPages({ locations, deviceCountryAlpha2, browseCountries, suppressedScopeIds, storedOrder }),
        [locations, deviceCountryAlpha2, browseCountries, suppressedScopeIds, storedOrder],
    );
    return { pages, loaded };
}
