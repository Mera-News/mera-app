/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
let mockFocused = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => mockFocused }));
jest.mock('@/components/ui/modal', () => {
  const { View } = require('react-native');
  const Pass = ({ children, testID }: any) => <View testID={testID}>{children}</View>;
  return {
    Modal: ({ children, isOpen }: any) => (isOpen ? <View>{children}</View> : null),
    ModalBackdrop: () => null,
    ModalBody: Pass,
    ModalContent: Pass,
    ModalFooter: Pass,
    ModalHeader: Pass,
  };
});
jest.mock('@/components/ui/button', () => {
  const { Pressable, Text } = require('react-native');
  return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/heading', () => {
  const { Text } = require('react-native');
  return { Heading: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import HowThisPageWorks from '../HowThisPageWorks';
import { PAGE_META } from '../page-registry';

describe('HowThisPageWorks', () => {
  beforeEach(() => {
    mockFocused = true;
  });

  it('opens the page explainer from the registry and closes it', () => {
    render(<HowThisPageWorks pageId="interests" />);
    expect(screen.queryByTestId('how-this-page-works-interests')).toBeNull();
    fireEvent.press(screen.getByTestId('how-this-page-works'));
    expect(screen.getByText(PAGE_META.interests.explainer!.titleKey)).toBeTruthy();
    for (const key of PAGE_META.interests.explainer!.paragraphKeys) expect(screen.getByText(key)).toBeTruthy();
    fireEvent.press(screen.getByTestId('how-this-page-works-close'));
    expect(screen.queryByTestId('how-this-page-works-interests')).toBeNull();
  });

  it('labels the button with its visible text', () => {
    render(<HowThisPageWorks pageId="feed" />);
    expect(screen.getByTestId('how-this-page-works').props.accessibilityLabel).toBe('nav.howThisPageWorks');
  });

  it('uses World copy for a country page', () => {
    render(<HowThisPageWorks pageId="country:DE" />);
    fireEvent.press(screen.getByTestId('how-this-page-works'));
    expect(screen.getByText('world.explainer.title')).toBeTruthy();
  });

  it('draws nothing on Settings', () => {
    render(<HowThisPageWorks pageId="settings" />);
    expect(screen.queryByTestId('how-this-page-works')).toBeNull();
  });

  it('closes when the screen loses focus', () => {
    const view = render(<HowThisPageWorks pageId="feed" />);
    fireEvent.press(screen.getByTestId('how-this-page-works'));
    mockFocused = false;
    view.rerender(<HowThisPageWorks pageId="feed" />);
    expect(screen.queryByTestId('how-this-page-works-feed')).toBeNull();
  });
});
