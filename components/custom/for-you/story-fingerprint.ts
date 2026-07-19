// Fingerprint helper for the For-You legacy story-grouping cache (perf item A3).
//
// The legacy `listData` memo in ForYouScreen runs the expensive union-find
// `buildStoryGroups` (title-Jaccard + cluster edges) over the whole visible set.
// That work only depends on each suggestion's IDENTITY and its CLUSTER
// MEMBERSHIPS + TITLE — never on its relevance/reason/score. So a score-only or
// reason-only feed update (the common case: the pipeline scores rows in place)
// must NOT re-run union-find.
//
// This fingerprint captures exactly the inputs `buildStoryGroups` keys on:
//   - `_id` — identity (and, transitively, the title: titles are immutable per
//     `_id` between syncs, so the id captures the title-edge input too).
//   - the cluster signature — the `clusterId`, `stableClusterId`, and
//     `confidence` of every membership, since all three drive (and gate) the
//     cluster/stable-cluster edges in `buildStoryGroups`.
//
// It deliberately excludes relevance/reason/status so the component's group
// cache stays warm across score/reason updates. Pure + RN-free so it unit-tests
// in isolation.

import type { ClusterMembership } from '@/lib/stores/for-you-store';

/**
 * Signature of a suggestion's cluster memberships — the fields
 * `buildStoryGroups` reads to build cluster (1) + stable-cluster (0) edges.
 * Order-sensitive (memberships are a server-ordered list); a reorder is treated
 * as a change, which is safe (over-invalidation only, never staleness).
 */
export function clustersSignature(clusters: ClusterMembership[]): string {
    if (clusters.length === 0) return '';
    let out = '';
    for (const c of clusters) {
        out += `${c.clusterId}~${c.stableClusterId ?? ''}~${c.confidence};`;
    }
    return out;
}

/**
 * Fingerprint of the visible suggestion set for the story-grouping cache. Equal
 * fingerprints ⇒ `buildStoryGroups` would produce identical groups, so the
 * cached id-groups can be reused. Any change to membership (add/remove/reorder),
 * to a cluster edge input, or to a title (via `_id`) changes the fingerprint.
 */
export function computeGroupingFingerprint(
    visible: readonly { _id: string; clusters: ClusterMembership[] }[],
): string {
    let fp = '';
    for (const s of visible) {
        fp += `${s._id}:${clustersSignature(s.clusters)}|`;
    }
    return fp;
}
