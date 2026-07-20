import { act, renderHook } from '@testing-library/react-native';

// `startTransition` marks the wrapped state update as low-priority, which React
// may defer off the current tick. Under fake timers that makes adoption timing
// nondeterministic, so mock it to a synchronous passthrough — this hook only
// uses it to keep the downstream tree interruptible, not for correctness.
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return { ...actual, startTransition: (fn: () => void) => fn() };
});

// eslint-disable-next-line import/first
import { useFocusCoalescedValue } from '../use-focus-coalesced-value';

type Props = { v: string; focused: boolean; interval?: number };

const setup = (initial: Props) =>
  renderHook(
    ({ v, focused, interval }: Props) =>
      useFocusCoalescedValue(v, { focused, blurredIntervalMs: interval ?? 5000 }),
    { initialProps: initial },
  );

describe('useFocusCoalescedValue', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('returns the initial value immediately', () => {
    const { result } = setup({ v: 'a', focused: true });
    expect(result.current).toBe('a');
  });

  it('while focused: adopts new live values', () => {
    const { result, rerender } = setup({ v: 'a', focused: true });
    act(() => rerender({ v: 'b', focused: true }));
    expect(result.current).toBe('b');
    act(() => rerender({ v: 'c', focused: true }));
    expect(result.current).toBe('c');
  });

  it('while blurred: does not adopt before the interval elapses', () => {
    const { result, rerender } = setup({ v: 'a', focused: false });
    act(() => rerender({ v: 'b', focused: false }));
    act(() => jest.advanceTimersByTime(4999));
    expect(result.current).toBe('a');
  });

  it('while blurred: rapid changes collapse to one adoption after the interval, latest wins', () => {
    const { result, rerender } = setup({ v: 'a', focused: false });

    act(() => rerender({ v: 'b', focused: false }));
    act(() => jest.advanceTimersByTime(1000));
    act(() => rerender({ v: 'c', focused: false }));
    act(() => jest.advanceTimersByTime(1000));
    act(() => rerender({ v: 'd', focused: false }));

    // Interval (armed on the first blurred change) has not elapsed — nothing adopted.
    expect(result.current).toBe('a');

    // The single trailing timer fires once and adopts the LATEST value.
    act(() => jest.advanceTimersByTime(5000));
    expect(result.current).toBe('d');

    // No further adoption without a new change (timer not re-armed).
    act(() => jest.advanceTimersByTime(10_000));
    expect(result.current).toBe('d');
  });

  it('blur → focus: adopts the latest value on refocus', () => {
    const { result, rerender } = setup({ v: 'a', focused: false });
    act(() => rerender({ v: 'b', focused: false }));
    act(() => jest.advanceTimersByTime(1000)); // still within interval — not adopted yet
    expect(result.current).toBe('a');

    act(() => rerender({ v: 'b', focused: true }));
    expect(result.current).toBe('b');
  });

  it('clears the pending timer on unmount', () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const { rerender, unmount } = setup({ v: 'a', focused: false });
    act(() => rerender({ v: 'b', focused: false })); // arm the trailing timer

    unmount();
    expect(clearSpy).toHaveBeenCalled();

    // Firing the underlying timer after unmount must be a no-op (no state update).
    expect(() => act(() => jest.advanceTimersByTime(5000))).not.toThrow();
    clearSpy.mockRestore();
  });
});
