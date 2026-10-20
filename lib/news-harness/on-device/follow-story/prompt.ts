import { MAX_TRACK_SEARCH_WORDS } from '../../article-feedback/agent-core';
import { IDENTITY_LINE, languageLine, renderPrompt, type ChatTurn } from '../shared';
import { MAX_OPTION_LABEL_WORDS } from './schema';

/** How every on-device track option is written, shared with the article chat. */
export const TRACK_OPTION_RULES = `Each option has a label, the story name the user sees (${MAX_OPTION_LABEL_WORDS} words or fewer, Title Case), and a search, a query of ${MAX_TRACK_SEARCH_WORDS} words or fewer naming the people, places and organisations of the story, keeping their capitals. Order them from the narrow event to the broad ongoing story. Write label and search in English, whatever language the reply is in: future articles are matched in English. Never name a year, season or edition that has already ended; today's date is in the context. Never write the word scope.`;

export function followStoryInstructions(languageName?: string): string {
  return `${IDENTITY_LINE}
The user wants to follow a news story. There is no article, only what they write.
If they have not named a story yet, ask in one short sentence which story, and leave options empty.
Once they name one, give 3 or 4 options, following the option rules in the prompt, and set reply to one short line asking them to pick a story below. Use only names the user wrote.
If they ask for something other than following a story, say this chat only starts following a story.
${languageLine(languageName)}`;
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
