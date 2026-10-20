// chat-phase-store — what the chat wait line is currently narrating.
//
// ── Why this is not a field on cloud-chat-store ─────────────────────────────
//
// `useLocalLLM` never writes `cloud-chat-store` at all. That is exactly why
// the `thinking` boolean this store replaces was dead on the on-device path:
// a field in a cloud-named store has nowhere to put half of a two-engine
// feature. This one is engine-agnostic and both engines write it.
//
// Living outside `lib/stores/` is deliberate and has precedent
// (`lib/scheduler/scheduler-store.ts`): it belongs to `lib/llm`, which is the
// only thing that publishes to it.
//
// No persist middleware. A phase dies with its turn, and a phase restored
// from disk at launch would describe work that is long over.

import { create } from 'zustand';
import {
  isModelCallPhase,
  type ChatPhaseId,
  type ChatPhaseView,
  type StepKind,
} from '@/lib/services/chat-phase';

// THREE STATES, NOT A NULLABLE PHASE (the type lives in chat-phase.ts).
//
// `idle` and `released` are both "no phase", and rendering them the same way
// is a visible bug in opposite directions:
//
//  - `released` means a turn published phases and then handed over, because
//    real text arrived or the turn died. The line must render NOTHING. A
//    fallback here flashes the opening sentence for a frame at the exact
//    handover moment, which is a backwards walk and the flicker class this
//    feature exists to remove.
//  - `idle` means nothing has been published for this turn yet. The line must
//    render the OPENING POOL, so a caller that forgets to publish degrades to
//    a sentence rather than to an empty assistant bubble.
export type { ChatPhaseView };

/** The tool the phone is running right now, between two model calls. Memory
 *  only: `args` can hold fact text, so it is never logged or persisted. */
export interface LiveTool {
  readonly kind: StepKind;
  /** The CONTRACT name (`lookup_place`), which the step labels key on. */
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

const IDLE: ChatPhaseView = { kind: 'idle' };
const RELEASED: ChatPhaseView = { kind: 'released' };

interface ChatPhaseState {
  view: ChatPhaseView;
  /** The phone is doing work that is not a model call (a tool, a search). */
  deviceWork: boolean;
  liveTool: LiveTool | null;
  /** A `retrying` phase was shown this turn. Survives the release; only the
   *  next turn's `reset()` clears it. */
  retriedThisTurn: boolean;
  /** Bumped by every `attesting` / `securing`. MONOTONIC, never reset: a
   *  buffered leg can publish `securing` and `thinking` in one tick, so the
   *  view alone would skip the letter; a viewer plays it once per new value. */
  sealedSeq: number;
  /** Advance to a phase. */
  setPhase: (id: ChatPhaseId) => void;
  /** Real text arrived, or the turn ended or failed. Render nothing. */
  release: () => void;
  /** A turn is opening. Back to the opening pool, every per-turn field cleared. */
  reset: () => void;
  setDeviceWork: (on: boolean) => void;
  toolStarted: (tool: LiveTool) => void;
  toolEnded: () => void;
}

export const useChatPhaseStore = create<ChatPhaseState>((set) => ({
  view: IDLE,
  deviceWork: false,
  liveTool: null,
  retriedThisTurn: false,
  sealedSeq: 0,

  // Identity-stable no-ops throughout: the sink already suppresses repeats,
  // but a second writer must not be able to re-render the line and restart
  // its dwell.
  setPhase: (id) =>
    set((s) => {
      if (s.view.kind === 'phase' && s.view.id === id) return s;
      const sealing = id === 'attesting' || id === 'securing';
      // Only a MODEL CALL ends a live tool. `webSearch` is published by the
      // search itself, after its tool started.
      const modelCall = isModelCallPhase(id);
      return {
        view: { kind: 'phase', id },
        ...(id === 'retrying' ? { retriedThisTurn: true } : {}),
        ...(sealing ? { sealedSeq: s.sealedSeq + 1 } : {}),
        ...(modelCall ? { liveTool: null, deviceWork: false } : {}),
      };
    }),

  // Clears the tool fields even when the view is already released: a tool
  // that started after the release (single-shot) must not outlive the turn.
  release: () =>
    set((s) =>
      s.view.kind === 'released' && !s.deviceWork && s.liveTool === null
        ? s
        : { view: RELEASED, deviceWork: false, liveTool: null },
    ),

  // EVERY per-turn field, whatever the view. A guard on the view alone let a
  // stale live tool or retry flag survive into the next turn. `sealedSeq` is
  // a counter, not turn state, and is deliberately left alone.
  reset: () =>
    set((s) =>
      s.view.kind === 'idle' && !s.deviceWork && s.liveTool === null && !s.retriedThisTurn
        ? s
        : { view: IDLE, deviceWork: false, liveTool: null, retriedThisTurn: false },
    ),

  setDeviceWork: (on) => set((s) => (s.deviceWork === on ? s : { deviceWork: on })),

  toolStarted: (tool) => set({ liveTool: tool, deviceWork: true }),

  toolEnded: () => set((s) => (s.liveTool === null && !s.deviceWork ? s : { liveTool: null, deviceWork: false })),
}));

/** Bind the store to a `makePhaseSink` apply callback. */
export function applyChatPhase(phase: ChatPhaseId | null): void {
  const s = useChatPhaseStore.getState();
  if (phase === null) s.release();
  else s.setPhase(phase);
}
