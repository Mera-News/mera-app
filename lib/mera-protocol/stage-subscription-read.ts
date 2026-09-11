import { Q } from '@nozbe/watermelondb';

import database from '../database/index';
import type ArticleSuggestionModel from '../database/models/ArticleSuggestion';
import {
  findPrimarySubscribedSibling,
  saveSubscriptionRead,
} from '../database/services/subscribed-sibling-service';
import { getSubscribedSourceNameSet } from '../database/services/user-publication-subscription-service';
import logger from '../logger';
import { getScoringLlmPort } from './stage-scoring';

/**
 * Post-scoring pass: a short read of how a publication the user PAYS FOR
 * covered each freshly scored story.
 *
 * Runs after `processAllUnscored()` because it needs scored rows, and it is
 * deliberately a separate stage rather than a step inside scoring: it is
 * optional work that most users generate none of, and a failure here must
 * never cost a sync its scores.
 */

const suggestionsCollection = database.get<ArticleSuggestionModel>('article_suggestions');

/** Cap per run. This is background polish, not the reason the sync exists. */
const MAX_READS_PER_RUN = 10;

/**
 * The body is PAYWALLED and we never fetch it. The model sees the headline,
 * the English description and the enrichment we already hold, and the prompt
 * says so explicitly so the output cannot drift into summarising an article it
 * was never shown.
 */
const SYSTEM_PROMPT = [
  'You compare how two news outlets covered the same story.',
  '',
  'You are given a headline and a short description from a publication the reader subscribes to.',
  'You have NOT been given the full article, and you never will be: it is behind a paywall.',
  'Write one or two plain sentences on what that outlet emphasises about this story.',
  '',
  'Rules:',
  '- Never claim or imply you read the full article.',
  '- Never invent a detail that is not in the text you were given.',
  '- If the text is too thin to say anything useful, reply with exactly: SKIP',
  '- No preamble, no quotation marks, no headings. Just the sentences.',
].join('\n');

function buildPrompt(sibling: ArticleSuggestionModel, anchorTitle: string | null): string {
  const lines = [
    `The reader is looking at this story: ${anchorTitle ?? '(untitled)'}`,
    '',
    `Their subscribed outlet: ${sibling.publicationName ?? '(unknown)'}`,
    `Its headline: ${sibling.titleEn ?? sibling.titleOriginal ?? '(untitled)'}`,
  ];
  if (sibling.descriptionEn) lines.push(`Its description: ${sibling.descriptionEn}`);
  if (sibling.category) lines.push(`Category: ${sibling.category}`);
  if (sibling.eventType) lines.push(`Event type: ${sibling.eventType}`);
  return lines.join('\n');
}

/**
 * Rows eligible for a read: scored, and not already carrying one.
 *
 * `subscription_read_at` is the marker rather than `subscription_read`,
 * because a run that legitimately produced nothing (the model said SKIP) must
 * not be retried forever. Both are stamped together.
 */
async function candidatesForRead(limit: number): Promise<ArticleSuggestionModel[]> {
  const rows = await suggestionsCollection
    .query(Q.where('subscription_read_at', null), Q.sortBy('created_at', Q.desc))
    .fetch();
  // Mirrored in JS so the result does not depend on the query engine, matching
  // the house convention in article-suggestion-service.
  return rows.filter((r) => r.subscriptionReadAt == null).slice(0, limit);
}

/**
 * Generates subscription reads for recently scored rows.
 *
 * Returns the number of reads written. Never throws: this is background
 * polish on the sync path, and a failure here must not fail the sync.
 */
export async function runSubscriptionReadStage(
  maxReads: number = MAX_READS_PER_RUN,
): Promise<number> {
  try {
    // Cheapest possible exit for the overwhelmingly common case: the user has
    // no subscriptions, so there is nothing to compare against and we never
    // touch the suggestions table at all.
    const subscribedNames = await getSubscribedSourceNameSet();
    if (subscribedNames.size === 0) return 0;

    const candidates = await candidatesForRead(maxReads);
    if (candidates.length === 0) return 0;

    const llm = getScoringLlmPort();
    let written = 0;

    for (const anchor of candidates) {
      try {
        const sibling = await findPrimarySubscribedSibling(anchor, subscribedNames);
        if (!sibling) continue;

        const raw = await llm.complete({
          systemPrompt: SYSTEM_PROMPT,
          prompt: buildPrompt(sibling, anchor.titleEn ?? anchor.titleOriginal),
          maxTokens: 160,
          temperature: 0,
        });

        const read = (raw ?? '').trim();
        // A SKIP is a real answer, and it is stamped like any other so the row
        // is not re-asked on every sync for the rest of its 48 hours.
        const stored = !read || read === 'SKIP' ? '' : read;
        await saveSubscriptionRead(anchor.id, stored);
        if (stored) written += 1;
      } catch (error) {
        logger.warn('[subscription-read] one row failed, continuing', {
          suggestionId: anchor.id,
          error: String(error),
        });
      }
    }

    return written;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'stage-subscription-read', method: 'runSubscriptionReadStage' },
    });
    return 0;
  }
}
