/* eslint-disable @typescript-eslint/no-require-imports */
// M23: the sheet's only action was a full-width orange "Close" styled as the
// primary action. It is a neutral outline now.
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/modal', () => {
  const { View } = require('react-native');
  const Pass = ({ children }: any) => <View>{children}</View>;
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
  return {
    Button: (p: any) => <Pressable {...p} />,
    ButtonText: (p: any) => <Text {...p} />,
  };
});
jest.mock('@/components/ui/heading', () => {
  const { Text } = require('react-native');
  return { Heading: (p: any) => <Text {...p} /> };
});
jest.mock('../FeedStatusDetails', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="feed-status-details" /> };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import FeedStatusSheet from '../FeedStatusSheet';

describe('FeedStatusSheet close action', () => {
  it('is an outline button, not the primary accent', () => {
    render(<FeedStatusSheet isOpen onClose={jest.fn()} lastProcessedLabel={null} />);
    const button = screen.getByTestId('feed-status-sheet-close');
    expect(button.props.variant).toBe('outline');
    expect(String(button.props.className)).not.toMatch(/bg-primary/);
  });
});
