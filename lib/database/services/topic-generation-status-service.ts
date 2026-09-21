// The three verbs that move `facts.topics_status`.
//
// A status is never written on its own: each verb moves it as part of the
// operation that justifies it, so the column and the `topics` table cannot
// drift apart through a caller forgetting a step. There is deliberately NO
// exported bare setter.
//
// Its own file rather than an addition to fact-service or topic-service:
// fact-service already lazy-`require`s topic-service, so a static import back
// the other way would be a module cycle held together by that require. This
// module imports both collections directly.

import database from '../index';
import logger from '../../logger';
import type FactModel from '../models/Fact';
import type TopicModel from '../models/Topic';
import { createTopics } from './topic-service';

const factsCollection = database.get<FactModel>('facts');

/**
 * Stamp 'pending' on every fact whose topic-generation job is being enqueued.
 *
 * ONE write for the whole set: the cloud path fans a single batch call out
 * over N facts, so N separate writes would be N transactions for one logical
 * event.
 */
export async function beginTopicGeneration(factIds: string[]): Promise<void> {
  if (factIds.length === 0) return;
  const records: FactModel[] = [];
  for (const id of factIds) {
    try {
      records.push(await factsCollection.find(id));
    } catch {
      // A fact deleted between enqueue and stamp is not an error worth
      // failing a batch over.
      logger.warn('[topic-gen-status] begin: fact missing', { factId: id });
    }
  }
  if (records.length === 0) return;

  await database.write(async () => {
    const now = new Date();
    await database.batch(
      records.map((r) =>
        r.prepareUpdate((f) => {
          f.topicsStatus = 'pending';
          f.topicsUpdatedAt = now;
        }),
      ),
    );
  });
}

/**
 * Mint the run's topics, THEN stamp 'done'.
 *
 * Deliberately NOT one atomic batch. Making it atomic would mean forking
 * `createTopics` or refactoring it to expose prepare-builders, and its
 * resolve-or-create dedup floor is exactly the code you do not want a second
 * copy of — a duplicate topic row is independently retrieved and independently
 * billed on every feed sync. So reuse it, and pick the safe ordering, because
 * the two failure modes are not symmetric:
 *
 *   stamp first, mint throws  → 'done' with no topics, nothing ever retries.
 *                               Invisible and permanent.
 *   mint first, stamp throws  → topics exist and render, status still
 *                               'pending'. A cosmetic spinner, healed to
 *                               'done' by the rescue sweep at the next
 *                               foreground.
 *
 * `createTopics` also keeps `fact.metadata.topics` in step, so callers never
 * touch that second list themselves.
 */
export async function completeTopicGeneration(
  factId: string,
  topicTexts: string[],
): Promise<TopicModel[]> {
  const texts = topicTexts.map((t) => t.trim()).filter(Boolean);

  const minted = texts.length
    ? await createTopics(texts.map((text) => ({ factId, text })))
    : [];

  try {
    const record = await factsCollection.find(factId);
    await record.setTopicsStatus('done');
  } catch {
    logger.warn('[topic-gen-status] complete: fact missing at stamp', { factId });
  }
  return minted;
}

/**
 * Stamp 'done' WITHOUT minting anything.
 *
 * For a path that already created the topics itself. `completeTopicGeneration`
 * mints, so calling it after a generator that has already written its rows
 * would duplicate them.
 *
 * THE BUG THIS EXISTS FOR: `fact-commit` stamps every accepted fact 'pending',
 * and only the queued skill-guided handler ever settled it. The batch cloud
 * generator minted topics and never touched the column, so its facts span
 * forever: chips visible in the chat card under a live "Finding topics"
 * spinner, and a profile row showing a spinner and no statement. Any path that
 * finishes generation must settle the status.
 */
export async function markTopicGenerationSettled(factIds: string[]): Promise<void> {
  for (const factId of factIds) {
    try {
      const record = await factsCollection.find(factId);
      await record.setTopicsStatus('done');
    } catch {
      logger.warn('[topic-gen-status] settle: fact missing at stamp', { factId });
    }
  }
}

/**
 * Stamp 'error' AND write `metadata.topicGenError` in one write.
 *
 * Both, because three live components still read the legacy marker
 * (TopicPlanCard, tool-handlers' retry path) and they are not this area's to
 * change. Writing only one of the two would let the new column and the marker
 * disagree about the same run.
 */
export async function failTopicGeneration(factId: string, message: string): Promise<void> {
  let record: FactModel;
  try {
    record = await factsCollection.find(factId);
  } catch {
    logger.warn('[topic-gen-status] fail: fact missing', { factId });
    return;
  }
  await database.write(async () => {
    const now = new Date();
    await database.batch([
      record.prepareUpdate((f) => {
        f.topicsStatus = 'error';
        f.topicsUpdatedAt = now;
        // Spread the existing metadata: assigning `{ topicGenError }` alone
        // would drop `topics` and `topicsReviewedAt`.
        f.metadata = { ...(f.metadata ?? {}), topicGenError: [message] };
        f.updatedAt = now;
      }),
    ]);
  });
}
