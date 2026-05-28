// Self-healing backfill for fact_topic_links.
//
// Historically fact_topic_links was never populated — the topic-gen handler
// now writes it after `submitUserTopics`, but facts created before that fix
// are stuck with empty links and can't be resolved on sync. This module
// reconstructs those links purely from local state:
//
//   fact.metadata.topics[*] (string)  ⟷  user_topics.news_topic_text (string)
//
// If the match hits, we already know the user_topic's server_id, so we can
// write (fact_id, server_topic_id, topic_text) straight to fact_topic_links.
// Idempotent — re-running it just rewrites the same rows.

import database from '../index';
import type FactModel from '../models/Fact';
import type FactTopicLinkModel from '../models/FactTopicLink';
import type UserTopicModel from '../models/UserTopic';

const factsCol = database.get<FactModel>('facts');
const linksCol = database.get<FactTopicLinkModel>('fact_topic_links');
const userTopicsCol = database.get<UserTopicModel>('user_topics');

export async function backfillFactTopicLinks(): Promise<{
  factsScanned: number;
  linksAdded: number;
  factsWithUnresolvedTopics: number;
}> {
  const [facts, userTopics, existingLinks] = await Promise.all([
    factsCol.query().fetch(),
    userTopicsCol.query().fetch(),
    linksCol.query().fetch(),
  ]);

  if (facts.length === 0 || userTopics.length === 0) {
    return { factsScanned: facts.length, linksAdded: 0, factsWithUnresolvedTopics: 0 };
  }

  // text → server topic id (last-write-wins if duplicate texts exist)
  const serverTopicIdByText = new Map<string, string>();
  for (const t of userTopics) {
    if (t.newsTopicText) serverTopicIdByText.set(t.newsTopicText, t.serverId);
  }

  // existing (fact_id, server_topic_id) tuples — skip anything already linked
  const existingKeys = new Set(
    existingLinks.map((l) => `${l.factId}::${l.serverTopicId}`),
  );

  const toCreate: { factId: string; serverTopicId: string; topicText: string }[] = [];
  let factsWithUnresolvedTopics = 0;

  for (const fact of facts) {
    const topics = (fact.metadata?.topics ?? []) as string[];
    if (topics.length === 0) continue;

    let matched = 0;
    for (const text of topics) {
      const serverTopicId = serverTopicIdByText.get(text);
      if (!serverTopicId) continue;
      const key = `${fact.id}::${serverTopicId}`;
      if (existingKeys.has(key)) {
        matched++;
        continue;
      }
      toCreate.push({ factId: fact.id, serverTopicId, topicText: text });
      existingKeys.add(key);
      matched++;
    }
    if (matched < topics.length) factsWithUnresolvedTopics++;
  }

  if (toCreate.length > 0) {
    await database.write(async () => {
      await database.batch(
        toCreate.map((link) =>
          linksCol.prepareCreate((r) => {
            r.factId = link.factId;
            r.serverTopicId = link.serverTopicId;
            r.topicText = link.topicText;
          }),
        ),
      );
    });
  }

  // Self-heal metadata.topics: if a fact's stored topic list has entries that
  // never resolved (server deduped/rejected them, text-normalized differently,
  // etc.), trim metadata.topics to only the texts that actually produced a
  // link. Without this, the UI's "linked / metadata.topics" ratio is stuck
  // below 1 forever.
  const allLinksAfter = toCreate.length > 0
    ? await linksCol.query().fetch()
    : existingLinks;
  const linkedTextsByFactId = new Map<string, Set<string>>();
  for (const link of allLinksAfter) {
    const bucket = linkedTextsByFactId.get(link.factId) ?? new Set<string>();
    bucket.add(link.topicText);
    linkedTextsByFactId.set(link.factId, bucket);
  }

  for (const fact of facts) {
    const metadataTopics = (fact.metadata?.topics ?? []) as string[];
    if (metadataTopics.length === 0) continue;
    const linkedTexts = linkedTextsByFactId.get(fact.id);
    if (!linkedTexts || linkedTexts.size === 0) continue; // nothing linked — leave as-is
    if (metadataTopics.length === linkedTexts.size) continue; // already aligned

    const trimmed = metadataTopics.filter((t) => linkedTexts.has(t));
    // Only rewrite if we'd actually shrink (avoid no-op writes)
    if (trimmed.length === metadataTopics.length) continue;
    await fact.updateFact(fact.statement, { ...fact.metadata, topics: trimmed });
  }

  return {
    factsScanned: facts.length,
    linksAdded: toCreate.length,
    factsWithUnresolvedTopics,
  };
}
