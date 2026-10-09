// renderHookInScreen: renderHook inside a minimal screen, so hooks that call
// @react-navigation's useIsFocused (directly or through useSectionSnapshots,
// useFocusCoalescedValue, useIsFocusedSafe) run. A fake navigation object on
// NavigationContext stands in for a container: no native screens, no router, and
// focus is a parameter the test drives (DECISIONS "Screen hooks": focus is a parameter).
import { act, renderHook, type RenderHookOptions } from '@testing-library/react-native';
import { NavigationContext } from '@react-navigation/native';
import React from 'react';

type FocusEvent = 'focus' | 'blur';

export interface ScreenNavigation {
  isFocused: () => boolean;
  addListener: (event: string, cb: () => void) => () => void;
  removeListener: (event: string, cb: () => void) => void;
  navigate: jest.Mock;
  goBack: jest.Mock;
  setOptions: jest.Mock;
  setParams: jest.Mock;
  dispatch: jest.Mock;
  canGoBack: () => boolean;
  getParent: () => undefined;
  getState: () => { index: number; routes: unknown[] };
}

export function renderHookInScreen<Result, Props>(
  hook: (props: Props) => Result,
  opts: { focused?: boolean } & Omit<RenderHookOptions<Props>, 'wrapper'> = {},
) {
  let focused = opts.focused ?? true;
  const listeners: Record<FocusEvent, Set<() => void>> = { focus: new Set(), blur: new Set() };
  const navigation: ScreenNavigation = {
    isFocused: () => focused,
    addListener: (event, cb) => {
      listeners[event as FocusEvent]?.add(cb);
      return () => listeners[event as FocusEvent]?.delete(cb);
    },
    removeListener: (event, cb) => {
      listeners[event as FocusEvent]?.delete(cb);
    },
    navigate: jest.fn(),
    goBack: jest.fn(),
    setOptions: jest.fn(),
    setParams: jest.fn(),
    dispatch: jest.fn(),
    canGoBack: () => false,
    getParent: () => undefined,
    getState: () => ({ index: 0, routes: [] }),
  };
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(NavigationContext.Provider, { value: navigation as never }, children);
  const result = renderHook(hook, { ...opts, wrapper });
  /** Focus or blur the screen; listeners run inside act(). */
  const setFocused = (next: boolean) =>
    act(() => {
      focused = next;
      for (const cb of listeners[next ? 'focus' : 'blur']) cb();
    });
  return { ...result, navigation, setFocused };
}
