// The article chat stages a follow card while at least one proposed scope is not yet followed
// for that article; only when every scope is followed does it answer alreadyTracked.
import { ArticleFeedbackAgent } from '@/lib/llm/agents/ArticleFeedbackAgent';
import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';
import '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';

jest.setTimeout(30_000);

beforeEach(() => {
  resetChatModules();
  const { AppScheduler } = require('@/lib/scheduler/AppScheduler');
  jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('started');
});
afterEach(() => jest.restoreAllMocks());

const agent = () => new ArticleFeedbackAgent('user-1', { articleId: 'a-1', suggestionId: 's-1' }, null);
const subject = { origin: 'suggestion' as const, surface: 'detail', articleId: 'a-1', title: 'Protest escalates' };
const follow = (label: string, searchText: string) => ({ type: 'track_story' as const, label, searchText, subject });

describe('ArticleFeedbackAgent proposeTrack guard', () => {
  it('stages the card when one proposed scope is new, and refuses when all are followed', async () => {
    await executeProposalActions([follow('Scope one', 'scope one')]);

    const mixed = await agent().executeTool('proposeTrack', {
      options: [{ label: 'Scope one', search: 'Scope  One' }, { label: 'Scope two', search: 'scope two' }],
    });
    expect(mixed.sideEffects?.proposal?.actions).toHaveLength(2);

    const allFollowed = await agent().executeTool('proposeTrack', { options: [{ label: 'Scope one', search: 'scope one' }] });
    expect(allFollowed.result).toMatchObject({ alreadyTracked: true });
    expect(allFollowed.sideEffects).toBeUndefined();
  });
});
