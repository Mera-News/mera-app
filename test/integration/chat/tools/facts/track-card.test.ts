// chatfix P2: the follow card's override. Grown options and per-row outcomes
// persist through setToolCallResult + patchMessageToolCallResult, a resumed
// thread redraws them, and a grown card is never applied by a typed yes.
// Real stores and the in-memory database; the store starts EMPTY, as at runtime.
import {
  appendMessage,
  createConversation,
  fetchMessagesForConversation,
} from '@/lib/database/services/conversation-service';
import { decideProposeTrack } from '@/lib/news-harness/article-feedback/agent-core';
import { makeFollowStorySubject } from '@/lib/news-harness/follow-story';
import { proposalRequiresUserChoice } from '@/lib/news-harness/core/proposals';
import { pendingProposalView } from '@/lib/chat-session/cloud-engine-helpers';
import type { ProposalAction, StagedProposal } from '@/lib/llm/types';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import * as chatSession from '@/lib/chat-session/chat-session';
import * as trackActions from '@/lib/tracking/track-actions';
import { observeActive } from '@/lib/database/services/tracked-story-service';
import { firstValueFrom } from 'rxjs';

const getActive = () => firstValueFrom(observeActive());
import {
  dismissTrackCard,
  followTickedOptions,
  growTrackCard,
  loadMoreTrackOptions,
  recordTrackOutcome,
} from '@/components/custom/floating-chat/track-card-actions';
import { deriveThreadItems } from '@/components/custom/floating-chat/deriveThreadItems';
import type { ChatThreadItem } from '@/components/custom/floating-chat/types';
import '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { pollUntil } from './kit';

const MSG = 'asst-track';
const subject = makeFollowStorySubject();
const action = (label: string): Extract<ProposalAction, { type: 'track_story' }> => ({ type: 'track_story', label, searchText: label.toLowerCase(), subject });

/** Stages a proposeTrack exactly as the agent does, shows it, and persists the assistant row. */
async function stage(labels: string[], names: Record<string, string[]> = {}) {
  const staged = decideProposeTrack(
    { options: labels.map((l) => ({ label: l, search: l.toLowerCase(), mustMatch: names[l] })) },
    subject,
  );
  const proposal = staged.sideEffects!.proposal!;
  useFloatingChatStore.getState().setProposal(proposal);
  const tc = { id: 'tc-0', name: 'proposeTrack', status: 'done' as const, input: {}, result: staged.result };
  const conversationId = await createConversation('CONFIG');
  await appendMessage(conversationId, { role: 'assistant', content: 'Pick below.', toolCalls: [tc] }, MSG);
  return { proposal, tc, conversationId, source: { resultKey: `${MSG}::0`, baseResult: staged.result } };
}

function card(items: ChatThreadItem[]) {
  return items.find((i): i is Extract<ChatThreadItem, { kind: 'proposal-card' }> => i.kind === 'proposal-card')!;
}

/** The thread as a resumed chat draws it: persisted rows only, no store. */
async function resumed(conversationId: string) {
  return card(
    deriveThreadItems({
      live: [],
      history: await fetchMessagesForConversation(conversationId),
      introMessage: null,
      isStreaming: false,
      earlierConversationLabel: 'Earlier',
    }),
  );
}

const labels = (p: StagedProposal) => p.actions.map((a) => (a as { label: string }).label);

beforeEach(() => resetChatModules());
afterEach(() => jest.restoreAllMocks());

