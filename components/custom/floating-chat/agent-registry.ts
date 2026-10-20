// Agent registry — maps a floating-chat ChatContext to the IAgent that should
// power the session. This is the single seam for adding context-aware agents
// (article discussion, generic route help) without touching the session
// container or the inference hooks.

import { ArticleFeedbackAgent } from '@/lib/llm/agents/ArticleFeedbackAgent';
import { FollowStoryAgent } from '@/lib/llm/agents/FollowStoryAgent';
import { PersonaUpdateAgent } from '@/lib/llm/agents/PersonaUpdateAgent';
import { TutorialHelpAgent } from '@/lib/llm/agents/TutorialHelpAgent';
import { ArticleFeedbackOnDeviceAgent } from '@/lib/llm/agents/on-device/ArticleFeedbackOnDeviceAgent';
import { FollowStoryOnDeviceAgent } from '@/lib/llm/agents/on-device/FollowStoryOnDeviceAgent';
import { PersonaOnDeviceAgent } from '@/lib/llm/agents/on-device/PersonaOnDeviceAgent';
import { TutorialHelpOnDeviceAgent } from '@/lib/llm/agents/on-device/TutorialHelpOnDeviceAgent';
import type { ChatAgent, IAgent, OnDeviceAgent } from '@/lib/llm/types';
import type { ChatContext } from '@/lib/stores/floating-chat-store';

/** The agent for a chat context on the given engine. On-device has its own
 *  agents (prompts, schemas, D27); the cloud ones are cloud-only. */
export function createAgentForContext(
  context: ChatContext,
  userId: string,
  surface: 'ONBOARDING' | 'CONFIG',
  kind?: 'cloud',
): IAgent;
export function createAgentForContext(
  context: ChatContext,
  userId: string,
  surface: 'ONBOARDING' | 'CONFIG',
  kind: 'local',
): OnDeviceAgent;
export function createAgentForContext(
  context: ChatContext,
  userId: string,
  surface: 'ONBOARDING' | 'CONFIG',
  kind: 'cloud' | 'local' = 'cloud',
): ChatAgent {
  if (kind === 'local') return createOnDeviceAgent(context, userId, surface);
  switch (context.kind) {
    case 'article-suggestion':
      // Also the FACT-CHECK surface (pivot P8c). `proposeFactCheck` moved onto
      // this agent because the `Quick fact check` chip and the article tick both
      // send into the EXISTING article thread; the standalone FactCheckAgent and
      // its `fact-check` ChatContext kind are gone with it.
      return new ArticleFeedbackAgent(
        userId,
        { articleId: context.articleId, suggestionId: context.suggestionId },
        context.trackSubject ?? null,
      );

    case 'follow-story':
      // Article-less "follow a story" chat (Followed-stories FAB). Falling
      // through to the persona agent would be silently wrong: it has no
      // proposeTrack tool, so the user would be asked what to follow by the
      // seeded turn and then get persona edits instead of a scope card.
      return new FollowStoryAgent(userId);

    case 'generic':
      // Route-aware product help — today, the "Ask Mera" button on a tutorial
      // slide (`tutorials/<chapter>/<slide>`).
      //
      // This used to fall through to the persona agent, and that was silently
      // wrong in the worst way: PersonaUpdateAgent's prompt tells it to redirect
      // off-profile questions AND mandates at least one `saveExtractedFacts`
      // call per turn, so "what is the Explore tab for?" got deflected AND wrote
      // to the user's profile. The popover morphed and a reply streamed, so it
      // looked like it worked. TutorialHelpAgent has NO tools at all.
      return new TutorialHelpAgent(userId, context.route);

    case 'persona':
    default:
      return new PersonaUpdateAgent(userId, surface);
  }
}

function createOnDeviceAgent(
  context: ChatContext,
  userId: string,
  surface: 'ONBOARDING' | 'CONFIG',
): OnDeviceAgent {
  switch (context.kind) {
    case 'article-suggestion':
      return new ArticleFeedbackOnDeviceAgent(
        userId,
        { articleId: context.articleId, suggestionId: context.suggestionId },
        context.trackSubject ?? null,
      );
    case 'follow-story':
      return new FollowStoryOnDeviceAgent(userId);
    case 'generic':
      return new TutorialHelpOnDeviceAgent(userId, context.route);
    case 'persona':
    default:
      return new PersonaOnDeviceAgent(userId, surface);
  }
}
