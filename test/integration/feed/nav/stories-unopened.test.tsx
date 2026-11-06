// A followed story the reader has never gone to see lights the Feed tab and the Stories pill,
// even with no updates, so a reader who lands on World finds their way there.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useStoriesUnopened, markStoriesOpened, __resetStoriesOpenedForTests } from '@/components/custom/tracked-stories/use-stories-unopened';
import { deleteSetting } from '@/lib/database/services/setting-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';

beforeEach(async () => {
    __resetStoriesOpenedForTests();
    await deleteSetting('stories_page_opened');
});

it('stays off with nothing followed', async () => {
    const { result } = await renderHook(() => useStoriesUnopened());
    await act(async () => undefined);
    expect(result.current).toBe(false);
});

it('lights for a followed story and goes out for good once Stories is opened', async () => {
    const { result } = await renderHook(() => useStoriesUnopened());
    await act(async () => {
        await trackStory({ title: 'Ukraine war', topicText: 'ukraine war' } as never);
    });
    await waitFor(() => expect(result.current).toBe(true));

    await act(async () => {
        await markStoriesOpened();
    });
    expect(result.current).toBe(false);

    __resetStoriesOpenedForTests();
    const again = await renderHook(() => useStoriesUnopened());
    await act(async () => undefined);
    await waitFor(() => expect(again.result.current).toBe(false));
});
