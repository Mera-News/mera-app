// `searchNews` — the chat tool that pulls REAL articles from Mera's own index
// into a conversation (item 12b).
//
// Server contract: `searchNews(query: String!, limit: Int): [NewsSearchHit!]!`,
// guarded and metered-EXEMPT, capped at 25 server-side. The hit deliberately
// carries no `description_en` and no `article_url` — headlines only. Hydration
// of a chosen id goes through the existing metered `articlesForTopicsByIds`,
// which is a different surface's job; nothing here should grow a body-text
// fetch.
//
// WHAT LEAVES THE DEVICE: the search words the model composed, and nothing
// else. No facts, no topics, no feed state. Same shape as any other GraphQL
// query the app already makes, on the session the user is already using.

import { gql } from '@apollo/client';
import { asUntrusted } from '@/lib/news-harness/prompts/untrusted-text';
import logger from '../logger';

const SEARCH_NEWS_QUERY = gql`
  query SearchNews($query: String!, $limit: Int) {
    searchNews(query: $query, limit: $limit) {
      _id
      title_en
      image_url
      publication_name
      country_code
      pubDate
      score
    }
  }
`;

/** The server caps at 25; a chat turn cannot afford anywhere near that many
 *  headlines, and the top handful are the ones that get discussed. */
export const NEWS_SEARCH_LIMIT = 8;

interface SearchNewsQueryResult {
  searchNews: {
    _id: string;
    title_en: string;
    image_url?: string | null;
    publication_name?: string | null;
    country_code?: string | null;
    pubDate: string;
    score: number;
  }[] | null;
}

/** `2026-08-07T09:12:00.000Z` → `2026-08-07`. The model needs recency, not a
 *  timestamp, and the full ISO string costs tokens on every single hit. */
function toDay(pubDate: string): string {
  const day = (pubDate ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

/**
 * Searches the last 48h of Mera's own article index.
 *
 * Never throws — a network failure returns `{ error }` so the turn degrades
 * into "I could not look that up" rather than dying. An EMPTY result list is a
 * success with a `note`, not an error: 48h of news genuinely may not contain
 * the thing asked about, and the model must say so rather than retry.
 */
export async function handleSearchNews(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { error: 'query must be a non-empty string' };
  }

  const requested = typeof args.limit === 'number' ? Math.floor(args.limit) : NEWS_SEARCH_LIMIT;
  const limit = Math.min(Math.max(requested, 1), NEWS_SEARCH_LIMIT);

  // Apollo is `require`d LAZILY, mirroring handleExplainMera's explainer module
  // and PersonaUpdateAgent.loadKnownPublicationNames: a static import drags the
  // Apollo client — and through it the whole WatermelonDB stack — into module
  // evaluation for every consumer of this agent, for a query that only runs on
  // a turn where the user actually asked about the news.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: client } = require('../apollo-client') as typeof import('../apollo-client');

  try {
    const { data } = await client.query<SearchNewsQueryResult>({
      query: SEARCH_NEWS_QUERY,
      variables: { query, limit },
      fetchPolicy: 'no-cache',
    });

    const hits = data?.searchNews ?? [];
    if (hits.length === 0) {
      return {
        query,
        articles: [],
        note: 'Nothing in the last 48 hours of Mera\'s news index matches this. Say so plainly; do not invent an article.',
      };
    }

    return {
      query,
      // Title and publication are PUBLISHER-CONTROLLED and become tool-result
      // text the model reads, so they cross the same boundary an article block
      // does and go through the same constructor. ESCAPE-ONLY, no nonce fence:
      // a tool result is framed to the model as "here is what the search
      // returned", not as article content, and the fence belongs to that other
      // framing in `lib/news-harness/prompts`.
      //
      // Each is passed its OWN length as the cap so `asUntrusted` sanitises
      // without truncating: neither field is truncated today, and quietly
      // introducing a character budget inside a security fix would be a
      // behaviour change nobody reviewed. The server already caps this list.
      //
      // `id`, `country` and `date` stay untouched — they are ours or
      // enum-shaped rather than publisher prose, and `id` in particular has to
      // remain byte-exact because the model hands it back for hydration.
      articles: hits.map((h) => ({
        id: h._id,
        title: asUntrusted(h.title_en ?? '', (h.title_en ?? '').length),
        publication: h.publication_name
          ? asUntrusted(h.publication_name, h.publication_name.length)
          : null,
        country: h.country_code ?? null,
        date: toDay(h.pubDate),
      })),
      note: 'Headlines only — you do not have the article text. Summarise what the headlines say and never invent details or a link.',
    };
  } catch (error: unknown) {
    logger.warn('[searchNews] Query failed', { error: String(error) });
    return {
      error: 'The news search could not be reached. Answer without it and say so.',
    };
  }
}
