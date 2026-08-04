// news-harness — tool-names: resolve a model-emitted tool name to a REAL tool.
//
// RN-free. Replaces a single hardcoded misspelling repair
// (`name === 'saveExtractedsFacts' ? 'saveExtractedFacts' : name`) that fixed
// exactly one observed typo and let every other variant fall through to
// "Unknown tool: X" — silently, from the user's point of view.
//
// The candidate list is always the agent's OWN live tool definitions, never a
// second hardcoded copy: a copy drifts (useLocalLLM's KNOWN_TOOLS had already
// drifted, carrying the misspelling as a literal member).

/** Levenshtein distance, capped for early exit. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Lowercase + strip everything that isn't a letter or digit, so
 *  `save_extracted_facts`, `Save-Extracted-Facts` and `saveExtractedFacts`
 *  all collapse to the same key. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolves `raw` to one of `known`, or null when nothing wins cleanly.
 *
 * Tiers, in order — the first that produces a UNIQUE winner returns:
 *   1. exact match
 *   2. case-insensitive match
 *   3. squashed match (separators/casing ignored)
 *   4. edit distance <= min(2, 20% of the name's length)
 *
 * Ambiguity always returns null rather than guessing: two candidates within the
 * distance threshold means we genuinely do not know which the model meant, and
 * inventing an answer could run the wrong tool.
 */
export function normalizeToolName(
  raw: string,
  known: readonly string[],
): string | null {
  const name = (raw ?? '').trim();
  if (!name || known.length === 0) return null;

  if (known.includes(name)) return name;

  const ciMatches = known.filter((k) => k.toLowerCase() === name.toLowerCase());
  if (ciMatches.length === 1) return ciMatches[0];

  const target = squash(name);
  const squashMatches = known.filter((k) => squash(k) === target);
  if (squashMatches.length === 1) return squashMatches[0];

  let best: string | null = null;
  let bestScore = Infinity;
  let tied = false;
  for (const k of known) {
    const limit = Math.min(2, Math.floor(squash(k).length * 0.2));
    if (limit < 1) continue;
    const d = editDistance(target, squash(k), limit);
    if (d > limit) continue;
    if (d < bestScore) {
      bestScore = d;
      best = k;
      tied = false;
    } else if (d === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}
