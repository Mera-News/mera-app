import { asUntrusted } from '../../prompts/untrusted-text';
import { TRACK_OPTION_RULES } from '../follow-story/prompt';
import { IDENTITY_LINE, languageLine, renderPrompt, type ChatTurn } from '../shared';
import { DEVICE_SLOTS } from '../../../harnesses/slots';
import { render } from '../../../harnesses/template';

export function articleFeedbackInstructions(languageName?: string): string {
  const language = languageLine(languageName);
  return render(DEVICE_SLOTS["article-chat/instructions"], { IDENTITY_LINE, language });
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
  /** Feedback sheet answers, already worded: "question: answer (applied)" or "question (Mera's mistake, changes nothing)". */
  answers?: string[];
  /** The screen the reader tapped Tell Mera on. */
  screen?: string;
  /** Recent "Mera's mistake" reports, at most 3: "reason; story from <publication>, <country>, <language>". */
  mistakes?: string[];
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
  if (c.answers?.length) blocks.push(`The user's feedback${c.screen ? ` on the ${u(c.screen, 40)} screen` : ''}:\n${list(c.answers, 6, 200)}`);
  if (c.mistakes?.length) blocks.push(`Recent mistakes the user reported:\n${list(c.mistakes, 3, 200)}`);
  return blocks.join('\n\n');
}

export function buildArticleFeedbackPrompt(context: ArticleChatContext, history: readonly ChatTurn[], budgetTokens: number): string {
  return renderPrompt(`Option rules: ${TRACK_OPTION_RULES}\n\n${articleChatContext(context)}`, history, budgetTokens);
}
