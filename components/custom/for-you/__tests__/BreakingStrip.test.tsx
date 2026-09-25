/* eslint-disable @typescript-eslint/no-require-imports */
// BreakingStrip.test — the strip is the loudest surface in the app, so what it
// SAYS and how prominent it is are product decisions, not styling details.
//
// Membership ("only EMERGENCY-band stories reach here at all") is enforced one
// layer up and covered by `fact-rows-selector.test` — this file guards the two
// things a future edit to this component could quietly undo.

jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import { render } from '@testing-library/react-native';
import React from 'react';
import type { BreakingCardData } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

jest.mock('react-native-css-interop/jsx-runtime', () => {
  const ReactJSXRuntime = require('react/jsx-runtime');
  return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const ReactJSXRuntime = require('react/jsx-dev-runtime');
  return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

// `t` echoes the key, so an assertion on rendered text is an assertion on WHICH
// key the component reaches for.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ text }: { text: string }) => <Text>{text}</Text>,
  };
});

// The strip's scroller is RNGH's ScrollView, so the Dashboard's tab swipe can
// wait for it. Mocked to a View carrying its props.
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  const R = require('react');
  return {
    ScrollView: R.forwardRef((p: any, ref: any) => (
      <View ref={ref} testID="gh-scroll" horizontal={p.horizontal} onScroll={p.onScroll} scrollEventThrottle={p.scrollEventThrottle}>
        {p.children}
      </View>
    )),
  };
});
const mockBlocker = { current: null };
const mockNotifyScrollTick = jest.fn();
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: () => mockNotifyScrollTick() }));
jest.mock('../SwipeTabs', () => ({ useSwipeTabsBlocker: () => mockBlocker }));

import BreakingStrip from '../BreakingStrip';

const item = (id: string, title: string): BreakingCardData => ({
  data: { _id: id, title_en: title } as unknown as ForYouSuggestion,
  members: [],
});

describe('BreakingStrip', () => {
  it('renders nothing when there are no items', () => {
    const { toJSON } = render(<BreakingStrip items={[]} onPressItem={jest.fn()} />);
    expect(toJSON()).toBeNull();
  });

  it('labels the chip from `relevance.emergency`, the same key the band uses everywhere else', () => {
    // NOT `forYou.breaking`. The strip gates on the EMERGENCY band, so it must
    // say what that band is called on the card pill and in the section
    // headers — one concept, one string. The old "Breaking" wording is exactly
    // how the label drifted away from what the strip actually gated on.
    const { getByText } = render(
      <BreakingStrip items={[item('a', 'Dam breach forces evacuation')]} onPressItem={jest.fn()} />,
    );
    // The card's text is a hidden visual under its labelled button.
    const HIDDEN = { includeHiddenElements: true } as const;
    expect(getByText('relevance.emergency'.toUpperCase(), HIDDEN)).toBeTruthy();
    expect(() => getByText('forYou.breaking'.toUpperCase(), HIDDEN)).toThrow();
  });

  it('gives the card enough width to show a real headline', () => {
    // Widened from 280/200. Asserted as a floor rather than an exact pair: the
    // requirement is "wide enough to read", and pinning exact points would make
    // any future tuning look like a regression.
    const { getByTestId } = render(
      <BreakingStrip items={[item('a', 'Dam breach forces evacuation')]} onPressItem={jest.fn()} />,
    );
    // The card is the frame; the button inside it is childless (glyph rule).
    const style = getByTestId('breaking-card-a').props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
    expect(flat.maxWidth).toBeGreaterThanOrEqual(320);
    expect(flat.minWidth).toBeGreaterThanOrEqual(260);
  });

  // ux2 B3: inside the Dashboard's swipe area, the strip must keep scrolling on
  // its own: its scroller is RNGH's and registers as the swipe's blocker.
  it('scrolls with RNGH ScrollView registered as the tab swipe blocker', () => {
    const r = render(
      <BreakingStrip items={[item('a', 'One'), item('b', 'Two')]} onPressItem={jest.fn()} />,
    );
    const scroll = r.getByTestId('gh-scroll');
    expect(scroll.props.horizontal).toBe(true);
    expect(mockBlocker.current).not.toBeNull();
  });
});

// Every icon-font glyph must be hidden itself and sit under no accessible
// element: iOS surfaces any other as its own StaticText (captured, ux2).
const glyphProblems = (root: any): string[] => {
    const glyphs = root.findAll(
        (n: any) => typeof n.type === 'string' && /[\uE000-\uF8FF]/.test(String(n.props?.children ?? '')),
    );
    if (glyphs.length === 0) return ['no glyph rendered'];
    const out: string[] = [];
    for (const g of glyphs) {
        if (
            g.props.accessible !== false ||
            g.props.accessibilityElementsHidden !== true ||
            g.props.importantForAccessibility !== 'no-hide-descendants'
        ) {
            out.push(`glyph ${JSON.stringify(g.props.children)} not hidden`);
        }
        for (let p: any = g.parent; p; p = p.parent) {
            if (p.props?.accessible === true) {
                out.push(`glyph under accessible ${p.props.testID ?? p.type}`);
                break;
            }
        }
    }
    return out;
};

it('keeps the warning glyph out of the card button, which is childless', () => {
    const r = render(<BreakingStrip items={[item('g1', 'Quake')]} onPressItem={jest.fn()} />);
    expect(glyphProblems(r.UNSAFE_root)).toEqual([]);
    const b = r.getByRole('button');
    expect(b.findAll((n: any) => n !== b && typeof n.type === 'string' && n.type !== 'View')).toHaveLength(0);
});

// Translated card titles measure themselves on scroll ticks, and they count as
// on screen only inside the screen's width (ux2 B3). A card scrolled in
// sideways must therefore re-measure: the strip ticks on its own scroll.
it('sends a scroll tick as the strip scrolls sideways', () => {
  const { fireEvent } = require('@testing-library/react-native');
  const r = render(<BreakingStrip items={[item('a', 'One'), item('b', 'Two')]} onPressItem={jest.fn()} />);
  const scroller = r.getByTestId('gh-scroll');
  expect(scroller.props.scrollEventThrottle).toBe(16);
  fireEvent.scroll(scroller, { nativeEvent: { contentOffset: { x: 120, y: 0 } } });
  expect(mockNotifyScrollTick).toHaveBeenCalledTimes(1);
});
