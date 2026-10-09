// The Mera button's look over the real display-prefs store and the real theme store: the reader's
// choice wins, no choice follows the theme, and a choice survives a relaunch through AsyncStorage.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import { meraButtonColors, resolveMeraButtonLook, useMeraButtonLook } from '@/components/custom/mera-button/look';
import { MERA_BUTTON_LOOK_KEY, useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { COLORS } from '@/lib/theme/tokens';
import { useThemeStore } from '@/lib/theme/theme-store';

beforeEach(() => {
  useDisplayPrefsStore.setState({ meraButtonLook: null });
  useThemeStore.setState({ mode: 'dark' });
});

describe('resolving the look', () => {
  it('follows the theme until the reader picks', () => {
    expect(resolveMeraButtonLook(null, 'dark')).toBe('light');
    expect(resolveMeraButtonLook(null, 'light')).toBe('dark');
    expect(resolveMeraButtonLook('dark', 'dark')).toBe('dark');
    expect(resolveMeraButtonLook('light', 'light')).toBe('light');
  });

  it('keeps the exact pairs the button wore per theme', () => {
    expect(meraButtonColors('light')).toEqual({ disc: COLORS.dark.ink, mark: COLORS.dark.base });
    expect(meraButtonColors('dark')).toEqual({ disc: COLORS.light.ink, mark: COLORS.light.base });
  });
});

describe('useMeraButtonLook', () => {
  it('with no choice, a dark theme wears the light disc and a light theme the dark one', () => {
    const { result } = renderHook(() => useMeraButtonLook());
    expect(result.current).toBe('light');

    act(() => useThemeStore.setState({ mode: 'light' }));
    expect(result.current).toBe('dark');
  });

  it('the reader choice wins over the theme and is kept in AsyncStorage', async () => {
    const { result } = renderHook(() => useMeraButtonLook());

    act(() => useDisplayPrefsStore.getState().setMeraButtonLook('dark'));

    expect(result.current).toBe('dark'); // the dark theme alone would have said light
    expect(await AsyncStorage.getItem(MERA_BUTTON_LOOK_KEY)).toBe('dark');

    act(() => useThemeStore.setState({ mode: 'light' }));
    expect(result.current).toBe('dark'); // and the theme no longer moves it
  });

  it('a stored choice comes back on hydrate, a garbage one is ignored', async () => {
    const { result } = renderHook(() => useMeraButtonLook());

    await AsyncStorage.setItem(MERA_BUTTON_LOOK_KEY, 'dark');
    await act(async () => {
      await useDisplayPrefsStore.getState().hydrate();
    });
    expect(result.current).toBe('dark');

    act(() => useDisplayPrefsStore.setState({ meraButtonLook: null }));
    await AsyncStorage.setItem(MERA_BUTTON_LOOK_KEY, 'sepia');
    await act(async () => {
      await useDisplayPrefsStore.getState().hydrate();
    });
    expect(useDisplayPrefsStore.getState().meraButtonLook).toBeNull();
    expect(result.current).toBe('light');
  });
});
