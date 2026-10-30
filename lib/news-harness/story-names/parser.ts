// news-harness: story-names parser (PURE, RN-free).

import { jsonCandidates } from '@/lib/mera-protocol-toolkit/core/structured-json';
import { normalizeMustMatch } from '../core/must-match';

/**
 * The normalized names from raw model output. Reads the LAST JSON object that
 * carries a `mustMatch` array (a leaked thinking trace can draft one earlier),
 * so `{"mustMatch": []}` is a valid answer meaning "no names". Throws when no
 * such object exists: the handler then writes nothing.
 */
export function parseStoryNamesOutput(raw: string): string[] {
  const text = (raw ?? '').trim();
  const candidates = jsonCandidates(text, '{');
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[i]);
    } catch {
      continue;
    }
    const names = (parsed as { mustMatch?: unknown } | null)?.mustMatch;
    if (Array.isArray(names)) return normalizeMustMatch(names);
  }
  throw new Error('story-names: no mustMatch object in model output');
}
