// `webSearch` — the chat tool behind the "Web search in chat" toggle (item 13).
//
// TWO GATES, both load-bearing, and they guard different failures:
//
//  1. The DECLARATION gate (persona-agent-core.getPersonaToolDefinitions, fed
//     by PersonaUpdateAgent.getToolDefinitions, and its siblings on the
//     article, follow-story and tutorial surfaces) omits the tool from the turn
//     payload while the toggle is off. The setting is now ON by default, so
//     this gate's job is no longer to keep an unused feature out of the prompt
//     — it is to make a user who turned it OFF cost nothing.
//
//  2. THIS gate. A persisted conversation replays tool calls made while the
//     toggle was ON. On such a turn the tool is not declared, so
//     `normalizeToolName` finds no match, the raw name falls through to the
//     agent's static `case 'webSearch'`, and execution reaches here. Without
//     the check below, turning the toggle off would not stop the query from
//     leaving the device.
//
// The store read is the FIRST statement, before any await. `searchWebBatch`
// resolves a JWT — itself a potentially networked call — so a check placed
// after that would already have hit the network by the time it refused.
//
// MULTI-QUERY IS THE DEFAULT SHAPE. The tool accepts `queries` (and still
// accepts a lone `query`), and every query in one call becomes ONE request to
// the gateway, which fans them out to Brave concurrently. The reason is the
// app's shared gateway limiter: it grants one caller every 3s, so a model that
// searches three things in three turns waits at least 6s in the queue alone.

import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import {
  MAX_BATCH_QUERIES,
  searchWebBatch,
  type WebSearchBatchEntry,
} from '../web-search/web-search-client';

/** How many hits per query reach the prompt when the model asked for one thing.
 *  The endpoint returns at most 10; a chat turn cannot afford ten snippets, and
 *  the top few are what get cited anyway. */
const MAX_RESULTS_SINGLE = 5;

/** Per query, once several were asked for. Four queries at five hits each is
 *  twenty snippets in one tool result — enough to displace the conversation the
 *  search was meant to inform. Breadth is what a batch buys; depth per query is
 *  what it spends. */
const MAX_RESULTS_PER_QUERY_BATCHED = 3;

/** Snippets are the bulky part of a hit; truncated so one search cannot
 *  displace the conversation it was meant to inform. */
const MAX_SNIPPET_CHARS = 220;

function truncate(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Reads either shape the model may emit. Non-string entries are dropped rather
 * than stringified: `[object Object]` is not a search anybody asked for.
 *
 * Trimmed and emptied HERE, so a call carrying nothing usable is refused before
 * any await rather than after one — the same reason gate 2 is the first
 * statement. Trimming is not truncating: an over-long query still goes through
 * at full length, for the client to refuse with an instruction the model can
 * act on.
 */
function readQueries(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
  };
  if (Array.isArray(args.queries)) for (const q of args.queries) push(q);
  push(args.query);
  return out;
}

function shapeEntry(entry: WebSearchBatchEntry, maxResults: number) {
  if (entry.error !== undefined) {
    // NOT an empty result list. `searched: false` is what stops the model
    // reporting "nothing was found" for a query nobody ever looked up.
    return { query: entry.query, searched: false, error: entry.error };
  }
  const results = entry.results ?? [];
  if (results.length === 0) {
    return {
      query: entry.query,
      searched: true,
      results: [],
      note: 'The search returned nothing for this query. Say you could not find anything on the web for it, and answer from what you already have.',
    };
  }
  return {
    query: entry.query,
    searched: true,
    results: results.slice(0, maxResults).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: truncate(r.snippet, MAX_SNIPPET_CHARS),
    })),
  };
}

export async function handleWebSearch(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // GATE 2 — first statement, no await before it. See the header.
  if (!useMeraProtocolStore.getState().webSearchInChat) {
    return {
      error:
        'Web search is switched off in this user\'s settings. No search was performed and nothing left the device. Answer from what you already have, and tell the user they can turn on "Web search in chat" in Mera Protocol settings.',
      searched: false,
    };
  }

  const queries = readQueries(args);
  if (queries.length === 0) {
    return { error: 'queries must be a non-empty array of strings', searched: false };
  }

  // Passed through UNTRUNCATED on purpose. Slicing an over-long query to 200
  // chars would cut it mid-clause and then report success, so the model would
  // answer confidently from results for a question it did not ask. The client's
  // own length check refuses it instead, with a "rewrite it and try once more"
  // the model can actually act on.
  const outcome = await searchWebBatch(queries);
  if (!outcome.ok) {
    return { error: outcome.error, searched: false };
  }

  // Single-query calls keep their original shape exactly. Reshaping them into a
  // one-element batch would change what every existing prompt sees for no gain.
  if (outcome.searches.length === 1 && queries.length === 1) {
    const only = shapeEntry(outcome.searches[0], MAX_RESULTS_SINGLE);
    return only as unknown as Record<string, unknown>;
  }

  const searches = outcome.searches.map((entry) =>
    shapeEntry(entry, MAX_RESULTS_PER_QUERY_BATCHED),
  );
  return {
    // True when AT LEAST ONE query was actually looked up. A batch where every
    // entry failed is `searched: false`, which is the same promise the single
    // path makes: never let "we could not look" read as "nothing is out there".
    searched: searches.some((s) => s.searched),
    dropped:
      queries.length > MAX_BATCH_QUERIES
        ? `Only the first ${MAX_BATCH_QUERIES} queries were searched.`
        : undefined,
    searches,
  };
}
