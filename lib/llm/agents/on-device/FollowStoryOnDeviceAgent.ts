// On-device "follow a story" chat: the reply's options are staged through the
// cloud agent's own proposeTrack executor, so the story card is the same one.

import {
  buildFollowStoryPrompt,
  FOLLOW_STORY_SCHEMA,
  followStoryInstructions,
  followStoryTurn,
  type FollowStoryReply,
} from '../../../news-harness/on-device/follow-story';
import { describePending } from '../../../news-harness/on-device/shared';
import { useFloatingChatStore } from '../../../stores/floating-chat-store';
import { FollowStoryAgent } from '../FollowStoryAgent';
import type { ConversationMessage, OnDeviceAgent } from '../../types';
import { appLanguageName, chatTurns, respondStructured, today } from './run';

export class FollowStoryOnDeviceAgent implements OnDeviceAgent {
  readonly onDevice = true;
  readonly id: string;
  private readonly cloud: FollowStoryAgent;

  constructor(userId: string) {
    this.cloud = new FollowStoryAgent(userId);
    this.id = this.cloud.id;
  }

  async respond(messages: ConversationMessage[]) {
    const pending = describePending(useFloatingChatStore.getState().proposal);
    const value = await respondStructured<FollowStoryReply>(
      followStoryInstructions(appLanguageName()),
      FOLLOW_STORY_SCHEMA,
      (budget) => buildFollowStoryPrompt({ today: today(), pending }, chatTurns(messages), budget),
    );
    return followStoryTurn(value);
  }

  executeTool(name: string, input: unknown) {
    return this.cloud.executeTool(name, input);
  }
}
