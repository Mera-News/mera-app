import type { ProcessingStageDef, ProcessingStageId } from './types';

/**
 * The six stages, in the order the progress bar draws them.
 *
 * Pure data: i18n KEY STRINGS only, no `t()` and no JSX, so this file can be
 * read by a test without a translation runtime and the keys can be asserted
 * against `en.json` directly.
 *
 * Three of the six headline pools were already translated in all twenty
 * dictionaries and shown to NOBODY: `stages.fetching` and its `amberSubline`
 * became unreachable when `FeedStatusShimmer` was deleted, and
 * `stages.cloudRelevance` / `cloudReasons` / `onDevice` render only inside the
 * status panel a reader has to open. The stage table puts all of them back on
 * the surface they were written for.
 */
export const PROCESSING_STAGES = [
  {
    id: 'fetching',
    labelKey: 'feed.processing.stageLabels.fetching',
    headlinesKey: 'feed.processing.stages.fetching.headlines',
    fallback: 'converge',
  },
  {
    id: 'downloading',
    labelKey: 'feed.processing.stageLabels.downloading',
    headlinesKey: 'feed.processing.stages.downloading.headlines',
    fallback: 'descend',
  },
  {
    id: 'grouping',
    labelKey: 'feed.processing.stageLabels.grouping',
    headlinesKey: 'feed.processing.stages.grouping.headlines',
    fallback: 'merge',
  },
  {
    id: 'analysing',
    labelKey: 'feed.processing.stageLabels.analysing',
    headlinesKey: 'feed.processing.stages.cloudRelevance.headlines',
    fallback: 'sweep',
  },
  {
    id: 'summarising',
    labelKey: 'feed.processing.stageLabels.summarising',
    headlinesKey: 'feed.processing.stages.cloudReasons.headlines',
    fallback: 'write',
  },
  {
    id: 'preparing',
    labelKey: 'feed.processing.stageLabels.preparing',
    headlinesKey: 'feed.processing.stages.preparing.headlines',
    fallback: 'stack',
  },
] as const satisfies readonly ProcessingStageDef[];

/** The registry's own row type, keys and all, so `t(def.labelKey)` stays typed
 *  rather than falling back to `tAny`. */
export type StageDef = (typeof PROCESSING_STAGES)[number];

/**
 * The on-device variant of the analysing stage's headlines.
 *
 * The stage is the same step in the same order either way, so it is one row
 * above rather than two; only the copy differs, because on-device scoring can
 * honestly say nothing leaves the phone and the cloud round trip cannot.
 */
export const ON_DEVICE_HEADLINES_KEY = 'feed.processing.stages.onDevice.headlines' as const;

/** Shown under the fetching stage only. Already translated everywhere, and its
 *  only previous reader was a component with no importers. */
export const FETCHING_SUBLINE_KEY = 'feed.processing.stages.fetching.amberSubline' as const;

export function stageDef(id: ProcessingStageId): StageDef {
  const found = PROCESSING_STAGES.find((s) => s.id === id);
  // Unreachable: `ProcessingStageId` is a closed union and the array is
  // exhaustive over it, which `processing-stages.test.ts` asserts.
  if (!found) throw new Error(`[processing] unknown stage ${id}`);
  return found;
}
