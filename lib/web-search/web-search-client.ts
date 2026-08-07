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
import logger from '../logger';

const WEB_SEARCH_API = `${INFERENCE_ENDPOINT}/v1/web-search`;

/** The server rejects anything outside this range with a 400 — mirrored here so
 *  a hopeless request is refused without a round trip. */
export const MIN_QUERY_CHARS = 2;
export const MAX_QUERY_CHARS = 200;

/** How long to wait before giving up. A chat turn is already waiting on this. */
const REQUEST_TIMEOUT_MS = 12_000;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchOutcome =
  | { ok: true; results: WebSearchResult[] }
  | { ok: false; error: string; status?: number };

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
    default:
      return `Search failed (HTTP ${status}). Answer without it and say so.`;
  }
}

/**
 * Runs one web search. Never throws — every failure is returned as
 * `{ ok: false }` so a chat turn degrades into "I could not search" instead of
 * dying.
 *
 * An EMPTY results array is a SUCCESS, not an error. The server returns
 * `{ results: [] }` when its own feature flag is off, and a query with no hits
 * looks identical. Coding that as a failure would make the model retry against
 * a switch it can never flip.
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
      return { ok: false, error: messageForStatus(response.status), status: response.status };
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
    return { ok: false, error: 'Search could not be reached. Answer without it and say so.' };
  } finally {
    clearTimeout(timer);
  }
}
