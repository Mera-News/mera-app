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
import type { ChatPhaseId } from '@/lib/services/chat-phase';

/**
 * THREE STATES, NOT A NULLABLE PHASE.
 *
 * `idle` and `released` are both "no phase", and rendering them the same way
 * is a visible bug in opposite directions:
 *
 *  - `released` means a turn published phases and then handed over, because
 *    real text arrived or the turn died. The line must render NOTHING. A
 *    fallback here flashes the opening sentence for a frame at the exact
 *    handover moment, which is a backwards walk and the flicker class this
 *    feature exists to remove.
 *  - `idle` means nothing has been published for this turn yet. The line must
 *    render the OPENING POOL, so a caller that forgets to publish degrades to
 *    a sentence rather than to an empty assistant bubble.
 */
export type ChatPhaseView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'phase'; readonly id: ChatPhaseId }
  | { readonly kind: 'released' };

const IDLE: ChatPhaseView = { kind: 'idle' };
const RELEASED: ChatPhaseView = { kind: 'released' };

interface ChatPhaseState {
  view: ChatPhaseView;
  /** Advance to a phase. */
  setPhase: (id: ChatPhaseId) => void;
  /** Real text arrived, or the turn ended or failed. Render nothing. */
  release: () => void;
  /** A turn is opening. Back to the opening pool. */
  reset: () => void;
}

export const useChatPhaseStore = create<ChatPhaseState>((set) => ({
  view: IDLE,

  // Identity-stable no-ops throughout, copied from `setThinking`'s guard: the
  // sink already suppresses repeats, but a second writer must not be able to
  // re-render the line and restart its dwell.
  setPhase: (id) =>
    set((s) => (s.view.kind === 'phase' && s.view.id === id ? s : { view: { kind: 'phase', id } })),

  release: () => set((s) => (s.view.kind === 'released' ? s : { view: RELEASED })),

  reset: () => set((s) => (s.view.kind === 'idle' ? s : { view: IDLE })),
}));

/** Bind the store to a `makePhaseSink` apply callback. */
export function applyChatPhase(phase: ChatPhaseId | null): void {
  const s = useChatPhaseStore.getState();
  if (phase === null) s.release();
  else s.setPhase(phase);
}
