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

describe('send disc', () => {
  it('disabled is neutral grey in both themes, enabled is the accent, Stop stays accent', () => {
    const { PromptInput } = require('../index');
    const { render } = require('@testing-library/react-native');
    const { Keyboard } = require('react-native');
    jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation((() => ({ remove: jest.fn() })) as never);
    for (const mode of ['dark', 'light'] as const) {
      useThemeStore.setState({ mode });
      const idle = render(<PromptInput onSubmit={() => {}} />);
      const disc = idle.getByTestId('chat-send-disc', { includeHiddenElements: true });
      const style = StyleSheet.flatten(disc.props.style);
      expect(style.backgroundColor).toBe(COLORS[mode].surfaceRaised);
      expect(style.opacity).toBeUndefined();
      idle.unmount();
      const stop = render(<PromptInput onSubmit={() => {}} busy onStop={() => {}} />);
      const stopDisc = stop.getByTestId('chat-send-disc', { includeHiddenElements: true });
      expect(StyleSheet.flatten(stopDisc.props.style).backgroundColor).not.toBe(
        COLORS[mode].surfaceRaised,
      );
      stop.unmount();
    }
  });
});