describe('growing the card', () => {
  it('keeps every option\'s mustMatch names, in the store and on resume', async () => {
    const { proposal, conversationId, source } = await stage(['Artemis II launch', 'Space news'], {
      'Artemis II launch': ['Artemis II'],
    });

    const names0 = (await resumed(conversationId)).proposal.actions.map((a) => (a as { mustMatch?: string[] }).mustMatch);
    expect(names0).toEqual([['Artemis II'], undefined]);

    growTrackCard(source, proposal, [{ ...action('Moon race'), mustMatch: ['Moon race'] }]);

    const names = (p: StagedProposal) => p.actions.map((a) => (a as { mustMatch?: string[] }).mustMatch);
    expect(names(useFloatingChatStore.getState().proposal!)).toEqual([['Artemis II'], undefined, ['Moon race']]);
    const c = await pollUntil(() => resumed(conversationId), (r) => r.proposal.actions.length === 3, 2000);
    expect(names(c.proposal)).toEqual([['Artemis II'], undefined, ['Moon race']]);
  });

  it('the first grow on an empty store keeps the staged options and persists the whole list', async () => {
    const { proposal, conversationId, source } = await stage(['Artemis II launch', 'NASA Artemis program']);

    const added = growTrackCard(source, proposal, [action('Moon race'), action('artemis ii LAUNCH')]);

    expect(added).toBe(1);
    const c = await pollUntil(() => resumed(conversationId), (r) => r.proposal.actions.length === 3, 2000);
    expect(labels(c.proposal)).toEqual(['Artemis II launch', 'NASA Artemis program', 'Moon race']);
  });

  it('grows the waiting proposal too, keeping its id, so a one-option card turns tap-only', async () => {
    const { proposal, source } = await stage(['Artemis II launch']);
    expect(proposalRequiresUserChoice(useFloatingChatStore.getState().proposal!)).toBe(false);
    expect(pendingProposalView()?.appliable).toBe(true);

    growTrackCard(source, proposal, [action('Moon race')]);

    const grown = useFloatingChatStore.getState().proposal!;
    expect(grown.id).toBe(proposal.id);
    expect(labels(grown)).toEqual(['Artemis II launch', 'Moon race']);
    expect(proposalRequiresUserChoice(grown)).toBe(true);
    expect(pendingProposalView()?.appliable).toBe(false);
  });

  it('a resumed grown card has nothing a typed yes could apply', async () => {
    const { proposal, conversationId, source } = await stage(['Artemis II launch']);
    growTrackCard(source, proposal, [action('Moon race')]);
    const c = await pollUntil(() => resumed(conversationId), (r) => r.proposal.actions.length === 2, 2000);

    resetChatModules();

    expect(pendingProposalView()).toBeNull();
    expect(c.proposal.chooseOne).toBe(true);
  });

  it('adds and writes nothing when every option is already on the card', async () => {
    const { proposal, source } = await stage(['Artemis II launch']);
    expect(growTrackCard(source, proposal, [action('Artemis II Launch')])).toBe(0);
    expect(useFloatingChatStore.getState().toolCallResults[source.resultKey]).toBeUndefined();
  });

  it('leaves the store alone when another proposal has replaced this card', async () => {
    const { proposal, source } = await stage(['Artemis II launch']);
    const other: StagedProposal = { id: 'other', explanation: '', expectedEffects: '', actions: [action('X')] };
    useFloatingChatStore.getState().setProposal(other);

    growTrackCard(source, proposal, [action('Moon race')]);

    expect(useFloatingChatStore.getState().proposal).toBe(other);
  });
});

describe('outcomes and Not now', () => {
  it('two outcomes in a row both survive, in memory and on the resumed card', async () => {
    const { conversationId, source } = await stage(['Artemis II launch', 'Moon race']);

    recordTrackOutcome(source, 'Artemis II launch', 'following');
    recordTrackOutcome(source, 'Moon race', 'failed');

    const expected = { 'artemis ii launch': 'following', 'moon race': 'failed' };
    expect(useFloatingChatStore.getState().toolCallResults[source.resultKey].followed).toEqual(expected);
    const c = await pollUntil(() => resumed(conversationId), (r) => Object.keys(r.track?.outcomes ?? {}).length === 2, 2000);
    expect(c.track?.outcomes).toEqual(expected);
  });

  it('an outcome after a grow keeps the grown list', async () => {
    const { proposal, conversationId, source } = await stage(['Artemis II launch']);
    growTrackCard(source, proposal, [action('Moon race')]);
    recordTrackOutcome(source, 'Moon race', 'following');

    const c = await pollUntil(() => resumed(conversationId), (r) => r.track?.outcomes['moon race'] !== undefined, 2000);
    expect(labels(c.proposal)).toEqual(['Artemis II launch', 'Moon race']);
    expect(c.track?.outcomes).toEqual({ 'moon race': 'following' });
  });

  it('Not now persists and cancels the waiting proposal', async () => {
    const { proposal, conversationId, source } = await stage(['Artemis II launch']);

    dismissTrackCard(source, proposal.id);

    expect(useFloatingChatStore.getState().proposal).toBeNull();
    expect(useFloatingChatStore.getState().resolvedProposals[proposal.id]).toBe('cancelled');
    const c = await pollUntil(() => resumed(conversationId), (r) => r.track?.dismissed === true, 2000);
    expect(c.track?.dismissed).toBe(true);
  });
});

