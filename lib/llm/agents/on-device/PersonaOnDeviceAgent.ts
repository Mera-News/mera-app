// On-device persona chat: facts to offer, facts to remove and a yes or no to a
// waiting change, run through PersonaUpdateAgent's executors. Warnings,
// calibration and config changes are cloud-only.

import { getFacts } from '../../../database/services/fact-service';
import {
  buildPersonaChatPrompt,
  personaChatInstructions,
  personaChatSchema,
  personaChatTurn,
  shownFactIds,
  type PersonaChatContext,
  type PersonaChatReply,
} from '../../../news-harness/on-device/persona-chat';
import { describePending } from '../../../news-harness/on-device/shared';
import { formatTopicPlanNotesBlock } from '../../../news-harness/persona-management/topic-plan-notes';
import { useFloatingChatStore } from '../../../stores/floating-chat-store';
import { PersonaUpdateAgent } from '../PersonaUpdateAgent';
import type { ConversationMessage } from '../../types';
import type { OnDeviceAgent } from './types';
import { appLanguageName, chatTurns, respondStructured } from './run';

export class PersonaOnDeviceAgent implements OnDeviceAgent {
  readonly onDevice = true;
  readonly id: string;
  private readonly cloud: PersonaUpdateAgent;

  constructor(
    userId: string,
    private readonly surface: 'ONBOARDING' | 'CONFIG',
  ) {
    this.cloud = new PersonaUpdateAgent(userId, surface);
    this.id = this.cloud.id;
  }

  async respond(messages: ConversationMessage[]) {
    const facts = await getFacts(); // newest first
    const { proposal, topicPlanNotes } = useFloatingChatStore.getState();
    const context: PersonaChatContext = {
      facts: facts.map((f) => ({ id: f.id, statement: f.statement, attribute: f.questionnaireAttribute })),
      // The same notes the cloud context carries: a hidden discard turn is the
      // first thing history trimming drops, this block is not.
      topicPlanNotes: formatTopicPlanNotesBlock(topicPlanNotes),
      pending: describePending(proposal),
    };
    const value = await respondStructured<PersonaChatReply>(
      personaChatInstructions(this.surface, appLanguageName()),
      personaChatSchema(this.surface),
      (budget) => buildPersonaChatPrompt(this.surface, context, chatTurns(messages), budget),
    );
    return personaChatTurn(value, { factIds: shownFactIds(context), hasPending: context.pending != null });
  }

  executeTool(name: string, input: unknown) {
    return this.cloud.executeTool(name, input);
  }
}
