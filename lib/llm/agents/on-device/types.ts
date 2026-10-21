// The on-device agent contract, kept beside the on-device agents so the cloud
// IAgent (lib/llm/types.ts) stays untouched.

import type { OnDeviceTurnResult } from '../../../news-harness/on-device/shared';
import type { ConversationMessage, IAgent, ToolExecutionResult } from '../../types';

/**
 * An ON-DEVICE chat agent (D27, D31). It builds its own prompt, runs the
 * on-device model (structured output, or a plain stream) and names the existing
 * executor tools the reply maps to; the on-device engine runs those through
 * `executeTool` exactly as a cloud tool call runs, so the cards are unchanged.
 */
export interface OnDeviceAgent {
  /** The same id as the cloud agent for this surface (persistence scoping). */
  readonly id: string;
  readonly onDevice: true;
  /** One turn. `onText` streams the reply for a plain-text flow; a structured flow never calls it. */
  respond(
    messages: ConversationMessage[],
    io: { signal: AbortSignal; onText: (delta: string) => void },
  ): Promise<OnDeviceTurnResult>;
  executeTool(name: string, input: unknown): Promise<ToolExecutionResult>;
}

/** What a chat view hands the chat session: a cloud agent or an on-device one, by engine kind. */
export type ChatAgent = IAgent | OnDeviceAgent;
