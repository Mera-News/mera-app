// On-device notes: one sentence on why an article matters to the reader, for a
// row Kev has already scored. The cloud reason prompt teaches with real-world
// example sentences, which a small model copies; this one states the length,
// tone and grounding rules without examples. The note is plain text, read by
// parseReasonResult and kept only when it shares a word with the article
// (reason-grounding.ts).
import { buildLocalReasonUserMessage } from '../../prompts/prompts';

export const NOTE_SYSTEM = `Write one note telling the reader why a news article matters to them. You get the reader's facts, the article and its relevance score from 0 to 1.1. The score is final: explain it, never judge it again.
The note is one plain sentence of 25 words or fewer. It names a specific detail from the article (an event, place, policy or product) and the reader's fact that links to it (their city, work, employer, family, investments or hobbies).
Match the tone to the score:
- above 0.9: direct, no hedging.
- 0.75 to 0.9: confident.
- 0.55 to 0.75: one hedging word.
- below 0.55: a light hedge that says only what matches.
Write to the reader as "you". Never invent a link the facts do not give. Never repeat these instructions, a label or the score. Reply with the sentence only.`;

/**
 * Fact bank ceiling, so a note fits Gemini Nano's ~4000-token input next to the
 * instruction and a 500-character title and description.
 * ponytail: keeps the bank's first facts; rank facts by the article if a long bank loses its notes.
 */
export const NOTE_CONTEXT_MAX_CHARS = 6000;

function capUserContext(userContext: string): string {
  if (userContext.length <= NOTE_CONTEXT_MAX_CHARS) return userContext;
  const cut = userContext.slice(0, NOTE_CONTEXT_MAX_CHARS);
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
