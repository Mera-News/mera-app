// formatCount — locale-aware thousands-grouping for plain integer counts
// (article counts, cloud/device scoring progress numbers). Groups digits
// according to the app's ACTIVE UI language (`useAppLanguage`,
// lib/stores/app-language-store.ts), not the device's OS locale — the two
// can disagree, and these counters sit right next to copy already rendered
// in the UI language (feed-status sheet, header stats sentence).
//
// PURE: no RN / expo imports — takes the locale tag as a plain string so it
// unit-tests without an app-language store or a live i18n instance.
//
// NOT for percentages, durations, or ids — grouping digits in an id would be
// nonsensical, and percentages/durations have their own formatting rules.
// This is for plain counts only.

const FALLBACK_LOCALE = 'en';

/**
 * Formats a plain count with locale-appropriate thousands separators
 * (e.g. 149370 → "149,370" in en, "149.370" in de, "1,49,370" in hi).
 *
 * Falls back to `en` grouping when `locale` is missing or not a valid
 * BCP-47 tag (defensive — every caller today passes a code straight out of
 * `SUPPORTED_LANGUAGES`, which are all valid, but a bad/legacy stored value
 * should never crash a stat row). Non-finite input (`NaN`/`Infinity`) is
 * returned via `String()` rather than thrown or silently coerced to `'0'`.
 */
export function formatCount(value: number, locale: string | null | undefined): string {
    if (!Number.isFinite(value)) return String(value);
    try {
        return value.toLocaleString(locale || FALLBACK_LOCALE);
    } catch {
        return value.toLocaleString(FALLBACK_LOCALE);
    }
}
