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
      questionnaire_attribute?: string;
      /**
       * 0-3 ALTERNATIVE readings of the same thing the user said, offered
       * alongside `statement` so the user picks which one Mera saves.
       *
       * This exists because extraction used to resolve an ambiguous proper noun
       * by rewriting it — "interested in sporting football club" became
       * "Interested in sporting a football club", which silently decided that
       * `sporting` was a verb and destroyed the club. A reading the user did not
       * choose is a guess, and a guess that reaches topic generation as a fact
       * cannot be told apart from one they meant.
       */
      alternatives?: string[];
    };

/** `level`/`levelCategory` are DEAD: the legacy level-based questionnaire is
 *  gone, so `normalizeFactEntry` can never populate them again. They stay on
 *  this type because two consumers still READ them off the object —
 *  lib/database/services/fact-service.ts::addFact and
 *  lib/database/models/Fact.ts::createFact — which were deliberately left
 *  untouched so the `facts` table's (now never-written) `questionnaire_level`
 *  columns keep compiling. Remove those two reads first if you delete these. */
export interface NormalizedFactEntry {
  statement: string;
  questionnaire?: {
    level?: number;
    levelCategory?: string;
    attribute?: string;
  };
  /** Extra readings offered beside `statement`. Never populated for the legacy
   *  string form, which by construction offers exactly one reading. */
  alternatives?: string[];
}

export function normalizeFactEntry(entry: FactEntry): NormalizedFactEntry {
  if (typeof entry === 'string') {
    return { statement: entry };
  }
  return {
    statement: entry.statement ?? '',
    questionnaire: entry.questionnaire_attribute
      ? { attribute: entry.questionnaire_attribute }
      : undefined,
    alternatives: Array.isArray(entry.alternatives)
      ? entry.alternatives.filter((a): a is string => typeof a === 'string')
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

// ---------------------------------------------------------------------------
// Fact CHOICE groups — propose-before-save
// ---------------------------------------------------------------------------

/** How many readings one card may offer. The user asked for as few as possible:
 *  one when the input is unambiguous, never more than this. */
export const MAX_FACT_CHOICE_OPTIONS = 4;

/**
 * One fact Mera is OFFERING, with the readings it is offering for it.
 *
 * `options[0]` is the model's preferred reading. A group with one option is the
 * unambiguous case and is still a group — the user still taps, which is what
 * makes the tap mean "save this" rather than "stop showing me this".
 */
export interface FactChoiceGroup {
  options: string[];
  questionnaire?: NormalizedFactEntry['questionnaire'];
}

/**
 * Turns the tool's `extracted_user_information` array into offerable groups.
 *
 * ONE ARRAY ELEMENT = ONE FACT = ONE GROUP, and its readings live on the
 * element. That is what keeps "several distinct facts in one turn" and "several
 * readings of one fact" from competing: N facts give N independent cards, so
 * nothing has to be squeezed through a single proposal-level flag.
 *
 * Every option runs the SAME accept/reject rules a saved fact used to run
 * (`filterNewFacts`), so a duplicate or over-long reading is dropped from the
 * card rather than offered and then refused after the tap. A group whose every
 * option is rejected yields no group at all — there is nothing to ask about.
 */
export function filterFactChoiceGroups(
  entries: FactEntry[],
  existingStatements: Iterable<string>,
): { groups: FactChoiceGroup[]; rejected: RejectedFact[] } {
  const groups: FactChoiceGroup[] = [];
  const rejected: RejectedFact[] = [];

  for (const entry of entries) {
    const { statement, questionnaire, alternatives } = normalizeFactEntry(entry);
    // Preferred reading first, then alternatives, deduped against each other so
    // a model that repeats itself does not render the same row twice.
    const candidates = [statement, ...(alternatives ?? [])];
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const c of candidates) {
      const key = normalizeStatement(c ?? '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }

    const { accepted, rejected: groupRejected } = filterNewFacts(unique, existingStatements);
    rejected.push(...groupRejected);
    if (accepted.length === 0) continue;

    groups.push({
      options: accepted.slice(0, MAX_FACT_CHOICE_OPTIONS).map((a) => a.statement),
      // The attribute belongs to the FACT, not to a reading of it, so it is
      // taken from the entry rather than from whichever option survived.
      // It must reach `addFact`: resolveUserLocationFact keys on it, and a
      // residence fact that loses it stops anchoring every future topic run.
      questionnaire,
    });
  }

  return { groups, rejected };
}
