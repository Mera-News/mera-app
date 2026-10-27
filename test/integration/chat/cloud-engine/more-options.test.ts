// "More options" on a follow card goes through the chat session, built from the card alone.
import { canRequestMoreOptions, requestMoreOptions } from '@/lib/chat-session/chat-session';
import { MAX_FOLLOW_OPTIONS } from '@/lib/chat-session/engine';
import type { ProposalAction, TrackFeedbackSubject } from '@/lib/news-harness/core/types';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { signInFixtureAccount } from '@/test/helpers';
import { attachCloud, settle } from './kit';

jest.setTimeout(30_000);
afterEach(settle);
beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});

const SUBJECT: TrackFeedbackSubject = {
  origin: 'article', surface: 'tracked-stories-chat', articleId: '', title: '', pubDate: null,
  stableClusterId: null, publicationName: null,
};
const track = (label: string): ProposalAction => ({ type: 'track_story', label, searchText: `${label} news`, subject: SUBJECT });

describe('requestMoreOptions', () => {
  it('asks the engine with the shown options, the room left and the card subject', async () => {
    const { engine } = await attachCloud();
    const seen: unknown[] = [];
    engine.moreOptions = async (req) => {
      seen.push(req);
      return { actions: [] , reason: 'none' };
    };
    expect(canRequestMoreOptions()).toBe(true);

    await requestMoreOptions('track-1', [track('DPDP rules'), track('Indian data law'), { type: 'retire_topic', topicText: 'cricket' }]);

    expect(seen).toEqual([{
      proposalId: 'track-1',
      shown: [{ label: 'DPDP rules', searchText: 'DPDP rules news' }, { label: 'Indian data law', searchText: 'Indian data law news' }],
      room: MAX_FOLLOW_OPTIONS - 2,
      subject: SUBJECT,
    }]);
  });

  it('answers none without asking when the card is full or the engine cannot do it', async () => {
    const { engine } = await attachCloud();
    const full = Array.from({ length: MAX_FOLLOW_OPTIONS }, (_, i) => track(`Option ${i}`));
    const ask = jest.fn();
    engine.moreOptions = ask;
    await expect(requestMoreOptions('track-1', full)).resolves.toEqual({ actions: [], reason: 'none' });
    expect(ask).not.toHaveBeenCalled();

    delete engine.moreOptions;
    expect(canRequestMoreOptions()).toBe(false);
    await expect(requestMoreOptions('track-1', [track('A')])).resolves.toEqual({ actions: [], reason: 'none' });
  });

  it('turns a throw into failed', async () => {
    const { engine } = await attachCloud();
    engine.moreOptions = async () => { throw new Error('boom'); };
    await expect(requestMoreOptions('track-1', [track('A')])).resolves.toEqual({ actions: [], reason: 'failed' });
  });
});
