// feed-select — cross-fact topic overlap core (PURE, RN-free).
//
// Finds normalized topic texts owned by two or more distinct facts, the raw
// input for the persona hygiene duplicate detector (fact-hygiene.ts). No
// imports of lib/database, lib/stores, expo, react-native, or watermelondb.

// ── Cross-fact topic overlap (dupe detector raw input) ─────────────────────

export interface TopicOverlapGroup {
  normalizedText: string;
  topicIds: string[];
  factIds: string[];
}

/**
 * Groups topics by `normalizedText` where the SAME normalized text is owned by
 * ≥2 DISTINCT facts — the raw input for the cross-fact duplicate detector.
 * Topics with no owning fact (factId null) are ignored (they can't create a
 * cross-fact dupe). Single-fact duplicates (same text, one fact) are NOT
 * grouped. Output is deterministic: groups sorted by normalizedText, ids sorted.
 */
export function findTopicOverlapAcrossFacts(
  topics: { id: string; factId: string | null; normalizedText: string }[],
): TopicOverlapGroup[] {
  const byText = new Map<
    string,
    { topicIds: Set<string>; factIds: Set<string> }
  >();
  for (const t of topics) {
    if (!t.factId) continue;
    const key = t.normalizedText;
    let entry = byText.get(key);
    if (!entry) {
      entry = { topicIds: new Set(), factIds: new Set() };
      byText.set(key, entry);
    }
    entry.topicIds.add(t.id);
    entry.factIds.add(t.factId);
  }

  const groups: TopicOverlapGroup[] = [];
  for (const [normalizedText, entry] of byText) {
    if (entry.factIds.size < 2) continue;
    groups.push({
      normalizedText,
      topicIds: [...entry.topicIds].sort(),
      factIds: [...entry.factIds].sort(),
    });
  }
  groups.sort((a, b) =>
    a.normalizedText < b.normalizedText ? -1 : a.normalizedText > b.normalizedText ? 1 : 0,
  );
  return groups;
}
