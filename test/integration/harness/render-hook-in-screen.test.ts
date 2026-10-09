// renderHookInScreen lets a hook that calls useIsFocused run, and focus is drivable.
import { useIsFocused } from '@react-navigation/native';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { renderHookInScreen } from '@/test/helpers';

describe('renderHookInScreen', () => {
  it('useIsFocused and useIsFocusedSafe follow the screen focus', () => {
    const { result, setFocused } = renderHookInScreen(() => ({ bare: useIsFocused(), safe: useIsFocusedSafe() }));
    expect(result.current).toEqual({ bare: true, safe: true });
    setFocused(false);
    expect(result.current).toEqual({ bare: false, safe: false });
    setFocused(true);
    expect(result.current).toEqual({ bare: true, safe: true });
  });

  it('can start blurred', () => {
    const { result } = renderHookInScreen(() => useIsFocused(), { focused: false });
    expect(result.current).toBe(false);
  });
});
