// The World variant of the Arrange overlay, as pure functions: the country
// list behind the add field, its search, and the commit of a draft.
// RN-free and i18n-free so each rule is tested on its own (WorldPages wires
// them to the overlay, the services and the translated note).

import countries from 'i18n-iso-countries';

import { alpha2OfPage, countryPageId } from '@/components/custom/nav/page-registry';
import type { ArrangeCountryOption, ArrangeDraft } from '@/components/custom/nav/types';
import { getCountryName } from '@/lib/country-utils';

/**
 * Countries the add field can offer, from the server's alpha-3 list (the one
 * Sources lists; `AccountService.getAllCountries`). The `GLOBAL` sentinel and
 * any code with no alpha-2 (World pages are keyed by alpha-2) are dropped.
 * Names are English: `lib/country-utils` registers `en` only, a known limit
 * shared with Sources' country search.
 */
export function toCountryOptions(alpha3s: readonly string[]): ArrangeCountryOption[] {
    const out: ArrangeCountryOption[] = [];
    const seen = new Set<string>();
    for (const raw of alpha3s) {
        const a3 = raw.trim().toUpperCase();
        if (!a3 || a3 === 'GLOBAL') continue;
        const a2 = countries.alpha3ToAlpha2(a3);
        if (!a2 || seen.has(a2)) continue;
        seen.add(a2);
        out.push({ alpha2: a2, name: getCountryName(a3) });
    }
    return out;
}

/**
 * Matches for the add field: names containing the query (case-insensitive),
 * those STARTING with it first ("Fra": France, French Polynesia, before
 * "Saint Pierre and Miquelon"), then by name. An empty query offers nothing.
 *
 * Every country, saved pages included, and no limit: the overlay drops what
 * is still in its draft (`filterAddable`) and only then cuts the list.
 * Excluding SAVED pages here made a country × 'd in the same draft impossible
 * to find again, and a limit applied first let drafted countries eat the
 * slots.
 */
export function searchCountryOptions(
    options: readonly ArrangeCountryOption[],
    query: string,
): ArrangeCountryOption[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = options.filter((o) => o.name.toLowerCase().includes(q));
    const rank = (o: ArrangeCountryOption) => (o.name.toLowerCase().startsWith(q) ? 0 : 1);
    return hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export interface WorldEditPorts {
    readonly addCountry: (alpha2: string) => Promise<void>;
    readonly removeCountry: (alpha2: string) => Promise<void>;
    readonly saveOrder: (ids: readonly string[]) => void;
}

/**
 * Commit a ✓'d draft: removals, then additions, then the order. Removed ids
 * leave the stored order (so a later re-add lands at the end, not in a stale
 * slot); added countries the overlay did not place are appended. World is
 * never removed (the overlay offers no ×), and a stray id is ignored here too.
 */
export async function commitWorldDraft(draft: ArrangeDraft, ports: WorldEditPorts): Promise<void> {
    const removed = new Set<string>(draft.removed.filter((id) => id !== 'world'));
    for (const id of removed) {
        const a2 = alpha2OfPage(id);
        if (a2) await ports.removeCountry(a2);
    }
    const addedIds: string[] = [];
    for (const a2 of draft.added) {
        await ports.addCountry(a2);
        addedIds.push(countryPageId(a2.trim()));
    }
    const order = draft.order.filter((id) => !removed.has(id)) as string[];
    for (const id of addedIds) if (!order.includes(id)) order.push(id);
    ports.saveOrder(order);
}
