// How the Saved page lays a list out: by date saved, by the reader's facts, or
// by priority. Pure, so it tests without a device. Priority is the score the
// row was saved with: a saved row is a snapshot and is never rescored.

import { pickMatchedFact, type PickableFact } from '@/components/custom/feedback-tree/pick-fact';
import type { SavedItem } from '@/lib/database/services/saved-article-suggestion-service';
import { bandOf } from '@/lib/news-harness/feed-select/ownership';

export const SAVED_GROUP_BY_SETTING = 'saved_group_by';

const GROUP_BYS = ['newest', 'facts', 'priority'] as const;
export type SavedGroupBy = (typeof GROUP_BYS)[number];

export const parseGroupBy = (stored: string | null): SavedGroupBy =>
  GROUP_BYS.find((g) => g === stored) ?? 'newest';

const PRIORITY_BANDS = ['EMERGENCY', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

export type SavedGroupHeading =
  | { kind: 'fact'; statement: string }
  | { kind: 'band'; band: PriorityBand }
  | { kind: 'no-priority' }
  | { kind: 'other' };

export interface SavedGroup {
  key: string;
  /** Null for the one flat group of `newest`. */
  heading: SavedGroupHeading | null;
  items: SavedItem[];
}

/** The fact an item sits under. `pickMatchedFact` answers with the first fact
 *  even when none shares a text, so only facts sharing one go in. */
function factOf(item: SavedItem, facts: readonly PickableFact[]) {
  const texts = item.origin === 'suggestion' ? (item.suggestion.userTopicIds ?? []) : [];
  if (texts.length === 0) return null;
  const sharing = facts.filter((f) => f.metadata?.topics?.some((t) => texts.includes(t)));
  return pickMatchedFact(sharing, texts);
}

function byPriority(items: readonly SavedItem[]): SavedGroup[] {
  const bands = new Map<string, SavedItem[]>();
  for (const item of items) {
    const band = bandOf(item.origin === 'suggestion' ? item.suggestion.relevance : null);
    bands.set(band, [...(bands.get(band) ?? []), item]);
  }
  const groups: SavedGroup[] = [];
  for (const band of PRIORITY_BANDS) {
    const found = bands.get(band);
    if (found) groups.push({ key: `band:${band}`, heading: { kind: 'band', band }, items: found });
  }
  const none = bands.get('SUB_GATE');
  if (none) groups.push({ key: 'no-priority', heading: { kind: 'no-priority' }, items: none });
  return groups;
}

function byFact(items: readonly SavedItem[], facts: readonly PickableFact[]): SavedGroup[] {
  const groups = new Map<string, SavedGroup>();
  const other: SavedItem[] = [];
  for (const item of items) {
    const fact = factOf(item, facts);
    if (!fact) {
      other.push(item);
      continue;
    }
    const group = groups.get(fact.id);
    if (group) group.items.push(item);
    else
      groups.set(fact.id, {
        key: `fact:${fact.id}`,
        heading: { kind: 'fact', statement: fact.statement },
        items: [item],
      });
  }
  const out = [...groups.values()];
  if (other.length > 0) out.push({ key: 'other', heading: { kind: 'other' }, items: other });
  return out;
}

/** `items` newest saved first, the order `loadSavedItems` gives: groups keep it
 *  inside, and fact groups are ordered by it. */
export function groupSavedItems(
  items: readonly SavedItem[],
  groupBy: SavedGroupBy,
  facts: readonly PickableFact[],
): SavedGroup[] {
  if (items.length === 0) return [];
  if (groupBy === 'priority') return byPriority(items);
  if (groupBy === 'facts') return byFact(items, facts);
  return [{ key: 'all', heading: null, items: [...items] }];
}
