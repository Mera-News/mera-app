// On-device "follow a story" chat: the reply's options are staged through the
// cloud agent's own proposeTrack executor, so the story card is the same one.
// Route 'kev' (D38): Kev decides, the built-in model writes; 'single' is one
// built-in call.

import {
  buildFollowStoryPrompt,
  FOLLOW_STORY_SCHEMA,
  followStoryInstructions,
  followStoryTurn,
  type FollowStoryReply,
} from '../../../news-harness/on-device/follow-story';
import { runFollowKevTurn } from '../../../news-harness/on-device/follow-story/kev-spec';
import { describePending } from '../../../news-harness/on-device/shared';
import { proposalRequiresUserChoice } from '../../../news-harness/core/proposals';
import { useFloatingChatStore } from '../../../stores/floating-chat-store';
import { FollowStoryAgent } from '../FollowStoryAgent';
import type { ConversationMessage } from '../../types';
import type { OnDeviceAgent } from './types';
import {
  appLanguageName,
  chatTurns,
  kevPorts,
  onDeviceTool,
  respondStructured,
  routeOf,
  today,
  tryKev,
  type OnDeviceAgentOptions,
} from './run';

export class FollowStoryOnDeviceAgent implements OnDeviceAgent {
  readonly onDevice = true;
  readonly id: string;
  private readonly cloud: FollowStoryAgent;

  constructor(
    userId: string,
    private readonly opts: OnDeviceAgentOptions = {},
  ) {
    this.cloud = new FollowStoryAgent(userId);
    this.id = this.cloud.id;
  }

  async respond(messages: ConversationMessage[]) {
    const proposal = useFloatingChatStore.getState().proposal;
    const pending = describePending(proposal);
    if (routeOf('follow', this.opts) === 'kev') {
      const kev = await tryKev('FollowStoryOnDeviceAgent', () =>
        runFollowKevTurn(
          {
            today: today(),
            pending: pending ? { text: pending, tapOnly: proposalRequiresUserChoice(proposal!) } : null,
            languageName: appLanguageName(),
          },
          messages,
          kevPorts(this.opts),
        ),
      );
      if (kev) return kev;
    }
    const value = await respondStructured<FollowStoryReply>(
      followStoryInstructions(appLanguageName()),
      FOLLOW_STORY_SCHEMA,
      (budget) => buildFollowStoryPrompt({ today: today(), pending }, chatTurns(messages), budget),
    );
    return followStoryTurn(value);
  }

  async executeTool(name: string, input: unknown) {
    return (await onDeviceTool(name, input)) ?? this.cloud.executeTool(name, input);
  }
}
