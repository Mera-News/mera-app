// What a chat engine (cloud or on-device) offers the chat session. Engines
// are plain closures over their own turn state and write to their store; no
// component owns them, so closing the chat never ends a turn.

import type { ChatAgent, IAgent } from '@/lib/llm/types';

/** `A` is the agent kind the engine runs: IAgent on cloud, OnDeviceAgent on the phone. */
export interface ChatEngine<A extends ChatAgent = IAgent> {
    send(text: string): void;
    /** A turn the user never sees (the topic-plan discard note). */
    sendHidden(text: string): void;
    /** The view re-creates its agent when the context object changes. */
    setAgent(agent: A): void;
    /** The Stop button: abort the turn in flight (and a queued hidden one).
     *  The partial reply stays; nothing new is staged or saved. */
    stop(): void;
    /** Stops the engine writing to its store once replaced. A turn already
     *  running finishes its own cleanup (the inference queue resumes). */
    dispose(): void;
}
