// Canonicalization of the language codes that reach the app from the feed.
//
// Prod `original_language_code` values are messy — CLD3 output, publisher-
// declared RSS tags and hand-entered feed config all land in the same field.
// A single day of production data contains `zh`, `ES`, `fr-fr`, `de-de`,
// `pt-pt`, `id-ID`, `iw`, `ja-Latn`, `sr-me` and ~100 other primary subtags.
// Every consumer (translation support, display names) has to agree on how
// those collapse, so the collapsing lives here and nowhere else.

/** Legacy / deprecated ISO 639-1 codes still emitted by some publishers. */
const LEGACY_ALIASES: Record<string, string> = {
    iw: 'he', // Hebrew — pre-1989 code, still used by older tooling
    in: 'id', // Indonesian
    ji: 'yi', // Yiddish
    mo: 'ro', // Moldovan → Romanian
    fil: 'tl', // Filipino → Tagalog (the code ML Kit uses)
    nb: 'no', // Norwegian Bokmål → Norwegian
    nn: 'no', // Norwegian Nynorsk → Norwegian
};

/**
 * Regions whose Chinese is written in Traditional script. Anything else
 * (including a bare `zh`, which is overwhelmingly Mainland in this feed)
 * resolves to Simplified.
 */
const TRADITIONAL_CHINESE_REGIONS = new Set(['tw', 'hk', 'mo']);

/**
 * Collapse an arbitrary BCP-47-ish tag to the canonical code the rest of
 * the app keys off.
 *
 * - the primary subtag is lowercased (prod sends `ES`, `ID`, `fr-fr`)
 * - Chinese always resolves to `zh-Hans` or `zh-Hant`, never bare `zh`,
 *   because script — not region — is what decides translatability
 * - every other language collapses to its primary subtag; region and
 *   script are dropped (`pt-BR` → `pt`, `ja-Latn` → `ja`)
 *
 * Returns null for empty/unusable input.
 */
export function canonicalizeLanguageCode(
    code: string | null | undefined,
): string | null {
    if (!code) return null;
    const parts = code.trim().split(/[-_]/).filter(Boolean);
    if (parts.length === 0) return null;

    let primary = parts[0].toLowerCase();
    if (!primary) return null;
    primary = LEGACY_ALIASES[primary] ?? primary;

    if (primary === 'zh') {
        // Script subtag wins when present; otherwise infer from the region.
        const script = parts.find((p) => /^[A-Za-z]{4}$/.test(p))?.toLowerCase();
        if (script === 'hant') return 'zh-Hant';
        if (script === 'hans') return 'zh-Hans';
        const region = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p))?.toLowerCase();
        return region && TRADITIONAL_CHINESE_REGIONS.has(region) ? 'zh-Hant' : 'zh-Hans';
    }

    // Cantonese is a distinct language, not a Chinese script variant.
    if (primary === 'yue') return 'yue';

    return primary;
}

/**
 * The primary subtag of a canonical code — `zh-Hans` → `zh`, `fr` → `fr`.
 * Used by lookups keyed on ISO 639-1 alone (display-name tables, ML Kit).
 */
export function primarySubtag(canonical: string): string {
    return canonical.split('-')[0];
}
