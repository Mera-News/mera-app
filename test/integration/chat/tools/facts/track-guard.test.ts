// chatfix P2 U3: the follow duplicate guard keys on article/cluster id AND scope text,
// an already-followed scope is a success, and N follows trigger one feed sync.
import { firstValueFrom } from 'rxjs';
import database from '@/lib/database';
import { getAllByNormalizedText } from '@/lib/database/services/topic-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import { observeSubjectTrackedId } from '@/lib/tracking/track-actions';
import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';
import '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';

jest.setTimeout(30_000);

const subject = (articleId: string) => ({
  origin: 'suggestion' as const,
  surface: 'detail',
  articleId,
  title: 'Protest escalates',
  publicationName: 'The Hindu',
});
const follow = (articleId: string, label: string, searchText = label.toLowerCase()) => ({
  type: 'track_story' as const,
  label,
  searchText,
  subject: subject(articleId),
});
const rows = () => database.get('tracked_stories').query().fetch();

let trigger: jest.SpyInstance;
beforeEach(() => {
  resetChatModules();
  const { AppScheduler } = require('@/lib/scheduler/AppScheduler');
  trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('started');
});
afterEach(() => jest.restoreAllMocks());

describe('follow duplicate guard', () => {
  it('two scopes of one article both follow', async () => {
    const r = await executeProposalActions([follow('a-1', 'Scope one'), follow('a-1', 'Scope two')]);

    expect(r).toMatchObject({ applied: 2, alreadyFollowed: 0, errors: [] });
    expect(await rows()).toHaveLength(2);
    expect(await getAllByNormalizedText('scope one')).toHaveLength(1);
    expect(await getAllByNormalizedText('scope two')).toHaveLength(1);
  });

  it('the same scope twice is already-followed success, one row', async () => {
    await executeProposalActions([follow('a-1', 'Scope one')]);
    const r = await executeProposalActions([follow('a-1', 'Scope one')]);

    expect(r.applied).toBe(1);
    expect(r.alreadyFollowed).toBe(1);
    expect(r.summaries).toEqual(['Already following "Scope one"']);
    expect(await rows()).toHaveLength(1);
  });

  it('scope text compares normalised (case, spacing)', async () => {
    await executeProposalActions([follow('a-1', 'Scope one', 'Scope   One')]);
    const r = await executeProposalActions([follow('a-1', 'Scope one', ' scope one ')]);

    expect(r.alreadyFollowed).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it('a legacy row with no topic text blocks every scope of its article', async () => {
    await trackStory({ articleId: 'a-9', title: 'Old', stableClusterId: null, originSurface: 'detail' });
    const r = await executeProposalActions([follow('a-9', 'Anything'), follow('a-9', 'Else')]);

    expect(r).toMatchObject({ applied: 2, alreadyFollowed: 2 });
    expect(await rows()).toHaveLength(1);
  });

  it('the same scope text on a different article is a separate follow', async () => {
    await executeProposalActions([follow('a-1', 'Scope one')]);
    // A different article, same scope text: distinct story (ids differ), follows.
    const r = await executeProposalActions([follow('a-2', 'Scope one')]);

    expect(r.alreadyFollowed).toBe(0);
    expect(await rows()).toHaveLength(2);
  });

  it('the track button observer stays true after any scope is followed', async () => {
    await executeProposalActions([follow('a-1', 'Scope one')]);

    expect(await firstValueFrom(observeSubjectTrackedId(subject('a-1')))).not.toBeNull();
  });
});

describe('feed sync', () => {
  it('three track actions trigger one sync', async () => {
    await executeProposalActions([follow('a-1', 'One'), follow('a-1', 'Two'), follow('a-1', 'Three')]);

    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('syncFeed: false triggers none', async () => {
    await executeProposalActions([follow('a-1', 'One'), follow('a-1', 'Two')], { syncFeed: false });

    expect(trigger).not.toHaveBeenCalled();
  });

  it('an already-followed repeat triggers none', async () => {
    await executeProposalActions([follow('a-1', 'One')]);
    trigger.mockClear();
    await executeProposalActions([follow('a-1', 'One')]);

    expect(trigger).not.toHaveBeenCalled();
  });
});
