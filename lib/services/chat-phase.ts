/**
 * Which phase of a chat turn the wait line is narrating, as a pure function.
 *
 * ── Why this lives in lib/services and not beside the component ─────────────
 *
 * Same reason as `processing-stage.ts`, which this file is deliberately shaped
 * after: it is the decision table two engines and one component would
 * otherwise each answer slightly differently, and it belongs under the
 * coverage gate honestly rather than being parked in `components/` to dodge
 * it.
 *
 * No React, no store, and NO CLOCK. The minimum on-screen dwell is a property
 * of the surface, not of the phase, so it lives in `ChatPhaseLine` where the
 * timer that implements it lives. Everything here is a total function of its
 * arguments, which is what makes the table testable row by row.
 *
 * ── The two traps ───────────────────────────────────────────────────────────
 *
 * 1. **A TURN IS A LOOP, NOT A WALK.** The feed's processing run goes one way,
 *    so one high-water mark per run is right there. An agent turn runs up to
 *    `MAX_AGENT_LEGS` sequential model calls and each one genuinely re-encrypts
 *    and re-sends, so a mark held across the whole turn would swallow every
 *    phase of legs 1..n. The mark is therefore bounded by ONE MODEL CALL:
 *    `cloudChatStream` opens with `'reset'`, which clears the mark and
 *    deliberately does NOT clear the display, so there is no blank frame
 *    between legs.
 *
 * 2. **`'reset'`, `null` AND "nothing yet" ARE THREE DIFFERENT THINGS**, and
 *    collapsing any two of them is a visible bug. `'reset'` clears the mark and
 *    leaves the line alone; `null` releases the line because real text has
 *    arrived or the turn died; "nothing published yet" is the store's `idle`,
 *    which renders the opening pool so a caller that forgets to publish
 *    degrades to a sentence rather than to an empty bubble. See
 *    `ChatPhaseView` in `lib/llm/chat-phase-store.ts`.
 */

/**
 * The cloud phases, in the order they can legally advance.
 *
 * `retrying` is ranked LAST on purpose. The 10s hedge, the model fallback and
 * both stream retries all re-enter the request builder, which would otherwise
 * report `securing` again and walk the reader back to "encrypting" at the exact
 * moment they have been waiting longest.
 *
 * IT OUTRANKS `thinking`, AND THAT IS THE DELIBERATE PART. On a hedged turn the
 * order of events is: build, POST, ...10s of silence..., hedge fires and
 * rebuilds (`retrying`), a leg finally answers (`thinking`). Because `thinking`
 * is rank 4 it is refused, so a hedged turn stays on "Still going. Thanks for
 * waiting." rather than stepping back to "Mera is reading what you said."
 *
 * Both sentences are true at that point, so this is a choice rather than a
 * constraint, and it goes this way because the reader has already been told
 * the turn is slow. Walking back to the ordinary line would read as the app
 * forgetting what it just said. Verified rather than assumed: `sendHedged`
 * builds the hedge leg inside its phase 2, after the timer, so an ordinary
 * turn never reaches `retrying` at all.
 */
export const CLOUD_PHASE_ORDER = [
  'preparing',
  'queued',
  'securing',
  'attesting',
  'thinking',
  'retrying',
  // The persona agent's web search (ux2 D10). Published by the device port
  // BETWEEN model calls, after the leg that asked for it, so it ranks above
  // everything that leg could have shown; the next call's 'reset' clears it.
  'webSearch',
] as const;

/**
 * The on-device phases. Disjoint from the cloud set by construction, so a
 * cloud caption physically cannot render on a device turn and the two orders
 * are never compared against each other.
 */
export const DEVICE_PHASE_ORDER = ['deviceLoading', 'devicePreparing', 'deviceThinking'] as const;

export type CloudPhaseId = (typeof CLOUD_PHASE_ORDER)[number];
export type DevicePhaseId = (typeof DEVICE_PHASE_ORDER)[number];
export type ChatPhaseId = CloudPhaseId | DevicePhaseId;

