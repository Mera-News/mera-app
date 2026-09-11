// No setting-service mock here ON PURPOSE: importing the theme layer must not
// pull in WatermelonDB. If this suite ever starts needing a DB mock, the lazy
// require in theme-store has been undone.
import { renderHook } from '@testing-library/react-native';

import { useThemeStore } from '@/lib/stores/theme-store';

import { SEMANTIC } from '../semantic';
import { getThemeColors, useThemeColors } from '../index';

beforeEach(() => {
  useThemeStore.getState().reset();
});

describe('useThemeColors', () => {
  it('returns the dark role map by default', () => {
    const { result } = renderHook(() => useThemeColors());
    expect(result.current).toBe(SEMANTIC.dark);
  });

  it('follows resolved, not preference', () => {
    useThemeStore.setState({ preference: 'system', resolved: 'light' });
    const { result } = renderHook(() => useThemeColors());
    expect(result.current).toBe(SEMANTIC.light);
  });
});

describe('getThemeColors', () => {
  it('reads the same map outside React', () => {
    expect(getThemeColors()).toBe(SEMANTIC.dark);
    useThemeStore.setState({ resolved: 'light' });
    expect(getThemeColors()).toBe(SEMANTIC.light);
  });
});
