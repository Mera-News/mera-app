// fact-commit — the WRITE half of propose-then-save.
//
// `handleSaveExtractedFacts` used to do all of this inline, the moment the model
// called the tool. It now only OFFERS readings; nothing here runs until the user
// taps a choice on a FactChoiceCard. The body below is deliberately the old
// handler's body, moved rather than rewritten, so the post-tap behaviour is the
// behaviour that has been in production: same `addFact` call with the same
// questionnaire argument, same conflict detection against the pre-commit bank,
// one `notifyFactMutation`, one `triggerTopicGeneration`, one geo sweep.
//
// ARRAY-SHAPED ON PURPOSE. A single card's tap is just N=1. "Save all" passes
// every chosen group in ONE call, which keeps topic generation to a single
// cloud batch — the same round trip a multi-fact turn used to make — instead of
// one batch per card.

import { addFact, getFacts } from '../database/services/fact-service';
import { detectFactConflicts } from '@/lib/news-harness/persona-management/fact-conflict';
import { normalizeStatement } from '@/lib/news-harness/persona-management/fact-rules';
import { runGeoDerivationSweep } from '../database/services/geo-derivation-service';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import logger from '../logger';
import { triggerTopicGeneration } from './tool-handlers';

export interface FactChoiceCommit {
  /** The reading the user tapped. */
  statement: string;
  questionnaire?: { level?: number; levelCategory?: string; attribute?: string };
}

export interface FactCommitResult {
  savedFacts: { id: string; statement: string }[];
  conflicts: ReturnType<typeof detectFactConflicts>;
}

export interface FactCommitOptions {
  /**
   * Fact ids committed by SIBLING cards from the same tool call.
   *
   * Conflict detection used to run once per turn against the pre-batch bank, so
   * two facts extracted together could never conflict with each other. Committing
   * per card would change that — the second tap would see the first tap's fact as
   * "existing" and could raise a ConflictResolutionCard between two facts from one
   * message. Excluding them preserves the shipped behaviour.
   */
  excludeFactIds?: string[];
}

/**
 * Writes the chosen readings and starts everything that used to follow a save.
 *
 * Idempotent by statement: a double tap, or a card resurrected after a failed
 * durable write, returns the existing fact instead of minting a second one.
 */
export async function commitFactChoices(
  choices: FactChoiceCommit[],
  options: FactCommitOptions = {},
): Promise<FactCommitResult> {
  const wanted = choices.filter((c) => c.statement.trim().length > 0);
  if (wanted.length === 0) return { savedFacts: [], conflicts: [] };

  const existingFacts = await getFacts();
  const existingByStatement = new Map(
    existingFacts.map((f) => [normalizeStatement(f.statement), f]),
  );
  const excluded = new Set(options.excludeFactIds ?? []);

  const savedFacts: { id: string; statement: string }[] = [];
  // Enriched with the questionnaire attribute so conflict detection can match on
  // the attribute key (see detectFactConflicts).
  const savedForConflict: {
    id: string;
    statement: string;
    questionnaireAttribute?: string | null;
  }[] = [];
  const freshEntries: { id: string; statement: string }[] = [];

  for (const choice of wanted) {
    const statement = choice.statement.trim();
    const already = existingByStatement.get(normalizeStatement(statement));
    if (already) {
      // Already saved — a double tap, or the same reading arrived twice. Report
      // it so the card can settle, but do not mint a duplicate or re-generate
      // topics for a fact that already has them.
      savedFacts.push({ id: already.id, statement });
      continue;
    }
    // `choice.questionnaire` is passed through UNCHANGED. resolveUserLocationFact
    // keys on the attribute, so a residence fact that loses it here stops
    // anchoring every future topic run.
    const saved = await addFact(statement, undefined, choice.questionnaire);
    savedFacts.push({ id: saved.id, statement });
    freshEntries.push({ id: saved.id, statement });
    savedForConflict.push({
      id: saved.id,
      statement,
      questionnaireAttribute: choice.questionnaire?.attribute ?? null,
    });
  }

  const conflicts = detectFactConflicts(
    savedForConflict,
    existingFacts
      .filter((f) => !excluded.has(f.id))
      .map((f) => ({
        id: f.id,
        statement: f.statement,
        questionnaireAttribute: f.questionnaireAttribute ?? null,
      })),
  );

  // Once, after every write — avoids the WatermelonDB cache race that per-fact
  // notifications used to cause.
  useFloatingChatStore.getState().notifyFactMutation();

  if (freshEntries.length > 0) {
    triggerTopicGeneration(freshEntries);
    // Derive countries now instead of waiting up to 24h for the `persona-geo`
    // task. `force` bypasses ONLY the cooldown, never the fact-fingerprint, so
    // repeated commits in one session don't each fire a fresh LLM call.
    void runGeoDerivationSweep({ force: true }).catch((err: unknown) =>
      logger.warn('[fact-commit] Geo derivation failed', { error: String(err) }),
    );
  }

  return { savedFacts, conflicts };
}
