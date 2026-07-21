// dashboard-section-selector — pure selector for a Dashboard section's
// "highest priority" preview (the collapsed top-N shown before a section is
// expanded) and its "new since last visit" badge count.
//
// PURE: RN-free. Consumes `FactRowGroup` (built by fact-rows-selector) and
// returns plain data; no DB / expo / react-native imports, so it unit-tests
// without a device.

import type { FactRowGroup } from './fact-rows-selector';

/** Number of groups shown in a section's collapsed preview. */
export const SECTION_PREVIEW_COUNT = 3;

/**
 * Dashboard "highest priority" ordering: `highPriority` groups first, then
 * `rawScore` descending (`null` sorts after any number, as `-Infinity`), then
 * `createdAtMs` descending, then a stable tie-break on the representative
 * suggestion's id (`group.data._id`, the only stable identifier `FactRowGroup`
 * exposes — it has no id of its own) ascending.
 */
export function compareByPriority(a: FactRowGroup, b: FactRowGroup): number {
  if (a.highPriority !== b.highPriority) return a.highPriority ? -1 : 1;
  const ra = a.rawScore ?? Number.NEGATIVE_INFINITY;
  const rb = b.rawScore ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb - ra;
  if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
  return a.data._id < b.data._id ? -1 : a.data._id > b.data._id ? 1 : 0;
}

/** Top-N preview for a dashboard section. Non-mutating (copies before sort). */
export function selectTopGroups(
  groups: FactRowGroup[],
  limit: number = SECTION_PREVIEW_COUNT,
): FactRowGroup[] {
  return [...groups].sort(compareByPriority).slice(0, limit);
}

/**
 * True iff the group became visible in the section after the user's last
 * visit. Uses `addedMs` (not `createdAtMs`) — `addedMs` is when the story
 * became eligible/visible in the section (`scoredAt ?? createdAt`, per
 * fact-rows-selector), which is the right clock for a "new since last visit"
 * badge. `lastVisitedMs === undefined` (never visited) is treated as NOT new,
 * to avoid badge-spam the first time this feature ships.
 */
export function isGroupNew(group: FactRowGroup, lastVisitedMs: number | undefined): boolean {
  if (lastVisitedMs === undefined) return false;
  return group.addedMs > lastVisitedMs;
}

/** Count of groups that are "new" since `lastVisitedMs` (see `isGroupNew`). */
export function countNewGroups(groups: FactRowGroup[], lastVisitedMs: number | undefined): number {
  if (lastVisitedMs === undefined) return 0;
  return groups.filter((g) => isGroupNew(g, lastVisitedMs)).length;
}
