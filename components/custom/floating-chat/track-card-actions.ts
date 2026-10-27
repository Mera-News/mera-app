// track-card-actions: the side-effect half of the follow card. Every write to a
// proposeTrack call's result goes through `patchTrackCard`, the same contract
// as fact-choice-actions: READ the store override (or the staged result on the
// first write), MERGE, WRITE, all synchronously so two writes in a row never
// lose each other, then patch the persisted row fire-and-forget (a row not
// written yet picks the override up at write time, see lib/chat-session).

import { patchMessageToolCallResult } from '@/lib/database/services/conversation-service';
import type { ProposalAction, StagedProposal } from '@/lib/llm/types';
import logger from '@/lib/logger';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import {
  mergeTrackOptions,
  normaliseTrackText,
  readTrackOutcomes,
  type TrackOption,
  type TrackOutcome,
} from './track-options';
import type { TrackCardSource } from './types';

type TrackAction = Extract<ProposalAction, { type: 'track_story' }>;
type Source = Pick<TrackCardSource, 'resultKey' | 'baseResult'>;

function trackActions(actions: readonly ProposalAction[]): TrackAction[] {
  return actions.filter((a): a is TrackAction => a.type === 'track_story');
}

/** Merge `patch(current)` into the card's result and persist it. Returns the new result. */
export function patchTrackCard(
  source: Source,
  patch: (current: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const store = useFloatingChatStore.getState();
  const current = store.toolCallResults[source.resultKey] ?? source.baseResult;
  const next = { ...current, ...patch(current) };
  store.setToolCallResult(source.resultKey, next);

  const [messageId, indexRaw] = source.resultKey.split('::');
  const index = Number(indexRaw);
  if (messageId && Number.isInteger(index)) {
    void patchMessageToolCallResult(messageId, index, next).catch((err: unknown) => {
      logger.warn('[track-card] durable patch failed', { resultKey: source.resultKey, error: String(err) });
    });
  }
  return next;
}

/**
 * Appends the new options More options returned. Persists the whole list as
 * `cardOptions` and, while this card is the store's waiting proposal, grows
 * that too, so every typed-yes guard reads the effective option count.
 * Returns how many options were added (0 writes nothing).
 */
export function growTrackCard(source: Source, proposal: StagedProposal, incoming: readonly ProposalAction[]): number {
  const shown = trackActions(proposal.actions);
  const toOption = (a: TrackAction): TrackOption => ({ label: a.label, search: a.searchText });
  const { options, added } = mergeTrackOptions(shown.map(toOption), trackActions(incoming).map(toOption));
  if (added === 0 || shown.length === 0) return 0;

  patchTrackCard(source, () => ({ cardOptions: options }));

  const store = useFloatingChatStore.getState();
  if (store.proposal?.id === proposal.id) {
    // Every option follows the card's own subject, as the resume path rebuilds it.
    const subject = shown[0].subject;
    const actions: ProposalAction[] = options.map((o) => ({
      type: 'track_story',
      label: o.label,
      searchText: o.search,
      subject,
    }));
    store.setProposal({ ...store.proposal, actions, chooseOne: actions.length >= 2 || undefined });
  }
  return added;
}

/** Records one row's outcome; called after EACH follow so a crash mid-batch keeps the rows done. */
export function recordTrackOutcome(source: Source, label: string, outcome: TrackOutcome): void {
  patchTrackCard(source, (current) => ({
    followed: { ...readTrackOutcomes(current.followed), [normaliseTrackText(label)]: outcome },
  }));
}

/** Not now: persisted, and the store's waiting proposal (if this card) is cancelled. */
export function dismissTrackCard(source: Source, proposalId: string): void {
  patchTrackCard(source, () => ({ dismissed: true }));
  const store = useFloatingChatStore.getState();
  if (store.proposal?.id === proposalId) store.resolveProposal('cancelled');
}
