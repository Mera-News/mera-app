// Status cards — surface coverage for the three non-article cards that render
// as ROWS in the Feed / Dashboard lists: NoGeneratedInterestsCard,
// FeedProcessingCard and OnboardingWaitingCard.
//
// FeedProcessingCard replaced FeedPreparingCard and deliberately KEPT its
// `feed-preparing-card` testID. That is not leftover debt: the simulator
// harness runbooks address this surface by that id, and the assertions below
// are about the card's SURFACE, which did not change hands.
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
// FeedProcessingCard is a CONTAINER: it subscribes to the processing snapshot,
// which reaches for-you-store and through it the WatermelonDB singleton at
// import time. This file tests the card's SURFACE, so the inside is stubbed and
// the outer box is left real. `ProcessingArea` has its own test.
jest.mock('@/components/custom/processing/ProcessingArea', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="processing-area" /> };
});
jest.mock('@/components/custom/processing/use-processing-snapshot', () => ({
  useProcessingSnapshot: () => ({
    visible: true,
    stage: 'analysing',
    stageIndex: 3,
    stageValue: 50,
    chunks: [],
    chunksReady: 0,
    chunksTotal: 0,
    hydrationCompleted: 0,
    hydrationTotal: 0,
    analysedDone: 0,
    analysedTotal: 0,
    isStatic: false,
    animationsActive: true,
  }),
  PROCESSING_TOTAL_STAGES: 6,
}));
jest.mock('@/lib/stores/selectors', () => ({
  useForYouDeviceProcessing: () => ({ isDeviceProcessing: false }),
}));
jest.mock('@/components/custom/cards/CardGlassPlate', () => {
  const { View } = require('react-native');
  return {
    CARDS_USE_GLASS: true,
    CardGlassPlate: () => <View testID="glass-plate" />,
    GLASS_CARD_EDGE: 'glass-edge',
  };
});
// IdleScene owns the only `react-native-reanimated` import on these surfaces,
// and jest.setup.js does not mock reanimated: importing it throws on the
// uninitialised worklets native module. Mocking the one component is the whole
// reason that import was centralised there rather than inlined in each card.
jest.mock('@/components/custom/IdleScene', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View {...p} /> };
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
import FeedProcessingCard from '../processing/FeedProcessingCard';
import NoGeneratedInterestsCard from '../NoGeneratedInterestsCard';
import OnboardingWaitingCard from '../for-you/OnboardingWaitingCard';

// FeedProcessingCard is deliberately NOT in this table any more. It no longer
// carries card chrome at all: see its own describe at the bottom of this file.
const CARDS: [string, React.FC, string][] = [
  ['NoGeneratedInterestsCard', NoGeneratedInterestsCard, 'no-interests-card'],
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

describe('FeedProcessingCard is flush with the page, not a card on it', () => {
  // It is the ONLY thing on screen while a run is in flight. An outlined plate
  // floating alone on an empty page reads as a card that failed to fill rather
  // than as the page working, so the border, radius, shadow and glass plate all
  // went. The other two cards in this file keep theirs: they sit in a list.
  const rootClass = () =>
    screen.getByTestId('feed-preparing-card').props.className as string;

  it('draws no border, no radius and no shadow', () => {
    render(<FeedProcessingCard />);
    expect(rootClass()).not.toContain('rounded-2xl');
    expect(rootClass()).not.toContain('shadow-hard-2');
    expect(rootClass()).not.toContain('border');
  });

  it('draws no glass plate, which exists to separate a card from its neighbours', () => {
    render(<FeedProcessingCard />);
    expect(screen.queryByTestId('glass-plate')).toBeNull();
  });

  it('keeps the row spacing, which is about the list rather than the look', () => {
    render(<FeedProcessingCard />);
    expect(rootClass()).toContain('mb-4');
  });

  it('keeps the testIDs the harness and the feed screens address it by', () => {
    render(<FeedProcessingCard />);
    expect(screen.getByTestId('feed-preparing-card')).toBeTruthy();
    expect(screen.getByTestId('feed-preparing-explore-cta')).toBeTruthy();
  });
});

// Owner: on the Feed, nothing animates unless the feed is updating. This card
// is a Feed row that can sit on screen indefinitely.
describe('NoGeneratedInterestsCard keeps its mark still', () => {
  it('renders the Mera mark without the torch sweep', () => {
    const { UNSAFE_root } = render(<NoGeneratedInterestsCard />);
    const logos = UNSAFE_root.findAll((n: any) => n.props?.size === 100 && 'animated' in (n.props ?? {}));
    expect(logos.length).toBeGreaterThan(0);
    for (const l of logos) expect(l.props.animated).toBe(false);
  });
});
