// AllCaughtUpCard — the end-of-list "you're all caught up" card.
//
// Used at SIX call sites: the Feed's end-of-list footer, and the empty state of
// the Feed, FactFeedScreen, and ForYouScreen. There used to be two MORE
// instances of this component, spliced in-list at each Feed attention-tier
// boundary (`variant="seen"` / `"read"`), each with its own headline and
// instruction line. The user reported their position wasn't reliable, so both
// were removed — this file used to pin their per-variant copy; that coverage is
// gone along with the feature, not weakened.
//
// What's left: the surface/scale contract (unchanged), and the CTA, which is
// now CONDITIONAL — "Browse Explore" by default, or "Want to read more? Lower
// the feed priority" when the caller passes both `feedThreshold` (above its
// floor) and `onLowerPriority`.
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

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { router } from 'expo-router';
import AllCaughtUpCard from '../AllCaughtUpCard';
import en from '@/lib/locales/en.json';

const rootClass = () => screen.getByTestId('all-caught-up-card').props.className as string;

describe('AllCaughtUpCard', () => {
  it('renders the headline and the Explore CTA by default, in both scales', () => {
    for (const compact of [false, true]) {
      const { unmount } = render(<AllCaughtUpCard compact={compact} />);
      expect(screen.getByText(en.feed.allCaughtUp)).toBeTruthy();
      expect(screen.getByTestId('all-caught-up-explore-cta')).toBeTruthy();
      expect(screen.queryByTestId('all-caught-up-lower-priority-cta')).toBeNull();
      unmount();
    }
  });

  it('tapping the Explore CTA navigates to Explore', () => {
    render(<AllCaughtUpCard />);
    fireEvent.press(screen.getByTestId('all-caught-up-explore-cta'));
    expect(router.navigate).toHaveBeenCalledWith('/logged-in/app_container/around');
  });

  // The user's explicit ask: "its corners should be rounded like the suggestion
  // cards". Radius is checked at both scales.
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

  // ── The conditional CTA (r14 #9) ──
  //
  // "if the user has chosen a priority higher than low in the feed header,
  // instead of the browse explore button write 'Want to read more? Lower the
  // feed priority'". `feedThreshold` and `onLowerPriority` are opt-in props —
  // only FeedScreen passes them; FactFeedScreen and ForYouScreen's empty
  // states (and the Feed's own loading/error states) pass neither and must
  // keep today's Explore-only behavior untouched.
  describe('the lower-priority CTA', () => {
    it('shows the Explore CTA when no props are passed (the other three call sites)', () => {
      render(<AllCaughtUpCard compact />);
      expect(screen.getByTestId('all-caught-up-explore-cta')).toBeTruthy();
      expect(screen.queryByTestId('all-caught-up-lower-priority-cta')).toBeNull();
    });

    it('shows the Explore CTA at threshold "low" even with a handler — nothing to lower', () => {
      const onLowerPriority = jest.fn();
      render(<AllCaughtUpCard compact feedThreshold="low" onLowerPriority={onLowerPriority} />);
      expect(screen.getByTestId('all-caught-up-explore-cta')).toBeTruthy();
      expect(screen.queryByTestId('all-caught-up-lower-priority-cta')).toBeNull();
    });

    it('shows the lower-priority CTA at threshold "medium"', () => {
      const onLowerPriority = jest.fn();
      render(<AllCaughtUpCard compact feedThreshold="medium" onLowerPriority={onLowerPriority} />);
      expect(screen.getByText(en.feed.lowerPriorityCta)).toBeTruthy();
      expect(screen.getByTestId('all-caught-up-lower-priority-cta')).toBeTruthy();
      expect(screen.queryByTestId('all-caught-up-explore-cta')).toBeNull();
    });

    it('shows the lower-priority CTA at threshold "high"', () => {
      const onLowerPriority = jest.fn();
      render(<AllCaughtUpCard compact feedThreshold="high" onLowerPriority={onLowerPriority} />);
      expect(screen.getByText(en.feed.lowerPriorityCta)).toBeTruthy();
      expect(screen.queryByTestId('all-caught-up-explore-cta')).toBeNull();
    });

    it('falls back to Explore when feedThreshold is passed without a handler', () => {
      render(<AllCaughtUpCard compact feedThreshold="high" />);
      expect(screen.getByTestId('all-caught-up-explore-cta')).toBeTruthy();
      expect(screen.queryByTestId('all-caught-up-lower-priority-cta')).toBeNull();
    });

    it('tapping the lower-priority CTA calls the handler', () => {
      const onLowerPriority = jest.fn();
      render(<AllCaughtUpCard compact feedThreshold="medium" onLowerPriority={onLowerPriority} />);
      fireEvent.press(screen.getByTestId('all-caught-up-lower-priority-cta'));
      expect(onLowerPriority).toHaveBeenCalledTimes(1);
    });
  });

  // Long translations must WRAP, not clip — nothing here sets numberOfLines, and
  // the card is content-sized, so the worst-case strings simply make it taller.
  it('does not constrain any text to a fixed line count', () => {
    render(<AllCaughtUpCard compact />);
    for (const node of screen.UNSAFE_getAllByType(require('react-native').Text)) {
      expect(node.props.numberOfLines).toBeUndefined();
    }
  });

  it('keeps the glass plate hanging off the unpadded clipping box', () => {
    render(<AllCaughtUpCard compact />);
    expect(screen.getByTestId('glass-plate')).toBeTruthy();
  });

  it('keeps the mindfulness cycling line at its original recede-from-headline styling', () => {
    const messages = require('@/lib/locales/en.json').feed.mindfulness as string[];
    const { getByText } = render(<AllCaughtUpCard />);
    const msg = getByText(messages[0]);
    expect(String(msg.props.className ?? '')).toContain('text-gray-400');
  });
});
