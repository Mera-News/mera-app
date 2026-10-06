/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
  const R = require('react/jsx-runtime');
  return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const R = require('react/jsx-dev-runtime');
  return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@/components/ui/icon', () => ({ CheckIcon: 'Check', Icon: () => null }));
jest.mock('@/components/ui/menu', () => {
  const { View, Pressable, Text } = require('react-native');
  return {
    // As gluestack: the trigger gets an onPress that opens; controlled via
    // isOpen/onOpen/onClose; the rest of the props reach the menu content.
    Menu: ({ isOpen, onOpen, onClose, trigger, children, useRNModal, placement, offset, closeOnSelect, ...rest }: any) => (
      <View testID="menu" {...{ useRNModal }}>
        {trigger({ onPress: onOpen })}
        {isOpen ? (
          <View testID="menu-content" {...rest}>
            {children}
          </View>
        ) : null}
      </View>
    ),
    MenuItem: ({ onPress, children, testID }: any) => (
      <Pressable testID={testID} onPress={onPress}>
        {children}
      </Pressable>
    ),
    MenuItemLabel: ({ children }: any) => <Text>{children}</Text>,
  };
});

import ExploreWindowToggle from '../ExploreWindowToggle';

describe('ExploreWindowToggle', () => {
  it('shows the current window and picks another from the menu', () => {
    const onChange = jest.fn();
    const r = render(<ExploreWindowToggle value={24} onChange={onChange} />);
    // The pill text is the hidden visual; the button carries the label.
    expect(r.getByText('explore.window.label24', { includeHiddenElements: true })).toBeTruthy();
    const button = r.getByTestId('explore-window-toggle');
    expect(button.props.accessibilityLabel).toBe('explore.window.menuLabel');
    expect(button.props.accessibilityValue).toEqual({ text: 'explore.window.a11y24' });

    fireEvent.press(button);
    expect(r.getByText('explore.window.option6')).toBeTruthy();
    expect(r.getByText('explore.window.option48')).toBeTruthy();
    fireEvent.press(r.getByTestId('explore-window-6'));
    expect(onChange).toHaveBeenCalledWith(6);
  });

  it('presents in a native modal and the VoiceOver escape gesture closes it', () => {
    const r = render(<ExploreWindowToggle value={12} onChange={jest.fn()} />);
    expect(r.getByTestId('menu').props.useRNModal).toBe(true);
    fireEvent.press(r.getByTestId('explore-window-toggle'));
    fireEvent(r.getByTestId('menu-content'), 'accessibilityEscape');
    expect(r.queryByTestId('menu-content')).toBeNull();
  });

  it('is ONE accessible element: the pill text is hidden from the accessibility tree', () => {
    const { queryByText } = render(<ExploreWindowToggle value={24} onChange={jest.fn()} />);
    expect(queryByText('explore.window.label24')).toBeNull();
  });
});
