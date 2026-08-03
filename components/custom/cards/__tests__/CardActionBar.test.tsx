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
    Crosshair: (p: any) => <View testID="icon-crosshair" fill={p.fill} color={p.color} />,
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
  const onTrack = jest.fn();
  const utils = render(
    <CardActionBar
      verdict={overrides.verdict ?? null}
      provisional={overrides.provisional}
      saved={overrides.saved ?? false}
      onLike={onLike}
      onDislike={onDislike}
      onAskMera={onAskMera}
      onToggleSave={'onToggleSave' in overrides ? overrides.onToggleSave : onToggleSave}
      // Defaults to ABSENT — the feed card's shape. Only the detail screens and
      // the standalone card pass a track handler.
      onTrack={'onTrack' in overrides ? overrides.onTrack : undefined}
      tracked={overrides.tracked}
      onShare={'onShare' in overrides ? overrides.onShare : onShare}
      horizontalPadding={overrides.horizontalPadding}
    />,
  );
  return { ...utils, onLike, onDislike, onAskMera, onToggleSave, onShare, onTrack };
}

describe('CardActionBar', () => {
  it('fires each handler on tap', () => {
    const { getByLabelText, onLike, onDislike, onAskMera, onToggleSave } = setup();
    fireEvent.press(getByLabelText('articleFeedback.likeLabel'));
    fireEvent.press(getByLabelText('articleFeedback.dislikeLabel'));
    fireEvent.press(getByLabelText('swipeFeed.askMera'));
    fireEvent.press(getByLabelText('savedSuggestions.saveAction'));
    expect(onLike).toHaveBeenCalledTimes(1);
    expect(onDislike).toHaveBeenCalledTimes(1);
    expect(onAskMera).toHaveBeenCalledTimes(1);
    expect(onToggleSave).toHaveBeenCalledTimes(1);
  });

  // Q21: the Mera button is BACK in this row, for view consistency with
  // standalone cards (ArticleActionsRow always kept its own). It is the
  // canonical affordance and owns `card-action-mera`; the rationale block's
  // glyph is `rationale-mera` and calls the same handler.
  it('renders the Mera button as the canonical card-action-mera affordance', () => {
    const { getByTestId, onAskMera } = setup();
    fireEvent.press(getByTestId('card-action-mera'));
    expect(onAskMera).toHaveBeenCalledTimes(1);
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

  // D15/F3, and the whole reason the detail screens adopted this row rather
  // than being restyled in place. Their old treatment carried these three
  // states in the button's BACKGROUND (orange fill = committed, 18% tint =
  // provisional, transparent = none), so deleting the circle — the actual ask —
  // would have collapsed provisional into committed. Here COLOUR says "the
  // verdict is recorded" and FILL says "a reason backs it", which survives
  // having no background at all. Pin both halves so a future tidy-up of the
  // fill logic cannot silently re-merge the two states.
  it('shows a provisional like coloured but HOLLOW, and a committed one filled', () => {
    const provisional = setup({ verdict: 'like', provisional: true });
    expect(provisional.getByTestId('icon-thumbsup').props.color).toBe('#22C55E');
    expect(provisional.getByTestId('icon-thumbsup').props.fill).toBe('none');

    const committed = setup({ verdict: 'like', provisional: false });
    expect(committed.getByTestId('icon-thumbsup').props.color).toBe('#22C55E');
    expect(committed.getByTestId('icon-thumbsup').props.fill).toBe('#22C55E');
  });

  it('shows a provisional dislike coloured but HOLLOW, and a committed one filled', () => {
    const provisional = setup({ verdict: 'dislike', provisional: true });
    expect(provisional.getByTestId('icon-thumbsdown').props.color).toBe('#EF4444');
    expect(provisional.getByTestId('icon-thumbsdown').props.fill).toBe('none');

    const committed = setup({ verdict: 'dislike', provisional: false });
    expect(committed.getByTestId('icon-thumbsdown').props.color).toBe('#EF4444');
    expect(committed.getByTestId('icon-thumbsdown').props.fill).toBe('#EF4444');
  });

  // Item F1-1: the label was the constant "Saved" on every card, so a screen
  // reader could not tell saved from unsaved and it lied on unsaved cards.
  it('labels the bookmark by STATE: Save when unsaved, Remove when saved', () => {
    const unsaved = setup({ saved: false });
    expect(unsaved.queryByLabelText('savedSuggestions.saveAction')).toBeTruthy();
    expect(unsaved.queryByLabelText('savedSuggestions.removeAction')).toBeNull();

    const saved = setup({ saved: true });
    expect(saved.queryByLabelText('savedSuggestions.removeAction')).toBeTruthy();
    expect(saved.queryByLabelText('savedSuggestions.saveAction')).toBeNull();
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

  // The track button exists for the detail screens and the standalone card,
  // which had it before they adopted this row. Feed cards pass no handler and
  // must keep showing nothing — the affordance is deliberately absent there.
  it('hides the track icon by default (the feed card shape)', () => {
    const { queryByTestId, queryByLabelText } = setup();
    expect(queryByTestId('card-action-track')).toBeNull();
    expect(queryByTestId('icon-crosshair')).toBeNull();
    expect(queryByLabelText('trackedStories.trackAction')).toBeNull();
  });

  it('renders the track icon and fires onTrack when a track handler is provided', () => {
    const onTrack = jest.fn();
    const { getByTestId } = setup({ onTrack });
    expect(getByTestId('icon-crosshair')).toBeTruthy();
    fireEvent.press(getByTestId('card-action-track'));
    expect(onTrack).toHaveBeenCalledTimes(1);
  });

  it('labels the track button by STATE and accents it when tracked', () => {
    const untracked = setup({ onTrack: jest.fn(), tracked: false });
    expect(untracked.queryByLabelText('trackedStories.trackAction')).toBeTruthy();
    expect(untracked.getByTestId('icon-crosshair').props.color).toBe('#FFFFFF');

    const tracked = setup({ onTrack: jest.fn(), tracked: true });
    expect(tracked.queryByLabelText('trackedStories.untrackAction')).toBeTruthy();
    expect(tracked.getByTestId('icon-crosshair').props.color).toBe('rgb(231,138,83)');
  });

  // The detail screens' `save` prop is optional, so the bookmark has to be able
  // to disappear rather than render a toggle that toggles nothing.
  it('hides the bookmark when no save handler is provided', () => {
    const { queryByTestId, queryByLabelText } = setup({ onToggleSave: undefined });
    expect(queryByTestId('icon-bookmark')).toBeNull();
    expect(queryByLabelText('savedSuggestions.saveAction')).toBeNull();
  });
});
