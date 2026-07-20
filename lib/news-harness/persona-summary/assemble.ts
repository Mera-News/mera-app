// news-harness — persona-summary assembler (PURE, RN-free).

import { MAX_STRING_CHARS, MAX_SUMMARY_STRINGS } from './config';
import type {
  PersonaSummaryDraft,
  PersonaSummaryFactInput,
  PersonaSummaryStringResult,
} from './types';

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

/**
 * Resolve drafts into storable results: map each draft's 1-based fact refs to
 * real fact ids (via the SAME ordered list passed to the prompt), union the
 * linked facts' topic ids, drop over-long or duplicate lines, and cap the
 * count. A draft with no valid refs is kept (it renders, but its sheet actions
 * that need a linked fact/topic are disabled).
 */
export function assemblePersonaSummaryStrings(
  drafts: PersonaSummaryDraft[],
  selected: PersonaSummaryFactInput[],
): PersonaSummaryStringResult[] {
  const results: PersonaSummaryStringResult[] = [];
  const seen = new Set<string>();

  for (const draft of drafts) {
    const text = draft.text.trim();
    if (!text || text.length > MAX_STRING_CHARS) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    const factIds: string[] = [];
    const topicIds: string[] = [];
    for (const ref of draft.factRefs) {
      const fact = selected[ref - 1];
      if (!fact) continue;
      factIds.push(fact.factId);
      topicIds.push(...fact.topicIds);
    }

    seen.add(key);
    results.push({
      text,
      linkedFactIds: unique(factIds),
      linkedTopicIds: unique(topicIds),
    });

    if (results.length >= MAX_SUMMARY_STRINGS) break;
  }

  return results;
}
