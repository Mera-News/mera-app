import type { ConversationMessage, ToolCallRecord } from '@/lib/llm/types';
import { readPendingGroups } from '@/lib/chat-tools/fact-choice-resolution';
import type { AgentStep, AgentTerminal, ChatThreadItem } from './types';
import {
  changedDataFrom,
  legStartStep,
  stepsForMessage,
  continuingStep,
} from './agent-step-labels';
import { asRecord } from './derive-fact-cards';

// ---------------------------------------------------------------------------
// Agent-steps boxes (pagent P2)
// ---------------------------------------------------------------------------
//
// ONE BOX PER TURN, not per message. A turn is several legs and therefore
// several assistant messages; a box per leg would flicker in and out as each
// leg settled. There is no turn id anywhere in the tree (every leg gets its own
// `asst-${Date.now()}-${rand}`), so a turn is derived from the sequence itself:
// the run of assistant messages following a user message. That costs one
// accumulator and keeps this module pure.
//
// The box is anchored AFTER the user message that opened the turn, so it never
// moves as legs accumulate, and a leg's prose renders below it.

export type AgentStepsItem = Extract<ChatThreadItem, { kind: 'agent-steps' }>;

interface TurnAccum {
  anchorId: string;
  firstAssistantId: string | null;
  steps: AgentStep[];
  toolStepCount: number;
  /** The turn put a card or chips on screen. */
  offered: boolean;
}

/** A tool call that leaves something on screen for the user to act on. */
function offersSomething(tc: ToolCallRecord): boolean {
  const r = asRecord(tc.result);
  if (!r || typeof r.error === 'string') return false;
  if (tc.name === 'ask_choice') return r.awaiting === 'user';
  if (tc.name === 'saveAsWritten') return true;
  if (tc.name === 'saveExtractedFacts') {
    return readPendingGroups(r).length > 0 || (Array.isArray(r.savedFacts) && r.savedFacts.length > 0);
  }
  return tc.name === 'deleteUserFacts';
}

interface SeqEntry {
  message: ConversationMessage;
}

/**
 * Build the per-turn boxes for one ordered message sequence.
 *
 * `turnActive` is the TURN-SCOPED flag from P1's agent turn state. It is
 * deliberately not `status` / `isStreaming` / `isStreamingRef`: all three are
 * named as though they were stream-scoped, behave turn-scoped nearly
 * everywhere, and go idle EARLY during a forced-extraction pass
 * (`useCloudPersonaChat` sets status idle unconditionally but releases
 * `turnBusyRef` only when no forced pass is running). Keying on one of those
 * paints a healthy turn as interrupted in that window, and P1's multi-leg loop
 * widens it to every gap between legs.
 *
 * `undefined` means the flag is not wired yet. The fallback is deliberately the
 * SAFE direction: collapse on "everything settled" (the old behaviour) and mark
 * nothing interrupted unless it is stale. Under-reporting an interruption looks
 * like today; over-reporting paints a live turn dead.
 */
