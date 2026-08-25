// Web search — the app's ONLY client for the inference gateway's
// `POST /v1/web-search` endpoint (item 13), in both of its shapes: `searchWeb`
// for one query, `searchWebBatch` for several in a single request.
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

/**
 * The batch deadline. Longer than the single-query one because the request now
 * covers several searches, not because any one of them got slower: the gateway
 * fans them out concurrently under its own 8s per-query ceiling, so this is
 * headroom over that ceiling plus one round trip, not a new class of wait.
 */
const BATCH_REQUEST_TIMEOUT_MS = 18_000;

/** Mirrors `MAX_BATCH_QUERIES` in the gateway's web-search.service.ts. Sending
 *  more is a 400, so the cap is applied here rather than discovered there. */
export const MAX_BATCH_QUERIES = 4;

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
    case 404:
      // Deploy skew: the gateway predates the search routes. Same user-visible
      // truth as 503 — nothing was searched — so the instruction must match it
      // word for word, or the model softens one and not the other.
      return 'Search is switched off or unreachable, so NOTHING was searched. Do not say you found nothing — say you were unable to search.';
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

/**
 * STATUS ONLY, and that is the whole decision — do not "improve" this by
 * reading the gateway's `{ code }` out of the body.
 *
 * A draft of this function did exactly that, then fell through to the same
 * answer whether or not the body matched. It was a check no input could make
 * fail: it read as validation while deciding nothing, which is precisely the
 * instrument-that-cannot-fail shape this whole change exists to remove. The
 * body genuinely cannot discriminate here — a 503 from Cloud Run itself, or
 * from a proxy in front of it, carries no JSON at all and means the same thing
 * our own 503 means: we did not search.
 *
 * 429 joins it because the gateway's per-IP throttle rejects the request before
 * it reaches any index.
 *
 * 404 JOINS THEM BECAUSE IT ACTUALLY HAPPENED (2026-08-12). The app shipped
 * from `dev` while the deployed gateway still ran `main`, which carries neither
 * `/v1/web-search` nor `/v1/fact-check-claims` — so a live quick fact check got
 * a 404 from a route that did not exist yet. That is deploy skew, and it is
 * "no search happened" in the purest form: not throttled, not switched off,
 * simply not there. It previously fell to the generic branch, which tells the
 * model the right thing but leaves `code` undefined, so a caller branching on
 * the code alone would treat a wholly unsearched query as merely a failed one.
 */
export function unavailableCodeForStatus(status: number): SearchUnavailableCode | undefined {
  return status === 503 || status === 429 || status === 404
    ? SEARCH_UNAVAILABLE
    : undefined;
}

/**
 * Awaits `work`, but gives up the moment `signal` aborts.
 *
 * `fetch` honours an AbortSignal for free; a promise from the rate limiter does
 * not. Without this, the deadline below would cover only the network call and a
 * caller stuck in the limiter's FIFO would wait forever — which is worse than
 * failing, because nothing above it ever learns the search is not coming.
 *
 * If `work` wins, the rejection branch is simply never armed: the `finally`
 * clears the timer, so `abort` never fires and the loser promise stays pending
 * and unreferenced.
 */
export function raceDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const fail = () =>
        reject(
          Object.assign(new Error('Search gave up waiting for a rate-limit grant'), {
            name: 'AbortError',
          }),
        );
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    }),
  ]);
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

  // THE DEADLINE STARTS BEFORE THE QUEUE WAIT, NOT AFTER IT. The limiter is a
  // shared FIFO also fed by submitInferenceJob and the scoring pipeline, and it
  // grants one caller every 3s with no ceiling on the queue — so timing only the
  // fetch would make the total unbounded, and a chat turn waiting on a search
  // would hang for as long as a scoring cycle takes. 12s is the budget for
  // "answer this search", queue time included.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // Through the SHARED gateway limiter, like every other inference-gateway
    // call. This used to `fetch` directly: fine for one search, but the
    // fact-check runner issues several in a burst and the gateway throttles at
    // 30 req/60s PER IP — which, behind a carrier NAT, is shared with strangers.
    // Tripping it would surface as a 429, and a 429 here means "we never looked".
    //
    // RACED against the deadline, not merely awaited. `acquire()` resolves only
    // when its FIFO turn comes up, so a plain await here would ignore the
    // AbortController entirely and hang for however long the queue is — the
    // exact failure this deadline exists to prevent, moved one line earlier.
    await raceDeadline(gatewayRateLimiter.acquire(), controller.signal);

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
      const code = unavailableCodeForStatus(response.status);
      return {
        ok: false,
        error: messageForStatus(response.status),
        status: response.status,
        ...(code ? { code } : {}),
      };
    }

    const body = (await response.json()) as { results?: unknown };
    return { ok: true, results: normaliseResults(body?.results) };
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

/**
 * One entry of a batch, and it is a UNION in spirit even though TypeScript sees
 * optional fields: EXACTLY ONE of `results` / `error` is ever set.
 *
 *   `results: [...]`  — we searched this query. `[]` means the index had
 *                       nothing, which is a real answer about the world.
 *   `error: '...'`    — we did NOT search this query. Prose written for the
 *                       model, same as `WebSearchOutcome.error`. `code` is set
 *                       when the search BACKEND was the reason.
 *
 * A consumer that reads `results` without checking `error` first gets
 * `undefined`, not a misleading empty array. That is deliberate.
 */
