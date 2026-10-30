// The names an article must mention to belong to a followed-story option.
// Pure. The server keeps an identical copy: change both together.

const MIN_CHARS = 3;
const MAX_CHARS = 60;
const MAX_NAMES = 3;

/**
 * The model's `mustMatch` cleaned: strings only, NFC, trimmed, 3 to 60 chars
 * (longer ones are dropped, never cut: half a name matches the wrong things),
 * deduped case-insensitively keeping the first, at most 3.
 */
export function normalizeMustMatch(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== 'string') continue;
    const name = entry.normalize('NFC').trim();
    if (name.length < MIN_CHARS || name.length > MAX_CHARS) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}
