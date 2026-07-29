// F2 — the caption's lifetime.
//
// The caption promises that a context-less thumb is DISCARDED. It used to be
// keyed off `initialPathIds.length`, so opening a branch retracted it — the app
// stopped explaining itself at the exact moment the promise was still in force
// and the user had committed nothing. It is now keyed off `committed`.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/scroll-view', () => {
  const { View } = require('react-native');
  return { ScrollView: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});
// The tree itself is exercised by its own suites; here it is inert.
jest.mock('@/components/custom/feed/InlineFeedbackTree', () => {
  const { View } = require('react-native');
  return { InlineFeedbackTree: () => <View testID="inline-tree" /> };
});

import { render } from '@testing-library/react-native';
import React from 'react';
import CardFeedbackSurface from '../CardFeedbackSurface';

const suggestion = { _id: 's1', articleId: 'a1', title_en: 'T' } as any;

function setup(props: Partial<React.ComponentProps<typeof CardFeedbackSurface>> = {}) {
  return render(
    <CardFeedbackSurface
      suggestion={suggestion}
      verdict="dislike"
      onClose={jest.fn()}
      onTreePathChanged={jest.fn()}
      onInvokeMera={jest.fn()}
      onLeafCommitted={jest.fn()}
      {...props}
    />,
  );
}

describe('CardFeedbackSurface — the discard caption', () => {
  it('shows on a bare verdict', () => {
    expect(setup().queryByTestId('feedback-caption')).toBeTruthy();
  });

  it('STAYS while the user is only navigating a branch (F2)', () => {
    const { queryByTestId } = setup({ initialPathIds: ['not_important_to_me'] });
    expect(queryByTestId('feedback-caption')).toBeTruthy();
  });

  it('goes once a leaf has committed', () => {
    const { queryByTestId } = setup({
      initialPathIds: ['not_important_to_me', 'not_important'],
      committed: true,
    });
    expect(queryByTestId('feedback-caption')).toBeNull();
  });
});
