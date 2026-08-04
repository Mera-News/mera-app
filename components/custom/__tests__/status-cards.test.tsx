// Status cards — surface coverage for the three non-article cards that render
// as ROWS in the Feed / Dashboard lists: NoGeneratedInterestsCard,
// FeedPreparingCard and OnboardingWaitingCard.
//
// Why this file exists rather than a shared radius constant: the bug these
// assertions guard against was STRUCTURAL, not a mistyped literal. All three
// carried a comment saying they matched "AllCaughtUpCard and ArticleCardBase's
// NON-flat branch" — and that comment was the vector: the Feed's article cards
// actually render through the FLAT branch, so copying the other one produced
// rounded-md corners, no shadow, and a Gluestack `Card` whose own `p-4` stacked
// on top of the content's `px-6` (40px of horizontal padding where 24 was
// intended). A `CARD_RADIUS` constant would not have caught any of that. These
// assertions do, and they follow the pattern already set by
// `AllCaughtUpCard.test.tsx` — the radius is pinned against the token
// ArticleCardBase's flat branch uses, so the two surfaces cannot silently drift.
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
jest.mock('@/components/custom/chat/StreamingIndicator', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="streaming-indicator" /> };
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
import FeedPreparingCard from '../FeedPreparingCard';
import NoGeneratedInterestsCard from '../NoGeneratedInterestsCard';
import OnboardingWaitingCard from '../for-you/OnboardingWaitingCard';

const CARDS: [string, React.FC, string][] = [
  ['NoGeneratedInterestsCard', NoGeneratedInterestsCard, 'no-interests-card'],
  ['FeedPreparingCard', FeedPreparingCard, 'feed-preparing-card'],
  ['OnboardingWaitingCard', OnboardingWaitingCard, 'onboarding-waiting-card'],
];

describe.each(CARDS)('%s surface', (_name, Component, testID) => {
  const rootClass = () => screen.getByTestId(testID).props.className as string;

  it('uses the article cards rounded-2xl radius', () => {
    render(<Component />);
    expect(rootClass()).toContain('rounded-2xl');
  });

  it('never falls back to the old rounded-md panel radius', () => {
    render(<Component />);
    expect(rootClass()).not.toContain('rounded-md');
  });

  // The shadow has to sit on the OUTER box, which must NOT clip: RN drops a
  // view's shadow the moment that same view also sets `overflow: hidden`.
  it('puts the shadow on a non-clipping outer box', () => {
    render(<Component />);
    expect(rootClass()).toContain('shadow-hard-2');
    expect(rootClass()).not.toContain('overflow-hidden');
  });

  // NOT the article cards' spacing — those are `mb-3` (ArticleCardBase's flat
  // branch). `mb-4` is deliberate: all three of these are FULL-SCALE terminal
  // states that own the whole screen, the same case as non-compact
  // AllCaughtUpCard, which its own test pins at `mb-4` for the same reason.
  // Only AllCaughtUpCard's `compact` in-list rows drop to `mb-3`.
  it('uses the full-scale terminal-state row spacing (mb-4, not the mb-3 of in-list rows)', () => {
    render(<Component />);
    expect(rootClass()).toContain('mb-4');
  });

  // Regression guard for the "pays for padding twice" defect: the content is no
  // longer wrapped in a Gluestack `Card`, whose padding (`p-3`/`p-4`/`p-6` for
  // size sm/md/lg) stacks on top of the content's own `px-6`. The match covers
  // every Card size, not just the `md` that was actually here — the defect class
  // is "Card padding stacks on content padding", not one specific literal.
  // `@/components/ui/card` is deliberately NOT mocked, so a reintroduced Card
  // renders a real View carrying cardStyle()'s computed className.
  it('does not wrap its content in a padded Card', () => {
    render(<Component />);
    const padded = screen
      .UNSAFE_getAllByType(require('react-native').View)
      .filter(
        (n: any) =>
          typeof n.props.className === 'string' && /\bp-[3-6]\b/.test(n.props.className),
      );
    expect(padded).toHaveLength(0);
  });

  it('keeps the glass plate hanging off the unpadded clipping box', () => {
    render(<Component />);
    expect(screen.getByTestId('glass-plate')).toBeTruthy();
  });
});
