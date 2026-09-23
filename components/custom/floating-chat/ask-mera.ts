// askMeraAbout — the one entry every article surface uses to open Mera on an
// article.
//
// It OPENS the chat and sends nothing. `openArticleFeedback(context, message)`
// looks like the same call and is not: it auto-sends a user turn through
// `pendingInitialMessage`, which spends a model call before the reader has
// typed a word. Opening costs zero calls; seeding costs one.
//
// Exists because the same `expand({ kind: 'article-suggestion', ... })` shape
// was written out at every article surface (the card action row, the compact
// actions sheet) and the shared `•••` menu is about to add a third. One helper
// keeps the context shape in one place, so a new field reaches every surface.

import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';

export interface AskMeraSubject {
  /** At least one of articleId / suggestionId must be set; the agent resolves
   *  the other from whichever it is given. */
  articleId?: string;
  suggestionId?: string;
  title?: string;
}

/** Opens the Mera chat on this article. Returns false when there is no id to
 *  open it on, so a caller can tell a no-op from an open. */
export function askMeraAbout(subject: AskMeraSubject): boolean {
  if (!subject.articleId && !subject.suggestionId) return false;
  useFloatingChatStore.getState().expand({
    kind: 'article-suggestion',
    articleId: subject.articleId,
    suggestionId: subject.suggestionId,
    articleTitle: subject.title,
  });
  return true;
}