export interface WebSearchBatchEntry {
  query: string;
  results?: WebSearchResult[];
  error?: string;
  code?: SearchUnavailableCode;
}

export type WebSearchBatchOutcome =
  | { ok: true; searches: WebSearchBatchEntry[] }
  | { ok: false; error: string; status?: number; code?: SearchUnavailableCode };

/**
 * Several queries in ONE request. THE POINT IS THE LIMITER, not the network.
 *
 * `gatewayRateLimiter.acquire()` is a shared FIFO that grants one caller every
 * 3s (`lib/llm/gateway-rate-limiter.ts`), so three searches issued from this
 * device are at least 6s of pure queueing however concurrently they are
 * written. This function takes ONE grant and makes ONE request; the gateway
 * fans the queries out to Brave itself. Spend is unchanged — N queries are
 * still N billed Brave requests.
 *
 * DEPLOY SKEW, AND WHY THE FALLBACK KEYS ON 400 AND NOT ON 404. A gateway that
 * predates batching still HAS this route, and its `ValidationPipe({whitelist})`
 * strips the `queries` it does not declare — so the body arrives empty and it
 * answers 400. That is the signal to retry one query at a time. A 404 means the
 * route itself is absent (this actually happened on 2026-08-12), and
 * `searchWeb` posts to the SAME url — so falling back there would spend one
 * limiter grant per query to arrive at the identical "we could not search".
 *
 * Every query is length-checked HERE, before the request, which is what keeps
 * the 400 above unambiguous: a server 400 can then only mean "shape not
 * understood".
 */
export async function searchWebBatch(queries: string[]): Promise<WebSearchBatchOutcome> {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  const rejected: WebSearchBatchEntry[] = [];
  for (const raw of queries ?? []) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (trimmed.length < MIN_QUERY_CHARS || trimmed.length > MAX_QUERY_CHARS) {
      // Reported per entry rather than failing the batch: the model can act on
      // "rewrite this one", and the queries that were fine still get answered.
      rejected.push({ query: trimmed, error: messageForStatus(400) });
      continue;
    }
    if (cleaned.length < MAX_BATCH_QUERIES) cleaned.push(trimmed);
  }

  if (cleaned.length === 0) {
    if (rejected.length > 0) return { ok: true, searches: rejected };
    return { ok: false, error: messageForStatus(400), status: 400 };
  }

  // One query needs no batch, and the single shape works against every gateway
  // ever deployed — so it is also the fallback's unit of work below.
  if (cleaned.length === 1) {
    const single = await searchWeb(cleaned[0]);
    if (!single.ok) return single;
    return { ok: true, searches: [...rejected, { query: cleaned[0], results: single.results }] };
  }

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
  const timer = setTimeout(() => controller.abort(), BATCH_REQUEST_TIMEOUT_MS);
  try {
    await raceDeadline(gatewayRateLimiter.acquire(), controller.signal);

    const response = await fetch(WEB_SEARCH_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ queries: cleaned }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn('[web-search] Non-OK batch response', {
        status: response.status,
        queryCount: cleaned.length,
      });
      if (response.status === 429) gatewayRateLimiter.pauseFor(THROTTLE_BACKOFF_MS);
      if (response.status === 400) {
        // Deploy skew — see the header. One grant per query from here on.
        logger.warn('[web-search] Batch shape rejected, falling back to single queries');
        const singles = await sequentialFallback(cleaned);
        return { ok: true, searches: [...rejected, ...singles] };
      }
      const code = unavailableCodeForStatus(response.status);
      return {
        ok: false,
        error: messageForStatus(response.status),
        status: response.status,
        ...(code ? { code } : {}),
      };
    }

    const body = (await response.json()) as { searches?: unknown };
    const raw = Array.isArray(body?.searches) ? body.searches : [];
    const searches: WebSearchBatchEntry[] = [...rejected];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { query?: unknown; results?: unknown; code?: unknown };
      const query = typeof e.query === 'string' ? e.query : '';
      if (!query) continue;
      if (e.code === SEARCH_UNAVAILABLE) {
        // The per-entry form of "we did not search". Never rendered as empty.
        searches.push({ query, error: messageForStatus(503), code: SEARCH_UNAVAILABLE });
        continue;
      }
      searches.push({ query, results: normaliseResults(e.results) });
    }
    return { ok: true, searches };
  } catch (err: unknown) {
    logger.warn('[web-search] Batch request failed', { error: String(err) });
    return {
      ok: false,
      error: 'Search could not be reached. Answer without it and say so.',
      code: SEARCH_UNAVAILABLE,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One `searchWeb` per query, each taking its own limiter grant. Only reached
 *  on deploy skew — this is the slow path the batch exists to avoid. */
async function sequentialFallback(queries: string[]): Promise<WebSearchBatchEntry[]> {
  const out: WebSearchBatchEntry[] = [];
  for (const query of queries) {
    const outcome = await searchWeb(query);
    out.push(
      outcome.ok
        ? { query, results: outcome.results }
        : { query, error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) },
    );
  }
  return out;
}

/** Field-by-field, because a partially-shaped hit rendered into the prompt as
 *  `undefined` is worse than a dropped one. Shared by both call shapes. */
function normaliseResults(raw: unknown): WebSearchResult[] {
  if (!Array.isArray(raw)) return [];
  return raw
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
}
