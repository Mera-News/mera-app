// VerdictBar behavior tests — the PRIMARY (buttons-first) interaction. UI
// primitives are stubbed to plain RN views (same pattern as cards.test.tsx) so
// the pills render under jest-expo without the native UI kit.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
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
jest.mock('@/components/custom/MeraLogo', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View {...p} /> };
});

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import VerdictBar from '../VerdictBar';

function setup(overrides: Partial<React.ComponentProps<typeof VerdictBar>> = {}) {
  const onVerdict = jest.fn();
  const onVerdictChanged = jest.fn();
  const onReopenTree = jest.fn();
  const onAskMera = jest.fn();
  const utils = render(
    <VerdictBar
      verdict={overrides.verdict ?? null}
      onVerdict={onVerdict}
      onVerdictChanged={onVerdictChanged}
      onReopenTree={onReopenTree}
      onAskMera={onAskMera}
    />,
  );
  return { ...utils, onVerdict, onVerdictChanged, onReopenTree, onAskMera };
}

describe('VerdictBar', () => {
  it('records a fresh verdict on an undecided card (thumb-up)', () => {
    const { getByLabelText, onVerdict, onVerdictChanged } = setup({ verdict: null });
    fireEvent.press(getByLabelText('swipeFeed.moreLikeThis'));
    expect(onVerdict).toHaveBeenCalledWith('like');
    expect(onVerdictChanged).not.toHaveBeenCalled();
  });

  it('flips the verdict when the OTHER thumb is tapped on a decided card', () => {
    const { getByLabelText, onVerdict, onVerdictChanged } = setup({ verdict: 'like' });
    fireEvent.press(getByLabelText('swipeFeed.lessLikeThis'));
    expect(onVerdictChanged).toHaveBeenCalledWith('like', 'dislike');
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it('re-opens the tree (no re-record) when the already-selected thumb is tapped', () => {
    const { getByLabelText, onVerdict, onVerdictChanged, onReopenTree } = setup({
      verdict: 'like',
    });
    fireEvent.press(getByLabelText('swipeFeed.moreLikeThis'));
    expect(onVerdict).not.toHaveBeenCalled();
    expect(onVerdictChanged).not.toHaveBeenCalled();
    expect(onReopenTree).toHaveBeenCalled();
  });

  it('invokes Ask Mera', () => {
    const { getByLabelText, onAskMera } = setup();
    fireEvent.press(getByLabelText('swipeFeed.askMera'));
    expect(onAskMera).toHaveBeenCalled();
  });
});
