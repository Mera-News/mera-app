import type { ProcessingStageDef, ProcessingStageId } from './types';

/**
 * The six stages, in the order the progress bar draws them.
 *
 * Pure data: i18n KEY STRINGS only, no `t()` and no JSX, so this file can be
 * read by a test without a translation runtime and the keys can be asserted
 * against `en.json` directly.
 *
 * Analysing and summarising carry no pool: their headline is built from the
 * live scoring progress ("Reading 12 of 40 for you") in ProcessingArea, so the
 * old cloud and on-device pools (which promised a notification and claimed
 * nothing leaves the phone) are gone from the surface.
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
    headlinesKey: null,
    fallback: 'sweep',
  },
  {
    id: 'summarising',
    labelKey: 'feed.processing.stageLabels.summarising',
    headlinesKey: null,
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

/** Shown under the fetching stage only. Already translated everywhere, and its
 *  only previous reader was a component with no importers. */
export const FETCHING_SUBLINE_KEY = 'feed.processing.stages.fetching.amberSubline' as const;

export function stageDef(id: ProcessingStageId): StageDef {
  const found = PROCESSING_STAGES.find((s) => s.id === id);
  // Unreachable: `ProcessingStageId` is a closed union and the array is
  // exhaustive over it, asserted in
  // `__tests__/animation-assets.test.ts` ("the registry covers every stage id").
  if (!found) throw new Error(`[processing] unknown stage ${id}`);
  return found;
}
