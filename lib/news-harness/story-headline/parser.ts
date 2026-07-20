// news-harness — story-headline strict-JSON parser (PURE, RN-free).

/**
 * Extract the `headline` string from raw model output. Tolerates markdown code
 * fences and leading/trailing prose (extracts the first top-level {...} object),
 * and a bare JSON string. Throws when nothing usable can be recovered — the
 * handler treats a throw as "leave the fallback title in place".
 */
export function parseStoryHeadlineOutput(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('story-headline: empty model output');

  const candidates: string[] = [];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  candidates.push(trimmed);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // not JSON — try the next candidate
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const headline = (parsed as Record<string, unknown>).headline;
      if (typeof headline === 'string' && headline.trim()) return headline.trim();
    }
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  }

  throw new Error('story-headline: no headline in model output');
}
