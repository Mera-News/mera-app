// Web search — the app's ONLY client for the inference gateway's
// `POST /v1/web-search` endpoint (item 13).
//
// WHAT LEAVES THE DEVICE: the query string, and nothing else. No facts, no
// feed, no topics, no persona. The request body is literally `{ query }`, and
// the Authorization header is the same session JWT every other gateway call
// already carries. The Brave API key lives only on the server — it is never in
// this bundle, and this module must never grow a provider SDK or key.
//
// This module does NOT decide whether searching is allowed. That gate is the
// caller's (lib/chat-tools/web-search-handler.ts checks the user's toggle
// before it ever reaches this file), which is why every function here is a
// straight transport concern.

import { getJwtToken } from '../auth-client';
import { INFERENCE_ENDPOINT } from '../config/endpoints';
import * as gatewayRateLimiter from '../llm/gateway-rate-limiter';
import logger from '../logger';

const WEB_SEARCH_API = `${INFERENCE_ENDPOINT}/v1/web-search`;

/** The server rejects anything outside this range with a 400 — mirrored here so
 *  a hopeless request is refused without a round trip. */
export const MIN_QUERY_CHARS = 2;
export const MAX_QUERY_CHARS = 200;

/** How long to wait before giving up. A chat turn is already waiting on this. */
const REQUEST_TIMEOUT_MS = 12_000;

/** The gateway's stable machine-readable "we did not search" code, emitted with
 *  a 503 by both `/v1/web-search` and `/v1/fact-check-claims`. Mirrors
 *  `SEARCH_UNAVAILABLE_CODE` in mera-inference-gateway/src/search-unavailable.ts.
 *  Kept as a literal type so a caller can branch on it exhaustively. */
export const SEARCH_UNAVAILABLE = 'search-unavailable';
export type SearchUnavailableCode = typeof SEARCH_UNAVAILABLE;

/** How long to hold off the shared gateway limiter after a 429. */
const THROTTLE_BACKOFF_MS = 30_000;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * THE CONTRACT CALLERS MUST BRANCH ON:
 *
 *   `{ ok: true,  results: [...] }` — we searched. Hits found.
 *   `{ ok: true,  results: []    }` — WE SEARCHED and the index had nothing.
 *                                     A real answer about the world.
 *   `{ ok: false, ... }`           — NO SEARCH HAPPENED. Never, under any
 *                                     circumstance, report this as "found
 *                                     nothing".
 *
 * `error` is prose written FOR THE MODEL — it is what the chat tool hands back
 * as the tool result, so it reads as instructions, not diagnostics. `code` is
 * the machine-readable sibling for callers that must make a decision rather
 * than a sentence (the fact-check runner marking a row `blocked`), and it is
 * set whenever the search BACKEND was unreachable or switched off, as opposed
 * to the caller's own query being unusable.
 */
export type WebSearchOutcome =
  | { ok: true; results: WebSearchResult[] }
  | { ok: false; error: string; status?: number; code?: SearchUnavailableCode };

/** Maps the endpoint's documented status codes to a message the MODEL reads.
 *  Written as instructions rather than diagnostics: the model's next move is
 *  what this string actually controls. */
function messageForStatus(status: number): string {
  switch (status) {
    case 400:
      return `Search rejected: the query must be between ${MIN_QUERY_CHARS} and ${MAX_QUERY_CHARS} characters. Rewrite it and try once more.`;
    case 401:
      return 'Search is unavailable right now (not authenticated). Answer without it and say you could not search.';
    case 429:
      return 'Search is rate-limited right now. Do not retry; answer without it and say so.';
    case 502:
      return 'The search provider failed. Do not retry; answer without it and say so.';
    case 503:
      // The load-bearing one. This status is what the gateway returns when it
      // never reached the search index at all — switched off, unconfigured, or
      // throttled upstream. Saying "no results" here would be a fabricated
      // all-clear, so the instruction has to forbid it explicitly.
      return 'Search is switched off or unreachable, so NOTHING was searched. Do not say you found nothing — say you were unable to search.';
    default:
      return `Search failed (HTTP ${status}). Answer without it and say so.`;
  }
}

