// The Mera button host's wiring over the REAL stores: it shows by route, once the corner has
// hydrated, and never while the chat is open or still moving (useFloatingChatShown). A tap on an
// article page opens the chat on that article through the real floating-chat store.
import { act, renderHook } from '@testing-library/react-native';
import {
  hydrateMeraButtonCorner,
  resetMeraButtonCorner,
  useMeraCornerStore,
} from '@/components/custom/mera-button/corner';
import { buttonContextFor, meraButtonVisible, routeKindFor } from '@/components/custom/mera-button/host-rules';
import { openMeraChat } from '@/components/custom/mera-button/open-mera-chat';
import { useFloatingChatShown, useFloatingChatStore } from '@/lib/stores/floating-chat-store';

/** What MeraButtonHost computes: the route from the segments, the two store reads, the rules. */
function useShown(segments: string[], extra: { arrangeOpen?: boolean; keyboardUp?: boolean } = {}): boolean {
  const hydrated = useMeraCornerStore((s) => s.hydrated);
  const chatOpen = useFloatingChatShown();
  return meraButtonVisible({
    route: routeKindFor(segments),
    hydrated,
    chatOpen,
    arrangeOpen: extra.arrangeOpen ?? false,
    keyboardUp: extra.keyboardUp ?? false,
  });
}

const TAB = ['logged-in', 'app_container', 'feed'];

beforeEach(() => {
  resetMeraButtonCorner();
  useFloatingChatStore.getState().reset();
});

describe('useFloatingChatShown', () => {
  it('is false on a closed chat, true while it is open, and true while it is still moving', () => {
    const { result } = renderHook(() => useFloatingChatShown());
    expect(result.current).toBe(false);

    act(() => useFloatingChatStore.getState().expand());
    expect(result.current).toBe(true);

    // The store collapsed but ChatPopover's close animation has not finished: still shown.
    act(() => useFloatingChatStore.getState().setChatShown(true));
    act(() => useFloatingChatStore.getState().collapse());
    expect(useFloatingChatStore.getState().isExpanded).toBe(false);
    expect(result.current).toBe(true);

    act(() => useFloatingChatStore.getState().setChatShown(false));
    expect(result.current).toBe(false);
  });
});

describe('when the button shows', () => {
  it('is hidden until the stored corner has loaded, then shows on a tab', async () => {
    const { result } = renderHook(() => useShown(TAB));
    expect(result.current).toBe(false);

    await act(async () => {
      await hydrateMeraButtonCorner();
    });
    expect(result.current).toBe(true);
  });

  it('hides while the chat is open or moving, and comes back when it is gone', async () => {
    await hydrateMeraButtonCorner();
    const { result } = renderHook(() => useShown(TAB));
    expect(result.current).toBe(true);

    act(() => useFloatingChatStore.getState().expand());
    expect(result.current).toBe(false);

    act(() => useFloatingChatStore.getState().setChatShown(true));
    act(() => useFloatingChatStore.getState().collapse());
    expect(result.current).toBe(false);

    act(() => useFloatingChatStore.getState().setChatShown(false));
    expect(result.current).toBe(true);
  });

  it.each([
    [['logged-in', 'onboarding'], false],
    [['logged-in', 'feedback-request'], false],
    [['auth'], false],
    [['logged-in', 'search'], true],
    [['logged-in', 'article-detail'], true],
  ])('on %j: %s', async (segments, expected) => {
    await hydrateMeraButtonCorner();
    const { result } = renderHook(() => useShown(segments));
    expect(result.current).toBe(expected);
  });

  it('the keyboard hides it on a tab but not on Search', async () => {
    await hydrateMeraButtonCorner();
    expect(renderHook(() => useShown(TAB, { keyboardUp: true })).result.current).toBe(false);
    expect(renderHook(() => useShown(['logged-in', 'search'], { keyboardUp: true })).result.current).toBe(true);
  });
});

describe('what a tap opens', () => {
  it('on an article page the real store opens Mera on that article', () => {
    const context = buttonContextFor('article', { articleId: 'a1', title: 'Headline' });
    expect(context).toBeDefined();

    openMeraChat(context!);

    const state = useFloatingChatStore.getState();
    expect(state.isExpanded).toBe(true);
    expect(state.context).toEqual({
      kind: 'article-suggestion',
      articleId: 'a1',
      suggestionId: undefined,
      articleTitle: 'Headline',
    });
  });

  it('on a tab there is no override, so the page decides', () => {
    expect(buttonContextFor('tab', { articleId: 'a1' })).toBeUndefined();
  });
});
