// "Add to my profile instead" on a follow card: the tap asks, costs no model call
// and saves nothing; Add it anyway commits as written. Real stores and the
// in-memory database; the store starts EMPTY, as at runtime.
import { appendMessage, createConversation, fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { decideProposeTrack } from '@/lib/news-harness/article-feedback/agent-core';
import { makeFollowStorySubject } from '@/lib/news-harness/follow-story';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import * as chatSession from '@/lib/chat-session/chat-session';
import {
  addProfileOffer,
  askProfileImpact,
  followTickedOptions,
  growTrackCard,
} from '@/components/custom/floating-chat/track-card-actions';
import { deriveThreadItems } from '@/components/custom/floating-chat/deriveThreadItems';
import { trackCardStatus } from '@/components/custom/floating-chat/track-options';
import type { ChatThreadItem } from '@/components/custom/floating-chat/types';
import '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { queuedJobs } from './kit';

const MSG = 'asst-track-profile';
const QUESTION = 'Before I add it, how does this affect you?';
const subject = makeFollowStorySubject();
const OFFER = [{ statement: 'Follows Rally Finland', questionnaire_attribute: 'topics: general interests', topic_skill_id: 'topics/interest' }];

async function stage(labels = ['Rally Finland', 'World Rally Championship'], offer: unknown = OFFER) {
  const staged = decideProposeTrack({ options: labels.map((l) => ({ label: l, search: l })) }, subject);
  const proposal = staged.sideEffects!.proposal!;
  useFloatingChatStore.getState().setProposal(proposal);
  const baseResult = { ...staged.result, storySubjects: [labels[0]], profileOffer: offer };
  const tc = { id: 'tc-0', name: 'proposeTrack', status: 'done' as const, input: {}, result: baseResult };
  const conversationId = await createConversation('CONFIG');
  await appendMessage(conversationId, { role: 'assistant', content: 'Pick below.', toolCalls: [tc] }, MSG);
  return { proposal, conversationId, source: { resultKey: `${MSG}::0`, baseResult } };
}
async function trackCard(conversationId: string) {
  const items = deriveThreadItems({
    live: [],
    history: await fetchMessagesForConversation(conversationId),
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: 'Earlier',
    toolCallResults: useFloatingChatStore.getState().toolCallResults,
  });
  return { items, card: items.find((i) => i.kind === 'proposal-card') as Extract<ChatThreadItem, { kind: 'proposal-card' }> };
}

describe('Add to my profile instead', () => {
  beforeEach(() => resetChatModules());

  it('the card reads the offer from the staged result', async () => {
    const { conversationId } = await stage();
    const { card } = await trackCard(conversationId);
    expect(card.track?.profileOffer).toEqual(OFFER);
    expect(card.track?.profileStep).toBeNull();
  });

  it('a card with a malformed offer has none', async () => {
    const { conversationId } = await stage(undefined, [{ nope: 1 }]);
    expect((await trackCard(conversationId)).card.track?.profileOffer).toEqual([]);
  });

  it('the tap saves nothing and asks through the engine, with no turn', async () => {
    const ask = jest.spyOn(chatSession, 'askImpactQuestion').mockResolvedValue(undefined);
    const { conversationId, source } = await stage();
    await askProfileImpact(source, QUESTION);

    expect(ask).toHaveBeenCalledWith(QUESTION);
    expect(await getFacts()).toHaveLength(0);
    expect(await queuedJobs('topic_gen')).toHaveLength(0);
    expect((await trackCard(conversationId)).card.track?.profileStep).toBe('asking');
    ask.mockRestore();
  });

  it('Add it anyway commits every entry with topic generation, and settles the card', async () => {
    const { conversationId, source, proposal } = await stage();
    await addProfileOffer(source, proposal.id, OFFER);

    const [fact] = await getFacts();
    expect(fact).toMatchObject({ statement: 'Follows Rally Finland', questionnaireAttribute: 'topics: general interests' });
    expect((await queuedJobs('topic_gen'))[0].payload).toMatchObject({ skillId: 'topics/interest' });
    const { card, items } = await trackCard(conversationId);
    expect(card.track?.profileStep).toBe('added');
    expect(trackCardStatus({ outcomes: {}, dismissed: false, superseded: false, added: true })).toBe('addedToProfile');
    expect(useFloatingChatStore.getState().proposal).toBeNull();
    // The saved fact and its topics, as any fact accepted in chat.
    expect(items.some((i) => i.kind === 'fact-card')).toBe(true);
  });

  it('a failed commit changes nothing, so the button can be tapped again', async () => {
    const commit = jest.spyOn(require('@/lib/chat-tools/fact-commit'), 'commitFactChoices').mockRejectedValueOnce(new Error('db'));
    const { conversationId, source, proposal } = await stage();
    await expect(addProfileOffer(source, proposal.id, OFFER)).resolves.toBe(false);
    expect((await trackCard(conversationId)).card.track?.profileStep).toBeNull();
    commit.mockRestore();
  });

  it('survives More options', async () => {
    const { conversationId, source, proposal } = await stage();
    growTrackCard(source, proposal, [{ type: 'track_story', label: 'Rally Sweden', searchText: 'Rally Sweden', subject }]);
    expect((await trackCard(conversationId)).card.track?.profileOffer).toEqual(OFFER);
    const { card } = await trackCard(conversationId);
    expect(card.proposal.actions).toHaveLength(3);
  });

  it('a row already followed stays followed', async () => {
    jest.spyOn(require('@/lib/tracking/track-actions'), 'syncFollowedStoryNow').mockResolvedValue(undefined);
    const { conversationId, source, proposal } = await stage();
    const follow = { ...source, dismissed: false, superseded: false };
    await followTickedOptions(follow, proposal, ['Rally Finland']);
    await addProfileOffer(source, proposal.id, OFFER);
    const { card } = await trackCard(conversationId);
    expect(card.track?.outcomes['rally finland']).toBe('following');
    expect(trackCardStatus({ outcomes: card.track!.outcomes, dismissed: false, superseded: false, added: true })).toBe('followed');
  });
});
