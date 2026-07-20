// Agent registry — maps a floating-chat ChatContext to the IAgent that should
// power the session. This is the single seam for adding context-aware agents
// (article discussion, generic route help) without touching the session
// container or the inference hooks.

import { ArticleFeedbackAgent } from '@/lib/llm/agents/ArticleFeedbackAgent';
import { PersonaUpdateAgent } from '@/lib/llm/agents/PersonaUpdateAgent';
import type { IAgent } from '@/lib/llm/types';
import type { ChatContext } from '@/lib/stores/floating-chat-store';

export function createAgentForContext(
  context: ChatContext,
  userId: string,
  surface: 'ONBOARDING' | 'CONFIG',
): IAgent {
  switch (context.kind) {
    case 'article-suggestion':
      return new ArticleFeedbackAgent(
        userId,
        { articleId: context.articleId, suggestionId: context.suggestionId },
        context.trackSubject ?? null,
      );

    case 'generic':
      // FUTURE: return a route-aware generic assistant agent seeded with
      // context.route. v1 falls through to the persona agent.
      return new PersonaUpdateAgent(userId, surface);

    case 'persona':
    default:
      return new PersonaUpdateAgent(userId, surface);
  }
}
