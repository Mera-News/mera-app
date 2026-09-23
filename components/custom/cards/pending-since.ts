import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/**
 * When a card's note started waiting: the moment its relevance was saved
 * (`scoredAt`), else when the row was written. The reason job follows the
 * relevance write, so this is the right start for the pending cap in
 * `StreamingIndicator`. Null when neither is known, which disables the cap.
 */
export function pendingSinceMs(
    s: Pick<ForYouSuggestion, 'scoredAt' | 'createdAt'> | null | undefined,
): number | null {
    if (!s) return null;
    if (typeof s.scoredAt === 'number' && Number.isFinite(s.scoredAt)) return s.scoredAt;
    const created = Date.parse(s.createdAt);
    return Number.isFinite(created) ? created : null;
}
