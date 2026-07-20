// news-harness — track-proposal strict-JSON parser (PURE, RN-free).

/**
 * Extract the `track` string from raw model output. Tolerates markdown code
 * fences and leading/trailing prose (extracts the first top-level {...} object),
 * and a bare JSON string. Throws when nothing usable can be recovered — the
 * caller treats a throw as "generation failed, show the retry state".
 */
export function parseTrackProposalOutput(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('track-proposal: empty model output');

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
      const track = (parsed as Record<string, unknown>).track;
      if (typeof track === 'string' && track.trim()) return track.trim();
    }
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  }

  throw new Error('track-proposal: no track proposal in model output');
}
