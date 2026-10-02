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

import ExploreWindowToggle from '../ExploreWindowToggle';

describe('ExploreWindowToggle', () => {
  it('shows the current window and switches 24h -> 48h', () => {
    const onChange = jest.fn();
    const { getByTestId, getByText } = render(
      <ExploreWindowToggle value={24} onChange={onChange} />,
    );
    // The pill text is the hidden visual; the button carries the label.
    expect(getByText('explore.window.label24', { includeHiddenElements: true })).toBeTruthy();
    const button = getByTestId('explore-window-toggle');
    expect(button.props.accessibilityLabel).toBe('explore.window.a11y24');
    expect(button.props.accessibilityHint).toBe('explore.window.hint24');
    fireEvent.press(button);
    expect(onChange).toHaveBeenCalledWith(48);
  });

  it('switches 48h -> 24h', () => {
    const onChange = jest.fn();
    const { getByTestId, getByText } = render(
      <ExploreWindowToggle value={48} onChange={onChange} />,
    );
    expect(getByText('explore.window.label48', { includeHiddenElements: true })).toBeTruthy();
    expect(getByTestId('explore-window-toggle').props.accessibilityLabel).toBe(
      'explore.window.a11y48',
    );
    fireEvent.press(getByTestId('explore-window-toggle'));
    expect(onChange).toHaveBeenCalledWith(24);
  });

  it('is ONE accessible element: the pill text is hidden from the accessibility tree', () => {
    const { queryByText } = render(<ExploreWindowToggle value={24} onChange={jest.fn()} />);
    expect(queryByText('explore.window.label24')).toBeNull();
  });
});
