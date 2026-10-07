// The fact page's numbers, in STORIES (owner Y1): Impactful is this fact's
// section from the Feed's own `buildFactRows` (so its count matches the
// sectioned header), Not impactful is what this fact's topics found in the
// last 48 hours and Mera left out, grouped into stories the same way. Both are
// in-memory selectors over the For You store: no new storage.

import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import {
    buildStoryGroups,
    CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    ENTITY_JACCARD_DISPLAY_THRESHOLD,
    pickRepresentative,
    TITLE_JACCARD_DISPLAY_THRESHOLD,
    WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
} from '@/lib/feed-grouping/story-grouping';
import { FEED_WINDOW_MS, isWithinWindow, relevancePassesGate } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** A story: its newest article and the rest. */
export interface Story {
    readonly data: ForYouSuggestion;
    readonly members: readonly ForYouSuggestion[];
}

function pubMs(s: ForYouSuggestion): number {
    const t = Date.parse(s.firstPubDate ?? '');
    return Number.isFinite(t) ? t : 0;
}

/** Found through this fact, then left out: below the bar, hidden by a filter
 *  (`excluded`) or already read. Rows still being scored are neither side. */
export function isLeftOut(s: ForYouSuggestion): boolean {
    if (s.status === ArticleSuggestionStatus.Excluded || s.status === ArticleSuggestionStatus.AlreadyRead) return true;
    return s.status === ArticleSuggestionStatus.Complete && !relevancePassesGate(s);
}

/**
 * This fact's left-out stories inside the 48-hour window, newest first.
 *
 * ponytail: grouped among themselves only, so one story with some articles
 * picked and some left out counts on both sides. Group across both pools if
 * the two totals ever need to be exact.
 */
export function leftOutStories(suggestions: readonly ForYouSuggestion[], factId: string, nowMs: number): Story[] {
    const cutoff = nowMs - FEED_WINDOW_MS;
    const pool = suggestions.filter(
        (s) => (s.factIds ?? []).includes(factId) && isWithinWindow(s, cutoff) && isLeftOut(s),
    );
    if (pool.length === 0) return [];
    const groups = buildStoryGroups(
        pool.map((s) => ({
            id: s._id,
            title: s.title_en ?? s.title_original ?? null,
            clusters: s.clusters ?? [],
            entities: s.entities,
            eventType: s.eventType,
            s,
        })),
        {
            titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
            clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
            weightedJaccardThreshold: WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
            entityJaccardThreshold: ENTITY_JACCARD_DISPLAY_THRESHOLD,
            ungateStableClusterEdge: true,
        },
    );
    return groups
        .map((g) => {
            const rep = pickRepresentative(g, (a, b) => pubMs(b.s) - pubMs(a.s)).s;
            return { data: rep, members: g.map((it) => it.s).filter((m) => m._id !== rep._id) };
        })
        .sort((a, b) => pubMs(b.data) - pubMs(a.data));
}

/**
 * Stories per topic of this fact, across both lists: a story counts once for
 * every topic any of its articles matched. Keyed by topic id, and by the
 * lower-cased text for matches that carry no id.
 */
export function storiesPerTopic(stories: readonly Story[]): (topic: { id: string; text: string }) => number {
    const byKey = new Map<string, number>();
    for (const story of stories) {
        const keys = new Set<string>();
        for (const s of [story.data, ...story.members]) {
            for (const m of s.matchedTopics ?? []) {
                if (m.topicId) keys.add(`id:${m.topicId}`);
                keys.add(`text:${m.text.trim().toLowerCase()}`);
            }
        }
        for (const k of keys) byKey.set(k, (byKey.get(k) ?? 0) + 1);
    }
    return (topic) => byKey.get(`id:${topic.id}`) ?? byKey.get(`text:${topic.text.trim().toLowerCase()}`) ?? 0;
}
