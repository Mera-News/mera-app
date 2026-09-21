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
// unconditionally "Browse Explore". It was briefly conditional, forking to
// "Want to read more? Lower the feed priority" when the Feed's importance
// filter was hiding stories; that filter is gone and so is the fork.
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

// The roomy branch draws a Lottie idle scene, which brings in two gates that
// the compact branch never needed.
//
// `jest.setup.js` does NOT mock react-native-reanimated: importing it throws on
// the uninitialised worklets native module, and the error points at the import
// line rather than at the cause. Hooks run unconditionally, so without this
// mock EVERY spec in this file dies, compact-only ones included.
// `lottie-react-native` IS mocked globally in jest.setup.js, so only one of the
// two needs handling here.
let mockReduceMotion = false;
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  useReducedMotion: () => mockReduceMotion,
}));

let mockStaticGradient = false;
jest.mock('@/lib/stores/display-prefs-store', () => ({
  useDisplayPrefsStore: (sel: (s: { staticGradient: boolean }) => unknown) =>
    sel({ staticGradient: mockStaticGradient }),
}));

let mockAnimationsActive = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({
  useAnimationsActive: () => mockAnimationsActive,
}));

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
import { PROCESSING_SCENE_SIZE } from '@/components/custom/processing/types';
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

  // ── The two scene branches ──
  //
  // The roomy branch draws the `game-hud-idle` Lottie loop; the compact branch
  // keeps the Mera mark. The split is the point, not an implementation detail:
  // compact is the Feed's end-of-list footer, so a loop there would run at the
  // bottom of every feed forever for no reader.
  describe('the scene', () => {
    beforeEach(() => {
      mockReduceMotion = false;
      mockStaticGradient = false;
      mockAnimationsActive = true;
    });

    it('draws the idle Lottie scene on the roomy branch and no Mera mark', () => {
      render(<AllCaughtUpCard />);
      expect(screen.getByTestId('all-caught-up-idle-scene')).toBeTruthy();
      expect(screen.queryByTestId('mera-logo')).toBeNull();
    });

    it('keeps the Mera mark at 64 on the compact branch and draws no idle scene', () => {
      render(<AllCaughtUpCard compact />);
      expect(screen.getByTestId('mera-logo').props.size).toBe(64);
      expect(screen.queryByTestId('all-caught-up-idle-scene')).toBeNull();
    });

    // The orphan gate guards registry -> disk. This guards CONSUMER -> registry,
    // which nothing else does: `gameAnimationFor` returns undefined for an id
    // the map does not hold, `source={undefined}` renders nothing, and both tsc
    // and the gate stay green while the card draws an empty box. It also pins
    // which node the specs below are reading, so an assertion cannot pass by
    // landing on a node that simply has no such prop.
    it('resolves a real asset for the idle scene', () => {
      render(<AllCaughtUpCard />);
      const lottie = screen.getByTestId('all-caught-up-idle-scene').children[0] as any;
      expect(lottie.props.source).toBeTruthy();
    });

    // It has to sit at the SAME size as FeedProcessingCard's stage scene. The
    // two cards swap when a sync starts and never render at once, so a
    // different number here makes the scene jump at that moment, which reads
    // as the card breaking rather than as work beginning.
    it('sizes the scene box to the processing card stage scene', () => {
      render(<AllCaughtUpCard />);
      expect(screen.getByTestId('all-caught-up-idle-scene').props.style).toMatchObject({
        width: PROCESSING_SCENE_SIZE,
        height: PROCESSING_SCENE_SIZE,
      });
    });

    // Never an empty box. `staticGradient` defaults ON below 6 GB of RAM, so a
    // held frame 0 is the normal rendering on a large share of the fleet, not a
    // rare degradation - and `game-hud-idle` is authored so frame 0 is the
    // whole composition at rest.
    it.each([
      ['Reduce Motion', () => { mockReduceMotion = true; }],
      ['the static-background preference', () => { mockStaticGradient = true; }],
      ['a blurred or backgrounded screen', () => { mockAnimationsActive = false; }],
    ])('holds frame 0 rather than playing, under %s', (_label, arrange) => {
      arrange();
      render(<AllCaughtUpCard />);
      const lottie = screen.getByTestId('all-caught-up-idle-scene').children[0] as any;
      expect(lottie.props.autoPlay).toBe(false);
      expect(lottie.props.progress).toBe(0);
    });

    it('plays when motion is allowed and someone is looking', () => {
      render(<AllCaughtUpCard />);
      const lottie = screen.getByTestId('all-caught-up-idle-scene').children[0] as any;
      expect(lottie.props.autoPlay).toBe(true);
      expect(lottie.props.progress).toBeUndefined();
    });
  });

  // ── The CTA ──
  //
  // There used to be a second CTA here, "Want to read more? Lower the feed
  // priority", shown when the Feed's importance dial was above its floor. The
  // dial is gone — every scored story down to the LOW band renders — so the
  // Explore CTA is unconditional at every call site. These tests exist to keep
  // it that way: a reappearing fork would mean a control came back with it.
  describe('the CTA', () => {
    it('shows the Explore CTA, compact', () => {
      render(<AllCaughtUpCard compact />);
      expect(screen.getByTestId('all-caught-up-explore-cta')).toBeTruthy();
      expect(screen.getByText(en.feed.exploreCta)).toBeTruthy();
    });

    it('shows the Explore CTA, roomy', () => {
      render(<AllCaughtUpCard />);
      expect(screen.getByTestId('all-caught-up-explore-cta')).toBeTruthy();
    });

    it('renders the Explore CTA once and no second CTA beside it', () => {
      render(<AllCaughtUpCard compact />);
      expect(screen.getAllByTestId('all-caught-up-explore-cta')).toHaveLength(1);
      expect(screen.queryByTestId('all-caught-up-lower-priority-cta')).toBeNull();
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
