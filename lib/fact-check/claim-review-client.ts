// ClaimReview lookup — the app's ONLY client for the inference gateway's
// `POST /v1/fact-check-claims` endpoint, which proxies Google's Fact Check
// Tools API (`claims:search`).
//
// WHY THIS IS NOT AN LLM CALL. Every IFCN signatory publishes its verdicts as
// ClaimReview structured data, and that corpus is exactly the `checkedBy[]`
// list the UI renders: `publisher.name -> organisation`, `url -> url`,
// `textualRating -> verdict`, `title -> summary`. Routing it through a model
// instead — which is what the server pipeline did — produced ZERO organisation
// attributions across every row it ever wrote. A structured lookup cannot
// hallucinate an organisation, and `textualRating` is already the publisher's
// own wording ("Pants on Fire", "Altered photo"), which is precisely the
// invariant `fact-check-state.ts` (describeOrganisationVerdict) exists to hold.
//
// WHAT LEAVES THE DEVICE: the query string and a BCP-47 language code, plus the
// same session JWT every other gateway call already carries. The Google API key
// lives only on the server.
//
// THE ONE CONTRACT THAT MATTERS: unavailable is NOT empty. An empty list means
// "no fact-checking organisation has published on this claim" — a fact, and the
// normal outcome (measured: ~4% of Mera's corpus is the genre fact-checkers
// cover). A disabled flag, a missing key, a 429 or a dead route must never
// produce that same value, because the caller would print a fabricated
// all-clear. Every one of those maps to `{ ok: false, error: 'search-unavailable' }`.

import { getJwtToken } from '../auth-client';
import { INFERENCE_ENDPOINT } from '../config/endpoints';
import { acquire, pauseFor } from '../llm/gateway-rate-limiter';
import { SEARCH_UNAVAILABLE, type SearchUnavailableCode } from '../web-search/web-search-client';
import logger from '../logger';

const CLAIM_REVIEW_API = `${INFERENCE_ENDPOINT}/v1/fact-check-claims`;

/** The gateway's own bounds for this route. Note the MAX is 300, not the web
 *  search's 200: a claim is a sentence someone asserted, not a query we built
 *  short. */
export const MIN_CLAIM_QUERY_CHARS = 2;
export const MAX_CLAIM_QUERY_CHARS = 300;

const REQUEST_TIMEOUT_MS = 12_000;

/** How long to hold the shared gateway limiter off after a 429. */
const THROTTLE_BACKOFF_MS = 30_000;

/** Re-exported so callers can key on ONE code across both search routes. The
 *  constant itself is `web-search-client`'s, deliberately: a fact-checker that
 *  reads one route's "we did not look" correctly and the other's loosely is
 *  worse than one that reads both loosely, because the bug is intermittent. */
export { SEARCH_UNAVAILABLE };

/** One organisation's published review, already mapped onto our shape. */
export interface ClaimReviewEntry {
  /** `claimReview[].publisher.name`. Required — an unattributed rating is dropped. */
  organisation: string;
  /** `claimReview[].url` — a link to that organisation's own fact check. */
  url?: string;
  /** `claimReview[].textualRating`, VERBATIM. Never normalised. */
  verdict?: string;
  /** `claimReview[].title`. */
  summary?: string;
}

/**
 * THE THREE OUTCOMES, AND WHY THE MIDDLE ONE IS NOT A FAILURE:
 *
 *   `{ ok: true,  entries: [...] }` — a fact-checker has published.
 *   `{ ok: true,  entries: []    }` — WE LOOKED, and no IFCN signatory has
 *                                     published on this claim. A fact about the
 *                                     world, and the normal outcome (~4% of the
 *                                     corpus is the genre they cover).
 *   `{ ok: false, ... }`            — NO LOOKUP HAPPENED. The caller must record
 *                                     `blocked`, never a verdict and never
 *                                     "nobody checked this".
 *
 * Collapsing rows 2 and 3 in either direction is the failure this module exists
 * to prevent. Shape mirrors `WebSearchOutcome` so the runner reads both the
 * same way.
 */
export type ClaimReviewOutcome =
  | { ok: true; entries: ClaimReviewEntry[] }
  | { ok: false; error: string; status?: number; code?: SearchUnavailableCode };

function unavailable(status?: number): ClaimReviewOutcome {
  return { ok: false, error: SEARCH_UNAVAILABLE, status, code: SEARCH_UNAVAILABLE };
}