export function buildTurnBoxes(
  seq: SeqEntry[],
  stale: boolean,
  turnActive: boolean | undefined,
  agentTerminal: AgentTerminal | null,
  waitPhase: string | null = null,
): Map<string, AgentStepsItem> {
  const turns: TurnAccum[] = [];
  let current: TurnAccum | null = null;

  for (const { message } of seq) {
    if (message.hidden) continue;
    if (message.role === 'user') {
      current = {
        anchorId: message.id,
        firstAssistantId: null,
        steps: [],
        toolStepCount: 0,
        offered: false,
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      // An assistant message with no user turn before it (a resumed thread that
      // begins mid-turn). Anchor the box on the assistant message itself.
      current = {
        anchorId: message.id,
        firstAssistantId: message.id,
        steps: [],
        toolStepCount: 0,
        offered: false,
      };
      turns.push(current);
    }
    if (current.firstAssistantId === null) current.firstAssistantId = message.id;
    const toolSteps = stepsForMessage(message.id, message.toolCalls, false);
    current.steps.push(...toolSteps);
    current.toolStepCount += toolSteps.length;
    if ((message.toolCalls ?? []).some(offersSomething)) current.offered = true;
  }

  // THE LAST TURN OVERALL, not the last one that happened to call a tool. A
  // new turn has no tool calls yet, so keying on "last with tools" made the
  // PREVIOUS turn's box reopen with "Working on it" the moment the user sent
  // a new message (audit F5, 5 of 5 on device).
  const lastTurn = turns[turns.length - 1];
  const withTools = turns.filter(
    (t) =>
      t.toolStepCount > 0
      // A turn with no tools still needs a box to carry its terminal
      // sentence, or a `no-route` turn ends in silence.
      || (t === lastTurn && agentTerminal !== null && t.firstAssistantId !== null),
  );

  const out = new Map<string, AgentStepsItem>();
  for (const turn of withTools) {
    const isLast = turn === lastTurn;
    // Only the LAST turn of the live sequence can still be running.
    const active = !stale && isLast && turnActive === true;

    const hasPending = turn.steps.some((s) => s.status === 'pending');
    const allSettled = !hasPending;

    // Without the flag, fall back to the old settled-based collapse.
    const collapsed = turnActive === undefined ? allSettled : !active;
    const interrupted =
      turnActive === undefined ? stale && hasPending : !active && hasPending;

    // Strand pending rows only once the turn really cannot settle them.
    const steps = interrupted
      ? turn.steps.map((step) =>
          step.status === 'pending'
            ? {
                ...step,
                status: 'error' as const,
                consequenceKey: 'agentSteps.consequence.interrupted',
              }
            : step,
        )
      : turn.steps;

    // ONE ROW PER REPEATED STEP. Three find_similar_facts calls rendered as
    // "Looking for things you've already told me" three times in one box
    // (audit F6). Consecutive steps with the same text merge into one row,
    // which carries the worst status among them.
    const mergedSteps = mergeRepeatedSteps(steps);

    // The leg-start row is the box's first entry and always settled: the box
    // only exists once a tool call has appeared, which means the thinking phase
    // it describes is over.
    //
    // A STILL-RUNNING turn gets a trailing PENDING row. `onLeg` fires only
    // after a leg's whole tool loop settles, so without it every row is `done`
    // the instant the box appears, the box has no live indicator between legs,
    // and — because the typing suppression below keys on "this box has a
    // pending row" — the box and the wait line were BOTH on screen. A
    // simulator pass caught that on real pixels across consecutive frames.
    const full: AgentStep[] = [
      legStartStep(turn.firstAssistantId ?? turn.anchorId, true),
      ...mergedSteps,
      // The live row carries the wait line's phase when it is the web search
      // (ux2 batch 25, D6): the wait line itself is suppressed while a box is
      // live, so "Searching the web from your device…" could never show.
      ...(active ? [continuingStep(turn.anchorId, waitPhase === 'webSearch' ? 'chatPhases.webSearch' : undefined)] : []),
    ];

    out.set(turn.anchorId, {
      kind: 'agent-steps',
      key: `agent-steps-${turn.anchorId}`,
      steps: full,
      collapsed,
      doneCount: full.filter((s) => s.status === 'done').length,
      failedCount: full.filter((s) => s.status === 'error').length,
      // Only the LAST turn: the store holds one terminal, and stamping it on an
      // older box would relabel a turn that ended for a different reason.
      // "Mera didn't find anything to add" beside the card it just offered
      // (ux2 D5 backstop): a turn that put a card on screen did find something.
      terminal:
        isLast && !(agentTerminal === 'no-proposal' && turn.offered) ? (agentTerminal ?? null) : null,
      interrupted,
      changedData: changedDataFrom(full),
      latest: isLast && !stale,
    });
  }
  return out;
}

const STATUS_RANK: Record<AgentStep['status'], number> = { done: 0, pending: 1, error: 2 };

/** Merge consecutive steps that render the same line. Keeps the first step's
 *  id, so keys stay stable as later repeats arrive. */
function mergeRepeatedSteps(steps: AgentStep[]): AgentStep[] {
  const out: AgentStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    const same =
      prev
      && prev.kind === step.kind
      && prev.labelKey === step.labelKey
      && JSON.stringify(prev.labelValues ?? null) === JSON.stringify(step.labelValues ?? null);
    if (!same) {
      out.push(step);
      continue;
    }
    if (STATUS_RANK[step.status] > STATUS_RANK[prev.status]) {
      out[out.length - 1] = { ...prev, status: step.status, consequenceKey: step.consequenceKey };
    }
  }
  return out;
}

/** Does the bubble text already carry this question? Compared loosely: case,
 *  spacing and the closing punctuation do not matter. */
export function bubbleCarries(content: string, question: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').replace(/[?.!\s]+$/, '').trim();
  const q = norm(question);
  if (q.length > 0 && norm(content).includes(q)) return true;
  // THE SAME QUESTION IN OTHER WORDS (ux2 batch 25, D5): "Which Newcastle did
  // you mean?" in the bubble over "Which Newcastle is home?" on the card read
  // as asking twice. A bubble that ENDS on a question is asking this one.
  return /\?\s*$/.test(content.trim());
}

/**
 * Should this settled box survive in the thread?
 *
 * A turn that CHANGED DATA keeps its line; a pure-read turn does not. Facts are
 * extracted on nearly every turn, so keeping every settled box would put a line
 * under most bubbles in the thread. A failure is always kept: a failure the
 * user never learns about is the case this surface exists to prevent.
 *
 * A TERMINAL is kept for exactly that reason, and it has to be its own clause.
 * The terminal sentence is carried BY this box, so dropping the box drops the
 * only thing on screen that says the turn ended badly. Measured on device: a
 * residence turn spent its legs on place lookups that all missed, ended
 * `leg-cap` with no proposal and an empty reply, and every tool call had
 * succeeded on its own terms, so `changedData` was false, `failedCount` was
 * zero, the box was dropped and the user was left looking at their own message
 * with no response of any kind. Silence is the one outcome this whole surface
 * exists to prevent.
 */
export function keepBox(box: AgentStepsItem): boolean {
  if (!box.collapsed) return true;
  // The LATEST finished turn keeps its fold, "Done in N steps", which opens
  // again on a tap (owner, navx2: FinalMeraChat #9 for the latest turn only).
  // Once the next message is sent it is no longer the latest and the M2 rule
  // applies: NOT `changedData` (ux2 M2), because an ordinary settled turn
  // left a "Done" row after every message. Only a failed step or a terminal
  // sentence keeps an older box.
  return box.latest || box.failedCount > 0 || box.terminal !== null;
}
