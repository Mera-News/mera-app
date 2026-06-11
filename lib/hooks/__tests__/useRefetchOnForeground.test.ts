// useRefetchOnForeground uses RN AppState — we capture the listener and invoke it.
//
// jest.mock() is hoisted before variable declarations, so the factory must NOT
// directly reference variables (they'd be in the TDZ). We use lazy wrappers
// (getters / wrapper functions) so values are resolved at call time.

const mockCurrentState = { value: 'active' as string };

jest.mock('react-native', () => ({
  AppState: {
    get currentState() { return mockCurrentState.value; },
    // Use a lazy wrapper: the real mockAddEventListener is resolved when called,
    // not when the factory runs.
    addEventListener: (...args: any[]) => mockAddEventListener(...args),
  },
  Platform: { OS: 'ios', select: (o: any) => o.ios },
  I18nManager: { isRTL: false, forceRTL: jest.fn() },
}));

// Declared AFTER jest.mock() in source order (but jest.mock was already hoisted).
// Safe to use in tests — only the lazy wrapper above captures these at call time.
const mockAddEventListener = jest.fn();
const mockRemove = jest.fn();

import { renderHook, act } from '@testing-library/react-native';
import { useRefetchOnForeground } from '../useRefetchOnForeground';

function captureListener(): (state: string) => void {
  const [, listener] = mockAddEventListener.mock.calls[0];
  return listener;
}

describe('useRefetchOnForeground', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentState.value = 'active';
    mockAddEventListener.mockReturnValue({ remove: mockRemove });
  });

  it('registers a listener for AppState "change" event on mount', () => {
    const callback = jest.fn();
    renderHook(() => useRefetchOnForeground(callback));
    expect(mockAddEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('removes the listener on unmount', () => {
    const { unmount } = renderHook(() => useRefetchOnForeground(jest.fn()));
    unmount();
    expect(mockRemove).toHaveBeenCalled();
  });

  it('fires callback when transitioning from background to active', () => {
    const callback = jest.fn();
    mockCurrentState.value = 'background';
    renderHook(() => useRefetchOnForeground(callback));

    const listener = captureListener();
    act(() => listener('active'));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('fires callback when transitioning from inactive to active', () => {
    const callback = jest.fn();
    mockCurrentState.value = 'inactive';
    renderHook(() => useRefetchOnForeground(callback));

    const listener = captureListener();
    act(() => listener('active'));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire callback when already active and stays active', () => {
    const callback = jest.fn();
    mockCurrentState.value = 'active';
    renderHook(() => useRefetchOnForeground(callback));

    const listener = captureListener();
    act(() => listener('active'));
    expect(callback).not.toHaveBeenCalled();
  });

  it('does NOT fire callback when transitioning from active to background', () => {
    const callback = jest.fn();
    mockCurrentState.value = 'active';
    renderHook(() => useRefetchOnForeground(callback));

    const listener = captureListener();
    act(() => listener('background'));
    expect(callback).not.toHaveBeenCalled();
  });

  it('does NOT fire callback when transitioning from active to inactive', () => {
    const callback = jest.fn();
    mockCurrentState.value = 'active';
    renderHook(() => useRefetchOnForeground(callback));

    const listener = captureListener();
    act(() => listener('inactive'));
    expect(callback).not.toHaveBeenCalled();
  });

  it('tracks state internally so subsequent background→active fires callback again', () => {
    const callback = jest.fn();
    mockCurrentState.value = 'active';
    renderHook(() => useRefetchOnForeground(callback));

    const listener = captureListener();
    // Go to background then return to foreground
    act(() => listener('background'));
    act(() => listener('active'));
    expect(callback).toHaveBeenCalledTimes(1);

    // Go to background again and return again
    act(() => listener('background'));
    act(() => listener('active'));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('fires callback even when callback reference changes', () => {
    let timesCallbackACalled = 0;
    let timesCallbackBCalled = 0;
    const callbackA = jest.fn(() => timesCallbackACalled++);
    const callbackB = jest.fn(() => timesCallbackBCalled++);

    mockCurrentState.value = 'background';
    const { rerender } = renderHook(
      ({ cb }: { cb: () => void }) => useRefetchOnForeground(cb),
      { initialProps: { cb: callbackA } },
    );

    // Trigger with callbackA
    const listenerA = captureListener();
    act(() => listenerA('active'));
    expect(timesCallbackACalled).toBe(1);

    // Re-render with callbackB — effect re-registers with new callback
    rerender({ cb: callbackB });
  });
});
