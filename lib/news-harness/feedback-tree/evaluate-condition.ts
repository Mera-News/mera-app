// evaluateCondition — PURE, RN-FREE. Gates a feedback-tree node's visibility
// against on-device context. No condition (undefined/empty) → visible. Only the
// keys this app schema understands are enforced; UNKNOWN keys are ignored
// (forward-compat — a newer server tree must not silently hide every node on a
// stale app).

import type { FeedbackTreeCondition, LocalFeedbackContext } from './types';

/**
 * True when every KNOWN gate in `visibleIf` is satisfied by `ctx`.
 * Unknown gate keys are ignored (do not block visibility).
 */
export function evaluateCondition(
  visibleIf: FeedbackTreeCondition | undefined,
  ctx: LocalFeedbackContext,
): boolean {
  if (!visibleIf) return true;

  if (typeof visibleIf.publication_visits_gte === 'number') {
    if ((ctx.publicationVisits ?? 0) < visibleIf.publication_visits_gte) return false;
  }
  if (typeof visibleIf.cluster_size_gte === 'number') {
    if ((ctx.clusterSize ?? 0) < visibleIf.cluster_size_gte) return false;
  }
  if (visibleIf.has_matched_topics === true) {
    const hasReal = (ctx.matchedTopics ?? []).some((t) => !!t.topicId);
    if (!hasReal) return false;
  }
  if (visibleIf.has_geo_mismatch === true) {
    if (!ctx.hasGeoMismatch) return false;
  }
  if (visibleIf.has_event_type === true) {
    if (!ctx.eventType?.trim()) return false;
  }
  // Entities are present on ~70% of SERVED articles (measured 2026-08-10 over
  // 300 topic-linked prod rows). Without this branch the key would be an
  // UNKNOWN one, and unknown keys are ignored — so a typo here does not hide
  // the node, it SHOWS it on every entity-less article. Fails open, silently;
  // hence the explicit absent-context test.
  if (visibleIf.has_entity === true) {
    if (!ctx.entity?.trim()) return false;
  }

  return true;
}
