// `webSearch` — the chat tool behind the "Web search in chat" toggle (item 13).
//
// TWO GATES, both load-bearing, and they guard different failures:
//
//  1. The DECLARATION gate (persona-agent-core.getPersonaToolDefinitions, fed
//     by PersonaUpdateAgent.getToolDefinitions) omits the tool from the turn
//     payload while the toggle is off. That is what keeps an off-by-default
//     feature from burning prompt tokens on every single turn.
//
//  2. THIS gate. A persisted conversation replays tool calls made while the
//     toggle was ON. On such a turn the tool is not declared, so
//     `normalizeToolName` finds no match, the raw name falls through to
//     PersonaUpdateAgent's static `case 'webSearch'`, and execution reaches
//     here. Without the check below, turning the toggle off would not stop the
//     query from leaving the device.
//
// The store read is the FIRST statement, before any await. `searchWeb` resolves
// a JWT — itself a potentially networked call — so a check placed after that
// would already have hit the network by the time it refused.

import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { searchWeb } from '../web-search/web-search-client';

/** How many hits reach the prompt. The endpoint returns at most 10; a chat turn
 *  cannot afford ten snippets, and the top few are what get cited anyway. */
const MAX_RESULTS_IN_RESULT = 5;

/** Snippets are the bulky part of a hit; truncated so one search cannot
 *  displace the conversation it was meant to inform. */
const MAX_SNIPPET_CHARS = 220;

function truncate(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
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

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { error: 'query must be a non-empty string', searched: false };
  }

  // Passed through UNTRUNCATED on purpose. Slicing an over-long query to 200
  // chars would cut it mid-clause and then report success, so the model would
  // answer confidently from results for a question it did not ask. The client's
  // own length check refuses it instead, with a "rewrite it and try once more"
  // the model can actually act on.
  const outcome = await searchWeb(query);
  if (!outcome.ok) {
    return { error: outcome.error, searched: false };
  }

  if (outcome.results.length === 0) {
    return {
      searched: true,
      query,
      results: [],
      note: 'The search returned nothing. Say you could not find anything on the web for this, and answer from what you already have.',
    };
  }

  return {
    searched: true,
    query,
    results: outcome.results.slice(0, MAX_RESULTS_IN_RESULT).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: truncate(r.snippet, MAX_SNIPPET_CHARS),
    })),
  };
}
