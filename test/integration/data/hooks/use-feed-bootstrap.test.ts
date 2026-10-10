// useFeedBootstrap under renderHook with the real stores, the in-memory DB and MSW. Focus is a
// parameter (R44), so no navigation container is needed. Seams: the opened-set hydrate on mount
// and refocus, the persona fetch gate, the hasGeneratedTopics write, and the two traps (blur is
// not unmount; the write is for the id the run started with).
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useFeedBootstrap } from '@/lib/hooks/use-feed-bootstrap';
import { createTopics } from '@/lib/database/services/topic-service';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useUserStore } from '@/lib/stores/user-store';
import { graphql, HttpResponse, mockGql, mockGqlError, server } from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';

const asked: string[] = [];
const persona = (userId: string) => personaFor(Date.now(), { userId });

/** Serves GetUserPersona and records the user ids asked for. */
function servePersona() {
  server.use(
    mockGql('GetUserPersona', (v) => {
      asked.push(String(v.userId));
      return { userPersonaByUserId: persona(String(v.userId)) };
    }),
  );
}

/** Like servePersona, but every response waits for `release()`. */
function servePersonaHeld() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  server.use(
    graphql.query('GetUserPersona', async ({ variables }) => {
      asked.push(String(variables.userId));
      await gate;
      return HttpResponse.json({ data: { userPersonaByUserId: persona(String(variables.userId)) } });
    }),
  );
  return release;
}

const mount = (focused: boolean) =>
  renderHook(({ focused }: { focused: boolean }) => useFeedBootstrap(focused), { initialProps: { focused } });

const hasTopics = () => useForYouStore.getState().hasGeneratedTopics;

beforeEach(() => {
  asked.length = 0;
  useUserStore.setState(useUserStore.getInitialState(), true);
  useOpenedStoriesStore.setState({ ids: new Set(), articleIds: new Set(), hydrated: false });
  useForYouStore.setState({ suggestions: [], hasGeneratedTopics: true });
  useUserStore.setState({ userId: 'user-1' });
  servePersona();
});

describe('opened-story hydrate', () => {
  it('hydrates on mount even while blurred', async () => {
    await recordOpen({ articleId: 'a1', surface: 'feed' });
    mount(false);
    await waitFor(() => expect([...useOpenedStoriesStore.getState().articleIds]).toEqual(['a1']));
  });

  it('refreshes on every refocus, so an open recorded elsewhere shows up', async () => {
    const { rerender } = mount(false);
    await waitFor(() => expect(useOpenedStoriesStore.getState().hydrated).toBe(true));
    await recordOpen({ articleId: 'a2', surface: 'detail' });
    expect(useOpenedStoriesStore.getState().articleIds.has('a2')).toBe(false);

    rerender({ focused: true });
    await waitFor(() => expect(useOpenedStoriesStore.getState().articleIds.has('a2')).toBe(true));
  });
});

describe('persona fetch gate', () => {
  it('fetches nothing while blurred, then fetches on focus', async () => {
    const { result, rerender } = mount(false);
    await act(async () => {});
    expect(asked).toEqual([]);
    expect(result.current.isLoading).toBe(false);

    rerender({ focused: true });
    await waitFor(() => expect(asked).toEqual(['user-1']));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('fetches nothing without a user id', async () => {
    useUserStore.setState({ userId: null });
    const { result } = mount(true);
    await act(async () => {});
    expect(asked).toEqual([]);
    expect(result.current).toEqual({ isLoading: false, errorMessage: null });
  });

  it('skips the fetch when the feed has suggestions and topics are known', async () => {
    useForYouStore.setState({ suggestions: [{ id: 's1' } as never], hasGeneratedTopics: true });
    mount(true);
    await act(async () => {});
    expect(asked).toEqual([]);
  });

  it('still fetches when suggestions exist but hasGeneratedTopics is false', async () => {
    useForYouStore.setState({ suggestions: [{ id: 's1' } as never], hasGeneratedTopics: false });
    mount(true);
    await waitFor(() => expect(asked).toEqual(['user-1']));
  });

  it('two mounts at once run one fetch (module-level in-flight guard)', async () => {
    const release = servePersonaHeld();
    const a = mount(true);
    const b = mount(true);
    await waitFor(() => expect(asked).toHaveLength(1));
    release();
    await waitFor(() => expect(a.result.current.isLoading).toBe(false));
    expect(asked).toEqual(['user-1']);
    expect(b.result.current.errorMessage).toBeNull();
  });
});

describe('hasGeneratedTopics', () => {
  it('becomes false for a confirmed-empty local topics table', async () => {
    const { result } = mount(true);
    await waitFor(() => expect(hasTopics()).toBe(false));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('becomes true when the device holds an active topic', async () => {
    useForYouStore.setState({ hasGeneratedTopics: false });
    await createTopics([{ text: 'Chess', weight: 1 }]);
    mount(true);
    await waitFor(() => expect(hasTopics()).toBe(true));
  });

  it("is written only for the id the run started with: a user switch mid-run drops the write", async () => {
    const release = servePersonaHeld();
    const { result, rerender } = mount(true);
    await waitFor(() => expect(asked).toEqual(['user-1']));

    // Blurred, so the switch starts no second run: this isolates the first run's write.
    rerender({ focused: false });
    act(() => useUserStore.setState({ userId: 'user-2' }));
    release();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {});
    expect(hasTopics()).toBe(true); // an empty table would have written false
  });
});

describe('failure', () => {
  it('shows the feed error, keeps hasGeneratedTopics, and a later refocus retries', async () => {
    server.use(mockGqlError('GetUserPersona', 'INTERNAL_SERVER_ERROR'));
    const { result, rerender } = mount(true);
    await waitFor(() => expect(result.current.errorMessage).not.toBeNull());
    expect(result.current.isLoading).toBe(false);
    expect(hasTopics()).toBe(true);

    servePersona();
    rerender({ focused: false });
    rerender({ focused: true });
    await waitFor(() => expect(hasTopics()).toBe(false));
    await waitFor(() => expect(result.current.errorMessage).toBeNull());
  });
});

describe('blur is not unmount', () => {
  it('a blur in the middle of a run still clears the spinner when the run settles', async () => {
    const release = servePersonaHeld();
    const { result, rerender } = mount(true);
    await waitFor(() => expect(result.current.isLoading).toBe(true));

    rerender({ focused: false });
    release();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(hasTopics()).toBe(false);
  });

  it('after unmount the run settles without touching local state', async () => {
    const release = servePersonaHeld();
    const { result, unmount } = mount(true);
    await waitFor(() => expect(result.current.isLoading).toBe(true));
    unmount();
    release();
    await waitFor(() => expect(hasTopics()).toBe(false)); // the store write still lands
  });
});
