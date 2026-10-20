// On-device tutorial help: plain streamed text, no tools.

import { inferStream } from '../../../mera-protocol-toolkit';
import { createThinkStripper } from '../../../algorithms/think-strip';
import { ON_DEVICE_CHAT_MAX_TOKENS } from '../../../news-harness/on-device/shared';
import {
  buildTutorialHelpOnDevicePrompt,
  tutorialHelpInstructions,
} from '../../../news-harness/on-device/tutorial-help';
import logger from '../../../logger';
import type { ConversationMessage, OnDeviceAgent } from '../../types';
import { appLanguageName, chatTurns, promptBudget } from './run';

export class TutorialHelpOnDeviceAgent implements OnDeviceAgent {
  readonly onDevice = true;
  readonly id: string;

  constructor(
    userId: string,
    /** `tutorials/<chapter>/<slide>` from the chat context. */
    private readonly route: string | null,
  ) {
    this.id = `tutorial-help-${userId}`;
  }

  async respond(
    messages: ConversationMessage[],
    io: { signal: AbortSignal; onText: (delta: string) => void },
  ) {
    const system = tutorialHelpInstructions(appLanguageName());
    const prompt = buildTutorialHelpOnDevicePrompt(this.route, chatTurns(messages), await promptBudget(system));
    const strip = createThinkStripper();
    let reply = '';
    for await (const token of inferStream(
      { systemPrompt: system, prompt, maxTokens: ON_DEVICE_CHAT_MAX_TOKENS, temperature: 0.4 },
      io.signal,
    )) {
      const visible = strip.push(token);
      if (!visible) continue;
      reply += visible;
      io.onText(visible);
    }
    const tail = strip.flush();
    if (tail) {
      reply += tail;
      io.onText(tail);
    }
    return { reply, calls: [] };
  }

  async executeTool(name: string) {
    // Never offered a tool; a name here can only be invented.
    logger.warn('[TutorialHelpOnDeviceAgent] Refused a tool call', { name });
    return { result: { error: 'this assistant only explains how mera works and cannot change anything' } };
  }
}
