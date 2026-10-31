// renderHookInScreen lets a hook that calls useIsFocused run, and focus is drivable.
import { useIsFocused } from 'expo-router';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { renderHookInScreen } from '@/test/helpers';

describe('renderHookInScreen', () => {
  it('useIsFocused and useIsFocusedSafe follow the screen focus', async () => {
    const { result, setFocused } = await renderHookInScreen(() => ({ bare: useIsFocused(), safe: useIsFocusedSafe() }));
    expect(result.current).toEqual({ bare: true, safe: true });
    await setFocused(false);
    expect(result.current).toEqual({ bare: false, safe: false });
    await setFocused(true);
    expect(result.current).toEqual({ bare: true, safe: true });
  });

  it('can start blurred', async () => {
    const { result } = await renderHookInScreen(() => useIsFocused(), { focused: false });
    expect(result.current).toBe(false);
  });

  it('the helper provides the NavigationContext that useIsFocusedSafe reads', async () => {
    const { result } = await renderHookInScreen(() => useIsFocusedSafe(), { focused: false });
    expect(result.current).toBe(false);
  });
});
