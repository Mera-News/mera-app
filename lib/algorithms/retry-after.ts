/** Parse a `Retry-After` header value (integer seconds) into ms, clamped to `maxMs`.
 *  Absent, empty, non-numeric or non-positive values fall back to `defaultMs`. */
export function retryAfterMs(
  raw: string | null | undefined,
  opts: { defaultMs: number; maxMs: number },
): number {
  const seconds = raw != null ? Number(raw) : NaN;
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : opts.defaultMs;
  return Math.min(ms, opts.maxMs);
}
