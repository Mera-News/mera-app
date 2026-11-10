// On-device notes: one sentence on why an article matters to the reader, for a
// row Kev has already scored. The cloud reason prompt teaches with real-world
// example sentences, which a small model copies; this one states the length,
// tone and grounding rules without examples. The note is plain text, read by
// parseReasonResult and kept only when it shares a word with the article
// (reason-grounding.ts).
import { buildLocalReasonUserMessage } from '../../prompts/prompts';
import { countTokens, largestFitting } from '../shared';
import { DEVICE_SLOTS } from '../../../harnesses/slots';

export const NOTE_SYSTEM = DEVICE_SLOTS["notes/note-system"];

/**
 * Fact bank ceiling in tokens (countTokens), so a note fits Gemini Nano's ~4000-token input next
 * to the instruction and a 500-character title and description, whatever script the facts are in.
 * ponytail: keeps the bank's first facts; rank facts by the article if a long bank loses its notes.
 */
export const NOTE_CONTEXT_MAX_TOKENS = 2000;

function capUserContext(userContext: string): string {
  if (countTokens(userContext) <= NOTE_CONTEXT_MAX_TOKENS) return userContext;
  const fit = largestFitting(userContext.length, (n) => countTokens(userContext.slice(0, n)) <= NOTE_CONTEXT_MAX_TOKENS);
  const cut = userContext.slice(0, fit);
  const lastFact = cut.lastIndexOf('. ');
  return lastFact > 0 ? cut.slice(0, lastFact + 1) : cut;
}

export function buildNotePrompt(params: Parameters<typeof buildLocalReasonUserMessage>[0]): {
  system: string;
  prompt: string;
} {
  return {
    system: NOTE_SYSTEM,
    prompt: buildLocalReasonUserMessage({ ...params, userContext: capUserContext(params.userContext) }),
  };
}
