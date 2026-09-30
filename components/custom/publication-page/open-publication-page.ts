// The ONE way into the publication page, from every entry point: Sources rows,
// card publication names, the ••• "About this source" item, the detail
// screen's "Name ⓘ", Visited rows and story-timeline source names.
//
// Keying rule, which is the reason this file exists rather than five inline
// `router.push` calls: a page is opened by a PUBLISHER id when the caller has
// one (Sources, GraphQL articles), and otherwise by the raw publication name
// plus its country (on-device suggestion rows carry nothing else). It is NEVER
// opened by a feed id: feeds are not a concept the app shows.
//
// It is pure apart from the final push, and imports no database, Apollo or
// native module, so it is safe inside the card graph.

import { getCurrentPathname } from '@/lib/nav-state';
import { router } from 'expo-router';

export const PUBLICATION_ROUTE = '/logged-in/publication';

export type PublicationOrder = 'NEWEST' | 'TOP_HEADLINES';

/** What an entry point knows. At least one of `publisherId` and `rawName`
 *  must be non-empty, or nothing opens (`buildPublicationParams` -> null). */
export interface PublicationTarget {
    readonly publisherId?: string | null;
    readonly rawName?: string | null;
    readonly countryCode?: string | null;
}

export interface PublicationRouteParams {
    publisherId?: string;
    name?: string;
    country?: string;
    order?: 'TOP_HEADLINES';
}

/**
 * The route params for a target, or null when there is nothing to open (no
 * id and a blank name). A name travels with its id when both are known, so
 * the page can show it before the profile resolves; the id still wins for the
 * lookup.
 */
export function buildPublicationParams(
    target: PublicationTarget,
    order: PublicationOrder = 'NEWEST',
): PublicationRouteParams | null {
    const publisherId = target.publisherId?.trim() || undefined;
    const name = target.rawName?.trim() || undefined;
    const country = target.countryCode?.trim() || undefined;
    if (!publisherId && !name) return null;
    const params: PublicationRouteParams = {};
    if (publisherId) params.publisherId = publisherId;
    if (name) params.name = name;
    if (country) params.country = country;
    if (order === 'TOP_HEADLINES') params.order = 'TOP_HEADLINES';
    return params;
}

/** The identity keys a target is known by. An id and a name+country pair can
 *  name the same publication, so the page registers every key it learns. */
export function publicationKeysFor(target: {
    publisherId?: string | null;
    rawName?: string | null;
    countryCode?: string | null;
}): string[] {
    const keys: string[] = [];
    const id = target.publisherId?.trim();
    if (id) keys.push(`id:${id}`);
    const name = target.rawName?.trim();
    if (name) keys.push(`name:${name.normalize('NFC').toLowerCase()}|${(target.countryCode ?? '').trim().toUpperCase()}`);
    return keys;
}

// The publication currently on top of the stack, as registered by the page
// while it is focused. Module state, because the check runs outside React (a
// card handler) and only needs "is this the page already showing".
let onTopKeys: ReadonlySet<string> = new Set();

/** Called by the page on focus (with every key it knows) and on blur ([]). */
export function setPublicationOnTop(keys: readonly string[]): void {
    onTopKeys = new Set(keys);
}

/** Whether `target` is the publication already on top of the stack. */
export function isPublicationOnTop(target: PublicationTarget): boolean {
    if (getCurrentPathname() !== PUBLICATION_ROUTE || onTopKeys.size === 0) return false;
    return publicationKeysFor(target).some((k) => onTopKeys.has(k));
}

/**
 * Open the publication page. Returns whether it navigated: false for an empty
 * target, and false when that publication is already on top, so tapping a
 * card's source name inside the page's own list does not stack a copy.
 */
export function openPublicationPage(
    target: PublicationTarget,
    order: PublicationOrder = 'NEWEST',
): boolean {
    const params = buildPublicationParams(target, order);
    if (!params) return false;
    if (isPublicationOnTop(target)) return false;
    router.push({ pathname: PUBLICATION_ROUTE, params: { ...params } });
    return true;
}

export function __resetPublicationOnTopForTests(): void {
    onTopKeys = new Set();
}
