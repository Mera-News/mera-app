// CardActionBar behavior tests — the small borderless Instagram-style action row.
// UI primitives + icons are stubbed to plain RN views (cards.test.tsx pattern);
// lucide icons render a View carrying their fill/color props so selected states
// are inspectable.
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
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@/components/custom/MeraLogo', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View {...p} /> };
});
jest.mock('lucide-react-native', () => {
  const { View } = require('react-native');
  return {
    ThumbsUp: (p: any) => <View testID="icon-thumbsup" fill={p.fill} color={p.color} />,
    ThumbsDown: (p: any) => <View testID="icon-thumbsdown" fill={p.fill} color={p.color} />,
    Bookmark: (p: any) => <View testID="icon-bookmark" fill={p.fill} color={p.color} />,
    Share2: (p: any) => <View testID="icon-share" fill={p.fill} color={p.color} />,
  };
});

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import CardActionBar from '../CardActionBar';

function setup(overrides: Partial<React.ComponentProps<typeof CardActionBar>> = {}) {
  const onLike = jest.fn();
  const onDislike = jest.fn();
  const onAskMera = jest.fn();
  const onToggleSave = jest.fn();
  const onShare = jest.fn();
  const utils = render(
    <CardActionBar
      verdict={overrides.verdict ?? null}
      saved={overrides.saved ?? false}
      onLike={onLike}
      onDislike={onDislike}
      onAskMera={onAskMera}
      onToggleSave={onToggleSave}
      onShare={'onShare' in overrides ? overrides.onShare : onShare}
      horizontalPadding={overrides.horizontalPadding}
    />,
  );
  return { ...utils, onLike, onDislike, onAskMera, onToggleSave, onShare };
}

describe('CardActionBar', () => {
  it('fires each handler on tap', () => {
    const { getByLabelText, onLike, onDislike, onAskMera, onToggleSave } = setup();
    fireEvent.press(getByLabelText('articleFeedback.likeLabel'));
    fireEvent.press(getByLabelText('articleFeedback.dislikeLabel'));
    fireEvent.press(getByLabelText('swipeFeed.askMera'));
    fireEvent.press(getByLabelText('savedSuggestions.savedToastTitle'));
    expect(onLike).toHaveBeenCalledTimes(1);
    expect(onDislike).toHaveBeenCalledTimes(1);
    expect(onAskMera).toHaveBeenCalledTimes(1);
    expect(onToggleSave).toHaveBeenCalledTimes(1);
  });

  it('renders unselected icons hollow (fill none, white)', () => {
    const { getByTestId } = setup();
    expect(getByTestId('icon-thumbsup').props.fill).toBe('none');
    expect(getByTestId('icon-thumbsup').props.color).toBe('#FFFFFF');
    expect(getByTestId('icon-bookmark').props.fill).toBe('none');
  });

  it('fills the thumb-up green when the verdict is like', () => {
    const { getByTestId } = setup({ verdict: 'like' });
    expect(getByTestId('icon-thumbsup').props.fill).toBe('#22C55E');
    expect(getByTestId('icon-thumbsdown').props.fill).toBe('none');
  });

  it('fills the thumb-down red when the verdict is dislike', () => {
    const { getByTestId } = setup({ verdict: 'dislike' });
    expect(getByTestId('icon-thumbsdown').props.fill).toBe('#EF4444');
    expect(getByTestId('icon-thumbsup').props.fill).toBe('none');
  });

  it('fills the bookmark accent when saved', () => {
    const { getByTestId } = setup({ saved: true });
    expect(getByTestId('icon-bookmark').props.fill).toBe('rgb(231,138,83)');
  });

  it('renders the share icon and fires onShare when a share handler is provided', () => {
    const { getByLabelText, getByTestId, onShare } = setup();
    expect(getByTestId('icon-share')).toBeTruthy();
    fireEvent.press(getByLabelText('articleDetail.share'));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('hides the share icon when no share handler is provided', () => {
    const { queryByTestId, queryByLabelText } = setup({ onShare: undefined });
    expect(queryByTestId('icon-share')).toBeNull();
    expect(queryByLabelText('articleDetail.share')).toBeNull();
  });
});
