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
 *    `ChatPhaseView` below and the store in `lib/llm/chat-phase-store.ts`.
 */

/**
 * The cloud phases, in the order they can legally advance.
 *
 * `retrying` outranks every phase a model call publishes, on purpose. The 10s hedge, the model fallback and
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
  // A cold call fetches the model's key FIRST and seals the message with it
  // after, so `securing` must be able to follow `attesting`.
  'attesting',
  'securing',
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

/**
 * What the wait line is narrating. THREE STATES, NOT A NULLABLE PHASE: see
 * `lib/llm/chat-phase-store.ts`, which owns the store and re-exports this.
 */
export type ChatPhaseView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'phase'; readonly id: ChatPhaseId }
  | { readonly kind: 'released' };

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

/** The phases a model call publishes from inside `cloudChatStream`. Only these
 *  mean the phone has handed work to the model, so only these end a live tool. */
const MODEL_CALL_PHASES: ReadonlySet<ChatPhaseId> = new Set<ChatPhaseId>([
  'queued',
  'attesting',
  'securing',
  'thinking',
  'retrying',
]);

export function isModelCallPhase(id: ChatPhaseId): boolean {
  return MODEL_CALL_PHASES.has(id);
}

/**
 * What the encryption strip draws. The handover's `return` is NOT here: the UI
 * plays it on the first visible token, which is not a phase.
 */
export type StripState =
  | 'phone'
  | 'attest'
  | 'secure'
  | 'think'
  | 'retry'
  | 'devicePreparing'
  | 'deviceLoading'
  | 'deviceThinking';

const CLOUD_STRIP: Partial<Record<ChatPhaseId, StripState>> = {
  attesting: 'attest',
  securing: 'secure',
  thinking: 'think',
  retrying: 'retry',
};

/**
 * The strip state, from the phase and nothing else. NEVER READS A ROW LABEL:
 * a sealed letter is drawn only for a phase `cloudChatStream` published, so
 * nothing sealed crosses the line while the phone does plain work (a place
 * lookup, a web search) that is not end-to-end encrypted.
 *
 * Precedence on cloud: work on the phone beats EVERY phase, `retrying`
 * included. The view stays on `retrying` until the next call publishes, so a
 * tool after a retried call would otherwise draw sealed traffic over plain
 * GraphQL or web work; the retry words ride in the trailing row instead.
 * `preparing`, `queued` and `webSearch` are phone work too. On device nothing is sealed or sent, so `deviceWork` changes nothing.
 */
export function stripStateFor(
  view: ChatPhaseView,
  deviceWork: boolean,
  engine: 'cloud' | 'local',
): StripState | null {
  if (engine === 'local') {
    if (view.kind === 'released') return null;
    if (view.kind === 'phase' && (DEVICE_PHASE_ORDER as readonly string[]).includes(view.id)) {
      return view.id as DevicePhaseId;
    }
    return 'devicePreparing';
  }
  if (deviceWork) return 'phone';
  if (view.kind === 'released') return null;
  if (view.kind === 'idle') return 'phone';
  return CLOUD_STRIP[view.id] ?? 'phone';
}

/** The step kinds shared by the strip, the step rows and the glyph registry. */
export type StepKind = 'think' | 'skill' | 'facts' | 'place' | 'write' | 'remove' | 'ask' | 'web' | 'working';

/** Keyed by the CONTRACT tool name the model calls, never by a label and never
 *  by the port's method name (`lookupPlace` is not `lookup_place`). */
const STEP_KIND_BY_TOOL: Readonly<Record<string, StepKind>> = {
  find_similar_facts: 'facts',
  lookup_place: 'place',
  saveExtractedFacts: 'write',
  deleteUserFacts: 'remove',
  ask_choice: 'ask',
  webSearch: 'web',
  load_skill: 'skill',
};

/** `explainMera` and any unknown name are generic work. */
export function stepKindForTool(toolName: string): StepKind {
  return Object.prototype.hasOwnProperty.call(STEP_KIND_BY_TOOL, toolName) ? STEP_KIND_BY_TOOL[toolName] : 'working';
}
