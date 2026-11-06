// What a chat engine (cloud or on-device) offers the chat session. Engines
// are plain closures over their own turn state and write to their store; no
// component owns them, so closing the chat never ends a turn.

import type { IAgent } from '@/lib/llm/types';
import type { ChatAgent } from '@/lib/llm/agents/on-device/types';
import type { ForcedSkill } from '@/lib/mera-harness/core/core';
import type { ProposalAction, TrackFeedbackSubject } from '@/lib/news-harness/core/types';

/** The most options a follow card may hold, grown ones included. */
export const MAX_FOLLOW_OPTIONS = 8;

/** Tools that change the reader's data or a card's outcome when they run. A turn
 *  that ran one is never retried. Staging tools (saveExtractedFacts, proposeTrack,
 *  proposeChanges, proposeFactCheck) write nothing, so a repeat is harmless. */
export const MUTATING_CHAT_TOOLS: ReadonlySet<string> = new Set([
    'applyProposal',
    'cancelProposal',
    'deleteUserFacts',
    'updateUserConfig',
    'issueWarning',
    'runCalibration',
]);

/** What rides one send. Held nowhere else, so nothing needs clearing. */
export interface SendOptions {
    /** This turn runs this skill with no route leg. Ignored on device, and by a
     *  chat that does not run on the harness. */
    forcedSkill?: ForcedSkill;
    /** The question this send answers, when no row holds it. Ignored on device. */
    asked?: string;
}

/** An onboarding line: no model call and no turn. The next real turn reads it. */
export interface ScriptedExchange {
    /** The reader's row, when they tapped an option. */
    user?: string;
    /** Mera's row. Ends on its question, as its own last line. */
    assistant: string;
    /** This row is the onboarding menu: the thread draws the card under it. */
    menu?: true;
    /** The question `user` answers, when no row holds it. */
    asked?: string;
}

/** The marker is the id, because the id is what `messages` keeps and resume returns. */
const MENU_ROW_SUFFIX = '-onboarding-menu';

export const isOnboardingMenuRow = (id: string): boolean => id.endsWith(MENU_ROW_SUFFIX);

/** Ids for one exchange. Rows written in one tick can share a timestamp, and the
 *  table then orders by id, so these sort reader first ("a" before "b" and "o"). */
export function scriptedRowIds(menu: boolean | undefined): { user: string; assistant: string } {
    const base = `scripted-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return { user: `${base}-a`, assistant: menu ? `${base}${MENU_ROW_SUFFIX}` : `${base}-b` };
}

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

/** A turn from a dead process. `heldMessageId`: this thread already shows its message. */
export interface KilledTurn {
    text: string;
    heldMessageId?: string;
}

/** `A` is the agent kind the engine runs: IAgent on cloud, OnDeviceAgent on the phone. */
export interface ChatEngine<A extends ChatAgent = IAgent> {
    send(text: string, opts?: SendOptions): void;
    /** A turn the user never sees (the topic-plan discard note). */
    sendHidden(text: string): void;
    /** Tells the reader these facts were removed: no user turn, no tools. The
     *  session calls it only when nothing is busy. */
    tellRemovedFacts?(statements: readonly string[]): void;
    /** The last turn threw and may be sent again; absent on an engine that cannot. */
    canRetry?(): boolean;
    /** Sends the failed turn again: no new bubble, the wire as the turn found it.
     *  With `killed`, a turn a kill ended instead. Either way what the first try
     *  may have done is not done twice. Answers whether a turn started. */
    retry?(killed?: KilledTurn): boolean;
    /** The view re-creates its agent when the context object changes. */
    setAgent(agent: A): void;
    /** The Stop button: abort the turn in flight (and a queued hidden one).
     *  The partial reply stays; nothing new is staged or saved. */
    stop(): void;
    /** New options for a follow card. Adds nothing to the thread, the wire or
     *  persistence and never stages a proposal: the card merges the result.
     *  Absent on an engine that cannot do it, and then the card hides the button. */
    moreOptions?(req: MoreOptionsRequest): Promise<MoreOptionsResult>;
    /** "Add to my profile instead": the fixed question joins the thread as an
     *  assistant row and the next turn reads the answer against it. No model call.
     *  Absent on device, where no card carries the offer. */
    askImpact?(question: string): Promise<void>;
    /** Adds the rows and tells the next turn what they asked. False, adding
     *  nothing, while a turn runs. Absent on device: onboarding chat is cloud only. */
    scriptedExchange?(exchange: ScriptedExchange): Promise<boolean>;
    /** Stops the engine writing to its store once replaced. A turn already
     *  running finishes its own cleanup (the inference queue resumes). */
    dispose(): void;
}
