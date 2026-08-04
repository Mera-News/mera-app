// AllCaughtUpCard — surface + scale coverage.
//
// This card renders at FIVE call sites that split two ways: two rows inside the
// Feed list (the in-list divider and the end-of-list footer, both `compact`) and
// three terminal EMPTY STATES (Feed `renderEmpty`, FactFeedScreen, ForYouScreen)
// where the card IS the screen. The tests below pin that split, because getting
// it wrong is invisible in a unit run and obvious on a device: a compact empty
// state is a small card marooned in a blank screen.
//
// The corner radius is asserted directly against the token ArticleCardBase's
// FLAT branch uses (`rounded-2xl`) — that branch is what the Feed's article
// cards render through, and matching it is the whole point of the change. If
// ArticleCardBase ever moves off `rounded-2xl`, this fails and the two surfaces
// can't silently drift apart.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { returnObjects?: boolean }) => {
      const en = require('@/lib/locales/en.json');
      const v = key.split('.').reduce<any>((acc, part) => acc?.[part], en);
      if (opts?.returnObjects) return v;
      return typeof v === 'string' ? v : key;
    },
  }),
}));
jest.mock('expo-router', () => ({ router: { navigate: jest.fn() } }));
jest.mock('../MeraLogo', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID="mera-logo" {...p} /> };
});
jest.mock('@/components/custom/cards/CardGlassPlate', () => {
  const { View } = require('react-native');
  return {
    CARDS_USE_GLASS: true,
    CardGlassPlate: () => <View testID="glass-plate" />,
    GLASS_CARD_EDGE: 'glass-edge',
  };
});
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/button', () => {
  const { Pressable, Text } = require('react-native');
  return {
    Button: (p: any) => <Pressable {...p} />,
    ButtonText: (p: any) => <Text {...p} />,
  };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import AllCaughtUpCard from '../AllCaughtUpCard';
import en from '@/lib/locales/en.json';

const rootClass = () => screen.getByTestId('all-caught-up-card').props.className as string;

describe('AllCaughtUpCard', () => {
  it('renders the headline and the Explore CTA in both scales', () => {
    for (const compact of [false, true]) {
      const { unmount } = render(<AllCaughtUpCard compact={compact} />);
      expect(screen.getByText(en.feed.allCaughtUp)).toBeTruthy();
      expect(screen.getByTestId('all-caught-up-explore-cta')).toBeTruthy();
      unmount();
    }
  });

  // The user's explicit ask: "its corners should be rounded like the suggestion
  // cards". Radius is NOT variant-dependent — it reads correctly at both scales.
  it('uses the article cards rounded-2xl radius at BOTH scales', () => {
    render(<AllCaughtUpCard />);
    expect(rootClass()).toContain('rounded-2xl');
    screen.unmount();
    render(<AllCaughtUpCard compact />);
    expect(rootClass()).toContain('rounded-2xl');
  });

  it('never falls back to the old rounded-md panel radius', () => {
    render(<AllCaughtUpCard compact />);
    expect(rootClass()).not.toContain('rounded-md');
  });

  it('compact matches the article cards row spacing (mb-3), default keeps mb-4', () => {
    render(<AllCaughtUpCard compact />);
    expect(rootClass()).toContain('mb-3');
    screen.unmount();
    render(<AllCaughtUpCard />);
    expect(rootClass()).toContain('mb-4');
  });

  it('compact shrinks the logo and the vertical padding', () => {
    render(<AllCaughtUpCard compact />);
    const compactLogo = screen.getByTestId('mera-logo').props.size;
    screen.unmount();
    render(<AllCaughtUpCard />);
    const roomyLogo = screen.getByTestId('mera-logo').props.size;
    expect(compactLogo).toBeLessThan(roomyLogo);
  });

  it('renders the subtitle only when one is passed', () => {
    render(<AllCaughtUpCard compact />);
    expect(screen.queryByText(en.feed.divider.caughtUpSubtitle)).toBeNull();
    screen.unmount();
    render(<AllCaughtUpCard compact subtitle={en.feed.divider.caughtUpSubtitle} />);
    expect(screen.getByText(en.feed.divider.caughtUpSubtitle)).toBeTruthy();
  });

  // Long translations must WRAP, not clip — nothing here sets numberOfLines, and
  // the card is content-sized, so the worst-case strings simply make it taller.
  it('does not constrain any text to a fixed line count', () => {
    render(<AllCaughtUpCard compact subtitle={en.feed.divider.caughtUpSubtitle} />);
    for (const node of screen.UNSAFE_getAllByType(require('react-native').Text)) {
      expect(node.props.numberOfLines).toBeUndefined();
    }
  });

  it('keeps the glass plate hanging off the unpadded clipping box', () => {
    render(<AllCaughtUpCard compact />);
    expect(screen.getByTestId('glass-plate')).toBeTruthy();
  });
});
