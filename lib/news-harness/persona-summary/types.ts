// news-harness — persona-summary types (PURE, RN-free).
//
// The persona-summary pipeline turns the structured on-device persona (facts +
// their generated topics) into a handful of plain-language, first/third-person
// "About you" strings the Profile tab renders. Everything here is data-only so
// the prompt builder, parser, and assembler stay unit-testable off-device.

/** One fact fed to the summary prompt, with the topic-row ids it owns so the
 *  assembler can link a produced string back to real fact/topic ids. */
export interface PersonaSummaryFactInput {
  factId: string;
  statement: string;
  /** Fact-level weight (higher = more important). Drives prompt selection. */
  weight: number;
  /** Ids of the active topic rows generated from this fact. */
  topicIds: string[];
}

/** A single string as the LLM emitted it: the text plus the 1-based fact
 *  numbers (from the ordered prompt list) it claims to be based on. */
export interface PersonaSummaryDraft {
  text: string;
  /** 1-based indexes into the ordered fact list handed to the prompt. */
  factRefs: number[];
}

/** A finished, storable summary string with its resolved fact/topic ids. */
export interface PersonaSummaryStringResult {
  text: string;
  linkedFactIds: string[];
  linkedTopicIds: string[];
}