/** Reads one entry out of whatever shape the gateway hands back.
 *
 *  Two shapes are accepted on purpose: the flattened `claimReview` entries the
 *  gateway is specified to return, and the raw `claims[].claimReview[]` nesting
 *  of the upstream API. A field-by-field map rather than a cast, because a
 *  half-shaped hit rendered as `undefined` under a masthead is worse than a
 *  dropped one. */
function toEntry(raw: unknown): ClaimReviewEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const organisation =
    typeof r.organisation === 'string' && r.organisation.trim()
      ? r.organisation.trim()
      : typeof r.publisher?.name === 'string' && r.publisher.name.trim()
        ? r.publisher.name.trim()
        : '';
  // No masthead ⇒ no row. `describeCheckedBy` would drop it downstream anyway,
  // and "whose judgement is this" is the entire value of the list.
  if (!organisation) return null;
  const verdict =
    typeof r.verdict === 'string'
      ? r.verdict
      : typeof r.textualRating === 'string'
        ? r.textualRating
        : undefined;
  const summary =
    typeof r.summary === 'string'
      ? r.summary
      : typeof r.title === 'string'
        ? r.title
        : undefined;
  return {
    organisation,
    url: typeof r.url === 'string' ? r.url : undefined,
    verdict: verdict?.trim() || undefined,
    summary: summary?.trim() || undefined,
  };
}

function flatten(body: unknown): ClaimReviewEntry[] {
  const b = (body ?? {}) as Record<string, any>;
  const rows: unknown[] = Array.isArray(b.results)
    ? b.results
    : Array.isArray(b.claimReviews)
      ? b.claimReviews
      : Array.isArray(b.claims)
        ? b.claims.flatMap((c: any) => (Array.isArray(c?.claimReview) ? c.claimReview : [c]))
        : [];
  const seen = new Set<string>();
  const out: ClaimReviewEntry[] = [];
  for (const row of rows) {
    const entry = toEntry(row);
    if (!entry) continue;
    // Same organisation + same URL twice is the API paginating over one review.
    const dedupe = `${entry.organisation.toLowerCase()}|${entry.url ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(entry);
  }
  return out;
}

export interface ClaimReviewRequest {
  query: string;
  /** BCP-47. Omitted deliberately on the retry — the corpus skews hard to a few
   *  languages, so a language-scoped miss is often a language artefact. */
  languageCode?: string;
  maxAgeDays?: number;
}

/**
 * Runs one ClaimReview lookup. Never throws.
 *
 * Goes through the shared gateway rate limiter: the runner fires this plus up
 * to three web searches in a burst, and behind a shared NAT that can trip the
 * gateway's per-IP throttle — which would come back as a 429 and correctly, but
 * pointlessly, block the whole check.
 */
export async function searchClaimReviews(
  request: ClaimReviewRequest,
): Promise<ClaimReviewOutcome> {
  const trimmed = (request.query ?? '').trim();
  if (
    trimmed.length < MIN_CLAIM_QUERY_CHARS
    || trimmed.length > MAX_CLAIM_QUERY_CHARS
  ) {
    return { ok: false, error: 'claim-query-invalid', status: 400 };
  }

  let token: string | null = null;
  try {
    token = await getJwtToken();
  } catch (err: unknown) {
    logger.warn('[claim-review] Could not resolve a token', { error: String(err) });
  }
  if (!token) return unavailable(401);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await acquire();
    const body: Record<string, unknown> = { query: trimmed };
    if (request.languageCode) body.languageCode = request.languageCode;
    if (typeof request.maxAgeDays === 'number') body.maxAgeDays = request.maxAgeDays;

    const response = await fetch(CLAIM_REVIEW_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 404 (route not deployed), 429 (throttled), 503 (flag off / no key) —
      // every one of them is "we could not look", never "nobody published".
      logger.warn('[claim-review] Non-OK response', { status: response.status });
      // The gateway's per-IP throttle rejects before reaching any index, so a
      // burst of claim lookups must not keep hammering it.
      if (response.status === 429) pauseFor(THROTTLE_BACKOFF_MS);
      return unavailable(response.status);
    }

    const parsed = (await response.json()) as Record<string, any>;
    // The gateway's in-band form of the same signal, for the deployment where
    // it answers 200 with a disabled marker rather than a 503.
    if (parsed?.available === false || parsed?.ok === false) return unavailable(200);

    return { ok: true, entries: flatten(parsed) };
  } catch (err: unknown) {
    logger.warn('[claim-review] Request failed', { error: String(err) });
    return unavailable();
  } finally {
    clearTimeout(timer);
  }
}
