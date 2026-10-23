// A cursor page can repeat a publisher the list already holds; keys must stay unique.
export function appendNewPublishers<T extends { _id: string }>(prev: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(prev.map((p) => p._id));
  const fresh = incoming.filter((p) => !seen.has(p._id) && seen.add(p._id));
  return [...prev, ...fresh];
}
