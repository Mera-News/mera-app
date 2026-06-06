// User Persona Service — persists/hydrates UserPersona with topics.

import database from '../index';
import type UserPersonaModel from '../models/UserPersona';
import type UserTopicModel from '../models/UserTopic';
import type FactTopicLinkModel from '../models/FactTopicLink';
import type {
  UserPersona,
  UserTopic,
} from '../../generated/graphql-types';
import { OnboardingStage, ProcessingMode } from '../../generated/graphql-types';
import { backfillFactTopicLinks } from './fact-topic-backfill';
import logger from '../../logger';

const personasCol = database.get<UserPersonaModel>('user_personas');
const topicsCol = database.get<UserTopicModel>('user_topics');
const linksCol = database.get<FactTopicLinkModel>('fact_topic_links');

// --- Persist ---

export async function persistUserPersona(
  userId: string,
  persona: UserPersona,
): Promise<void> {
  await database.write(async () => {
    // Wipe ALL personas, their topics, and their fact_topic_links — only one
    // user's data should ever live on-device at a time. This prevents orphaned
    // persona data from accumulating when the server-side user ID changes.
    const existingPersonas = await personasCol.query().fetch();
    const deleteOps: any[] = [];

    for (const p of existingPersonas) {
      const topics = await topicsCol.query(Q.where('user_persona_id', p.id)).fetch();
      deleteOps.push(...topics.map((t) => t.prepareDestroyPermanently()));
      deleteOps.push(p.prepareDestroyPermanently());
    }

    // Clear all fact_topic_links — backfillFactTopicLinks rebuilds them
    // correctly for the incoming persona's topics.
    const existingLinks = await linksCol.query().fetch();
    deleteOps.push(...existingLinks.map((l) => l.prepareDestroyPermanently()));

    if (deleteOps.length > 0) {
      await database.batch(deleteOps);
    }

    // Create persona
    const personaRecord = personasCol.prepareCreate((r) => {
      r.serverId = persona._id;
      r.userId = userId;
      r.processingMode = persona.processingMode;
      r.onboardingStage = persona.onboardingStage;
      r.blockedByLlm = persona.blockedByLlm;
      r.blockedByLlmReason = persona.blockedByLlmReason ?? null;
      r.llmWarningCount = persona.llmWarningCount;
      r.notificationsEnabled = persona.notificationsEnabled ?? false;
      r.preferredNotificationWindow = persona.preferredNotificationWindow;
      r.languageCodes = persona.language_codes ?? null;
      r.createdAt = new Date(toTimestamp(persona.createdAt));
      r.updatedAt = new Date(toTimestamp(persona.updatedAt));
    });

    const createOps: any[] = [personaRecord];
    const localPersonaId = personaRecord.id;

    // Create topics
    for (const topic of persona.userTopics ?? []) {
      createOps.push(
        topicsCol.prepareCreate((r) => {
          r.serverId = topic._id;
          r.userPersonaId = localPersonaId;
          r.newsTopicText = topic.news_topic_text;
          r.articleCount = topic.article_count;
          r.clusterCount = topic.cluster_count;
          r.isCanonical = topic.is_canonical;
        }),
      );
    }

    await database.batch(createOps);
  });

  // The persona fetch is our only reliable signal that the server has finished
  // processing topics submitted via submitUserTopics (that flow is async on
  // the backend — the graphql mutation just enqueues). Now that user_topics
  // is fresh locally, re-run the fact→topic link backfill so suggestions can
  // start resolving to facts on the next sync.
  backfillFactTopicLinks().catch((err) =>
    logger.captureException(err, {
      tags: { service: 'user-persona-service', method: 'persistUserPersona.backfill' },
    }),
  );
}

// --- Hydrate ---

export async function loadUserPersona(
  userId: string,
): Promise<UserPersona | null> {
  const personas = await personasCol
    .query(Q.where('user_id', userId))
    .fetch();

  if (personas.length === 0) return null;

  const persona = personas[0];
  const topics = await topicsCol
    .query(Q.where('user_persona_id', persona.id))
    .fetch();

  const userTopics: UserTopic[] = topics.map(toUserTopic);

  return {
    _id: persona.serverId,
    userId: persona.userId,
    processingMode: toProcessingMode(persona.processingMode),
    onboardingStage: toOnboardingStage(persona.onboardingStage),
    blockedByLlm: persona.blockedByLlm,
    blockedByLlmReason: persona.blockedByLlmReason,
    llmWarningCount: persona.llmWarningCount,
    notificationsEnabled: persona.notificationsEnabled,
    preferredNotificationWindow: persona.preferredNotificationWindow,
    language_codes: persona.languageCodes,
    userTopics,
    createdAt: persona.createdAt.toISOString(),
    updatedAt: persona.updatedAt.toISOString(),
  } as UserPersona;
}

// --- Clear ---

export async function clearUserPersona(): Promise<void> {
  await database.write(async () => {
    const allTopics = await topicsCol.query().fetch();
    const allPersonas = await personasCol.query().fetch();

    const batch = [
      ...allTopics.map((t) => t.prepareDestroyPermanently()),
      ...allPersonas.map((p) => p.prepareDestroyPermanently()),
    ];

    if (batch.length > 0) {
      await database.batch(batch);
    }
  });
}

// --- Helpers ---

function toUserTopic(record: UserTopicModel): UserTopic {
  return {
    _id: record.serverId,
    news_topic_text: record.newsTopicText,
    article_count: record.articleCount,
    cluster_count: record.clusterCount,
    is_canonical: record.isCanonical,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toProcessingMode(value: string): ProcessingMode {
  return value === ProcessingMode.OnDevice
    ? ProcessingMode.OnDevice
    : ProcessingMode.Cloud;
}

function toOnboardingStage(value: string | null | undefined): OnboardingStage {
  switch (value) {
    case OnboardingStage.Finished:
      return OnboardingStage.Finished;
    case OnboardingStage.ProcessingMode:
      return OnboardingStage.ProcessingMode;
    case OnboardingStage.PersonaChat:
      return OnboardingStage.PersonaChat;
    default:
      return OnboardingStage.Notifications;
  }
}

function toTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}
