// articleChatContext — the one place the 'article-suggestion' chat context shape
// is built, so a new field reaches every article surface.

import type { ChatContext } from '@/lib/stores/floating-chat-store';

export interface AskMeraSubject {
  /** At least one of articleId / suggestionId must be set; the agent resolves
   *  the other from whichever it is given. */
  articleId?: string;
  suggestionId?: string;
  title?: string;
}

/** The chat context for an article, or null when there is no id to open it
 *  on. The article page's Mera button opens the same context. */
export function articleChatContext(subject: AskMeraSubject): ChatContext | null {
  if (!subject.articleId && !subject.suggestionId) return null;
  return {
    kind: 'article-suggestion',
    articleId: subject.articleId,
    suggestionId: subject.suggestionId,
    articleTitle: subject.title,
  };
}