export const CHAT_PHASE_IDS = [...CLOUD_PHASE_ORDER, ...DEVICE_PHASE_ORDER] as const;

/**
 * What an engine may publish.
 *
 * `'reset'` bounds one model call. `null` releases the line. Anything else is
 * a phase to advance to, subject to the mark.
 */
export type PhaseSignal = ChatPhaseId | 'reset' | null;

function orderFor(id: ChatPhaseId): readonly ChatPhaseId[] | null {
  if ((CLOUD_PHASE_ORDER as readonly string[]).includes(id)) return CLOUD_PHASE_ORDER;
  if ((DEVICE_PHASE_ORDER as readonly string[]).includes(id)) return DEVICE_PHASE_ORDER;
  return null;
}

/** Rank within this id's own engine, or -1 for an id in neither order. */
export function chatPhaseIndex(id: ChatPhaseId): number {
  const order = orderFor(id);
  return order ? order.indexOf(id) : -1;
}

export interface ResolveChatPhaseInput {
  /** The phase an engine just published. Never `'reset'` and never `null`;
   *  both of those are decided by the sink, which does not consult this. */
  readonly signal: ChatPhaseId;
  /** What is on screen, or null at the start of a model call. */
  readonly previousPhase: ChatPhaseId | null;
}

/**
 * Resolve one published phase against the mark, monotonically.
 *
 * Once rank N has been shown, a lower rank from the same engine is refused:
 * a signal that arrives late, or a builder re-entered by a retry, must never
 * walk the reader backwards. A cross-engine signal is refused outright rather
 * than compared, because the two orders share no scale.
 *
 * The mark is released by the caller passing `previousPhase: null`, which is
 * what `'reset'` does between legs.
 */
export function resolveChatPhase({ signal, previousPhase }: ResolveChatPhaseInput): ChatPhaseId {
  if (previousPhase === null) return signal;
  if (orderFor(signal) !== orderFor(previousPhase)) return previousPhase;
  return chatPhaseIndex(signal) > chatPhaseIndex(previousPhase) ? signal : previousPhase;
}

/** `null` means release the line. */
export type PhaseApply = (phase: ChatPhaseId | null) => void;

export type PhaseSink = (signal: PhaseSignal) => void;

/**
 * One sink per turn, holding the mark in its closure.
 *
 * `apply` is called only when the displayed phase actually changes, so a
 * refused backwards signal, a repeat, and a `'reset'` are all free: nothing
 * re-renders and no dwell timer is disturbed. That property is what lets
 * `cloudChatStream` re-emit `'thinking'` on the `reasoning` event without
 * caring whether the post-headers route already emitted it, which in turn is
 * what makes a retry's second `reasoning` event harmless.
 */
export function makePhaseSink(apply: PhaseApply): PhaseSink {
  // TWO pieces of state, and collapsing them into one is a bug that survives
  // every happy-path test. `mark` bounds ONE MODEL CALL and is cleared by
  // `'reset'`. `displayed` is what is actually on screen and is cleared only by
  // a release. With one variable, a turn that resets for leg 1 and then throws
  // finds the mark already null, returns early, and leaves the line cycling
  // "Mera is reading what you said" underneath the error banner forever.
  let mark: ChatPhaseId | null = null;
  let displayed: ChatPhaseId | null = null;
  return (signal) => {
    if (signal === 'reset') {
      // Bounds the next model call. The LINE IS LEFT ALONE on purpose: clearing
      // it here is a blank frame between every pair of legs.
      mark = null;
      return;
    }
    if (signal === null) {
      mark = null;
      if (displayed === null) return;
      displayed = null;
      apply(null);
      return;
    }
    const next = resolveChatPhase({ signal, previousPhase: mark });
    if (next === mark) return;
    mark = next;
    if (next === displayed) return;
    displayed = next;
    apply(next);
  };
}
