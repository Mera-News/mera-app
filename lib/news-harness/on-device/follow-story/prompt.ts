import { IDENTITY_LINE, languageLine, renderPrompt, type ChatTurn } from '../shared';
import { MAX_OPTION_LABEL_WORDS, MAX_TRACK_SEARCH_WORDS } from './schema';
import { DEVICE_BASE_SLOTS } from '../../../harnesses/slots.generated';
import { render } from '../../../harnesses/template';

/** How every on-device track option is written, shared with the article chat. */
export const TRACK_OPTION_RULES = render(DEVICE_BASE_SLOTS["follow-story/track-option-rules"], { MAX_OPTION_LABEL_WORDS, MAX_TRACK_SEARCH_WORDS });

export function followStoryInstructions(languageName?: string): string {
  const language = languageLine(languageName);
  return render(DEVICE_BASE_SLOTS["follow-story/instructions"], { IDENTITY_LINE, language });
}

export interface FollowStoryContext {
  /** YYYY-MM-DD, from the adapter's clock. */
  today: string;
  /** The card still waiting on the user (describePending), if any. */
  pending?: string | null;
}

export function followStoryContext(input: FollowStoryContext): string {
  return input.pending ? `Today: ${input.today}\n${input.pending}` : `Today: ${input.today}`;
}

export function buildFollowStoryPrompt(context: FollowStoryContext, history: readonly ChatTurn[], budgetTokens: number): string {
  return renderPrompt(`Option rules: ${TRACK_OPTION_RULES}\n\n${followStoryContext(context)}`, history, budgetTokens);
}
