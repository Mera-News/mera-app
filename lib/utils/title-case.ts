// toTitleCase — normalizes publisher names for display.
//
// PURE: no RN / expo imports.
//
// Publisher names come straight from RSS `<title>` elements and feed config,
// so a single feed list contains `NDTV`, `DIE WELT`, `globoesporte.com`,
// `barbados Today`, `myMetro` and `www.wirtualnemedia.pl`. Blindly capitalizing
// every word turns `NDTV` into `Ndtv`, which reads as a bug; blindly leaving
// them alone keeps the shouting and the stray lowercase. The rules below split
// the difference, biased toward never mangling a recognizable brand.

/** Words kept verbatim: initialisms and brand tokens carrying digits. */
function isAcronym(word: string): boolean {
    const letters = word.replace(/[^\p{L}\p{N}]/gu, '');
    if (!letters) return false;
    if (letters !== letters.toUpperCase()) return false; // has lowercase → not shouting
    if (/\d/.test(letters)) return true; // G1, 3FM, E24
    if (letters.length <= 3) return true; // ABC, TSA, RFI
    return !/[AEIOUÀ-ÖØ-Þ]/.test(letters); // NDTV, HLN, RTVNK
}

/** A brand that already chose its own casing — dzFoot, myMetro, McClatchy. */
function hasInternalCapital(word: string): boolean {
    return /^.[^\p{Lu}]*\p{Lu}/u.test(word) && word !== word.toUpperCase();
}

function capitalizeFirst(word: string): string {
    const index = word.search(/\p{L}|\p{N}/u);
    if (index < 0) return word;
    return word.slice(0, index) + word[index].toUpperCase() + word.slice(index + 1);
}

/**
 * Title-cases a publisher name, preserving initialisms and deliberate brand
 * casing. Returns the input unchanged when it is empty or non-Latin (CJK,
 * Arabic, Devanagari names have no case to fix).
 */
export function toTitleCase(name: string | null | undefined): string {
    if (!name) return '';
    // A leading `www.` is feed plumbing, not part of the name.
    const cleaned = name.trim().replace(/^www\./i, '');
    if (!cleaned) return '';

    return cleaned
        .split(/(\s+)/)
        .map((word) => {
            if (!word.trim()) return word; // preserve the original spacing
            if (isAcronym(word)) return word;
            if (hasInternalCapital(word)) return word;
            return capitalizeFirst(word.toLowerCase());
        })
        .join('');
}
