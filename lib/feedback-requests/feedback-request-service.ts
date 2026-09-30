// feedback-request-service: the two GraphQL calls behind in-app feedback
// requests (a question the Mera team asks every user for a limited time).
//
//   activeFeedbackRequests(locale): LIVE requests with endsAt > now, the
//     question already localized server-side (English fallback). Self-scoped:
//     `answered` is about the signed-in account, and the client never sends a
//     user id.
//   submitFeedbackResponse(input): one answer. A closed, ended or unknown
//     request is a GraphQL error with extensions.code FEEDBACK_REQUEST_CLOSED;
//     `alreadyAnswered: true` is a success ("you already answered").
//
// Both are `no-cache` (asking again is the point) and `noSyncStatus` (neither
// is part of the feed sync, so a failure must never paint "sync failed" on
// the feed). The Apollo error link owns Sentry capture; this file only
// breadcrumbs, the same contract as article-service.
//
// Nothing about showing, opening or dismissing a request ever goes to the
// server: the only thing sent is the answer the reader chose to submit.

import { gql } from '@apollo/client';
import client from '@/lib/apollo-client';
import logger from '@/lib/logger';
import { serverLocaleFor } from '@/lib/publication-display-service';
import { useNetworkStore } from '@/lib/stores/network-store';

// Mirrors of the wave contract, until codegen carries the server's SDL.
interface FeedbackRequestView {
  id: string;
  question: string;
  endsAt: unknown;
  createdAt: unknown;
  answered: boolean;
}
interface QueryActiveFeedbackRequestsArgs {
  locale: string;
}
interface MutationSubmitFeedbackResponseArgs {
  input: { feedbackRequestId: string; text: string };
}
interface SubmitFeedbackResponseResult {
  ok: boolean;
  alreadyAnswered: boolean;
}

export const FEEDBACK_REQUEST_CLOSED = 'FEEDBACK_REQUEST_CLOSED';

/** Server-side bounds on an answer (trimmed). The modal enforces the max. */
export const FEEDBACK_RESPONSE_MAX_CHARS = 2000;

const ACTIVE_FEEDBACK_REQUESTS = gql`
  query ActiveFeedbackRequests($locale: String!) {
    activeFeedbackRequests(locale: $locale) {
      id
      question
      endsAt
      createdAt
      answered
    }
  }
`;

const SUBMIT_FEEDBACK_RESPONSE = gql`
  mutation SubmitFeedbackResponse($input: SubmitFeedbackResponseInput!) {
    submitFeedbackResponse(input: $input) {
      ok
      alreadyAnswered
    }
  }
`;

export interface ActiveFeedbackRequest {
  id: string;
  question: string;
  /** Epoch ms. */
  endsAt: number;
  answered: boolean;
}

export type FetchActiveFeedbackRequestsResult =
  | { ok: true; requests: ActiveFeedbackRequest[] }
  | { ok: false; offline: boolean };

export type SubmitFeedbackResponseOutcome =
  | { status: 'ok'; alreadyAnswered: boolean }
  | { status: 'closed' }
  | { status: 'error'; offline: boolean };

/** GraphQL error codes on a rejection (Apollo 4 `errors`, Apollo 3 `graphQLErrors`). */
function graphQLErrorCodes(err: unknown): string[] {
  if (!err || typeof err !== 'object') return [];
  const list =
    (err as { errors?: unknown }).errors ?? (err as { graphQLErrors?: unknown }).graphQLErrors;
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => (e as { extensions?: { code?: unknown } })?.extensions?.code)
    .filter((c): c is string => typeof c === 'string');
}

/** Raw device link only, never `isOnline()` (a latch about Mera's own health).
 *  `=== false`: an unknown link is not offline. */
function deviceOffline(): boolean {
  return useNetworkStore.getState().isConnected === false;
}

function breadcrumb(method: string, extra?: Record<string, unknown>): void {
  logger.addBreadcrumb(
    `[feedback-request] ${method} failed`,
    'feedback-request',
    { method, ...extra },
    'warning',
  );
}

function toRequest(row: FeedbackRequestView | null | undefined): ActiveFeedbackRequest | null {
  if (!row || typeof row.id !== 'string' || row.id === '') return null;
  if (typeof row.question !== 'string' || row.question.trim() === '') return null;
  const endsAt = Date.parse(String(row.endsAt));
  if (!Number.isFinite(endsAt)) return null;
  return { id: row.id, question: row.question, endsAt, answered: row.answered === true };
}

/**
 * The live requests, in the app language (mapped to the server's locale list:
 * sent as-is, `zh-Hans` would silently get English). Never throws.
 */
export async function fetchActiveFeedbackRequests(
  appLanguage: string,
): Promise<FetchActiveFeedbackRequestsResult> {
  const variables: QueryActiveFeedbackRequestsArgs = { locale: serverLocaleFor(appLanguage) };
  try {
    const { data } = await client.query<{ activeFeedbackRequests: FeedbackRequestView[] }>({
      query: ACTIVE_FEEDBACK_REQUESTS,
      variables,
      fetchPolicy: 'no-cache',
      context: { noSyncStatus: true },
    });
    const requests = (data?.activeFeedbackRequests ?? [])
      .map(toRequest)
      .filter((r): r is ActiveFeedbackRequest => r !== null);
    return { ok: true, requests };
  } catch (err) {
    breadcrumb('fetchActiveFeedbackRequests', { codes: graphQLErrorCodes(err) });
    return { ok: false, offline: deviceOffline() };
  }
}

/**
 * Send one answer. `text` is trimmed here; an empty answer never reaches the
 * network. Never throws.
 */
export async function submitFeedbackResponse(
  feedbackRequestId: string,
  text: string,
): Promise<SubmitFeedbackResponseOutcome> {
  const trimmed = text.trim().slice(0, FEEDBACK_RESPONSE_MAX_CHARS);
  if (!trimmed) return { status: 'error', offline: false };
  const variables: MutationSubmitFeedbackResponseArgs = {
    input: { feedbackRequestId, text: trimmed },
  };
  try {
    const { data } = await client.mutate<{ submitFeedbackResponse: SubmitFeedbackResponseResult }>({
      mutation: SUBMIT_FEEDBACK_RESPONSE,
      variables,
      fetchPolicy: 'no-cache',
      // A closed question is an outcome this screen shows ("This question has
      // closed"), not a fault: a breadcrumb in the error link, no Sentry event.
      context: { noSyncStatus: true, expectedErrorCodes: [FEEDBACK_REQUEST_CLOSED] },
    });
    const result = data?.submitFeedbackResponse;
    if (!result) {
      breadcrumb('submitFeedbackResponse', { reason: 'empty-result' });
      return { status: 'error', offline: false };
    }
    if (result.alreadyAnswered) return { status: 'ok', alreadyAnswered: true };
    if (!result.ok) {
      breadcrumb('submitFeedbackResponse', { reason: 'not-ok' });
      return { status: 'error', offline: false };
    }
    return { status: 'ok', alreadyAnswered: false };
  } catch (err) {
    const codes = graphQLErrorCodes(err);
    if (codes.includes(FEEDBACK_REQUEST_CLOSED)) return { status: 'closed' };
    breadcrumb('submitFeedbackResponse', { codes });
    return { status: 'error', offline: deviceOffline() };
  }
}
