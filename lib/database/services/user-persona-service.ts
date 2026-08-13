// User Persona Service — persists/hydrates UserPersona (without topics).

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type UserPersonaModel from '../models/UserPersona';
import type {
  UserPersona,
} from '../../generated/graphql-types';
import { OnboardingStage, ProcessingMode } from '../../generated/graphql-types';
import logger from '../../logger';

const personasCol = database.get<UserPersonaModel>('user_personas');

// --- Persist ---

export async function persistUserPersona(
  userId: string,
  persona: UserPersona,
): Promise<void> {
  await database.write(async () => {
    // Wipe ALL personas — only one user's data should ever live on-device at a
    // time. This prevents orphaned persona data from accumulating when the
    // server-side user ID changes.
    const existingPersonas = await personasCol.query().fetch();
    const deleteOps = existingPersonas.map((p) => p.prepareDestroyPermanently());
    if (deleteOps.length > 0) {
      await database.batch(deleteOps);
    }

    await database.batch([
      personasCol.prepareCreate((r) => {
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
      }),
    ]);
  });
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
    createdAt: persona.createdAt.toISOString(),
    updatedAt: persona.updatedAt.toISOString(),
  } as UserPersona;
}

// --- Clear ---

export async function clearUserPersona(): Promise<void> {
  await database.write(async () => {
    const allPersonas = await personasCol.query().fetch();
    if (allPersonas.length > 0) {
      await database.batch(allPersonas.map((p) => p.prepareDestroyPermanently()));
    }
  });
}

// --- Ownership alarm ---

/**
 * Does a persona row on this device belong to somebody OTHER than `ownerId`?
 *
 * A cheap second opinion on the question `cached_user_id` normally answers.
 * `user_personas` is the only one of the six user-data tables with a `user_id`
 * column, and it is indexed, so this is one query — but it is positive evidence
 * of contamination even when `cached_user_id` was lost or overwritten, which is
 * exactly the failure the cross-user leak was made of.
 *
 * IT CAN ONLY EVER CONFIRM, NEVER CLEAR. `persistUserPersona` is called
 * fire-and-forget from the user store, so a perfectly clean device can hold
 * zero persona rows — "no mismatch found" therefore proves nothing at all.
 * Treat `true` as a reason to force a wipe; never treat `false` as permission
 * to skip one, and never make this the gate. `hasAnyFacts()` plus a correct,
 * fail-closed wipe remains the gate.
 *
 * Returns `false` on any read failure, for the same reason: an unanswerable
 * question is not evidence.
 */
export async function assertPersonaOwner(ownerId: string): Promise<boolean> {
  if (!ownerId) return false;
  try {
    const foreign = await personasCol
      .query(Q.where('user_id', Q.notEq(ownerId)))
      .fetchCount();
    if (foreign > 0) {
      logger.captureMessage(
        'Persona rows on this device belong to a different user',
        {
          level: 'error',
          tags: { source: 'user-persona-service' },
          extra: { foreignRowCount: foreign },
        },
      );
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// --- Helpers ---

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
