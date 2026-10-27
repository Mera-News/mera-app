// Fold keys for a followed story's timeline: two member snapshots that share
// one fold the SAME story's copies into one entry at display time. Pure.
//
// `sk:<storyKey>` is the server's decision. The title keys catch copies the
// server did not link, and old snapshots that predate storyKey. The UTC day
// bucket stands in for a stoplist: a recurring title ("Morning briefing")
// lands in a different bucket every day, in every language, with no list to
// maintain. A copy straddling UTC midnight does not fold on the title key;
// the storyKey still folds it.

const MIN_TITLE_CHARS = 20;
const DAY_MS = 86_400_000;

/** NFKC, lowercase, punctuation stripped, whitespace collapsed. */
export function normalizeTitle(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FoldKeySource {
  storyKey?: string;
  title?: string;
  titleOriginal?: string;
  pubDateMs?: number;
}

/** Storykey first. Both titles are keys: a seed from before titleOriginal
 *  existed has only the English one, its copies only the original. */
export function foldKeysOf(snap: FoldKeySource): string[] {
  const keys: string[] = [];
  if (snap.storyKey) keys.push(`sk:${snap.storyKey}`);
  const ms = snap.pubDateMs ?? 0;
  if (ms > 0) {
    const day = Math.floor(ms / DAY_MS);
    for (const t of [snap.titleOriginal, snap.title]) {
      const n = normalizeTitle(t);
      if (n.length >= MIN_TITLE_CHARS) keys.push(`t:${n}:${day}`);
    }
  }
  return keys;
}
