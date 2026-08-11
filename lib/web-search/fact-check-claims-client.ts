// ClaimReview lookup — the app's ONLY client for the inference gateway's
// `POST /v1/fact-check-claims` endpoint.
//
// WHAT LEAVES THE DEVICE: the claim text, an optional BCP-47 language tag, and
// an optional age filter. Nothing else — no article id, no user id, no persona,
// no feed. The gateway's DTO declares exactly these three fields and its global
// ValidationPipe strips everything else, so nothing can ride along by accident.
// The Google API key lives only on the server.
//
// WHY THIS EXISTS AS A SIBLING OF web-search-client RATHER THAN INSIDE
// lib/fact-check: it is the client half of a gateway contract, and the two
// halves have to move together. The "did we actually look?" rule below is the
// same rule `searchWeb` obeys, and the two must never drift apart — a
// fact-checker that reads one of them correctly and the other loosely is worse
// than one that reads both loosely, because the bug is then intermittent.

import { getJwtToken } from '../auth-client';
import { INFERENCE_ENDPOINT } from '../config/endpoints';
import * as gatewayRateLimiter from '../llm/gateway-rate-limiter';
import logger from '../logger';
import { SEARCH_UNAVAILABLE, readUnavailableCode, type SearchUnavailableCode } from './web-search-client';

const FACT_CHECK_CLAIMS_API = `${INFERENCE_ENDPOINT}/v1/fact-check-claims`;

/** Mirrors the gateway's own bounds — a hopeless request is refused without a
 *  round trip. Note this MAX is 300, not web search's 200: a claim is a
 *  sentence someone asserted, not a query built short. */
export const MIN_CLAIM_CHARS = 2;
export const MAX_CLAIM_CHARS = 300;

/** A structured lookup, not a chat turn — but a user is still waiting. */
const REQUEST_TIMEOUT_MS = 12_000;

/** How long to hold off the shared gateway limiter after a 429. */
const THROTTLE_BACKOFF_MS = 30_000;

/**
 * One ClaimReview, flattened by the gateway out of `claims[].claimReview[]`.
 * Field names are Google's; mapping them to the app's `FactCheckOrganisation`
 * (`publisher.name → organisation`, `textualRating → verdict`, `title →
 * summary`) is the caller's job.
 *
 * `textualRating` is the publisher's OWN verdict wording — "Pants on Fire",
 * "Mostly False". It must reach the UI verbatim: an organisation's rating
 * rewritten by us, or by a model, is an attribution we are not entitled to make.
 */
export interface ClaimReview {
  claim: string;
  claimant: string;
  claimDate: string;
  publisher: { name: string; site: string };
  url: string;
  title: string;
  reviewDate: string;
  textualRating: string;
  languageCode: string;
}

/**
 * THE THREE OUTCOMES, AND WHY THE MIDDLE ONE IS NOT A FAILURE:
 *
 *   `{ ok: true,  claimReviews: [...] }` — a fact-checker has published.
 *   `{ ok: true,  claimReviews: []    }` — WE LOOKED, and no IFCN signatory has
 *                                          published on this claim. That is a
 *                                          fact about the world and the NORMAL
 *                                          outcome for most news; the corpus
 *                                          coverage is roughly 4%.
 *   `{ ok: false, ... }`                 — NO LOOKUP HAPPENED. The caller must
 *                                          record `blocked`, never a verdict
 *                                          and never "nobody checked this".
 *
 * Collapsing rows 2 and 3 in either direction is the failure this whole module
 * exists to prevent.
 */
export type FactCheckClaimsOutcome =
  | { ok: true; claimReviews: ClaimReview[] }
  | { ok: false; error: string; status?: number; code?: SearchUnavailableCode };

function messageForStatus(status: number): string {
  switch (status) {
    case 400:
      return `Claim lookup rejected: the claim must be between ${MIN_CLAIM_CHARS} and ${MAX_CLAIM_CHARS} characters.`;
    case 401:
      return 'Claim lookup is unavailable (not authenticated). No lookup was performed.';
    case 429:
      return 'Claim lookup is rate-limited right now. No lookup was performed.';
    case 502:
      return 'The fact-check index failed. No lookup was performed.';
    case 503:
      return 'Claim lookup is switched off or unreachable, so NOTHING was looked up. This is not evidence that no fact-checker has ruled on the claim.';
    default:
      return `Claim lookup failed (HTTP ${status}). No lookup was performed.`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Field-by-field, because a half-shaped review rendered as an attribution is
 *  worse than a dropped one — and a review with no url cannot be checked by the
 *  reader, which is the whole point of showing it. */
function parseClaimReviews(raw: unknown): ClaimReview[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaimReview[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const url = str(entry.url);
    if (!url) continue;
    const publisher = isRecord(entry.publisher) ? entry.publisher : {};
    out.push({
      claim: str(entry.claim),
      claimant: str(entry.claimant),
      claimDate: str(entry.claimDate),
      publisher: { name: str(publisher.name), site: str(publisher.site) },
      url,
      title: str(entry.title),
      reviewDate: str(entry.reviewDate),
      textualRating: str(entry.textualRating),
      languageCode: str(entry.languageCode),
    });
  }
  return out;
}

/**
 * Looks a claim up in the ClaimReview corpus. Never throws — every failure is
 * `{ ok: false }`, so a caller degrades into "I could not look" rather than
 * dying, and never into "nobody has checked this".
 *
 * `languageCode` is optional ON PURPOSE. The corpus skews heavily English, so a
 * locale-scoped miss is worth retrying with it omitted before concluding that
 * nobody has published — an omitted tag is a deliberate, valid request, not a
 * degraded one.
 */
export async function searchClaimReviews(
  claim: string,
  options: { languageCode?: string; maxAgeDays?: number } = {},
): Promise<FactCheckClaimsOutcome> {
  const trimmed = (claim ?? '').trim();
  if (trimmed.length < MIN_CLAIM_CHARS || trimmed.length > MAX_CLAIM_CHARS) {
    return { ok: false, error: messageForStatus(400), status: 400 };
  }

  let token: string | null = null;
  try {
    token = await getJwtToken();
  } catch (err: unknown) {
    logger.warn('[fact-check-claims] Could not resolve a token', { error: String(err) });
  }
  if (!token) {
    return { ok: false, error: messageForStatus(401), status: 401 };
  }

  // Same shared limiter as every other gateway call. The gateway's 30 req/60s
  // throttle is per-IP across ALL routes, so a runner that paced its web
  // searches but not its claim lookups would still trip it.
  await gatewayRateLimiter.acquire();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(FACT_CHECK_CLAIMS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: trimmed,
        ...(options.languageCode ? { languageCode: options.languageCode } : {}),
        ...(typeof options.maxAgeDays === 'number' ? { maxAgeDays: options.maxAgeDays } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn('[fact-check-claims] Non-OK response', { status: response.status });
      if (response.status === 429) gatewayRateLimiter.pauseFor(THROTTLE_BACKOFF_MS);
      const code = await readUnavailableCode(response);
      return {
        ok: false,
        error: messageForStatus(response.status),
        status: response.status,
        ...(code ? { code } : {}),
      };
    }

    const body = (await response.json()) as { claimReviews?: unknown };
    return { ok: true, claimReviews: parseClaimReviews(body?.claimReviews) };
  } catch (err: unknown) {
    logger.warn('[fact-check-claims] Request failed', { error: String(err) });
    return {
      ok: false,
      error: 'The fact-check index could not be reached. No lookup was performed.',
      code: SEARCH_UNAVAILABLE,
    };
  } finally {
    clearTimeout(timer);
  }
}
