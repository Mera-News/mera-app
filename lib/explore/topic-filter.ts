// World's topic filter, pure: slugs, labels, and which topics the sheet offers. No RN.
import type { TFunction } from 'i18next';
import type { CanonicalTopic, CanonicalTopicFacet } from '@/lib/generated/graphql-types';

/** Level-1 topics that are not news topics (owner). */
export const EXCLUDED_TOPIC_PATHS: readonly string[] = ['/Reference'];

/** '/Arts & Entertainment' -> 'arts_entertainment': the suffix of `explore.topic.<slug>`. */
export function topicSlug(path: string): string {
    return path
        .replace(/^\//, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
}

/** The translated label when the app has one, else the server's. */
export function topicLabel(
    t: TFunction,
    topic: Pick<CanonicalTopic, 'path' | 'label'>,
): string {
    const key = `explore.topic.${topicSlug(topic.path)}`;
    // Computed key: no literal to type.
    const out = (t as unknown as (k: string, o: object) => string)(key, { defaultValue: '' });
    return out && out !== key ? out : topic.label;
}

export type TopicWithCount = { readonly topic: CanonicalTopic; readonly count: number };

/** Topics worth offering on this page: not excluded, count above zero, biggest first. */
export function visibleTopics(
    topics: readonly CanonicalTopic[],
    facets: readonly Pick<CanonicalTopicFacet, 'topicId' | 'count'>[],
): TopicWithCount[] {
    const counts = new Map(facets.map((f) => [f.topicId, f.count]));
    return topics
        .filter((tp) => !EXCLUDED_TOPIC_PATHS.includes(tp.path) && (counts.get(tp.id) ?? 0) > 0)
        .map((topic) => ({ topic, count: counts.get(topic.id) ?? 0 }))
        .sort((a, b) => b.count - a.count);
}

/** The pick if this page has stories for it, else null (show all). */
export function effectivePick(
    pick: string | null,
    facets: readonly Pick<CanonicalTopicFacet, 'topicId' | 'count'>[],
): string | null {
    if (!pick) return null;
    return facets.some((f) => f.topicId === pick && f.count > 0) ? pick : null;
}
