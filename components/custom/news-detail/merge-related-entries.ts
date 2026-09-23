/**
 * The suggestion route's related list is two blocks: the reader's own local
 * siblings first, then server pages. Both can carry the same article: the
 * first server page may go out before the local siblings are known (see
 * `use-related-pagination`'s settle refetch), a later page can re-serve a row,
 * and two local suggestion rows can point at one article. Rendering either
 * duplicate puts two children under one React key.
 *
 * So: one entry per article id, LOCAL WINS (it taps into the richer
 * suggestion-detail route and works offline), and the article on screen is
 * never listed as related to itself. Order within each block is preserved.
 */
export function mergeRelatedEntries<T extends { id: string }>(
    local: readonly T[],
    server: readonly T[],
    selfId: string | null | undefined,
): T[] {
    const seen = new Set<string>();
    if (selfId) seen.add(selfId);
    const out: T[] = [];
    for (const entry of [...local, ...server]) {
        if (!entry.id || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
    }
    return out;
}
