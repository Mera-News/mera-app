// Menu logic for the tutorials screen. Pure — the screen renders what this
// returns and owns no rules of its own.

import { TUTORIAL_CHAPTERS, chaptersAtLevel } from './chapters';
import type { ChapterId, ChapterLevel, TutorialChapter } from './types';

/**
 * Completed BASIC chapters required before "Go deeper" appears.
 *
 * Three, not one and not all seven: the advanced chapters describe controls
 * (mute vs downrank, filter expiry, the importance dial) whose vocabulary the
 * basics establish, and someone who has read none of them will read "a downrank
 * is not a block" as a distinction without a difference. Seven would hide the
 * chapter with the highest value — `chat` — behind an hour of reading.
 */
export const ADVANCED_UNLOCK_THRESHOLD = 3;

export interface MenuRow {
  readonly chapter: TutorialChapter;
  readonly completed: boolean;
}

export interface MenuSection {
  readonly level: ChapterLevel;
  readonly rows: readonly MenuRow[];
}

export interface MenuModel {
  readonly sections: readonly MenuSection[];
  /** Completed chapters across BOTH levels — what the "X of Y done" line shows. */
  readonly completedCount: number;
  readonly totalCount: number;
  /** How many more basics are needed before "Go deeper" unlocks. 0 once open. */
  readonly advancedRemaining: number;
}

/** Completed BASIC chapters only — the advanced gate does not count itself. */
export function countCompletedBasics(completed: ReadonlySet<string>): number {
  return chaptersAtLevel('basic').filter((c) => completed.has(c.id)).length;
}

export function isAdvancedUnlocked(completed: ReadonlySet<string>): boolean {
  return countCompletedBasics(completed) >= ADVANCED_UNLOCK_THRESHOLD;
}

/**
 * The whole menu, derived from the completion set.
 *
 * The advanced SECTION is omitted while locked rather than rendered disabled:
 * a row the user cannot open is a dead end, and the "N more to go" line the
 * screen prints from `advancedRemaining` says the same thing without pretending
 * to be tappable.
 */
export function buildMenuModel(completed: ReadonlySet<string>): MenuModel {
  const unlocked = isAdvancedUnlocked(completed);
  const levels: ChapterLevel[] = unlocked ? ['basic', 'advanced'] : ['basic'];

  const sections = levels.map((level) => ({
    level,
    rows: chaptersAtLevel(level).map((chapter) => ({
      chapter,
      completed: completed.has(chapter.id),
    })),
  }));

  return {
    sections,
    completedCount: TUTORIAL_CHAPTERS.filter((c) => completed.has(c.id)).length,
    totalCount: TUTORIAL_CHAPTERS.length,
    advancedRemaining: unlocked
      ? 0
      : ADVANCED_UNLOCK_THRESHOLD - countCompletedBasics(completed),
  };
}

/**
 * The chapter to open when the user taps "Continue" — the first incomplete one
 * they can actually reach. Falls back to the first chapter once everything is
 * done, so "watch again" always has a target.
 */
export function nextChapterId(completed: ReadonlySet<string>): ChapterId {
  const reachable = isAdvancedUnlocked(completed)
    ? TUTORIAL_CHAPTERS
    : chaptersAtLevel('basic');
  const pending = reachable.find((chapter) => !completed.has(chapter.id));
  return (pending ?? TUTORIAL_CHAPTERS[0]).id;
}