/** Reads the gateway's `{ code }` off a non-OK body without ever throwing. A
 *  Cloud Run 503 (as opposed to ours) carries no JSON at all, and it means the
 *  same thing anyway, so the status alone is enough to conclude the code. */
export async function readUnavailableCode(
  response: { status: number; json: () => Promise<unknown> },
): Promise<SearchUnavailableCode | undefined> {
  if (response.status !== 503 && response.status !== 429) return undefined;
  try {
    const body = (await response.json()) as { code?: unknown };
    if (body?.code === SEARCH_UNAVAILABLE) return SEARCH_UNAVAILABLE;
  } catch {
    // A body-less or non-JSON 503 is still an unavailability — fall through.
  }
  return SEARCH_UNAVAILABLE;
}

/**
 * Runs one web search. Never throws — every failure is returned as
 * `{ ok: false }` so a chat turn degrades into "I could not search" instead of
 * dying.
 *
 * WHY THERE IS NO "EMPTY MEANS THE FLAG IS OFF" BRANCH ANY MORE. This client
 * used to document an empty array as an unconditional success *because the
 * gateway returned `{results: []}` when its own feature flag was off*. That made
 * a missing env var indistinguishable from a real zero-hit search — the exact
 * shape of a fabricated all-clear. The gateway now answers 503 +
 * `code: 'search-unavailable'` for every state in which it did not search, so an
 * empty array behind a 200 once again means only what it says: we asked, and
 * the index had nothing.
 */
export async function searchWeb(query: string): Promise<WebSearchOutcome> {
  const trimmed = (query ?? '').trim();
  if (trimmed.length < MIN_QUERY_CHARS || trimmed.length > MAX_QUERY_CHARS) {
    return { ok: false, error: messageForStatus(400), status: 400 };
  }

  // `getJwtToken` resolves null when there is no session and can throw on a
  // keychain failure — both mean "cannot authenticate", and both must return
  // BEFORE the fetch below rather than sending a `Bearer null`.
  let token: string | null = null;
  try {
    token = await getJwtToken();
  } catch (err: unknown) {
    logger.warn('[web-search] Could not resolve a token', { error: String(err) });
  }
  if (!token) {
    return { ok: false, error: messageForStatus(401), status: 401 };
  }

  // Through the SHARED gateway limiter, like every other inference-gateway
  // call. This used to `fetch` directly: fine for one search, but the
  // fact-check runner issues several in a burst and the gateway throttles at
  // 30 req/60s PER IP — which, behind a carrier NAT, is shared with strangers.
  // Tripping it would surface as a 429, and a 429 here means "we never looked".
  await gatewayRateLimiter.acquire();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(WEB_SEARCH_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: trimmed }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn('[web-search] Non-OK response', { status: response.status });
      // Tell the shared limiter to back off so the next caller does not walk
      // straight into the same throttle.
      if (response.status === 429) gatewayRateLimiter.pauseFor(THROTTLE_BACKOFF_MS);
      const code = await readUnavailableCode(response);
      return {
        ok: false,
        error: messageForStatus(response.status),
        status: response.status,
        ...(code ? { code } : {}),
      };
    }

    const body = (await response.json()) as { results?: unknown };
    const raw = Array.isArray(body?.results) ? body.results : [];
    // Field-by-field, because a partially-shaped hit rendered into the prompt
    // as `undefined` is worse than a dropped one.
    const results: WebSearchResult[] = raw
      .filter(
        (r): r is WebSearchResult =>
          !!r
          && typeof r === 'object'
          && typeof (r as WebSearchResult).title === 'string'
          && typeof (r as WebSearchResult).url === 'string',
      )
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: typeof r.snippet === 'string' ? r.snippet : '',
      }));

    return { ok: true, results };
  } catch (err: unknown) {
    logger.warn('[web-search] Request failed', { error: String(err) });
    // A transport failure is also "we did not search" — same code, so a caller
    // deciding between `blocked` and a verdict does not need to special-case it.
    return {
      ok: false,
      error: 'Search could not be reached. Answer without it and say so.',
      code: SEARCH_UNAVAILABLE,
    };
  } finally {
    clearTimeout(timer);
  }
}
