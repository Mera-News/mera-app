import { act, renderHook } from '@testing-library/react-native';
import { DEFAULT_DEBOUNCE_MS, useDebouncedValue } from '../use-debounced-value';

describe('useDebouncedValue', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 250));
    expect(result.current).toBe('a');
  });

  it('defers updates until the value settles for delayMs', () => {
    const { result, rerender } = renderHook((({ v }: { v: string }) => useDebouncedValue(v, 250)), {
      initialProps: { v: 'a' },
    });

    rerender({ v: 'ab' });
    expect(result.current).toBe('a'); // not yet elapsed

    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(result.current).toBe('ab');
  });

  it('coalesces rapid changes — only the last value lands (trailing edge)', () => {
    const { result, rerender } = renderHook((({ v }: { v: string }) => useDebouncedValue(v, 250)), {
      initialProps: { v: 'a' },
    });

    rerender({ v: 'ab' });
    act(() => jest.advanceTimersByTime(100));
    rerender({ v: 'abc' });
    act(() => jest.advanceTimersByTime(100));
    rerender({ v: 'abcd' });

    // The first two changes were superseded before their timers fired.
    expect(result.current).toBe('a');

    act(() => jest.advanceTimersByTime(250));
    expect(result.current).toBe('abcd');
  });

  it('falls back to the default debounce window when none is given', () => {
    const { result, rerender } = renderHook((({ v }: { v: string }) => useDebouncedValue(v)), {
      initialProps: { v: 'x' },
    });
    rerender({ v: 'y' });
    act(() => jest.advanceTimersByTime(DEFAULT_DEBOUNCE_MS));
    expect(result.current).toBe('y');
  });
});
