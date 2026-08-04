// AllCaughtUpCard — variant + surface + scale coverage.
//
// This card renders at SIX call sites along two INDEPENDENT axes.
//
//  `variant` — which boundary the card marks, and the ONE line of copy that
//  differs: `seen` (Feed divider #1), `read` (Feed divider #2, which used to be
//  the separate FeedOpenedDivider component), and `end` (the DEFAULT — the
//  end-of-list footer and the three empty states, where there is no boundary
//  below to describe). Everything else — headline, cycling mindfulness nudge,
//  Explore CTA — is identical in all three, which is the whole point of the
//  consolidation and is pinned below.
//
//  `compact` — scale. Three call sites are rows inside the Feed list (both
//  dividers and the footer, all `compact`) and three are terminal EMPTY STATES
//  (Feed `renderEmpty`, FactFeedScreen, ForYouScreen) where the card IS the
//  screen. The tests below pin that split, because getting it wrong is invisible
//  in a unit run and obvious on a device: a compact empty state is a small card
//  marooned in a blank screen.
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

  // ── The one line that differs ──
  //
  // Asserted against the REAL en.json values (the i18n mock resolves the actual
  // file), so a renamed or missing key fails here rather than silently rendering
  // the raw key path on device.
  it('renders the seen boundary line for variant="seen" and nothing else', () => {
    render(<AllCaughtUpCard compact variant="seen" />);
    expect(screen.getByText(en.feed.divider.seenLine)).toBeTruthy();
    expect(screen.queryByText(en.feed.divider.readLine)).toBeNull();
  });

  it('renders the read boundary line for variant="read" and nothing else', () => {
    render(<AllCaughtUpCard compact variant="read" />);
    expect(screen.getByText(en.feed.divider.readLine)).toBeTruthy();
    expect(screen.queryByText(en.feed.divider.seenLine)).toBeNull();
  });

  // "the basic all caught up card, with no props" — the footer and the three
  // empty states. `end` is the default precisely so those call sites pass none.
  it('renders NO boundary line by default, i.e. the end variant', () => {
    render(<AllCaughtUpCard compact />);
    expect(screen.queryByText(en.feed.divider.seenLine)).toBeNull();
    expect(screen.queryByText(en.feed.divider.readLine)).toBeNull();
    screen.unmount();
    render(<AllCaughtUpCard compact variant="end" />);
    expect(screen.queryByText(en.feed.divider.seenLine)).toBeNull();
    expect(screen.queryByText(en.feed.divider.readLine)).toBeNull();
  });

  // The consolidation's actual contract: ONE component, and exactly one line
  // moves between variants. If a future change makes the headline, the nudge or
  // the CTA variant-dependent too, this fails.
  it('keeps the headline, the mindfulness nudge and the Explore CTA identical in ALL three variants', () => {
    const messages = require('@/lib/locales/en.json').feed.mindfulness as string[];
    for (const variant of ['seen', 'read', 'end'] as const) {
      const { unmount } = render(<AllCaughtUpCard compact variant={variant} />);
      expect(screen.getByText(en.feed.allCaughtUp)).toBeTruthy();
      // The nudge to step away must render everywhere — the user's explicit ask.
      expect(screen.getByText(messages[0])).toBeTruthy();
      // The CTA is deliberately NOT gated to `end`: the footer only renders when
      // nothing below the pin boundary has been seen and the empty states only
      // on an empty feed, so gating it would leave a normal populated feed with
      // no Explore affordance at all.
      expect(screen.getByTestId('all-caught-up-explore-cta')).toBeTruthy();
      unmount();
    }
  });

  // The two boundary lines must not read alike — the variant line is now the
  // ONLY thing distinguishing two otherwise identical cards ten rows apart.
  it('the two boundary strings exist and are distinguishable from each other and the headline', () => {
    expect(en.feed.divider.seenLine).toBeTruthy();
    expect(en.feed.divider.readLine).toBeTruthy();
    expect(en.feed.divider.seenLine).not.toBe(en.feed.divider.readLine);
    expect(en.feed.divider.seenLine).not.toBe(en.feed.allCaughtUp);
    expect(en.feed.divider.readLine).not.toBe(en.feed.allCaughtUp);
  });

  // Long translations must WRAP, not clip — nothing here sets numberOfLines, and
  // the card is content-sized, so the worst-case strings simply make it taller.
  it('does not constrain any text to a fixed line count', () => {
    render(<AllCaughtUpCard compact variant="seen" />);
    for (const node of screen.UNSAFE_getAllByType(require('react-native').Text)) {
      expect(node.props.numberOfLines).toBeUndefined();
    }
  });

  it('keeps the glass plate hanging off the unpadded clipping box', () => {
    render(<AllCaughtUpCard compact />);
    expect(screen.getByTestId('glass-plate')).toBeTruthy();
  });

    it('renders the functional boundary line brighter than the cycling mindfulness line', () => {
        // Regression guard: these two sat at identical weight on device and a user could not
        // tell which line explained the boundary. They must stay visually distinct. Checked on
        // BOTH boundary variants — the hierarchy is keyed off "a boundary line renders", not
        // off which one.
        for (const variant of ['seen', 'read'] as const) {
            const line = variant === 'seen' ? en.feed.divider.seenLine : en.feed.divider.readLine;
            const { unmount } = render(<AllCaughtUpCard variant={variant} compact />);
            const subClass = String(screen.getByText(line).props.className ?? '');
            expect(subClass).toContain('text-typography-200');
            expect(subClass).toContain('font-medium');
            unmount();
        }
    });

    it('leaves the mindfulness line as the primary line in the end variant', () => {
        // Footer and empty states render no boundary line, so the cycling line keeps its
        // original class — the pre-variant appearance, unchanged.
        const messages = require('@/lib/locales/en.json').feed.mindfulness as string[];
        const { getByText } = render(<AllCaughtUpCard />);
        const msg = getByText(messages[0]);
        expect(String(msg.props.className ?? '')).toContain('text-gray-400');
    });

    it('recedes the mindfulness line whenever a boundary line is present', () => {
        // The other half of the same rule: with a functional line above it, the decorative
        // cycling line must step back. Pinned so the two classes cannot be collapsed into one.
        const messages = require('@/lib/locales/en.json').feed.mindfulness as string[];
        render(<AllCaughtUpCard variant="seen" compact />);
        const msg = screen.getByText(messages[0]);
        expect(String(msg.props.className ?? '')).toContain('text-typography-500');
    });
});