describe('More options', () => {
  type Answer = Awaited<ReturnType<typeof chatSession.requestMoreOptions>>;
  const answer = (a: Answer) => jest.spyOn(chatSession, 'requestMoreOptions').mockResolvedValue(a);
  const more = () => useFloatingChatStore.getState().trackMore;

  it('asks from the card alone, grows it and clears the request', async () => {
    const { proposal, source } = await stage(['Artemis II launch']);
    const spy = answer({ actions: [action('Moon race')] });

    const res = await loadMoreTrackOptions(source, proposal);

    expect(spy).toHaveBeenCalledWith(proposal.id, proposal.actions);
    expect(res).toEqual({ added: 1, state: null });
    expect(labels(useFloatingChatStore.getState().proposal!)).toEqual(['Artemis II launch', 'Moon race']);
    expect(more()[proposal.id]).toBeUndefined();
  });

  it('shows loading while the engine works, and a second tap sends nothing', async () => {
    const { proposal, source } = await stage(['Artemis II launch']);
    let release!: (a: Answer) => void;
    const spy = jest.spyOn(chatSession, 'requestMoreOptions').mockReturnValue(new Promise<Answer>((r) => (release = r)));

    const first = loadMoreTrackOptions(source, proposal);
    expect(more()[proposal.id]).toBe('loading');
    expect(await loadMoreTrackOptions(source, proposal)).toEqual({ added: 0, state: 'loading' });
    expect(spy).toHaveBeenCalledTimes(1);

    release({ actions: [], reason: 'stopped' });
    expect(await first).toEqual({ added: 0, state: null });
    expect(more()[proposal.id]).toBeUndefined();
  });

  it.each([
    ['an empty answer', { actions: [], reason: 'none' as const }, 'none'],
    ['only repeats of shown options', { actions: [action('artemis ii launch')] }, 'none'],
    ['a failed call', { actions: [], reason: 'failed' as const }, 'failed'],
    ['a busy engine', { actions: [], reason: 'busy' as const }, 'failed'],
  ])('%s leaves the card as it was and says so', async (_what, a, state) => {
    const { proposal, source } = await stage(['Artemis II launch']);
    answer(a);

    expect(await loadMoreTrackOptions(source, proposal)).toEqual({ added: 0, state });
    expect(more()[proposal.id]).toBe(state);
    expect(useFloatingChatStore.getState().proposal).toBe(proposal);
  });
});

describe('Follow', () => {
  const sync = () => jest.spyOn(trackActions, 'syncFollowedStoryNow').mockResolvedValue();
  const card = (source: { resultKey: string; baseResult: Record<string, unknown> }) => ({ ...source, dismissed: false, superseded: false });

  it('follows each ticked row under its own label and search, records each, syncs the feed once', async () => {
    const { proposal, source } = await stage(['Artemis II launch', 'NASA Artemis program', 'Moon race']);
    const synced = sync();

    const res = await followTickedOptions(card(source), proposal, ['Artemis II launch', 'moon race']);

    expect(res).toEqual({ outcomes: { 'artemis ii launch': 'following', 'moon race': 'following' }, status: 'followed' });
    const rows = await getActive();
    expect(rows.map((r) => [r.llmHeadline, r.topicText]).sort()).toEqual([
      ['Artemis II launch', 'artemis ii launch'],
      ['Moon race', 'moon race'],
    ]);
    expect(synced).toHaveBeenCalledTimes(1);
    expect(useFloatingChatStore.getState().resolvedProposals[proposal.id]).toBe('applied');
  });

  it('a story already followed is a done row, and nothing new means no feed sync', async () => {
    const first = await stage(['Artemis II launch']);
    sync();
    await followTickedOptions(card(first.source), first.proposal, ['Artemis II launch']);
    resetChatModules();
    const again = await stage(['Artemis II launch']);
    const synced = sync();
    synced.mockClear(); // the same spy as the first follow's

    const res = await followTickedOptions(card(again.source), again.proposal, ['Artemis II launch']);

    expect(res).toEqual({ outcomes: { 'artemis ii launch': 'already' }, status: 'followed' });
    expect(synced).not.toHaveBeenCalled();
    expect(await getActive()).toHaveLength(1);
  });

  it('a failed row keeps the card pending and its proposal waiting, while the rows done stay recorded', async () => {
    const { proposal, conversationId, source } = await stage(['Artemis II launch', 'Moon race']);
    sync();
    const real = trackActions.trackStoryWithProposal;
    jest
      .spyOn(trackActions, 'trackStoryWithProposal')
      .mockImplementation((subj, scope, opts) =>
        scope.label === 'Moon race' ? Promise.reject(new Error('db down')) : real(subj, scope, opts),
      );

    const res = await followTickedOptions(card(source), proposal, ['Artemis II launch', 'Moon race']);

    expect(res).toEqual({ outcomes: { 'artemis ii launch': 'following', 'moon race': 'failed' }, status: 'pending' });
    expect(useFloatingChatStore.getState().proposal?.id).toBe(proposal.id);
    const c = await pollUntil(() => resumed(conversationId), (r) => Object.keys(r.track?.outcomes ?? {}).length === 2, 2000);
    expect(c.track?.outcomes).toEqual(res.outcomes);
  });

  it('follows nothing when nothing is ticked', async () => {
    const { proposal, source } = await stage(['Artemis II launch']);
    const res = await followTickedOptions(card(source), proposal, []);
    expect(res).toEqual({ outcomes: {}, status: 'pending' });
    expect(await getActive()).toHaveLength(0);
  });
});
