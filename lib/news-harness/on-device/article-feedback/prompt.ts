import { asUntrusted } from '../../prompts/untrusted-text';
import { TRACK_OPTION_RULES } from '../follow-story/prompt';
import { IDENTITY_LINE, languageLine, renderPrompt, type ChatTurn } from '../shared';

export function articleFeedbackInstructions(languageName?: string): string {
  return `${IDENTITY_LINE}
The user is asking about one news article Mera suggested. You see only its title, publication and a short description, never the full text.
Pick one intent:
- answer: explain why it was suggested, or answer from what you see.
- track: they want to follow this story. Give 3 or 4 options using names from the article.
- less or more: they want fewer or more articles like this. Fill change.
- mute: they want nothing more from this publication.
- confirm or cancel: a change is waiting and they agree or decline.
Fact checks and web searches need Private cloud, so say that if asked.
${languageLine(languageName)}`;
}

/** Everything the context block shows, already read by the adapter. */
export interface ArticleChatContext {
  today: string;
  published?: string | null;
  title: string;
  publication?: string | null;
  description?: string | null;
  category?: string | null;
  entities?: string[];
  /** 0 to 1, null while unscored. */
  relevance?: number | null;
  note?: string | null;
  matchedTopics: string[];
  /** Statements of the user's facts behind the matched topics. */
  producingFacts: string[];
  relatedCoverage: string[];
  alreadyFollowing?: boolean;
  verdict?: 'like' | 'dislike' | null;
  pending?: string | null;
}

const u = (value: string, max: number) => asUntrusted(value, max);
const list = (items: string[], max: number, each: number) =>
  items.length > 0 ? items.slice(0, max).map((i) => `- ${u(i, each)}`).join('\n') : 'None';

export function articleChatContext(c: ArticleChatContext): string {
  const article = [`Title: ${u(c.title, 160)}`];
  if (c.published) article.push(`Published: ${c.published}`);
  if (c.publication) article.push(`Publication: ${u(c.publication, 80)}`);
  if (c.description) article.push(`Description: ${u(c.description, 300)}`);
  if (c.category) article.push(`Category: ${u(c.category, 60)}`);
  if (c.entities?.length) article.push(`Names: ${c.entities.slice(0, 8).map((e) => u(e, 60)).join(', ')}`);
  const blocks = [`Today: ${c.today}`, `Article:\n${article.join('\n')}`];
  blocks.push(
    c.relevance == null
      ? 'Not scored yet.'
      : `Relevance: ${Math.min(10, c.relevance * 10).toFixed(1)} out of 10.${c.note ? ` Note: ${u(c.note, 200)}` : ''}`,
  );
  blocks.push(`Matched topics:\n${list(c.matchedTopics, 6, 80)}`);
  blocks.push(`Your facts behind them:\n${list(c.producingFacts, 6, 160)}`);
  if (c.relatedCoverage.length > 0) blocks.push(`Related coverage:\n${list(c.relatedCoverage, 5, 120)}`);
  if (c.alreadyFollowing) blocks.push('The user already follows this story, so do not offer options again.');
  if (c.verdict) blocks.push(c.verdict === 'like' ? 'The user liked this article.' : 'The user disliked this article.');
  if (c.pending) blocks.push(c.pending);
  return blocks.join('\n\n');
}

export function buildArticleFeedbackPrompt(context: ArticleChatContext, history: readonly ChatTurn[], budgetTokens: number): string {
  return renderPrompt(`Option rules: ${TRACK_OPTION_RULES}\n\n${articleChatContext(context)}`, history, budgetTokens);
}
