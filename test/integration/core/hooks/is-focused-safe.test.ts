// use-is-focused-safe: the "visible and in front" predicate behind every looping animation.
// A fake navigation object on NavigationContext (renderHookInScreen) stands in for a navigator,
// and the integration setup's drivable AppState stands in for the OS.
import { act, renderHook } from '@testing-library/react-native';
import { useAnimationsActive, useAppIsForegrounded, useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { renderHookInScreen, setAppState } from '@/test/helpers';

beforeEach(() => setAppState('active'));
afterAll(() => setAppState('active'));

describe('useIsFocusedSafe', () => {
  it('is true with no navigator above it, where useIsFocused would throw', () => {
    const { result } = renderHook(() => useIsFocusedSafe());
    expect(result.current).toBe(true);
  });

  it('reads the screen\'s focus at mount', () => {
    expect(renderHookInScreen(() => useIsFocusedSafe(), { focused: true }).result.current).toBe(true);
    expect(renderHookInScreen(() => useIsFocusedSafe(), { focused: false }).result.current).toBe(false);
  });

  it('follows focus and blur events', () => {
    const { result, setFocused } = renderHookInScreen(() => useIsFocusedSafe());
    setFocused(false);
    expect(result.current).toBe(false);
    setFocused(true);
    expect(result.current).toBe(true);
  });

  it('stops listening once unmounted', () => {
    const { result, setFocused, unmount } = renderHookInScreen(() => useIsFocusedSafe());
    unmount();
    setFocused(false);
    expect(result.current).toBe(true);
  });
});

describe('useAppIsForegrounded', () => {
  it('is true while active and while inactive (app switcher still shows content)', () => {
    const { result } = renderHook(() => useAppIsForegrounded());
    expect(result.current).toBe(true);
    act(() => setAppState('inactive'));
    expect(result.current).toBe(true);
  });

  it('is false only in the background, and true again on return', () => {
    const { result } = renderHook(() => useAppIsForegrounded());
    act(() => setAppState('background'));
    expect(result.current).toBe(false);
    act(() => setAppState('active'));
    expect(result.current).toBe(true);
  });

  it('starts false when mounted while the app is already in the background', () => {
    setAppState('background');
    const { result } = renderHook(() => useAppIsForegrounded());
    expect(result.current).toBe(false);
  });

  it('stops listening once unmounted', () => {
    const { result, unmount } = renderHook(() => useAppIsForegrounded());
    unmount();
    act(() => setAppState('background'));
    expect(result.current).toBe(true);
  });
});

describe('useAnimationsActive', () => {
  it('runs only when the screen is focused AND the app is in front', () => {
    const { result, setFocused } = renderHookInScreen(() => useAnimationsActive());
    expect(result.current).toBe(true);

    act(() => setAppState('background'));
    expect(result.current).toBe(false);

    act(() => setAppState('active'));
    expect(result.current).toBe(true);

    setFocused(false);
    expect(result.current).toBe(false);

    // Back in front but still blurred: still paused.
    act(() => setAppState('inactive'));
    expect(result.current).toBe(false);

    setFocused(true);
    expect(result.current).toBe(true);
  });

  it('is true with no navigator while the app is in front', () => {
    const { result } = renderHook(() => useAnimationsActive());
    expect(result.current).toBe(true);
    act(() => setAppState('background'));
    expect(result.current).toBe(false);
  });
});
