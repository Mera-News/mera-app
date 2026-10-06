// Pure display helpers for a publication, shared by the page and the Sources
// rows so a host, a badge or a monogram reads the same everywhere. No React,
// no i18n, no database.

import { secureUrlOrNull } from '@/lib/secure-url';

/**
 * The publication's HOMEPAGE link, upgraded to https. The catalogue stores
 * some homepages as `http://` (Denik.cz: `http://denik.cz/`), and the app
 * never opens a plaintext URL, so the header used to drop the link. For the
 * homepage ONLY, `http://` is rewritten to `https://` and the result still has
 * to pass `secureUrlOrNull`; a site that cannot serve https simply fails in
 * the in-app browser. Article links are NOT upgraded: this is a homepage rule,
 * kept here rather than in the shared `lib/secure-url.ts`.
 */
export function homepageUrlOf(url: string | null | undefined): string | null {
    const raw = (url ?? '').trim();
    const upgraded = /^http:\/\//i.test(raw) ? `https://${raw.slice('http://'.length)}` : raw;
    return secureUrlOrNull(upgraded);
}

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

/**
 * A stable hue (0-359) for a publication's monogram tile, from its name, so
 * each outlet keeps one recognisable colour everywhere it appears and two
 * outlets sharing a first letter still look different. FNV-1a over the
 * trimmed, lower-cased code points: deterministic across launches and
 * devices, no randomness, no lookup table.
 */
export function monogramHueOf(name: string | null | undefined): number {
    let hash = 0x811c9dc5;
    for (const ch of Array.from((name ?? '').trim().toLowerCase())) {
        hash ^= ch.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % 360;
}

/** The monogram tile's three inks from one hue: a deep tinted fill, a hairline
 *  in the same hue and a pale letter. Saturation and lightness are fixed, so
 *  every outlet sits at the same visual weight on a dark surface whatever its
 *  hue. Here, not in PublicationHeader, so a list row can draw the same tile
 *  without importing the header's browser module. */
export function monogramInks(hue: number): { fill: string; border: string; letter: string } {
    return {
        fill: `hsl(${hue}, 32%, 20%)`,
        border: `hsla(${hue}, 55%, 60%, 0.35)`,
        letter: `hsl(${hue}, 75%, 84%)`,
    };
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
