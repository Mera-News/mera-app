/**
 * Classifies an error as a benign, recoverable network/abort failure — the kind
 * that is expected on flaky mobile connections and resolves itself on the next
 * trigger or app-foreground. These should be logged at most as `warning`, never
 * as `error`, so Sentry isn't flooded with noise we can't act on.
 *
 * Matches the production strings observed in Sentry, e.g.
 *   - "Unknown error: The request timed out."
 *   - "Unknown error: The network connection was lost."
 *   - AbortError ("Aborted") from a fetch/timeout abort.
 */
export function isTransientNetworkError(err: unknown): boolean {
  // AbortError (request cancelled / timed out via AbortController).
  if (err instanceof Error && err.name === 'AbortError') return true;

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return false;

  return (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('network connection was lost') ||
    msg.includes('the network connection') ||
    msg.includes('connection was lost') ||
    msg.includes('network request failed') ||
    msg.includes('aborted') ||
    msg.includes('offline') ||
    msg.includes('econnreset') ||
    msg.includes('econnaborted') ||
    msg.includes('enotfound')
  );
}
