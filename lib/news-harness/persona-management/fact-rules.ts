// news-harness — pure fact-acceptance rules.
//
// Extracted from lib/chat-tools/tool-handlers.ts::handleSaveExtractedFacts. The
// accept/reject DECISIONS live here as a pure function; the handler keeps the DB
// writes, store notify, and topic-generation trigger and delegates the decisions
// to filterNewFacts.

export const MAX_FACT_LENGTH = 200;

/** A fact entry from the LLM — either a plain string (legacy) or an object with
 *  questionnaire metadata. */
export type FactEntry =
  | string
  | {
      statement: string;
      questionnaire_level?: number;
      questionnaire_level_category?: string;
      questionnaire_attribute?: string;
    };

export interface NormalizedFactEntry {
  statement: string;
  questionnaire?: {
    level?: number;
    levelCategory?: string;
    attribute?: string;
  };
}

export function normalizeFactEntry(entry: FactEntry): NormalizedFactEntry {
  if (typeof entry === 'string') {
    return { statement: entry };
  }
  return {
    statement: entry.statement ?? '',
    questionnaire:
      entry.questionnaire_level ||
      entry.questionnaire_level_category ||
      entry.questionnaire_attribute
        ? {
            level: entry.questionnaire_level,
            levelCategory: entry.questionnaire_level_category,
            attribute: entry.questionnaire_attribute,
          }
        : undefined,
  };
}

/** Canonicalizes a statement for duplicate detection (lowercase, single-spaced). */
export function normalizeStatement(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Meta-conversational statements the LLM sometimes hallucinates as facts. */
const META_CONVERSATIONAL_PATTERNS = [
  /^user\s+(is|wants?|asked?|greeted|said|requested)\b/,
  /\b(setting up|update|updating|set up)\s+(persona|profile|preferences)\b/,
];

export type FactRejectionReason = 'empty' | 'too-long' | 'meta' | 'duplicate';

export interface AcceptedFact {
  statement: string;
  questionnaire?: NormalizedFactEntry['questionnaire'];
}

export interface RejectedFact {
  statement: string;
  reason: FactRejectionReason;
}

/**
 * Applies the exact accept/reject rules the old handler applied inline, in order:
 *   empty → too-long (>200) → meta-conversational → duplicate (vs existing).
 * Duplicate detection is against `existingStatements` only — like the original,
 * facts accepted earlier in the same batch do NOT dedup against each other.
 */
export function filterNewFacts(
  entries: FactEntry[],
  existingStatements: Iterable<string>,
): { accepted: AcceptedFact[]; rejected: RejectedFact[] } {
  const existing = new Set<string>();
  for (const s of existingStatements) existing.add(s);

  const accepted: AcceptedFact[] = [];
  const rejected: RejectedFact[] = [];

  for (const factEntry of entries) {
    const { statement, questionnaire } = normalizeFactEntry(factEntry);
    const trimmed = statement.trim();
    if (!trimmed) {
      rejected.push({ statement: trimmed, reason: 'empty' });
      continue;
    }
    if (trimmed.length > MAX_FACT_LENGTH) {
      rejected.push({ statement: trimmed, reason: 'too-long' });
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (META_CONVERSATIONAL_PATTERNS.some((re) => re.test(lower))) {
      rejected.push({ statement: trimmed, reason: 'meta' });
      continue;
    }
    if (existing.has(normalizeStatement(trimmed))) {
      rejected.push({ statement: trimmed, reason: 'duplicate' });
      continue;
    }
    accepted.push({ statement: trimmed, questionnaire });
  }

  return { accepted, rejected };
}
