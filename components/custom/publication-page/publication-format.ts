// Pure display helpers for a publication, shared by the page and the Sources
// rows so a host, a badge or a monogram reads the same everywhere. No React,
// no i18n, no database.

/** `https://www.example.com/news/` -> `example.com`. Null when there is no
 *  usable host. Only the host is shown, never a path: a path is noise on a
 *  one-line row and can carry tracking segments. */
export function hostOf(url: string | null | undefined): string | null {
    const raw = (url ?? '').trim();
    if (!raw) return null;
    const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#:]+)/i.exec(raw) ?? /^([^/?#:\s]+\.[^/?#:\s]+)/.exec(raw);
    const host = m?.[1]?.toLowerCase().replace(/^www\./, '');
    return host || null;
}

/**
 * The monogram letter: the FIRST CODE POINT of the trimmed name, upper-cased
 * where the script has case. Not a grapheme: Hermes ships no
 * `Intl.Segmenter`, and for every script a publication name starts with in
 * practice (Latin, Cyrillic, Greek, CJK, Devanagari's base consonant, Arabic,
 * Thai) the first code point is the letter a reader would pick. `Array.from`
 * keeps a surrogate pair whole, which `charAt(0)` would split.
 */
export function monogramOf(name: string | null | undefined): string {
    const first = Array.from((name ?? '').trim())[0];
    return first ? first.toLocaleUpperCase() : '?';
}

// Official-source badge. A measured, deliberately narrow rule: ONLY
// `publication_type === 'government'` or `'regulator'` renders anything.
// Every other value, including null ("not classified yet"), renders nothing.
// A keyword derivation from free-text categories was built, measured and
// deleted (it badged "Android Authority" as an authority while missing real
// government outlets); do not reintroduce one.
export type SourceKind = 'government' | 'regulator';

export const SOURCE_KIND_META: Record<SourceKind, { key: 'sources.badgeGovernment' | 'sources.badgeRegulator'; color: string }> = {
    government: { key: 'sources.badgeGovernment', color: '#60a5fa' },
    regulator: { key: 'sources.badgeRegulator', color: '#34d399' },
};

export function sourceKindOf(publicationType: string | null | undefined): SourceKind | null {
    return publicationType === 'government' || publicationType === 'regulator' ? publicationType : null;
}

// Humanizes the structured taxonomy slugs for display. Deliberately NOT
// translated: they are raw server-side data values rendered as-is, not UI copy.
const humanizeSlug = (slug: string): string => slug.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function formatCategories(categories: readonly string[] | null | undefined): string | null {
    const parts = (categories ?? []).filter((c) => c && c.trim()).map(humanizeSlug);
    return parts.length > 0 ? parts.join(', ') : null;
}
