// track-card-actions: the side-effect half of the follow card. Every write to a
// proposeTrack call's result goes through `patchTrackCard`, the same contract
// as fact-choice-actions: READ the store override (or the staged result on the
// first write), MERGE, WRITE, all synchronously so two writes in a row never
// lose each other, then patch the persisted row fire-and-forget (a row not
// written yet picks the override up at write time, see lib/chat-session).

import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';
import { patchMessageToolCallResult } from '@/lib/database/services/conversation-service';
import { syncFollowedStoryNow } from '@/lib/tracking/track-actions';
import type { ProposalAction, StagedProposal } from '@/lib/llm/types';
import logger from '@/lib/logger';
import { requestMoreOptions } from '@/lib/chat-session/chat-session';
import { useFloatingChatStore, type TrackMoreState } from '@/lib/stores/floating-chat-store';
import {
  mergeTrackOptions,
  normaliseTrackText,
  readTrackOutcomes,
  trackCardStatus,
  type TrackCardStatus,
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
  const toOption = (a: TrackAction): TrackOption => ({
    label: a.label,
    search: a.searchText,
    ...(a.mustMatch ? { mustMatch: a.mustMatch } : {}),
  });
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
      ...(o.mustMatch ? { mustMatch: o.mustMatch } : {}),
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

/**
 * Follow: the ticked rows in card order, one executor call each, so every row
 * gets its own outcome, written as soon as that row settles (a crash mid-batch
 * keeps the rows already done). One feed sync after the batch, not one per
 * follow. A card left resolved settles the store's waiting proposal.
 */
export async function followTickedOptions(
  source: Source & Pick<TrackCardSource, 'dismissed' | 'superseded'>,
  proposal: StagedProposal,
  tickedLabels: readonly string[],
): Promise<{ outcomes: Record<string, TrackOutcome>; status: TrackCardStatus }> {
  const ticked = new Set(tickedLabels.map(normaliseTrackText));
  let followedNew = false;
  for (const action of trackActions(proposal.actions)) {
    if (!ticked.has(normaliseTrackText(action.label))) continue;
    let outcome: TrackOutcome = 'failed';
    try {
      const r = await executeProposalActions([action], { confirmedByUser: true, syncFeed: false });
      if (r.applied > 0 && r.errors.length === 0) outcome = r.alreadyFollowed > 0 ? 'already' : 'following';
    } catch {
      // The executor never throws; a failed row is still the honest answer.
    }
    if (outcome === 'following') followedNew = true;
    recordTrackOutcome(source, action.label, outcome);
  }
  if (followedNew) void syncFollowedStoryNow();

  const store = useFloatingChatStore.getState();
  const current = store.toolCallResults[source.resultKey] ?? source.baseResult;
  const outcomes = readTrackOutcomes(current.followed);
  const status = trackCardStatus({ outcomes, dismissed: source.dismissed, superseded: source.superseded });
  if (status === 'followed' && store.proposal?.id === proposal.id) store.resolveProposal('applied');
  return { outcomes, status };
}

/**
 * More options: one engine call built from the card, merged into it. The
 * request state lives in the store (`trackMore`), so a card that unmounts
 * mid-request comes back showing it. A second tap while one runs does nothing.
 * Stopped clears the state (no message); busy or failed reads as failed.
 */
export async function loadMoreTrackOptions(
  source: Source,
  proposal: StagedProposal,
): Promise<{ added: number; state: TrackMoreState | null }> {
  if (useFloatingChatStore.getState().trackMore[proposal.id] === 'loading') return { added: 0, state: 'loading' };
  useFloatingChatStore.getState().setTrackMore(proposal.id, 'loading');
  const res = await requestMoreOptions(proposal.id, proposal.actions);
  const added = res.actions.length > 0 ? growTrackCard(source, proposal, res.actions) : 0;
  const state: TrackMoreState | null =
    added > 0 || res.reason === 'stopped'
      ? null
      : res.reason === 'failed' || res.reason === 'busy'
        ? 'failed'
        : 'none';
  useFloatingChatStore.getState().setTrackMore(proposal.id, state);
  return { added, state };
}

/** Not now: persisted, and the store's waiting proposal (if this card) is cancelled. */
export function dismissTrackCard(source: Source, proposalId: string): void {
  patchTrackCard(source, () => ({ dismissed: true }));
  const store = useFloatingChatStore.getState();
  if (store.proposal?.id === proposalId) store.resolveProposal('cancelled');
}
