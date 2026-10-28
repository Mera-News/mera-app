// What a chat engine (cloud or on-device) offers the chat session. Engines
// are plain closures over their own turn state and write to their store; no
// component owns them, so closing the chat never ends a turn.

import type { IAgent } from '@/lib/llm/types';
import type { ChatAgent } from '@/lib/llm/agents/on-device/types';
import type { ProposalAction, TrackFeedbackSubject } from '@/lib/news-harness/core/types';

/** The most options a follow card may hold, grown ones included. */
export const MAX_FOLLOW_OPTIONS = 8;

/** "More options" on a follow card, built from the card alone (`requestMoreOptions`). */
export interface MoreOptionsRequest {
    /** The card the reader tapped. */
    proposalId: string;
    /** Every option on the card now, grown ones included, in card order. */
    shown: { label: string; searchText: string }[];
    /** MAX_FOLLOW_OPTIONS minus shown, at least 1. */
    room: number;
    /** The card's subject, stamped on every returned action. */
    subject: TrackFeedbackSubject;
}

/** Never thrown: an empty `actions` always carries a reason. */
export interface MoreOptionsResult {
    /** track_story only, none matching a shown label or searchText, at most `room`. */
    actions: Extract<ProposalAction, { type: 'track_story' }>[];
    reason?: 'none' | 'busy' | 'failed' | 'stopped';
}

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
    /** New options for a follow card. Adds nothing to the thread, the wire or
     *  persistence and never stages a proposal: the card merges the result.
     *  Absent on an engine that cannot do it, and then the card hides the button. */
    moreOptions?(req: MoreOptionsRequest): Promise<MoreOptionsResult>;
    /** Stops the engine writing to its store once replaced. A turn already
     *  running finishes its own cleanup (the inference queue resumes). */
    dispose(): void;
}
