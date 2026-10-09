// useOpenSuggestion: the shared "open a suggestion" handler. It pushes the detail route at once and
// defers the dim + impression bookkeeping past navigation. Real opened-stories store, real
// story_impressions table on the in-memory DB, real auth session; only expo-router is the edge.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { authClient } from '@/lib/auth-client';
import { getAll } from '@/lib/database/services/story-impression-service';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useUserStore } from '@/lib/stores/user-store';
import { FIXTURE_ACCOUNT, signInFixtureAccount } from '@/test/helpers';
import { seedArticles, suggestionRows } from '../sync/seed';

const push = router.push as unknown as jest.Mock;

async function seeded(opts: { title?: string; clusterId?: string; stableClusterId?: string } = {}): Promise<ForYouSuggestion> {
  await seedArticles([{ id: 'art-1', title: opts.title ?? 'Dike repair starts in Hoorn', ...opts }]);
  return (await suggestionRows())['art-1'];
}

/** The impression write is fire-and-forget behind InteractionManager: wait for the row. */
async function impressions() {
  await waitFor(async () => expect(await getAll()).toHaveLength(1));
  return getAll();
}

beforeEach(() => {
  useOpenedStoriesStore.setState({ ids: new Set(), articleIds: new Set(), hydrated: true });
  useUserStore.setState({ userPersona: null });
});

describe('useOpenSuggestion', () => {
  it('pushes suggestion-detail with empty user and persona ids when signed out', async () => {
    const s = await seeded();
    const { result } = renderHook(() => useOpenSuggestion('feed'));

    act(() => result.current(s));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: s._id, userId: '', userPersonaId: '' },
    });
    await impressions(); // let the deferred write finish inside this test
  });

  it('carries the session user id and the persona id in the route params', async () => {
    await signInFixtureAccount();
    useUserStore.setState({ userPersona: { _id: 'persona-1' } as never });
    const s = await seeded();
    const { result } = renderHook(() => ({ open: useOpenSuggestion('feed'), session: authClient.useSession().data }));
    await waitFor(() => expect(result.current.session?.user?.id).toBe(FIXTURE_ACCOUNT.userId));

    act(() => result.current.open(s));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: s._id, userId: FIXTURE_ACCOUNT.userId, userPersonaId: 'persona-1' },
    });
    await impressions();
  });

  it('dims the story and records the open with its surface, ids and normalised title', async () => {
    const s = await seeded({ title: '  Dike   REPAIR starts\nin Hoorn ', clusterId: 'c1', stableClusterId: 'stable-1' });
    const { result } = renderHook(() => useOpenSuggestion('headlines'));

    act(() => result.current(s));

    const [row] = await impressions();
    expect(row.articleId).toBe('art-1');
    expect(row.suggestionId).toBe(s._id);
    expect(row.stableClusterId).toBe('stable-1');
    expect(row.titleNorm).toBe('dike repair starts in hoorn');
    expect(row.surface).toBe('headlines');
    expect(row.opened).toBe(true);

    const opened = useOpenedStoriesStore.getState();
    expect([...opened.ids].sort()).toEqual(['art-1', 'stable-1']);
    expect([...opened.articleIds]).toEqual(['art-1']);
  });

  it('records no cluster and no title when the row has neither', async () => {
    const s = { ...(await seeded()), clusters: [], title_en: null };
    const { result } = renderHook(() => useOpenSuggestion('feed'));

    act(() => result.current(s));

    const [row] = await impressions();
    expect(row.stableClusterId).toBeNull();
    expect(row.titleNorm).toBeNull();
    expect([...useOpenedStoriesStore.getState().ids]).toEqual(['art-1']);
  });

  it('uses the first cluster that has a stable id', async () => {
    const s = {
      ...(await seeded()),
      clusters: [
        { clusterId: 'c0', confidence: 0.9 },
        { clusterId: 'c1', confidence: 0.8, stableClusterId: 'stable-b' },
        { clusterId: 'c2', confidence: 0.7, stableClusterId: 'stable-c' },
      ],
    };
    const { result } = renderHook(() => useOpenSuggestion('feed'));

    act(() => result.current(s));

    const [row] = await impressions();
    expect(row.stableClusterId).toBe('stable-b');
  });

  it('keeps one callback per surface and session', async () => {
    const { result, rerender } = renderHook(({ surface }: { surface: 'feed' | 'swipe' }) => useOpenSuggestion(surface), {
      initialProps: { surface: 'feed' as 'feed' | 'swipe' },
    });
    const first = result.current;
    rerender({ surface: 'feed' });
    expect(result.current).toBe(first);
    rerender({ surface: 'swipe' });
    expect(result.current).not.toBe(first);
  });
});
