import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { useThemeStore } from '@/lib/theme/theme-store';
import { COLORS } from '@/lib/theme/tokens';

import { MessageContent } from '../index';

const flat = (id: string, ui: React.ReactElement) => {
  const { getByTestId } = render(ui);
  return StyleSheet.flatten(getByTestId(id).props.style);
};

afterEach(() => useThemeStore.setState({ mode: 'dark' }));

describe('chat bubble surfaces', () => {
  it('light: Mera is the white card surface with a hairline; the user stays tinted', () => {
    useThemeStore.setState({ mode: 'light' });
    const mera = flat(
      'a',
      <MessageContent role="assistant" testID="a">
        x
      </MessageContent>,
    );
    expect(mera.backgroundColor).toBe(COLORS.light.panel);
    expect(mera.borderColor).toBe(COLORS.light.panelBorder);
    const user = flat(
      'u',
      <MessageContent role="user" testID="u">
        x
      </MessageContent>,
    );
    expect(user.backgroundColor).not.toBe(mera.backgroundColor);
  });

  it('dark: Mera keeps the raised tint and no border', () => {
    useThemeStore.setState({ mode: 'dark' });
    const mera = flat(
      'a',
      <MessageContent role="assistant" testID="a">
        x
      </MessageContent>,
    );
    expect(mera.backgroundColor).toBe(COLORS.dark.surfaceRaised);
    expect(mera.borderWidth).toBeUndefined();
  });
});
