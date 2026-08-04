// use-is-focused-safe.test — the load-bearing case is the FIRST describe:
// `useIsFocused()` throws without a navigator, and this app mounts animated
// components above the navigator (NativeUpdateGate -> ForceUpdateScreen).

import React from 'react';
import { AppState, Text } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { NavigationContext } from '@react-navigation/native';

import {
  useAnimationsActive,
  useAppIsForegrounded,
  useIsFocusedSafe,
} from '../use-is-focused-safe';

// Spy rather than a module factory mock: the factory would have to close over
// these bindings, which jest's hoisting forbids.
let appStateHandler: ((s: string) => void) | undefined;
const removeSpy = jest.fn();
let addSpy: jest.SpyInstance;

beforeEach(() => {
  appStateHandler = undefined;
  removeSpy.mockClear();
  addSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_e: string, cb: (s: string) => void) => {
      appStateHandler = cb;
      return { remove: removeSpy };
    }) as never);
});

afterEach(() => addSpy.mockRestore());

function Probe({ hook }: { hook: () => boolean }) {
  const value = hook();
  return <Text>{value ? 'yes' : 'no'}</Text>;
}

/** Minimal stand-in for a react-navigation route object. */
function makeNavigation(initiallyFocused: boolean) {
  const listeners: Record<string, Array<() => void>> = { focus: [], blur: [] };
  return {
    nav: {
      isFocused: () => initiallyFocused,
      addListener: (event: string, cb: () => void) => {
        listeners[event]?.push(cb);
        return () => {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== cb);
        };
      },
    } as never,
    fire: (event: 'focus' | 'blur') =>
      act(() => {
        (listeners[event] ?? []).forEach((f) => f());
      }),
    listenerCount: () => listeners.focus.length + listeners.blur.length,
  };
}

describe('useIsFocusedSafe', () => {
  describe('with NO navigator above it', () => {
    it('returns true instead of throwing', () => {
      // This is the ForceUpdateScreen / FullScreenErrorFallback case. A bare
      // useIsFocused() would throw "Couldn't find a navigation object" here.
      const { getByText } = render(<Probe hook={useIsFocusedSafe} />);
      expect(getByText('yes')).toBeTruthy();
    });
  });

  describe('with a navigator', () => {
    it('reports the navigator focus state on first render', () => {
      const { nav } = makeNavigation(false);
      const { getByText } = render(
        <NavigationContext.Provider value={nav}>
          <Probe hook={useIsFocusedSafe} />
        </NavigationContext.Provider>,
      );
      expect(getByText('no')).toBeTruthy();
    });

    it('flips on blur and back on focus', () => {
      const { nav, fire } = makeNavigation(true);
      const { getByText } = render(
        <NavigationContext.Provider value={nav}>
          <Probe hook={useIsFocusedSafe} />
        </NavigationContext.Provider>,
      );
      expect(getByText('yes')).toBeTruthy();

      fire('blur');
      expect(getByText('no')).toBeTruthy();

      fire('focus');
      expect(getByText('yes')).toBeTruthy();
    });

    it('unsubscribes both listeners on unmount', () => {
      const { nav, listenerCount } = makeNavigation(true);
      const { unmount } = render(
        <NavigationContext.Provider value={nav}>
          <Probe hook={useIsFocusedSafe} />
        </NavigationContext.Provider>,
      );
      expect(listenerCount()).toBe(2);
      unmount();
      expect(listenerCount()).toBe(0);
    });
  });
});

describe('useAppIsForegrounded', () => {
  it('treats `inactive` as still foregrounded, `background` as not', () => {
    const { getByText } = render(<Probe hook={useAppIsForegrounded} />);
    expect(getByText('yes')).toBeTruthy();

    // The app switcher / a system alert — content is still on screen.
    act(() => appStateHandler?.('inactive'));
    expect(getByText('yes')).toBeTruthy();

    act(() => appStateHandler?.('background'));
    expect(getByText('no')).toBeTruthy();

    act(() => appStateHandler?.('active'));
    expect(getByText('yes')).toBeTruthy();
  });

  it('removes its AppState subscription on unmount', () => {
    const { unmount } = render(<Probe hook={useAppIsForegrounded} />);
    unmount();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useAnimationsActive', () => {
  it('is true only when focused AND foregrounded', () => {
    const { nav, fire } = makeNavigation(true);
    const { getByText } = render(
      <NavigationContext.Provider value={nav}>
        <Probe hook={useAnimationsActive} />
      </NavigationContext.Provider>,
    );
    expect(getByText('yes')).toBeTruthy();

    // Blurred but foregrounded — another tab is on screen.
    fire('blur');
    expect(getByText('no')).toBeTruthy();

    // Focused again, but the app goes to the background.
    fire('focus');
    act(() => appStateHandler?.('background'));
    expect(getByText('no')).toBeTruthy();

    act(() => appStateHandler?.('active'));
    expect(getByText('yes')).toBeTruthy();
  });
});
