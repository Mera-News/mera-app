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

/** The prompt rule for `mustMatch`, one line in each chat's option rules. The
 *  harness's follow skill and `PROPOSE_TRACK_TOOL` carry literal copies (it
 *  imports nothing from here); tests pin them to these. */
export const MUST_MATCH_RULE =
  '- "mustMatch": 1-3 distinctive names (event, organisation, product or person) that any article about exactly this option must mention, written as English headlines write them: Latin script, no year, spelling variants in the spare slots. Never a city, region or country on its own: a place name alone lets in every other event held there. Leave it empty for a broad option that no single name covers.';

/** The `mustMatch` schema description, on every tool and structured schema that offers options. */
export const MUST_MATCH_DESCRIPTION =
  '1-3 distinctive names (event, organisation, product or person) any article about exactly this option must mention, as English headlines write them: Latin script, no year, spelling variants in the spare slots. Never a place name on its own. Empty for a broad option. NOT shown to the user.';
