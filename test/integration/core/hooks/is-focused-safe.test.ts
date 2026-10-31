// use-is-focused-safe: the "visible and in front" predicate behind every looping animation.
// A fake navigation object on NavigationContext (renderHookInScreen) stands in for a navigator,
// and the integration setup's drivable AppState stands in for the OS.
import { act, renderHook } from '@testing-library/react-native';
import { useAnimationsActive, useAppIsForegrounded, useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { renderHookInScreen, setAppState } from '@/test/helpers';

beforeEach(() => setAppState('active'));
afterAll(() => setAppState('active'));

describe('useIsFocusedSafe', () => {
  it('is true with no navigator above it, where useIsFocused would throw', async () => {
    const { result } = await renderHook(() => useIsFocusedSafe());
    expect(result.current).toBe(true);
  });

  it('reads the screen\'s focus at mount', async () => {
    expect((await renderHookInScreen(() => useIsFocusedSafe(), { focused: true })).result.current).toBe(true);
    expect((await renderHookInScreen(() => useIsFocusedSafe(), { focused: false })).result.current).toBe(false);
  });

  it('follows focus and blur events', async () => {
    const { result, setFocused } = await renderHookInScreen(() => useIsFocusedSafe());
    await setFocused(false);
    expect(result.current).toBe(false);
    await setFocused(true);
    expect(result.current).toBe(true);
  });

  it('stops listening once unmounted', async () => {
    const { result, setFocused, unmount } = await renderHookInScreen(() => useIsFocusedSafe());
    await unmount();
    await setFocused(false);
    expect(result.current).toBe(true);
  });
});

describe('useAppIsForegrounded', () => {
  it('is true while active and while inactive (app switcher still shows content)', async () => {
    const { result } = await renderHook(() => useAppIsForegrounded());
    expect(result.current).toBe(true);
    await act(() => setAppState('inactive'));
    expect(result.current).toBe(true);
  });

  it('is false only in the background, and true again on return', async () => {
    const { result } = await renderHook(() => useAppIsForegrounded());
    await act(() => setAppState('background'));
    expect(result.current).toBe(false);
    await act(() => setAppState('active'));
    expect(result.current).toBe(true);
  });

  it('starts false when mounted while the app is already in the background', async () => {
    setAppState('background');
    const { result } = await renderHook(() => useAppIsForegrounded());
    expect(result.current).toBe(false);
  });

  it('stops listening once unmounted', async () => {
    const { result, unmount } = await renderHook(() => useAppIsForegrounded());
    await unmount();
    await act(() => setAppState('background'));
    expect(result.current).toBe(true);
  });
});

describe('useAnimationsActive', () => {
  it('runs only when the screen is focused AND the app is in front', async () => {
    const { result, setFocused } = await renderHookInScreen(() => useAnimationsActive());
    expect(result.current).toBe(true);

    await act(() => setAppState('background'));
    expect(result.current).toBe(false);

    await act(() => setAppState('active'));
    expect(result.current).toBe(true);

    await setFocused(false);
    expect(result.current).toBe(false);

    // Back in front but still blurred: still paused.
    await act(() => setAppState('inactive'));
    expect(result.current).toBe(false);

    await setFocused(true);
    expect(result.current).toBe(true);
  });

  it('is true with no navigator while the app is in front', async () => {
    const { result } = await renderHook(() => useAnimationsActive());
    expect(result.current).toBe(true);
    await act(() => setAppState('background'));
    expect(result.current).toBe(false);
  });
});
